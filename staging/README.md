# Ludy — staging local

**Production :** le [guide de déploiement](production/README.md) décrit le site web avec sessions personnelles et le PC fixe qui centralise les connecteurs. Le serveur web utilise le Supabase existant et écoute sur un port distinct de l’application du PC. Les instructions ci-dessous restent celles du staging local ; la rubrique des applications 0.1.1 et du serveur séparé est historique.

Cette copie fonctionne avec son propre Supabase local : PostgreSQL, Auth, Storage et Realtime. Les fichiers de production restent dans les dossiers d'origine. Aucun projet Supabase cloud n'est nécessaire.

Prérequis : Node.js 20 ou plus, npm et Docker en fonctionnement. Le premier lancement télécharge les images officielles Supabase et peut prendre plusieurs minutes.

Depuis la racine du dépôt, installer les dépendances du staging (le dossier est autonome) :

```bash
cd staging
npm ci
npm start
```

Pour les lancements suivants, depuis la racine du dépôt :

```bash
npm --prefix staging start
```

Ouvrir **http://127.0.0.1:4173**. Les identifiants administrateur sont créés dans `.local/credentials.json` avec un mot de passe aléatoire. Ce compte appartient uniquement à l'Auth locale ; aucun email n'est envoyé à l'extérieur. Ne pas réutiliser un mot de passe de production.

| Service | Adresse |
|---|---|
| Application | http://127.0.0.1:4173 |
| API Supabase locale | http://127.0.0.1:57421 |
| PostgreSQL | 127.0.0.1:57422 |
| Supabase Studio | http://127.0.0.1:57423 |
| Courriels de test | http://127.0.0.1:57424 |

`Ctrl+C` arrête le serveur web. `npm run serve` le redémarre si Supabase fonctionne déjà. `npm run stop` arrête uniquement la pile Docker `ludy-staging` et conserve ses données. `npm run bootstrap` recrée la configuration locale et le compte administrateur si nécessaire, sans réinitialiser les données. `npm run check` vérifie la configuration avant démarrage.

Si le serveur web est déjà actif, `npm start` et `npm run serve` affichent son adresse puis rendent la main. L'instance existante continue de fonctionner, avec son suivi Bolt et ses associations Uber. Si un autre service occupe le port 4173, le lancement signale le conflit sans arrêter ce service.

Les journaux de démarrage, clés locales, identifiants et secrets de connecteurs restent dans `.local/`, ignoré par Git et jamais servi par le serveur web. Le serveur génère `/config.js` avec la clé publique de la base locale ; il refuse une URL de base différente. Le réseau Docker propre au staging limite les ports publiés à `127.0.0.1`.

Les migrations d'origine sont copiées dans `supabase/migrations/`, puis complétées par les migrations propres au staging. Sur une installation neuve, le seed contient deux agences, deux véhicules et deux chauffeurs explicitement fictifs. Dans cette installation, ces fiches de démonstration, restées intactes et inutilisées, ont été remplacées par la copie de référence du 30 octobre 2026 décrite ci-dessous. Aucun déplacement, statut Uber/Bolt ou course n'est inventé. Les intégrations restent déconnectées tant qu'une source autorisée n'a pas fourni d'observation.

Le collecteur Apps Script de production n'est pas lancé : aucun envoi d'alerte, rapport, copie Google Sheets/Drive ou reprise d'historique. Une première activation explicite dans Connecteurs autorise la reprise automatique de Bolt, Geotab ou MyClicar après redémarrage. Une pause manuelle reste enregistrée. Les statuts de plateforme et leurs alertes sont stockés dans les nouvelles tables `fleet_*`, séparément des alertes Geotab. Les réglages et accès aux connecteurs se font dans l'interface de staging.

## Chiffre d'affaires consolidé

Ouvrir **Finances → Chiffre d'affaires** (`#/chiffre-affaires`) avec un compte administrateur ou gestionnaire. Les filtres couvrent la journée, la semaine Uber, le mois, des dates libres, l'agence, le chauffeur et la source. La semaine Uber commence le **lundi à 04:00, heure du Maroc (`Africa/Casablanca`)**, et se termine le lundi suivant à 04:00 exclu. Les comparaisons portent sur le même temps écoulé de la période précédente lorsque les données et durées sont comparables.

Le tableau distingue revenus déclarés, **brut**, **net après commissions** et versements. Il présente aussi les commissions, pourboires, péages, primes, espèces, évolutions quotidiennes, répartitions par source et chauffeur, ainsi qu'un export CSV. Un montant absent reste indisponible : un versement n'est pas assimilé à un revenu net, ni le net à un bénéfice après toutes les charges. Les devises restent séparées ; les anciens imports sans devise certaine sont identifiés à part. Les écritures privées datées sans heure qui chevauchent une borne à 04:00 ou l'instant actuel sont affichées séparément des totaux précis.

Les sources financières sont les relevés Uber Fleet Earnings, les relevés importés Uber/Bolt et les courses privées enregistrées dans la caisse. Les observations de courses des API ne sont pas ajoutées une deuxième fois. Les rapports Uber automatiques d'activité, de courses et de qualité ne fournissent actuellement pas de montants financiers. InDrive n’est pas utilisé actuellement et reste hors du périmètre financier ; aucun zéro ni revenu n’est inventé pour cette plateforme.

**Lecture Uber Earnings** : le navigateur dédié peut aussi lire le tableau Earnings de la flotte configurée et parcourir ses pages. Lancer `npm --prefix staging run uber:reports-browser -- --earnings` pour conserver les rapports d'activité et ajouter cette lecture, ou `--earnings-only` pour la seule partie financière. La session est celle du profil privé existant ; une demande de connexion Uber doit être traitée normalement dans ce navigateur. Une seule instance utilise ce profil. La prochaine lecture Earnings commence au moins **cinq minutes après la fin** de la précédente, avec attente bornée du chargement et sans lectures simultanées. La semaine courante et la précédente sont sélectionnées dans le calendrier normal puis vérifiées exactement du lundi 04 h au lundi 04 h suivant. La semaine précédente complète est relue au démarrage, au changement de semaine puis chaque 24 heures. Une réponse 429 suspend la lecture et espace les tentatives de 15, 30 puis 60 minutes ; une modification de page invalide la lecture concernée.

Dans l'interface Uber observée, « Download report » renvoie à la liste Reports. Un export direct reste utilisable si une autre version de l'interface le fournit. Le collecteur lit normalement le DOM et observe les réponses déjà reçues par cette navigation pour confirmer les identifiants et les millisecondes des bornes. Aucun endpoint n'est rejoué et aucun jeton Uber n'est extrait. Une identité doit correspondre de manière unique à la ligne financière entière, dans la même flotte et la même fenêtre ; les autres lignes restent non rapprochées. Les catégories immédiates de l’accordéon `Total earnings` sont lues après dépliage, pour la flotte et depuis le tiroir de chaque chauffeur. Le calcul exige une liste exhaustive reconnue et l’égalité exacte au centime : **brut = Fare + Tip + Promotion**, **net après commissions = brut + Service Fee signée**, puis **revenus déclarés = net + Taxes signées**. Le net est donc présenté avant le poste `Taxes`, dont la nature fiscale n’est pas supposée. Une rubrique inconnue, une incohérence ou un détail absent interdit ce calcul ; aucune catégorie absente ne devient zéro sans preuve d’exhaustivité. Les preuves sont contrôlées par le normaliseur, la base et le lecteur de l’interface.

La caisse et le CA partagent les relevés Earnings enregistrés. Leurs fenêtres exactes, devise, date de lecture, couverture et rattachements sont conservés. Un relevé complet ne remplace les imports Uber dans les statistiques que lorsque le périmètre et les bornes correspondent exactement. Pour la semaine canonique en cours, le relevé couvre la fenêtre hebdomadaire entière avec sa propre date d’observation : il ne prétend pas être une capture exacte jusqu’à l’instant du chargement. Les écritures individuelles gardent leur véritable borne de lecture ; la comparaison à durée égale est désactivée. Une lecture antérieure à la clôture ne devient pas automatiquement un relevé définitif après cette clôture. Les jours, mois et dates libres gardent leurs règles de correspondance stricte. Les autres relevés restent affichés séparément : une fenêtre de règlement à 05:02 ne devient pas une semaine à 04:00, un cumul de période n'est pas réparti artificiellement par jour, et les lignes chauffeurs ne sont pas additionnées une seconde fois au total flotte. Les lignes sans identifiant fournisseur confirmé ne sont pas attribuées par simple ressemblance de nom.

Les soldes initial/final, les versements et le libellé fournisseur « Net earnings » sont distingués du revenu net après commissions. Ce dernier n'est renseigné que si sa définition est établie par la source ; un solde diminué des versements ne constitue pas cette preuve. Les espèces réellement remises dans Ludy et les rapprochements par shift restent fondés sur leurs écritures et preuves détaillées.

