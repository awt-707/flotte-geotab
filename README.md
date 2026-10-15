# Flotte Geotab

Supervision de la flotte au Maroc (base Geotab « clicar ») : véhicules en direct, journées de travail par contrat, classement des chauffeurs, alertes (vitesse, ralenti, siphonage, boîtier coupé…), agences, alertes par e-mail en temps réel, rapports PDF.

Aucun Google Sheet n'est nécessaire au fonctionnement : véhicules, chauffeurs, contrats et agences se gèrent sur le site. L'ancien Sheet v6 et le Sheet « ETAT PARC » ne sont lus qu'une fois, au premier lancement, pour reprendre l'historique et la liste du parc.

Site : https://flotte-geotab-clicar.netlify.app

## Comment ça marche

```
Geotab ──► Collecteur (Google Apps Script, toutes les 5 min) ──► Base Supabase ──► Site (Netlify)
                         ▲                                          ▲
                         └── nouvelle version testée (releases) ────┘── contrats, véhicules, chauffeurs, agences, réglages
```

## Ce que fait le site

| Page | Rôle |
|---|---|
| En direct, Tableau de bord, Du jour, Classement, Alertes | Suivi Geotab croisé avec les contrats. Une nouvelle alerte s'affiche en bandeau dès son calcul (et en notification du navigateur si la page est en arrière-plan). |
| Chauffeurs | Fiches : ceux des contrats sont ajoutés seuls ; ajout à la main ou import Excel (code client, nom, téléphone, e-mail, agence). |
| Véhicules | Liste du parc : ajout à la main ou import Excel (immatriculation, marque, modèle, VIN, carburant, agence). Remplace le Sheet ETAT PARC. |
| Contrats, Plaques | Import de l'extract des contrats ; changements de plaque WW / W18 → définitive. |
| Rapports | Rapport de la période et de l'agence choisies, téléchargeable en PDF. |
| Agences (admin) | Création des agences et accès des utilisateurs : chacun ne voit que les véhicules (et leurs trajets, contrats, alertes, chauffeurs) de ses agences ; l'admin voit tout. |
| Réglages (admin) | Utilisateurs, destinataires des alertes par e-mail (agence, gravité, types), rapports PDF automatiques (jour / semaine / mois, par agence), paramètres. |

Le collecteur envoie les e-mails (alertes et rapports PDF) avec le compte Google du projet Apps Script.

| Dossier | Contenu |
|---|---|
| `collector/src/` | Collecteur Apps Script. `15_engine.gs` = moteur de calcul du Google Sheet v6, repris à l'identique. |
| `supabase/migrations/` | Structure de la base (tables, droits, fonctions). Un fichier par changement, jamais modifié après coup. |
| `site/report.js` | Calcul et mise en page du rapport, partagé : PDF du site et PDF envoyé par le collecteur (publié avec lui sous le nom `60_report`). |
| `site/` | Site web statique (HTML, CSS, JS, sans étape de construction). |
| `tests/` | Tests automatiques sur les vraies données Geotab (26/09 au 06/10/2026, contrats anonymisés). |
| `tests/reference/` | Le Google Sheet v6 d'origine : chaque résultat du collecteur est comparé ligne à ligne avec lui. |

## Ce que vérifient les tests (à chaque modification)

- Trajets, événements, carburant, ralentis, jauge, journal et alertes **identiques au Google Sheet v6**.
- Temps réel : trajets présents le soir même, finalisés le lendemain midi sans changer.
- Reprise complète de l'historique de l'ancien Google Sheet.
- Import des contrats depuis le site identique à l'injection du Sheet.
- Toutes les pages du site, sur ordinateur et sur téléphone, sans erreur ; compte en attente sans accès aux données.
- Agences : un gestionnaire ne voit et ne modifie que les données de ses agences (droits de la base).
- Véhicules et chauffeurs injectés depuis le site (Excel et saisie), rapport PDF téléchargé, bandeau d'alerte en temps réel.
- Alertes par e-mail : bons destinataires (agence, gravité, type), jamais deux fois, historique non envoyé. Rapports planifiés : une fois par période, après finalisation, PDF de la bonne agence.
- Arrêts moteur tournant (3 min et plus) : contrôlés sur les données brutes Geotab ; litres = vraie différence du compteur ralenti, sinon « non mesuré ».
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

## Installation du collecteur (chargeur, une seule fois)

Projet Apps Script « Flotte Geotab - Collecteur » sous a.atmani@clicar.fr (https://script.google.com/d/1Ou0GfD8tiaWGYpM3ywzSz4IR-khIwKuWBq-n0sgj7pEt32uAQbWrndJ3/edit) :

1. Fichier `Code.gs` : remplacer tout son contenu par `collector/loader/Code.gs` (chargeur, environ 60 lignes, ne change plus).
2. Paramètres du projet > cocher « Afficher le fichier manifeste appsscript.json » ; remplacer son contenu par `collector/src/appsscript.json`.
3. Propriétés du script : `GEO_USER`, `GEO_PWD`, `SUPABASE_KEY` (service_role).
4. Exécuter `installer` et accepter les autorisations.

Ensuite, chaque version qui passe les tests sur `main` est chargée automatiquement au passage suivant (5 min). Aucune API Google à activer. Fonctions utiles : `testConnexions`, `collecterMaintenant`, `arreter`.
