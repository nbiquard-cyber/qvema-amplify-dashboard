// QVEMA Amplify — Import automatique des Réseaux sociaux depuis l'Excel Teams.
// Reçoit le contenu de la feuille "BILANS MENSUELS" (tableau 2D des valeurs, plage A1:AH70)
// envoyé par un flux Power Automate (Office Script « Run script » → HTTP POST), le mappe
// en (mois × réseau) et met à jour la table Airtable "RS Mensuel".
//
// Sécurité : header "x-rs-secret" (ou ?secret=) comparé à RS_IMPORT_SECRET. Pas d'auth cockpit.
// Écriture Airtable avec AIRTABLE_WRITE_TOKEN.
const crypto = require("crypto");

const WRITE_TOKEN = process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || "";
const BASE = process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl";
const TABLE = "tblUk7VMqvGagLmPu"; // RS Mensuel
const SECRET = process.env.RS_IMPORT_SECRET || "";

const F = {
  cle: "Clé", mois: "Mois", reseau: "Réseau", abonnes: "Abonnés", vues: "Vues",
  revenus: "Revenus", publications: "Publications", interactions: "Interactions",
  portee: "Portée", rpm: "RPM", watch: "Watch (h)",
};

// Colonnes (0-based) de chaque mois dans la feuille BILANS MENSUELS.
// nov/déc = 2025 ; janv→déc = 2026. (Tient à la disposition de la saison en cours.)
const MONTH_COLS = [
  ["2025-11", 2], ["2025-12", 3], ["2026-01", 6], ["2026-02", 8], ["2026-03", 10],
  ["2026-04", 12], ["2026-05", 14], ["2026-06", 16], ["2026-07", 18], ["2026-08", 20],
  ["2026-09", 22], ["2026-10", 24], ["2026-11", 26], ["2026-12", 28],
];

// Lignes (0-based) de chaque métrique par réseau. sum:[a,b] = addition de deux lignes.
const PLATS = {
  Facebook:  { revenus: 3, vues: 9, abonnes: 12, interactions: 13, portee: 14, publications: 15 },
  Instagram: { revenus: 19, portee: 20, interactions: 21, abonnes: 22, vues: 23, publications: 25 },
  Snapchat:  { revenus: 29, rpm: 30, watch: 31, vues: 32, abonnes: 33, publications: { sum: [34, 35] }, portee: 36 },
  TikTok:    { revenus: 40, vues: 43, portee: 44, interactions: { sum: [45, 46] }, abonnes: 47, publications: 48 },
  YouTube:   { revenus: 52, vues: 53, rpm: 56, abonnes: 57, watch: 58, publications: { sum: [59, 60] } },
  LinkedIn:  { abonnes: 64, vues: 65 },
};

const INTS = new Set(["abonnes", "vues", "publications", "interactions", "portee", "watch"]);

function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === "" || s === "-" || s === "x") return null;
  s = s.replace(/\s/g, "").replace(/ /g, "").replace(",", ".");
  const n = Number(s);
  return isNaN(n) ? null : n;
}

function cell(rows, r, c) {
  const row = rows[r];
  return row ? num(row[c]) : null;
}

function metric(rows, spec, c) {
  if (spec && typeof spec === "object" && Array.isArray(spec.sum)) {
    const a = cell(rows, spec.sum[0], c), b = cell(rows, spec.sum[1], c);
    if (a == null && b == null) return null;
    return (a || 0) + (b || 0);
  }
  return cell(rows, spec, c);
}

// Construit les enregistrements (mois × réseau) à partir du tableau 2D.
function buildRecords(rows) {
  const out = [];
  for (const [mk, c] of MONTH_COLS) {
    for (const [reseau, fields] of Object.entries(PLATS)) {
      const rec = {};
      for (const [key, spec] of Object.entries(fields)) {
        let v = metric(rows, spec, c);
        if (v == null) continue;
        v = INTS.has(key) ? Math.round(v) : Math.round(v * 100) / 100;
        rec[key] = v;
      }
      // On ne garde que les lignes réellement renseignées (abonnés ou vues > 0).
      const meaningful = (rec.abonnes && rec.abonnes > 0) || (rec.vues && rec.vues > 0);
      if (!meaningful) continue;
      out.push({ mk, reseau, rec });
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) {
      if (typeof req.body === "object") return resolve(req.body);
      try { return resolve(JSON.parse(req.body)); } catch (_) { return resolve({}); }
    }
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

async function fetchAll() {
  let recs = [], offset = null;
  do {
    const u = new URL("https://api.airtable.com/v0/" + BASE + "/" + TABLE);
    u.searchParams.set("pageSize", "100");
    if (offset) u.searchParams.set("offset", offset);
    const r = await fetch(u, { headers: { Authorization: "Bearer " + WRITE_TOKEN } });
    if (!r.ok) throw new Error("airtable_read_" + r.status);
    const j = await r.json();
    recs = recs.concat(j.records || []);
    offset = j.offset;
  } while (offset);
  return recs;
}

async function batchWrite(method, records) {
  const url = "https://api.airtable.com/v0/" + BASE + "/" + TABLE;
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + WRITE_TOKEN };
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const r = await fetch(url, { method, headers, body: JSON.stringify({ records: chunk, typecast: true }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || ("airtable_write_" + r.status)); }
  }
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" })); }

  const given = req.headers["x-rs-secret"] || (req.query && req.query.secret) || "";
  if (!SECRET || !safeEq(given, SECRET)) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: "unauthorized" })); }
  if (!WRITE_TOKEN) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "missing_token" })); }

  try {
    const body = await readBody(req);
    const rows = Array.isArray(body) ? body : (body.values || body.rows || null);
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "Corps invalide : attendu { values: [[...]] } (tableau 2D de la feuille BILANS MENSUELS)." }));
    }

    const items = buildRecords(rows);
    if (!items.length) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, imported: 0, note: "Aucune donnée exploitable trouvée dans la feuille." }));
    }

    const existing = await fetchAll();
    const byCle = {};
    existing.forEach((r) => { const k = (r.fields || {})[F.cle]; if (k) byCle[k] = r.id; });

    const toCreate = [], toUpdate = [];
    for (const { mk, reseau, rec } of items) {
      const cle = mk + " · " + reseau;
      const fields = { [F.cle]: cle, [F.mois]: mk + "-01", [F.reseau]: reseau };
      if (rec.abonnes != null) fields[F.abonnes] = rec.abonnes;
      if (rec.vues != null) fields[F.vues] = rec.vues;
      if (rec.revenus != null) fields[F.revenus] = rec.revenus;
      if (rec.publications != null) fields[F.publications] = rec.publications;
      if (rec.interactions != null) fields[F.interactions] = rec.interactions;
      if (rec.portee != null) fields[F.portee] = rec.portee;
      if (rec.rpm != null) fields[F.rpm] = rec.rpm;
      if (rec.watch != null) fields[F.watch] = rec.watch;
      if (byCle[cle]) toUpdate.push({ id: byCle[cle], fields });
      else toCreate.push({ fields });
    }

    if (toUpdate.length) await batchWrite("PATCH", toUpdate);
    if (toCreate.length) await batchWrite("POST", toCreate);

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, imported: items.length, created: toCreate.length, updated: toUpdate.length }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
};
