// QVEMA Amplify — Dépense Meta LIVE (Marketing API, insights niveau campagne).
// Fichier préfixé "_" => helper importé, PAS une route (n'ajoute pas de fonction serverless).
//
// fetchCampaignSpend({ token, accounts, since, until, apiVersion, timeoutMs, budgetMs }) :
//   pour chaque compte pub (id numérique, avec ou sans "act_") → GET /act_<id>/insights?level=campaign
//   sur la fenêtre [since, until] (YYYY-MM-DD, une ligne par campagne), suit paging.next jusqu'au bout.
//   Token envoyé en en-tête Authorization: Bearer (jamais en query string, jamais loggé).
//   Un compte en erreur (bloqué, 4xx, timeout, délai global) NE fait PAS échouer les autres : l'erreur est
//   consignée dans errors[] (texte sans balises, tronqué à 200 car., token masqué).
//   Retour : { rows: [{ account, campaignId, name, spend:Number, currency }], errors: [{ account, error }] }.
const GRAPH = "https://graph.facebook.com";
const DEFAULT_VERSION = "v25.0"; // v26.0 disponible depuis 07/2026 ; surcharge via META_API_VERSION
const DEFAULT_TIMEOUT = 8000; // ms par requête (AbortController)
const DEFAULT_BUDGET = 15000; // ms pour l'ensemble des appels d'un compte (pagination comprise)
const MAX_PAGES = 50; // garde-fou pagination (500 lignes / page)

// Masque le token (valeur brute ou paramètre access_token=…), retire les balises HTML, tronque à 200 caractères.
function scrub(msg, token) {
  let s = String(msg == null ? "" : (msg && msg.message) || msg);
  if (token) s = s.split(token).join("[token]");
  s = s.replace(/access_token=[^&\s"']*/gi, "access_token=[token]").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 200);
}

// Retire un éventuel access_token d'une URL (paging.next renvoyé par Graph) : on n'authentifie que par en-tête.
function stripToken(url) {
  try { const u = new URL(url); u.searchParams.delete("access_token"); return u.toString(); } catch (_) { return url; }
}

async function getJson(url, token, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Authorization: "Bearer " + token } });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) {}
    if (!r.ok || !j || j.error) {
      const m = j && j.error ? (j.error.message || JSON.stringify(j.error)) : text;
      throw new Error("Graph HTTP " + r.status + " : " + m);
    }
    return j;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("timeout après " + timeoutMs + " ms");
    throw e;
  } finally { clearTimeout(timer); }
}

async function fetchAccount(acct, { token, since, until, apiVersion, timeoutMs, deadlineAt }) {
  const q = new URLSearchParams({
    level: "campaign", fields: "campaign_id,campaign_name,spend,account_currency",
    time_range: JSON.stringify({ since, until }), limit: "500",
  });
  let url = GRAPH + "/" + apiVersion + "/act_" + acct + "/insights?" + q;
  const byId = new Map(); // fusion des lignes d'une même campagne entre pages
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const left = deadlineAt - Date.now();
    if (left <= 0) throw new Error("délai global dépassé (" + page + " page(s) lue(s))");
    const j = await getJson(url, token, Math.min(timeoutMs, left));
    for (const d of j.data || []) {
      const id = String(d.campaign_id || "");
      const row = byId.get(id) || { account: acct, campaignId: id, name: String(d.campaign_name || ""), spend: 0, currency: String(d.account_currency || "") };
      row.spend += Number(d.spend) || 0;
      byId.set(id, row);
    }
    const next = j.paging && j.paging.next;
    url = next && String(next).startsWith(GRAPH + "/") ? stripToken(String(next)) : null; // ne suit que Graph
  }
  return [...byId.values()];
}

async function fetchCampaignSpend({ token, accounts, since, until, apiVersion, timeoutMs, budgetMs } = {}) {
  const rows = [], errors = [];
  if (!token) return { rows, errors: [{ account: "*", error: "token Meta manquant" }] };
  const opts = { token, since, until, apiVersion: apiVersion || DEFAULT_VERSION, timeoutMs: timeoutMs || DEFAULT_TIMEOUT, deadlineAt: Date.now() + (budgetMs || DEFAULT_BUDGET) };
  await Promise.all((accounts || []).map(async (a) => {
    const acct = String(a == null ? "" : a).trim().replace(/^act_/, "");
    if (!/^\d+$/.test(acct)) { errors.push({ account: acct, error: "id de compte invalide" }); return; }
    try { rows.push(...(await fetchAccount(acct, opts))); }
    catch (e) { errors.push({ account: acct, error: scrub(e, token) }); }
  }));
  return { rows, errors };
}

module.exports = { fetchCampaignSpend, scrub, stripToken, DEFAULT_VERSION };
