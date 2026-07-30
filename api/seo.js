// QVEMA Amplify — Suivi mensuel Site & SEO (table Airtable "SEO Mensuel").
//   GET  : renvoie tous les mois (triés chronologiquement). Auth + permission "seo".
//   POST : crée OU met à jour un mois (upsert par mois YYYY-MM). Auth + permission "seo".
// Lecture avec AIRTABLE_TOKEN ; écriture avec AIRTABLE_WRITE_TOKEN (comme le CRM).
const auth = require("./_auth.js");

const READ_TOKEN = process.env.AIRTABLE_TOKEN || "";
const WRITE_TOKEN = process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || "";
const BASE = process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl";
const TABLE = "tblvCb64IaLRsrqCs"; // SEO Mensuel

const F = {
  mois: "Mois",
  organique: "Trafic organique",
  payant: "Trafic payant",
  direct: "Trafic direct",
  global: "Trafic global",
  position: "Position moyenne",
  top10: "Top 10",
  top1150: "Top 11-50",
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
  const org = num(f[F.organique]), pay = num(f[F.payant]), dir = num(f[F.direct]);
  let glob = num(f[F.global]);
  if (glob == null && (org != null || pay != null || dir != null)) glob = (org || 0) + (pay || 0) + (dir || 0);
  return {
    id: rec.id,
    mois: String(f[F.mois] || "").slice(0, 10),
    moisKey: monthKey(f[F.mois]),
    organique: org, payant: pay, direct: dir, global: glob,
    part: glob && org != null ? Math.round((org / glob) * 1000) / 10 : null,
    position: num(f[F.position]), top10: num(f[F.top10]), top1150: num(f[F.top1150]),
    commentaire: String(f[F.commentaire] || ""),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const user = auth.authFromRequest(req);
  if (!user) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: "unauthorized" })); }
  if (!auth.has(user.perms, "seo")) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: "forbidden" })); }
  if (!READ_TOKEN) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "missing_token" })); }

  try {
    if (req.method === "GET") {
      const recs = await fetchAll();
      const mois = recs.map(toObj).filter((m) => m.moisKey).sort((a, b) => a.mois.localeCompare(b.mois));
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, mois }));
    }

    if (req.method === "POST") {
      const b = await readBody(req);
      const mk = monthKey(b.mois);
      if (!/^\d{4}-\d{2}$/.test(mk)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "Mois invalide (format attendu AAAA-MM)." }));
      }
      const fields = {};
      fields[F.mois] = mk + "-01";
      const setNum = (k, key) => { const v = num(b[k]); if (v != null) fields[key] = v; };
      setNum("organique", F.organique); setNum("payant", F.payant); setNum("direct", F.direct);
      setNum("global", F.global); setNum("position", F.position); setNum("top10", F.top10); setNum("top1150", F.top1150);
      if (fields[F.global] == null) {
        const s = (num(b.organique) || 0) + (num(b.payant) || 0) + (num(b.direct) || 0);
        if (s > 0) fields[F.global] = s;
      }
      if (typeof b.commentaire === "string") fields[F.commentaire] = b.commentaire;

      // Upsert : on cherche un enregistrement déjà présent pour ce mois.
      const recs = await fetchAll();
      const existing = recs.find((r) => monthKey((r.fields || {})[F.mois]) === mk);
      const url = "https://api.airtable.com/v0/" + BASE + "/" + TABLE;
      const headers = { "Content-Type": "application/json", Authorization: "Bearer " + WRITE_TOKEN };
      const payload = existing
        ? { records: [{ id: existing.id, fields }] }
        : { records: [{ fields }] };
      const r = await fetch(url, { method: existing ? "PATCH" : "POST", headers, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!r.ok) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ ok: false, error: (j.error && j.error.message) || "airtable_write_error" }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, saved: mk, created: !existing }));
    }

    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
};
