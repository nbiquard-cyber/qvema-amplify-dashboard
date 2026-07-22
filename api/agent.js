// QVEMA Amplify — Agent commercial (copilote conversationnel)
// Endpoint de chat : reçoit l'historique de la conversation et répond
// via l'API Claude, en utilisant le prompt de pilotage comme cerveau.
// Auth via mot de passe partagé (header x-dashboard-password), comme le
// reste du dashboard.

const PROMPT = require("./agent-prompt.json"); // { system: "..." }

const CONFIG = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  // Modèle configurable côté Vercel. Défaut : un modèle Claude récent et
  // capable. Mettre ANTHROPIC_MODEL pour un modèle plus profond si besoin.
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 2048),
  password: process.env.DASHBOARD_PASSWORD || "",
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // Auth
  const pw = req.headers["x-dashboard-password"] || "";
  if (!CONFIG.password || pw !== CONFIG.password) {
    return json(res, 401, { error: "Non autorisé" });
  }
  if (!CONFIG.apiKey) {
    return json(res, 500, { error: "ANTHROPIC_API_KEY manquante côté serveur" });
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: "Corps de requête invalide" });
  }

  // messages: [{ role: "user"|"assistant", content: "..." }, ...]
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const cleaned = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  if (!cleaned.length) return json(res, 400, { error: "Aucun message" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": CONFIG.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        system: PROMPT.system,
        messages: cleaned,
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return json(res, 502, { error: `Erreur API Claude (${r.status})`, detail });
    }

    const data = await r.json();
    const reply = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim()
      : "";

    return json(res, 200, { reply, model: CONFIG.model, usage: data.usage || null });
  } catch (e) {
    return json(res, 500, { error: "Erreur serveur", detail: String(e && e.message || e) });
  }
};
