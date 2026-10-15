# Flotte Geotab

Supervision de la flotte au Maroc (base Geotab « clicar ») : véhicules en direct, journées de travail par contrat, classement des chauffeurs, alertes (vitesse, ralenti, siphonage, boîtier coupé…).

Site : https://flotte-geotab-clicar.netlify.app

## Comment ça marche

```
Geotab ──► Collecteur (Google Apps Script, toutes les 5 min) ──► Base Supabase ──► Site (Netlify)
                         ▲                                          ▲
                         └── nouvelle version testée (releases) ────┘── import des contrats, plaques, réglages
```

| Dossier | Contenu |
|---|---|
| `collector/src/` | Collecteur Apps Script. `15_engine.gs` = moteur de calcul du Google Sheet v6, repris à l'identique. |
| `supabase/migrations/` | Structure de la base (tables, droits, fonctions). Un fichier par changement, jamais modifié après coup. |
| `site/` | Site web statique (HTML, CSS, JS, sans étape de construction). |
| `tests/` | Tests automatiques sur les vraies données Geotab (26/09 au 06/10/2026, contrats anonymisés). |
| `tests/reference/` | Le Google Sheet v6 d'origine : chaque résultat du collecteur est comparé ligne à ligne avec lui. |

## Ce que vérifient les tests (à chaque modification)

- Trajets, événements, carburant, ralentis, jauge, journal et alertes **identiques au Google Sheet v6**.
- Temps réel : trajets présents le soir même, finalisés le lendemain midi sans changer.
- Reprise complète de l'historique de l'ancien Google Sheet.
- Import des contrats depuis le site identique à l'injection du Sheet.
- Toutes les pages du site, sur ordinateur et sur téléphone, sans erreur ; compte en attente sans accès aux données.
- Mise à jour automatique du collecteur.
- Aucune clé secrète dans le dépôt, clé publique du site = clé « anon ».

## Mise en ligne automatique

À chaque modification sur `main`, GitHub Actions lance les tests. **Seulement s'ils réussissent** :

1. le site est publié sur Netlify ;
2. le collecteur est publié dans la table `releases` ; Apps Script l'installe tout seul au passage suivant (5 min).

Secrets à créer une fois dans GitHub (Settings > Secrets and variables > Actions) :

| Secret | Où le trouver |
|---|---|
| `NETLIFY_AUTH_TOKEN` | Netlify > User settings > Applications > Personal access tokens > New access token |
| `SUPABASE_SERVICE_KEY` | Supabase (flotte_luxury) > Project Settings > API Keys > Legacy > `service_role` |

Et une fois dans Google : https://script.google.com/home/usersettings > « API Google Apps Script » = **Activé** (permet au collecteur de se mettre à jour).

## Changer la structure de la base

Ajouter un fichier `supabase/migrations/AAAAMMJJhhmmss_description.sql` (les tests l'appliquent sur une base neuve), puis l'exécuter dans Supabase > SQL Editor une fois les tests verts.

## Lancer les tests sur un ordinateur

```bash
npm ci
npx playwright install chromium
bash tests/setup_db.sh     # Postgres 16 + PostgREST requis (voir .github/workflows/ci.yml)
npm test
```

## Installation du collecteur (déjà faite)

Projet Apps Script « Flotte Geotab - Collecteur » sous a.atmani@clicar.fr. Propriétés du script : `GEO_USER`, `GEO_PWD`, `SUPABASE_KEY` (service_role). Fonction `installer` exécutée une fois. Fonctions utiles : `testConnexions`, `collecterMaintenant`, `arreter`.
