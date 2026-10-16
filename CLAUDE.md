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
2. collecteur publié dans `releases` (`scripts/publish-collector.js`, secret `SUPABASE_SERVICE_KEY`).

**Chargeur (depuis le 15/10/2026)** : le projet Apps Script ne contient que `collector/loader/Code.gs` (+ `collector/src/appsscript.json`). À chaque exécution il charge la dernière version de `releases` et l'exécute (`new Function`), sans API Google : le projet Google Cloud lié au script est un projet caché, Ahmed ne peut pas y activer d'API (erreur `resourcemanager.projects.get`). L'ancienne mise à jour par l'API Apps Script (`45_update.gs`) est ignorée en mode chargeur. La reprise de l'ancien Sheet lit le classeur par SpreadsheetApp si l'API Sheets répond 403 (`sheetValuesApp_`).

## État au 15/10/2026

Fait :
- Base flotte_luxury : schéma complet + table `releases` appliqués.
- Site en ligne et à jour (CI verte, secrets GitHub en place, publication automatique).
- 15/10 soir : collecte bloquée en production (reprise de l'ancien Sheet en échec : API Sheets désactivée dans le projet caché). Corrigé dans le code ; il faut coller le chargeur dans Apps Script (voir README) puis exécuter `installer`.
- Projet Apps Script : code = build du dépôt (`dist/Collecteur.gs`, un fichier `Code.gs`) + manifeste avec les scopes (dont `script.projects`). Fuseau Africa/Casablanca.
- 41 tests verts en local.

Ajouté le 15/10/2026 (branche `claude/sweet-albattani-9xcpvl`, à fusionner dans `main`) : agences, parc et chauffeurs gérés sur le site, alertes par e-mail et en temps réel, rapports PDF. **Migration `20261016000000_agences.sql` à exécuter dans Supabase > SQL Editor** (après `20261015…`).

Ajouté le 16/10/2026 : page **Arrêts moteur** (chaque arrêt moteur tournant ≥ `engStopMin` = 3 min, table `engine_stops`, calcul `collector/src/17_stops.gs` à côté du moteur v6 qui reste inchangé). Litres = compteur Geotab `DiagnosticDeviceTotalIdleFuelId` relevé avant/après l'arrêt (≤ 1 min d'autre ralenti entre les relevés), sinon « non mesuré » ; le site affiche alors le ralenti réel du trajet entier. Ceinture conducteur `DiagnosticDriverSeatbeltId` (0 bouclée, 1 débouclée ; transmise par les Staria, pas par les Sonata). Frein à main (`DiagnosticParkingBrakeId`) toujours 0 sur la flotte, présence passager et clim non transmises : non utilisés. **Migration `20261017000000_arrets_moteur.sql` à exécuter dans Supabase > SQL Editor.** Constat sur les données réelles : le compteur ralenti est surtout relevé au contact mis / coupé, donc peu d'arrêts en cours de trajet ont des litres mesurés (1 sur 13 dans le jeu de test).

Ajouté le 16/10/2026 : **temps réel Geotab** sur la page En direct. Fonction Supabase `geotab-live` (`supabase/functions/geotab-live/live.mjs`, sans dépendance, testée sous Node) : DeviceStatusInfo + dernier contact (StatusData from = to = maintenant) de toute la flotte en un appel, réponse gardée 2 s, session Geotab en mémoire + table `geotab_session` (migration `20261018000000_relais_direct.sql`). Véhicules lus avec le jeton de l'utilisateur (droits par agence). Le site l'interroge toutes les 5 s tant que la page est visible, les marqueurs glissent vers la nouvelle position ; si la fonction répond mal, message + positions du collecteur, nouvel essai 1 min plus tard. Secrets de la fonction (Supabase > Edge Functions > Secrets) : `GEO_USER`, `GEO_PWD`. Publication par la CI avec le secret GitHub `SUPABASE_ACCESS_TOKEN`. Quota gratuit Supabase : 500 000 appels de fonctions par mois (≈ 216 000 pour une page ouverte 10 h/jour).
Heure du Maroc (corrigé le 16/10) : l'heure réelle d'Ahmed est **UTC+1** (UTC+0 pendant le Ramadan), alors que la table des fuseaux de Google met le Maroc à UTC+0 depuis le 20/09/2026. Le collecteur utilise la table `MA_TZ` (`05_constants.gs`, fuseaux 2025b) pour tous ses calculs d'heure (`tzOffsetMin_`, `fmtMa_`), la publie dans le param `tzRules` et le site l'applique (`setTzRules`). Une fois (`tzFix_`, propriété `TZ_FIX`) : journées depuis le 20/09/2026 retéléchargées et recalculées. Les harnais de test utilisent la même table pour « Africa/Casablanca ».

