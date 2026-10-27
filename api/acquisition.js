// QVEMA Amplify — Acquisition data API (bilan ads & funnel par promo)
// Même pattern que data.js : auth cockpit + Airtable live, cache court.
// - Dépense Meta / campagnes P1 & P2 = CONSTANTES validées (exports Ads Manager consolidés,
//   comptes bloqués → pas d'API fiable). Sources : CSV 24/06→23/07 (3 comptes P2),
//   exports Le Cab + MON ASSOCIE FACTORY (P1). Attribution = UTM (source de vérité).
// - PROMO 1 : bilan FIGÉ (post-mortem validé, cascade premier-contact incl. lead form).
// - PROMO 2 : inscrits & ventes par canal recalculés LIVE depuis Airtable
//   (cascade : ① UTM checkout → ② match e-mail opt-in → ③ Direct).
// - PROMO 3 : funnel LIVE Airtable + dépense Meta LIVE (Marketing API via api/_meta.js, 2 comptes :
//   MON ASSOCIE FACTORY principal + Bootcamp QVEMA back-up). Périmètre = campagnes « Septembre 2026 ».
const auth = require("./_auth.js");
const { fetchCampaignSpend, scrub, DEFAULT_VERSION } = require("./_meta.js");

const CONFIG = {
  airtableToken: process.env.AIRTABLE_TOKEN || "",
  airtableBase: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
  // Meta Marketing API (dépense P3). Comptes : MON ASSOCIE FACTORY 3220696111443286 (principal) + Bootcamp QVEMA 854328590746337 (back-up).
  metaToken: process.env.META_ACCESS_TOKEN || "",
  metaAccounts: [...new Set((process.env.META_AD_ACCOUNTS || "3220696111443286,854328590746337").split(",").map((s) => s.trim().replace(/^act_/, "")).filter(Boolean))],
  p3Since: process.env.P3_META_SINCE || "2026-08-01", // début de la fenêtre dépense P3 (until = aujourd'hui, Europe/Paris) ; le périmètre par nom évite toute fuite P2
  apiVersion: process.env.META_API_VERSION || DEFAULT_VERSION,
};
const T = { optin: "tblLFSHiUudhDSvM9", clients: "tblalRhenwmZZgenq" };

const COLORS = {
  "Paid Meta (ads)": "#3ecf8e",
  "Direct / Site": "#8a94a6",
  "Newsletter / Email": "#ffce3a",
  "WhatsApp": "#a779ff",
  "Réseaux sociaux": "#5b8def",
  "Partenaires": "#ff9f1c",
  "Direct / organique": "#8a94a6",
};

// ---------- PROMO 1 — bilan figé (validé au 17/06, base "réalisé au live") ----------
const PROMO1 = {
  fenetre: "3 → 10 juin 2026",
  liveDate: "10/06/2026",
  spend: { total: 17233.11, acquisition: 17233.11, rtg: 0,
    note: "2 comptes : MON ASSOCIE FACTORY 4 006 € (chauffe + lead form) + Le Cab 13 227 € (vidéos créateurs)." },
  inscrits: 4171,
  channels: [
    { name: "Paid Meta (ads)", ins: 2421, ventes: 59, fac: 76110, enc: 40312.5 },
    { name: "Direct / organique", ins: 1037, ventes: 75, fac: 96750, enc: 47407.5 },
    { name: "Partenaires", ins: 366, ventes: 6, fac: 7740, enc: 2902.5 },
    { name: "Newsletter / Email", ins: 347, ventes: 17, fac: 21930, enc: 11288 },
  ],
  byDay: [
    { d: "03/06", ch: { "Paid Meta (ads)": 151, "Direct / organique": 241 } },
    { d: "04/06", ch: { "Paid Meta (ads)": 97, "Newsletter / Email": 52, "Direct / organique": 135 } },
    { d: "05/06", ch: { "Paid Meta (ads)": 126, "Newsletter / Email": 47, "Direct / organique": 104 } },
    { d: "06/06", ch: { "Paid Meta (ads)": 145, "Newsletter / Email": 12, "Direct / organique": 101 } },
    { d: "07/06", ch: { "Paid Meta (ads)": 285, "Newsletter / Email": 13, "Direct / organique": 77 } },
    { d: "08/06", ch: { "Paid Meta (ads)": 556, "Newsletter / Email": 16, "Partenaires": 41, "Direct / organique": 129 } },
    { d: "09/06", ch: { "Paid Meta (ads)": 733, "Newsletter / Email": 120, "Partenaires": 287, "Direct / organique": 158 } },
    { d: "10/06", ch: { "Paid Meta (ads)": 328, "Newsletter / Email": 87, "Partenaires": 38, "Direct / organique": 92 } },
  ],
  campaigns: [
    { name: "ACQ - Marc", ins: 1000, spend: 5149.42 },
    { name: "ACQ - Alice", ins: 750, spend: 4595.52 },
    { name: "ACQ - JMK", ins: 158, spend: 1522.21 },
    { name: "ACQ - Eric", ins: 75, spend: 953.93 },
    { name: "ACQ - Sarah", ins: 42, spend: 434.39 },
    { name: "ACQ - Lead form (FACTORY)", ins: 360, spend: 3948.0 },
  ],
  notes: [
    "Attribution premier-contact validée (cascade UTM → lead form Meta → opt-in → identité), dédoublonnée.",
    "Le lead form (1 462 e-mails captés à 2,70 €) a généré 360 inscriptions conf (10,97 €/inscr.) et 23 ventes.",
    "Compte MON ASSOCIE FACTORY bloqué en cours de campagne → bascule sur Le Cab.",
  ],
};

