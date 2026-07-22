// QVEMA Amplify — Feature Liz · chatbot sur les documents du dossier LIZ QVEMA.
// Lit en temps réel les fichiers Drive (compte de service), en extrait le texte
// et répond via l'API Claude. Auth : mot de passe partagé.
//
// Env : GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY, GDRIVE_LIZ_FOLDER_ID,
//       ANTHROPIC_API_KEY, DASHBOARD_PASSWORD.

const gdrive = require("../lib/gdrive");
const { extractText } = require("../lib/extract");

const CONFIG = {
  password: process.env.DASHBOARD_PASSWORD || "",
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 2048),
};

const PER_FILE_CAP = 45000; // caractères max par fichier injecté
const TOTAL_CAP = 180000; // caractères max de contexte total

// Cache mémoire (lambda chaud) : fileId -> { modifiedTime, text }.
// Le temps réel est préservé : si le fichier change sur Drive, modifiedTime
// change et on ré-extrait.
const CACHE = new Map();

const EXPORT_MIME = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

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

async function fileText(token, f) {
  const cached = CACHE.get(f.id);
  if (cached && cached.modifiedTime === f.modifiedTime) return cached.text;
  let text = "";
  try {
    const exportMime = EXPORT_MIME[f.mimeType];
    const buf = await gdrive.download(token, f.id, exportMime);
    text = exportMime ? buf.toString("utf8") : extractText(f.name, f.mimeType, buf);
  } catch (e) {
    text = `[lecture impossible : ${String((e && e.message) || e)}]`;
  }
  if (text.length > PER_FILE_CAP) text = text.slice(0, PER_FILE_CAP) + "\n…[tronqué]";
  CACHE.set(f.id, { modifiedTime: f.modifiedTime, text });
  return text;
}

async function buildContext(token) {
  const files = await gdrive.list(token);
  let total = 0;
  const parts = [];
  const included = [];
  for (const f of files) {
    if (f.mimeType === "application/vnd.google-apps.folder") continue;
    const text = await fileText(token, f);
    if (!text) continue;
    const block = `\n===== FICHIER : ${f.name}  (modifié ${f.modifiedTime}) =====\n${text}\n`;
    if (total + block.length > TOTAL_CAP) {
      parts.push(`\n[Contexte tronqué : certains fichiers non inclus faute de place.]`);
      break;
    }
    parts.push(block);
    included.push(f.name);
    total += block.length;
  }
  return { context: parts.join(""), included, count: files.length };
}

function systemPrompt(ctx) {
  return `Tu es l'assistant "Feature Liz" de QVEMA Amplify, un copilote pour Amplify Connect (le cercle des alumni de l'émission "Qui Veut Être Mon Associé").

Ton rôle : répondre VITE et CLAIREMENT à des questions posées pendant un appel ou en préparation, en t'appuyant UNIQUEMENT sur les documents ci-dessous (dossier Google Drive "LIZ QVEMA" : CRM, listes d'appels, fiches d'appel, scripts, mails).

Règles :
- Réponds en français, de façon directe et concise. Va droit au but : la personne est souvent en appel.
- Base-toi STRICTEMENT sur les documents fournis. Si l'information n'y est pas, dis-le clairement ("je ne trouve pas cette info dans les documents") plutôt que d'inventer.
- Quand c'est utile, cite le fichier source (ex. "d'après le CRM…").
- Pour une personne/entreprise, donne les faits clés trouvés (statut, saison QVEMA, dernier contact, prochaine action, notes) sans inventer ce qui manque.
- Respecte les interdictions du script v5 (⚠) : ne jamais promettre un accès illimité aux jurés ni un retour garanti ; ne pas annoncer un prix non sourcé ; ne pas confondre Amplify Connect avec le Bootcamp / la formation ESCP / l'accélérateur TOMCAT / l'émission TV.

=================  DOCUMENTS (LIZ QVEMA)  =================
${ctx}
=================  FIN DES DOCUMENTS  =================`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const pw = req.headers["x-dashboard-password"] || "";
  if (!CONFIG.password || pw !== CONFIG.password) return json(res, 401, { error: "Non autorisé" });
  if (!CONFIG.apiKey) return json(res, 500, { error: "ANTHROPIC_API_KEY manquante côté serveur" });

  let payload;
  try {
    payload = await readBody(req);
  } catch (_) {
    return json(res, 400, { error: "Corps de requête invalide" });
  }
  const messages = (Array.isArray(payload.messages) ? payload.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length) return json(res, 400, { error: "Aucun message" });

  try {
    const token = await gdrive.getAccessToken();
    const { context, included, count } = await buildContext(token);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": CONFIG.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        system: systemPrompt(context || "(aucun document lisible dans le dossier)"),
        messages,
      }),
    });
    const text = await r.text();
    if (!r.ok) return json(res, 502, { error: `Erreur API Claude (${r.status})`, detail: text.slice(0, 400) });
    const data = JSON.parse(text);
    const reply = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return json(res, 200, { reply: reply || "(réponse vide)", sources: included, filesSeen: count });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const notConfigured = /non configuré|token Google|FOLDER_ID/.test(msg);
    return json(res, notConfigured ? 503 : 500, { error: msg, configured: !notConfigured });
  }
};