Ajouté le 16/10/2026 (nuit) :
- Page **Consommation** (`pageConso`, `rptConso` dans `site/report.js`) : carburant entre deux instants (à la minute, heure du Maroc), toute la flotte / un véhicule / une agence, mêmes règles que `fuelPeriod` du v6 (trajet compté s'il démarre dans la période), par véhicule, chauffeur, jour, pleins, siphonages, trajets non enregistrés, part non mesurée, journées pas encore téléchargées ; PDF. Les rapports planifiés joignent aussi le rapport de consommation (`buildConso_`).
- Relecture complète (collecteur, site, base / relais) et corrections : droits par agence (migration **`20261019000000_securite.sql`**), import de contrats d'un gestionnaire limité à ses véhicules, contrats longs encore en cours, rapports renvoyés après échec et jamais avant finalisation, alertes e-mail non perdues sans autorisation d'envoi, pagination stable du site (`all()` trie toujours sur la clé), `rpcAll`, dates ISO, URL trop longues (`writeTable_`, `writeLive_`), table horaire republiée (`TZ_PUB`).
- Non corrigé (noté) : file `SYNC_QUEUE` dans une seule propriété (limite 9 Ko, ~220 véhicule-jours : suffisant pour 8 véhicules) ; contrats repris de l'ancien Sheet après le 20/09 lus en UTC+0 (réinjecter l'extract depuis le site corrige) ; CLI Supabase non épinglée dans la CI.