// ---------- PROMO 2 — dépense & campagnes figées (CSV), funnel live Airtable ----------
const P2_META = {
  fenetre: "13 → 22 juillet 2026",
  liveDate: "22/07/2026",
  spend: { total: 18327.91, acquisition: 18071.3, rtg: 256.61,
    note: "3 comptes : principal 17 245 € (bloqué) + relais 672 € (Marc chaud + RTG) + chauffe 411 €. RTG post-webi encore actif." },
  campaigns: [
    { name: "ACQ - Marc (cpt 1)", spend: 7938.93, match: /Marc(?!.*26\b)/ },
    { name: "ACQ - Alice", spend: 5043.26, match: /Alice/ },
    { name: "ACQ - JMK", spend: 3839.4, match: /JMK/ },
    { name: "ACQ - Marc chaud (cpt 2)", spend: 415.02, match: /Marc.*Juillet\s*26(?!\d)/ },
    { name: "ACQ - Chauffe (cpt 3)", spend: 410.91, match: /Chauffe/ },
    { name: "ACQ - Eric", spend: 305.62, match: /Eric/ },
    { name: "ACQ - Instit", spend: 118.16, match: /Instit/ },
  ],
  notes: [
    "Attribution UTM (source de vérité) : ① UTM checkout → ② match e-mail opt-in (1ᵉʳ contact) → ③ Direct.",
    "Pas de lead form en P2. WhatsApp désormais tracké (grp-wa). Early-bird 5→8/07 à 1 290 € (18 ventes).",
    "Compte principal bloqué en cours de campagne (comme en P1) → 3 comptes consolidés via exports Ads Manager.",
    "Participants au live du 22/07 : en attente de la donnée (funnel show-up à venir).",
  ],
};

// ---------- PROMO 3 — dépense LIVE (Meta Marketing API via api/_meta.js), funnel live Airtable ----------
// Env : META_ACCESS_TOKEN (sans lui : dépense 0 + note), META_AD_ACCOUNTS, P3_META_SINCE, META_API_VERSION (cf. CONFIG),
//       P3_LIVE_DATE, P3_META_MATCH, P3_META_INCLUDE_IDS, P3_META_ALIASES (ci-dessous). Rien ne touche P1 / P2.
// Règle de périmètre : texte littéral (espaces/insécables tolérants, insensible à la casse) ou /regex/ explicite.
const envRe = (v, d) => {
  try {
    const m = /^\/(.+)\/([a-z]*)$/.exec(v || "");
    if (m) return new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i");
    return new RegExp((v || d).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "i");
  } catch (_) { return new RegExp(d.replace(/\s+/g, "\\s*"), "i"); }
};
const envJson = (v) => { try { return JSON.parse(v || "{}") || {}; } catch (_) { return {}; } };
const P3_META = {
  liveDate: process.env.P3_LIVE_DATE || "à venir",
  // PÉRIMÈTRE (règle opérateur) : une campagne Meta appartient à la P3 ssi son nom contient « Septembre 2026 »…
  match: envRe(process.env.P3_META_MATCH, "Septembre 2026"),
  matchLabel: process.env.P3_META_MATCH || "Septembre 2026", // libellé humain de la règle (notes)
  // …ou si son id est forcé (ex. 52607628596514 = « ACQ - Instit - Compte back up » sur Bootcamp QVEMA, nom sans « Septembre 2026 »).
  includeIds: (process.env.P3_META_INCLUDE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
  rtgMatch: /RTG|retarget|remarketing/i,
  // Nom de campagne Meta -> valeur UTM campaign quand ils diffèrent, ex. {"ACQ - Instit - Septembre 2026":"ACQ - Instit"}.
  aliases: envJson(process.env.P3_META_ALIASES),
  accountNames: { "3220696111443286": "MON ASSOCIE FACTORY", "854328590746337": "Bootcamp QVEMA" }, // libellés dans les notes
};
const accLabel = (id) => P3_META.accountNames[id] || (id === "*" ? "tous comptes" : "act_" + id);
// Dernière lecture Meta réussie par compte (par instance) : si un compte tombe (P1/P2 : compte principal bloqué en cours
// de campagne), on réutilise ses dernières lignes plutôt que d'afficher une dépense fausse ; sans repli => dépense PARTIELLE.
let _lastMeta = {};

// ---------- PROMO 4 — même mécanique que P3 (vue Airtable « Inscrits Webi 4 » + clients {Promo}='PROMO 4').
// La dépense Meta P4 reste DÉSACTIVÉE tant que P4_META_MATCH n'est pas défini (sinon on double-compterait
// le spend P3). Pour l'activer : définir dans Vercel P4_META_MATCH (nom de campagne, ex. « Novembre 2026 »)
// + P4_META_SINCE (début de fenêtre, AAAA-MM-JJ), et au besoin P4_META_INCLUDE_IDS / P4_META_ALIASES / P4_LIVE_DATE.
const P4_META = {
  liveDate: process.env.P4_LIVE_DATE || "à venir",
  // Périmètre P4 : campagnes Meta nommées « Octobre 2026 » (distinct de « Septembre 2026 » = P3,
  // donc aucun double-comptage). Surchargeable via P4_META_MATCH (texte ou /regex/, ex. « Octobre 2026|Novembre 2026 »).
  match: envRe(process.env.P4_META_MATCH, "Octobre 2026"),
  matchLabel: process.env.P4_META_MATCH || "Octobre 2026",
  includeIds: (process.env.P4_META_INCLUDE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
  rtgMatch: /RTG|retarget|remarketing/i,
  aliases: envJson(process.env.P4_META_ALIASES),
  accountNames: P3_META.accountNames,
};

async function airtableAll(table, fields, filterByFormula, view) {
  const out = [];
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${CONFIG.airtableBase}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (fields) fields.forEach((f) => url.searchParams.append("fields[]", f));
    if (filterByFormula) url.searchParams.set("filterByFormula", filterByFormula);
    if (view) url.searchParams.set("view", view);
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${CONFIG.airtableToken}` } });
    if (!r.ok) throw new Error(`Airtable ${table} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.records);
    offset = j.offset;
  } while (offset);
  return out;
}

