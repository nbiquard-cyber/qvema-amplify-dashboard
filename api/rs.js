// QVEMA Amplify — Suivi mensuel Réseaux sociaux (table Airtable "RS Mensuel").
//   GET  : renvoie toutes les lignes (1 ligne = 1 mois × 1 réseau). Auth + permission "rs".
//   POST : upsert manuel d'un (mois × réseau). Auth + permission "rs".
//   POST + header "x-rs-secret" : import automatique de la feuille Excel Teams
//     "BILANS MENSUELS" (tableau 2D envoyé par Power Automate). Pas d'auth cockpit,
//     protégé par RS_IMPORT_SECRET. (Fusionné ici pour ne pas dépasser la limite de
//     fonctions serverless du plan Vercel.)
const auth = require("./_auth.js");
const crypto = require("crypto");
const graph = require("./_msgraph.js");

const READ_TOKEN = process.env.AIRTABLE_TOKEN || "";
const WRITE_TOKEN = process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || "";
const BASE = process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl";
const TABLE = "tblUk7VMqvGagLmPu"; // RS Mensuel
const IMPORT_SECRET = process.env.RS_IMPORT_SECRET || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
// Emplacement de l'Excel Teams (SharePoint) — valeurs par défaut = fichier RS QVEMA.
const RS_DRIVE_ID = process.env.RS_DRIVE_ID || "b!9sg7UHd1e0Kb0xEO_0B9dVMscmM9-DdEq0rnHj272WouVxyHBddLRYdqIh7ec4Lf";
const RS_ITEM_ID = process.env.RS_ITEM_ID || "01AQAWV27HY43GNMCTLFA2HE6LKDVZFQDN";
const RS_SHEET = process.env.RS_SHEET || "BILANS MENSUELS";
const RS_RANGE = process.env.RS_RANGE || "A1:AH70";

// Réseaux gérés + devise de leurs revenus (Snapchat facture en $, les autres en €).
const RESEAUX = ["Facebook", "Instagram", "Snapchat", "TikTok", "YouTube", "LinkedIn"];

const F = {
  cle: "Clé",
  mois: "Mois",
  reseau: "Réseau",
  abonnes: "Abonnés",
  vues: "Vues",
  revenus: "Revenus",
  publications: "Publications",
  interactions: "Interactions",
  portee: "Portée",
  rpm: "RPM",
  watch: "Watch (h)",
  commentaire: "Commentaire",
};

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

const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
const monthKey = (d) => String(d || "").slice(0, 7); // "YYYY-MM"

async function fetchPage(token, offset) {
  const u = new URL("https://api.airtable.com/v0/" + BASE + "/" + TABLE);
  u.searchParams.set("pageSize", "100");
  if (offset) u.searchParams.set("offset", offset);
  return fetch(u, { headers: { Authorization: "Bearer " + token } });
}

async function fetchAll() {
  // RS Mensuel est une table récente : le token de lecture peut ne pas y avoir accès.
  // On tente le token de lecture puis, en cas d'échec, le token d'écriture (accès complet).
  let token = READ_TOKEN;
  let recs = [], offset = null, tried = false;
  do {
    let r = await fetchPage(token, offset);
    if (!r.ok && !tried && WRITE_TOKEN && WRITE_TOKEN !== READ_TOKEN) {
      tried = true; token = WRITE_TOKEN; r = await fetchPage(token, offset);
    }
    if (!r.ok) throw new Error("airtable_read_" + r.status);
    const j = await r.json();
    recs = recs.concat(j.records || []);
    offset = j.offset;
  } while (offset);
  return recs;
}

function toObj(rec) {
  const f = rec.fields || {};
  return {
    id: rec.id,
    mois: String(f[F.mois] || "").slice(0, 10),
    moisKey: monthKey(f[F.mois]),
    reseau: String(f[F.reseau] || ""),
    abonnes: num(f[F.abonnes]), vues: num(f[F.vues]), revenus: num(f[F.revenus]),
    publications: num(f[F.publications]), interactions: num(f[F.interactions]),
    portee: num(f[F.portee]), rpm: num(f[F.rpm]), watch: num(f[F.watch]),
    commentaire: String(f[F.commentaire] || ""),
  };
}

