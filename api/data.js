// QVEMA Amplify — Live dashboard data API
// Aggregates Airtable (CRM) + Stripe (paiements) and returns JSON.
// Read-only. Auth via shared password (header x-dashboard-password).

const CONFIG = {
  airtableToken: process.env.AIRTABLE_TOKEN || "",
  airtableBase: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
  stripeKey: process.env.STRIPE_KEY || "",
  password: process.env.DASHBOARD_PASSWORD || "",
};

// Airtable table ids
const T = {
  clients: "tblalRhenwmZZgenq", // Bootcamp
  connect: "tblRnZSfcOqww83ua", // Amplify connect (payeurs)
  candidatures: "tblRZz5ZmEMRymltB", // Candidatures Amplify Connect
  accueil: "tbl50HZE7JH2E24xv", // Accueil Bootcamp (onboarding : secteur d'activité)
};

// Stripe amount buckets (in cents / centimes)
const BOOTCAMP_1X = [129000, 99000]; // paiement 1 fois (1290€, ancien 990€)
const BOOTCAMP_4X = [32250, 46666]; // mensualité plan 4x (322,50€, ancien 466,66€)
const AMPLIFY = [100000]; // Amplify Connect (1000€) - jamais compté dans le bootcamp

async function airtableAll(table, fields) {
  const out = [];
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${CONFIG.airtableBase}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (fields) fields.forEach((f) => url.searchParams.append("fields[]", f));
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${CONFIG.airtableToken}` },
    });
    if (!r.ok) throw new Error(`Airtable ${table} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.records);
    offset = j.offset;
  } while (offset);
  return out;
}

async function stripeList(resource, params = {}) {
  const out = [];
  let startingAfter = null;
  do {
    const url = new URL(`https://api.stripe.com/v1/${resource}`);
    url.searchParams.set("limit", "100");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${CONFIG.stripeKey}` },
    });
    if (!r.ok) throw new Error(`Stripe ${resource} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.data);
    if (j.has_more && j.data.length) startingAfter = j.data[j.data.length - 1].id;
    else startingAfter = null;
  } while (startingAfter);
  return out;
}

function bucket(amount) {
  if (BOOTCAMP_1X.includes(amount)) return "b1x";
  if (BOOTCAMP_4X.includes(amount)) return "b4x";
  if (AMPLIFY.includes(amount)) return "amplify";
  return "other";
}

// --- Démographie : département (code postal) -> région française ---
// La feuille Clients n'a pas de champ Région : on le déduit du code postal.
const REGION_BY_DEPT = (() => {
  const map = {};
  const src = {
    "Auvergne-Rhône-Alpes": "01 03 07 15 26 38 42 43 63 69 73 74",
    "Bourgogne-Franche-Comté": "21 25 39 58 70 71 89 90",
    "Bretagne": "22 29 35 56",
    "Centre-Val de Loire": "18 28 36 37 41 45",
    "Corse": "20 2A 2B",
    "Grand Est": "08 10 51 52 54 55 57 67 68 88",
    "Hauts-de-France": "02 59 60 62 80",
    "Île-de-France": "75 77 78 91 92 93 94 95",
    "Normandie": "14 27 50 61 76",
    "Nouvelle-Aquitaine": "16 17 19 23 24 33 40 47 64 79 86 87",
    "Occitanie": "09 11 12 30 31 32 34 46 48 65 66 81 82",
    "Pays de la Loire": "44 49 53 72 85",
    "Provence-Alpes-Côte d'Azur": "04 05 06 13 83 84",
  };
  for (const [region, depts] of Object.entries(src))
    for (const d of depts.split(" ")) map[d] = region;
  return map;
})();

function regionFromFields(f) {
  const pays = (f["Pays"] || "").toString().trim();
  if (pays && !/^(france|fr)$/i.test(pays)) return "Étranger";
  const cp = (f["Code postal"] || "").toString().trim().replace(/\s+/g, "");
  if (!cp) return "Non renseigné";
  const d2 = cp.slice(0, 2);
  if (d2 === "97" || d2 === "98") return "Outre-Mer"; // DOM-TOM
  return REGION_BY_DEPT[d2] || "Non renseigné";
}

