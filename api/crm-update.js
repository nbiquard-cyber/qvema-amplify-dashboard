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
    } else if (object === "p3-identity-map" || object === "identity-map") {
      // Mapping identité Accueil -> Clients pour une promo (body.promo, défaut PROMO 3) (Prénom, Nom, Sexe, Date de naissance).
      // Remplit UNIQUEMENT les champs vides (ne réécrit jamais une valeur existante) et ne traite
      // que les Clients P3 appariés par e-mail à une réponse Accueil P3. dry=true -> plan sans écriture.
      if (!auth.has(user.perms, "bootcamp")) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: "forbidden" })); }
      const dry = body.dry !== false; // par défaut, aperçu seulement
      const norm = (s) => (s == null ? "" : String(s)).trim();
      const low = (s) => norm(s).toLowerCase();
      const promoWanted = (norm(body.promo) || "PROMO 3").toUpperCase();
      const isP3 = (v) => norm(v).toUpperCase() === promoWanted;
      // Overrides sexe validés par l'utilisateur (par e-mail)
      const SEXE_OVERRIDE = { "net-eclair@hotmail.com": "Homme" };
      const toISODate = (v) => {
        const s = norm(v); if (!s) return "";
        const t = Date.parse(s); if (isNaN(t)) return "";
        const d = new Date(t + 12 * 3600 * 1000); // recadre le midi -> date locale correcte
        return d.toISOString().slice(0, 10);
      };
      async function all(table, fields) {
        const out = []; let offset;
        do {
          const u = new URL("https://api.airtable.com/v0/" + CONFIG.base + "/" + table);
          fields.forEach((f) => u.searchParams.append("fields[]", f));
          u.searchParams.set("pageSize", "100");
          if (offset) u.searchParams.set("offset", offset);
          const r = await fetch(u, { headers: { Authorization: "Bearer " + CONFIG.token } });
          if (!r.ok) throw new Error("read_" + table + "_" + r.status);
          const j = await r.json();
          out.push(...j.records); offset = j.offset;
        } while (offset);
        return out;
      }
      const [clients, accueil] = await Promise.all([
        all(T.clients, ["Email", "Promo", "Statut Paiement", "Prénom", "Nom", "Sexe", "Date de naissance"]),
        all(T.accueil, ["Adresse mail", "Promo", "Prénom", "Nom", "Sexe", "Date de naissance"]),
      ]);
      // Dernière réponse Accueil P3 par e-mail
      const acc = {};
      for (const a of accueil) {
        if (!isP3(a.fields["Promo"])) continue;
        const e = low(a.fields["Adresse mail"]); if (!e) continue;
        acc[e] = a.fields;
      }
      const plan = [];
      for (const c of clients) {
        if (!isP3(c.fields["Promo"])) continue;
        const e = low(c.fields["Email"]); if (!e || !acc[e]) continue;
        const a = acc[e];
        const fill = {};
        if (!norm(c.fields["Prénom"]) && norm(a["Prénom"])) fill["Prénom"] = norm(a["Prénom"]);
        if (!norm(c.fields["Nom"]) && norm(a["Nom"])) fill["Nom"] = norm(a["Nom"]);
        if (!norm(c.fields["Sexe"])) {
          const sx = SEXE_OVERRIDE[e] || norm(a["Sexe"]);
          if (sx) fill["Sexe"] = sx;
        }
        if (!norm(c.fields["Date de naissance"])) {
          const dob = toISODate(a["Date de naissance"]);
          if (dob) fill["Date de naissance"] = dob;
        }
        if (Object.keys(fill).length) {
          plan.push({ id: c.id, email: norm(c.fields["Email"]), fill });
        }
      }
      let written = 0;
      if (!dry) {
        for (const row of plan) {
          await patch(T.clients, row.id, row.fill);
          written++;
        }
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, dry, promo: promoWanted, candidats: plan.length, written, plan }, null, 2));
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
