// QVEMA Amplify — Cron mensuel Site & SEO.
// Vercel Cron appelle cette route (voir "crons" dans vercel.json) le 4 de chaque mois :
// on importe le MOIS PRÉCÉDENT (GA4 + Search Console) et on upsert dans "SEO Mensuel".
// Protégé par CRON_SECRET : Vercel envoie automatiquement l'en-tête
//   Authorization: Bearer <CRON_SECRET>  quand cette variable d'environnement est définie.
const seo = require("./seo.js");

function prevMonthKey() {
  const d = new Date();
  const pm = new Date(d.getFullYear(), d.getMonth() - 1, 1); // 1er du mois précédent
  return pm.getFullYear() + "-" + String(pm.getMonth() + 1).padStart(2, "0");
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.CRON_SECRET || "";
  const authz = req.headers["authorization"] || "";
  if (!secret || authz !== "Bearer " + secret) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  }

  try {
    // ?mois=YYYY-MM permet un rattrapage manuel ; sinon = mois précédent.
    const mk = (req.query && req.query.mois) || prevMonthKey();
    const out = await seo.syncMonth(mk);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, mois: mk, created: out.created, data: out.data }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
};