// Upsert d'un (mois × réseau) : clé unique = "YYYY-MM · Réseau".
async function upsert(mk, reseau, fields) {
  const cle = mk + " · " + reseau;
  fields[F.cle] = cle;
  fields[F.mois] = mk + "-01";
  fields[F.reseau] = reseau;
  const recs = await fetchAll();
  const existing = recs.find((r) => String((r.fields || {})[F.cle] || "") === cle);
  const url = "https://api.airtable.com/v0/" + BASE + "/" + TABLE;
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + WRITE_TOKEN };
  const payload = existing ? { records: [{ id: existing.id, fields }] } : { records: [{ fields }] };
  const r = await fetch(url, { method: existing ? "PATCH" : "POST", headers, body: JSON.stringify(payload) });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "airtable_write_error");
  return { created: !existing };
}

/* ===== Import automatique depuis l'Excel Teams (Power Automate + Office Script) ===== */
// Colonnes (0-based) de chaque mois dans BILANS MENSUELS. nov/déc = 2025 ; janv→déc = 2026.
const MONTH_COLS = [
  ["2025-11", 2], ["2025-12", 3], ["2026-01", 6], ["2026-02", 8], ["2026-03", 10],
  ["2026-04", 12], ["2026-05", 14], ["2026-06", 16], ["2026-07", 18], ["2026-08", 20],
  ["2026-09", 22], ["2026-10", 24], ["2026-11", 26], ["2026-12", 28],
];
// Lignes (0-based) de chaque métrique par réseau. {sum:[a,b]} = addition de deux lignes.
const PLATS = {
  Facebook:  { revenus: 3, vues: 9, abonnes: 12, interactions: 13, portee: 14, publications: 15 },
  Instagram: { revenus: 19, portee: 20, interactions: 21, abonnes: 22, vues: 23, publications: 25 },
  Snapchat:  { revenus: 29, rpm: 30, watch: 31, vues: 32, abonnes: 33, publications: { sum: [34, 35] }, portee: 36 },
  TikTok:    { revenus: 40, vues: 43, portee: 44, interactions: { sum: [45, 46] }, abonnes: 47, publications: 48 },
  YouTube:   { revenus: 52, vues: 53, rpm: 56, abonnes: 57, watch: 58, publications: { sum: [59, 60] } },
  LinkedIn:  { abonnes: 64, vues: 65 },
};
const IMPORT_INTS = new Set(["abonnes", "vues", "publications", "interactions", "portee", "watch"]);

const cnum = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(s);
  return s === "" || isNaN(n) ? null : n;
};
const gcell = (rows, r, c) => { const row = rows[r]; return row ? cnum(row[c]) : null; };
function gmetric(rows, spec, c) {
  if (spec && typeof spec === "object" && Array.isArray(spec.sum)) {
    const a = gcell(rows, spec.sum[0], c), b = gcell(rows, spec.sum[1], c);
    return a == null && b == null ? null : (a || 0) + (b || 0);
  }
  return gcell(rows, spec, c);
}
function buildImportRecords(rows) {
  const out = [];
  for (const [mk, c] of MONTH_COLS) {
    for (const [reseau, fields] of Object.entries(PLATS)) {
      const rec = {};
      for (const [key, spec] of Object.entries(fields)) {
        let v = gmetric(rows, spec, c);
        if (v == null) continue;
        rec[key] = IMPORT_INTS.has(key) ? Math.round(v) : Math.round(v * 100) / 100;
      }
      if (!((rec.abonnes && rec.abonnes > 0) || (rec.vues && rec.vues > 0))) continue;
      out.push({ mk, reseau, rec });
    }
  }
  return out;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function batchWrite(method, records) {
  const url = "https://api.airtable.com/v0/" + BASE + "/" + TABLE;
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + WRITE_TOKEN };
  for (let i = 0; i < records.length; i += 10) {
    const r = await fetch(url, { method, headers, body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || ("airtable_write_" + r.status)); }
  }
}
// Applique une liste d'items {mk, reseau, rec} dans Airtable (upsert par Clé, en lots de 10).
async function applyItems(items) {
  if (!items.length) return { imported: 0, created: 0, updated: 0 };
  const existing = await fetchAll();
  const byCle = {};
  existing.forEach((r) => { const k = (r.fields || {})[F.cle]; if (k) byCle[k] = r.id; });
  const toCreate = [], toUpdate = [];
  for (const { mk, reseau, rec } of items) {
    const cle = mk + " · " + reseau;
    const fields = { [F.cle]: cle, [F.mois]: mk + "-01", [F.reseau]: reseau };
    ["abonnes", "vues", "revenus", "publications", "interactions", "portee", "rpm", "watch"].forEach((k) => { if (rec[k] != null) fields[F[k]] = rec[k]; });
    if (byCle[cle]) toUpdate.push({ id: byCle[cle], fields }); else toCreate.push({ fields });
  }
  if (toUpdate.length) await batchWrite("PATCH", toUpdate);
  if (toCreate.length) await batchWrite("POST", toCreate);
  return { imported: items.length, created: toCreate.length, updated: toUpdate.length };
}

