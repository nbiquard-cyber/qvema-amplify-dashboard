// QVEMA Amplify — Acquisition data API (bilan ads & funnel par promo)
// Même pattern que data.js : auth cockpit + Airtable live, cache court.
// - Dépense Meta / campagnes = CONSTANTES validées (exports Ads Manager consolidés,
//   comptes bloqués → pas d'API fiable). Sources : CSV 24/06→23/07 (3 comptes P2),
//   exports Le Cab + MON ASSOCIE FACTORY (P1). Attribution = UTM (source de vérité).
// - PROMO 1 : bilan FIGÉ (post-mortem validé, cascade premier-contact incl. lead form).
// - PROMO 2 : inscrits & ventes par canal recalculés LIVE depuis Airtable
//   (cascade : ① UTM checkout → ② match e-mail opt-in → ③ Direct).
const auth = require("./_auth.js");

const CONFIG = {
  airtableToken: process.env.AIRTABLE_TOKEN || "",
  airtableBase: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
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

async function airtableAll(table, fields, filterByFormula) {
  const out = [];
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${CONFIG.airtableBase}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (fields) fields.forEach((f) => url.searchParams.append("fields[]", f));
    if (filterByFormula) url.searchParams.set("filterByFormula", filterByFormula);
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

function decode(c) {
  try { return decodeURIComponent((c || "").replace(/\+/g, " ")); } catch (_) { return c || ""; }
}

async function buildPromo2() {
  const [optins, clients] = await Promise.all([
    airtableAll(T.optin, ["Email", "Created", "UTM Source", "UTM Campaign"],
      `IS_AFTER({Created}, '2026-06-15')`),
    airtableAll(T.clients, ["Email", "UTM Source", "Montant", "Mode de paiement", "Statut Paiement", "Promo", "Date Paiement"],
      `{Promo} = 'PROMO 2'`),
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
const _TTL = 60000;

module.exports = async (req, res) => {
  const user = auth.authFromRequest(req);
  if (!user) { res.statusCode = 401; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: "unauthorized" })); }
  if (!auth.has(user.perms, "bootcamp")) { res.statusCode = 403; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ error: "forbidden" })); }
  try {
    if (!_cache.data || Date.now() - _cache.at > _TTL) {
      const p2 = await buildPromo2();
      _cache = { at: Date.now(), data: {
        generatedAt: new Date().toISOString(),
        colors: COLORS,
        promoOrder: ["PROMO 2", "PROMO 1"],
        scopes: { "PROMO 1": promo1Scope(), "PROMO 2": p2 },
      } };
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
