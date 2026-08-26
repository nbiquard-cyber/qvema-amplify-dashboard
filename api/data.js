// QVEMA Amplify — Live dashboard data API
// Aggregates Airtable (CRM) + Stripe (paiements) and returns JSON.
// Read-only. Auth via token cockpit (Authorization: Bearer) + permissions par vue.
const auth = require("./_auth.js");

const CONFIG = {
  airtableToken: process.env.AIRTABLE_TOKEN || "",
  airtableBase: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
  stripeKey: process.env.STRIPE_KEY || "",
  password: process.env.DASHBOARD_PASSWORD || "",
};

// Airtable table ids
const T = {
  clients: "tblalRhenwmZZgenq", // Bootcamp
  connect: "tblRnZSfcOqww83ua", // Amplify connect (payeurs)
  candidatures: "tblRZz5ZmEMRymltB", // Candidatures Amplify Connect
  accueil: "tbl50HZE7JH2E24xv", // Accueil Bootcamp (onboarding : secteur d'activité)
};

// Stripe amount buckets (in cents / centimes)
const BOOTCAMP_1X = [129000, 99000, 149000]; // paiement 1 fois (1290€, ancien 990€, PROMO 2 = 1490€)
const BOOTCAMP_4X = [32250, 46666, 37250]; // mensualité plan 4x (322,50€, ancien 466,66€, PROMO 2 = 372,50€ = 1490/4)
const AMPLIFY = [100000]; // Amplify Connect (1000€) - jamais compté dans le bootcamp

async function airtableAll(table, fields) {
  const out = [];
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${CONFIG.airtableBase}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (fields) fields.forEach((f) => url.searchParams.append("fields[]", f));
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${CONFIG.airtableToken}` },
    });
    if (!r.ok) throw new Error(`Airtable ${table} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.records);
    offset = j.offset;
  } while (offset);
  return out;
}

async function stripeList(resource, params = {}) {
  const out = [];
  let startingAfter = null;
  do {
    const url = new URL(`https://api.stripe.com/v1/${resource}`);
    url.searchParams.set("limit", "100");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${CONFIG.stripeKey}` },
    });
    if (!r.ok) throw new Error(`Stripe ${resource} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.data);
    if (j.has_more && j.data.length) startingAfter = j.data[j.data.length - 1].id;
    else startingAfter = null;
  } while (startingAfter);
  return out;
}

function bucket(amount) {
  if (BOOTCAMP_1X.includes(amount)) return "b1x";
  if (BOOTCAMP_4X.includes(amount)) return "b4x";
  if (AMPLIFY.includes(amount)) return "amplify";
  return "other";
}

// --- Stockage partagé de l'agenda des lives (table "Agenda Lives", 1 enreg. Clé=store) ---
const AGENDA_TABLE = "tblyw8J0NEPRXQARb";
const AGENDA_WRITE_TOKEN = process.env.AIRTABLE_WRITE_TOKEN || CONFIG.airtableToken;
function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
async function agendaRecord() {
  const url = "https://api.airtable.com/v0/" + CONFIG.airtableBase + "/" + AGENDA_TABLE +
    "?maxRecords=1&filterByFormula=" + encodeURIComponent("{Clé}='store'");
  const r = await fetch(url, { headers: { Authorization: "Bearer " + AGENDA_WRITE_TOKEN } });
  if (!r.ok) throw new Error("agenda read " + r.status);
  const j = await r.json();
  return (j.records && j.records[0]) || null;
}
function agendaEvents(rec) { try { return rec ? (JSON.parse(rec.fields.Data || "{}") || {}) : {}; } catch (e) { return {}; } }
async function agendaWrite(events, rec) {
  const fields = { "Clé": "store", Data: JSON.stringify(events), Updated: new Date().toISOString() };
  const base = "https://api.airtable.com/v0/" + CONFIG.airtableBase + "/" + AGENDA_TABLE;
  const opt = rec
    ? { url: base + "/" + rec.id, method: "PATCH", body: JSON.stringify({ fields }) }
    : { url: base, method: "POST", body: JSON.stringify({ records: [{ fields }] }) };
  const r = await fetch(opt.url, { method: opt.method, headers: { Authorization: "Bearer " + AGENDA_WRITE_TOKEN, "Content-Type": "application/json" }, body: opt.body });
  if (!r.ok) throw new Error("agenda write " + r.status + ": " + (await r.text()).slice(0, 150));
}

