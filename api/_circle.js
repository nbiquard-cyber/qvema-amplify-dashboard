// QVEMA Amplify — Progression Bootcamp via les tags Circle (Admin API v1).
// Fichier préfixé "_" => helper importé, PAS une route (n'ajoute pas de fonction serverless).
//
// Chaque apprenant a des tags "Promo N" et "Module N". Son module ACTUEL = le plus
// haut tag "Module". On agrège, par promo (et en global "Toutes"), la répartition.
// Variable d'env : CIRCLE_API_TOKEN (token Admin API Circle, accès lecture membres).
const TOKEN = process.env.CIRCLE_API_TOKEN || "";
const BASE = "https://app.circle.so/api/v1";
const PROMO_RE = /^promo\s*(\d+)$/i;
const MODULE_RE = /^module\s*(\d+)$/i;

let _cache = { at: 0, data: null };
const TTL = 300000; // 5 min

async function fetchAllMembers() {
  let members = [], page = 1;
  for (;;) {
    const r = await fetch(BASE + "/community_members?per_page=100&page=" + page, {
      headers: { Authorization: "Token " + TOKEN },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error("Circle HTTP " + r.status + (t ? " : " + t.slice(0, 160) : ""));
    }
    const j = await r.json();
    const recs = j.records || j.community_members || (Array.isArray(j) ? j : []);
    members = members.concat(recs);
    const more = j.has_next_page === true || recs.length >= 100;
    if (!more || page >= 25) break;
    page++;
  }
  return members;
}

async function progression() {
  if (!TOKEN) throw new Error("CIRCLE_API_TOKEN manquant dans Vercel.");
  if (_cache.data && Date.now() - _cache.at < TTL) return _cache.data;

  const members = await fetchAllMembers();
  const scopes = {};
  const ensure = (k) => scopes[k] || (scopes[k] = { total: 0, byModule: {} });
  let horsPromo = 0;

  for (const m of members) {
    const tags = m.member_tags || [];
    let promoNum = null, maxMod = null;
    for (const t of tags) {
      const nm = (t.name || "").trim();
      let mm;
      if ((mm = nm.match(PROMO_RE))) {
        const n = Number(mm[1]);
        if (promoNum == null || n < promoNum) promoNum = n; // si plusieurs, la plus ancienne
      } else if ((mm = nm.match(MODULE_RE))) {
        const n = Number(mm[1]);
        if (maxMod == null || n > maxMod) maxMod = n;
      }
    }
    if (promoNum == null) { horsPromo++; continue; } // pas un apprenant de promo (coach, alumni…)
    const bucket = maxMod == null ? "none" : String(maxMod);
    for (const k of ["PROMO " + promoNum, "Toutes"]) {
      const s = ensure(k);
      s.total++;
      s.byModule[bucket] = (s.byModule[bucket] || 0) + 1;
    }
  }

  const data = {
    ok: true,
    modules: [0, 1, 2, 3, 4, 5, 6, 7],
    scopes,
    horsPromo,
    membres: members.length,
    generatedAt: new Date().toISOString(),
  };
  _cache = { at: Date.now(), data };
  return data;
}

module.exports = { progression };