// Répartition H/F, âge moyen (+ tranches) et régions pour une liste de clients.
function computeDemographics(list) {
  let Homme = 0, Femme = 0, nonRenseigne = 0;
  const ages = [];
  const tranches = { "< 30 ans": 0, "30–39 ans": 0, "40–49 ans": 0, "50–59 ans": 0, "60 ans et +": 0 };
  const regions = {};
  for (const c of list) {
    const sx = (c.fields["Sexe"] || "").toString().trim();
    if (sx === "Homme") Homme++;
    else if (sx === "Femme") Femme++;
    else nonRenseigne++;

    const age = Number(c.fields["Age"]);
    if (Number.isFinite(age) && age > 0 && age < 120) {
      ages.push(age);
      if (age < 30) tranches["< 30 ans"]++;
      else if (age < 40) tranches["30–39 ans"]++;
      else if (age < 50) tranches["40–49 ans"]++;
      else if (age < 60) tranches["50–59 ans"]++;
      else tranches["60 ans et +"]++;
    }

    const rg = regionFromFields(c.fields);
    regions[rg] = (regions[rg] || 0) + 1;
  }
  const ageMoyen = ages.length
    ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10
    : null;
  return {
    effectif: list.length,
    genre: { Homme, Femme, nonRenseigne },
    age: {
      moyen: ageMoyen,
      renseignes: ages.length,
      min: ages.length ? Math.min(...ages) : null,
      max: ages.length ? Math.max(...ages) : null,
      tranches,
    },
    regions,
  };
}

