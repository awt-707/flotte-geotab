# CLAUDE.md : contexte du projet pour Claude Code

Répondre à Ahmed **en français**, de façon courte et directe. Il veut des données fiables : **rien d'inventé ni d'estimé** ; « non mesuré » quand Geotab ne fournit pas la valeur.

## Le projet

Supervision de la flotte au Maroc (Hyundai Staria / Sonata, chauffeurs sous contrat, base Geotab « clicar »). Remplace l'ancien Google Sheet v6 (Apps Script) par :

```
Geotab ──► Collecteur Apps Script (toutes les 5 min) ──► Supabase (Postgres) ──► Site statique Netlify
```

- **Plus aucune dépendance aux Google Sheets** (demande d'Ahmed, 15/10/2026) : contrats, véhicules (table `parc`), chauffeurs et agences se gèrent sur le site. Le Sheet ETAT PARC n'est lu qu'une fois (`seedParcFromSheet_`) si `parc` est vide ; l'ancien Sheet v6 une fois (reprise de l'historique). Le collecteur reste sur Apps Script (choix d'Ahmed : gratuit, pas de limite de calcul).
- Contrats injectés depuis le site (extract .xlsx, fonction `import_contracts`) → tout se recalcule seul (chauffeurs, journal, alertes).
- Agences : `agencies`, `user_agencies` ; agence du véhicule (`vehicles.agency_id`, reprise du `parc` par déclencheur). Droits de lecture par agence dans la base (`my_vehicle_keys()`), admin = tout. Un gestionnaire / lecture seule sans agence ne voit rien.
- Alertes en temps réel : bandeau sur le site (Supabase Realtime sur `alerts`) + e-mails (`alert_recipients`, `notifyAlerts_`, une seule fois par alerte via `notified_at`, historique jamais envoyé).
- Rapports PDF : `site/report.js` (partagé site / collecteur). Site : jsPDF + AutoTable. Collecteur : HTML → PDF Apps Script, envoi planifié (`report_schedules`, `reportsStep_`) après `reportHour` (13 h) et finalisation.
- Changement de plaque (WW / W18 provisoire → définitive) : l'historique reste rattaché au véhicule (`plate_changes`, `rekey_vehicle`).
- Moteur de calcul = celui du Sheet v6, **repris à l'identique** (`collector/src/15_engine.gs`). Les tests le comparent ligne à ligne au v6 (`tests/reference/Code_v6.gs`). Ne pas modifier le moteur sans mettre à jour la référence et les tests.

## Identifiants (aucun secret ici)

| Élément | Valeur |
|---|---|
| Dépôt | github.com/awt-707/flotte-geotab (privé), branche `main` |
| Supabase | projet **flotte_luxury**, ref `cgiiwumbblimvmrypxlc`, https://cgiiwumbblimvmrypxlc.supabase.co (orga LUXURY-DISCOVERY) |
| Netlify | site `flotte-geotab-clicar`, Site ID `00645516-06e7-4f1a-b209-7a9065244464`, https://flotte-geotab-clicar.netlify.app (équipe a-atmani) |
| Apps Script | « Flotte Geotab - Collecteur », script ID `1Ou0GfD8tiaWGYpM3ywzSz4IR-khIwKuWBq-n0sgj7pEt32uAQbWrndJ3`, compte a.atmani@clicar.fr |
| Ancien Google Sheet v6 | `1VxAV7P5SlaeSIZRC_EAQKjl3CFICQS4idJre4YLif1k` (historique repris automatiquement au 1er lancement) |
| Sheet Parc (« ETAT PARC ») | lu chaque jour par `importVehicles` (ID dans les paramètres) |
| Ancien projet Supabase « flotte-geotab » | « Unhealthy », abandonné ; ne pas l'utiliser |

Secrets (jamais dans le dépôt, jamais demandés en clair) : `GEO_USER`, `GEO_PWD`, `SUPABASE_KEY` dans les propriétés du script Apps Script ; `NETLIFY_AUTH_TOKEN`, `SUPABASE_SERVICE_KEY` dans les secrets GitHub Actions. La clé du site (`site/config.js`) est la clé **anon** publique ; `npm run check` refuse toute autre clé.

## Structure

- `collector/src/*.gs` + `appsscript.json` : collecteur. `npm run build` → `collector/dist/Collecteur.gs` (un seul fichier, pour tests et copie manuelle). Ordre de chargement dans `collector/build.js`.
  - `10_db.gs` : accès Supabase (PostgREST). `20_ref.gs` : référentiels, parc. `30_run.gs` : `collect()` toutes les 5 min, demandes du site (table `jobs`), tâches du jour. `40_install.gs` : `installer`, reprise de l'ancien Sheet. `45_update.gs` : mise à jour automatique depuis la table `releases`. `50_notify.gs` : alertes par e-mail, rapports planifiés. `site/report.js` est ajouté au collecteur (`60_report`) par `build.js` et `publish-collector.js`.
- `supabase/migrations/` : un fichier par changement, **ne jamais modifier un fichier déjà appliqué** ; en ajouter un nouveau, puis l'exécuter dans Supabase > SQL Editor.
- `site/` : HTML/CSS/JS sans build. Bibliothèques CDN aux versions épinglées dans `package.json` (vérifié par `npm run check`). En-têtes de sécurité / CSP dans `site/_headers` (appliqués aussi en test).
- `tests/` : `node --test`, base Postgres + PostgREST (`tests/setup_db.sh`), faux Geotab rejouant les vraies réponses (fixture compressée), faux Google Sheets, Playwright pour le site. Contrats de test **anonymisés**.

## Commandes

```bash
npm ci && npx playwright install chromium
bash tests/setup_db.sh          # base de test neuve + PostgREST :3001 (variables PG_ADMIN_URL, PG_URL, PGRST_DB_URI, POSTGREST_BIN)
npm test                        # build + contrôles + tous les tests (~5 min)
```

Après une nouvelle migration, relancer `tests/setup_db.sh` (sinon PostgREST ne voit pas la nouvelle table : 404).

## Mise en ligne

`.github/workflows/ci.yml` : tests à chaque push ; sur `main` et **seulement si tout passe** :
1. site publié sur Netlify (API zip, secret `NETLIFY_AUTH_TOKEN`) ;
2. collecteur publié dans `releases` (`scripts/publish-collector.js`, secret `SUPABASE_SERVICE_KEY`). Au passage suivant, le collecteur remplace son propre code via l'API Apps Script (à activer une fois sur script.google.com/home/usersettings). `AUTO_UPDATE=NON` dans les propriétés du script désactive la mise à jour.

## État au 15/10/2026

Fait :
- Base flotte_luxury : schéma complet + table `releases` appliqués.
- Site en ligne (ancienne version visuelle) ; la nouvelle version du dépôt sera publiée par la CI.
- Projet Apps Script : code = build du dépôt (`dist/Collecteur.gs`, un fichier `Code.gs`) + manifeste avec les scopes (dont `script.projects`). Fuseau Africa/Casablanca.
- 41 tests verts en local.

Ajouté le 15/10/2026 (branche `claude/sweet-albattani-9xcpvl`, à fusionner dans `main`) : agences, parc et chauffeurs gérés sur le site, alertes par e-mail et en temps réel, rapports PDF. **Migration `20261016000000_agences.sql` à exécuter dans Supabase > SQL Editor** (après `20261015…`).

Reste à faire (par Ahmed, secrets et autorisations) :
0. Supabase > SQL Editor : exécuter `supabase/migrations/20261016000000_agences.sql`.
1. Apps Script > Paramètres du projet > Propriétés du script : `GEO_USER`, `GEO_PWD`, `SUPABASE_KEY` (service_role de flotte_luxury : Project Settings > API Keys > Legacy).
2. Exécuter `installer` dans l'éditeur, accepter les autorisations.
3. Activer « API Google Apps Script » : script.google.com/home/usersettings.
4. Secrets GitHub (Settings > Secrets and variables > Actions) : `NETLIFY_AUTH_TOKEN` (Netlify > User settings > Applications > Personal access tokens) et `SUPABASE_SERVICE_KEY`.
5. Créer son compte sur le site : le **premier compte créé devient administrateur**, les suivants attendent sa validation (Réglages).
6. Une fois le nouveau collecteur installé (Journal : « collecteur mis à jour »), exécuter `installer` encore une fois pour accepter l'envoi d'e-mails.
7. Sur le site : créer les agences, rattacher véhicules et utilisateurs (page Agences), choisir les destinataires des alertes et des rapports (Réglages).

Ensuite (Claude) :
- Vérifier la CI verte et le déploiement (site + `releases`) ; vérifier dans le Journal technique du site que la reprise de l'ancien Sheet se termine (« TERMINÉE »).
- Une fois la reprise terminée : **arrêter les déclencheurs de l'ancien Google Sheet** (sinon double appel Geotab).
- Contrôler les pages du site avec les vraies données.

## Pièges connus

- **Heure du Maroc** : le Maroc est repassé à GMT (UTC+0) le 20/09/2026. Tout le code passe par le fuseau `Africa/Casablanca` (jamais de décalage écrit en dur) ; les résultats dépendent donc de la version des fuseaux installée (Node récent / Google = UTC+0). Le projet Apps Script doit rester en fuseau Africa/Casablanca. Les tests forcent `TZ=Africa/Casablanca`.

- Copier du code dans l'éditeur Apps Script via le navigateur : l'outil JavaScript décode les `\uXXXX` ; reconstruire les échappements avec `String.fromCharCode(92)` et vérifier le hash SHA-256 du contenu final.
- PostgREST renvoie 1 000 lignes max par requête : toujours paginer (`dbSelect_`, `all()` côté site).
- Les dates du Sheet arrivent en numéros de série dans le fuseau du classeur (`serialToDate_`).
- Le Supabase de test est émulé (`tests/lib/supabase_prelude.sql`) : rôles anon / authenticated / service_role, `auth.uid()` depuis le JWT.
