// QVEMA Amplify — accès Google (GA4 Data API + Search Console API) via compte de service.
// Fichier préfixé "_" => non exposé comme route. Aucune dépendance npm : on signe
// le JWT nous-mêmes (RS256) avec le module crypto de Node.
//
// Variables d'environnement Vercel attendues :
//   GOOGLE_SERVICE_ACCOUNT_JSON = contenu complet du fichier JSON du compte de service
//   GA4_PROPERTY_ID             = ex. "527343910"
//   GSC_SITES                   = propriété(s) Search Console, séparées par des virgules
const crypto = require("crypto");

// Seuil anti-bruit pour le comptage des mots-clés positionnés : on ne compte
// en top 10 / top 11-50 que les requêtes ayant au moins ce nombre d'impressions
// sur le mois (une requête vue 1 fois n'est pas un vrai positionnement suivi).
const MIN_KW_IMPRESSIONS = 10;

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function loadSA() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON manquante dans Vercel.");
  let j;
  try { j = JSON.parse(raw); } catch (e) { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON illisible (JSON invalide) — colle bien tout le fichier, des { aux }."); }
  if (!j.client_email || !j.private_key) throw new Error("Compte de service incomplet (client_email / private_key absents).");
  return j;
}

let _tok = { access: null, exp: 0, scopeKey: "" };
async function getToken(scopes) {
  const scope = scopes.join(" ");
  const now = Math.floor(Date.now() / 1000);
  if (_tok.access && _tok.exp - 60 > now && _tok.scopeKey === scope) return _tok.access;
  const sa = loadSA();
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const input = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claim));
  let key = sa.private_key;
  if (key.indexOf("\\n") >= 0 && key.indexOf("\n") < 0) key = key.replace(/\\n/g, "\n"); // filet de sécurité
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(input);
  const jwt = input + "." + b64url(signer.sign(key));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + encodeURIComponent(jwt),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("Authentification Google refusée : " + (j.error_description || j.error || ("HTTP " + r.status)));
  _tok = { access: j.access_token, exp: now + (j.expires_in || 3600), scopeKey: scope };
  return j.access_token;
}

// --- GA4 : sessions par canal, agrégées dans les 3 buckets du tableau. ---
// Mapping : organique = "Organic Search" ; payant = tout "Paid *" + Display + Cross-network ;
//           direct/autres = tout le reste. global = total des sessions.
async function ga4Sessions(propertyId, startDate, endDate) {
  const token = await getToken(["https://www.googleapis.com/auth/analytics.readonly"]);
  const r = await fetch("https://analyticsdata.googleapis.com/v1beta/properties/" + propertyId + ":runReport", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("GA4 : " + ((j.error && j.error.message) || ("HTTP " + r.status)));
  let organique = 0, payant = 0, autres = 0, global = 0;
  const parCanal = {};
  for (const row of j.rows || []) {
    const ch = (row.dimensionValues[0] || {}).value || "(non défini)";
    const v = Number((row.metricValues[0] || {}).value) || 0;
    parCanal[ch] = v;
    global += v;
    if (ch === "Organic Search") organique += v;
    else if (/paid/i.test(ch) || ch === "Display" || ch === "Cross-network") payant += v;
    else autres += v;
  }
  return { organique, payant, direct: autres, global, parCanal };
}

// --- Search Console : position moyenne (pondérée impressions) + comptage mots-clés. ---
async function gscMonth(sites, startDate, endDate) {
  const token = await getToken(["https://www.googleapis.com/auth/webmasters.readonly"]);
  let clicks = 0, impressions = 0, posWeighted = 0, posImpr = 0, top10 = 0, top1150 = 0;
  for (const site of sites) {
    const base = "https://searchconsole.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(site) + "/searchAnalytics/query";
    const hdr = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    // Agrégat du site (aucune dimension => 1 ligne : clicks / impressions / ctr / position).
    const ra = await fetch(base, { method: "POST", headers: hdr, body: JSON.stringify({ startDate, endDate, dimensions: [] }) });
    const ja = await ra.json();
    if (!ra.ok) throw new Error("Search Console (" + site + ") : " + ((ja.error && ja.error.message) || ("HTTP " + ra.status)));
    const a = (ja.rows && ja.rows[0]) || { clicks: 0, impressions: 0, position: 0 };
    clicks += a.clicks || 0; impressions += a.impressions || 0;
    posWeighted += (a.position || 0) * (a.impressions || 0); posImpr += a.impressions || 0;
    // Mots-clés positionnés (dimension query).
    const rk = await fetch(base, { method: "POST", headers: hdr, body: JSON.stringify({ startDate, endDate, dimensions: ["query"], rowLimit: 25000 }) });
    const jk = await rk.json();
    if (rk.ok) {
      for (const row of jk.rows || []) {
        if ((row.impressions || 0) < MIN_KW_IMPRESSIONS) continue; // filtre anti-bruit
        const p = row.position || 999;
        if (p <= 10) top10++;
        else if (p <= 50) top1150++;
      }
    }
  }
  const position = posImpr ? Math.round((posWeighted / posImpr) * 100) / 100 : null;
  const ctr = impressions ? Math.round((clicks / impressions) * 1000) / 10 : null;
  return { clicks, impressions, position, ctr, top10, top1150 };
}

module.exports = { ga4Sessions, gscMonth };
