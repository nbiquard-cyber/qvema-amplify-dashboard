// QVEMA Amplify — Suivi mensuel Réseaux sociaux (table Airtable "RS Mensuel").
//   GET  : renvoie toutes les lignes (1 ligne = 1 mois × 1 réseau). Auth + permission "rs".
//   POST : upsert manuel d'un (mois × réseau). Auth + permission "rs".
// Lecture avec AIRTABLE_TOKEN ; écriture avec AIRTABLE_WRITE_TOKEN (comme le SEO / CRM).
const auth = require("./_auth.js");

const READ_TOKEN = process.env.AIRTABLE_TOKEN || "";
const WRITE_TOKEN = process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || "";
const BASE = process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl";
const TABLE = "tblUk7VMqvGagLmPu"; // RS Mensuel

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

async function fetchAll() {
  let recs = [], offset = null;
  do {
    const u = new URL("https://api.airtable.com/v0/" + BASE + "/" + TABLE);
    u.searchParams.set("pageSize", "100");
    if (offset) u.searchParams.set("offset", offset);
    const r = await fetch(u, { headers: { Authorization: "Bearer " + READ_TOKEN } });
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

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

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