const norm = (s) => (s || "").toString().trim();
const lower = (s) => norm(s).toLowerCase();

// utm_source -> canal (tagging propre P2)
function chanFromSrc(src) {
  const s = lower(src);
  if (s === "meta" || s === "fb") return "Paid Meta (ads)";
  if (s === "ac") return "Newsletter / Email";
  if (s === "rs") return "Réseaux sociaux";
  if (s === "grp-wa") return "WhatsApp";
  if (s === "btn-site" || s === "") return "Direct / Site";
  return "Direct / Site"; // partenaires isolés etc. fondus dans Direct
}

// Canaux ORGANIQUES (plan organique conférence) : utm_source -> libellé. Le reste (meta/fb = ads,
// btn-site/"" = direct) n'est pas de l'organique par intervenant.
const ORGANIC_CHAN = {
  linkedin: "LinkedIn", instagram: "Instagram", insta: "Instagram",
  facebook: "Facebook", short: "YouTube Short", youtube: "YouTube", yt: "YouTube",
  newsletter: "Newsletter", tiktok: "TikTok", snapchat: "Snapchat", snap: "Snapchat",
  x: "X (Twitter)", twitter: "X (Twitter)", threads: "Threads",
};

function decode(c) {
  try { return decodeURIComponent((c || "").replace(/\+/g, " ")); } catch (_) { return c || ""; }
}
// Répare un UTM « cassé » : lien publié avec « &amp; » au lieu de « & » → toute la query atterrit dans
// utm_source, ex. « linkedinamp;utm_medium=elarchevequeamp;utm_campaign=amplify-oct-2026 ».
// On recompose source / medium / campaign. Sans effet sur un UTM propre.
function fixUtm(rawSrc, rawMed, rawCamp) {
  let source = decode(rawSrc).trim(), medium = decode(rawMed).trim(), campaign = decode(rawCamp).trim();
  if (/(amp;|&|;)utm_/i.test(source)) {
    const parts = source.replace(/amp;/gi, "&").split(/[&;]/);
    source = parts[0].trim();
    for (const p of parts.slice(1)) {
      const m = /^utm_(source|medium|campaign)=(.*)$/i.exec(p.trim());
      if (!m || !m[2].trim()) continue;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === "medium") medium = v; else if (k === "campaign") campaign = v; else source = v;
    }
  }
  // medium seul cassé (« elarchevequeamp;utm_campaign=… ») : on coupe au premier séparateur.
  if (/(amp;|&|;)utm_/i.test(medium)) medium = medium.split(/amp;|&|;/i)[0].trim();
  return { source, medium, campaign };
}
// Aujourd'hui à Paris en YYYY-MM-DD (fr-CA = format ISO) : borne « until » de la fenêtre Meta P3.
const todayParis = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ddmm = (iso) => norm(iso).slice(8, 10) + "/" + norm(iso).slice(5, 7);
const hhmm = (t) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
const r2 = (v) => Math.round(v * 100) / 100;
const EUR0 = (v) => Math.round(v).toLocaleString("fr-FR") + " €";

