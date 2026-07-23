// QVEMA Amplify — Commentaires par page (cockpit).
// Confidentialité : chaque personne ne voit QUE ses propres commentaires ;
// seuls Nathan et Jean-Baptiste voient l'ensemble. Filtrage CÔTÉ SERVEUR.
// GET  ?page=<clé>  -> liste visible par l'utilisateur.
// POST { page, pageLabel, texte } -> crée + notifie Nathan (webhook optionnel).
const auth = require("./_auth.js");

const CONFIG = {
  readToken: process.env.AIRTABLE_TOKEN || "",
  writeToken: process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || "",
  base: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
  table: "Cockpit Commentaires",
  webhook: process.env.COMMENT_WEBHOOK_URL || "",
};
// Les deux seules personnes autorisées à voir TOUS les commentaires.
const ADMINS = ["nbiquard@qvemaamplify.com", "jbpasquier@qvemaamplify.com"];
const NOTIFY = "nbiquard@qvemaamplify.com";

const clean = (s) => (s == null ? "" : "" + s);
const lower = (s) => clean(s).trim().toLowerCase();
const escF = (s) => String(s).replace(/'/g, "");
const tableUrl = () => "https://api.airtable.com/v0/" + CONFIG.base + "/" + encodeURIComponent(CONFIG.table);
function readBody(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); req.on("error", () => r("")); }); }

module.exports = async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  const user = auth.authFromRequest(req);
  if (!user) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: "unauthorized" })); }
  const canSeeAll = ADMINS.includes(lower(user.email));

  try {
    if (req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const page = clean(u.searchParams.get("page")).trim();
      if (!page) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: "page_manquante" })); }
      const formula = canSeeAll
        ? "{Page}='" + escF(page) + "'"
        : "AND({Page}='" + escF(page) + "',LOWER({Auteur})='" + escF(lower(user.email)) + "')";
      const url = new URL(tableUrl());
      url.searchParams.set("filterByFormula", formula);
      url.searchParams.set("pageSize", "100");
      const r = await fetch(url, { headers: { Authorization: "Bearer " + CONFIG.readToken } });
      if (!r.ok) throw new Error("read_" + r.status);
      const j = await r.json();
      const items = (j.records || [])
        .map((rec) => ({ id: rec.id, createdTime: rec.createdTime, auteur: clean(rec.fields["Auteur"]), nom: clean(rec.fields["Nom"]), commentaire: clean(rec.fields["Commentaire"]) }))
        .sort((a, b) => (b.createdTime || "").localeCompare(a.createdTime || ""));
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, canSeeAll, items }));
    }

    if (req.method === "POST") {
      if (!CONFIG.writeToken) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "AIRTABLE_WRITE_TOKEN manquante" })); }
      let body; try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) { body = {}; }
      const page = clean(body.page).trim();
      const texte = clean(body.texte).trim();
      if (!page || !texte) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: "page_ou_texte_manquant" })); }
      const fields = { Auteur: lower(user.email), Nom: clean(user.name), Page: page, Commentaire: texte };
      const r = await fetch(tableUrl(), { method: "POST", headers: { Authorization: "Bearer " + CONFIG.writeToken, "Content-Type": "application/json" }, body: JSON.stringify({ records: [{ fields }], typecast: false }) });
      if (!r.ok) throw new Error("create_" + r.status + ": " + (await r.text()).slice(0, 200));
      const j = await r.json();
      // Notification Nathan : webhook optionnel (ex. Make -> email). Sinon, une
      // automation Airtable "record created -> email" fait le job.
      if (CONFIG.webhook) {
        try {
          await fetch(CONFIG.webhook, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notify: NOTIFY, page, pageLabel: clean(body.pageLabel) || page, auteur: fields.Auteur, nom: fields.Nom, commentaire: texte, at: new Date().toISOString() }),
          });
        } catch (e) { /* notification best-effort */ }
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, id: j.records && j.records[0] && j.records[0].id }));
    }

    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "method" }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
