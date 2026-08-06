// QVEMA Amplify — Petit client Microsoft Graph (client credentials, zéro dépendance npm).
// Sert à lire une plage de l'Excel Teams (SharePoint) pour la synchro Réseaux sociaux.
// Fichier préfixé "_" => non exposé comme route Vercel (n'entre pas dans la limite de fonctions).

const TENANT = () => (process.env.MS_TENANT_ID || "").trim();
const CLIENT = () => (process.env.MS_CLIENT_ID || "").trim();
const SECRET = () => (process.env.MS_CLIENT_SECRET || "").trim();

// Jeton d'application (flux client_credentials).
async function getToken() {
  const tenant = TENANT(), client = CLIENT(), secret = SECRET();
  if (!tenant || !client || !secret) throw new Error("Config Microsoft manquante (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET).");
  const url = "https://login.microsoftonline.com/" + encodeURIComponent(tenant) + "/oauth2/v2.0/token";
  const body = new URLSearchParams({
    client_id: client,
    client_secret: secret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("Auth Graph échouée : " + ((j && (j.error_description || j.error)) || ("HTTP " + r.status)));
  return j.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lit une plage d'une feuille d'un classeur Excel dans SharePoint/OneDrive.
// Renvoie le tableau 2D des valeurs (range.values).
// L'API Workbook de Graph renvoie parfois une erreur transitoire ("General exception
// while processing") — on réessaie quelques fois avec une petite attente.
async function readRange(driveId, itemId, sheet, address, attempts) {
  const max = attempts || 4;
  const token = await getToken();
  const url = "https://graph.microsoft.com/v1.0/drives/" + encodeURIComponent(driveId) +
    "/items/" + encodeURIComponent(itemId) +
    "/workbook/worksheets('" + encodeURIComponent(sheet) + "')/range(address='" + encodeURIComponent(address) + "')";
  let lastErr = "";
  for (let i = 0; i < max; i++) {
    if (i > 0) await sleep(1500);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j.values || [];
    lastErr = (j && j.error && j.error.message) || ("HTTP " + r.status);
    // 401/403 = problème d'autorisation, inutile de réessayer.
    if (r.status === 401 || r.status === 403) break;
  }
  throw new Error("Lecture Graph échouée : " + lastErr);
}

module.exports = { getToken, readRange };