async function buildPromo2() {
  // Inscrits P2 : SOURCE DE VÉRITÉ = vue Airtable "Inscrits Webi 2" (liste canonique,
  // évite les doublons d'une somme par canal). Repli sur un filtre date si la vue est renommée.
  const OPTIN_FIELDS = ["Email", "Created", "UTM Source", "UTM Campaign"];
  const optinsP = airtableAll(T.optin, OPTIN_FIELDS, null, "Inscrits Webi 2")
    .catch(() => airtableAll(T.optin, OPTIN_FIELDS, `IS_AFTER({Created}, '2026-06-15')`));
  const [optins, clients] = await Promise.all([
    optinsP,
    airtableAll(T.clients, ["Email", "UTM Source", "Montant", "Mode de paiement", "Statut Paiement", "Promo", "Date Paiement"],
      `TRIM(UPPER({Promo})) = 'PROMO 2'`),
  ]);

  // Inscrits : dédoublonnés par e-mail (premier opt-in conservé)
  const seen = new Map();
  for (const r of optins) {
    const em = lower(r.fields["Email"]);
    const key = em || r.id;
    if (!seen.has(key)) seen.set(key, r);
  }
  const uniq = [...seen.values()];

  const channels = {};
  const byDayMap = {};
  const campIns = {};
  const emailChan = {};
  for (const r of uniq) {
    const chan = chanFromSrc(r.fields["UTM Source"]);
    channels[chan] = channels[chan] || { ins: 0, ventes: 0, fac: 0, enc: 0 };
    channels[chan].ins++;
    const em = lower(r.fields["Email"]);
    if (em) emailChan[em] = chan;
    const created = norm(r.fields["Created"]).slice(0, 10);
    if (created >= "2026-07-13") {
      const d = created.slice(8, 10) + "/" + created.slice(5, 7);
      byDayMap[d] = byDayMap[d] || {};
      byDayMap[d][chan] = (byDayMap[d][chan] || 0) + 1;
    }
    if (chan === "Paid Meta (ads)") {
      const c = decode(r.fields["UTM Campaign"]);
      const hit = P2_META.campaigns.find((k) => k.match.test(c));
      const key = hit ? hit.name : (/Chauffe/i.test(c) ? "ACQ - Chauffe (cpt 3)" : "(UTM cassé)");
      campIns[key] = (campIns[key] || 0) + 1;
    }
  }

  // Ventes : cascade ① UTM checkout → ② opt-in e-mail → ③ Direct. "En attente" exclu.
  let ventes = 0, caFac = 0, caEnc = 0, refunds = 0;
  for (const c of clients) {
    if (norm(c.fields["Statut Paiement"]) === "En attente" || norm(c.fields["Statut Paiement"]) === "Échec") continue;
    const m = Number(c.fields["Montant"]) || 0;
    const mode = lower(c.fields["Mode de paiement"]);
    const src = norm(c.fields["UTM Source"]);
    const em = lower(c.fields["Email"]);
    let chan = src ? chanFromSrc(src) : (em && emailChan[em]) || "Direct / Site";
    channels[chan] = channels[chan] || { ins: 0, ventes: 0, fac: 0, enc: 0 };
    channels[chan].ventes++;
    channels[chan].fac += m;
    channels[chan].enc += mode === "4x" ? m / 4 : m;
    ventes++; caFac += m; caEnc += mode === "4x" ? m / 4 : m;
    if (norm(c.fields["Statut Paiement"]) === "Remboursé") refunds++;
  }

  const channelList = Object.entries(channels)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.ins - a.ins);
  const inscrits = channelList.reduce((a, c) => a + c.ins, 0);
  const metaIns = (channels["Paid Meta (ads)"] || {}).ins || 0;
  const metaFac = (channels["Paid Meta (ads)"] || {}).fac || 0;
  const metaVentes = (channels["Paid Meta (ads)"] || {}).ventes || 0;

  const days = Object.keys(byDayMap).sort((a, b) => (a.slice(3) + a.slice(0, 2)).localeCompare(b.slice(3) + b.slice(0, 2)));
  return {
    fenetre: P2_META.fenetre, liveDate: P2_META.liveDate, spend: P2_META.spend,
    inscrits, channels: channelList,
    byDay: days.map((d) => ({ d, ch: byDayMap[d] })),
    campaigns: P2_META.campaigns.map((k) => ({ name: k.name, spend: k.spend, ins: campIns[k.name] || 0 })),
    utmCasses: campIns["(UTM cassé)"] || 0,
    kpis: {
      ventes, caFac, caEnc, refunds,
      cpl: metaIns ? P2_META.spend.acquisition / metaIns : null,
      roasMeta: metaFac / P2_META.spend.total,
      roasBlended: caFac / P2_META.spend.total,
      cac: metaVentes ? P2_META.spend.total / metaVentes : null,
      conv: inscrits ? (ventes / inscrits) * 100 : null,
    },
    notes: P2_META.notes,
  };
}

