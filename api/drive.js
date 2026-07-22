// QVEMA Amplify — Feature Liz · endpoint Drive (liste + upload)
// GET  /api/drive         → liste les fichiers du dossier LIZ QVEMA
// POST /api/drive {name,mimeType,base64} → uploade un fichier dans le dossier
// Auth : mot de passe partagé (x-dashboard-password).

const gdrive = require("../lib/gdrive");

const PASSWORD = process.env.DASHBOARD_PASSWORD || "";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  const pw = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
  if (!PASSWORD || pw !== PASSWORD) return json(res, 401, { error: "Non autorisé" });

  try {
    const token = await gdrive.getAccessToken();

    if (req.method === "GET") {
      return json(res, 200, { folderId: gdrive.config.folderId, files: await gdrive.list(token) });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body.name || !body.base64) return json(res, 400, { error: "name et base64 requis" });
      return json(res, 200, { file: await gdrive.upload(token, body.name, body.mimeType, body.base64) });
    }
    return json(res, 405, { error: "Method not allowed" });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const notConfigured = /non configuré|token Google|FOLDER_ID/.test(msg);
    return json(res, notConfigured ? 503 : 500, { error: msg, configured: !notConfigured });
  }
};
