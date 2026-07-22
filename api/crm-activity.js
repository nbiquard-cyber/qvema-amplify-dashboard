// QVEMA Amplify — CRM : notes & tâches (timeline par contact).
// GET  ?ref=recXXX&objet=apprenant|amplify   -> liste des activités du contact.
// POST { action:'create'|'update'|'delete', ... }.
// Permissions : objet=apprenant -> "bootcamp" ; objet=amplify -> "amplify".
const auth = require("./_auth.js");

const CONFIG = {
  readToken: process.env.AIRTABLE_TOKEN || "",
  writeToken: process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || "",
  base: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
  table: "CRM Activités",
};
const permForObjet = (o) => (o === "amplify" ? "amplify" : "bootcamp");
const OBJ_LABEL = { apprenant: "Apprenant", amplify: "Amplify" };
const clean = (s) => (s == null ? "" : String(s));

function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); req.on("error", () => resolve(""));
  });
}
function tableUrl() { return "https://api.airtable.com/v0/" + CONFIG.base + "/" + encodeURIComponent(CONFIG.table); }

module.exports = async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  const user = auth.authFromRequest(req);
  if (!user) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: "unauthorized" })); }

  try {
    // ---------- GET : liste ----------
    if (req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const ref = clean(u.searchParams.get("ref"));
      const objet = clean(u.searchParams.get("objet"));
      if (!ref) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: "ref_manquante" })); }
      if (!auth.has(user.perms, permForObjet(objet))) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: "forbidden" })); }
      const url = new URL(tableUrl());
      url.searchParams.set("filterByFormula", "{Réf}='" + ref.replace(/'/g, "") + "'");
      url.searchParams.set("pageSize", "100");
      const r = await fetch(url, { headers: { Authorization: "Bearer " + CONFIG.readToken } });
      if (!r.ok) throw new Error("read_" + r.status);
      const j = await r.json();
      const items = (j.records || []).map((rec) => {
        const f = rec.fields || {};
        return {
          id: rec.id,
          createdTime: rec.createdTime,
          type: clean(f["Type"]),
          contenu: clean(f["Contenu"]),
          statut: clean(f["Statut"]),
          echeance: clean(f["Échéance"]),
          responsable: clean(f["Responsable"]),
          auteur: clean(f["Auteur"]),
        };
      }).sort((a, b) => (b.createdTime || "").localeCompare(a.createdTime || ""));
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, items }));
    }

    // ---------- POST : create / update / delete ----------
    if (req.method === "POST") {
      if (!CONFIG.writeToken) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "AIRTABLE_WRITE_TOKEN manquante." })); }
      let body; try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) { body = {}; }
      const action = body.action;
      const objet = clean(body.objet);
      if (!auth.has(user.perms, permForObjet(objet))) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: "forbidden" })); }
      const H = { Authorization: "Bearer " + CONFIG.writeToken, "Content-Type": "application/json" };

      if (action === "create") {
        const type = body.type === "Tâche" ? "Tâche" : "Note";
        const contenu = clean(body.contenu).trim();
        if (!contenu) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: "contenu_vide" })); }
        const fields = {
          Contact: clean(body.contact),
          Type: type,
          Objet: OBJ_LABEL[objet] || "Apprenant",
          "Réf": clean(body.ref),
          Email: clean(body.email),
          Contenu: contenu,
          Auteur: clean(user.email || user.name || ""),
        };
        if (type === "Tâche") {
          fields["Statut"] = clean(body.statut) || "À faire";
          if (body.echeance) fields["Échéance"] = clean(body.echeance);
          if (body.responsable) fields["Responsable"] = clean(body.responsable);
        }
        const r = await fetch(tableUrl(), { method: "POST", headers: H, body: JSON.stringify({ records: [{ fields }], typecast: false }) });
        if (!r.ok) throw new Error("create_" + r.status + ": " + (await r.text()).slice(0, 200));
        const j = await r.json();
        res.statusCode = 200; return res.end(JSON.stringify({ ok: true, id: j.records && j.records[0] && j.records[0].id }));
      }

      if (action === "update") {
        const id = clean(body.id); if (!id) throw new Error("id_manquant");
        const p = body.patch || {};
        const fields = {};
        if (typeof p.statut === "string" && p.statut) fields["Statut"] = clean(p.statut);
        if (typeof p.contenu === "string") fields["Contenu"] = clean(p.contenu);
        if (typeof p.echeance === "string") fields["Échéance"] = clean(p.echeance);
        if (typeof p.responsable === "string") fields["Responsable"] = clean(p.responsable);
        const r = await fetch(tableUrl() + "/" + id, { method: "PATCH", headers: H, body: JSON.stringify({ fields, typecast: false }) });
        if (!r.ok) throw new Error("update_" + r.status + ": " + (await r.text()).slice(0, 200));
        res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
      }

      if (action === "delete") {
        const id = clean(body.id); if (!id) throw new Error("id_manquant");
        const r = await fetch(tableUrl() + "/" + id, { method: "DELETE", headers: { Authorization: "Bearer " + CONFIG.writeToken } });
        if (!r.ok) throw new Error("delete_" + r.status);
        res.statusCode = 200; return res.end(JSON.stringify({ ok: true }));
      }

      res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: "action_inconnue" }));
    }

    res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: "method" }));
  } catch (e) {
    res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
