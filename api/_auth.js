// QVEMA Amplify — cœur d'authentification du cockpit (multi-utilisateurs, accès par vue).
// Fichier préfixé "_" => non exposé comme route Vercel, seulement importé par les endpoints.
//
// Utilisateurs : table Airtable "Cockpit Users" (Email, Mot de passe, Accès, Actif).
// Connexion (/api/login) : email + mot de passe -> token signé (HMAC) portant les
// permissions. Les endpoints (/api/data, /api/feedback) vérifient le token et
// filtrent/refusent les données selon les permissions.
const crypto = require("crypto");

const CONFIG = {
  airtableToken: process.env.AIRTABLE_TOKEN || "",
  airtableBase: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
  usersTable: process.env.COCKPIT_USERS_TABLE || "Cockpit Users",
  masterPassword: process.env.DASHBOARD_PASSWORD || "",
  secret: process.env.AUTH_SECRET || process.env.DASHBOARD_PASSWORD || "qvema-cockpit-secret",
  ttlHours: 12,
};

// Vues métier connues. "admin" = accès total.
const PERMS = ["bootcamp", "feedback", "amplify", "board"];

function labelToPerm(label) {
  const s = String(label || "").trim().toLowerCase();
  if (s.startsWith("admin")) return "admin";
  if (s.startsWith("bootcamp")) return "bootcamp";
  if (s.startsWith("feedback")) return "feedback";
  if (s.startsWith("amplify")) return "amplify";
  if (s.startsWith("board")) return "board";
  return null;
}
function expandPerms(list) {
  const set = new Set();
  (list || []).forEach((l) => { const p = labelToPerm(l); if (p) set.add(p); });
  if (set.has("admin")) return ["admin", ...PERMS];
  return [...set];
}
function has(perms, key) {
  return Array.isArray(perms) && (perms.includes("admin") || perms.includes(key));
}

// ---- Token signé (stateless) : base64url(payload) + "." + hmac ----
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDec = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
function hmac(body) {
  return b64u(crypto.createHmac("sha256", CONFIG.secret).update(body).digest());
}
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + "." + hmac(body);
}
function verify(token) {
  if (!token || String(token).indexOf(".") < 0) return null;
  const [body, mac] = String(token).split(".");
  const expected = hmac(body);
  const a = Buffer.from(mac || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64uDec(body)); } catch (e) { return null; }
  if (!payload || (payload.exp && Date.now() > payload.exp)) return null;
  return payload;
}
function makeToken(user) {
  return sign({
    email: user.email,
    name: user.name || "",
    perms: user.perms,
    exp: Date.now() + CONFIG.ttlHours * 3600 * 1000,
  });
}

// ---- Lecture des utilisateurs Airtable ----
async function fetchUsers() {
  const url = new URL(
    "https://api.airtable.com/v0/" + CONFIG.airtableBase + "/" + encodeURIComponent(CONFIG.usersTable)
  );
  url.searchParams.set("pageSize", "100");
  const r = await fetch(url, { headers: { Authorization: "Bearer " + CONFIG.airtableToken } });
  if (!r.ok) throw new Error("airtable_users_" + r.status);
  const j = await r.json();
  return (j.records || []).map((rec) => {
    const f = rec.fields || {};
    return {
      email: String(f["Email"] || "").trim().toLowerCase(),
      password: String(f["Mot de passe"] || ""),
      name: String(f["Nom"] || ""),
      perms: expandPerms(f["Accès"] || []),
      actif: f["Actif"] === true,
    };
  });
}

// Valide email + mot de passe. Renvoie {email, name, perms} ou null.
async function login(email, password) {
  const em = String(email || "").trim().toLowerCase();
  const pwd = String(password || "");
  if (!pwd) return null;
  // Clé maître : le mot de passe historique du dashboard = admin complet (secours).
  if (CONFIG.masterPassword && pwd === CONFIG.masterPassword) {
    return { email: em || "admin", name: "Admin", perms: ["admin", ...PERMS] };
  }
  const users = await fetchUsers();
  const u = users.find((x) => x.actif && x.email === em && x.password === pwd);
  if (!u) return null;
  return { email: u.email, name: u.name, perms: u.perms };
}

// Authentifie une requête : token Bearer / x-cockpit-token, ou clé maître (compat).
// Renvoie {email, name, perms} ou null.
function authFromRequest(req) {
  const legacy = req.headers["x-dashboard-password"] || "";
  if (CONFIG.masterPassword && legacy === CONFIG.masterPassword) {
    return { email: "admin", name: "Admin", perms: ["admin", ...PERMS] };
  }
  let token = req.headers["x-cockpit-token"] || "";
  const authz = req.headers["authorization"] || "";
  if (!token && /^Bearer\s+/i.test(authz)) token = authz.replace(/^Bearer\s+/i, "").trim();
  return verify(token);
}

module.exports = { PERMS, has, sign, verify, makeToken, login, authFromRequest, fetchUsers };