// PROMO 3 : même chemin que P2 (vue Airtable "Inscrits Webi 3" + clients {Promo}='PROMO 3'),
// mais dépense Meta LIVE (Marketing API, 2 comptes, périmètre « Septembre 2026 ») au lieu de CSV figés.
// Sans META_ACCESS_TOKEN : comportement d'avant (dépense 0, CPL/ROAS/CAC null) + note explicite.
// Builder générique d'une promo LIVE (funnel Airtable + dépense Meta optionnelle).
// cfg = { promoLabel, promoFilter, webiView, webiLabel, openText, since, meta, metaEnabled, metaOffNote }
async function buildPromoLive(cfg) {
  const META = cfg.meta;
  const OPTIN_FIELDS = ["Email", "Created", "UTM Source", "UTM Medium", "UTM Campaign"];
  const since = cfg.since, until = todayParis();
  const optinsP = airtableAll(T.optin, OPTIN_FIELDS, null, cfg.webiView).catch(() => []);
  // Dépense Meta en parallèle des 2 appels Airtable ; null si désactivée pour cette promo (fallback = funnel seul).
  const metaP = cfg.metaEnabled
    ? fetchCampaignSpend({ token: CONFIG.metaToken, accounts: CONFIG.metaAccounts, since, until, apiVersion: CONFIG.apiVersion })
        .catch((e) => ({ rows: [], errors: [{ account: "*", error: scrub(e, CONFIG.metaToken) }] }))
    : Promise.resolve(null);
  const [optins, clients, meta] = await Promise.all([
    optinsP,
    airtableAll(T.clients, ["Email", "UTM Source", "Montant", "Mode de paiement", "Statut Paiement", "Promo", "Date Paiement"],
      cfg.promoFilter),
    metaP,
  ]);
  // Repli par compte : compte en erreur => dernières lignes connues (stale) si on en a, sinon dépense PARTIELLE (KPIs masqués).
  const stale = [], missing = [];
  const LK = (a) => cfg.promoLabel + "|" + a; // clé de repli Meta par promo (évite tout mélange P3/P4)
  if (meta) {
    const failed = new Set(meta.errors.map((e) => e.account));
    for (const a of CONFIG.metaAccounts) {
      if (!failed.has(a) && !failed.has("*")) { _lastMeta[LK(a)] = { rows: meta.rows.filter((r) => r.account === a), at: Date.now() }; continue; }
      const lg = _lastMeta[LK(a)];
      if (lg) { meta.rows.push(...lg.rows); stale.push(accLabel(a) + " (figé à " + hhmm(lg.at) + ")"); } else missing.push(a);
    }
  }
  const partial = !!meta && missing.length > 0;

  const seen = new Map();
  for (const r of optins) { const em = lower(r.fields["Email"]); const key = em || r.id; if (!seen.has(key)) seen.set(key, r); }
  const uniq = [...seen.values()];

  const channels = {}, byDayMap = {}, emailChan = {}, campIns = {}, orgMap = {}, emailOrg = {}, emailCamp = {}, campVentes = {};
  for (const r of uniq) {
    const u = fixUtm(r.fields["UTM Source"], r.fields["UTM Medium"], r.fields["UTM Campaign"]); // UTM réparé si lien « &amp; »
    const chan = chanFromSrc(u.source);
    channels[chan] = channels[chan] || { ins: 0, ventes: 0, fac: 0, enc: 0 };
    channels[chan].ins++;
    const em = lower(r.fields["Email"]); if (em) emailChan[em] = chan;
    const created = norm(r.fields["Created"]).slice(0, 10);
    if (created) { const d = created.slice(8, 10) + "/" + created.slice(5, 7); byDayMap[d] = byDayMap[d] || {}; byDayMap[d][chan] = (byDayMap[d][chan] || 0) + 1; }
    // Campagne via l'UTM : nom Meta encodé ({{campaign.name}} → « ACQ+-+Marc+-+Septembre+2026 ») OU id numérique ({{campaign.id}}).
    // Vide / « {{campaign.name}} » non résolu = UTM cassé (compté à part, comme en P2).
    if (chan === "Paid Meta (ads)") { const c = u.campaign; const key = !c || /\{\{|\}\}/.test(c) ? "(UTM cassé)" : c; campIns[key] = (campIns[key] || 0) + 1; if (em) emailCamp[em] = key; }
    // Organique par intervenant × canal (utm_source organique + utm_medium = la personne qui poste).
    const orgLabel = ORGANIC_CHAN[lower(u.source)];
    if (orgLabel) {
      const med = u.medium || "(sans intervenant)";
      const key = med + " | " + orgLabel;
      (orgMap[key] = orgMap[key] || { intervenant: med, canal: orgLabel, ins: 0, ventes: 0 }).ins++;
      if (em) emailOrg[em] = key; // pour attribuer la vente au même intervenant×canal que l'inscrit
    }
  }

  let ventes = 0, caFac = 0, caEnc = 0, refunds = 0;
  for (const c of clients) {
    const st = norm(c.fields["Statut Paiement"]);
    if (st === "En attente" || st === "Échec") continue;
    const m = Number(c.fields["Montant"]) || 0;
    const mode = lower(c.fields["Mode de paiement"]);
    const src = fixUtm(c.fields["UTM Source"]).source; // même réparation côté checkout
    const em = lower(c.fields["Email"]);
    const chan = src ? chanFromSrc(src) : (em && emailChan[em]) || "Direct / Site";
    channels[chan] = channels[chan] || { ins: 0, ventes: 0, fac: 0, enc: 0 };
    channels[chan].ventes++; channels[chan].fac += m; channels[chan].enc += mode === "4x" ? m / 4 : m;
    ventes++; caFac += m; caEnc += mode === "4x" ? m / 4 : m;
    if (st === "Remboursé") refunds++;
    // Attribution organique de la vente : même intervenant×canal que l'inscrit (via match e-mail opt-in).
    const oKey = em && emailOrg[em];
    if (oKey && orgMap[oKey]) orgMap[oKey].ventes++;
    // Attribution de la vente à la campagne Meta (via campagne de l'opt-in, même base que les inscrits).
    if (chan === "Paid Meta (ads)") { const ck = em && emailCamp[em]; if (ck) campVentes[ck] = (campVentes[ck] || 0) + 1; }
  }

  const channelList = Object.entries(channels).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.ins - a.ins);
  const inscrits = channelList.reduce((a, c) => a + c.ins, 0);
  const metaIns = (channels["Paid Meta (ads)"] || {}).ins || 0;
  const metaFac = (channels["Paid Meta (ads)"] || {}).fac || 0;
  const metaVentes = (channels["Paid Meta (ads)"] || {}).ventes || 0;
  const days = Object.keys(byDayMap).sort((a, b) => (a.slice(3) + a.slice(0, 2)).localeCompare(b.slice(3) + b.slice(0, 2)));

  // ---- Dépense Meta : périmètre P3 (nom « Septembre 2026 » ou id forcé), fusion par nom normalisé
  //      (même campagne sur 2 comptes = 1 ligne). Hors périmètre avec dépense > 0 => signalé dans la note.
  const norm2 = (s) => decode(s).replace(/[\u00a0\u202f]/g, " ").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  const clean = (s) => String(s || "").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim(); // nom affiché
  const rows = {}, excl = {}, badCur = [];
  for (const m of (meta && meta.rows) || []) {
    if (m.currency && m.currency !== "EUR") { if (m.spend > 0) badCur.push(clean(m.name) + " (" + m.currency + ")"); continue; } // devise non gérée : jamais sommée
    const ok = META.match.test(norm2(m.name)) || META.includeIds.includes(String(m.campaignId));
    if (!ok && !(m.spend > 0)) continue;
    const bucket = ok ? rows : excl, k = norm2(m.name);
    const row = bucket[k] || (bucket[k] = { name: clean(m.name), spend: 0, ids: [], ins: 0, ventes: 0 });
    row.spend += m.spend;
    if (m.campaignId && !row.ids.includes(m.campaignId)) row.ids.push(m.campaignId);
  }
  // ---- Rattachement UTM → campagne Meta : clé numérique = campaign_id, sinon nom exact normalisé (alias possible).
  //      Plusieurs clés UTM (id + nom) résolues vers la même campagne = 1 ligne, nommée comme dans Meta.
  const byId = {}, byName = {}, aliasByNorm = {};
  for (const [k, v] of Object.entries(META.aliases)) aliasByNorm[norm2(k)] = v;
  for (const row of Object.values(rows)) {
    row.ids.forEach((id) => { byId[id] = row; });
    byName[norm2(row.name)] = row;
    const al = aliasByNorm[norm2(row.name)]; if (al) byName[norm2(al)] = row;
  }
  const campaigns = [];
  for (const [key, ins] of Object.entries(campIns)) {
    if (key === "(UTM cassé)") continue;
    const v = campVentes[key] || 0;
    const row = /^\d+$/.test(key) ? byId[key] : byName[norm2(key)];
    if (row) { row.ins += ins; row.ventes += v; } else campaigns.push({ name: clean(key).replace(/[<>]/g, "").slice(0, 80), ins, ventes: v, spend: null }); // UTM non rattaché : dépense inconnue (—), balises retirées
  }
  for (const row of Object.values(rows)) campaigns.push({ name: row.name, ins: row.ins, ventes: row.ventes || 0, spend: r2(row.spend) }); // ins 0 possible : la dépense compte quand même
  campaigns.sort((a, b) => ((b.spend || 0) - (a.spend || 0)) || (b.ins - a.ins));

  const scope = Object.values(rows);
  const total = r2(scope.reduce((a, c) => a + c.spend, 0));
  const rtg = r2(scope.filter((c) => META.rtgMatch.test(c.name)).reduce((a, c) => a + c.spend, 0));
  const spend = { total, rtg, acquisition: r2(total - rtg), note: "", partial };
  const fenetre = ddmm(since) + " → " + ddmm(until);
  const notes = [
    "Attribution UTM (source de vérité) : ① UTM checkout → ② match e-mail opt-in (1ᵉʳ contact) → ③ Direct. Inscrits = vue Airtable « " + cfg.webiLabel + " » (" + cfg.openText + ").",
  ];
  if (!meta) {
    spend.note = cfg.metaOffNote;
    notes.push(cfg.metaOffNote + " : CPL, ROAS et CAC s'afficheront une fois branchés.");
  } else {
    const errs = meta.errors.map((e) => "compte " + accLabel(e.account) + " indisponible : " + e.error);
    const dropped = Object.values(excl).sort((a, b) => b.spend - a.spend).map((c) => c.name + " " + EUR0(c.spend));
    const perim = "nom sans « " + META.matchLabel + " »";
    spend.note = (partial ? "⚠ DÉPENSE PARTIELLE · " : "") + "Live Meta API · " + CONFIG.metaAccounts.length + " compte(s) · fenêtre " + fenetre
      + (stale.length ? " · dernière valeur connue : " + stale.join(", ") : "")
      + (errs.length ? " · " + errs.join(" · ") : "")
      + (dropped.length ? " · Hors périmètre " + cfg.promoLabel + " (" + perim + ") : " + dropped.join(", ") : "")
      + (badCur.length ? " · devise non gérée (exclu) : " + badCur.join(", ") : "");
    notes.push("Dépense Meta LIVE (Marketing API) : " + CONFIG.metaAccounts.map(accLabel).join(" + ") + " · périmètre " + cfg.promoLabel + " = campagnes dont le nom contient « " + META.matchLabel + " »"
      + (META.includeIds.length ? " + ids forcés " + META.includeIds.join(", ") : "") + " · fenêtre " + fenetre + " · rafraîchi toutes les 60 s.");
    notes.push("Campagnes rattachées par UTM campaign (nom Meta encodé ou id numérique) ; UTM vides ou « {{campaign.name}} » non résolus comptés en UTM cassé ; une campagne Meta sans inscrit reste affichée (0) pour que la dépense totale soit juste.");
    if (stale.length) notes.push("Compte(s) Meta indisponible(s), dépense figée à la dernière lecture réussie : " + stale.join(", ") + ".");
    if (partial) notes.push("⚠ " + errs.join(" · ") + " — dépense PARTIELLE : CPL, ROAS et CAC masqués (ils seraient faux) ; la dépense affichée ne couvre pas tous les comptes.");
    else if (errs.length) notes.push("⚠ " + errs.join(" · "));
    if (badCur.length) notes.push("Campagne(s) dans une devise autre que EUR, exclue(s) du total : " + badCur.join(", ") + ".");
    if (dropped.length) notes.push("Hors périmètre " + cfg.promoLabel + " (" + perim + "), dépense ignorée : " + dropped.join(", ") + ".");
  }
  return {
    fenetre, liveDate: META.liveDate, spend,
    inscrits, channels: channelList,
    byDay: days.map((d) => ({ d, ch: byDayMap[d] })),
    // Campagnes : dépense Meta live (périmètre P3) + inscrits via UTM ; spend null = UTM non rattaché (colonnes Dépense/CPL vides).
    campaigns,
    // Organique : inscrits par intervenant × canal (UTM medium × source), 0 masqué (construit depuis les inscrits réels).
    organique: Object.values(orgMap).map((o) => ({ ...o, conv: o.ins ? (o.ventes / o.ins) * 100 : null })).sort((a, b) => b.ins - a.ins || a.canal.localeCompare(b.canal) || a.intervenant.localeCompare(b.intervenant)),
    utmCasses: campIns["(UTM cassé)"] || 0,
    kpis: {
      ventes, caFac, caEnc, refunds,
      cpl: !partial && metaIns && spend.acquisition > 0 ? spend.acquisition / metaIns : null,
      roasMeta: !partial && spend.total > 0 ? metaFac / spend.total : null,
      roasBlended: !partial && spend.total > 0 ? caFac / spend.total : null,
      cac: !partial && metaVentes && spend.total > 0 ? spend.total / metaVentes : null,
      conv: inscrits ? (ventes / inscrits) * 100 : null,
    },
    notes,
  };
}

