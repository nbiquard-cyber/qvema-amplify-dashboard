// QVEMA Amplify — connexion au cockpit (email + mot de passe).
// Renvoie un token signé + la liste des permissions (vues autorisées).
const { login, makeToken } = require("./_auth.js");

module.exports = async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  }

  // Lecture du corps (fonction Node brute : pas de body parser).
  let raw = "";
  try {
    raw = await new Promise((resolve, reject) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => resolve(d));
      req.on("error", reject);
    });
  } catch (e) { raw = ""; }

  let email = "", password = "";
  try { const j = JSON.parse(raw || "{}"); email = j.email; password = j.password; } catch (e) {}

  try {
    const u = await login(email, password);
    if (!u) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, error: "Identifiants invalides ou compte désactivé." }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, token: makeToken(u), email: u.email, name: u.name, perms: u.perms }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: "Erreur d'authentification : " + e.message }));
  }
};
