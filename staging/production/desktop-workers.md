# Collecteurs sur les postes : contrat PostgreSQL

`desktop-workers.sql` prépare l’arbitrage partagé des collecteurs. Il ne déploie pas l’application, ne rejoue aucune migration métier et ne modifie pas `params.environment`. Le fichier est distinct du manifeste staging et n’a pas été appliqué durablement. La production existante doit d’abord recevoir les tables métier nécessaires et les variantes explicitement prévues pour la production des RPC qui vérifient aujourd’hui `environment = staging`.

Le poste conserve uniquement la clé publique Supabase et la session JWT de son administrateur. Le serveur réutilisé transmet ses opérations internes aux RPC ci-dessous ; il ne conserve aucune clé `service_role` de production. Les requêtes utilisateur ordinaires suivent les accès JWT/RLS existants. Les lectures privilégiées de suivi restent réservées à un administrateur authentifié et à un appareil enregistré lui appartenant.

## Appareil et bail

Un UUID aléatoire local identifie l’installation. Un appareil neuf est désactivé par défaut. L’administrateur l’approuve explicitement avec `p_enabled=true`. Un autre administrateur ne peut pas réutiliser cet UUID. Un manager ou viewer utilise les écrans ordinaires et ne peut ni enregistrer ni activer un collecteur.

| RPC | Arguments | Résultat |
| --- | --- | --- |
| `desktop_worker_register` | `p_device_id uuid`, `p_label text`, `p_enabled boolean=false` | État de l’appareil et du bail ; désactiver libère son bail |
| `desktop_worker_status` | `p_device_id uuid` | État, sans nom ni identité d’un autre propriétaire |
| `desktop_worker_claim` | `p_device_id uuid` | `owned:true` si acquis ; `owned:false` si un autre appareil est actif |
| `desktop_worker_renew` | `p_device_id uuid`, `p_fence bigint` | Même génération renouvelée ; erreur si expirée ou remplacée |
| `desktop_worker_release` | `p_device_id uuid`, `p_fence bigint` | `{version:1,released:true}` ; un ancien poste ne peut libérer son successeur |

L’état a cette forme :

```json
{"version":1,"device":{"id":"uuid","enabled":true,"owner":true},"lease":{"scope":"workspace","fence":1,"expires_at":"date ISO","owned":true}}
```

Le bail global dure 90 secondes selon l’horloge de PostgreSQL. Le poste le renouvelle toutes les 25 secondes. Toute acquisition après expiration ou libération augmente `fence`, y compris par le même appareil. Une réclamation du propriétaire encore actif conserve sa génération. `expires_at` vaut `null` lorsque le bail est libre.

Le runtime doit démarrer les collecteurs seulement après acquisition, cesser toute nouvelle collecte dès perte du bail/session, interrompre les appels en cours et libérer après fermeture. L’ownership du serveur local doit aussi empêcher deux processus utilisant le même UUID sur un PC. Le verrou PostgreSQL protège les écritures transactionnelles ; il ne peut annuler rétroactivement un appel déjà envoyé à un fournisseur.

## Transport des opérations internes

```text
desktop_worker_request(
  p_device_id uuid, p_fence bigint, p_resource text, p_method text,
  p_params jsonb = {}, p_body jsonb = null, p_prefer text = null
) -> {status, body, headers}
```

Les méthodes sont exactement `GET`, `POST`, `PATCH`, `DELETE`. Les valeurs de `p_params` sont des chaînes, ou des tableaux de chaînes pour les filtres répétés : `{"observed_at":["gte.2026-11-01T00:00:00Z","lte.2026-11-02T00:00:00Z"]}`. Cette distinction préserve les deux bornes de lecture des compteurs Geotab.

Le sous-ensemble pris en charge comprend `select`, `order`, `limit` (1–1000), `offset` (0–100000), `eq`, `neq`, `is.null`, `not.is.null`, `is.true`, `is.false`, `in` simple, `gt/gte/lt/lte` et les bornes simples `and`. Le seul chemin JSON autorisé est `observation->>metric`. Les sélections imbriquées, alias, SQL libre, opérateurs inconnus et ordres arbitraires sont refusés. `Prefer: count=exact` ajoute `headers["content-range"]` ; les préférences de retour et de résolution de doublons suivent les appels existants. Les corps sont bornés à 8 MiB, les insertions à 1000 lignes ; les RPC métier conservent leurs propres limites plus strictes.

Une lecture `GET` peut utiliser `p_fence=null`, même sur un appareil désactivé, pour afficher les métadonnées de suivi d’un poste secondaire. Chaque mutation, y compris un appel RPC, exige un appareil activé et la génération active. Le verrou partagé du bail et les verrous du profil/appareil sont conservés pendant l’opération. Une reprise ou révocation attend donc la transaction en cours. L’expiration est revérifiée après l’opération : son dépassement annule la transaction entière.

Les SQLSTATE sont `42501` (session, rôle, appareil ou droit refusé), `55000` (bail perdu/expiré), `22023` (ressource, argument ou opération non autorisée). Les validations métier et les casts typés peuvent également renvoyer leur propre erreur. Le transport ne doit pas transformer un refus d’autorisation en succès ni réessayer indéfiniment une mutation avec une ancienne génération.

## Périmètre figé

Les listes de tables, colonnes et clés de conflit figurent dans `read_columns`, `write_columns` et `conflict_columns`. Ajouter une colonne à une table ne l’expose pas automatiquement, y compris dans les réponses d’écriture.