module.exports = async (req, res) => {
  const pw = req.headers["x-dashboard-password"] || "";
  if (!CONFIG.password || pw !== CONFIG.password) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  try {
    // ---------- AIRTABLE ----------
    const [clients, connect, candidatures, accueil] = await Promise.all([
      airtableAll(T.clients, ["Promo", "Montant", "Statut Paiement", "Produit", "Date Paiement", "Email", "Sexe", "Age", "Code postal", "Pays"]),
      airtableAll(T.connect, ["Email", "Nom complet", "Montant", "Statut Paiement", "Date Paiement", "Mode Paiement", "Saison QVEMA", "Statut Membre"]),
      airtableAll(T.candidatures, ["Statut Candidature", "Statut Membre", "Mode de paiement", "Date Candidature", "Sous-cercle d'intérêt", "Saison"]),
      airtableAll(T.accueil, ["Promo", "Secteur d'activité"]),
    ]);

    const norm = (s) => (s || "").toString().trim();
    const lower = (s) => norm(s).toLowerCase();
    const promoOf = (c) => norm(c.fields["Promo"]) || "Sans promo";

    // ----- Bootcamp (Clients) -----
    const bcPaid = clients.filter((c) => norm(c.fields["Statut Paiement"]) === "Payé");

    // byPromo (comparatif global : inscrits + CA généré par promo)
    const byPromo = {};
    for (const c of bcPaid) {
      const p = promoOf(c);
      const m = Number(c.fields["Montant"]) || 0;
      byPromo[p] = byPromo[p] || { count: 0, montant: 0 };
      byPromo[p].count++;
      byPromo[p].montant += m;
    }

    // Remboursements (global + par promo)
    const refunds = clients.filter((c) => norm(c.fields["Statut Paiement"]) === "Remboursé");
    const caRembourse = refunds.reduce((a, c) => a + (Number(c.fields["Montant"]) || 0), 0);
    const refundByPromo = {};
    for (const c of refunds) {
      const p = promoOf(c);
      const m = Number(c.fields["Montant"]) || 0;
      refundByPromo[p] = refundByPromo[p] || { count: 0, montant: 0 };
      refundByPromo[p].count++;
      refundByPromo[p].montant += m;
    }

    // Statuts de paiement par promo + global
    const statutGlobal = {};
    const statutByPromo = {};
    for (const c of clients) {
      const s = norm(c.fields["Statut Paiement"]) || "Inconnu";
      const p = promoOf(c);
      statutGlobal[s] = (statutGlobal[s] || 0) + 1;
      statutByPromo[p] = statutByPromo[p] || {};
      statutByPromo[p][s] = (statutByPromo[p][s] || 0) + 1;
    }

    // email -> promo (parmi les inscrits payés) pour attribuer les paiements Stripe
    const emailToPromo = {};
    for (const c of bcPaid) {
      const em = lower(c.fields["Email"]);
      if (em) emailToPromo[em] = promoOf(c);
    }
    // email -> promo pour TOUS les clients (dont remboursés) : attribution des refunds Stripe
    const emailToPromoAll = {};
    for (const c of clients) {
      const em = lower(c.fields["Email"]);
      if (em) emailToPromoAll[em] = promoOf(c);
    }

    // ----- Amplify Connect (payeurs Airtable) -----
    const acMembers = connect;
    const acCaAirtable = acMembers.reduce((a, c) => a + (Number(c.fields["Montant"]) || 0), 0);
    const acBySaison = {};
    const acByMode = {};
    for (const c of acMembers) {
      const s = norm(c.fields["Saison QVEMA"]) || "—";
      const mode = norm(c.fields["Mode Paiement"]) || "—";
      acBySaison[s] = (acBySaison[s] || 0) + 1;
      acByMode[mode] = (acByMode[mode] || 0) + 1;
    }
    const candByStatut = {};
    const candByMode = {};
    const candBySousCercle = {};
    for (const c of candidatures) {
      const s = norm(c.fields["Statut Candidature"]) || "—";
      const mode = norm(c.fields["Mode de paiement"]) || "—";
      const sc = norm(c.fields["Sous-cercle d'intérêt"]) || "—";
      candByStatut[s] = (candByStatut[s] || 0) + 1;
      candByMode[mode] = (candByMode[mode] || 0) + 1;
      candBySousCercle[sc] = (candBySousCercle[sc] || 0) + 1;
    }

    // ---------- STRIPE ----------
    let stripeOk = true;
    let stripeError = null;
    let charges = [];
    let subs = [];
    try {
      [charges, subs] = await Promise.all([
        stripeList("charges"),
        stripeList("subscriptions", { status: "all" }),
      ]);
    } catch (e) {
      stripeOk = false;
      stripeError = e.message;
    }

    const succeeded = charges.filter((c) => c.status === "succeeded" && c.paid);
    const chargeEmail = (c) => lower((c.billing_details && c.billing_details.email) || c.receipt_email || "");

    // Attribution des paiements bootcamp (par promo via e-mail) + set des payeurs 4x
    let caEncGlobal = 0;
    let instGlobal = 0; // nb de mensualités 4x encaissées
    const caEncByPromo = {};
    const instByPromo = {};
    const emails4x = new Set();
    // Montant RÉELLEMENT remboursé (Stripe amount_refunded), pas la valeur du contrat.
    let refundEncGlobal = 0;
    const refundEncByPromo = {};
    for (const c of succeeded) {
      const b = bucket(c.amount);
      if (b !== "b1x" && b !== "b4x") continue; // Amplify & autres exclus du bootcamp
      const net = (c.amount - (c.amount_refunded || 0)) / 100;
      const em = chargeEmail(c);
      const promo = em && emailToPromo[em] ? emailToPromo[em] : null;
      caEncGlobal += net;
      if (promo) caEncByPromo[promo] = (caEncByPromo[promo] || 0) + net;
      if (b === "b4x") {
        instGlobal++;
        if (em) emails4x.add(em);
        if (promo) instByPromo[promo] = (instByPromo[promo] || 0) + 1;
      }
      // Refund réel (une ou plusieurs mensualités selon le cas)
      const refd = (c.amount_refunded || 0) / 100;
      if (refd > 0) {
        refundEncGlobal += refd;
        const rp = em && emailToPromoAll[em] ? emailToPromoAll[em] : null;
        if (rp) refundEncByPromo[rp] = (refundEncByPromo[rp] || 0) + refd;
      }
    }

    // Santé des abonnements bootcamp (global)
    const subProduct = (s) => { try { return s.items.data[0].price.product; } catch (_) { return null; } };
    const BOOTCAMP_PRODUCTS = ["prod_UZ1KUTItSVpKvk", "prod_UVLeGAeB6HXrRD"];
    const bcSubs = subs.filter((s) => BOOTCAMP_PRODUCTS.includes(subProduct(s)));
    const bcSubsByStatus = {};
    for (const s of bcSubs) bcSubsByStatus[s.status] = (bcSubsByStatus[s.status] || 0) + 1;

    // Construit un objet d'indicateurs pour une liste d'inscrits payés
    const buildScope = (list, caEnc, installments, statutCounts) => {
      let caGenere = 0;
      const byDay = {};
      let nb4x = 0;
      for (const c of list) {
        caGenere += Number(c.fields["Montant"]) || 0;
        const d = c.fields["Date Paiement"];
        if (d) { const day = d.slice(0, 10); byDay[day] = (byDay[day] || 0) + 1; }
        const em = lower(c.fields["Email"]);
        if (em && emails4x.has(em)) nb4x++;
      }
      const nb1x = Math.max(0, list.length - nb4x);
      return {
        totalInscrits: list.length,
        caGenere,
        caEncaisse: stripeOk ? Math.round(caEnc * 100) / 100 : null,
        caRestantAEncaisser: stripeOk ? Math.round((caGenere - caEnc) * 100) / 100 : null,
        paiement: { un_fois: nb1x, quatre_fois: nb4x, installments_collectees: installments },
        statutCounts,
        byDay,
        demographics: computeDemographics(list),
      };
    };

    // Secteur d'activité (source : Accueil Bootcamp) — global + par promo.
    // La promo Accueil ("Promo 1") est normalisée en MAJ pour matcher les scopes ("PROMO 1").
    const secteurGlobal = {};
    const secteurByPromo = {};
    for (const a of accueil) {
      const sec = norm(a.fields["Secteur d'activité"]);
      if (!sec) continue;
      const p = norm(a.fields["Promo"]).toUpperCase();
      secteurGlobal[sec] = (secteurGlobal[sec] || 0) + 1;
      secteurByPromo[p] = secteurByPromo[p] || {};
      secteurByPromo[p][sec] = (secteurByPromo[p][sec] || 0) + 1;
    }

    const scopes = {};
    scopes["Toutes"] = buildScope(bcPaid, caEncGlobal, instGlobal, statutGlobal);
    scopes["Toutes"].secteurs = secteurGlobal;
    const promoList = [...new Set(bcPaid.map(promoOf))];
    for (const p of promoList) {
      const list = bcPaid.filter((c) => promoOf(c) === p);
      scopes[p] = buildScope(list, caEncByPromo[p] || 0, instByPromo[p] || 0, statutByPromo[p] || {});
      scopes[p].secteurs = secteurByPromo[p] || {};
    }
    // Remboursements par scope : nombre (Airtable), montant réel (Stripe amount_refunded), taux.
    const attachRefund = (scopeObj, count, montantReel, montantContrat) => {
      const denom = scopeObj.totalInscrits + count; // ventes = payés restants + remboursés
      scopeObj.refund = {
        count,
        montant: stripeOk ? Math.round(montantReel * 100) / 100 : null,
        montantContrat: Math.round(montantContrat * 100) / 100,
        taux: denom ? Math.round((count / denom) * 1000) / 10 : 0,
      };
    };
    attachRefund(scopes["Toutes"], refunds.length, refundEncGlobal, caRembourse);
    for (const p of promoList) {
      const r = refundByPromo[p] || { count: 0, montant: 0 };
      attachRefund(scopes[p], r.count, refundEncByPromo[p] || 0, r.montant);
    }
    // Ordre des boutons : Toutes puis promos (PROMO 1, PROMO 2, ...), on masque "Test interne"
    const promoOrder = ["Toutes", ...promoList.filter((p) => p !== "Test interne").sort()];

    const result = {
      generatedAt: new Date().toISOString(),
      stripe: { ok: stripeOk, error: stripeError, nbCharges: charges.length, nbSubscriptions: subs.length },
      bootcamp: {
        scopes,
        promoOrder,
        byPromo,
        caRembourse,
        nbRembourses: refunds.length,
        subsByStatus: bcSubsByStatus,
        prixUnitaire: 1290,
      },
      amplify: {
        membresPayants: acMembers.length,
        caEncaisse: acCaAirtable,
        caAirtable: acCaAirtable,
        abonnementsActifs: acMembers.length,
        arr: acCaAirtable,
        prixAbonnement: acMembers.length ? Math.round(acCaAirtable / acMembers.length) : 0,
        bySaison: acBySaison,
        byMode: acByMode,
        candidatures: {
          total: candidatures.length,
          byStatut: candByStatut,
          byMode: candByMode,
          bySousCercle: candBySousCercle,
        },
      },
    };

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: e.message }));
  }
};
