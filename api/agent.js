// QVEMA Amplify — Agent Liz (copilote Amplify Connect)
// Endpoint de chat : reçoit l'historique de conversation et répond via
// l'API Claude, en utilisant le prompt de pilotage + la base de connaissance
// comme cerveau. L'agent peut lire les données live du dashboard via l'outil
// get_dashboard_data (tool-use). Auth par mot de passe partagé.

const PROMPT = require("./agent-prompt.json"); // { system: "..." } (prompt de pilotage)
let KNOWLEDGE = { knowledge: "" };
try {
  KNOWLEDGE = require("./agent-knowledge.json"); // { knowledge: "..." } (base métier, optionnelle)
} catch (_) {
  /* base de connaissance non fournie pour l'instant */
}

const CONFIG = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 3072),
  password: process.env.DASHBOARD_PASSWORD || "",
};

// Cadrage spécifique de l'onglet "Agent Liz" (focus Amplify Connect).
const FOCUS = `## CADRAGE DE CET ONGLET — AGENT LIZ (AMPLIFY CONNECT)

Tu opères dans l'onglet « Agent Liz » du cockpit QVEMA Amplify, dédié à **Amplify Connect** (closing du cercle des alumni QVEMA). Concentre-toi sur :
- **Débriefs d'appels** dictés en vrac → interprète l'intention (ne corrige pas la forme), produis un compte rendu structuré + une **prochaine relance datée** (créneau précis, jamais « bientôt »).
- **Mails personnalisés** : liens réels au format [texte](url), **sans signature** (une signature électronique existe pour Liz), email du contact **en tête** du message, pas d'onglet séparé.
- **Fiches d'appel** (1 page : bandeau + faits + objectif + 4 étapes + phrases en encadré) et **réponses aux objections** (script cold call v5 = référence).
- **Reporting de la température du pipe Connect** (intérêt / relance / adhésion payée). Rappelle toujours : **intérêt ≠ adhésion payée**.

**Registre par défaut : Liz** — oral, chaleureux, solaire, direct, jamais corporate ni bullshit. Français.

**Données live** : tu as un accès LECTURE aux indicateurs du dashboard via l'outil \`get_dashboard_data\` (membres Connect payants, CA encaissé, ARR, saisons, modes de paiement, candidatures par statut/mode/sous-cercle, et côté Bootcamp : inscrits, CA, promos, remboursements, démographie). Utilise-le pour tout reporting ou question chiffrée, et ne cite jamais un chiffre que tu n'as pas obtenu de cet outil ou de l'utilisateur.

**Autonomie** : tu PRÉPARES, l'humain VALIDE et ENVOIE. N'envoie jamais un mail et n'écris jamais dans une source de vérité sans validation explicite. Respecte les interdictions Connect (ne pas contacter THE SMILIST, SKIN & OUT, Funky Veggie, Naali, Poiscaille, Hydratis, Bol Maju ; ne jamais promettre accès jurés / retour M6 / deal via mise en relation ; ne pas écrire de motifs juridiques dans un fichier qui circule).`;

function buildSystem() {
  let sys = FOCUS + "\n\n---\n\n" + PROMPT.system;
  if (KNOWLEDGE && KNOWLEDGE.knowledge && KNOWLEDGE.knowledge.trim()) {
    sys +=
      "\n\n---\n\n## BASE DE CONNAISSANCE (MASTER_CONTEXTE_QVEMA_AMPLIFY)\n\n" +
      KNOWLEDGE.knowledge;
  }
  return sys;
}

const TOOLS = [
  {
    name: "get_dashboard_data",
    description:
      "Récupère les indicateurs LIVE du dashboard QVEMA Amplify. Renvoie un JSON agrégé : côté Amplify Connect (membres payants, CA encaissé, ARR, prix moyen, répartition par saison QVEMA et par mode de paiement, candidatures par statut/mode/sous-cercle) et côté Bootcamp (inscrits payés, CA généré/encaissé, remboursements, répartition par promo, démographie). À utiliser dès qu'une question porte sur des chiffres réels, un reporting, la température du pipe, le nombre de membres ou de candidatures.",
    input_schema: { type: "object", properties: {} },
  },
];

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

// Exécute un outil demandé par le modèle.
async function runTool(name, _input, req) {
  if (name === "get_dashboard_data") {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const base = process.env.PUBLIC_BASE_URL || `${proto}://${host}`;
    const r = await fetch(`${base}/api/data`, {
      headers: { "x-dashboard-password": CONFIG.password },
    });
    if (!r.ok) return { error: `api/data ${r.status}`, detail: (await r.text()).slice(0, 500) };
    return await r.json();
  }
  return { error: `Outil inconnu : ${name}` };
}

async function callClaude(messages) {
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
      system: buildSystem(),
      tools: TOOLS,
      messages,
    }),
  });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    /* ignore */
  }
  return { ok: r.ok, status: r.status, data, text };
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

  const incoming = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = incoming
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length) return json(res, 400, { error: "Aucun message" });

  try {
    // Boucle tool-use : au plus 5 tours (largement suffisant ici).
    for (let turn = 0; turn < 5; turn++) {
      const resp = await callClaude(messages);
      if (!resp.ok) {
        return json(res, 502, {
          error: `Erreur API Claude (${resp.status})`,
          detail: (resp.text || "").slice(0, 500),
        });
      }
      const data = resp.data || {};

      if (data.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: data.content });
        const results = [];
        for (const block of data.content || []) {
          if (block.type === "tool_use") {
            let result;
            try {
              result = await runTool(block.name, block.input, req);
            } catch (e) {
              result = { error: String((e && e.message) || e) };
            }
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result).slice(0, 60000),
            });
          }
        }
        messages.push({ role: "user", content: results });
        continue; // relance le modèle avec les résultats d'outils
      }

      const reply = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return json(res, 200, { reply: reply || "(réponse vide)", model: CONFIG.model, usage: data.usage || null });
    }

    return json(res, 200, { reply: "Je me suis un peu perdue dans les données 😅 reformule ta demande ?", model: CONFIG.model });
  } catch (e) {
    return json(res, 500, { error: "Erreur serveur", detail: String((e && e.message) || e) });
  }
};