Les mutations CRUD autorisées sont les observations/états de plateformes, les fiches provisoires et identités collectées, les alertes de suivi, les états Geotab partagés (`desktop_vehicle_live`), les associations automatiques gardées, les états de synchronisation, les notifications de conduite et les checkpoints carburant. La recherche d’un compte pour notifier lit uniquement son identifiant, code chauffeur et état actif. Aucun accès aux secrets, à Auth, aux profils, à `jobs`, ni aucune mutation de réglages administratifs n’est délégué. La lecture de `params` est limitée à `environment`, `shiftDay`, `shiftNight`, `shiftAdvance`, `tzRules`. Les réponses d’agences excluent les identifiants Drive/RH, et les réponses de chauffeurs excluent téléphone/email inutiles à la collecte.

Les 17 RPC métier sont appelées par leur nom et leur signature explicites : sauvegarde du mouvement, parkings, référence carburant mesurée, contrats/rotation/inventaire MyClicar, performances Bolt, déconnexions, snapshots financiers, rapprochements automatiques, rapports Uber, archive télémétrique et ingestion du catalogue d’événements. Aucun nom de fonction ni signature libre n’est exécuté. Les écritures financières passent uniquement par la RPC de validation existante, jamais par un insert direct dans les tables financières. Les JWT d’origine sont conservés ; aucun rôle ou marqueur d’environnement n’est fabriqué.

Les opérations administratives existantes (liaison manuelle, configuration des rapports, édition des zones, import manuel) requièrent leurs voies utilisateur dédiées. Elles ne sont pas rendues accessibles implicitement par ce transport de collecteurs. Un cycle du backend peut comprendre plusieurs transactions : la barrière protège chaque transaction, sans promettre une atomicité nouvelle de tout le cycle.

## Administration manuelle distincte

`desktop-admin.sql` s’installe après `desktop-workers.sql`. Sa RPC `desktop_admin_request(p_device_id uuid,p_resource text,p_method text,p_params jsonb={},p_body jsonb=null,p_prefer text=null)` retourne la même enveloppe. Elle exige la session administrateur et l’appareil possédé enregistré, y compris désactivé. Elle permet uniquement les règles de flotte et de consommation, références carburant manuelles, zones, événements manuels, imports CSV, liens manuels, configuration des rapports et gestion/modération des comptes chauffeurs. Les colonnes et sept RPC sont énumérées explicitement. Chaque `p_user`/`reviewed_by` doit correspondre à `auth.uid()`. Les dates de création/modération et référence manuelle sont fixées par PostgreSQL. Les lectures admin peuvent atteindre 2000 lignes pour les listes existantes.

Le transport choisit cette voie uniquement dans le contexte limité à la durée d’une requête HTTP administrateur autorisée et d’une ressource manuelle reconnue. Les callbacks collecteurs, tâches différées et requêtes fournisseur gardent la voie avec bail. Connexion, pause et association Geotab doivent être refusées par le runtime avant tout effet si le poste n’est pas actif. Le PATCH de mapping Geotab manuel vérifie aussi le bail actif dans SQL ; la suppression de l’ancien état et la pause restent des opérations collecteur avec génération.

La création de comptes et la rotation de leurs codes n’exposent aucun hash en réponse. Les sessions `dps_*`, le login chauffeur et les écritures d’un chauffeur ne sont pas autorisés par ces RPC. Le portail mobile nécessite son propre service d’authentification/hébergement.

`desktop-manager.sql` conserve les deux opérations existantes des gestionnaires : `ops_rush_rules` en POST/PATCH et `rpc/ops_import_demand`. La RPC `desktop_manager_request(p_resource,p_method,p_params,p_body,p_prefer)` exige un JWT manager/admin, sans appareil ni bail. Elle verrouille le profil et les appartenances d’agence, contrôle les agences d’origine et de destination d’une règle, et refuse toute agence extérieure au périmètre d’un gestionnaire. L’import valide l’enveloppe normalisée et affecte toutes ses lignes à l’agence du manifeste ; une ligne ne peut fournir son propre agency_id. La clé de conflit inclut l’agence. Les lectures restent des requêtes utilisateur RLS ordinaires. Ces droits ne permettent aucune opération administrateur ou collecteur.

## Validation locale

```sh
node staging/tests/desktop-workers.integration.mjs
node staging/tests/desktop-workers-concurrency.integration.mjs
node staging/tests/desktop-admin.integration.mjs
node staging/tests/desktop-manager.integration.mjs
```

Le premier test installe le SQL et ses données synthétiques dans une transaction locale gardée, puis annule le tout et vérifie l’absence d’installation et de fixtures. Il couvre rôles, ownership, lectures des postes secondaires, préférences, filtres, allowlists, RPC métier typées, maintien des JWT et gardes d’environnement, générations et expiration pendant une écriture.

Le second crée une base PostgreSQL jetable dans le conteneur local déjà identifié, sans toucher aux tables staging. Quatre connexions réclament simultanément le bail : une seule gagne. Une autre connexion attend le verrou de l’écriture en cours ; cette écriture est annulée à l’expiration avant la reprise. L’ancien propriétaire ne peut plus écrire. La base jetable est supprimée dans le bloc de nettoyage.

Le test admin est également entièrement annulé. Il vérifie notamment la liaison entre acteur et JWT, l’absence de hashes en lecture/retour, les versions des zones, la séparation des opérations collecteur et les refus des managers, sessions inconnues et appareils d’un autre propriétaire. Les tests SQL restent locaux et ne constituent pas une validation du schéma réel de production.

Le test manager vérifie les deux scopes lors d’un déplacement de règle, les révocations de rôle/appartenance, le refus des viewers, l’idempotence d’import et l’isolation de deux agences utilisant le même identifiant de course. Toutes ses écritures et la création de la RPC sont annulées.
