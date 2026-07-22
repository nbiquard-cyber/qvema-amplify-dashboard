// QVEMA Amplify — CRM (écriture légère, liste blanche stricte).
// Apprenant : Notes + Statut Paiement (table Clients) ; Stade d'avancement (table Accueil Bootcamp,
//             via accueilId, sinon création d'une fiche Accueil minimale).
// Amplify   : Notes + Statut Membre (table Amplify connect).
const auth = require("./_auth.js");

const CONFIG = {
  token: process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || "",
  base: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
};
const T = { clients: "tblalRhenwmZZgenq", connect: "tblRnZSfcOqww83ua", accueil: "tbl50HZE7JH2E24xv" };

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
}
async function patch(table, id, fields) {
  const r = await fetch("https://api.airtable.com/v0/" + CONFIG.base + "/" + table + "/" + id, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + CONFIG.token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: false }),
  });
  if (!r.ok) throw new Error("write_" + table + "_" + r.status + ": " + (await r.text()).slice(0, 200));
  return r.json();
}
async function create(table, fields) {
  const r = await fetch("https://api.airtable.com/v0/" + CONFIG.base + "/" + table, {
    method: "POST",
    headers: { Authorization: "Bearer " + CONFIG.token, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: false }),
  });
  if (!r.ok) throw new Error("create_" + table + "_" + r.status + ": " + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.records && j.records[0];
}
const clean = (s) => (s == null ? "" : String(s));

module.exports = async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: "method" })); }

  const user = auth.authFromRequest(req);
  if (!user) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: "unauthorized" })); }
  if (!CONFIG.token) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "AIRTABLE_WRITE_TOKEN manquante." })); }

  let body;
  try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) { body = {}; }
  const object = body.object;
  const id = body.id;
  const p = body.patch || {};

  try {
    const result = { ok: true, patched: {} };

    if (object === "apprenant") {
      if (!auth.has(user.perms, "bootcamp")) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: "forbidden" })); }
      // Champs Clients
      const cf = {};
      if (typeof p.notes === "string") cf["Notes"] = clean(p.notes);
      if (typeof p.statutPaiement === "string" && p.statutPaiement) cf["Statut Paiement"] = clean(p.statutPaiement);
      if (Object.keys(cf).length) {
        if (!id) throw new Error("id_manquant");
        await patch(T.clients, id, cf);
        Object.assign(result.patched, cf);
      }
      // Stade -> Accueil Bootcamp
      if (typeof p.stade === "string") {
        if (body.accueilId) {
          await patch(T.accueil, body.accueilId, { "Stade d'avancement": clean(p.stade) });
        } else if (body.email) {
          const rec = await create(T.accueil, {
            "Adresse mail": clean(body.email),
            "Promo": clean(body.promo || ""),
            "Stade d'avancement": clean(p.stade),
          });
          result.accueilId = rec && rec.id;
        } else {
          throw new Error("stade_sans_fiche_accueil");
        }
        result.patched["Stade d'avancement"] = clean(p.stade);
      }
    } else if (object === "amplify") {
      if (!auth.has(user.perms, "amplify")) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: "forbidden" })); }
      if (!id) throw new Error("id_manquant");
      const cf = {};
      if (typeof p.notes === "string") cf["Notes"] = clean(p.notes);
      if (typeof p.statutMembre === "string" && p.statutMembre) cf["Statut Membre"] = clean(p.statutMembre);
      if (Object.keys(cf).length) { await patch(T.connect, id, cf); Object.assign(result.patched, cf); }
    } else {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "objet_inconnu" }));
    }

    res.statusCode = 200;
    return res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
