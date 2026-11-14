# Base de données de Ludy

PostgreSQL (aujourd'hui Supabase, projet `flotte_luxury`). Ce dossier est la base **rangée et lisible** : un fichier par domaine, l'installation sur un serveur neuf, les outils de contrôle et la marche à suivre pour quitter Supabase (OVH).

## Deux sources, toujours identiques

| | Rôle | Qui l'écrit |
|---|---|---|
| `supabase/migrations/` | Historique : un fichier par changement, exécuté une fois en production (Supabase > SQL Editor). **Ne jamais modifier un fichier déjà appliqué.** | à la main |
| `database/schema/` + `database/liens_droits/` | État final de la base de Ludy, rangé par domaine. Sert à lire la base et à l'installer d'un coup sur un serveur neuf. | `node database/outils/schema.js build` |

Le test `tests/base.test.js` (`schema.js check`) construit une base depuis les migrations, une autre depuis `database/`, et vérifie que leurs catalogues sont identiques objet par objet : tables, colonnes, contraintes, index, fonctions, déclencheurs, règles RLS et droits.

**Pour changer la base :** ajouter une migration, l'exécuter en production, puis relancer `build` (avec `PG_DUMP` = chemin de `pg_dump`). Une nouvelle table ou fonction doit être rangée dans `outils/domaines.js` : sinon `build` la refuse.

## Domaines

| Fichier | Contenu |
|---|---|
| `00_socle` | Fonctions de droits utilisées par toutes les règles (`is_admin`, `my_role`, `my_vehicle_keys`, `rh_scope`, `plan_can_edit`…), paramètres, règles de score, demandes du site au collecteur, journal technique, versions du collecteur, compteurs d'usage, coffre des intégrations |
| `10_comptes_agences` | Profils et rôles, agences, rattachements, connexions, planning des gestionnaires, destinataires des alertes et des rapports |
| `20_flotte` | Véhicules, parc, changements de plaque, données Geotab (trajets, ralentis, arrêts moteur, événements, carburant, jauge), alertes, journal, position en direct, tickets Afriquia |
| `30_chauffeurs_contrats` | Contrats injectés depuis l'extract, chauffeurs qui en sont déduits |
| `40_courses_manifestes` | Courses privées et devis, grilles tarifaires par ville, manifestes, sociétés émettrices |
| `50_caisse` | Mouvements de caisse et leur historique, exports Uber et Bolt, fiches d'encaissement, justificatifs |
| `60_planning_chauffeurs` | Réglages, cases jour / nuit, absences, semaines publiées ou verrouillées |
| `70_rh` | Salariés, événements RH, pointage, dossiers, sociétés employeuses, contrats de travail |

Chaque domaine a deux fichiers :
- `schema/<nn>_<domaine>.sql` : la structure (fonctions, tables, clés, index, déclencheurs) ;
- `liens_droits/<nn>_<domaine>.sql` : les clés étrangères et les droits (RLS, règles, GRANT).

Les liens sont installés après la structure de **tous** les domaines, car ils relient les domaines entre eux : une règle de la caisse lit les agences, une clé du parc vise les sociétés…

## Autres dossiers

- `modules/bureau_raphael.sql` : application de bureau de Raphael. Ce sont 50 tables (`fleet_*`, `desktop_*`, `ops_*`, `telemetry_*`, portail chauffeurs…), 68 fonctions et 15 déclencheurs présents en production mais absents des migrations.
  - C'est une **copie exacte de la production**, à ne pas modifier : `node database/outils/production.js extraire`.
  - Elle ajoute aussi 3 colonnes à `vehicles` et des déclencheurs sur la caisse (`revenue_refresh`).
  - Elle remplace 3 fonctions de Ludy : `refresh_drivers`, `bump_usage`, `usage_stats`. Une migration de Ludy qui les redéfinit efface la version de Raphael (et inversement) : se coordonner avec lui avant d'y toucher.
- `plateforme/` : ce qui dépend de l'hébergeur.
  - `stockage.sql` : 8 seaux de fichiers et leurs règles (Supabase Storage).
  - `temps_reel.sql` : tables suivies en temps réel.
  - `roles_hors_supabase.sql` : rôles et `auth.uid()` à créer quand la base n'est pas un Supabase.
- `installer.sh` : installe la base complète dans une base vide (`DB_URL=… bash database/installer.sh [--hors-supabase]`). Elle a été vérifiée sur un PostgreSQL neuf : 103 tables, 139 fonctions.
- `outils/` :
  - `schema.js build|check` : rangement par domaine et contrôle d'égalité avec les migrations ;
  - `production.js ecarts` : production comparée au dépôt (lecture seule, jeton `SUPABASE_ACCESS_TOKEN`) ;
  - `production.js extraire` : réécrit le module de bureau et le stockage depuis la production ;
  - `catalogue.sql` : empreinte d'une base.
- `ovh/` : reprise des données (`transfert.sh`) et des fichiers (`copie_fichiers.js`). Voir `OVH.md`.

## Règles de la base (à respecter dans toute migration)

- **RLS sur toutes les tables.**
  - Le site lit et écrit avec le jeton de l'utilisateur (rôle `authenticated`).
  - Le collecteur et le relais utilisent la clé `service_role`, qui passe outre les règles.
  - `anon` (sans compte) n'a aucun droit : ni table, ni séquence, ni fonction de droits.
- **Droits explicites.** Après chaque `create table`, ajouter `revoke all … from anon` et ne redonner à `authenticated` que ce qui sert, colonne par colonne pour les mises à jour. Attention : `revoke update on <table>` retire aussi les droits colonne par colonne.
- **Fonctions de droits dans les règles** : toujours sous la forme `(select public.is_admin())`, pour qu'elles soient évaluées une fois par requête et non à chaque ligne (25 fois plus rapide sur la caisse).
- **Fonctions `security definer`** : toujours avec `set search_path = public`, en contrôlant l'appelant. Elles renvoient `false` (jamais `NULL`) quand un argument manque.
- **Heure du Maroc** : jamais `Africa/Casablanca` côté base (les tables de fuseaux récentes ont tort depuis le 20/09/2026) : voir `MA_TZ` dans le collecteur.
