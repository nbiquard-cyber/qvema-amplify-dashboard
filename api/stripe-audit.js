// QVEMA Amplify — AUDIT Stripe TEMPORAIRE (admin only). À SUPPRIMER après usage.
// Réconciliation : distribution de tous les montants Stripe, montants non classés,
// et attribution par promo (brut vs bucket) pour repérer ce qui manque.
const auth = require("./_auth.js");

const CONFIG = {
  stripeKey: process.env.STRIPE_KEY || "",
  airtableToken: process.env.AIRTABLE_TOKEN || "",
  base: process.env.AIRTABLE_BASE || "appUjhN2jh25MBAAl",
};
const T_CLIENTS = "tblalRhenwmZZgenq";
const BOOTCAMP = [129000, 99000, 149000, 32250, 46666, 37250];
const AMPLIFY = [100000];
const norm = (s) => (s == null ? "" : "" + s).trim();
const lower = (s) => norm(s).toLowerCase();

async function stripeList(resource, params = {}) {
  const out = [];
  let after = null;
  do {
    const url = new URL("https://api.stripe.com/v1/" + resource);
    url.searchParams.set("limit", "100");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (after) url.searchParams.set("starting_after", after);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + CONFIG.stripeKey } });
    if (!r.ok) throw new Error("Stripe " + resource + " " + r.status + ": " + (await r.text()).slice(0, 200));
    const j = await r.json();
    out.push(...j.data);
    after = j.has_more && j.data.length ? j.data[j.data.length - 1].id : null;
  } while (after);
  return out;
}
async function airtableAll(table, fields) {
  const out = []; let offset = null;
  do {
    const url = new URL("https://api.airtable.com/v0/" + CONFIG.base + "/" + table);
    url.searchParams.set("pageSize", "100");
    fields.forEach((f) => url.searchParams.append("fields[]", f));
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + CONFIG.airtableToken } });
    if (!r.ok) throw new Error("airtable " + r.status);
    const j = await r.json();
    out.push(...(j.records || [])); offset = j.offset;
  } while (offset);
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  const user = auth.authFromRequest(req);
  if (!user || !auth.has(user.perms, "admin")) { res.statusCode = 403; return res.end(JSON.stringify({ error: "admin only" })); }
  try {
    const [charges, clients] = await Promise.all([
      stripeList("charges"),
      airtableAll(T_CLIENTS, ["Promo", "Email", "Statut Paiement", "Montant"]),
    ]);
    const succeeded = charges.filter((c) => c.status === "succeeded" && c.paid);
    const chargeEmail = (c) => lower((c.billing_details && c.billing_details.email) || c.receipt_email || "");

    const emailToPromo = {};
    clients
      .filter((c) => norm(c.fields["Statut Paiement"]) === "Payé" && !/test/i.test(norm(c.fields["Promo"])))
      .forEach((c) => { const em = lower(c.fields["Email"]); if (em) emailToPromo[em] = norm(c.fields["Promo"]); });

    const bootSet = new Set(BOOTCAMP), ampSet = new Set(AMPLIFY);
    const amountDist = {}, unclassified = {}, rawByPromo = {}, bucketByPromo = {}, p2amounts = {};
    let unattributedBoot = { count: 0, net: 0 };
    for (const c of succeeded) {
      const a = c.amount, net = (c.amount - (c.amount_refunded || 0)) / 100;
      amountDist[a] = amountDist[a] || { count: 0, net: 0 }; amountDist[a].count++; amountDist[a].net += net;
      if (!bootSet.has(a) && !ampSet.has(a)) { unclassified[a] = unclassified[a] || { count: 0, net: 0 }; unclassified[a].count++; unclassified[a].net += net; }
      const em = chargeEmail(c), promo = em && emailToPromo[em] ? emailToPromo[em] : null;
      if (promo) {
        rawByPromo[promo] = (rawByPromo[promo] || 0) + net;
        if (bootSet.has(a)) bucketByPromo[promo] = (bucketByPromo[promo] || 0) + net;
        if (promo === "PROMO 2") p2amounts[a] = (p2amounts[a] || 0) + 1;
      } else if (bootSet.has(a)) { unattributedBoot.count++; unattributedBoot.net += net; }
    }
    const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    res.statusCode = 200;
    return res.end(JSON.stringify({
      nbSucceeded: succeeded.length,
      amountDist: Object.entries(amountDist).sort((x, y) => y[1].net - x[1].net),
      unclassifiedAmounts: Object.entries(unclassified).sort((x, y) => y[1].net - x[1].net),
      rawByPromo: round(rawByPromo),
      bucketByPromo: round(bucketByPromo),
      promo2AmountCounts: p2amounts,
      unattributedBootcampCharges: { count: unattributedBoot.count, net: Math.round(unattributedBoot.net * 100) / 100 },
    }, null, 2));
  } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
};