Ajouté le 16/10/2026 (jour) : **chauffeurs séparés en shift jour / shift nuit partout** (demande d'Ahmed) : site (`shiftOf`, `shiftName` dans `lib.js` ; `shiftSections`, `contractShifts`, `alertShift` dans `app.js`) et rapports PDF (`rptShift`, `rptSplit` dans `report.js` ; le collecteur passe `hmOf: localHM_` et `ctrShift`). Shift = heure de début du contrat, début de shift le plus proche (`shiftDay` 7 h, `shiftNight` 19 h) ; sans contrat : « Hors contrat ». `driver_rule_counts` renvoie aussi `contract_num` (migration `20261020000000_shifts.sql`, exécutée le 16/10). Test : `tests/shift.test.js`.

Corrigé le 16/10/2026 (soir) : **shift des alertes** (signalé par Ahmed : alerte de 14:06 marquée « Nuit »). Shift d'une alerte = celui du contrat en cours sur le véhicule à son heure (`alertShifts`, app.js), sinon le créneau horaire (`shiftAt`, lib.js : jour shiftDay → shiftNight, sinon nuit) ; **une nuit appartient au jour où elle commence** (02:30 le 17/10 = nuit du 16/10 → 17/10, `shiftDayName`). Alertes du tableau de bord et de la page Journée regroupées par shift daté ; page Journée du J = shift jour du J + shift nuit du J au J+1 (contrats, arrêts prolongés, alertes). Test : `tests/shift.test.js`, `tests/site.test.js`.

Corrigé le 16/10/2026 (après-midi) : **pleins de la nuit non détectés** (signalé par Ahmed : pleins du 16/10 vers 02:30 et 05:15). Les pleins viennent des FillUp Geotab, calculés par Geotab après coup ; la collecte en direct ne relit que 3 h en arrière (`LIVE_EVBACK`), donc un FillUp publié plus tard n'apparaissait qu'à la finalisation (lendemain ~13 h). `collector/src/18_fills.gs` (`liveFills_`, à côté du moteur v6) relit à chaque passage les FillUp d'hier et d'aujourd'hui (journées non finalisées), lignes provisoires identiques à la finalisation. Test : `tests/pleins.test.js` (faux Geotab : FillUp visibles 6 h après le plein, `__FILL_DELAY_MS`).

Refait le 16/10/2026 (soir) : **page En direct** (`site/direct.js`, sorti de `app.js`). Carte avec marqueurs (couleur = état, flèche = sens de la marche, plaque + vitesse) et trace depuis l'ouverture de la page ; liste des véhicules à droite (clic = carte centrée) ; alertes en cartes cliquables → **fiche de l'alerte** (`openAlertDetail`, aussi bouton « Détail » de la page Alertes) : relais `?mode=detail` = vitesse du capteur (`DiagnosticEngineRoadSpeedId`), positions GPS, limite de la route (`GetRoadMaxSpeeds`) et événements Geotab de 3 min avant à 3 min après, courbe SVG + carte. **Chauffeurs en ce moment** sans attendre la fin du trajet : relais `?mode=drivers` (toutes les 30 s) = compteurs du véhicule (odomètre, carburant total, carburant au ralenti) au début du contrat et maintenant, trajets Geotab (conduite, ralenti, Vmax) + vitesse du trajet en cours, événements depuis le début du contrat ; repli sur les totaux du collecteur si le relais répond mal. La carte MyGeotab elle-même ne peut pas être intégrée (connexion Geotab dans le navigateur, page interdite en cadre) : la carte du site affiche les mêmes positions Geotab, lues toutes les 5 s. Tests : `tests/relais.test.js`, `tests/site.test.js`.
Piste notée : Ahmed a trouvé le modèle Power BI « Geotab Data Connector – Driver Safety Benchmarking » (tables `DriverSafety_Daily`, `FleetSafety_Daily`, `VehicleKpi_Daily` : collisions prévues / 1 M km, centiles vitesse, ceinture, freinage, accélération, virages, distance de sécurité, comparaison aux flottes similaires). Données quotidiennes calculées par Geotab, via le Data Connector (OData) s'il est activé sur la base clicar : à intégrer éventuellement dans Classement / rapports, pas en temps réel.

Ajouté le 16/10/2026 (soir) :
- **Marque Ludy** (demande d'Ahmed) : logo `site/logo-ludy.png` (crème, barre latérale sombre), `site/logo-ludy-sombre.png` (fonds clairs : connexion), `site/favicon.png`, `RPT_LOGO` (report.js, en-tête des PDF du site et du collecteur). Titre « Ludy · Supervision de flotte », e-mails « Ludy : … » (expéditeur Ludy). Dépôt, base, dossiers Drive : noms techniques inchangés.
- **Comportement chauffeur** (`pageComportement`, pages2.js ; menu « Comportement chauffeur », lien depuis la fiche chauffeur) : profil + historique entre deux dates (journées, vitesse, événements par règle et détail, consommation par véhicule, pleins, siphonages, ralenti prolongé, arrêts moteur tournant, alertes, score et rang). Calcul partagé `rptDriver` (report.js) : même rapport sur le site, en PDF et par e-mail. Envoi par e-mail = demande `driver_report` (arg JSON code/from/to/email) traitée par le collecteur (`jobDriverReport_`, `buildDriver_` dans 50_notify.gs, MailApp avec le PDF). Gestionnaire : **migration `20261021000000_comportement.sql`** (seulement ses chauffeurs) ; l'administrateur n'en a pas besoin.
- **PDF des pages Conduite et Classement** (`colsTable` + `rptSimple`, tableaux par shift).

Ajouté le 16/10/2026 (soir) : **seuil d'alerte de dépassement par limite de route** (Réglages > « Alerte de dépassement de vitesse » : seuil par limite 20…120 km/h, seuil général `overAlert`, Vmax `vmaxAlert`). Param `overByLimit` (« 50:30;80:20 » ; limite non listée = limite inférieure la plus proche, sinon seuil général ; vide = règle du v6 à l'identique). Le collecteur garde pour chaque trajet le plus gros dépassement mesuré sur chaque limite (`trips.over_by_limit`, `cOverByLimit_` dans `collector/src/19_speed.gs`, mêmes relevés que le pire dépassement du v6) : les alertes « Dépassement limite » (`overAlertOf_`) se recalculent avec les seuils sans retélécharger. Règle partagée `rptOverTol` / `rptOverWorst` / `rptOverHit` (report.js) : alertes, Conduite, Comportement. En direct : le relais renvoie la limite de la route sous chaque véhicule en route (`GetRoadMaxSpeeds`, 3 dernières minutes, repli sans limite si Geotab refuse) et le site lève l'alerte à l'instant. **Migration `20261022000000_vitesse.sql`** (colonne + paramètre). Tests : `tests/vitesse.test.js`, `relais.test.js`, `site*.test.js`.

Reste à faire (par Ahmed, secrets et autorisations) :
0. Supabase > SQL Editor : exécuter `supabase/migrations/20261016000000_agences.sql` (fait), puis `20261017000000_arrets_moteur.sql`, `20261018000000_relais_direct.sql`, `20261019000000_securite.sql` et `20261020000000_shifts.sql` (tous faits, 16/10), puis `20261021000000_comportement.sql` (envoi par e-mail par un gestionnaire) et `20261022000000_vitesse.sql` (seuils de dépassement par limite).
0 bis. Relais en direct : secrets `GEO_USER` / `GEO_PWD` dans Supabase > Edge Functions > Secrets ; secret GitHub `SUPABASE_ACCESS_TOKEN`.
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

- **Heure du Maroc** : heure réelle = UTC+1 (UTC+0 pendant le Ramadan). Les tables de fuseaux récentes (Google, conteneur) disent UTC+0 depuis le 20/09/2026 : ne pas s'y fier, tout passe par `MA_TZ` (collecteur, tests) et `tzRules` (site). Le projet Apps Script doit rester en fuseau Africa/Casablanca. Les tests forcent `TZ=Africa/Casablanca` et leurs harnais appliquent `MA_TZ`.

- Copier du code dans l'éditeur Apps Script via le navigateur : l'outil JavaScript décode les `\uXXXX` ; reconstruire les échappements avec `String.fromCharCode(92)` et vérifier le hash SHA-256 du contenu final.
- PostgREST renvoie 1 000 lignes max par requête : toujours paginer (`dbSelect_`, `all()` côté site).
- Les dates du Sheet arrivent en numéros de série dans le fuseau du classeur (`serialToDate_`).
- Le Supabase de test est émulé (`tests/lib/supabase_prelude.sql`) : rôles anon / authenticated / service_role, `auth.uid()` depuis le JWT.
