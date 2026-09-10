# qvema-amplify-dashboard

Cockpit QVEMA Amplify : HTML statique + fonctions serverless `api/*.js` (Vercel, plan Hobby : 12 routes max, les fichiers préfixés `_` sont des helpers, pas des routes).

## Acquisition — dépense Meta live (Promo 3)

La vue Acquisition lit `/api/acquisition` (`api/acquisition.js`). P1 et P2 : constantes validées (exports Ads Manager). P3 : inscrits live Airtable (vue « Inscrits Webi 3 ») **et dépense Meta live** via la Marketing API (`api/_meta.js`).

Périmètre P3 : les campagnes dont le nom contient « Septembre 2026 », sur les deux comptes publicitaires MON ASSOCIE FACTORY (`act_3220696111443286`, principal) et Bootcamp QVEMA (`act_854328590746337`, back-up). Les campagnes hors périmètre qui dépensent sont listées dans la note de la carte « Dépense ads » (jamais sommées).

### 1. Jeton Meta (Business Manager, une fois)

1. Meta Business Suite → Paramètres → Utilisateurs → **Utilisateurs système** → créer un utilisateur système (rôle Employé suffit).
2. **Attribuer des actifs** : les deux comptes publicitaires ci-dessus, avec l'accès « Voir les performances » (ANALYZE). Sans cette attribution, la note affichera `(#100) … missing permissions`.
3. **Générer un jeton** : choisir l'app (accès Ads Management Standard ou plus), permission `ads_read` uniquement. Le jeton n'est affiché qu'une fois. Non expirant par défaut ; si « expire dans 60 jours » est coché, prévoir le renouvellement (sinon `(#190)` dans la note).
4. L'app ne doit pas exiger `appsecret_proof` (App Dashboard → Paramètres → Avancé → « Exiger la clé secrète » désactivé), le dashboard n'envoie que le jeton en en-tête `Authorization: Bearer`.

### 2. Variables d'environnement Vercel

| Variable | Rôle | Défaut |
|---|---|---|
| `META_ACCESS_TOKEN` | jeton système `ads_read` (**obligatoire** ; sans lui la P3 affiche 0 € + une note explicite) | — |
| `META_AD_ACCOUNTS` | comptes publicitaires, séparés par des virgules (avec ou sans `act_`) | `3220696111443286,854328590746337` |
| `P3_META_SINCE` | début de la fenêtre de dépense (AAAA-MM-JJ) ; la fin est toujours aujourd'hui (Europe/Paris) | `2026-08-01` |
| `P3_META_MATCH` | règle de périmètre sur le nom de campagne (texte, ou `/regex/`) | `Septembre 2026` |
| `P3_META_INCLUDE_IDS` | ids de campagnes forcés dans le périmètre même si le nom ne matche pas | vide |
| `P3_META_ALIASES` | JSON `{ "nom de campagne Meta": "valeur utm_campaign" }` quand l'UTM diffère du nom | `{}` |
| `P3_LIVE_DATE` | date du live affichée sur la carte Inscrits | `à venir` |
| `META_API_VERSION` | version Graph API | `v25.0` |

Redéployer après ajout (les variables sont lues au démarrage de la fonction).

### 3. Vérifier

Test direct du jeton (remplacer `$META_ACCESS_TOKEN`) :

```
curl -s "https://graph.facebook.com/v25.0/act_3220696111443286/insights?level=campaign&fields=campaign_name,spend&time_range=%7B%22since%22%3A%222026-08-01%22%2C%22until%22%3A%222026-09-30%22%7D" -H "Authorization: Bearer $META_ACCESS_TOKEN"
```

Puis Acquisition → PROMO 3 : la note sous le tableau « Campagnes Meta » commence par « Live Meta API · 2 compte(s) ». Comportements prévus :

- un compte indisponible avec une lecture précédente réussie : sa dépense reste figée (note « dernière valeur connue ») ;
- un compte indisponible sans lecture précédente : « ⚠ DÉPENSE PARTIELLE », CPL / ROAS / CAC masqués pour ne pas afficher des ratios faux ;
- UTM `utm_campaign` = nom de campagne encodé **ou** id numérique de campagne (`{{campaign.id}}`), les deux sont rattachés ; les valeurs vides ou `{{campaign.name}}` non résolu sont comptées en « UTM cassé ».

Auto-test hors ligne (fetch simulé) : `node p3-selftest.js` depuis le dossier parent contenant ce dépôt (voir le script pour les modes).
