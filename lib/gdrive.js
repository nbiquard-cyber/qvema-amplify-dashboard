// QVEMA Amplify — Feature Liz · helpers Google Drive (compte de service)
// Partagé par api/drive.js (liste/upload) et api/liz-chat.js (lecture pour le chatbot).
// Auth via JWT RS256 signé avec la clé privée du compte de service.

const crypto = require("crypto");

const config = {
  saEmail: process.env.GOOGLE_SA_EMAIL || "",
  saKey: (process.env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  folderId: process.env.GDRIVE_LIZ_FOLDER_ID || "",
};

const DRIVE_COMMON = "supportsAllDrives=true&includeItemsFromAllDrives=true";

let tokenCache = { token: null, exp: 0 };
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;
  if (!config.saEmail || !config.saKey) throw new Error("Compte de service Google non configuré");

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput =
    `${b64({ alg: "RS256", typ: "JWT" })}.` +
    b64({
      iss: config.saEmail,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(config.saKey).toString("base64url");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("token Google: " + (j.error_description || j.error || "échec"));
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokenCache.token;
}

async function list(token) {
  if (!config.folderId) throw new Error("GDRIVE_LIZ_FOLDER_ID manquant");
  const q = encodeURIComponent(`'${config.folderId}' in parents and trashed=false`);
  const fields = encodeURIComponent("files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink)");
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=modifiedTime desc&pageSize=200&${DRIVE_COMMON}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error("Drive list: " + ((j.error && j.error.message) || "échec"));
  return j.files || [];
}

async function upload(token, name, mimeType, base64) {
  const boundary = "lizqvema" + crypto.randomBytes(8).toString("hex");
  const pre =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [config.folderId] }) +
    `\r\n--${boundary}\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(pre, "utf8"), Buffer.from(base64, "utf8"), Buffer.from(`\r\n--${boundary}--`, "utf8")]);
  const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink,iconLink&${DRIVE_COMMON}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Drive upload: " + ((j.error && j.error.message) || "échec"));
  return j;
}

// Télécharge le contenu binaire d'un fichier (Buffer). Pour les fichiers
// Google-natifs (Docs/Sheets), utilise `exportMime` (ex. text/plain, text/csv).
async function download(token, fileId, exportMime) {
  const base = `https://www.googleapis.com/drive/v3/files/${fileId}`;
  const url = exportMime
    ? `${base}/export?mimeType=${encodeURIComponent(exportMime)}&${DRIVE_COMMON}`
    : `${base}?alt=media&${DRIVE_COMMON}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive download ${fileId}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { config, getAccessToken, list, upload, download };