// --- Démographie : département (code postal) -> région française ---
// La feuille Clients n'a pas de champ Région : on le déduit du code postal.
const REGION_BY_DEPT = (() => {
  const map = {};
  const src = {
    "Auvergne-Rhône-Alpes": "01 03 07 15 26 38 42 43 63 69 73 74",
    "Bourgogne-Franche-Comté": "21 25 39 58 70 71 89 90",
    "Bretagne": "22 29 35 56",
    "Centre-Val de Loire": "18 28 36 37 41 45",
    "Corse": "20 2A 2B",
    "Grand Est": "08 10 51 52 54 55 57 67 68 88",
    "Hauts-de-France": "02 59 60 62 80",
    "Île-de-France": "75 77 78 91 92 93 94 95",
    "Normandie": "14 27 50 61 76",
    "Nouvelle-Aquitaine": "16 17 19 23 24 33 40 47 64 79 86 87",
    "Occitanie": "09 11 12 30 31 32 34 46 48 65 66 81 82",
    "Pays de la Loire": "44 49 53 72 85",
    "Provence-Alpes-Côte d'Azur": "04 05 06 13 83 84",
  };
  for (const [region, depts] of Object.entries(src))
    for (const d of depts.split(" ")) map[d] = region;
  return map;
})();

function regionFromFields(f) {
  const pays = (f["Pays"] || "").toString().trim();
  if (pays && !/^(france|fr)$/i.test(pays)) return "Étranger";
  const cp = (f["Code postal"] || "").toString().trim().replace(/\s+/g, "");
  if (!cp) return "Non renseigné";
  const d2 = cp.slice(0, 2);
  if (d2 === "97" || d2 === "98") return "Outre-Mer"; // DOM-TOM
  return REGION_BY_DEPT[d2] || "Non renseigné";
}

// Centroïdes (lng, lat) des départements métropolitains + Corse — pour la carte Amplify.
const DEPT_CENTROIDS = {"10":[4.161,48.305],"11":[2.414,43.103],"12":[2.679,44.281],"13":[5.086,43.543],"14":[-0.362,49.1],"15":[2.669,45.051],"16":[0.203,45.719],"17":[-0.654,45.766],"18":[2.491,47.066],"19":[1.878,45.357],"21":[4.773,47.426],"22":[-2.865,48.44],"23":[2.018,46.091],"24":[0.741,45.105],"25":[6.363,47.166],"26":[5.164,44.679],"27":[0.996,49.114],"28":[1.37,48.388],"29":[-4.057,48.261],"30":[4.18,43.994],"31":[1.175,43.359],"32":[0.453,43.693],"33":[-0.583,44.839],"34":[3.369,43.579],"35":[-1.634,48.151],"36":[1.576,46.778],"37":[0.691,47.258],"38":[5.574,45.264],"39":[5.697,46.729],"40":[-0.784,43.966],"41":[1.428,47.617],"42":[4.165,45.728],"43":[3.806,45.128],"44":[-1.679,47.363],"45":[2.344,47.912],"46":[1.606,44.625],"47":[0.461,44.368],"48":[3.5,44.517],"49":[-0.559,47.39],"50":[-1.329,49.081],"51":[4.239,48.95],"52":[5.226,48.11],"53":[-0.657,48.147],"54":[6.162,48.788],"55":[5.381,48.991],"56":[-2.804,47.855],"57":[6.661,49.038],"58":[3.504,47.116],"59":[3.216,50.449],"60":[2.425,49.41],"61":[0.128,48.623],"62":[2.289,50.493],"63":[3.14,45.726],"64":[-0.758,43.257],"65":[0.166,43.051],"66":[2.521,42.599],"67":[7.552,48.671],"68":[7.274,47.859],"69":[4.641,45.871],"70":[6.087,47.641],"71":[4.543,46.645],"72":[0.223,47.995],"73":[6.443,45.478],"74":[6.428,46.035],"75":[2.343,48.857],"76":[1.027,49.655],"77":[2.934,48.627],"78":[1.841,48.815],"79":[-0.318,46.557],"80":[2.276,49.958],"81":[2.166,43.786],"82":[1.282,44.086],"83":[6.244,43.444],"84":[5.185,43.994],"85":[-1.288,46.673],"86":[0.459,46.565],"87":[1.235,45.892],"88":[6.38,48.196],"89":[3.563,47.841],"90":[6.929,47.632],"91":[2.243,48.523],"92":[2.246,48.848],"93":[2.478,48.918],"94":[2.469,48.777],"95":[2.131,49.083],"01":[5.349,46.1],"02":[3.559,49.561],"03":[3.188,46.394],"04":[6.245,44.106],"05":[6.265,44.664],"06":[7.116,43.938],"2A":[8.987,41.864],"2B":[9.206,42.395],"07":[4.426,44.753],"08":[4.641,49.616],"09":[1.504,42.921]};

