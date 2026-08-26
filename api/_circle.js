// QVEMA Amplify — Progression Bootcamp via les tags Circle (Admin API v1).
// Fichier préfixé "_" => helper importé, PAS une route (n'ajoute pas de fonction serverless).
//
// Chaque apprenant a des tags "Promo N" et "Module N". Son module ACTUEL = le plus
// haut tag "Module". On agrège, par promo (et en global "Toutes"), la répartition.
// Variable d'env : CIRCLE_API_TOKEN (token Admin API Circle, accès lecture membres).
const TOKEN = process.env.CIRCLE_API_TOKEN || "";
const BASE = "https://app.circle.so/api/admin/v2";
const PROMO_RE = /^promo\s*(\d+)$/i;
const MODULE_RE = /^module\s*(\d+)$/i;

let _cache = { at: 0, data: null };
const TTL = 300000; // 5 min

async function fetchAllMembers() {
  let members = [], page = 1;
  for (;;) {
    const r = await fetch(BASE + "/community_members?per_page=100&page=" + page, {
      headers: { Authorization: "Bearer " + TOKEN },
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
    let promoNum = null, maxMod = null, finisher = false;
    for (const t of tags) {
      const nm = (t.name || "").trim();
      let mm;
      if ((mm = nm.match(PROMO_RE))) {
        const n = Number(mm[1]);
        if (promoNum == null || n < promoNum) promoNum = n; // si plusieurs, la plus ancienne
      } else if ((mm = nm.match(MODULE_RE))) {
        const n = Number(mm[1]);
        if (maxMod == null || n > maxMod) maxMod = n;
      } else if (/^finisher$/i.test(nm)) finisher = true;
    }
    if (promoNum == null) { horsPromo++; continue; } // pas un apprenant de promo (coach, alumni…)
    // Le tag "Module N" signifie "a TERMINÉ le module N-1". Donc module atteint = plus haut tag - 1.
    // "Finisher" = a terminé tout le bootcamp (module 7). Aucun tag Module = non démarré.
    const level = finisher ? 7 : (maxMod == null ? null : Math.max(0, maxMod - 1));
    const bucket = level == null ? "none" : String(level);
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

// Diagnostic : teste plusieurs bases/en-têtes Circle pour trouver la bonne combinaison.
async function debugRaw() {
  const combos = [
    { label: "v1+Token", url: "https://app.circle.so/api/v1/community_members?per_page=1", h: { Authorization: "Token " + TOKEN } },
    { label: "v1+Bearer", url: "https://app.circle.so/api/v1/community_members?per_page=1", h: { Authorization: "Bearer " + TOKEN } },
    { label: "adminv2+Bearer", url: "https://app.circle.so/api/admin/v2/community_members?per_page=1", h: { Authorization: "Bearer " + TOKEN } },
    { label: "adminv2+Token", url: "https://app.circle.so/api/admin/v2/community_members?per_page=1", h: { Authorization: "Token " + TOKEN } },
    { label: "headless+Bearer", url: "https://app.circle.so/api/headless/v1/community_members?per_page=1", h: { Authorization: "Bearer " + TOKEN } },
  ];
  const tries = [];
  for (const c of combos) {
    try {
      const r = await fetch(c.url, { headers: c.h });
      const t = await r.text();
      tries.push({ combo: c.label, status: r.status, body: t.slice(0, 140) });
    } catch (e) { tries.push({ combo: c.label, error: String((e && e.message) || e) }); }
  }
  return { tokenPresent: !!TOKEN, tokenLen: TOKEN.length, tries };
}

// --- Création d'un live en BROUILLON dans l'espace événement Circle de la promo ---
const EVENT_SPACES = { 1: 2646532, 2: 2646536, 3: 2646539, 4: 2646541 }; // Lives Promo 1..4
function parisOffset(dateStr) {
  try {
    const d = new Date(dateStr + "T12:00:00Z");
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" }).formatToParts(d);
    const tz = ((parts.find((p) => p.type === "timeZoneName") || {}).value) || "GMT+1";
    const m = tz.match(/GMT([+-]?\d+)/);
    const h = m ? parseInt(m[1], 10) : 1;
    return (h >= 0 ? "+" : "-") + String(Math.abs(h)).padStart(2, "0") + ":00";
  } catch (e) { return "+01:00"; }
}
async function createLiveDraft(ev) {
  if (!TOKEN) throw new Error("CIRCLE_API_TOKEN manquant");
  const promo = Number(ev && ev.promo) || 1;
  const spaceId = EVENT_SPACES[promo] || EVENT_SPACES[1];
  const date = (ev && ev.date) || "";
  if (!date) throw new Error("date manquante");
  const deb = (ev && ev.deb) || "18:30";
  const startsAt = date + "T" + deb + ":00" + parisOffset(date);
  let dur = 3600;
  if (ev && ev.deb && ev.fin) {
    const a = ev.deb.split(":").map(Number), b = ev.fin.split(":").map(Number);
    const s = ((b[0] * 60 + b[1]) - (a[0] * 60 + a[1])) * 60;
    if (s > 0) dur = s;
  }
  const payload = {
    space_id: spaceId,
    event: {
      space_id: spaceId,
      name: (ev && ev.name) || "Live",
      status: "draft",
      event_type: "single",
      body: (ev && ev.body) || "",
      event_setting_attributes: { starts_at: startsAt, duration_in_seconds: dur, location_type: "tbd" },
    },
  };
  const r = await fetch(BASE + "/events", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Circle HTTP " + r.status + " : " + t.slice(0, 220));
  let j = {}; try { j = JSON.parse(t); } catch (e) {}
  return { ok: true, promo, spaceId, id: j.id || null, url: j.url || j.public_url || null, name: payload.event.name };
}

// Met à jour un événement Circle existant (par son id) — préserve son statut (brouillon/publié)
// et son espace. Sert quand on édite un live déjà poussé dans Circle depuis l'agenda.
async function updateLiveDraft(ev) {
  if (!TOKEN) throw new Error("CIRCLE_API_TOKEN manquant");
  const id = ev && ev.circleId;
  if (!id) throw new Error("circleId manquant");
  const promo = Number(ev.promo) || 1;
  let spaceId = EVENT_SPACES[promo] || EVENT_SPACES[1];
  let status = "draft";
  // Lire l'état actuel : préserve le statut (ne pas repasser un live publié en brouillon) + l'espace.
  try {
    const g = await fetch(BASE + "/events/" + id, { headers: { Authorization: "Bearer " + TOKEN } });
    if (g.ok) {
      const gj = await g.json();
      if (gj.status) status = gj.status; else if (gj.published_at) status = "published";
      if (gj.space && gj.space.id) spaceId = gj.space.id;
    }
  } catch (e) {}
  const date = (ev.date || "");
  const deb = (ev.deb || "18:30");
  const setting = { duration_in_seconds: 3600 };
  if (ev.deb && ev.fin) {
    const a = ev.deb.split(":").map(Number), b = ev.fin.split(":").map(Number);
    const s = ((b[0] * 60 + b[1]) - (a[0] * 60 + a[1])) * 60; if (s > 0) setting.duration_in_seconds = s;
  }
  if (date) setting.starts_at = date + "T" + deb + ":00" + parisOffset(date);
  const payload = {
    space_id: spaceId,
    event: { space_id: spaceId, name: ev.name || "Live", status, event_type: "single", body: ev.body || "", event_setting_attributes: setting },
  };
  const r = await fetch(BASE + "/events/" + id, {
    method: "PUT",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Circle update HTTP " + r.status + " : " + t.slice(0, 200));
  let j = {}; try { j = JSON.parse(t); } catch (e) {}
  return { ok: true, id, status, url: j.url || null };
}

module.exports = { progression, debugRaw, createLiveDraft, updateLiveDraft };