// Voie 1 : import « push » — Power Automate envoie le tableau 2D de la feuille.
async function handleImport(req, res) {
  if (!WRITE_TOKEN) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "missing_token" })); }
  const body = await readBody(req);
  const rows = Array.isArray(body) ? body : (body.values || body.rows || null);
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: "Corps invalide : attendu { values: [[...]] } (tableau 2D de la feuille BILANS MENSUELS)." }));
  }
  const out = await applyItems(buildImportRecords(rows));
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, source: "push", ...out }));
}

// Voie 2 : import « pull » — le dashboard lit l'Excel Teams via Microsoft Graph (cron quotidien).
async function graphSync(res) {
  if (!WRITE_TOKEN) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "missing_token" })); }
  const rows = await graph.readRange(RS_DRIVE_ID, RS_ITEM_ID, RS_SHEET, RS_RANGE);
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: "Réponse Graph inattendue (pas de tableau 2D)." }));
  }
  const out = await applyItems(buildImportRecords(rows));
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, source: "graph", ...out }));
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const rsSecret = req.headers["x-rs-secret"] || (req.query && req.query.secret) || "";
  const authz = req.headers["authorization"] || "";
  const isCron = CRON_SECRET && authz === "Bearer " + CRON_SECRET;
  const hasImportSecret = IMPORT_SECRET && rsSecret && safeEq(rsSecret, IMPORT_SECRET);
  const wantGraph = req.query && (req.query.source === "graph" || req.query.sync === "graph");

  // Synchro « pull » via Microsoft Graph : déclenchée par le cron Vercel, ou manuellement
  // avec le secret d'import + ?source=graph. Sans auth cockpit.
  if (isCron || (hasImportSecret && wantGraph)) {
    try { return await graphSync(res); }
    catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
  }

  // Import « push » (Power Automate) : POST + header secret, sans auth cockpit.
  if (req.method === "POST" && hasImportSecret) {
    try { return await handleImport(req, res); }
    catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
  }

  const user = auth.authFromRequest(req);
  if (!user) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: "unauthorized" })); }
  if (!auth.has(user.perms, "rs")) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: "forbidden" })); }
  if (!READ_TOKEN) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "missing_token" })); }

  try {
    if (req.method === "GET") {
      const recs = await fetchAll();
      const lignes = recs.map(toObj).filter((m) => m.moisKey && m.reseau)
        .sort((a, b) => a.mois.localeCompare(b.mois) || a.reseau.localeCompare(b.reseau));
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, reseaux: RESEAUX, lignes }));
    }

    if (req.method === "POST") {
      const b = await readBody(req);
      const mk = monthKey(b.mois);
      if (!/^\d{4}-\d{2}$/.test(mk)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "Mois invalide (format attendu AAAA-MM)." }));
      }
      const reseau = String(b.reseau || "").trim();
      if (!RESEAUX.includes(reseau)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "Réseau inconnu." }));
      }
      const fields = {};
      const setNum = (k, key) => { const v = num(b[k]); if (v != null) fields[key] = v; };
      setNum("abonnes", F.abonnes); setNum("vues", F.vues); setNum("revenus", F.revenus);
      setNum("publications", F.publications); setNum("interactions", F.interactions);
      setNum("portee", F.portee); setNum("rpm", F.rpm); setNum("watch", F.watch);
      if (typeof b.commentaire === "string") fields[F.commentaire] = b.commentaire;
      const out = await upsert(mk, reseau, fields);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, saved: mk + " · " + reseau, created: out.created }));
    }

    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
};
