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
const AMPLIFY = [100000]; // Amplify Connect 1000€/an
const BOOTCAMP_PRODUCTS = ["prod_UZ1KUTItSVpKvk", "prod_UVLeGAeB6HXrRD"];
const AMPLIFY_PRODUCTS = ["prod_UZQXh1ELvDob4Q"];

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
  // Paginate fully through a Stripe list endpoint
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
  // --- Auth ---
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

    // ----- Bootcamp (Clients) -----
    const norm = (s) => (s || "").toString().trim();
    const bcPaid = clients.filter((c) => norm(c.fields["Statut Paiement"]) === "Payé");
    const byPromo = {};
    let caGenere = 0;
    for (const c of bcPaid) {
      const promo = norm(c.fields["Promo"]) || "Sans promo";
      const m = Number(c.fields["Montant"]) || 0;
      byPromo[promo] = byPromo[promo] || { count: 0, montant: 0 };
      byPromo[promo].count++;
      byPromo[promo].montant += m;
      caGenere += m;
    }
    const statutCounts = {};
    for (const c of clients) {
      const s = norm(c.fields["Statut Paiement"]) || "Inconnu";
      statutCounts[s] = (statutCounts[s] || 0) + 1;
    }
    const refunds = clients.filter((c) => norm(c.fields["Statut Paiement"]) === "Remboursé");
    const caRembourse = refunds.reduce((a, c) => a + (Number(c.fields["Montant"]) || 0), 0);

    // Acquisition par jour (Date Paiement) pour les payés
    const bcByDay = {};
    for (const c of bcPaid) {
      const d = c.fields["Date Paiement"];
      if (!d) continue;
      const day = d.slice(0, 10);
      bcByDay[day] = (bcByDay[day] || 0) + 1;
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
    // Candidatures
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

    // Charges classification
    const succeeded = charges.filter((c) => c.status === "succeeded" && c.paid);
    let caEncaisseBootcamp = 0,
      caEncaisseAmplify = 0,
      caEncaisseOther = 0;
    let nbCharges1x = 0,
      nbCharges4x = 0,
      nbChargesAmplify = 0;
    const cust1x = new Set();
    const cust4x = new Set();
    for (const c of succeeded) {
      const net = (c.amount - (c.amount_refunded || 0)) / 100;
      const b = bucket(c.amount);
      const fullyRefunded = c.amount_refunded >= c.amount;
      if (b === "b1x") {
        caEncaisseBootcamp += net;
        if (!fullyRefunded) { nbCharges1x++; if (c.customer) cust1x.add(c.customer); }
      } else if (b === "b4x") {
        caEncaisseBootcamp += net;
        nbCharges4x++;
        if (c.customer) cust4x.add(c.customer);
      } else if (b === "amplify") {
        caEncaisseAmplify += net;
        if (!fullyRefunded) { nbChargesAmplify++; }
      } else {
        caEncaisseOther += net;
      }
    }

    // Subscriptions classification
    const subProduct = (s) => {
      try { return s.items.data[0].price.product; } catch (_) { return null; }
    };
    const bcSubs = subs.filter((s) => BOOTCAMP_PRODUCTS.includes(subProduct(s)));
    const acSubs = subs.filter((s) => AMPLIFY_PRODUCTS.includes(subProduct(s)));
    const bcSubsByStatus = {};
    for (const s of bcSubs) bcSubsByStatus[s.status] = (bcSubsByStatus[s.status] || 0) + 1;
    const acSubsActive = acSubs.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
    const acAmount = (() => { try { return acSubs[0].items.data[0].price.unit_amount / 100; } catch (_) { return 1000; } })();

    const nb4x = cust4x.size; // clients distincts en paiement 4 fois
    const nb1x = Math.max(0, bcPaid.length - nb4x); // le reste = paiement 1 fois

    const result = {
      generatedAt: new Date().toISOString(),
      stripe: { ok: stripeOk, error: stripeError, nbCharges: charges.length, nbSubscriptions: subs.length },
      bootcamp: {
        totalInscrits: bcPaid.length,
        byPromo,
        statutCounts,
        caGenere,
        caRembourse,
        nbRembourses: refunds.length,
        paiement: {
          un_fois: nb1x,
          quatre_fois: nb4x,
          installments_collectees: nbCharges4x,
          source: "Stripe (abonnements = 4x, charges one-time = 1x)",
        },
         caEncaisse: acCaAirtable,
        caAirtable: acCaAirtable,
        abonnementsActifs: acMembers.length,
        arr: acCaAirtable,
        prixAbonnement: acMembers.length ? Math.round(acCaAirtable / acMembers.length) : 0,
      },
      amplify: {
        membresPayants: acMembers.length,
        caEncaisse: stripeOk ? Math.round(caEncaisseAmplify * 100) / 100 : acCaAirtable,
        caAirtable: acCaAirtable,
        abonnementsActifs: acSubsActive.length,
        arr: acSubsActive.length * acAmount,
        prixAbonnement: acAmount,
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