// PROMO 3 : funnel live (vue « Inscrits Webi 3 ») + dépense Meta LIVE (périmètre « Septembre 2026 »).
function buildPromo3() {
  return buildPromoLive({
    promoLabel: "PROMO 3",
    promoFilter: `TRIM(UPPER({Promo})) = 'PROMO 3'`,
    webiView: "Inscrits Webi 3",
    webiLabel: "Inscrits Webi 3",
    openText: "inscriptions ouvertes le 05/09",
    since: CONFIG.p3Since,
    meta: P3_META,
    metaEnabled: !!CONFIG.metaToken,
    metaOffNote: "Dépense Meta non branchée (META_ACCESS_TOKEN manquant)",
  });
}

// PROMO 4 : même chemin (vue « Inscrits Webi 4 » + clients 'PROMO 4'). Dépense Meta désactivée tant que
// P4_META_MATCH n'est pas défini (sinon double-comptage du spend P3) ; funnel/ventes/organique restent live.
function buildPromo4() {
  return buildPromoLive({
    promoLabel: "PROMO 4",
    promoFilter: `TRIM(UPPER({Promo})) = 'PROMO 4'`,
    webiView: "Inscrits Webi 4",
    webiLabel: "Inscrits Webi 4",
    openText: process.env.P4_OPEN_TEXT || "inscriptions webi 4",
    since: process.env.P4_META_SINCE || "2026-10-01",
    meta: P4_META,
    metaEnabled: !!CONFIG.metaToken, // périmètre P4 défini (« Octobre 2026 ») : dépense Meta LIVE comme la P3
    metaOffNote: "Dépense Meta non branchée (META_ACCESS_TOKEN manquant)",
  });
}

