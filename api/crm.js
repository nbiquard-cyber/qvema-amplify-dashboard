// QVEMA Amplify — CRM (lecture).
// Apprenants  = table Clients (Statut Paiement = "Payé"), enrichis par Accueil Bootcamp
//               (stade d'avancement, secteur…) via jointure e-mail.
// Amplify     = table Amplify connect (membres/payeurs).
// Accès par permissions : apprenants -> "bootcamp", amplify -> "amplify".
const auth = require("./_auth.js");

const CONFIG = {
  token: process.env.AIRTABLE_TOKEN || "",
  base: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
};
const T = {
  clients: "tblalRhenwmZZgenq",
  connect: "tblRnZSfcOqww83ua",
  accueil: "tbl50HZE7JH2E24xv",
};

const norm = (s) => (s == null ? "" : String(s)).trim();
const lower = (s) => norm(s).toLowerCase();

async function airtableAll(table, fields) {
  const out = [];
  let offset = null;
  do {
    const url = new URL("https://api.airtable.com/v0/" + CONFIG.base + "/" + table);
    url.searchParams.set("pageSize", "100");
    (fields || []).forEach((f) => url.searchParams.append("fields[]", f));
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + CONFIG.token } });
    if (!r.ok) throw new Error("airtable_" + table + "_" + r.status);
    const j = await r.json();
    out.push(...(j.records || []));
    offset = j.offset;
  } while (offset);
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  const user = auth.authFromRequest(req);
  if (!user) { res.statusCode = 401; return res.end(JSON.stringify({ error: "unauthorized" })); }
  const canBoot = auth.has(user.perms, "bootcamp");
  const canAmp = auth.has(user.perms, "amplify");
  if (!canBoot && !canAmp) { res.statusCode = 403; return res.end(JSON.stringify({ error: "forbidden" })); }

  try {
    const jobs = [];
    // Apprenants (Clients payés) + Accueil (jointure) si droit bootcamp.
    if (canBoot) {
      jobs.push(
        airtableAll(T.clients, [
          "Prénom", "Nom", "Promo", "Email", "Téléphone", "Montant", "Mode de paiement",
          "Statut Paiement", "Produit", "Date Paiement", "Ville", "Code postal", "Pays",
          "Sexe", "Date de naissance", "Notes", "Circle Profile URL",
        ]),
        airtableAll(T.accueil, [
          "Adresse mail", "Promo", "Prénom", "Nom", "Secteur d'activité", "Stade d'avancement",
          "Description en 1 phrase", "Ce que je recherche", "LinkedIn", "Site web",
          "Nom du projet / Entreprise",
        ])
      );
    }
    if (canAmp) {
      jobs.push(
        airtableAll(T.connect, [
          "Email", "Nom complet", "Nom entreprise", "Téléphone", "Montant", "Statut Paiement",
          "Statut Membre", "Saison QVEMA", "Mode Paiement", "Date Paiement", "Ville", "Notes",
        ])
      );
    }
    const results = await Promise.all(jobs);

    const out = { generatedAt: new Date().toISOString() };

    if (canBoot) {
      const clients = results[0];
      const accueil = results[1];
      // Index Accueil par e-mail (fiche la plus complète = dernière rencontrée).
      const accByEmail = {};
      for (const a of accueil) {
        const em = lower(a.fields["Adresse mail"]);
        if (em) accByEmail[em] = a;
      }
      out.apprenants = clients
        .filter((c) => norm(c.fields["Statut Paiement"]) === "Payé")
        .map((c) => {
          const f = c.fields;
          const em = lower(f["Email"]);
          const a = em ? accByEmail[em] : null;
          const af = a ? a.fields : {};
          return {
            id: c.id,
            accueilId: a ? a.id : null,
            prenom: norm(f["Prénom"]),
            nom: norm(f["Nom"]),
            email: norm(f["Email"]),
            tel: norm(f["Téléphone"]),
            promo: norm(f["Promo"]),
            produit: norm(f["Produit"]),
            montant: Number(f["Montant"]) || 0,
            mode: norm(f["Mode de paiement"]),
            statutPaiement: norm(f["Statut Paiement"]),
            ville: norm(f["Ville"]),
            cp: norm(f["Code postal"]),
            pays: norm(f["Pays"]),
            sexe: norm(f["Sexe"]),
            dob: norm(f["Date de naissance"]),
            datePaiement: norm(f["Date Paiement"]),
            notes: norm(f["Notes"]),
            circleUrl: norm(f["Circle Profile URL"]),
            // Enrichissement Accueil Bootcamp
            stade: norm(af["Stade d'avancement"]),
            secteur: norm(af["Secteur d'activité"]),
            projet: norm(af["Nom du projet / Entreprise"]),
            description: norm(af["Description en 1 phrase"]),
            recherche: norm(af["Ce que je recherche"]),
            linkedin: norm(af["LinkedIn"]),
            site: norm(af["Site web"]),
          };
        })
        .sort((x, y) => (x.nom + x.prenom).localeCompare(y.nom + y.prenom, "fr"));
    }

    if (canAmp) {
      const connect = results[canBoot ? 2 : 0];
      out.amplify = connect
        .map((c) => {
          const f = c.fields;
          return {
            id: c.id,
            nom: norm(f["Nom complet"]),
            email: norm(f["Email"]),
            entreprise: norm(f["Nom entreprise"]),
            tel: norm(f["Téléphone"]),
            montant: Number(f["Montant"]) || 0,
            statutPaiement: norm(f["Statut Paiement"]),
            statutMembre: norm(f["Statut Membre"]),
            saison: norm(f["Saison QVEMA"]),
            mode: norm(f["Mode Paiement"]),
            date: norm(f["Date Paiement"]),
            ville: norm(f["Ville"]),
            notes: norm(f["Notes"]),
          };
        })
        .sort((x, y) => (x.nom || x.email).localeCompare(y.nom || y.email, "fr"));
    }

    res.statusCode = 200;
    return res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message }));
  }
};