**Limite de l'API Bolt** : les deux spécifications officielles vérifiées le 3 novembre 2026 exposent l'historique des courses et leurs prix, sans endpoint de relevé financier, commissions ou encaissements réellement collectés. Le client signale cette capacité absente ; il ne remplace pas les relevés `bolt_sessions` par les prix des courses. Les prix API restent consultables dans Performance chauffeur. L’import du journal d’activité exige un total et des espèces explicites en MAD/DH : montant obligatoire absent ou malformé, devise incompatible et doublon contradictoire annulent le fichier. Les vrais zéros et les corrections signées sont conservés. Voir le [catalogue officiel](https://developer.bolt.eu/fleet-integration/main/) et la [spécification technique](https://apidocs.bolt.eu/fleetIntegration/fleetIntegrationGatewayV2Auth/open-api.json).

La page relit les données enregistrées toutes les 30 secondes lorsqu'elle est visible et à réception d'un signal Realtime. La migration locale `20261223000000_revenue_realtime.sql` publie uniquement un marqueur de modification par agence ; les montants restent lus via la session de l'utilisateur et les politiques d'accès des tables financières. Les imports, modifications et suppressions déclenchent ce signal. La date de lecture, la fraîcheur des sources et les couvertures inconnues ou incomplètes sont affichées. Cette actualisation ne transforme pas les imports fournisseurs en un flux de gains instantané.

La préparation du passage vers le Supabase et le GitHub existants est décrite dans [`production/README.md`](production/README.md). Aucun déploiement ni modification de la production n'est effectué par cette préparation ; `git add`, `git commit` et `git push` restent à faire par l'utilisateur.

Validation du tableau financier le 3 novembre 2026 : **1 032 tests de régression réussis**, dont les parcours navigateur du tableau, puis **26 contrôles de préparation**. Les **65 contrôles SQL financiers et Realtime** passent sur le staging local avec données synthétiques et `ROLLBACK`, après répétition puis application de la migration locale avec sauvegarde préalable. Ils couvrent les bornes du lundi 04:00, les droits par agence, les imports groupés, les transferts d'agence, les suppressions et les notifications sans contenu financier. Le script d'inventaire adapté au SQL Editor a aussi été vérifié localement : résultat JSON complet, transaction de lecture seule et nettoyage de la valeur de session temporaire.

La passe suivante, incluant les repères et la continuité, compte **1 202 tests réussis sur 1 202** (`.local/checks/provider-continuity-final-regression.log`). Les corrections finales de sélection des relevés, de lecture des composantes Uber et de présentation ont ensuite passé **109 tests ciblés**. Les migrations locales 25, 26 et 27 ont été appliquées avec sauvegarde préalable et validées par **123 contrôles SQL avec rollback** (36 archive, 49 relevés/sémantique, 38 sélection), dont un historique synthétique de 34 034 lignes.

La collecte réelle locale du 3 novembre 2026 a reçu deux semaines exactes : du 2 au 9 novembre, 34 lignes sur quatre pages, 31 UUID prouvés et 33 décompositions chauffeur vérifiées ; du 26 octobre au 2 novembre, 37 lignes, 34 UUID et 37 décompositions vérifiées. La flotte dispose dans les deux cas d’une preuve exacte permettant le brut et le net. Sur la semaine courante, un chauffeur affichait des revenus nuls sans détail : son brut/net reste inconnu. L’audit de rattachement confirme 23 lignes sur 34 ; huit UUID ne sont pas associés, dont deux références MyClicar sans agence, et trois lignes n’ont pas d’UUID prouvé. La semaine précédente compte 24 rattachements confirmés. Aucun nom ni agence n’est déduit pour compléter ces liens. La sélection en base charge seulement les fenêtres exactes et le dernier contexte utile ; les fenêtres chevauchantes ne sont jamais additionnées. Les migrations locales 28 et 29 sont appliquées et le validateur rejette les métadonnées de preuve malformées. Le contrôle authentifié du CA et de la Caisse à 17:33 UTC a confirmé les montants calculés, les bornes de semaine, l’absence de comparaison de la semaine ouverte, la séparation des flux de caisse et l’affichage mobile, sans erreur JavaScript ni écriture financière. Voir le [contrat financier détaillé](docs/finance-provider-contract.md) pour les définitions, les contrôles et les limites Bolt/inDrive.

**Rapprochements financiers** (`#/rapprochements-financiers`, administrateur) : la vue reprend les lignes non attribuées du relevé et montre leur UUID fournisseur prouvé. L’administrateur choisit explicitement une fiche Ludy, une agence et la référence d’une preuve vérifiée ; aucun choix n’est présélectionné. Une fiche sans agence exige une confirmation distincte pour lui attribuer l’agence. La confirmation revalide le rôle et la révision du relevé dans une seule transaction, refuse les associations contradictoires et consigne la preuve dans l’audit existant. Les montants historiques et les affectations de véhicules restent inchangés ; la collecte suivante applique le lien à ses nouveaux relevés. Pour les trois lignes dépourvues d’UUID prouvé, la vue indique la preuve fournisseur à obtenir, sans possibilité de confirmer un rapprochement sur le seul nom ou montant. La migration locale 31 est préparée avec 31 contrôles SQL en rollback et 9 tests client/interface ; son application locale suit la procédure de sauvegarde habituelle.

## Continuité Geotab / Texat

Geotab reste la source principale. Le moteur `server/telemetry-continuity.mjs` distingue la fraîcheur réseau, la qualité GPS, le kilométrage et le carburant ; le retour à la source principale demande une stabilité suffisante pour éviter les basculements répétés. Les observations et corrections restent identifiables par véhicule, appareil, source, heure de mesure et heure de réception. Un compteur conserve son propre horodatage, qui peut différer de l'heure de lecture de la page.

Les deltas d'odomètre et de carburant cumulé sont calculés uniquement entre mesures compatibles du même compteur et de la même source. Une remise à zéro, un saut incohérent ou une couverture incomplète reste signalé. Une distance calculée entre points GPS est une estimation ; un niveau de réservoir ne devient pas une quantité consommée. La réconciliation préfère une couverture Geotab fiable, conserve les preuves de secours et ne répartit pas proportionnellement un intervalle qui chevauche partiellement une période. Les sources ne sont jamais additionnées pour un même intervalle.

Le serveur local archive maintenant les mesures Geotab dans `telemetry_observations` par une RPC dédiée : doublons ignorés, corrections conservées comme versions concurrentes, aucune réécriture d'une observation reçue. L'agence à la réception et le rattachement actuel du véhicule sont distingués d'une affectation historique inconnue. Les traitements existants de carburant et de stationnement conservent leurs callbacks.

Le journal privé `.local/telemetry/pending.json` conserve les mesures en attente d'enregistrement, avec écritures atomiques et reprise au redémarrage. Il est borné à 20 000 mesures et 32 Mio ; après quatre reprises automatiques infructueuses, le lot reste sur disque et son état est signalé. Le statut administrateur Geotab expose uniquement les compteurs de fonctionnement de l'archive. La réconciliation reste une méthode serveur privée : aucun nouveau total n'est injecté dans la carte ou les statistiques tant que le raccordement des sources n'est pas terminé.

Le connecteur réel **Teksat / Minton** est vérifié sur le compte fourni et la filiale Maroc : huit véhicules correspondent sans ambiguïté par leurs anciennes plaques enregistrées. Le serveur conserve leurs positions brutes dans un journal privé, toutes les 60 secondes après la fin du cycle. Les associations sont revérifiées à chaque lecture ; aucune affectation historique n'est déduite d'une correspondance actuelle. La page **Connecteurs** présente l'état de la lecture et de l'archive.

L'historique Teksat conserve les heures source inchangées, avec heure de réception UTC, sans purge automatique. Rotation à 8 Mio, plafond de 512 Mio avec avertissement à 80 % et arrêt explicite avant saturation. Le fuseau des dates GPS, leur validité et les données kilométriques/carburant ne sont pas encore suffisamment établis : **le basculement normalisé n'est pas activé**. La présence d'un véhicule dans les deux systèmes ne prouve pas deux boîtiers physiques distincts. Voir [le contrat et les confirmations nécessaires](docs/texat-integration.md).

La prévisualisation privée `server/texat-normalization.mjs` est prête et reste non branchée au collecteur et à la carte. Elle exige un contrat documenté approuvé explicitement, lié au compte et aux preuves de collecte, ainsi que des affectations temporelles confirmées. Elle vérifie le secours GPS et le retour Geotab à travers le moteur existant, sans modifier le journal ni les totaux. **37 tests ciblés passent**, dont 10 nouveaux ; ils utilisent uniquement des fixtures synthétiques. Le code client Minton réécrit aussi `dateGps` lors d’événements contact/conducteur/mode privé : le champ qui date réellement les coordonnées, les décalages applicables au compte et les codes de qualité doivent donc être confirmés avant activation. Kilométrage et carburant restent exclus de cet adaptateur ; les 8 correspondances actuelles ne prouvent ni les affectations passées ni deux boîtiers indépendants.

## Repères de prise en charge fournis

La page Demande présente les 79 repères du fichier `zones_pickup_gps (1).csv` : 17 centres de zone et 62 points, dont 45 entrées à Casablanca et 34 à Marrakech. La carte schématique fonctionne sans fond de plan externe ; les liens Google Maps s'ouvrent uniquement sur clic. Les coordonnées restent des références séparées des courses, avec leur provenance déclarée et l'incertitude annoncée de ±200 m pour les estimations. Trois points estimés ont été corrigés le **3 novembre 2026** à partir des localisations publiées par les établissements : [Mövenpick Casablanca](https://all.accor.com/hotel/B4P8/index.fr.shtml), [Menara Mall](https://www.menaramall.com/contact) et [M Avenue](https://m-avenue.ma/experience-m-avenue-/m-info/). Les anciennes coordonnées et les sources sont conservées ; ces localisations ne certifient pas une entrée de prise en charge.

Les **20 autres estimations restent non validées**. Les pages officielles du [Jardin Majorelle](https://www.jardinmajorelle.com/lejardin/), d'[Es Saadi](https://www.essaadi.com/en/access-contact/) et de [La Mamounia](https://mamounia.com/en/contact.html), contrôlées le 3 novembre, précisent une adresse ou un accès mais ne justifient pas de nouvelles coordonnées pour les libellés fournis, parfois groupés. Les sources, dates, empreintes des pages et motifs de non-validation sont conservés ; aucune précision ±200 m n'est certifiée.

Le fichier de 6 544 courses ne contient aucune colonne GPS. Ses adresses comportent 308 occurrences de plus codes courts : 274 peuvent être décodées avec un suffixe de ville explicite et le contexte géographique documenté, tandis que 34 restent non résolues par cette règle. La revue privée des 17 adresses retrouve un contexte pays→ville explicite pour un code supplémentaire, sans modifier ce bilan automatique ni attribuer une position à la course. Ces coordonnées sont **dérivées d'un code d'adresse, pas un GPS mesuré de course**. Elles ne sont pas affectées aux trajets ni aux centres de zone. Les plus codes bruts et les références Wikipedia précises absents du fichier des 79 repères ne sont pas inventés.

Le complément local du 3 novembre a ajouté **557 courses** (537 Casablanca, 20 Marrakech), sans modifier les 5 720 précédentes. Le reçu `applied-new-aliases.json` et une vérification SQL en lecture seule confirment **6 277 UUID uniques**, sans doublon : **5 756 Casablanca** (4 546 terminées, 1 210 annulées) et **521 Marrakech** (465 terminées, 56 annulées). La revue complémentaire des 17 anciennes attributions ambiguës confirme la ville pour **12 lignes** : 9 adresses Umayya/Corniche corroborées par le site officiel et 3 adresses présentant explicitement pays puis ville. **5 restent à confirmer** : 4 libellés « Casa Santa » et une simple mention de « route de Casablanca ». Ce contrôle confirme un nom de ville, jamais une position GPS.

La quarantaine analytique est réversible et ne modifie aucune ligne SQL. `scripts/prepare-demand-city-review.mjs --csv CHEMIN_ABSOLU --decisions CHEMIN_PRIVE` compare chaque décision privée à la source et aux valeurs actuelles de la base locale dans une transaction en lecture seule. Le plan contient les empreintes d'identité et de contenu, sans adresse ni UUID brut ; il reste dans `.local/`, exclu du bundle. Après revue du plan et copie privée en `.local/demand-city-review.json` (fichier 0600, dossier 0700), le redémarrage du serveur active l'exclusion des seules lignes correspondantes. Un changement de ces lignes exige une nouvelle revue. Plan absent ou invalide : l'interface signale que les attributions importées ne sont pas validées. Pour revenir en arrière, restaurer le plan privé précédent puis redémarrer ; sans plan précédent, retirer le plan actif rétablit les totaux importés avec leur avertissement, sans prétendre confirmer les villes.

Le plan préparé le 3 novembre n'effectue aucune écriture de base : **5 lignes à part** (4 terminées, 1 annulée), **5 751 Casablanca analysables** (4 542 terminées, 1 209 annulées) et **521 Marrakech**, soit **6 272 analysées / 6 277 conservées** après activation. L'API et l'interface excluent ces cinq lignes des totaux, heures, zones et recommandations, et montrent leur compteur séparément sous le périmètre autorisé de l'utilisateur. Ce total Casablanca de 5 751 correspond à toute la période moins les cinq incertitudes ; il ne faut pas le confondre avec le même nombre obtenu avant quarantaine en filtrant les dates du 3 octobre au 2 novembre. Les empreintes et preuves de courses restent privées ; aucune généralisation à tous les lieux portant le même nom.

Les pourcentages et créneaux restent ceux fournis par l'utilisateur, sans recalcul implicite. L'annonce de 5 945 demandes à Casablanca du 3 octobre au 2 novembre n'est pas reproduite par ce fichier : les 5 756 lignes attribuées à Casablanca couvrent le 2 octobre au 2 novembre. À Marrakech, les 521 lignes commencent le 5 octobre, tandis que le résumé porte sur le 28 octobre au 2 novembre. Ces périmètres restent distincts, ainsi que les taux de prises localisables et d'adresses sans précision. L'original des repères est archivé dans `.local/pickup-references/` ; le reçu et le contrôle des courses sont conservés dans `.local/uber-reports/manual-imports/`. Aucune coordonnée de course ni zone autorisée n'est créée.

### Audit du 3 novembre 2026

Les corrections portent sur les filtres d'agence du parc, les réponses tardives après navigation ou changement de compte, les affectations périmées, l'expiration locale des signalements de zone, la cohérence entre badges parking et activité plateforme, ainsi que la reprise du planning après erreur. Les pages de pointage et le référentiel ne réutilisent pas une réponse d'une ancienne session. La pagination du parc conserve un ordre unique, y compris au-delà de 1 000 véhicules. La page **Accès au staging** indique désormais l'accès navigateur à cette version de test.

Bolt et Geotab respectent les délais `Retry-After` exprimés en secondes ou en date HTTP, même au-delà d'une heure ; les longues minuteries sont fractionnées sans avancer la prochaine lecture. Ces scénarios ont été vérifiés avec des réponses simulées. La reprise automatique réelle de Geotab après un timeout a également été observée, sans relance forcée.

Validation : suite de **879 tests**, avec mise à jour des fixtures de date et de délai puis rejeu des modules concernés ; **268 contrôles SQL** sur le schéma local, tous annulés par rollback ; **38 parcours de navigation** sur ordinateur et mobile, complétés par les tests des cartes et nouvelles vues. Les tests de navigateur bloquent les services externes ou remplacent leurs réponses par des données fictives. Les secrets connus ne sont pas présents dans les 371 fichiers publiables contrôlés ; les accès locaux restent privés et ignorés par Git. Les journaux détaillés sont dans `.local/checks/`.

Les limites de données restent distinctes des bugs corrigés : identité MyClicar de Youssef Mezoiar non établie, parking nord de Marrakech non confirmé et contours géographiques indicatifs. Le statut de la collecte réelle des CSV Uber est détaillé plus bas. Aucun rapprochement incertain ni présence GPS actuelle ne sont inventés pour masquer ces limites.

**Horaires du Maroc** : le serveur Node présent sur ce poste utilisait encore une base de fuseaux ancienne, contrairement au navigateur et à PostgreSQL. Le serveur et les pages utilisent désormais le même référentiel IANA **2026f**, avec les transitions historiques du Ramadan et le retour permanent à GMT au **20 septembre 2026**. Les dates locales ambiguës lors d'un changement d'heure sont signalées ; les horodatages portant un décalage explicite sont conservés. Cela corrige les périodes de rapports, les compteurs journaliers Geotab, les horaires des contrats, les rotations et les créneaux. La migration locale `20261221000000_usage_morocco_calendar.sql` remplace aussi les deux anciens calculs SQL `+ 1 hour` des compteurs d'usage. Les observations historiques déjà enregistrées ne sont pas réécrites en bloc. [Annonce officielle](https://www.cg.gov.ma/en/node/13036), [référentiel IANA](https://data.iana.org/time-zones/tzdb/africa).

La dernière passe complète du 3 novembre, après les corrections de fuseau, de rapports et de leur période d'affichage, compte **967 tests réussis sur 967**, sans test ignoré. Elle couvre aussi les clients de bureau et la préparation du serveur. Les migrations de rapprochement et de calendrier d'usage ont en outre passé **52 contrôles SQL avec rollback** après application locale ; les trois suites de rapports et de configuration ajoutent **74 contrôles SQL**, également annulés après vérification. La vérification via l'API réelle confirme 25 synthèses Activité, 25 synthèses Qualité et leur restitution sur une fiche avec la période exacte. Journaux : `.local/checks/staging-final-units-2026-11-03-complete.log` et `.local/checks/performance-real-validation-2026-11-03.json`. Ces contrôles ne remplacent pas la validation sur un serveur Oracle encore absent, ni les parcours métier sur macOS/Windows. Les essais natifs du conteneur sont détaillés plus bas.

La passe des points 3, 4 et 5 du 3 novembre compte **1 325 tests réussis**, sans échec ni test ignoré (`.local/checks/remaining-three-four-five-regression.log`). La migration locale 31 a été appliquée après sauvegarde et 31 vérifications SQL en rollback. L’écran de rapprochement financier a été vérifié sur les 11 cas réels sans créer d’association. Le plan privé des villes est actif : 6 277 courses conservées, 6 272 analysées, cinq mises à part. Le serveur et les collecteurs ont repris ; l’archive Teksat compte huit véhicules, sans erreur ni attente d’écriture. Le basculement réel Teksat et la validation métier sur Windows/macOS restent conditionnés aux preuves ou rapports indiqués dans leurs sections.

## Anciennes applications clientes et serveur de test (0.1.1)

Le client de bureau est dans `desktop/`. Il ouvre uniquement l’adresse HTTPS du staging configurée à la construction et vérifie `/health` avant d’afficher Ludy. Les utilisateurs se connectent avec leur compte de test ; le ZIP ne contient ni identifiants, ni base, ni accès Uber/Bolt/Geotab/MyClicar. Les fichiers du client sont sélectionnés explicitement et les archives Electron vérifiées par SHA-256. Le site peut évoluer sur le serveur sans reconstruire le client ; une mise à jour du moteur Electron demande une nouvelle archive.

Avec Node.js 22.12 ou plus, `curl` et `zip` :

```bash
npm --prefix staging/desktop ci
npm --prefix staging run desktop:build -- --draft --target windows-x64
npm --prefix staging run desktop:build -- --draft --target linux-x64
npm --prefix staging run desktop:build -- --local
# Après déploiement et vérification du vrai serveur :
npm --prefix staging run desktop:build -- --url https://votre-staging --target windows-x64
# Kit de sources à transmettre au collègue qui teste sur Mac :
node staging/scripts/build-mac-test-kit.mjs
```

Les sorties sont dans `.local/releases/desktop/`. Le suffixe **NON-CONFIGURE** identifie les archives sans serveur configuré : à partir de la version 0.1.1, elles permettent uniquement les tests de lancement hors connexion. La version **LOCAL** est réservée à Linux et utilise le staging déjà lancé sur ce PC. Les ZIP Windows et Linux conservent tous les fichiers nécessaires. Windows n’est pas signé et peut afficher un avertissement.

La construction Mac depuis Linux est désormais refusée avant tout téléchargement : les anciens ZIP Mac ne doivent plus être transmis. Le kit **Ludy-Mac-Test-Local** contient les sources du client, les dépendances verrouillées et leurs empreintes, sans données de flotte. Sur le Mac, installer Node.js LTS 22.12 minimum, extraire le kit, puis taper `sh ` dans Terminal et y glisser `Preparer Ludy.command`. Le script vérifie les fichiers, télécharge les outils, construit pour l’architecture du Mac, signe localement et vérifie strictement la signature avant de lancer le diagnostic. Une erreur de signature arrête le lancement. Le dossier obtenu est réservé à ce Mac : aucun ZIP d’application Mac n’est produit. Cette signature ad hoc n’est pas une distribution Developer ID notariée ; la distribution générale reste à préparer avec ces éléments Apple. Les protections système restent actives.

Les cinq archives **0.1.0** ont été construites et contrôlées : sommes SHA-256, intégrité ZIP, contenu ASAR limité aux fichiers prévus, icônes, architectures et liens symboliques macOS. La recette renouvelée du **3 novembre 2026** compte **22 tests automatisés réussis** et **20 contrôles Electron exécutés sur Linux**, avec sandbox et serveur simulé pour les parcours de connexion, indisponibilité, notifications et documents. Pour cette version, Windows et macOS ont été vérifiés statiquement, sans exécution native sur ces systèmes. Les versions Mac demandent macOS 13 ou plus. Les archives `NON-CONFIGURE` restent des préparations : elles ne constituent pas un déploiement accessible aux collègues.

Les quatre archives **0.1.1** ajoutent un diagnostic hors connexion : `Tester Ludy.cmd` sur Windows, `Tester Ludy.command` sur Mac et `Tester-Ludy.sh` sur Linux. Le test utilise le vrai conteneur avec une page fictive et un profil temporaire, sans lire la configuration ou la session habituelle. Il vérifie affichage, isolation, fenêtre PDF et préparation de l’export, puis propose un rapport JSON sans donnée de flotte. Il ne certifie ni les notifications natives ni les parcours métier. **25 tests automatisés, 20 contrôles Electron et les 8 contrôles du diagnostic ont réussi sur Linux.** Les quatre ZIP ont été reconstruits et leurs empreintes contrôlées.

Le rapport fourni depuis **Windows x64 le 3 novembre 2026 à 19:27 UTC** confirme **8 contrôles sur 8 réussis** avec Ludy 0.1.1 et Electron 45.2.1, sans requête réseau. Sa portée est `offline_desktop_container` et `applicationWorkflowsTested` reste `false`. L’original est conservé avec son empreinte SHA-256 dans `.local/validation/desktop/Ludy-test-win32-x64-2026-11-03.json`. Sur le Mac **arm64 / macOS 15.7.7**, l’ancien ZIP 0.1.1 reste bloqué au lancement ; `codesign` signale `code has no resources but signature indicates they must be present`. Aucun diagnostic Mac réussi n’est encore reçu. Une fois une adresse serveur configurée, les comptes, données, exports réels, notifications et reprise doivent encore être essayés sur Windows et Mac.

Le correctif de préparation Mac passe **41 tests ciblés** : clients, signature exigée, arrêt avant lancement en cas d’échec et intégrité du kit. Le kit final `Ludy-Mac-Test-Local-0.1.1-2026-11-03T20-11-55-451Z-9f5f5761.zip` contient 18 fichiers de sources et instructions, plus leur manifeste (208 868 octets). CRC, SHA-256, correspondance aux sources et installation isolée des outils verrouillés ont été vérifiés sous Linux. L’exécution native et la signature sur le Mac restent à confirmer par son rapport ; aucune réussite macOS n’est déduite de ces contrôles Linux.

L’ancienne option de serveur permanent décrite ici est remplacée, pour la production retenue, par le [serveur embarqué dans chaque application](production/README.md). Les commandes d’hébergement de staging restent disponibles pour leurs usages de test. `hosting:prepare` prépare les unités et la configuration, `hosting:bundle` produit uniquement les sources ; aucune de ces commandes ne déploie ni n’active un service. `host -- --check` vérifie la préparation avant que `host` puisse ouvrir la passerelle locale sur 4174. Les secrets Auth de développement ne sont pas acceptables pour cet hébergement : la préparation serveur génère ses propres clés, et le lancement exige leur vérification ainsi que le confinement des ports internes. Les sessions Uber devront être connectées normalement sur le serveur, avec validation humaine si Uber la demande. Le poste de l’opérateur n’aura alors plus à rester allumé.

Le paquet serveur vérifié est `.local/releases/server/Ludy-Staging-Server-2026-11-03.tar.gz` : 262 fichiers source, avec manifeste SHA-256, sans données privées ni dépendances installées. Le [guide d’hébergement](hosting/README.md) décrit la préparation Oracle et la bascule. En mode hébergé, les documents Contrats/Manifestes/Planning/Devis/RH sont transmis sous le compte utilisateur et ses règles d’accès, avec une limite de **8 Mio par requête complète**. Le portail `https://votre-staging/chauffeur.html` conserve ses codes personnels et n’expose aucune donnée de flotte ; ses requêtes sont limitées à 16 Kio. Les connexions sont limitées par adresse IP transmise par Caddy. Les contrôles des connecteurs et la création des accès chauffeur restent réservés au poste qui héberge la collecte.

Les recherches supplémentaires du 3 novembre n’ont pas établi de correspondance certaine pour Youssef Mezoiar, ni la nature du stationnement de WW968208 au nord de Marrakech. L’utilisateur a confirmé que ces deux points restent **à confirmer** : aucun rapprochement ni parking n’a été forcé.

## Parcours dans Ludy

La **Vue d'ensemble** rassemble les sources, les états Uber/Bolt par chauffeur et les signalements internes. La navigation regroupe les écrans existants par activité ; la recherche de pages s'ouvre aussi avec `Ctrl+K`. Les états non observés ou périmés restent signalés comme tels.

Sur la **Carte en direct**, les voitures portent le badge Uber ou Bolt selon leur affectation actuelle et les observations récentes. Une course ou une approche prime sur une plateforme seulement disponible ; deux plateformes actives au même niveau affichent les deux badges. Leur couleur indique l'activité plateforme : gris disponible, bleu en course, vert vers le client, orange en pause, rouge hors ligne confirmé. Une activité inconnue reste neutre ; une alerte critique ajoute un contour rouge et un point d'exclamation sans remplacer la couleur d'activité. Les logos restent horizontaux lorsque la voiture suit son cap.

Le symbole **P bleu** demande une présence récente dans un parking configuré, un inventaire MyClicar disponible et complet, aucun contrat en cours correspondant et aucune activité plateforme contradictoire. Un **P gris daté** peut indiquer la dernière position connue au parking, moteur coupé, après vérification de l'inventaire et des retours : il ne confirme pas une présence actuelle et n'augmente pas ce compteur. Une panne de source, un départ, une activité ou une position contradictoire retire cette preuve. Sans preuve suffisante, la voiture reste sans badge parking.

Une plaque plateforme certaine peut afficher le chauffeur observé même si sa fiche Ludy reste à rapprocher. Cet affichage ne crée pas d'affectation et n'active pas la surveillance des 200 m. Les compteurs d'affectations à confirmer portent sur les chauffeurs ayant une activité récente, un contrat en cours, une affectation actuelle ou un incident encore ouvert ; les simples profils historiques sont exclus. Une ancienne contradiction peut être levée automatiquement après une nouvelle observation fiable du titulaire sur le même véhicule ; son expiration seule ne suffit pas.

Les compteurs distinguent le **parc complet**, les **véhicules associés à un boîtier GPS**, les **positions récentes** et les **chauffeurs en ligne**. Ces derniers sont comptés par fiche commune Uber/Bolt : deux comptes du même chauffeur confirmé comptent pour une personne. Un même nom ne suffit pas à fusionner deux profils. Il peut donc y avoir 14 chauffeurs en ligne, 11 véhicules suivis par GPS et 19 véhicules au parc. La carte conserve les voitures sans GPS dans sa liste et présente les chauffeurs sans position actuelle confirmée ; elle n'invente aucun marqueur pour eux. Les compteurs respectent le filtre d'agence.

Le détail d'un chauffeur présente la chronologie des observations. Les noms complets identiques et uniques sont maintenant rapprochés automatiquement du référentiel Ludy, en harmonisant accents, ponctuation et ordre des mots. Une différence limitée aux espaces ou traits d’union peut aussi être reconnue si toutes les lettres restent identiques dans leur ordre, le nom comporte plusieurs mots et la référence est unique. Ce rapprochement est revérifié dans la base, refuse les doublons de comptes de la même plateforme et est tracé comme `name_spacing`. Il ne suffit jamais à attribuer un véhicule. Uber et Bolt sont réunis sur une fiche sans supprimer l'historique. Les homonymes, noms partiels et comptes multiples de la même plateforme restent à vérifier dans **Associations**. Toute correction manuelle devient prioritaire et désactive l'automatisme pour cette fiche. Les opérations sont tracées dans `fleet_link_audit`.

Les signalements de **durée hors ligne** sont internes au staging. Leur seuil par défaut est de cinq minutes, avec au moins deux observations ; il se règle dans **Connecteurs**. Une interruption de collecte suspend ces signalements. Une absence de ligne à l'écran n'est jamais transformée en état hors ligne. Les **urgences de déconnexion pendant le service**, décrites ci-dessous, constituent une surveillance distincte fondée sur les contrats MyClicar.

## Connecter les sources

- **Bolt** : les accès sont lus côté serveur depuis `.local/bolt.env`, jamais transmis au navigateur. Dans **Connecteurs**, choisir **Activer le suivi automatique**. Une lecture immédiate est suivie d'une actualisation toutes les 60 secondes. **Mettre en pause** arrête ce suivi. Le suivi actif reprend au redémarrage du serveur ; une pause manuelle est conservée dans `.local/connector-state.json`. Une panne, même lors du premier appel, déclenche des tentatives espacées et respecte les délais de quota. La prochaine tentative est affichée dans Connecteurs. Les appels à Bolt lisent les données ; ils ne modifient pas le compte Fleet. Les observations reçues sont conservées dans la base locale.
- **Uber Fleet** : ouvrir le [guide local d'installation](http://127.0.0.1:4173/uber-extension/), installer l'extension puis générer un code depuis **Associer mon écran Uber**. Coller ce code dans l'extension, ouvrir la Live Map sur le deuxième écran et démarrer sa lecture. La liste est parcourue par défilement à cadence cible de 15 secondes, sans dépasser un parcours simultané. Le compteur couvre aussi les chauffeurs au-delà des premières lignes ; chaque statut garde l’heure de son observation. Gris = disponible, bleu = en course, vert = en approche. La liaison est conservée après redémarrage du serveur, expire après 30 jours sans activité et nécessite un nouveau code au plus tard après 90 jours. L'extension 0.6.6 reprend après une panne locale et recharge la Live Map toutes les vingt minutes pendant la collecte, après la fin du parcours et de sa transmission. Une page cachée ou une interaction récente reporte ce rechargement ; Arrêter l'annule. L'option de reprise automatique demande une autorisation navigateur et retrouve la Live Map visible de la même flotte après réouverture ; elle ne connecte pas le compte Uber et n'ouvre aucun onglet. Sans cette option, cliquer sur Démarrer après réouverture du navigateur. Voir aussi [les instructions complètes de l'extension](uber-extension/README.md).
- **Geotab** : dans **Connecteurs**, tester et enregistrer les accès MyGeotab, vérifier les rapprochements certains du catalogue et démarrer le suivi des positions, de la vitesse et du contact. Les 11 véhicules initialement associés, les compteurs et les événements ont été validés avec le compte réel dédié au staging ; ce nombre ne représente pas le parc complet. Voir le parcours détaillé ci-dessous.
- **MyClicar** : le connecteur lit les contrats en cours toutes les **60 secondes**, et le catalogue complet des véhicules/agences toutes les **cinq minutes**. Dans **Connecteurs → MyClicar**, enregistrer séparément les accès de la protection HTTP et du compte Luxury, puis activer le suivi automatique. Les deux mots de passe restent dans `.local/myclicar.json` (0600), jamais dans le navigateur après enregistrement. Une pause reste enregistrée ; un suivi actif reprend au redémarrage avec des tentatives espacées en cas de panne.

Le raccordement MyClicar utilise les mêmes requêtes de lecture que le portail : authentification Luxury (`clicarmaroc`), listes paginées des agences/véhicules et contrats `IN_PROGRESS`, puis détail des contrats nécessaires à la vérification des références et horaires. Les départs de toutes les agences accessibles sont lus ; un changement d'agence contradictoire avec la fiche locale reste à vérifier. Aucun dossier personnel client n'est collecté ; les contacts et données financières des réponses sont écartés. Aucune modification n'est effectuée chez MyClicar. Une page manquante, un doublon ou une erreur conserve le dernier lot complet ; une lecture contractuelle invalide ne renouvelle pas les affectations automatiques.

Le catalogue MyClicar complète le référentiel local même pour les véhicules inutilisés ou sans contrat. Le relevé de préparation a identifié **19 véhicules non archivés**, 20 références archivées et 2 agences : ces nombres sont datés, pas des quotas fixes. Les références archivées restent séparées et ne créent pas de nouvelles voitures actives. Une ancienne référence ne concurrence pas sa remplaçante actuelle ; le renouvellement d'une référence déjà associée exige le même VIN confirmé des deux côtés. Les rapprochements utilisent les identifiants fournisseur, VIN et plaques certains ; les doublons restent à vérifier. Les fiches existantes et leurs réglages manuels sont conservés. Les agences sont rapprochées par nom sans préfixe « Agence » ou par ville exacte, uniquement en cas de correspondance unique et cohérente. Les doublons créés par un ancien import restent conservés avec un marqueur d'alias local ; les droits des gestionnaires ne sont pas déplacés. L'agence d'une voiture neuve reste inconnue jusqu'à une preuve contractuelle cohérente ou un choix manuel ; elle reste alors visible uniquement par l'administrateur. Une référence chauffeur manquante n'est créée que depuis un contrat vérifié avec départ effectif, sans coordonnées personnelles.

Les affectations MyClicar utilisent le code chauffeur Ludy, une référence véhicule certaine et le **départ effectif**. L'horodatage ISO du détail vérifié est prioritaire sur la date affichée dans la liste ; les horaires sont présentés à l'heure du Maroc. La date de retour prévue ne constitue pas un retour réel. Les contrats sans correspondance certaine restent à vérifier dans **Associations** ; les choix manuels sont prioritaires. Une affectation automatique expire au plus tard après cinq minutes sans nouvelle lecture valide. Un contrat disparu de la liste complète perd immédiatement sa valeur de preuve, sans inventer sa date de retour. Un changement de contrat remet à zéro la mesure du déplacement hors ligne, même pour le même chauffeur et la même voiture.

Le référentiel initial est une copie datée du 30 octobre 2026, sans synchronisation avec la base Supabase de production. Le connecteur MyClicar le complète désormais par ses lectures autorisées. Les observations Bolt/Uber suivent leur propre collecte ; elles ne créent pas à elles seules un véhicule ni un départ contractuel. Le collecteur Uber a été vérifié sur des pages fictives et son installation Chromium a été testée ; la compatibilité avec la vue actuelle du compte Uber doit encore être vérifiée après association. La distribution Firefox est temporaire et doit être rechargée après redémarrage du navigateur.

### Configurer MyGeotab dans le staging

Utiliser le compte de service MyGeotab dédié au staging, avec des droits de lecture et l'accès aux véhicules souhaités. L'API utilise le nom de la base, l'identifiant et le mot de passe de ce compte ; elle ne nécessite pas de clé développeur séparée. Voir les [premiers pas du SDK MyGeotab](https://developers.geotab.com/myGeotab/guides/gettingStarted/) et le [guide des comptes de service](https://support.geotab.com/help/mygeotab/access-and-administration/database-administration/service-accounts).

1. Se connecter à Ludy local avec le compte administrateur, puis ouvrir **Connecteurs → Geotab**.
2. Saisir la **base MyGeotab** (`clicar` est proposée par défaut), l'**identifiant MyGeotab** et le **mot de passe MyGeotab** directement dans le formulaire local. Ce sont les accès MyGeotab, pas les identifiants de connexion à Ludy.
3. Cliquer sur **Tester et enregistrer**. Le serveur vérifie les accès et lit le catalogue des boîtiers accessibles ; cela ne démarre pas le suivi. Le champ du mot de passe est vidé après soumission.
4. Ouvrir **Associer les véhicules aux boîtiers**. L'import MyClicar et l'actualisation du catalogue tentent les correspondances uniques par plaque ou VIN. Pour les cas restants, rechercher par plaque, nom ou identifiant, choisir le boîtier et cliquer sur **Enregistrer**. Chaque sélecteur affiche au plus 50 résultats de recherche, ainsi que le boîtier déjà sélectionné. Les associations modifient uniquement la base locale.
5. Cliquer sur **Activer le suivi automatique**, puis **Ouvrir la carte**. Le suivi reprend au redémarrage du serveur et réessaie après une interruption. **Mettre en pause** arrête les lectures et conserve cet arrêt au redémarrage ; les accès et associations restent enregistrés. Une modification des accès ou des boîtiers reprend automatiquement le suivi s'il était activé.

Le rapprochement utilisé en production est également disponible localement : clé du véhicule, plaque actuelle et anciennes plaques comparées au nom ou à la plaque du boîtier, et VIN lorsqu'il est disponible dans les deux référentiels. La normalisation des plaques est identique à `collector/src/15_engine.gs`. Seules les correspondances uniques, sans boîtier déjà associé, sont appliquées ; deux VIN renseignés mais différents interdisent le rapprochement, même si la plaque concorde. Les associations existantes et les dissociations manuelles sont prioritaires : un boîtier retiré manuellement n'est pas réaffecté par l'automatisme. Les anciennes fiches locales sans boîtier sont également protégées. Après chaque import d'inventaire, le rapprochement utilise uniquement le catalogue Geotab déjà validé pour ce compte, sans nouvel appel fournisseur et sans suspendre le suivi. Actualiser explicitement ce catalogue dans Connecteurs pour récupérer les VIN manquants ; les nouveaux véhicules sans correspondance restent sans GPS.

```bash
# Afficher uniquement les nombres de correspondances, sans modification
npm --prefix staging run geotab:associate
# Appliquer les correspondances uniques puis démarrer le suivi Geotab
npm --prefix staging run geotab:associate -- --apply --start
```

La commande lit le compte administrateur local dans `.local/credentials.json` sans afficher ses accès. Avant modification, elle conserve les associations précédentes dans un fichier privé `.local/geotab-associations-*.json`. Sans `--start`, une collecte en pause reste en pause ; un suivi automatique déjà activé reprend après chaque changement d'association.

Les accès sont stockés côté serveur dans `.local/geotab.json`, en permissions privées `0600`. Ce dossier est ignoré par Git et n'est pas servi par le site. Le mot de passe enregistré et la session Geotab ne sont jamais renvoyés au navigateur par l'API, ni placés dans le stockage du navigateur. Ne pas copier ce fichier ou le mot de passe dans une conversation.

La collecte vise une lecture des positions et du contact toutes les **2 secondes pour les 11 véhicules initialement associés**. Les événements de conduite `ExceptionEvent` sont relus toutes les **10 secondes**, les compteurs `StatusData` de kilométrage, carburant total et carburant au ralenti toutes les **30 secondes**. Les différences de compteurs et les L/100 km sont calculés depuis minuit, heure du Maroc ; cette période est indiquée dans l'interface. Une valeur absente ou un compteur réinitialisé reste inconnu. Les vues **Trajets** et **Bilans Geotab** complètent ces lectures avec l'historique détaillé et un export CSV.

Le front utilise les mêmes transitions horaires marocaines que la production, copiées dans `site/timezone.js`, afin de compenser les tables de fuseaux périmées de certains navigateurs. Les frontières de journée et les changements du Ramadan sont vérifiés contre le calcul du serveur.

Le suivi est limité à **100 véhicules associés**. Les lectures sont regroupées par `ExecuteMultiCall` et la cadence ralentit pour une flotte plus grande. Les cycles de positions ne se chevauchent pas ; les compteurs et événements sont lus indépendamment pour ne pas les bloquer. Une réponse lente ou un quota peut retarder le prochain passage. Les limites de l'API s'appliquent également aux sous-appels des requêtes groupées ([documentation Geotab](https://developers.geotab.com/myGeotab/guides/rateLimits/index.html)).

La carte consulte le cache local toutes les **2 secondes** lorsqu'elle est visible, y compris sans activité de souris ou de clavier. Ces demandes ne déclenchent pas une lecture Geotab supplémentaire par écran. La cadence réelle du serveur est affichée dans Connecteurs et sur la carte. Les véhicules renvoyés respectent les accès par agence du compte Ludy, via les droits de la base locale. Les positions anciennes, les interruptions et les pauses sont signalées ; une absence de données ne permet pas de conclure qu'un chauffeur est hors ligne. Une lecture plus fréquente ne crée pas de nouvelles positions si le boîtier ne les a pas encore transmises : chaque position conserve son horodatage Geotab.

Le catalogue des boîtiers est lu par pages de 500, triées par identifiant, jusqu'à une page vide. Seuls l'identifiant, le nom, la plaque et le VIN sont demandés. Cette [pagination Geotab](https://developers.geotab.com/myGeotab/guides/concepts/#pagination) permet de dépasser l'ancienne limite de 2 000 boîtiers. Le connecteur refuse une liste partielle en cas d'erreur, de curseur répété, de dépassement de 20 000 boîtiers, de 60 pages ou du délai global de lecture de 60 secondes. Ces limites du catalogue sont distinctes de la limite des 100 véhicules suivis.

Ces lectures utilisent les ressources et quotas de l'API MyGeotab : un impact nul sur le service Geotab ne peut pas être garanti. Aucune écriture n'est effectuée dans Geotab ou Supabase de production, et le collecteur Apps Script de production n'est pas démarré. Les données reçues sont enregistrées uniquement dans le staging local.

### Parc, parkings et zones autorisées

**Parc et zones** (`#/parkings`) présente toutes les voitures accessibles, y compris inutilisées ou sans GPS, avec filtres de stationnement, mouvement, absence de boîtier et disponibilité hors zone. La présence actuelle repose sur des positions Geotab récentes. Deux observations distinctes confirment un franchissement ; la première position au démarrage peut établir une présence sans inventer une entrée. Une interruption ou un changement de boîtier rompt la continuité.

Sur **Carte en direct**, **Aller vers une zone** permet de choisir une zone autorisée, un parking ou une exclusion puis **Aller** cadre son contour. La liste est regroupée par ville et agence et respecte le filtre d'agence courant ; les zones communes restent proposées. Les zones supprimées sont exclues, et les contours indicatifs ou désactivés sont identifiés. Cette navigation est disponible aux comptes en lecture seule et ne change ni les affectations ni le suivi. Les mises à jour GPS conservent le cadrage choisi. Le catalogue est lu séparément du parc, sans appel fournisseur : au montage du contrôle, avec **Actualiser les zones**, ou à la réouverture du sélecteur après une minute.

Un administrateur choisit un contour Geotab ou dessine une zone locale, précise son agence et son usage : **parking**, **exclusion** ou **zone autorisée**. Une zone autorisée appartient obligatoirement à une agence. Une zone sélectionnée dans le catalogue Geotab est proposée désactivée ; le catalogue couvre plusieurs territoires et ses types ne valident pas leur usage pour Ludy. Chaque exclusion doit être sélectionnée et vérifiée localement, sans activation en bloc des exclusions mondiales. Ces choix ne modifient pas Geotab.

Le parking de l'agence Marrakech, près de **M Avenue**, est ajouté localement en mode **indicatif** : centre `31.62181475, -8.01562023`, rayon de 65 m, agence 2. Il repose sur quatre retours MyClicar vérifiés de véhicules distincts, le matin et le soir, dont les positions Geotab se regroupent dans un diamètre de 77,45 m, et sur l'adresse d'agence MyClicar. Ce périmètre actif reste estimé et modifiable ; ce n'est pas une zone officielle Geotab. Le regroupement de véhicules plus au nord n'est pas considéré comme un parking sans preuve supplémentaire. Les relevés détaillés restent privés dans `.local/marrakech-parking-evidence.json`.

Dans cette installation, le parking **Luxury Casablanca**, issu de Geotab, et les deux **zones autorisées de Casablanca et Marrakech** sont actifs dans le staging. Les zones autorisées reprennent les contours bleus fournis par l'utilisateur : 29 sommets pour Casablanca, 39 pour Marrakech, rattachés aux agences correspondantes. Elles sont activées en **mode indicatif**, conformément au choix de l'utilisateur. Le calage sur des repères cartographiques à partir de captures non géoréférencées reste approximatif : environ **750 m à Casablanca et 1 km à Marrakech** constituent des ordres de grandeur prudents, sans garantie de précision. Le bord est du port de Casablanca mérite notamment une vérification ; l'aéroport de Marrakech est inclus. Le parking de Marrakech attend toujours un emplacement confirmé.

La règle **Disponible hors zone** signale un chauffeur dont au moins une plateforme utilisée le déclare disponible, avec une affectation actuelle certaine au véhicule, lorsque celui-ci est confirmé hors de **toutes les zones autorisées actives de son agence**. Plusieurs zones d'une même agence forment donc un ensemble autorisé : se trouver dans l'une d'elles suffit. Le déclenchement exige au moins **deux positions GPS distinctes sur cinq secondes ou plus**, à **30 m ou davantage à l'extérieur** ; le retour est confirmé à **15 m ou davantage à l'intérieur**. Les marges traitent le bruit GPS ; l'incertitude du contour issu des captures reste entière.

Une source inconnue ou périmée, un statut en course ou en approche sur une autre plateforme, une preuve d'affectation absente/expirée ou un conflit de chauffeur empêche le signalement. Les données manquantes ne prouvent jamais une sortie. Le front relit les alertes dans le cache local toutes les **cinq secondes**, sans appel fournisseur supplémentaire par écran. Un badge et une notification interne portent explicitement la mention **contour indicatif** pour ces deux zones.

Pour créer une zone autorisée : **Parc et zones → Dessiner une zone autorisée**, choisir **Ville et agence**, puis **Placer les points sur la carte**. Cliquer autour du périmètre et terminer avec **Terminer le contour** après au moins trois points. **Annuler le dernier point** corrige le tracé ; **Annuler le tracé** revient au contour précédent sans enregistrer. Le nom, l'agence, les points et l'activation ne sont appliqués qu'avec **Enregistrer la zone**. Les fenêtres des zones déjà présentes ne prennent pas les clics pendant le dessin, ce qui permet de tracer une zone superposée.

Pour ajuster un contour local : **Modifier**, déplacer ses points bleus sur la carte, puis enregistrer. Les flèches du clavier déplacent aussi un point sélectionné. **Redessiner le contour** permet de recommencer ; **Annuler** ferme l'éditeur sans enregistrer ses changements. La création d'un cercle avec centre et rayon reste disponible dans **Créer ou modifier une zone**. Le réglage « Contour indicatif » reste visible ; la précision opérationnelle du périmètre se vérifie séparément. Les contours provenant de Geotab restent ceux du fournisseur.

Le bouton **Supprimer** est visible pour les administrateurs sur chaque zone et demande confirmation avec son nom. La zone est retirée du parc actif et sa détection est arrêtée ; elle est archivée pour conserver les entrées et sorties passées, affichées avec la mention **zone supprimée**. Une modification concurrente bloque la suppression jusqu'à actualisation : aucune version plus récente n'est effacée silencieusement. La suppression n'envoie aucune modification à Geotab. Une réimportation explicite de la même zone Geotab peut la rétablir dans Ludy.

### Urgences de déconnexion pendant le service

La règle retenue est **contrat MyClicar en cours = chauffeur en service jusqu'au retour effectif**. Le départ effectif doit être confirmé, le titulaire doit correspondre exactement à une fiche chauffeur, et le véhicule doit être identifié dans la même agence. La lecture MyClicar doit rester récente, au maximum cinq minutes. Une affectation contractuelle écartée après un changement de chauffeur ne prouve plus que l'ancien titulaire doit être en service. Les contrats ambigus, les références inconnues et les changements d'affectation exclus apparaissent dans la couverture de surveillance ; aucun horaire ni chauffeur n'est inventé pour compléter les données manquantes.

La politique **`all`**, intitulée **Déconnexion confirmée du chauffeur**, exige une transition **en ligne puis explicitement hors ligne pendant le même service**, ainsi que des observations récentes confirmant que tous ses comptes Uber/Bolt connus et actifs sont hors ligne. Une activité sur l'autre plateforme empêche l'urgence ; une source inconnue ou périmée suspend la conclusion. Une transition peut attendre la confirmation de l'autre compte tant que sa propre continuité reste valide ; une reprise d'activité annule cette attente. Un compte déjà hors ligne à la première lecture, jamais observé en ligne pendant ce service, ne déclenche pas d'urgence. Une disparition de la liste ou une panne ne prouvent jamais une déconnexion.

Ces urgences apparaissent dans le **Cockpit**, le centre **Alertes** et les notifications internes. Elles n'attendent ni le seuil de cinq minutes des signalements de durée, ni un déplacement de 200 m. L'historique est conservé : une activité récente postérieure à l'incident sur Uber **ou** Bolt, ou le retour effectif du véhicule enregistré au contrat, résout l'épisode. Des sources périmées ou un intervalle hors ligne devenu différent suspendent la conclusion. Un contrat absent du dernier lot est aussi suspendu : son absence seule ne prouve pas le retour du véhicule. La surveillance des **200 m** garde sa propre règle de disponibilité et ses preuves GPS. Aucun message n'est envoyé par e-mail, SMS ou WhatsApp.

Les réglages administrateur se trouvent dans **Connecteurs**. La migration crée la fonctionnalité **désactivée**. Cette installation utilise `enabled: true`, `policy: 'all'`, `duty_mode: 'contract'` pour éviter de confondre déconnexion d'un compte et arrêt d'activité du chauffeur. Deux alternatives restent configurables :

- **`policy: 'any'`** (**Déconnexion d'une plateforme**) : signaler une transition explicite de la plateforme observée lorsqu'aucune activité récente n'est connue sur l'autre. Ce mode peut déclencher si l'autre source est indisponible ; il ne confirme donc pas l'arrêt d'activité global du chauffeur.
- **`duty_mode: 'shift'`** : limiter le service au shift du contrat, en plus du départ effectif. Les paramètres actuels sont jour 7 h–19 h et nuit 19 h–7 h, à l'heure du Maroc. `shiftAdvance` classe un départ anticipé dans son shift sans avancer la période surveillée. Ce mode ne crée pas de planning chauffeur.

API locale, avec session Ludy authentifiée et droits par agence pour la lecture :

| Méthode et route | Usage |
|---|---|
| `GET /api/fleet/disconnections` | Lire les urgences, leur historique, les réglages et la couverture autorisée. |
| `POST /api/fleet/disconnections/settings` | Administrateur : enregistrer `{ "enabled": true, "policy": "all", "duty_mode": "contract" }`. Valeurs admises : `policy` = `any` ou `all`, `duty_mode` = `contract` ou `shift`. |

La détection dépend des observations reçues : cadence cible d'environ **15 secondes pour Uber**, **60 secondes pour Bolt**, puis actualisation de l'interface toutes les **2 secondes** lorsqu'elle est visible. Les délais du portail, du réseau et les interruptions peuvent allonger ce délai. Ce fonctionnement ne garantit pas une détection instantanée ni une couverture complète lorsque les sources sont indisponibles.

### Déplacement hors ligne : seuil de 200 m

Les noms complets uniques rapprochent automatiquement les comptes Uber/Bolt des fiches Ludy. Les plaques actuelles des plateformes déterminent ensuite le véhicule, si la correspondance est unique et compatible avec l’agence. Une voiture observée avec un nouveau chauffeur suit ce changement de shift sans sélection manuelle. Deux conducteurs simultanément observés sur la même voiture, ou deux plaques contradictoires pour le même conducteur, restent en conflit. Le modèle du véhicule ne suffit jamais à départager.

Dans **Cockpit → fiche chauffeur**, le mode **Automatique · plaques Uber / Bolt** conserve la fiche choisie tout en suivant les changements de véhicule. Corriger le nom ou la fiche ne verrouille donc plus la voiture. Le mode **Manuelle · véhicule fixé** est un choix explicite ; repasser en automatique libère ce verrou puis réévalue immédiatement les preuves. Les compteurs de déplacement ne sont pas transférés d’un chauffeur à l’autre.

Un contrat MyClicar avec départ effectif confirmé sert de référence en l’absence de preuve plateforme contradictoire. Une plaque live prime sur son affectation commerciale. Le staging mémorise le contrat écarté dans `fleet_contract_assignment_overrides` : son renouvellement de lecture, une coupure de source ou un passage hors ligne ne peuvent pas réattribuer la voiture à l’ancien chauffeur. Cette exclusion concerne uniquement l’association de supervision, jamais le contrat commercial. Elle s’applique au même identifiant, titulaire, véhicule et départ effectif ; une nouvelle affectation contractuelle distincte est réévaluée.

La surveillance démarre lorsque **tous les comptes Uber/Bolt connus et actifs du chauffeur sont explicitement hors ligne**, avec des observations récentes et une affectation véhicule vérifiée. Une activité récente sur l'une des plateformes (disponible, en approche, en course ou en pause) empêche l'alerte hors ligne ; un compte connu sans observation actuelle suspend la conclusion. La mesure commence au passage hors ligne du dernier compte et produit un seul incident par chauffeur/véhicule. Elle mesure les segments GPS observés après ce statut, avec des positions récentes et une vitesse confirmant le mouvement. Au-delà de **200 m**, une alerte **critique de déplacement hors ligne** apparaît dans Ludy. Le contact moteur figure parmi les preuves ; aucune commande n'est envoyée au véhicule. Le déplacement ne prouve pas qu'une course a lieu.

Les observations de plateforme inconnues ou périmées, les ruptures GPS et les changements d'affectation interrompent la continuité. Les doublons et sauts GPS incohérents ne comptent pas. La progression est sauvegardée dans `fleet_motion_checkpoints`, accessible uniquement au service local. Après un redémarrage court, elle est réutilisée uniquement si l'identité, la voiture, le boîtier, l'épisode et la fraîcheur restent valides. Un trou de données rompt la mesure ; une alerte suspendue reprend après plus de 200 m nouvellement confirmés, dans le même incident. Les comptes Bolt suspendus ou désactivés sont exclus. Une sélection de véhicule enregistrée dans le compte Bolt n'est pas une affectation actuelle : seule une plaque renvoyée pour un chauffeur observé en ligne peut établir une preuve automatique. Cette preuve expire sans être prolongée par une simple sélection hors ligne. Les anciens signalements issus d'une preuve non vérifiée restent dans l'historique avec leur motif de correction.

La réaction dépend aussi du délai de publication des boîtiers et des statuts (Uber : 15 s, Bolt : 60 s), pas seulement de la lecture Geotab à 2 s.

La table locale `fleet_motion_alerts` applique les droits des agences du chauffeur **et** du véhicule. `npm --prefix staging run migrate:local` applique la migration nécessaire uniquement au conteneur Supabase local, après contrôle du marqueur `staging` et sauvegarde privée. `npm --prefix staging start` effectue aussi ce contrôle, sans réinitialiser les données.

### Trajets, détails et bilans Geotab

**Trajets** affiche une journée par véhicule : tracé GPS, liste des déplacements, compteurs et événements. Une alerte de conduite ouvre les vitesses, positions et limites routières disponibles autour de l'événement. **Bilans Geotab** compare les véhicules sur une période de sept jours maximum et exporte les données en CSV.

Ces lectures sont demandées explicitement, utilisent un cache partagé de 1 à 5 minutes et ne se relancent pas avec chaque position. Les accès par agence sont vérifiés avant tout appel fournisseur. Bornes : historique de 90 jours, 25 h pour une journée avec changement d'heure, 25 véhicules par bilan, 20 000 points GPS, 5 000 événements et 2 000 trajets par réponse. Un résultat tronqué est refusé ; une durée impossible à attribuer exactement à la période reste inconnue et rend le bilan partiel. Les points interpolés de l'historique ne servent jamais à la surveillance des 200 m.

Le compteur **Chauffeurs suivis** du cockpit compte l’union des profils récemment observés sur Uber ou Bolt, y compris hors ligne, sans véhicule ou non encore liés à une fiche. Un profil canonique présent sur les deux plateformes compte une seule fois ; un nom identique seul ne fusionne pas deux comptes. Le détail Uber/Bolt/communs et les profils à rapprocher sont affichés. Les observations anciennes restent dans **Tous les profils**. Les filtres globaux d’agence ou **Mes véhicules** sont indiqués avec le nombre de profils exclus et peuvent être retirés via **Afficher toute la flotte**, dans les droits de la session.

La navigation principale donne accès au poste de pilotage, à la carte filtrable, au centre d'alertes et aux trajets. La fiche latérale d'un véhicule rassemble son état, sa consommation et ses signalements. La recherche et le véhicule sélectionné restent stables pendant les mises à jour ; les écrans métier existants restent accessibles dans les groupes de navigation.

### Mise à jour de l'extension Uber

La version 0.6.6 lit la plaque et le modèle dans les détails du chauffeur, y compris la ligne « plaque · année marque modèle ». Elle ouvre au maximum 12 fiches par passage, avec rotation pour les listes plus longues. La plaque identifie le véhicule ; le modèle apporte une information complémentaire et ne suffit jamais à associer une voiture. Le compteur des plaques est distinct de celui des statuts lus. Une plaque mise en cache conserve son heure d’origine pendant 180 secondes au maximum ; elle n’établit une affectation que si le chauffeur est encore observé en ligne. Les changements de shift révoquent les anciennes affectations automatiques contredites. Un choix manuel contredit est conservé mais suspend la surveillance hors ligne jusqu’à sa nouvelle confirmation.

Après passage à la version **0.6.6**, recharger l'extension dans `chrome://extensions`, puis **recharger les pages Uber Live Map et Rapports** pour remplacer les anciens scripts injectés. Si l'extension demande un code ou utilise encore une ancienne liaison temporaire, générer un nouveau code dans **Connecteurs** puis le coller dans l'extension. Une liaison persistante déjà fonctionnelle se conserve. Les anciens codes qui n'existaient qu'en mémoire ne peuvent pas être récupérés après redémarrage. Les nouveaux survivent aux redémarrages : seules leurs empreintes sont stockées dans `.local/uber-pairing.json` (0600). Un nouveau code révoque le précédent de cet administrateur ; le retrait du rôle administrateur révoque également la liaison.

Le correctif **0.6.4** a amélioré la reconnaissance du panneau latéral, des listes de sélection personnalisées, des libellés et des dates. Le correctif **0.6.5** traite le cas réel restant : libellé et sélecteur placés comme éléments voisins dans le panneau, avec recours au type affiché uniquement lorsqu'il identifie un sélecteur unique. Les liens explicites `for` et ARIA restent prioritaires ; un bouton d'aide voisin ne devient pas un second sélecteur. Une date en lecture seule n'est pas assimilée au menu du rapport à cause du texte d'un contrôle voisin. Une période ou une organisation non vérifiée empêche toujours la génération. Recharger l'extension et les pages Uber est nécessaire ; redémarrer le serveur seul ne remplace pas les scripts du navigateur.

Les reprises ont été testées avec suspension du service worker, huit heures de panne simulée, erreurs de quota, rechargement de page et arrêt manuel. Les observations périmées ne sont jamais rejouées. Une ligne disparue ne devient jamais hors ligne ; la couverture reste celle de la liste affichée et de ses filtres. Le parcours revient au début, avance avec recouvrement, puis restaure la position initiale ; une intervention dans la liste interrompt le défilement. Une liste virtualisée est lue à mesure que ses lignes sont affichées, sans accéder aux données cachées. Chaque cycle est borné à 18 secondes, 40 étapes et 200 chauffeurs, et les lectures partielles sont signalées. Les doublons ambigus sont exclus. Les écrans de reconnexion, les régions en chargement et les indices contradictoires suspendent la lecture. Le serveur refuse deux collecteurs actifs concurrents et une ancienne réponse ne peut annuler un arrêt plus récent. Uber ne fournit pas ici d'horodatage source : cette observation d'écran ne peut garantir l'exhaustivité ou une détection instantanée.


## Pauses, courses Uber et recommandations

**Pauses et rush** (`#/pauses-rush`) permet de définir les créneaux par ville, agence et jour, à l'heure du Maroc, y compris ceux qui traversent minuit. Une pause explicitement observée pendant un rush est signalée dans Ludy. Une absence d'observation ne devient pas une pause et une activité sur l'autre plateforme est prise en compte. Les fenêtres proposées pour les pauses restent des indications issues des courses observées.

Configuration locale du 2 novembre : **7 h–10 h tous les jours**, et **20 h–minuit le samedi et le dimanche**, pour chacune des deux villes. Ce sont les créneaux de préparation demandés, modifiables dans Ludy ; ils ne sont pas présentés comme une analyse déjà calculée des rapports Uber. Aucun rapport réel n’a encore permis de déduire des horaires spécifiques.

**Collecte des rapports Uber** (`#/uber-rapports`, administrateur) configure la flotte Uber, le nom exact de l'organisation, les agences de Casablanca/Marrakech et le format des dates. Le navigateur local dédié suit ensuite le parcours visible : choix du rapport, période, génération et téléchargement CSV normal. Les trois types **Trip activity**, **Driver activity** et **Driver quality** sont traités séparément sur les sept journées complètes précédentes, à l'heure du Maroc, avec un nouveau passage toutes les six heures.

Pour démarrer ce navigateur :

1. Garder le serveur Ludy local démarré et activer les rapports automatiques dans cet écran après avoir enregistré les réglages.
2. Dans le popup de l'extension Uber, cliquer sur **Arrêter les rapports**. Garder la lecture **Live Map** active sur le second écran : elle conserve son extension et sa liaison.
3. Depuis la racine du dépôt, ouvrir un autre terminal et lancer :

```sh
npm --prefix staging run uber:reports-browser
```

4. Dans la fenêtre dédiée, se connecter manuellement à Uber et terminer les éventuelles vérifications du compte. Le profil privé `staging/.local/uber-reports-browser/profile` conserve cette session ; une nouvelle connexion n'est demandée que si elle expire ou si Uber l'exige. Aucun nouveau code d'association Ludy n'est nécessaire.
5. Laisser le navigateur dédié, son terminal et le serveur Ludy fonctionner pour les passages suivants. Ce navigateur est séparé du navigateur habituel et de la Live Map.

Un bail local de **90 secondes**, renouvelé pendant le suivi, réserve la collecte des rapports à un seul navigateur. Tant qu'il est actif, le serveur refuse les imports de rapports de l'extension pour empêcher deux collectes simultanées ; le suivi des chauffeurs continue. Il ne faut pas réactiver **Activer les rapports** dans l'extension pendant ce workflow. Le collecteur de rapports de l'extension 0.6.6 reste une solution alternative lorsque le navigateur dédié est arrêté, décrite dans [son guide](uber-extension/README.md).

L'extension 0.6.6 refuse la génération des rapports lorsque son navigateur utilise un autre fuseau que `Africa/Casablanca` ; cette restriction ne concerne pas la Live Map. Utiliser le navigateur dédié Ludy évite de modifier le fuseau du poste. Le lecteur vérifie la colonne visible **Report time range** avant le nom du fichier : un ancien export généré à l'heure de Paris ne remplace pas un rapport demandé à l'heure du Maroc. Si Uber ne permet pas la dernière borne, la collecte conserve une fenêtre de sept journées complètes décalée d'un jour, indiquée dans le journal. La borne de fin est minuit du lendemain, exclusive.

Une session expirée, un formulaire non reconnu, une période ambiguë ou un téléchargement invalide demande une intervention ; aucune donnée n'est inventée. Le navigateur utilise Chromium fourni par Playwright, avec son sandbox activé et le fuseau `Africa/Casablanca`. Il vérifie aussi les décalages horaires réels du navigateur contre le référentiel commun pour la date actuelle et les bornes de la période : un navigateur dont les règles sont anciennes est refusé. La génération et le téléchargement des trois types de CSV ont été vérifiés sur le compte réel le 3 novembre 2026. Les premiers exports créés à l'heure de Paris restent archivés sans import ; les exports corrigés sont distincts.

En cas d'échec de reconnaissance, **État de la collecte → Éléments du formulaire reconnus** indique les contrôles repérés, absents ou ambigus. Le diagnostic conserve uniquement des catégories prédéfinies et des compteurs bornés : aucun texte de page, valeur de champ, HTML ou URL de téléchargement n'est transmis dans ce diagnostic. Il est effacé dès que le rapport quitte l'état d'échec. Le détail complet de la page Uber reste dans le navigateur.

Le **2 novembre 2026 à 15 h 26 UTC**, le diagnostic réel de la version **0.6.4** indiquait, pour les trois rapports, un type de rapport non repéré (`report_type: 0`) et un seul contrôle repéré pour chaque date, l'organisation et le bouton Generate. Aucun CSV n'avait été importé. Le relevé privé `.local/uber-report-form-diagnostic-064-2026-11-02.json` conserve ces catégories et compteurs, sans contenu de formulaire. Ce constat motive le correctif 0.6.5 ; il ne constitue pas une validation de sa réception ni de l'import.

La réception reconnaît les en-têtes du rapport et les statuts des courses. Elle importe les courses terminées et annulées, déduplique les reprises et sépare les villes uniquement si l'adresse de prise en charge les nomme explicitement. Les villes ambiguës ou non configurées sont exclues et comptées ; la ville n'est pas déduite de l'agence du chauffeur. Les tables d'analyse ignorent les contacts et champs non nécessaires. Les fiches chauffeur utilisent l'UUID exact du rapport ou, seulement en son absence, un nom complet unique dans la même flotte. Ce nom sert au rapprochement. Les deux villes sont enregistrées dans une seule transaction locale ; un échec ne laisse pas un demi-rapport importé.

**Copies locales des CSV** : après validation du format et avant l'import en base, chaque export accepté est conservé **intégralement** dans `staging/.local/uber-reports/files/<organisation>/`. Ces fichiers gardent donc aussi les colonnes écartées des tables d'analyse. Leur nom est généré par le serveur à partir du type de rapport, de la période et de l'empreinte SHA-256 ; un contenu identique pour la même organisation, le même type et la même période ne crée pas de doublon.

Les reçus dans `staging/.local/uber-reports/receipts/` indiquent `pending`, `imported` ou `failed`, avec les dates, la taille et l'empreinte, sans contenu CSV ni message libre. Le fichier reste disponible après un import réussi ou échoué pour contrôle local. Les dossiers sont en **0700**, les fichiers en **0600**, ignorés par Git et non servis par HTTP ; aucune purge automatique n'est activée. Les exports sont limités à **6 Mio**. Ce stockage dédié n'explore pas et ne conserve pas le dossier général **Téléchargements**.

**Validation réelle du 3 novembre 2026** : les exports corrigés couvrent le **26 octobre au 1er novembre inclus**, soit `2026-10-26T00:00:00Z` → `2026-11-02T00:00:00Z` exclusive. Activité et Qualité contiennent chacun **37 lignes, dont 25 associées et 12 non rapprochées**. Leur rejeu a conservé deux journaux et 25 synthèses par type, sans doublon. Le CSV Courses corrigé contient **1 704 lignes** et reste archivé, sans analyse, car ses heures n'indiquent aucun fuseau explicite. Le réglage `csv_timezone` reste non confirmé ; la capture du résumé chauffeur ne suffit pas à identifier l'heure de demande ou de dépose d'une course précise. La preuve agrégée est dans `.local/checks/uber-real-validation-2026-11-03.json`.

La migration `20261222000000_uber_report_identity_promotion.sql` relie un UUID du rapport à une identité Live Map provisoire uniquement sur un nom complet normalisé exact et unique dans la flotte et le CSV, avec une fiche Ludy déjà rapprochée et une agence concordante. Elle conserve l'identité de collecte, les choix manuels, les affectations et la fraîcheur des statuts ; un UUID contradictoire ou un rapprochement incertain est refusé. La preuve est journalisée. La prochaine lecture Live Map conserve l'UUID confirmé et le rejeu des archives peut compléter les synthèses sans générer un nouvel export.

Dans cette installation, la flotte Uber connue et les agences des deux villes sont déjà configurées. Le format initial est **année / mois / jour**, pour refuser les dates numériques jour/mois ambiguës tant que le format réel de l'export n'est pas connu. Un format local différent se choisit explicitement dans cet écran ; les horodatages ISO restent reconnus. La période du rapport est vérifiée côté serveur. La relecture après six heures peut intégrer les corrections d'un export déjà disponible sans multiplier les demandes de génération.

**Analyse des courses Uber** (`#/demande`) présente les heures, jours et zones de prise en charge observés, ainsi que les annulations. Les recommandations exigent au moins cinq courses réparties sur trois journées pour une zone/créneau ; un échantillon global inférieur à trente courses ou trois journées est signalé. Ce sont des tendances historiques des courses de cette flotte, pas une mesure exhaustive de la demande Uber ni une prévision en direct. Aucun résultat n'est inventé avant le premier import. L'import manuel CSV/Excel reste disponible en recours.

## Performance d'un chauffeur

**Performance chauffeur** (`#/performance-chauffeur`) propose un chauffeur, une plateforme et une période de 31 jours maximum, à l'heure du Maroc. Le journal présente les courses reçues, leurs étapes et les points de prise en charge/dépose disponibles, sans reconstituer un itinéraire. Les montants restent séparés par devise ; prix de course, pourboires et frais ne sont pas additionnés arbitrairement. Gains nets, primes, commissions et revenu horaire restent indisponibles sans données suffisantes.

Le bouton **Période du rapport Uber** choisit la dernière période réellement importée pour la fiche accessible, y compris lorsque la disponibilité Uber impose un jour de décalage. Les dates saisies manuellement ou transmises dans un lien sont conservées. Les périodes de plusieurs organisations ne sont pas fusionnées et aucun prorata n'est appliqué aux bilans officiels.

- **Bolt** : le collecteur d'historique utilise la pagination et relit automatiquement les courses toutes les quinze minutes lorsque le suivi Bolt fonctionne. **La première collecte réelle a réussi : 106 courses importées et synchronisation sans erreur des sept fiches Bolt connues lors de la vérification du 2 novembre 2026.** Elle a suivi la correction du format des dates demandé par Bolt, sans millisecondes. Le premier passage demande les sept derniers jours ; les suivants relisent aussi les deux jours précédant la dernière couverture pour recevoir d'éventuelles corrections. Les nombres évoluent avec la collecte et ne représentent pas tout l'historique du compte. Chaque fiche indique les périodes effectivement synchronisées et les mesures renseignées. Le suivi des statuts et l'historique des courses restent deux flux distincts ; un échec de lecture ne signifie pas zéro course.
- **Uber** : Trip activity alimente les courses associées avec certitude ; Driver activity et Driver quality complètent les heures et taux officiels pour la **période exacte** du rapport, sans prorata. Les trois rapports ne fournissent pas à eux seuls un bilan financier. Une distance sans unité reste inconnue et la durée demande → fin n'est pas assimilée au temps avec passager. Les rapports Activité et Qualité du 26 octobre au 1er novembre 2026 inclus ont été reçus en conditions réelles le 3 novembre ; le CSV Courses reste archivé en attente de confirmation du fuseau de ses colonnes horaires.

L'activité observée par Ludy (course, approche, attente, pause, hors ligne) indique sa couverture et reste distincte des rapports officiels. La **connexion observée inclut les pauses déclarées**. Le **temps actif hors pause** additionne l'attente, l'approche et la course ; l'occupation observée est la part de ce temps passée en course. Une interruption ne devient ni attente ni pause ; un statut hors ligne ne prouve pas une pause. Les métriques partielles affichent leur nombre de courses renseignées et les droits par agence s'appliquent à toute la fiche.

Le [catalogue public Bolt Fleet](https://developer.bolt.eu/versions/114.0.0/docs/fleet-integration/main.yaml) ne fournit pas de bilan de gains nets, de commissions ou de taux officiel d'acceptation. L'[historique documenté](https://developer.bolt.eu/versions/114.0.0/docs/fleet-integration/spec/components/Order.yaml) fournit les résultats des demandes, durées, distances et composantes du prix lorsqu'ils sont renseignés. L'acceptation affichée par Ludy est un calcul sur les demandes non optionnelles reçues, avec son dénominateur et ses exclusions, pas le taux officiel du portail. Les [états courants Bolt](https://developer.bolt.eu/versions/114.0.0/docs/fleet-integration/spec/components/OnlineDriver.yaml) permettent d'observer l'attente et la pause ; ils ne fournissent pas rétroactivement une durée complète de connexion. Les devises de trois lettres sont normalisées en majuscules et leurs montants restent séparés.

## Interface chauffeur et notifications de consommation

**Signalements chauffeurs** (`#/communaute`, administrateur) crée un accès individuel pour un chauffeur existant. Le code personnel aléatoire est affiché une seule fois ; sa réinitialisation ou sa révocation coupe aussi les sessions existantes. Le chauffeur utilise **http://127.0.0.1:4173/chauffeur.html** sur cet ordinateur. Cet accès reste local : ce lien ne rend pas le portail accessible depuis un téléphone ou à distance sans l'hébergement prévu séparément.

Le portail est indépendant de la session de gestion Ludy : signaler une situation, consulter ses propres signalements et recevoir ses propres notifications. Il n'offre aucun accès au parc, aux autres chauffeurs, aux contrats ou aux données des agences. Le gestionnaire examine les signalements dans Ludy. Les notifications sont actualisées lorsque le portail est ouvert ; aucune notification système ou push avec le navigateur fermé n'est encore mise en place.

**Notifications consommation** (`#/eco-conduite`) compare la consommation réellement mesurée par les compteurs Geotab à la référence L/100 km de chaque véhicule. Par défaut : dépassement de **30 %**, après au moins **10 km** mesurés, avec **60 minutes** entre deux notifications pour le même épisode. Ces paramètres sont modifiables par un administrateur. Une référence véhicule renseignée, des compteurs récents et cohérents, une affectation chauffeur/boîtier certaine et un accès chauffeur actif sont nécessaires. Les changements d'affectation, remises à zéro ou interruptions de mesure interrompent le calcul ; une nouvelle mesure recommence. Les tentatives reprises après une erreur ne créent pas de doublon.

Les références manquantes sont calculées automatiquement sur **sept journées marocaines complètes**, à partir d’au moins **100 km** et de différences de compteurs Geotab cohérentes aux mêmes bornes. Une valeur manuelle n’est jamais écrasée. La preuve conserve période, distance, litres, dates des compteurs et boîtier ; la référence reste fixe pendant les futures mesures. La collecte partage le client Geotab et respecte sa pause, avec un passage quotidien et une reprise espacée après erreur. Premier relevé réel du 2 novembre : **8 références calculées sur 16 véhicules équipés** ; huit historiques insuffisants et trois véhicules sans boîtier restent à renseigner.

Le 2 novembre, **36 accès chauffeurs** ont été créés pour des fiches connues du staging. Les codes destinés à une remise personnelle restent uniquement dans `.local/driver-access-2026-11-02.json` (0600, ignoré par Git, jamais servi par HTTP). Aucun message ni code n’a été envoyé aux chauffeurs. Le portail et les données de flotte restent séparés.

Le message décrit une surconsommation mesurée et conseille une conduite souple. Il ne prétend pas en connaître la cause : une accélération seule ne prouve pas une surconsommation.

## Événements Casablanca et Marrakech

**Événements** (`#/evenements`) est désormais un agenda **manuel**. L’administrateur renseigne un titre, une adresse, la ville et les horaires à l’heure du Maroc, puis ajoute et valide l’événement. Les filtres ville/période, la modification et la suppression restent disponibles. Une modification concurrente est signalée et une création réessayée après une réponse interrompue ne produit pas de doublon.

La collecte externe est désactivée et son ancien point d’entrée ne relance aucun fournisseur. Les 21 annonces collectées ont été retirées de la base locale le 2 novembre 2026 après sauvegarde privée. La migration conserve les événements manuels et interdit la réintroduction d’annonces collectées. Aucun événement ne crée automatiquement de créneau de rush.

## Rotation des véhicules entre deux chauffeurs

**Rotations des véhicules** (`#/rotations`) distingue le temps de chaque remise en route, la moyenne par agence/ville et la durée de remise en route de tout un groupe de retours. Le calcul principal utilise le **retour effectif** du contrat précédent et le **départ effectif** du contrat suivant, pour le même véhicule et deux chauffeurs distincts. Une date de retour prévue n'est jamais utilisée comme retour réel.

MyClicar fournit les contrats actifs et, toutes les cinq minutes, l'historique des retours des sept derniers jours. L'historique reçu est conservé localement ; choisir une période de trente et un jours n'implique pas que trente et un jours aient déjà été collectés. Les informations manquantes, doublons et chevauchements sont signalés. Une estimation à partir des connexions de plateforme reste séparée des mesures contractuelles et des moyennes mesurées.

Pour chaque groupe de shift (repères 7 h / 19 h à l'heure du Maroc), la durée globale va du **premier retour au dernier nouveau départ**. Elle n'est présentée comme terminée que lorsque tous les véhicules du groupe ont un départ confirmé ; les véhicules encore en attente restent visibles. La moyenne des durées individuelles n'est pas confondue avec cette durée globale.

## Export de références depuis la production

Le script `scripts/export-reference.mjs` prépare un extrait destiné au staging. La configuration du site continue de pointer exclusivement vers Supabase local. Aucun lien cloud n'est créé et aucune importation n'est lancée par ce script.

Pour afficher le périmètre sans établir de connexion :

```bash
npm --prefix staging run export:reference
```

Pour effectuer l'export à un moment calme :

```bash
npm --prefix staging run export:reference -- --export
```

Le client PostgreSQL `psql` (version 16 ou plus) demande le **mot de passe de la base PostgreSQL**, directement dans le terminal et sans afficher les caractères. Ce n'est pas le mot de passe du compte Supabase ni celui de Ludy. Il n'est pas enregistré, transmis à Git ou inclus dans la ligne de commande. Les caractères spéciaux peuvent être saisis tels quels. La connexion TLS vérifie le certificat et le nom du serveur.

Le pooler Supabase utilise sa propre autorité de certification. Le script fournit explicitement `scripts/certs/supabase-prod-ca-2021.crt` à `psql` et conserve `sslmode=verify-full`. Le certificat public provient de l'[URL officielle utilisée par le dashboard](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json), téléchargé en HTTPS depuis [Supabase Downloads](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt). Empreinte SHA-256 : `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`, expiration le 26 avril 2031. Son empreinte et sa validité sont contrôlées avant la demande de mot de passe. Aucun certificat système ni réglage de la base n'est modifié. Voir la [configuration officielle psql](https://supabase.com/docs/guides/database/psql).

Le périmètre est fixé : 100 agences maximum, 2 000 entrées parc, 2 000 véhicules, 5 000 chauffeurs, 500 règles et 2 000 contrats ayant commencé au cours des 30 derniers jours. Si une limite est dépassée, le script refuse l'extrait incomplet et ne relance aucune lecture. Les noms, identifiants, plaques et dates utiles sont conservés ; les téléphones, e-mails, commentaires, comptes Auth, paramètres externes et automatismes sont exclus. Les contrats plus anciens, les trajets et les documents Storage ne sont pas copiés : **ce n'est pas une sauvegarde complète**.

Les requêtes SQL sont consultables dans `scripts/export-reference.sql`. Elles s'exécutent dans une transaction `READ ONLY`, avec une connexion, sans parallélisme de lecture, une limite de 15 secondes par instruction et une attente de verrou limitée à une seconde. L'export ne modifie pas les données de production, mais consomme des ressources de lecture : aucun impact nul sur les performances n'est garanti. Un échec n'est jamais réessayé automatiquement. Ces réglages sont propres à la transaction ; ils ne changent pas la configuration du serveur. Voir les paramètres [PostgreSQL](https://www.postgresql.org/docs/18/runtime-config-client.html) et le client [psql](https://www.postgresql.org/docs/18/app-psql.html).

Le fichier validé est créé sous `.local/exports/` en mode privé `0600`, dans un dossier `0700` ignoré par Git et non servi par le site. Il contient des données métier : ne pas le publier ni le coller dans une conversation. Son chemin et les nombres de lignes suffisent pour préparer son import exclusivement dans le staging. Aucun `npx skills add` n'est nécessaire.

## Import local de la copie

La copie du **30 octobre 2026 est déjà importée** dans cette installation : 2 agences, 11 entrées parc, 11 véhicules, 71 chauffeurs, 454 contrats et 69 règles. Les 49 contrats dont la référence véhicule n'apparaît pas dans cet extrait conservent leur clé historique ; aucun véhicule manquant n'a été inventé. Le compte administrateur local et les quatre identités de plateforme déjà présentes ont été conservés. Le rapprochement automatique relie les correspondances certaines ; les cas ambigus restent dans la page Associations.

Les compteurs et dates de contrats des fiches importées sont recalculés uniquement à partir des contrats présents dans la base locale, sans rapprochement automatique des identités. L'écran Chauffeurs rappelle que l'extrait initial couvre 30 jours : ces compteurs ne représentent pas l'historique complet de production.

Le script `scripts/import-reference.mjs` lit uniquement un export existant sous `staging/.local/exports/`. **Il ne se connecte jamais à la production.** Utiliser un chemin absolu, car `npm --prefix staging` exécute le script depuis le dossier `staging`.

Pour valider le fichier sans accéder à la base :

```bash
npm --prefix staging run import:reference -- /home/tibo/projet/flotte-geotab/staging/.local/exports/reference-2026-10-30T11-59-52-572Z-41b92b11-284e-4900-874c-43758de7dc03.json
```

Pour vérifier les contraintes et le résultat dans une transaction **locale**, annulée par `ROLLBACK` à la fin :

```bash
npm --prefix staging run import:reference -- /home/tibo/projet/flotte-geotab/staging/.local/exports/reference-2026-10-30T11-59-52-572Z-41b92b11-284e-4900-874c-43758de7dc03.json --check
```

Pour sauvegarder puis appliquer l'import local — déjà effectué pour ce fichier :

```bash
npm --prefix staging run import:reference -- /home/tibo/projet/flotte-geotab/staging/.local/exports/reference-2026-10-30T11-59-52-572Z-41b92b11-284e-4900-874c-43758de7dc03.json --apply
```

La destination est fixée : socket Docker local `/var/run/docker.sock`, conteneur `supabase_db_ludy-staging`, puis socket PostgreSQL interne. Le script vérifie le label Docker du projet `ludy-staging`, la configuration locale et le marqueur `environment=staging` en base avant l'import. Il n'accepte aucune URL distante de destination.

Avec `--apply`, une sauvegarde complète de la base locale est créée dans `.local/backups/` et contrôlée avec `pg_restore --list` avant toute modification des données. Les six tables de référence sont ensuite importées dans une transaction ; les identifiants existants sont mis à jour sans créer de doublons. Seules les fiches de démonstration initiales encore intactes et inutilisées peuvent être retirées. Les autres données locales sont conservées, notamment les comptes Auth, profils, observations et sessions `fleet_*`, réglages et automatismes existants. Aucun automatisme de production n'est importé ou activé ; seul le repère local `reference_snapshot_at` est ajouté ou actualisé dans les paramètres.

Le rapport `.local/reference-import.json` conserve la date de l'extrait, son empreinte, les nombres de lignes et le chemin de sauvegarde. Rapport, sauvegardes et éventuels diagnostics restent privés, ignorés par Git et non servis par le site. L'extrait source n'est pas modifié. L'import ne raccorde ni Geotab ni MyClicar et ne relance aucun export.

## Vérifications

Le contrôle navigateur s'exécute sur le staging démarré avec son compte local. Il vérifie les parcours sur ordinateur et mobile, la navigation, les écrans de connexion Uber et l'historique lorsqu'une source a déjà remonté des chauffeurs. Par défaut, il ne régénère pas de code d'appairage et ne modifie pas les réglages. Il ne démarre pas de fournisseur externe. Les captures restent dans `.local/screenshots/` (elles peuvent contenir les données réelles remontées).

```bash
node staging/tests/workspace.e2e.mjs
```

Pour inclure volontairement les tests qui régénèrent le code d'appairage Uber et écrivent les réglages locaux :

```bash
LUDY_E2E_MUTATIONS=1 node staging/tests/workspace.e2e.mjs
```

Après l'import du 30 octobre, les six tables ont été comparées champ par champ à l'extrait, une deuxième simulation `--check` a confirmé la stabilité des nombres de lignes, et les 38 parcours navigateur sur ordinateur et mobile ont réussi.

Depuis la racine du dépôt, les tests autonomes utilisent des fournisseurs simulés et des données fictives :

```bash
node --test staging/scripts/*.test.mjs staging/tests/*.test.mjs
```

La surveillance des déconnexions est couverte par les calculs de service, les transitions en ligne/hors ligne, la persistance et l'interface. Pour isoler ces vérifications :

```bash
node --test staging/tests/service-duty.test.mjs \
  staging/tests/platform-disconnections.test.mjs \
  staging/tests/platform-disconnection-service.test.mjs \
  staging/tests/disconnections-ui.test.mjs \
  staging/tests/disconnections-ui-browser.test.mjs
```

Avant l'application de sa migration, le contrôle SQL suivant simule celle-ci et les incidents fictifs dans une transaction locale entièrement annulée par `ROLLBACK`, avec `safeupdate` et les rôles réels de la base :

```bash
node staging/tests/disconnection-alerts.integration.mjs --with-migration
```

Une fois la migration appliquée, lancer le même contrôle **sans** `--with-migration`. Il vérifie notamment les droits, la déduplication, la suspension, la résolution et la conservation de l'historique. Ces tests n'appellent aucun fournisseur et ne valident pas à eux seuls un incident réel.

Les tests de l'extension nécessitent Chromium à `/usr/bin/chromium`, ou un chemin fourni par `LUDY_TEST_CHROMIUM`. Pour vérifier l'Auth, les accès par agence et le rapprochement des identités sur la pile locale démarrée :

```bash
node staging/tests/fleet-local.integration.mjs
node staging/tests/myclicar-local.integration.mjs
node staging/tests/automatic-vehicle-assignments.integration.mjs
node staging/tests/automatic-associations.e2e.mjs
```

Le premier contrôle crée des entrées fictives uniques puis les supprime. Le contrôle MyClicar utilise une transaction entièrement annulée, avec la protection PostgreSQL `safeupdate` activée comme dans l'API locale. Aucun de ces contrôles n'appelle de fournisseur externe. Pour régénérer les archives d'installation Uber après une modification de l'extension :

```bash
node staging/uber-extension/build.mjs
```

Les nouvelles fonctions d'exploitation disposent aussi de contrôles SQL locaux annulés par `ROLLBACK`, à lancer après les migrations :

```bash
node staging/tests/operations-growth.integration.mjs
node staging/tests/driver-portal.integration.mjs
node staging/tests/driver-sessions.integration.mjs
node staging/tests/rotation-history.integration.mjs
node staging/tests/myclicar-inventory.integration.mjs
node staging/tests/inventory-current-bindings.integration.mjs
node staging/tests/parking.integration.mjs
node staging/tests/driver-performance.integration.mjs
node staging/tests/uber-driver-reports.integration.mjs
node staging/tests/uber-reports.integration.mjs
node staging/tests/rotations-local.e2e.mjs
```

Le dernier contrôle lit les données locales de rotation avec une session de gestion ; il ne déclenche ni synchronisation fournisseur, ni écriture, ni notification.

Pour diagnostiquer un échec de Docker, consulter `.local/supabase-start.log`. Ne pas utiliser `supabase link`, `db push` ou une URL cloud dans cet environnement. Le lancement est fondé sur le [développement local Supabase](https://supabase.com/docs/guides/local-development) et le CLI [2.122.0](https://github.com/supabase/cli/releases/tag/v2.122.0), fixé dans `package-lock.json`.

## À faire

Suivi de la validation d'utilisation :

- [x] **Pauses et rush** : règles par agence/ville, pauses explicitement observées, prise en compte de l'autre plateforme et rappels internes.
- [x] **Analyse Uber** : imports dédupliqués, tendances par zone/jour/heure et recommandations avec contrôle de l'échantillon.
- [x] **Rapports automatiques Uber 0.6.6** : trois types séparés, sept journées complètes, relecture toutes les six heures, contrôles de période, rapprochement chauffeur certain et import local dédupliqué.
- [x] **Archivage local des rapports** : CSV entiers en fichiers privés, reçus séparés, écriture atomique, déduplication et conservation après import. Le navigateur dédié évite d'utiliser le dossier Téléchargements habituel ; sa validation réelle reste à effectuer.
- [ ] **Premiers rapports Uber réels** : les liaisons 0.6.3 puis 0.6.4 ont été reçues, mais aucun CSV réel n'a encore été importé. Le diagnostic 0.6.4 identifie le menu du type de rapport comme seul contrôle non reconnu pour les trois rapports. Arrêter les rapports de l'extension, lancer le navigateur dédié et valider la connexion, le téléchargement, les fichiers privés, les dates, les identités et les unités. La réception de la liaison et les tests simulés ne valident pas ce parcours complet.
- [x] **Portail chauffeur** : accès individuel distinct de l'Auth de gestion, propres signalements/notifications seulement, renouvellement atomique et révocation des sessions.
- [ ] **Diffusion aux chauffeurs** : 36 accès créés, codes conservés dans le fichier privé indiqué ci-dessus ; préparer un hébergement privé puis remettre individuellement les accès. Le serveur actuel reste local ; les notifications nécessitent le portail ouvert.
- [x] **Notifications de consommation** : mesure Geotab, référence véhicule, affectation vérifiée, seuils réglables et déduplication. Huit références ont été calculées ; compléter les références manquantes reste nécessaire pour couvrir tous les véhicules. Les 36 accès chauffeurs créés ne remplacent pas la vérification de l'affectation courante.
- [x] **Événements manuels** : titre, adresse obligatoire, ville, horaires Maroc, validation explicite, modification et suppression ; les 21 annonces collectées ont été retirées après sauvegarde privée.
- [x] **Rotations** : retours/départs effectifs MyClicar, moyenne par véhicule/agence/ville et remise en route des lots de shift, estimations séparées. Lecture locale vérifiée sur 129 rotations mesurées ; les observations facultatives ne bloquent plus le rapport contractuel.

- [x] **Parc complet MyClicar** : agences, véhicules actuels et archives distingués, lecture bornée toutes les cinq minutes, détails contractuels vérifiés et départs de toutes les agences accessibles. Relevé de préparation : 19 véhicules actuels, 13 contrats en cours ; les totaux évoluent avec la source.
- [x] **Compteurs du cockpit** : personnes distinctes Uber/Bolt, véhicules GPS, positions récentes et parc total séparés ; profils sans position visibles, scénario 14 chauffeurs / 11 GPS / 19 voitures couvert en navigateur.
- [x] **Rapprochements Geotab** : plaque/VIN certains après inventaire, contradiction de VIN refusée, dissociations manuelles conservées ; aucun appel catalogue à chaque inventaire.
- [x] **Catalogue Geotab avec VIN** : le relevé final du 2 novembre compte 16 véhicules associés à Geotab sur 19 au parc. Les trois autres restent sans boîtier associé ; une association ne garantit pas une position récente. Les nombres évoluent avec le parc et les associations.
- [x] **Parc et zones** : parc complet, parking Luxury Casablanca actif, présences et franchissements vérifiés, configuration locale par agence ; aucune exclusion mondiale activée en bloc.
- [x] **Disponible hors zone** : zones Casablanca/Marrakech actives en mode indicatif, disponibilité et affectation certaines, deux GPS sur au moins cinq secondes, union des zones de l'agence, badges et notifications internes. La collecte locale des alertes se renouvelle toutes les cinq secondes.
- [x] **Ajustement des contours** : Modifier dans Parc et zones, déplacer les sommets, puis enregistrer ; mention indicative conservée tant que la précision reste à vérifier.
- [ ] **Précision des zones** : affiner les limites issues des captures avec des repères confirmés. Les ordres de grandeur 750 m / 1 km ne constituent pas une précision garantie ; l'utilisation indicative est déjà active.
- [x] **Parking Marrakech** : périmètre indicatif de 65 m près de M Avenue, reconstitué à partir de quatre retours avec GPS concordants et de l'adresse MyClicar ; actif dans le staging.
- [ ] **Limites des parkings et exclusions** : préciser le contour exact du parking Marrakech et sélectionner uniquement les exclusions opérationnelles propres à chaque agence.
- [x] **Performance chauffeur** : fiche Bolt/Uber, journal des courses reçues, couverture des observations et séparation des métriques officielles, observées et indisponibles.
- [x] **Historique Bolt réel** : première collecte réussie le 2 novembre 2026, 106 courses importées et sept fiches connues synchronisées sans erreur. La couverture reste limitée aux périodes effectivement lues, avec les mesures manquantes indiquées ; ce flux reste distinct des statuts.
- [x] **MyClicar** : connexion HTTP et compte Luxury séparés, lecture complète des contrats en cours, rapprochement exact des références locales et affectations expirables.
- [x] **Lecture réelle MyClicar du 30 octobre 2026 à 19 h 04 (Paris)** : 10 contrats actuellement actifs, tous rapprochés des profils suivis. Le nombre varie avec les départs et retours ; les lectures antérieures comptaient 11 contrats.
- [x] **Associations de shift automatiques** : priorité aux plaques live, contrats écartés durablement pour leur affectation courante, mode véhicule automatique distinct de la fiche choisie. Les contradictions de chauffeurs simultanés suspendent l'affectation ; les preuves expirées ne sont pas prolongées rétroactivement. Une fiche chauffeur liée ne suffit pas à confirmer son véhicule actuel.
- [x] **Connecteurs automatiques** : intention active/pause persistée, reprise après redémarrage, premier échec réessayé, retours tardifs ignorés et prochaine tentative affichée.
- [x] **Extension Chromium Uber 0.6.6** : liaison persistante, reprise après panne, plaques visibles et rechargement Live Map toutes les vingt minutes après transmission, reporté pendant une interaction.
- [x] Préparer le connecteur MyGeotab local : saisie privée des accès, association explicite des boîtiers, démarrage et pause du suivi des positions, de la vitesse et du contact.
- [x] Saisir le compte MyGeotab dédié, vérifier les accès réels et valider la collecte sur la carte. La première validation portait sur 11 véhicules ; le catalogue actuel en associe 16.
- [x] **Geotab** : positions/contact à cadence cible de 2 s, compteurs distance/carburant du jour et événements de conduite. Validés avec les lectures réelles le 30 octobre 2026 ; l'horodatage du boîtier reste la référence de fraîcheur.
- [x] **Geotab** : historique détaillé, vitesses autour d'une alerte, rapports par véhicule et CSV. Premières lectures réelles vérifiées sur les 11 véhicules du périmètre initial.
- [x] Alerte critique au-delà de 200 m après confirmation hors ligne des comptes Uber/Bolt connus : mesure GPS, suspension des données incertaines, preuves, droits par agence et affichage interne testés. Rappel hors ligne/contact mis disponible.
- [x] Rapprochement automatique des noms complets uniques, preuves de plaque récentes, protection des corrections manuelles et traçabilité. Le relevé final compte 31 profils suivis liés à une fiche Ludy sur 32 ; le dernier rapprochement incertain n'est pas forcé.
- [x] **Uber 0.4.0 réellement observé** : un parcours complet de la liste a transmis les 11 chauffeurs, au-delà des dix premières lignes.
- [x] **Plaques Uber 0.5.0 réellement reçues** : relevé du 31 octobre 2026 à 12 h 37 (Paris), 11 chauffeurs actuels dont 9 avec plaque, modèle et horodatage distinct.
- [ ] **Uber 0.6.6 sur la durée** : la génération et le téléchargement des trois rapports ont été vérifiés avec le navigateur dédié. Restent la confirmation du fuseau du CSV Courses et une observation continue des changements de chauffeur et des reprises Live Map. Les tests simulés ne valident pas tous les scénarios réels.
- [ ] **Observation continue sur 24 heures** : la collecte du 30 au 31 octobre est terminée mais incomplète : 422 mesures, 7 heures réellement observées et deux interruptions représentant environ 17 heures. Aucune contradiction persistante n'a été confirmée dans les mesures disponibles ; ce rapport ne valide pas une journée continue. Prévoir une nouvelle observation complète après les corrections.
- [ ] **Validation d'une alerte en conditions réelles** : le rapport précédent a détecté un incident réel de déplacement pendant la collecte. Sa présence ne suffit pas à confirmer la justesse du signalement ; examiner ses preuves et les nouveaux cas après les corrections.
- [x] **Recette du front sur ordinateur et mobile** : dernière passe réussie sur 38 routes du poste de travail, 22 contrôles des écrans d'exploitation et 36 contrôles des nouvelles vues. Focus conservé pendant les actualisations, fermeture de fiche accessible sur mobile et compteurs périmés masqués.
- [x] Copier le référentiel autorisé dans Supabase local : extrait du 30 octobre 2026 importé, avec sauvegarde locale préalable et conservation des comptes et observations existants.
- [x] **Audit des associations** : 31 des 32 profils suivis sont rapprochés d'une fiche Ludy ; un profil reste à identifier avec certitude. Ce total décrit le référentiel des profils, pas le nombre de chauffeurs actuellement en ligne. Les affectations de voitures restent conditionnées aux preuves actuelles.

### Relevé local du 2 novembre 2026

Lors du relevé à 14 h 13 (Paris), le parc comptait 19 véhicules, dont 16 associés à Geotab : 11 positions étaient récentes et cinq anciennes ou manquantes. Les trois véhicules sans boîtier associé étaient comptés séparément. Les 13 contrats MyClicar en cours étaient rapprochés. Parmi 13 chauffeurs en ligne, neuf avaient une affectation courante confirmée et quatre attendaient une identification certaine de leur véhicule. Il s'agit d'un instantané ; ces nombres évoluent pendant les shifts.

Le relevé de clôture confirme 16 véhicules associés à Geotab sur 19, 31 profils suivis liés sur 32, huit références de consommation et 36 accès chauffeurs créés. Ces accès n'ont pas été distribués. Une liaison Uber 0.6.3 avait été reçue. Le diagnostic réel 0.6.4 du 2 novembre à 15 h 26 UTC confirme ensuite trois échecs de reconnaissance du type de rapport ; aucun CSV réel n'est encore importé. Le correctif 0.6.5 reste à valider dans le navigateur. Le relevé Bolt de 14 h 13 comptait 107 courses reçues et sept fiches synchronisées, des totaux susceptibles d'évoluer avec la collecte.

Les créneaux de rush sont configurés. Les 21 événements collectés ont été retirés pour laisser place à l’agenda manuel. Les deux zones d'exploitation indicatives et le parking Casablanca sont actifs ; le parking Marrakech et l'accès distant des testeurs restent à préparer. Le serveur actuel écoute uniquement sur `127.0.0.1:4173`.

### Validation d’exploitation

Dans **Connecteurs → Observation sur 24 heures**, le serveur lit son cache local toutes les 60 secondes. Ce contrôle ne déclenche aucun appel supplémentaire à Uber, Bolt, Geotab ou MyClicar et ne crée aucune observation fictive. Le rapport privé `.local/validation-24h.json` ne conserve que des compteurs, horodatages et états des sources, sans noms, identifiants de chauffeurs, coordonnées GPS ni secrets.

Le suivi reprend après redémarrage. Une absence de mesure de plus de 90 secondes compte comme interruption ; une journée écoulée n’est pas comptée comme une journée observée. Le rapport distingue la fin de collecte, les heures effectivement couvertes, les lectures partielles et les incohérences rencontrées lors de contrôles successifs. Il indique séparément si un nouvel incident réel de déplacement a été observé. Les scénarios automatisés ne constituent pas une validation sur un incident réel.

Le premier rapport de contrôle du démarrage est conservé dans `.local/validation-demarrage-*.json`. Son interruption a permis de corriger la planification après redémarrage : la prochaine mesure conserve désormais son échéance. La fenêtre de 24 heures ci-dessus a été lancée après cette correction, avec les quatre sources à jour.

La vérification Bolt du 30 octobre 2026 a confirmé **1 société, 4 chauffeurs actifs et 3 véhicules**, avec des totaux de pagination concordants. Ce périmètre correspond aux sociétés accessibles à la clé API, conformément à la [documentation Bolt Fleet](https://developer.bolt.eu/fleet-integration/main/). Une page courte ne termine plus prématurément la lecture ; les doublons, totaux changeants et résultats incomplets sont refusés.

Les rejeux des alertes couvrent le retour en ligne sur l’autre plateforme, les 200 m, les changements de contrat/chauffeur, les redémarrages et les trous de validité d’affectation. Une nouvelle preuve ne prolonge plus rétroactivement une preuve expirée. Les nouveaux incidents conservent leurs observations de plateforme, l’affectation et la santé des sources à l’ouverture, séparément de leurs mises à jour.

### Audit et corrections du 2 novembre 2026

Les contrôles portent sur le staging local, les automatismes, les droits par agence, l’affectation des véhicules, les sessions, les importations et les interfaces sur ordinateur/mobile. Les rapports réels Uber dépendent encore de la reconnaissance complète de l’interface du compte et sont suivis séparément des tests simulés.

La dernière exécution complète, antérieure au correctif de reconnaissance des formulaires 0.6.4, compte **712 tests JavaScript réussis sur 712**, **24 suites d'intégration SQL réussies**, puis **22 assertions supplémentaires** sur le périmètre des organisations Uber. La validation ciblée de la version **0.6.4** compte ensuite **17 tests du serveur et de l'interface** et **38 tests du lecteur de rapports** réussis. La version **0.6.5** passe ensuite **45 tests ciblés**, notamment les libellés séparés, les menus personnalisés, la priorité des libellés explicites et l'exclusion des dates comme sélecteurs de rapport. L'API commune d'import et l'archivage des CSV passent **28 tests ciblés** ; ils ne valident pas encore la connexion ni le téléchargement dans le navigateur dédié réel. Ces contrôles recouvrent en partie la suite complète et ne s'ajoutent pas à son total. La recette navigateur passe sur **38 routes**, **22 contrôles d'exploitation** et **36 contrôles des nouvelles vues**, sur ordinateur et mobile. Ces résultats ne remplacent ni le premier import Uber réel ni une observation continue complète sur 24 heures.

Corrections vérifiées : conservation des historiques pendant les fusions de chauffeurs, références provenant de contrats terminés vérifiés, levée des fausses contradictions après identification confirmée, arrêt des cumuls de distance pendant une interruption et suspension durable des anciennes urgences après pause/reprise. Les réponses tardives des connecteurs ne réactivent plus un service fermé. Les insertions PostgREST réussies avec réponse vide ne deviennent plus des erreurs affichées après enregistrement.

La navigation garde les marqueurs, les fenêtres et les filtres pendant les actualisations. Les résultats d’une ancienne session ou d’un ancien filtre ne remplacent plus la sélection actuelle. Le portail conserve son brouillon entre onglets, l’efface à la déconnexion et interdit un double envoi pendant une requête. Les heures marocaines utilisent les règles partagées, même lorsque la base horaire du navigateur est ancienne.

**Dépendances** : le staging sert son propre client Supabase **2.118.0**, avec version et intégrité verrouillées ; les dépendances de production restent inchangées. SheetJS **0.18.5** a été remplacé le 3 novembre par la version officielle **0.20.3**, conservée avec son empreinte dans [`vendor/`](vendor/README.md) et incluse dans le bundle serveur. Les imports CSV/XLS/XLSX restent analysés dans un Worker jetable sans réseau, avec limites de taille/décompression/lignes/cellules, délai de quinze secondes et annulation de session. Seules des grilles de valeurs primitives reviennent à la page.

Les journaux de vérification sont privés : `.local/audit-unit-tests-final.log`, `.local/audit-sql-tests.log` et `.local/dependency-audit.json`. Les tests de base utilisent des transactions annulées ou des données temporaires supprimées ; ils ne constituent pas une garantie d’absence de défaut sur tous les scénarios réels.

### Partager le staging avec des testeurs, gratuitement

Le partage utilise un [Quick Tunnel Cloudflare](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), destiné aux essais : lien HTTPS temporaire, sans compte Cloudflare ni nom de domaine. Le PC, Docker, Ludy et le terminal de partage doivent rester ouverts. Le lien change à chaque lancement et cesse de fonctionner à l’arrêt. Ce mode n’est pas un hébergement permanent ; Cloudflare ne garantit pas sa disponibilité. `cloudflared` est déjà installé sur ce poste.

Depuis `/home/tibo/projet/flotte-geotab`, garder Ludy démarré, puis ouvrir un deuxième terminal :

```bash
npm --prefix staging run share -- --check
npm --prefix staging run share
```

`--check` vérifie uniquement le serveur local, le marqueur de la base staging et l’installation de `cloudflared`. La seconde commande ouvre réellement le lien. Le fichier privé `staging/.local/share-access.json` contient `inviteUrl`, le lien avec son code d’accès. Copier ce champ pour les testeurs choisis ; le code placé après `#` est retiré de l’adresse par la page d’accueil et remplacé par une session de partage de huit heures. Le champ `url` seul affiche un formulaire demandant le code. Chaque testeur doit ensuite se connecter avec son compte Ludy personnel. Aucun identifiant administrateur n’est inclus dans le lien.

Créer un compte de consultation pour un testeur, en remplaçant l’adresse d’exemple :

```bash
npm --prefix staging run tester:create -- --email testeur@example.com --all-agencies
```

Pour limiter ce compte, remplacer `--all-agencies` par `--agency ID`, éventuellement répété. La commande génère un mot de passe aléatoire et indique le fichier privé `staging/.local/testers/<identifiant>.json` à ouvrir pour le transmettre individuellement. Elle n’envoie aucun e-mail, ne réinitialise aucun compte existant et n’attribue jamais le rôle administrateur. Les identifiants restent séparés de ceux de production. Les testeurs voient les données du staging correspondant aux agences autorisées, y compris les données réelles déjà importées dans cet environnement.

Pour retirer ensuite l’accès, reprendre le champ `userId` du fichier du testeur :

```bash
npm --prefix staging run tester:create -- --disable IDENTIFIANT_DU_TESTEUR
```

**Arrêter le partage :** `Ctrl+C` dans son terminal. Cela ferme la passerelle et les connexions temps réel, invalide le code de ce lancement et arrête le tunnel. Ludy reste utilisable localement. Le fichier de partage est marqué inactif et ne conserve plus le code. Si le PC s’éteint ou perd sa connexion, le lien devient indisponible ; relancer la commande produit un nouveau lien et un nouveau code.

La passerelle écoute uniquement sur `127.0.0.1:4174`. Elle sert le site et les routes Supabase nécessaires sous une même origine HTTPS, en conservant le JWT utilisateur et les droits de la base locale. Elle ne contient aucune clé de service. Studio, PostgreSQL, la boîte de courriels de test, les fichiers `.local`, les identifiants des connecteurs, la réception de l’extension et le navigateur des rapports ne sont pas publiés. La configuration des collecteurs reste sur le poste de l’opérateur. Les sessions Uber, la Live Map et le navigateur des rapports continuent à fonctionner sur ce poste pendant les tests à distance.

Le partage du portail chauffeur et les chargements de nouveaux documents Storage ne sont pas inclus dans ce mode d’essai ; les testeurs de consultation peuvent lire les documents déjà disponibles. Pour une démonstration du dessin des zones, l’administrateur peut utiliser son propre compte dans le lien protégé ; les comptes testeurs de consultation ne peuvent pas modifier les zones.

Validation locale du partage et des zones, le 2 novembre 2026 : **148 tests ciblés réussis sur 148** (passerelle, comptes testeurs, éditeur de zones, archivage, rapports et vues utilisant les appels API), plus **36 assertions SQL d’archivage avec transaction annulée**. Une session navigateur a traversé la passerelle avec le vrai serveur local : connexion Ludy et page Parc et zones fonctionnelles, sans erreur JavaScript ni requête HTTP en échec. Ce contrôle simule l’origine HTTPS localement ; aucun tunnel Internet n’a été ouvert pendant la recette. Journal : `.local/checks/final-share-zones-reports.log`.

Le navigateur dédié aux rapports gère également le cas où plusieurs téléchargements arrivent ensemble et la fermeture pendant une lecture. Le premier CSV réel n’est toujours pas confirmé : la dernière session s’est arrêtée lorsque son onglet principal Uber a été fermé. Relancer `npm --prefix staging run uber:reports-browser`, se connecter à Uber puis laisser Reports ouvert permet de poursuivre cette vérification ; une suite de tests réussie ne remplace pas cet import réel.