function promo1Scope() {
  const inscrits = PROMO1.inscrits;
  const caFac = PROMO1.channels.reduce((a, c) => a + c.fac, 0);
  const caEnc = PROMO1.channels.reduce((a, c) => a + c.enc, 0);
  const ventes = PROMO1.channels.reduce((a, c) => a + c.ventes, 0);
  const meta = PROMO1.channels.find((c) => c.name === "Paid Meta (ads)");
  return {
    fenetre: PROMO1.fenetre, liveDate: PROMO1.liveDate, spend: PROMO1.spend,
    inscrits, channels: PROMO1.channels, byDay: PROMO1.byDay,
    campaigns: PROMO1.campaigns, utmCasses: 0,
    kpis: {
      ventes, caFac, caEnc, refunds: 9,
      cpl: PROMO1.spend.acquisition / meta.ins,
      roasMeta: meta.fac / PROMO1.spend.total,
      roasBlended: caFac / PROMO1.spend.total,
      cac: PROMO1.spend.total / meta.ventes,
      conv: (ventes / inscrits) * 100,
    },
    notes: PROMO1.notes,
    fige: true,
  };
}

let _cache = { at: 0, data: null };
let _inflight = null; // reconstruction en cours (les requêtes concurrentes la partagent)
const _TTL = 60000;

