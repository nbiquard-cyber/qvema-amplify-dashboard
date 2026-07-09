// QVEMA Amplify — password check (léger, pour le Board mensuel).
// Réutilise le même mot de passe partagé que le dashboard temps réel
// (variable d'environnement Vercel : DASHBOARD_PASSWORD).
module.exports = async (req, res) => {
  const pw =
    req.headers["x-dashboard-password"] ||
    (req.query && req.query.pw) ||
    "";
  const ok = !!process.env.DASHBOARD_PASSWORD && pw === process.env.DASHBOARD_PASSWORD;
  res.statusCode = ok ? 200 : 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok }));
};
