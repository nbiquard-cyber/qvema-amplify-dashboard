// QVEMA Amplify — proxy "Pilotage des feedbacks" (login unique).
// Le cockpit s'authentifie avec le mot de passe du dashboard (DASHBOARD_PASSWORD).
// Ce proxy appelle, CÔTÉ SERVEUR, le Google Apps Script du pilotage des feedbacks
// en injectant la clé feedback (variable d'environnement Vercel : FEEDBACK_KEY).
// => un seul mot de passe pour tout le cockpit, et la clé feedback n'est jamais
//    exposée au navigateur (le HTML reste public, mais pas la clé).
const ENDPOINT =
  "https://script.google.com/macros/s/AKfycbzVcNiXd0lAOFtyBWOE4vOaZOj0LHJDqO8zJ_yn6B_nRVtA4mTjfHcR9itlnjL-cAyJnA/exec";

module.exports = async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  // 1) Même porte que le reste du cockpit.
  const pw = req.headers["x-dashboard-password"] || "";
  if (!process.env.DASHBOARD_PASSWORD || pw !== process.env.DASHBOARD_PASSWORD) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  }

  // 2) Clé feedback (à configurer dans Vercel : FEEDBACK_KEY).
  const key = process.env.FEEDBACK_KEY || "";
  if (!key) {
    res.statusCode = 500;
    return res.end(
      JSON.stringify({
        ok: false,
        error:
          "FEEDBACK_KEY manquante : ajoute la variable d'environnement FEEDBACK_KEY dans Vercel (valeur = mot de passe du pilotage des feedbacks).",
      })
    );
  }

  // 3) Lecture côté serveur ; la source renvoie du JSON pur.
  try {
    const url =
      ENDPOINT + "?action=data&key=" + encodeURIComponent(key) + "&t=" + Date.now();
    const r = await fetch(url, { redirect: "follow" });
    let body = (await r.text()).trim();
    // Filet de sécurité si la source venait à renvoyer du JSONP « cb({...}) ».
    const m = body.match(/^[A-Za-z_$][\w$]*\((([\s\S]*))\)\s*;?\s*$/);
    if (m) body = m[1];
    res.statusCode = 200;
    return res.end(body);
  } catch (e) {
    res.statusCode = 502;
    return res.end(
      JSON.stringify({ ok: false, error: "Source feedback injoignable : " + e.message })
    );
  }
};
