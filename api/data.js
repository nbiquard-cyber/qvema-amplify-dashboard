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

module.exports = async (req, res) => {
  const pw = req.headers["x-dashboard-password"] || "";
  if (!CONFIG.password || pw !== CONFIG.password) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  try {
    // ---------- AIRTABLE ----------
    const [clients, connect, candidatures] = await Promise.all([
      airtableAll(T.clients, ["Promo", "Montant", "Statut Paiement", "Produit", "Date Paiement", "Email"]),
      airtableAll(T.connect, ["Email", "Nom complet", "Montant", "Statut Paiement", "Date Paiement", "Mode Paiement", "Saison QVEMA", "Statut Membre"]),
      airtableAll(T.candidatures, ["Statut Candidature", "Statut Membre", "Mode de paiement", "Date Candidature", "Sous-cercle d'intérêt", "Saison"]),
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

    // Remboursements (global, info)
    const refunds = clients.filter((c) => norm(c.fields["Statut Paiement"]) === "Remboursé");
    const caRembourse = refunds.reduce((a, c) => a + (Number(c.fields["Montant"]) || 0), 0);

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
      };
    };

    const scopes = {};
    scopes["Toutes"] = buildScope(bcPaid, caEncGlobal, instGlobal, statutGlobal);
    const promoList = [...new Set(bcPaid.map(promoOf))];
    for (const p of promoList) {
      const list = bcPaid.filter((c) => promoOf(c) === p);
      scopes[p] = buildScope(list, caEncByPromo[p] || 0, instByPromo[p] || 0, statutByPromo[p] || {});
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