module.exports = async (req, res) => {
  const user = auth.authFromRequest(req);
  if (!user) { res.statusCode = 401; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: "unauthorized" })); }
  if (!auth.has(user.perms, "bootcamp")) { res.statusCode = 403; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: "forbidden" })); }
  const only = (req.query && req.query.only) || require("url").parse(req.url, true).query.only;
  if (only === "webi-overlap") {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    try {
      const [w2, w3] = await Promise.all([
        airtableAll(T.optin, ["Email"], null, "Inscrits Webi 2"),
        airtableAll(T.optin, ["Email"], null, "Inscrits Webi 3"),
      ]);
      const set2 = new Set(w2.map((r) => lower(r.fields["Email"])).filter(Boolean));
      const uniq3 = new Set(w3.map((r) => lower(r.fields["Email"])).filter(Boolean));
      let overlap = 0; for (const e of uniq3) if (set2.has(e)) overlap++;
      res.statusCode = 200;
      return res.end(JSON.stringify({
        webi2_lignes: w2.length, webi2_uniques: set2.size,
        webi3_lignes: w3.length, webi3_uniques: uniq3.size,
        deja_inscrits_webi2: overlap, nouveaux_webi3: uniq3.size - overlap,
      }));
    } catch (e) { res.statusCode = 502; return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  if (only === "p4-diag") {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    try {
      const rows = await airtableAll(T.optin, ["Email", "Created", "UTM Source", "UTM Medium", "UTM Campaign"], null, "Inscrits Webi 4");
      const emails = rows.map((r) => lower(r.fields["Email"]));
      const withEmail = emails.filter(Boolean);
      const uniq = new Set(withEmail);
      // distribution des utm_source (décodés) + mapping canal/organique
      const bySrc = {};
      for (const r of rows) {
        const rawSrc = decode(r.fields["UTM Source"]).trim();
        const s = lower(rawSrc);
        const e = bySrc[s] || (bySrc[s] = { source: rawSrc || "(vide)", n: 0, canal: chanFromSrc(rawSrc), organique: ORGANIC_CHAN[s] || null, mediums: {} });
        e.n++;
        const med = decode(r.fields["UTM Medium"]).trim() || "(vide)";
        e.mediums[med] = (e.mediums[med] || 0) + 1;
      }
      const srcList = Object.values(bySrc).sort((a, b) => b.n - a.n);
      // lignes mentionnant larcheveque/linkedin (source OU medium OU campaign)
      const hit = rows.filter((r) => /larchev|linkedin/i.test(decode(r.fields["UTM Source"]) + " " + decode(r.fields["UTM Medium"]) + " " + decode(r.fields["UTM Campaign"])))
        .map((r) => ({ source: decode(r.fields["UTM Source"]), medium: decode(r.fields["UTM Medium"]), campaign: decode(r.fields["UTM Campaign"]) }));
      const hitAgg = {};
      for (const h of hit) { const k = h.source + " | " + h.medium + " | " + h.campaign; hitAgg[k] = (hitAgg[k] || 0) + 1; }
      res.statusCode = 200;
      return res.end(JSON.stringify({
        lignes_vue: rows.length, emails_uniques: uniq.size, lignes_sans_email: rows.length - withEmail.length,
        doublons_email: withEmail.length - uniq.size,
        inscrits_dashboard: uniq.size + (rows.length - withEmail.length),
        sources: srcList,
        larcheveque_linkedin: { lignes: hit.length, detail: hitAgg },
      }, null, 2));
    } catch (e) { res.statusCode = 502; return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  if (only === "p3-meta-signups") {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    try {
      const [optins, clients] = await Promise.all([
        airtableAll(T.optin, ["Email", "Created", "UTM Source"], null, "Inscrits Webi 3"),
        airtableAll(T.clients, ["Email", "UTM Source", "Statut Paiement", "Promo"], `TRIM(UPPER({Promo})) = 'PROMO 3'`),
      ]);
      const seen = new Map();
      for (const r of optins) { const em = lower(r.fields["Email"]); const key = em || r.id; if (!seen.has(key)) seen.set(key, r); }
      const emailChan = {}, emailCreated = {};
      for (const r of seen.values()) { const em = lower(r.fields["Email"]); if (!em) continue; emailChan[em] = chanFromSrc(r.fields["UTM Source"]); emailCreated[em] = norm(r.fields["Created"]).slice(0, 10); }
      const rows = [];
      for (const c of clients) {
        const st = norm(c.fields["Statut Paiement"]); if (st === "En attente" || st === "Échec") continue;
        const src = norm(c.fields["UTM Source"]), em = lower(c.fields["Email"]);
        const chan = src ? chanFromSrc(src) : (em && emailChan[em]) || "Direct / Site";
        if (chan !== "Paid Meta (ads)") continue;
        rows.push({ email: em, webiCreated: emailCreated[em] || null, statut: st });
      }
      const after = (d) => rows.filter((r) => r.webiCreated && r.webiCreated > d).length;
      const sansDate = rows.filter((r) => !r.webiCreated).length;
      res.statusCode = 200;
      return res.end(JSON.stringify({
        paid_meta_payes: rows.length,
        avec_date_webi: rows.length - sansDate, sans_date_webi: sansDate,
        apres_samedi_12_09: after("2026-09-12"), // inscription webi le 13/09 ou après
        apres_dimanche_13_09: after("2026-09-13"), // inscription webi le 14/09 ou après
        detail: rows.slice().sort((a, b) => String(a.webiCreated).localeCompare(String(b.webiCreated))),
      }));
    } catch (e) { res.statusCode = 502; return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  try {
    if (!_cache.data || Date.now() - _cache.at > _TTL) {
      if (!_inflight) _inflight = (async () => {
        const [p2, p3, p4] = await Promise.all([buildPromo2(), buildPromo3(), buildPromo4()]);
        return {
          generatedAt: new Date().toISOString(),
          colors: COLORS,
          promoOrder: ["PROMO 1", "PROMO 2", "PROMO 3", "PROMO 4"],
          scopes: { "PROMO 1": promo1Scope(), "PROMO 2": p2, "PROMO 3": p3, "PROMO 4": p4 },
        };
      })().finally(() => { _inflight = null; });
      const data = await _inflight;
      _cache = { at: Date.now(), data };
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(_cache.data));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: e.message }));
  }
};

// Export pour tests hors-ligne (p3-selftest) : n'altère pas le handler Vercel.
module.exports._test = { buildPromo3, buildPromo4, buildPromo2, promo1Scope };