// Répartition par région + points carte (par département) pour une liste Amplify.
function computeAmplifyGeo(list) {
  const regions = {};
  const byDept = {};
  let horsCarte = 0;
  const titlecase = (s) =>
    s.toLowerCase().replace(/(^|[\s\-'])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
  for (const c of list) {
    const rg = regionFromFields(c.fields);
    regions[rg] = (regions[rg] || 0) + 1;
    const pays = (c.fields["Pays"] || "").toString().trim();
    const cp = (c.fields["Code postal"] || "").toString().trim().replace(/\s+/g, "");
    const ville = (c.fields["Ville"] || "").toString().trim().replace(/\s+/g, " ");
    if ((pays && !/^(fr|france)$/i.test(pays)) || !cp) { horsCarte++; continue; }
    let dept = cp.slice(0, 2);
    if (dept === "20") dept = parseInt(cp, 10) < 20200 ? "2A" : "2B";
    const cen = DEPT_CENTROIDS[dept];
    if (!cen) { horsCarte++; continue; } // Outre-mer / inconnu : pas sur la carte métropole
    const e = byDept[dept] || (byDept[dept] = { dept, lng: cen[0], lat: cen[1], count: 0, region: REGION_BY_DEPT[dept] || rg, villes: {} });
    e.count++;
    if (ville) { const v = titlecase(ville); e.villes[v] = (e.villes[v] || 0) + 1; }
  }
  const points = Object.values(byDept).map((p) => ({
    dept: p.dept, lat: p.lat, lng: p.lng, count: p.count, region: p.region,
    villes: Object.keys(p.villes).sort((a, b) => p.villes[b] - p.villes[a]).slice(0, 6),
  }));
  return { regions, map: { points, horsCarte, total: list.length } };
}

// Répartition H/F, âge moyen (+ tranches) et régions pour une liste de clients.
function computeDemographics(list) {
  let Homme = 0, Femme = 0, nonRenseigne = 0;
  const ages = [];
  const tranches = { "< 30 ans": 0, "30–39 ans": 0, "40–49 ans": 0, "50–59 ans": 0, "60 ans et +": 0 };
  const regions = {};
  for (const c of list) {
    const sx = (c.fields["Sexe"] || "").toString().trim();
    if (sx === "Homme") Homme++;
    else if (sx === "Femme") Femme++;
    else nonRenseigne++;

    const age = Number(c.fields["Age"]);
    if (Number.isFinite(age) && age > 0 && age < 120) {
      ages.push(age);
      if (age < 30) tranches["< 30 ans"]++;
      else if (age < 40) tranches["30–39 ans"]++;
      else if (age < 50) tranches["40–49 ans"]++;
      else if (age < 60) tranches["50–59 ans"]++;
      else tranches["60 ans et +"]++;
    }

    const rg = regionFromFields(c.fields);
    regions[rg] = (regions[rg] || 0) + 1;
  }
  const ageMoyen = ages.length
    ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10
    : null;
  return {
    effectif: list.length,
    genre: { Homme, Femme, nonRenseigne },
    age: {
      moyen: ageMoyen,
      renseignes: ages.length,
      min: ages.length ? Math.min(...ages) : null,
      max: ages.length ? Math.max(...ages) : null,
      tranches,
    },
    regions,
  };
}

// Cache mémoire court (instance chaude) : évite de ré-agréger Airtable + Stripe
// à chaque appel rapproché. Non partagé entre instances, mais absorbe les rafales.
let _cache = { at: 0, data: null };
const _CACHE_TTL = 60000;

module.exports = async (req, res) => {
  const user = auth.authFromRequest(req);
  if (!user) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }
  // Sous-routes hébergées sur /api/data (limite Hobby : pas de nouvelle fonction serverless).
  const only = (req.query && req.query.only) || require("url").parse(req.url, true).query.only;

  // POST : crée/MET À JOUR un live (brouillon) dans Circle depuis l'agenda. Accès agenda/bootcamp/amplify.
  if (req.method === "POST" && (only === "create-live-draft" || only === "update-live-draft")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (!auth.has(user.perms, "agenda") && !auth.has(user.perms, "bootcamp") && !auth.has(user.perms, "amplify")) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ ok: false, error: "forbidden" }));
    }
    try {
      const body = await readBody(req);
      const circle = require("./_circle.js");
      const r = only === "update-live-draft" ? await circle.updateLiveDraft(body) : await circle.createLiveDraft(body);
      res.statusCode = 200;
      return res.end(JSON.stringify(r));
    } catch (e) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }

  // Agenda des lives — stockage PARTAGÉ (lecture/écriture). Accès : agenda, bootcamp ou amplify.
  if (only === "agenda-events" || only === "agenda-save" || only === "agenda-delete" || only === "agenda-set-all") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (!auth.has(user.perms, "agenda") && !auth.has(user.perms, "bootcamp") && !auth.has(user.perms, "amplify")) {
      res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: "forbidden" }));
    }
    try {
      const rec = await agendaRecord();
      if (req.method !== "POST" && only === "agenda-events") {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, events: agendaEvents(rec), seeded: !!rec }));
      }
      const body = await readBody(req);
      let events = agendaEvents(rec);
      if (only === "agenda-set-all") { events = (body.events && typeof body.events === "object") ? body.events : {}; }
      else if (only === "agenda-save") { const ev = body.event; if (!ev || ev.id == null) throw new Error("event.id requis"); events[ev.id] = ev; }
      else if (only === "agenda-delete") { if (body.id != null) delete events[body.id]; }
      else { throw new Error("action agenda invalide"); }
      await agendaWrite(events, rec);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, count: Object.keys(events).length }));
    } catch (e) {
      res.statusCode = 502; return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }

  // Accès aux données business (toutes les autres routes) : nécessite Bootcamp ou Amplify (ou Admin).
  if (!auth.has(user.perms, "bootcamp") && !auth.has(user.perms, "amplify")) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "forbidden" }));
  }

  if (only === "progression") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      const prog = await require("./_circle.js").progression();
      res.statusCode = 200;
      return res.end(JSON.stringify(prog));
    } catch (e) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }

  // Diagnostic : tous les paiements Stripe d'un email. ?only=charges&email=...
  if (only === "charges") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      const norm = (s) => (s || "").toString().trim();
      const lower = (s) => norm(s).toLowerCase();
      const q = lower((req.query && req.query.email) || require("url").parse(req.url, true).query.email);
      if (!q) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: "email requis" })); }
      const charges = await stripeList("charges");
      const chargeEmail = (c) => lower((c.billing_details && c.billing_details.email) || c.receipt_email || "");
      const mine = charges.filter((c) => chargeEmail(c) === q).map((c) => ({
        date: new Date((c.created || 0) * 1000).toISOString().slice(0, 10),
        montant: c.amount / 100, status: c.status, paid: !!c.paid,
        rembourse: (c.amount_refunded || 0) / 100, desc: c.description || "",
      })).sort((a, b) => (a.date < b.date ? -1 : 1));
      const net = mine.filter((c) => c.status === "succeeded" && c.paid).reduce((s, c) => s + (c.montant - c.rembourse), 0);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, email: q, count: mine.length, totalNetPaye: Math.round(net * 100) / 100, charges: mine }));
    } catch (e) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }

  // Diagnostic mensualités : croise la liste Airtable d'une promo (payés) avec Stripe,
  // échéance par échéance, pour vérifier la 2e mensualité des payeurs 4x. ?only=mensualites&promo=PROMO%202
  if (only === "mensualites") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    try {
      const norm = (s) => (s || "").toString().trim();
      const lower = (s) => norm(s).toLowerCase();
      const promoWanted = ((req.query && req.query.promo) || require("url").parse(req.url, true).query.promo || "PROMO 2").toUpperCase();
      const [clients, charges] = await Promise.all([
        airtableAll(T.clients, ["Promo", "Statut Paiement", "Email", "Prénom", "Nom"]),
        stripeList("charges"),
      ]);
      const wanted = clients.filter((c) => norm(c.fields["Promo"]).toUpperCase() === promoWanted && norm(c.fields["Statut Paiement"]) === "Payé");
      const chargeEmail = (c) => lower((c.billing_details && c.billing_details.email) || c.receipt_email || "");
      const INST = 37250, FULL = [149000, 129000, 99000]; // mensualité 4x Promo 2 / paiement 1x
      const byEmail = {};
      for (const c of charges) {
        const em = chargeEmail(c); if (!em) continue;
        const b = byEmail[em] || (byEmail[em] = { paid: [], failed: [], oneShot: false });
        const ok = c.status === "succeeded" && c.paid;
        if (c.amount === INST) { if (ok) b.paid.push((c.created || 0) * 1000); else if (c.status === "failed") b.failed.push((c.created || 0) * 1000); }
        else if (FULL.includes(c.amount) && ok) b.oneShot = true;
      }
      const NOW = Date.now(), DAY = 86400000, MONTH = 30.44 * DAY, GRACE = 7 * DAY;
      const d = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : null);
      const rows = wanted.map((c) => {
        const em = lower(c.fields["Email"]);
        const b = byEmail[em] || { paid: [], failed: [], oneShot: false };
        const inst = b.paid.slice().sort((a, z) => a - z);
        const n = inst.length, first = inst[0] || null;
        return {
          nom: (norm(c.fields["Prénom"]) + " " + norm(c.fields["Nom"])).trim(), email: em,
          mode: b.oneShot ? "1x" : (n ? "4x" : "?"),
          installmentsPaid: n, firstPaid: d(first), secondPaid: n >= 2, secondDate: d(inst[1] || null),
          secondDue: first ? first + MONTH + GRACE <= NOW : false,
          failedAttempts: b.failed.length, lastFailed: d(b.failed.sort((a, z) => z - a)[0] || null),
        };
      });
      const four = rows.filter((r) => r.mode === "4x");
      const out = {
        ok: true, promo: promoWanted, totalPayes: wanted.length,
        quatreFois: four.length, unFois: rows.filter((r) => r.mode === "1x").length,
        sansMatchStripe: rows.filter((r) => r.mode === "?"),
        secondPaidCount: four.filter((r) => r.secondPaid).length,
        secondUnpaidDue: four.filter((r) => !r.secondPaid && r.secondDue),
        secondNotDueYet: four.filter((r) => !r.secondPaid && !r.secondDue),
        withFailedAttempts: four.filter((r) => r.failedAttempts > 0),
        rows: four,
      };
      res.statusCode = 200;
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }

  try {
    // Cache chaud : réponse quasi instantanée si les données ont < 60 s.
    if (_cache.data && Date.now() - _cache.at < _CACHE_TTL) {
      const out = { ..._cache.data };
      if (!auth.has(user.perms, "bootcamp")) delete out.bootcamp;
      if (!auth.has(user.perms, "amplify")) delete out.amplify;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify(out));
    }

    // ---------- AIRTABLE ----------
    const [clientsRaw, connect, candidatures, accueilRaw] = await Promise.all([
      airtableAll(T.clients, ["Promo", "Montant", "Statut Paiement", "Produit", "Date Paiement", "Email", "Sexe", "Age", "Code postal", "Pays", "Mode de paiement", "Prénom", "Nom"]),
      airtableAll(T.connect, ["Email", "Nom complet", "Montant", "Statut Paiement", "Date Paiement", "Mode Paiement", "Saison QVEMA", "Statut Membre", "Code postal", "Ville", "Pays"]),
      airtableAll(T.candidatures, ["Statut Candidature", "Statut Membre", "Mode de paiement", "Date Candidature", "Sous-cercle d'intérêt", "Saison"]),
      airtableAll(T.accueil, ["Promo", "Secteur d'activité", "Stade d'avancement", "Région", "Adresse mail", "Horodatage"]),
    ]);

    const norm = (s) => (s || "").toString().trim();
    const lower = (s) => norm(s).toLowerCase();
    const promoOf = (c) => norm(c.fields["Promo"]) || "Sans promo";

    // Exclusion des TESTS INTERNES (Promo contenant "test") : ne doivent jamais
    // apparaître ni fausser les stats (inscrits, CA, démographie, secteurs/stades…).
    const isTestInterne = (rec) => /test/i.test(norm(rec.fields["Promo"]));
    const clients = clientsRaw.filter((c) => !isTestInterne(c));
    const accueil = accueilRaw.filter((a) => !isTestInterne(a));

    // ----- Bootcamp (Clients) -----
    const bcPaid = clients.filter((c) => norm(c.fields["Statut Paiement"]) === "Payé");

    // byPromo (comparatif global : inscrits + CA généré par promo)
    const byPromo = {};
    for (const c of bcPaid) {
      const p = promoOf(c);
      const m = Number(c.fields["Montant"]) || 0;
      byPromo[p] = byPromo[p] || { count: 0, montant: 0 };
      byPromo[p].count++;
      byPromo[p].montant += m;
    }

    // Remboursements (global + par promo)
    const refunds = clients.filter((c) => norm(c.fields["Statut Paiement"]) === "Remboursé");
    const caRembourse = refunds.reduce((a, c) => a + (Number(c.fields["Montant"]) || 0), 0);
    const refundByPromo = {};
    for (const c of refunds) {
      const p = promoOf(c);
      const m = Number(c.fields["Montant"]) || 0;
      refundByPromo[p] = refundByPromo[p] || { count: 0, montant: 0 };
      refundByPromo[p].count++;
      refundByPromo[p].montant += m;
    }

    // Statuts de paiement par promo + global
    const statutGlobal = {};
    const statutByPromo = {};
    for (const c of clients) {
      const s = norm(c.fields["Statut Paiement"]) || "Inconnu";
      const p = promoOf(c);
      statutGlobal[s] = (statutGlobal[s] || 0) + 1;
      statutByPromo[p] = statutByPromo[p] || {};
      statutByPromo[p][s] = (statutByPromo[p][s] || 0) + 1;
    }

    // email -> promo (parmi les inscrits payés) pour attribuer les paiements Stripe
    const emailToPromo = {};
    for (const c of bcPaid) {
      const em = lower(c.fields["Email"]);
      if (em) emailToPromo[em] = promoOf(c);
    }
    // email -> promo pour TOUS les clients (dont remboursés) : attribution des refunds Stripe
    const emailToPromoAll = {};
    for (const c of clients) {
      const em = lower(c.fields["Email"]);
      if (em) emailToPromoAll[em] = promoOf(c);
    }

    // ----- Amplify Connect (payeurs Airtable) -----
    const acMembers = connect;
    const acCaAirtable = acMembers.reduce((a, c) => a + (Number(c.fields["Montant"]) || 0), 0);
    const acBySaison = {};
    const acByMode = {};
    for (const c of acMembers) {
      const s = norm(c.fields["Saison QVEMA"]) || "—";
      const mode = norm(c.fields["Mode Paiement"]) || "—";
      acBySaison[s] = (acBySaison[s] || 0) + 1;
      acByMode[mode] = (acByMode[mode] || 0) + 1;
    }
    const acGeo = computeAmplifyGeo(acMembers); // { regions, map:{points,horsCarte,total} }
    const candByStatut = {};
    const candByMode = {};
    const candBySousCercle = {};
    for (const c of candidatures) {
      const s = norm(c.fields["Statut Candidature"]) || "—";
      const mode = norm(c.fields["Mode de paiement"]) || "—";
      const sc = norm(c.fields["Sous-cercle d'intérêt"]) || "—";
      candByStatut[s] = (candByStatut[s] || 0) + 1;
      candByMode[mode] = (candByMode[mode] || 0) + 1;
      candBySousCercle[sc] = (candBySousCercle[sc] || 0) + 1;
    }

    // ---------- STRIPE ----------
    let stripeOk = true;
    let stripeError = null;
    let charges = [];
    let subs = [];
    try {
      [charges, subs] = await Promise.all([
        stripeList("charges"),
        stripeList("subscriptions", { status: "all" }),
      ]);
    } catch (e) {
      stripeOk = false;
      stripeError = e.message;
    }

    const succeeded = charges.filter((c) => c.status === "succeeded" && c.paid);
    const chargeEmail = (c) => lower((c.billing_details && c.billing_details.email) || c.receipt_email || "");

    // Attribution des paiements bootcamp (par promo via e-mail) + set des payeurs 4x
    let caEncGlobal = 0;
    let instGlobal = 0; // nb de mensualités 4x encaissées
    const caEncByPromo = {};
    const instByPromo = {};
    const instByEmail = {}; // email -> { count, amount(cts), last(ms) } pour les impayés
    const emails4x = new Set();
    // Montant RÉELLEMENT remboursé (Stripe amount_refunded), pas la valeur du contrat.
    let refundEncGlobal = 0;
    const refundEncByPromo = {};
    for (const c of succeeded) {
      const b = bucket(c.amount);
      if (b !== "b1x" && b !== "b4x") continue; // Amplify & autres exclus du bootcamp
      const net = (c.amount - (c.amount_refunded || 0)) / 100;
      const em = chargeEmail(c);
      const promo = em && emailToPromo[em] ? emailToPromo[em] : null;
      caEncGlobal += net;
      if (promo) caEncByPromo[promo] = (caEncByPromo[promo] || 0) + net;
      if (b === "b4x") {
        instGlobal++;
        if (em) emails4x.add(em);
        if (promo) instByPromo[promo] = (instByPromo[promo] || 0) + 1;
        // Suivi par personne pour le calcul des impayés (recouvrement).
        if (em) {
          const ie = (instByEmail[em] = instByEmail[em] || { count: 0, amount: c.amount, first: Infinity, last: 0, refunded: false });
          ie.count++; ie.amount = c.amount;
          if ((c.amount_refunded || 0) > 0) ie.refunded = true; // mensualité remboursée => pas un impayé
          const cr = (c.created || 0) * 1000;
          if (cr > ie.last) ie.last = cr;
          if (cr && cr < ie.first) ie.first = cr;
        }
      }
      // Refund réel (une ou plusieurs mensualités selon le cas)
      const refd = (c.amount_refunded || 0) / 100;
      if (refd > 0) {
        refundEncGlobal += refd;
        const rp = em && emailToPromoAll[em] ? emailToPromoAll[em] : null;
        if (rp) refundEncByPromo[rp] = (refundEncByPromo[rp] || 0) + refd;
      }
    }

    // Tentatives de mensualité 4x ÉCHOUÉES dans Stripe (par email, la plus récente).
    const lastFailedByEmail = {};
    for (const c of charges) {
      if (c.status === "failed" && bucket(c.amount) === "b4x") {
        const em = chargeEmail(c);
        if (em) { const ts = (c.created || 0) * 1000; if (ts > (lastFailedByEmail[em] || 0)) lastFailedByEmail[em] = ts; }
      }
    }
    // Total net encaissé par email sur le bootcamp (mensualités + solde payé en une fois, ex.
    // "Solde Bootcamp…"), hors produit Amplify (1000€) : sert à détecter les plans 4x SOLDÉS.
    const bcNetByEmail = {};
    for (const c of succeeded) {
      if (bucket(c.amount) === "amplify") continue;
      const em = chargeEmail(c);
      if (em) bcNetByEmail[em] = (bcNetByEmail[em] || 0) + (c.amount - (c.amount_refunded || 0)) / 100;
    }

    // ----- Impayés (recouvrement) : payeurs 4x en retard sur l'échéancier OU dont une
    // mensualité a échoué dans Stripe (tentative échouée après le dernier paiement réussi).
    // Les remboursés sont exclus. Montant impayé = échéances non réglées x montant mensuel.
    const nameByEmail = {};
    for (const c of clients) { const e = lower(c.fields["Email"]); if (e) nameByEmail[e] = (norm(c.fields["Prénom"]) + " " + norm(c.fields["Nom"])).trim(); }
    const refundedSet = new Set(refunds.map((c) => lower(c.fields["Email"])).filter(Boolean));
    const NOW = Date.now(), DAY = 86400000, MONTH = 30.44 * DAY, GRACE = 7 * DAY;
    const impayesByPromo = {}, impayesAll = [];
    for (const e in instByEmail) {
      const info = instByEmail[e];
      if (refundedSet.has(e) || info.refunded) continue; // remboursé => pas un impayé
      if (info.count >= 4) continue; // plan 4x soldé (4 mensualités)
      // Solde payé en une fois : total net encaissé >= mensualité × 4 (tolérance 1€) => à jour.
      if ((bcNetByEmail[e] || 0) >= (info.amount / 100) * 4 - 1) continue;
      const first = isFinite(info.first) ? info.first : info.last;
      // Mensualités DÉJÀ ÉCHUES à ce jour (1 à la souscription puis 1/mois), tolérance 7j.
      let echues = 0;
      for (let k = 0; k < 4; k++) { if (first + k * MONTH + GRACE <= NOW) echues++; }
      let retard = Math.max(0, echues - info.count); // échéances passées non payées (calendrier)
      // Échec Stripe : une tentative échouée APRÈS le dernier paiement réussi = mensualité en
      // échec non rattrapée (même si la tolérance calendaire de 7 j n'est pas encore dépassée).
      const lf = lastFailedByEmail[e] || 0;
      const echecStripe = lf > (info.last || 0);
      if (echecStripe) retard = Math.max(retard, 1);
      if (retard < 1) continue; // à jour : aucune échéance due non réglée, aucun échec Stripe
      const perso = {
        email: e, nom: nameByEmail[e] || "", promo: emailToPromoAll[e] || "Sans promo",
        paye: info.count, echues: Math.max(echues, info.count + (echecStripe ? 1 : 0)), retard,
        mensualite: Math.round((info.amount / 100) * 100) / 100,
        montant: Math.round(retard * (info.amount / 100) * 100) / 100,
        dernierPaiement: info.last ? new Date(info.last).toISOString().slice(0, 10) : null,
        echecStripe, dernierEchec: echecStripe ? new Date(lf).toISOString().slice(0, 10) : null,
      };
      (impayesByPromo[perso.promo] = impayesByPromo[perso.promo] || []).push(perso);
      impayesAll.push(perso);
    }
    const impayeScope = (list) => {
      const arr = (list || []).slice().sort((a, b) => b.montant - a.montant);
      return { count: arr.length, montant: Math.round(arr.reduce((s, x) => s + x.montant, 0) * 100) / 100, personnes: arr };
    };

    // Santé des abonnements bootcamp (global)
    const subProduct = (s) => { try { return s.items.data[0].price.product; } catch (_) { return null; } };
    const BOOTCAMP_PRODUCTS = ["prod_UZ1KUTItSVpKvk", "prod_UVLeGAeB6HXrRD"];
    const bcSubs = subs.filter((s) => BOOTCAMP_PRODUCTS.includes(subProduct(s)));
    const bcSubsByStatus = {};
    for (const s of bcSubs) bcSubsByStatus[s.status] = (bcSubsByStatus[s.status] || 0) + 1;

    // Construit un objet d'indicateurs pour une liste d'inscrits payés
    const buildScope = (list, caEnc, installments, statutCounts) => {
      let caGenere = 0;
      const byDay = {};
      let nb4x = 0;
      for (const c of list) {
        caGenere += Number(c.fields["Montant"]) || 0;
        const d = c.fields["Date Paiement"];
        if (d) { const day = d.slice(0, 10); byDay[day] = (byDay[day] || 0) + 1; }
        // 4x/1x : on se base sur le champ Airtable "Mode de paiement" (1x / 4x).
        // Fallback sur les charges Stripe (emails4x) uniquement quand le mode n'est
        // pas renseigné (ex. promos où le champ n'est pas encore saisi), pour ne pas
        // casser leur décompte historique.
        const mode = norm(c.fields["Mode de paiement"]).toLowerCase();
        const em = lower(c.fields["Email"]);
        const is4x = mode === "4x" ? true : mode === "1x" ? false : (em && emails4x.has(em));
        if (is4x) nb4x++;
      }
      const nb1x = Math.max(0, list.length - nb4x);
      return {
        totalInscrits: list.length,
        caGenere,
        caEncaisse: stripeOk ? Math.round(caEnc * 100) / 100 : null,
        caRestantAEncaisser: stripeOk ? Math.round((caGenere - caEnc) * 100) / 100 : null,
        paiement: { un_fois: nb1x, quatre_fois: nb4x, installments_collectees: installments },
        statutCounts,
        byDay,
        demographics: computeDemographics(list),
      };
    };

    // Secteur d'activité (source : Accueil Bootcamp) — global + par promo.
    // La promo Accueil ("Promo 1") est normalisée en MAJ pour matcher les scopes ("PROMO 1").
    const secteurGlobal = {};
    const secteurByPromo = {};
    const stadeGlobal = {};
    const stadeByPromo = {};
    for (const a of accueil) {
      const p = norm(a.fields["Promo"]).toUpperCase();
      const sec = norm(a.fields["Secteur d'activité"]);
      if (sec) {
        secteurGlobal[sec] = (secteurGlobal[sec] || 0) + 1;
        secteurByPromo[p] = secteurByPromo[p] || {};
        secteurByPromo[p][sec] = (secteurByPromo[p][sec] || 0) + 1;
      }
      const st = norm(a.fields["Stade d'avancement"]);
      if (st) {
        stadeGlobal[st] = (stadeGlobal[st] || 0) + 1;
        stadeByPromo[p] = stadeByPromo[p] || {};
        stadeByPromo[p][st] = (stadeByPromo[p][st] || 0) + 1;
      }
    }

    // Région PROMO 2 : source Accueil Bootcamp (champ "Région"), dédupliquée par
    // e-mail — un même e-mail (plusieurs formulaires) n'est compté qu'UNE fois
    // (on garde le formulaire le plus récent via l'Horodatage).
    const p2RegionByEmail = new Map();
    for (const a of accueil) {
      if (norm(a.fields["Promo"]).toUpperCase() !== "PROMO 2") continue;
      const em = lower(a.fields["Adresse mail"]);
      if (!em) continue;
      const ts = norm(a.fields["Horodatage"]);
      const prev = p2RegionByEmail.get(em);
      if (!prev || ts > prev.ts) p2RegionByEmail.set(em, { region: norm(a.fields["Région"]) || "Non renseigné", ts });
    }
    const regionsPromo2 = {};
    for (const v of p2RegionByEmail.values()) regionsPromo2[v.region] = (regionsPromo2[v.region] || 0) + 1;

    const scopes = {};
    scopes["Toutes"] = buildScope(bcPaid, caEncGlobal, instGlobal, statutGlobal);
    scopes["Toutes"].secteurs = secteurGlobal;
    scopes["Toutes"].stades = stadeGlobal;
    scopes["Toutes"].impayes = impayeScope(impayesAll);
    const promoList = [...new Set(bcPaid.map(promoOf))];
    for (const p of promoList) {
      const list = bcPaid.filter((c) => promoOf(c) === p);
      scopes[p] = buildScope(list, caEncByPromo[p] || 0, instByPromo[p] || 0, statutByPromo[p] || {});
      scopes[p].secteurs = secteurByPromo[p] || {};
      scopes[p].stades = stadeByPromo[p] || {};
      scopes[p].impayes = impayeScope(impayesByPromo[p]);
    }
    // Pour la Promo 2, la région vient d'Accueil (dédupliquée par e-mail), pas du code postal Clients.
    if (scopes["PROMO 2"] && scopes["PROMO 2"].demographics) {
      scopes["PROMO 2"].demographics.regions = regionsPromo2;
    }
    // Remboursements par scope : nombre (Airtable), montant réel (Stripe amount_refunded), taux.
    const attachRefund = (scopeObj, count, montantReel, montantContrat) => {
      const denom = scopeObj.totalInscrits + count; // ventes = payés restants + remboursés
      scopeObj.refund = {
        count,
        montant: stripeOk ? Math.round(montantReel * 100) / 100 : null,
        montantContrat: Math.round(montantContrat * 100) / 100,
        taux: denom ? Math.round((count / denom) * 1000) / 10 : 0,
      };
    };
    attachRefund(scopes["Toutes"], refunds.length, refundEncGlobal, caRembourse);
    for (const p of promoList) {
      const r = refundByPromo[p] || { count: 0, montant: 0 };
      attachRefund(scopes[p], r.count, refundEncByPromo[p] || 0, r.montant);
    }
    // Ordre des boutons : Toutes puis promos (PROMO 1, PROMO 2, ...), on masque "Test interne"
    const promoOrder = ["Toutes", ...promoList.filter((p) => p !== "Test interne").sort()];

    const result = {
      generatedAt: new Date().toISOString(),
      stripe: { ok: stripeOk, error: stripeError, nbCharges: charges.length, nbSubscriptions: subs.length },
      bootcamp: {
        scopes,
        promoOrder,
        byPromo,
        caRembourse,
        nbRembourses: refunds.length,
        subsByStatus: bcSubsByStatus,
        prixUnitaire: 1290,
      },
      amplify: {
        membresPayants: acMembers.length,
        caEncaisse: acCaAirtable,
        caAirtable: acCaAirtable,
        abonnementsActifs: acMembers.length,
        arr: acCaAirtable,
        prixAbonnement: acMembers.length ? Math.round(acCaAirtable / acMembers.length) : 0,
        bySaison: acBySaison,
        byMode: acByMode,
        regions: acGeo.regions,
        map: acGeo.map,
        candidatures: {
          total: candidatures.length,
          byStatut: candByStatut,
          byMode: candByMode,
          bySousCercle: candBySousCercle,
        },
      },
    };

    _cache = { at: Date.now(), data: result };

    // Filtrage par permissions (copie, pour ne pas altérer le cache).
    const out = { ...result };
    if (!auth.has(user.perms, "bootcamp")) delete out.bootcamp;
    if (!auth.has(user.perms, "amplify")) delete out.amplify;

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: e.message }));
  }
};
