# Déployer Ludy

## Site web et PC collecteur

La version web **0.1.0** reprend l’interface et les données de Ludy. Chaque navigateur ouvre sa session Supabase personnelle avec les droits de son agence. Le PC fixe conserve l’application et les connexions aux fournisseurs. Le site affiche leur état et les observations partagées ; il ne crée aucun collecteur, ne démarre aucun navigateur Uber et n’utilise aucune session du PC fixe pour les collègues.

Le serveur web écoute uniquement **127.0.0.1:4180**. Il est indépendant du serveur de l’application, qui reste sur **127.0.0.1:4173**. Un reverse proxy HTTPS doit conserver le Host public configuré. L’adresse HTTPS est contrôlée strictement ; les en-têtes `X-Forwarded-*` et les identités Tailscale ne remplacent jamais le JWT Ludy. Chaque requête vérifie l’utilisateur et son rôle courant. Les observateurs techniques des administrateurs sont distincts, désactivés et ne prennent aucun bail de collecte.

Les lectures métier, les éditions manuelles et les réglages centraux autorisés restent disponibles. La connexion aux fournisseurs, les imports directs Geotab, les commandes de navigateur Uber et les synchronisations fournisseur se font sur le PC collecteur. Le portail chauffeur à code personnel n’est pas publié par ce serveur web staff. Les accès RH conservent leurs pages et leurs règles existantes.

La migration additive [`fleet-source-health.sql`](fleet-source-health.sql) a été appliquée le 5 novembre au projet de production existant. Les contrôles SQL des rôles administrateur, gestionnaire et consultation ont réussi : ils peuvent lire un résumé borné de santé, sans accès supplémentaire à la table brute réservée aux administrateurs. Il n’est pas nécessaire de rejouer les migrations historiques pour installer le site.

### Construire et démarrer le site

Depuis la racine du dépôt :

```bash
node staging/scripts/build-web.mjs --check
node staging/scripts/build-web.mjs --out /chemin/neuf/Ludy-Web-0.1.0
```

Le constructeur copie une liste fermée de sources, suit leurs imports, installe les dépendances verrouillées sans scripts npm, vérifie les imports du runtime et produit `build-manifest.json` avec les empreintes SHA-256. Il refuse de remplacer une livraison existante. Il ne copie ni configuration opérateur, ni session, ni identifiants fournisseur, ni clé privilégiée. Le paquet fonctionne avec Node.js ; le binaire Node est fourni séparément.

Créer hors du paquet un JSON contenant exactement `environment` (`production`), `projectRef`, `supabaseUrl`, `publishableKey` (clé publique uniquement) et `webOrigin` (origine HTTPS exacte, sans slash final). Conserver un dossier d’état propre au site, hors du programme et des profils de l’application. Puis, depuis le paquet :

```bash
node web-runtime/main.mjs --config /chemin/web-public.json --state-dir /chemin/etat-web-prive
```

La route locale `http://127.0.0.1:4180/health` permet de vérifier le processus sans ouvrir une session. Les pages et les API utilisent l’origine HTTPS configurée. Pour un serveur Linux/VPS, lancer cette commande dans un service système dédié et placer le reverse proxy HTTPS devant le port local. La base reste le Supabase existant.

### Démarrage automatique sur le PC Windows

Exécuter `web-runtime/windows/install.ps1` depuis un PowerShell élevé **sous le compte Windows qui possédera le site**. Fournir les chemins absolus `-RuntimeRoot`, `-NodePath`, `-ConfigPath`, `-StateDir`, l’empreinte officielle `-NodeSha256` et l’empreinte du manifeste de livraison `-ManifestSha256`.

L’installateur vérifie les fichiers, prépare les permissions du dossier privé, refuse un port 4180 occupé ou une tâche existante et crée `LudyWeb-0.1.0`. Cette tâche utilise le compte Windows courant avec un jeton limité et le mode S4U, sans mot de passe enregistré, au démarrage du PC. Le contrôle vérifie le serveur et le processus qui possède le port. En cas d’échec, seule la nouvelle tâche est retirée. Le journal privé `web-service.log` contient les démarrages et codes de sortie, sans sorties brutes des services. Le 5 novembre, l’installation native et le démarrage S4U ont réussi sur le PC fixe ; la page répond 200 et une API sans connexion répond 401. La reprise après un redémarrage réel du PC reste à vérifier.

Pour un accès privé, [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) peut publier le port 4180 en HTTPS dans le réseau Tailscale. Les collègues doivent alors avoir accès à ce réseau. Un accès public nécessite un proxy ou tunnel public configuré pour ce serveur web, ou un hébergement VPS avec une adresse HTTPS ; le serveur desktop 4173 reste local.

Le PC doit rester allumé, connecté et sans mise en veille. Le démarrage automatique du site ne remplace pas la session interactive nécessaire aux collecteurs et à Uber ; la collecte continue dépend de cette session et de la validité des accès fournisseur. Une installation terminée ne constitue pas une validation de fonctionnement sur 24 heures.

## Historique des applications et migrations initiales

Chaque application Ludy 0.2.4 contient son serveur local. Les postes utilisent le même Supabase de production et les comptes Ludy existants. Un seul poste administrateur participant détient le bail de collecte ; les autres consultent les données partagées et peuvent prendre le relais. Il faut laisser au moins un poste préparé, connecté et éveillé pour poursuivre la collecte.

Cette architecture ne demande pas de VM. Elle conserve les données, Auth, Storage et les services Apps Script existants. Le serveur embarqué écoute seulement `127.0.0.1:4173`. Les applications contiennent la configuration publique Supabase ; aucune clé `service_role` n'est installée sur les postes.

**État au 4 novembre 2026 : schéma déployé et vérifié sur `flotte_luxury` (`cgiiwumbblimvmrypxlc`).** La migration `20261104103135_ludy_embedded_desktop_0_2_0` a été appliquée par le plugin Supabase. Les trois tables desktop, les huit RPC et leurs droits passent le contrôle ; les 50 tables historiques, leurs protections et les deux fonctions propres à la production sont conservées. Leurs nombres de lignes sont identiques avant/après, sauf `params` qui reçoit le marqueur `environment=production`. Ces comptages ne prouvent pas que chaque ligne est inchangée pendant les écritures concurrentes.

Le [relevé de déploiement](../.local/production/deployment-2026-11-04.json) conserve les contrôles et les empreintes. Une sauvegarde physique du 4 novembre à 06:47:42 UTC est visible dans le tableau de bord fourni par l’utilisateur ; aucune restauration réelle n’a été effectuée. Les services existants sont restés actifs pendant le lot atomique, avec une attente de verrou limitée à cinq secondes. **Ne pas rejouer le lot de promotion sur ce projet.**

La version **0.2.2** rétablit la page de téléchargement de l’extension Uber et ajoute le formulaire des accès API Bolt sur chaque poste. Elle distingue la configuration locale des données partagées et affiche les échecs de lecture sans faux succès. Elle corrige aussi le chargement des modules Windows PowerShell lorsque Node est lancé depuis PowerShell 7. La mise à jour conserve le profil utilisateur existant et ne demande aucune nouvelle migration.

La version **0.2.3** ajoute le mode poste permanent Windows et le renouvellement de la connexion Ludy en arrière-plan. Sur le PC fixe disposant déjà d’un profil privé, elle a échoué au démarrage lors d’une réécriture des permissions Windows (`SeSecurityPrivilege`). **Installer 0.2.4** : cette version vérifie les permissions existantes et évite cette réécriture lorsqu’elles sont déjà conformes. Le profil est conservé ; aucune nouvelle migration n’est nécessaire.

| Cible | Paquet à installer |
| --- | --- |
| Windows x64 | [Ludy Windows 0.2.4](../.local/livraison-collegues/Ludy-Windows-0.2.4.zip) |
| Mac Apple Silicon | [Ludy Mac Apple Silicon 0.2.4](../.local/livraison-collegues/Ludy-Mac-Apple-Silicon-0.2.4.zip) |
| Mac Intel | [Ludy Mac Intel 0.2.4](../.local/livraison-collegues/Ludy-Mac-Intel-0.2.4.zip) |

Les archives Mac sont produites par le workflow [Ludy macOS et contrôle Windows](../../.github/workflows/ludy-embedded-macos.yml), sur leurs architectures natives, avec contrôle de signature ad hoc et réextraction du ZIP. Le [run 41936911823](https://github.com/awt-707/flotte-geotab/actions/runs/41936911823), construit depuis `832592ba2629535c1854f46a2ed3fe1ec51c281d`, a réussi les deux contrôles Mac et les **57 tests Windows natifs**. Ces tests CI n’ouvrent aucune session fournisseur réelle. Les applications Mac ne sont pas notariées et leur interface reste à tester sur un Mac pilote.

**Vérifications sur le PC fixe Windows au 5 novembre 2026, 00:02 UTC :** l’installation 0.2.4 et le démarrage du serveur local ont réussi dans la session interactive normale, avec un jeton Windows `Limited`. La fenêtre a été masquée à 00:00:24 puis rouverte à 00:01:49, sans changement du processus ni du serveur. Pendant cet intervalle, le bail a été renouvelé, Bolt et les contrats MyClicar ont été actualisés, et une nouvelle observation Uber LiveMap a été reçue. Les trois composantes MyClicar — contrats, inventaire et historique — sont en état `healthy` ; huit contrats sont associés et huit restent non associés. Le signalement « À connecter » concernait Geotab desktop, volontairement désactivé pendant le maintien d’Apps Script. Une archive brute Teksat de 21 778 octets a été conservée ; cela ne valide pas le calcul de kilomètres ou de carburant. Les rapports Uber et Earnings ne sont pas encore configurés. **Aucun fonctionnement continu sur 24 heures ni renouvellement JWT de longue durée n’est encore validé sur le PC réel.** Le [reçu 0.2.4](../.local/releases/embedded-desktop/delivery-0.2.4.json) et le [contrôle des collectes](../.local/production/pc-fixe-ssh/production-collection-check.json) séparent les preuves de construction, les essais sur le poste et leurs limites.

À 00:03:41 UTC, l’alimentation Geotab existante continuait d’actualiser `live_status` (19 lignes, 16 véhicules associés). Elle fournit les données sans configuration Geotab chez les collègues. Le nouveau panneau desktop ne reconnaît toutefois pas encore cette alimentation comme sa propre source ; le transfert complet et les fonctions récentes qui en dépendent restent à valider.

La livraison précédente 0.2.0 et son [relevé](../.local/releases/embedded-desktop/delivery-2026-11-04.json) sont conservés dans `staging/.local/releases/embedded-desktop/`. Les 1 400 tests de cette livraison restent le socle de régression ; le correctif 0.2.2 ajoute des vérifications ciblées des connecteurs, du stockage privé et du téléchargement depuis le paquet réel.

## Première mise en service avec les services existants

### Poste Windows permanent (0.2.4)

Pour un profil Windows existant, utiliser **0.2.4 ou plus récent** : 0.2.3 peut échouer au démarrage en tentant de réappliquer les permissions déjà correctes du dossier privé. La correction vérifie strictement ces permissions et évite cette réécriture lorsqu’elles sont conformes. Ludy continue de fonctionner sous la session Windows normale, sans demander de lancement administrateur.

La version 0.2.3 ajoute le menu natif **Ludy → Mode poste permanent**. Ce mode est désactivé par défaut. Après activation, Ludy démarre à l’ouverture de la session Windows, sa fenêtre se ferme vers l’icône près de l’horloge et la veille automatique est empêchée tant que Ludy tourne. L’écran peut s’éteindre. **Quitter Ludy** arrête toujours l’application et ses collecteurs. Garder le dossier contenant `Ludy.exe` à un emplacement stable ; ouvrir une nouvelle version met à jour le chemin de démarrage.

Le renouvellement de la connexion Ludy reste actif en arrière-plan dans l’application de production. Une déconnexion, une révocation du compte ou une session fournisseur expirée demande toujours une reconnexion. Aucun mot de passe Windows ni jeton de renouvellement supplémentaire n’est enregistré par ce mode.

Sur le PC fixe : se connecter avec un compte administrateur Ludy, configurer et vérifier les fournisseurs, puis laisser **Application → Participer à la collecte** activé. Sur les postes des collègues, laisser cette participation désactivée : ils consultent les données partagées sans configurer les fournisseurs.

Ce mode ne crée pas de session Windows après un redémarrage. Il faut ouvrir la session du compte de collecte ; Ludy se lancera ensuite. Uber LiveMap demande en plus un onglet visible et une session Uber valide. Le navigateur des rapports Uber utilise sa propre connexion. Vérifier les nouvelles dates de collecte après fermeture de la fenêtre Ludy, verrouillage de Windows et déconnexion de l’outil de contrôle à distance. L’accès distant au PC ne prouve pas à lui seul la continuité des fournisseurs.

La construction du paquet, les tests automatisés et les collectes observées sur le PC fixe sont consignés séparément. La continuité après redémarrage, verrouillage et sur une durée de 24 heures reste à vérifier. **Geotab desktop reste désactivé** pendant cette installation ; les services Apps Script existants restent actifs.

Le paquet [Windows à transmettre aux collègues](../.local/livraison-collegues/Ludy-Windows-0.2.4.zip) est accompagné des [instructions d’installation 0.2.4](../.local/livraison-collegues/INSTALLER-LUDY-0.2.4.txt) et du [guide du PC fixe](../.local/livraison-collegues/INSTALLER-LUDY-PC-FIXE-0.2.4.txt). Conserver la participation désactivée chez les collègues qui consultent seulement. Ils utilisent leurs comptes Ludy existants et n’ont pas besoin des identifiants fournisseurs.

**Conserver Apps Script et laisser Geotab desktop désactivé lors de cette première mise en service.** Les autres connecteurs desktop peuvent être configurés sur le poste administrateur désigné. Le bail desktop arbitre les nouvelles applications ; il ne bloque pas les écritures de l’ancien collecteur Apps Script.

La lecture du collecteur existant confirme que son unique déclencheur traite aussi les courriels, PDF, jobs, caisse Sheets et RH/Drive. `arreter()` arrête cet ensemble. Il n’existe pas de pause Geotab seule : `liveMin=0` ne désactive pas la collecte. Apps Script conserve aussi l’alimentation historique que le desktop ne remplace pas entièrement.

Avant d’activer Geotab desktop, il reste à déléguer les écritures de `live_status` et des associations `vehicles.geotab_id/geotab_name` avec la protection SQL ciblée décrite plus bas. L’ancien rapprochement ne respecte pas le nouveau verrou manuel `geotab_auto_link_disabled`. Le relais Edge Geotab n’écrit pas ces tables ; fermer l’ancien onglet « En direct » arrête ses lectures automatiques. Cette première mise en service ne valide donc pas encore le remplacement complet de Geotab par les applications.

## 1. Préparation de la base — déjà exécutée sur ce projet

Cette section décrit la préparation conservée pour revue. Le déploiement réel a utilisé `promote-mcp.sql`, qui reprend exactement le corps du lot dans une instruction `DO` atomique. Les essais avec et sans transaction externe ont vérifié l’annulation complète après une erreur injectée à la fin des DDL. Le fichier original `promote-draft.sql` reste inchangé. L’historique distant et les contrôles après migration confirment l’application ; ne pas relancer les instructions ci-dessous sur cette production.

L'inventaire fourni, capturé le 4 novembre à 08:30 UTC sur PostgreSQL 17.11, correspond au socle historique pour les tables, colonnes, contraintes, droits, politiques, index et publications concernés. Le complément confirme deux fonctions spécifiques : `mission_guard`, qui garde la validation administrative des devis, et `rls_auto_enable`, appelée par `ensure_rls` pour protéger les nouvelles tables. Elles doivent être conservées. Le marqueur `params.environment` est actuellement nul ou absent.

Le générateur prépare **42 variantes métier et 4 ajouts desktop**, sans rejouer les **37 migrations historiques**, sans seed et sans importer les comptes de test. Les ajouts desktop partagent l'état Geotab et installent les droits de collecte et d'administration. Les variantes retirent la réparation immédiate des affectations d'agence et refusent une migration qui effacerait des événements existants.

Depuis la racine du dépôt :

```sh
# Génération locale uniquement : aucune connexion Supabase de production.
node staging/production/prepare.mjs
```

Les entrées privées sont `staging/.local/production/production-inventory-2026-11-04.json` et `production-function-review-2026-11-04.json`. Les sorties sont dans `staging/.local/production/preparation/` :

- [promote-draft.sql](../.local/production/preparation/promote-draft.sql) : transaction complète à relire avant exécution, avec fichier `.sha256` ;
- `variants-manifest.json` : empreintes et transformations des sources ;
- `rehearsal-report.json` et `rehearsal-atomic-report.json` : répétitions locales et conservation des données synthétiques.

Le SQL contrôle le catalogue avant les modifications, préserve les fonctions propres à la production et initialise le marqueur `production` seulement après ces vérifications. Une valeur `staging` ou un catalogue différent provoque un arrêt. Une erreur dans la transaction annule l'ensemble du lot. Ne pas contourner un refus ni exécuter les variantes une par une pour le faire passer.

Avant d'exécuter ce fichier dans le SQL Editor du **même projet Supabase** :

1. Conserver une sauvegarde restaurable de la base, des comptes et des documents, puis répéter sur une copie privée des données réelles. Les essais locaux avec des lignes synthétiques ne remplacent pas cette restauration.
2. Définir une courte fenêtre sans écritures et suspendre les collecteurs concernés. Conserver la version précédente et la configuration des services existants.
3. Exécuter le fichier entier, après revue du lot et de sa somme SHA-256. Attendre le message `Ludy production schema promotion committed`. Puis exécuter [verify-deployment-editor.sql](verify-deployment-editor.sql) dans une nouvelle requête : le résultat attendu est `ok = true`. Ce contrôle est en lecture seule et vérifie la présence des objets et leurs droits ; les parcours utilisateurs restent à tester sur le poste pilote avant d’activer un collecteur.

Pour une future évolution, exporter un nouvel inventaire avec `migrations-inventory-editor.sql` et refaire la comparaison. Le générateur n’a aucune option d’application distante. Son manifeste de préparation conserve ses réserves initiales ; l’état réellement appliqué est consigné séparément dans le relevé de déploiement, sans prétendre qu’une restauration des données réelles ou la bascule complète de Geotab a été testée.

## 2. Installer les applications

### Windows

Fermer Ludy, extraire **tout** le ZIP `Ludy-Windows-0.2.4.zip` dans un nouveau dossier utilisateur, puis lancer `Ludy.exe`. Garder les DLL et le dossier `resources` à côté de l'exécutable. Node.js, Docker et Supabase local ne sont pas nécessaires sur le PC utilisateur. Le paquet n’est pas signé. Les tests Windows natifs et le lancement sur le profil existant du PC fixe ont réussi ; les parcours métier et la durée d’observation vérifiés sont précisés dans le reçu de livraison.

### Linux

Extraire tout le ZIP `Ludy-0.2.4-Linux-x64-….zip` et lancer `Ludy`. Le démarrage du vrai paquet, sa connexion au serveur embarqué et son arrêt sont testés dans un réseau isolé. Cette recette ne se connecte pas à Supabase de production.

Le port 4173 doit être libre : fermer l'ancien staging local avant de lancer la nouvelle application. Ludy refuse de remplacer un service déjà présent sur ce port.

### Mac

Le workflow [Ludy macOS et contrôle Windows](../../.github/workflows/ludy-embedded-macos.yml) construit deux archives contenant directement **Ludy.app** : **Apple Silicon** (`arm64`) et **Intel** (`x64`). Il se déclenche après le push de ces fichiers sur la branche `staging`. Les collègues utilisant ces archives n’ont pas besoin de Node.js ni de construire l’application.

La variable GitHub `LUDY_DESKTOP_PUBLIC_CONFIG` est configurée sur le dépôt avec l’adresse et la clé publique validées du Supabase de production. Le workflow refuse un autre projet et toute clé privilégiée. Il utilise uniquement les sources suivies et les dépendances verrouillées ; il n’exécute aucune migration ni collecte et ne reçoit aucun secret fournisseur.

Chaque archive est construite sur un Mac de son architecture, signée ad hoc, réextraite et vérifiée avant publication dans les artifacts du workflow. Le contrôle indépendant vérifie les exécutables Mach-O, les permissions, les liens, les ressources et la signature. Il ne lance pas l’interface : le premier lancement et la connexion restent à vérifier sur un Mac pilote. Les artifacts sont conservés sept jours ; conserver une copie locale du ZIP livré et de sa somme SHA-256.

Sur le Mac, ouvrir **À propos de ce Mac** pour choisir Apple Silicon lorsque la ligne « Puce » affiche Apple M1/M2/M3/etc., ou Intel lorsque la ligne « Processeur » indique Intel. Quitter l’ancienne application et déplacer son éventuelle copie dans Téléchargements avant d’extraire le nouveau ZIP : le chemin de lancement doit désigner la nouvelle **Ludy.app**. Utiliser le compte Ludy habituel et conserver la participation à la collecte désactivée sur les postes de consultation.

Cette construction ne possède pas de certificat **Developer ID** ni de notarisation Apple. Pour la livraison vérifiée extraite dans Téléchargements, le lancement demandé utilise uniquement cette copie :

```sh
xattr -cr ~/Downloads/Ludy.app
open ~/Downloads/Ludy.app
```

La première commande supprime les attributs étendus de cette application ; la seconde la lance. L’alternative graphique est **Réglages Système → Confidentialité et sécurité → Ouvrir quand même**. Un Mac administré peut refuser cette exception. Voir [les instructions Apple](https://support.apple.com/fr-fr/102445). Une distribution reconnue directement par Gatekeeper demande encore le certificat Developer ID et la notarisation.

Le **kit de sources embarqué 0.2.0** reste disponible pour construire localement : installer Node.js 22.12 minimum sur le Mac, extraire le kit, puis taper `sh ` dans Terminal et y glisser `Preparer Ludy Mac.command`. L’ancien kit 0.1.1 ne contient pas le serveur embarqué.

Depuis un checkout préparé sur le Mac, les commandes équivalentes sont :

```sh
npm --prefix staging ci
npm --prefix staging/desktop ci
# Apple Silicon ; remplacer macos-arm64 par macos-x64 pour un Mac Intel.
node staging/scripts/build-embedded-desktop.mjs \
  --config /chemin/desktop-public.json --target macos-arm64 --mac-local-test
```

Pour reconstruire les ZIP sur le poste de préparation :

```sh
node staging/scripts/build-embedded-desktop.mjs --config staging/.local/production/desktop-public.json --target windows-x64
node staging/scripts/build-embedded-desktop.mjs --config staging/.local/production/desktop-public.json --target linux-x64
node staging/scripts/build-embedded-mac-kit.mjs
```

Chaque ZIP possède un fichier `.sha256`. Depuis leur dossier, `sha256sum -c nom.zip.sha256` vérifie Linux et `shasum -a 256 -c nom.zip.sha256` vérifie macOS ; sous Windows, comparer `Get-FileHash .\nom.zip -Algorithm SHA256` au fichier fourni.

La configuration ne contient que `environment`, `projectRef`, `supabaseUrl` et `publishableKey`. Le builder exige l'URL canonique du projet et refuse une clé privilégiée. La construction Mac et le contrôle de son archive sont exécutés en CI ; son premier lancement et ses parcours métier restent à vérifier sur le Mac utilisateur.

## 3. Préparer les postes qui pourront collecter

**Prérequis de la version 0.2.8 :** appliquer une seule fois [fleet-source-health.sql](fleet-source-health.sql) dans une transaction sur la base cible avant d’installer les nouveaux clients. Ce complément expose aux profils validés uniquement l’état technique des quatre sources. Il ne modifie ni les lignes métier, ni les politiques et permissions de `fleet_sources` ; les anciens collecteurs restent compatibles. Un schéma ou une fonction déjà présents font échouer l’installation pour permettre leur inspection. Les contrôles locaux des rôles et de compatibilité s’exécutent avec `node staging/tests/fleet-source-health.integration.mjs` et annulent leurs données de test. Le fonctionnement réel avec plusieurs utilisateurs reste à vérifier après déploiement.

Se connecter avec son compte **Ludy de production**. Les comptes du staging ne sont pas transférés. La participation est désactivée au premier lancement ; seuls les administrateurs peuvent l'activer dans **Application → Participer à la collecte**. Les autres utilisateurs consultent les données selon leurs droits et agences.

Préparer et tester les postes de secours **à tour de rôle** : suspendre temporairement la participation du premier, faire participer le second, puis configurer et vérifier ses sources. Certaines commandes de connexion fournisseur exigent que le poste détienne déjà le bail. Une fois la préparation terminée, laisser participer seulement les postes complets. Le bail ne vérifie pas automatiquement que tous les fournisseurs sont configurés : un poste incomplet peut l'acquérir et empêcher un autre de collecter.

Les secrets et sessions fournisseurs restent propres au poste et au compte Ludy. Ils ne sont pas synchronisés par Supabase et ne figurent pas dans les ZIP. Ne pas copier `desktop.json` ou le profil Ludy complet entre ordinateurs : l'identifiant du poste doit rester unique.

| Système | Dossier privé du projet |
| --- | --- |
| Windows | `%APPDATA%\Ludy\<projectRef>` |
| macOS | `~/Library/Application Support/Ludy/<projectRef>` |
| Linux | `$XDG_CONFIG_HOME/Ludy/<projectRef>` ou `~/.config/Ludy/<projectRef>` |

Les configurations d'un utilisateur sont dans `users/<UUID Auth Ludy>/` sous ce dossier. Les permissions sont limitées au compte système ; elles ne constituent pas un chiffrement des fichiers. Éviter de faire itinérer ou synchroniser ce profil entre PC.

Pour chaque poste de collecte :

- **MyClicar** : renseigner ses accès dans Connecteurs, activer la source et vérifier son état et ses associations. **Geotab desktop reste désactivé lors de la première mise en service décrite plus haut** ; son activation attend la délégation des écritures depuis Apps Script.
- **Bolt** : ouvrir **Connecteurs → Bolt**, renseigner l’identifiant client et le secret de l’API Bolt Fleet, puis **Enregistrer les accès sur ce poste**. Cet enregistrement local ne vérifie pas encore les accès et ne démarre pas la collecte. Dans **Application**, activer la participation et attendre **Collecte active sur ce poste**, puis activer le suivi Bolt. Vérifier la date de dernière lecture et les véhicules suivis ; un échec avec reprise automatique reste affiché comme avertissement. Les anciens fichiers `bolt.env` restent lisibles et les accès ne sont jamais intégrés aux ZIP.
- **Uber Reports/Earnings** : configurer la flotte, puis utiliser **Connecter Uber** dans Application. Un navigateur dédié s'ouvre ; la connexion et les validations Uber se font normalement. L'application télécharge son navigateur au premier besoin. Connecter aussi les postes de secours individuellement. Laisser désactivé l’ancien collecteur Rapports de l’extension lorsque ce navigateur dédié est utilisé.
- **Uber LiveMap** : installer et associer l'extension locale à ce poste, ouvrir la bonne flotte dans un onglet visible et conserver une session Uber valide. Le navigateur dédié aux rapports ne remplace pas cette vue LiveMap. Lorsqu’une transmission est refusée parce que le poste attend le bail, l’extension suspend ses lectures et rafraîchissements automatiques. Elle vérifie le statut local une fois par minute et reprend lorsque ce poste devient actif. La page Uber peut conserver son propre fonctionnement indépendant de l’extension. Après une déconnexion Ludy qui invalide l’association, associer de nouveau l’extension. L’option de reprise automatique concerne la réouverture de son onglet ; elle ne remplace pas une connexion Uber expirée.
- **Teksat** : configurer `texat.json` avec les propriétés `TEXAT_SOCIETE`, `TEXAT_EMAIL` et `TEXAT_PASSWORD`, ainsi que `texat-scope.json` avec la filiale et l’empreinte du compte et les preuves d’association validées dans `texat-mapping-evidence.json`. Ne pas inventer ces preuves pour activer la source. La conservation des positions brutes est disponible ; le basculement normalisé automatique attend encore les preuves de fuseau, GPS et compteurs décrites dans [le contrat Teksat](../docs/texat-integration.md).

La connexion Uber de la LiveMap et celle du navigateur dédié sont distinctes : les préparer toutes les deux sur chaque poste. Pour Bolt, Geotab et MyClicar, utiliser aussi **Démarrer/Activer** dans Connecteurs ; les identifiants présents sur disque ne suffisent pas à activer leur reprise.

## 4. Vérifier la reprise entre deux postes

1. Sur le poste A préparé, activer la participation. Vérifier **Collecte active sur ce poste**, puis la date des nouvelles observations dans les vues partagées.
2. Sur le poste B préparé, activer la participation. Il reste en attente pendant que A collecte. Vérifier que B voit les mêmes nouvelles données et respecte les agences de l'utilisateur.
3. Suspendre la participation de A ou quitter Ludy. Vérifier que B devient actif et que les dates de collecte continuent à progresser.
4. Refaire l'essai en coupant le réseau ou en mettant A en veille. La reprise peut attendre l'expiration du bail de **90 secondes**, puis la prochaine tentative de B. La LiveMap de l’extension peut ajouter jusqu’à une minute d’attente avant sa prochaine vérification locale. Le renouvellement normal a lieu toutes les **25 secondes** ; le client cesse de travailler avant sa limite conservatrice de 70 secondes sans renouvellement.
5. Rouvrir A : il doit attendre tant que B détient le bail. Vérifier aussi une déconnexion Ludy et une session fournisseur expirée.

La barrière SQL refuse les écritures d'une ancienne génération, même si une requête revient tard. Elle ne peut pas annuler un appel fournisseur déjà parti. Les navigateurs Uber peuvent demander une nouvelle validation humaine ; la reprise ne contourne pas cette connexion.

Sous macOS, fermer la dernière fenêtre laisse normalement l'application ouverte ; utiliser **Ludy → Quitter** pour arrêter aussi le serveur. Si tous les postes sont arrêtés, endormis, déconnectés de Ludy ou sans réseau, les données déjà enregistrées restent disponibles dans Supabase, mais la collecte s'interrompt.

## 5. Organiser la bascule des services existants

Conserver Apps Script pour les courriels, PDF, `jobs`, devis, manifestes et fonctions RH/Drive encore utilisés. Une demande de rapport ou de courriel dans l'application de production peut déclencher un véritable envoi via ce service.

Identifier séparément les lectures Geotab encore déclenchées par l'ancien site, la fonction `geotab-live` et Apps Script. Suspendre seulement les collectes faisant doublon lors de leur remplacement. Ne pas arrêter Apps Script en bloc : le serveur embarqué ne remplace pas toutes ses tâches.

### Délégation Geotab ciblée — procédure préparée, exécution à confirmer

La [migration de protection](../supabase/migrations/20261105001650_ludy_geotab_writer_delegation.sql) installe deux déclencheurs **désactivés**, sur `vehicles` et `live_status`. Leur installation seule ne transfère aucune écriture. Les fichiers ci-dessous décrivent l’opération prévue ; ils ne constituent pas un reçu de bascule.

1. Laisser Geotab arrêté dans Ludy. Installer la migration dans une transaction, puis vérifier la présence des deux déclencheurs et leur état désactivé. Ne pas rejouer une installation déjà enregistrée. Préparer et vérifier les accès Geotab, le catalogue et les associations sur le PC fixe, sans lancer la collecte.
2. Exécuter entièrement [activate-geotab-desktop.sql](activate-geotab-desktop.sql). La transaction active les deux déclencheurs après verrouillage de `vehicles`, puis `live_status` ; elle limite l’attente de verrou à cinq secondes et l’instruction à vingt secondes. Une erreur ne doit pas être contournée : attendre un succès confirmé et vérifier que les deux protections sont actives avant de démarrer Geotab.
3. Sur le poste administrateur qui détient le bail, utiliser **Connecteurs → Geotab → Démarrer**. Vérifier une lecture réussie, les associations attendues et l’arrivée de données récentes dans `fleet_sources` et `desktop_vehicle_live`. Vérifier aussi la progression des autres collecteurs et de l’historique existant. Consigner les heures, l’état des protections et les contrôles dans un reçu distinct avant de déclarer la bascule validée.

Quand les protections sont actives, les requêtes portant le rôle JWT `service_role` ne peuvent plus insérer, modifier ou supprimer les positions dans `live_status`. Sur `vehicles`, elles conservent les valeurs Geotab existantes lors d’une mise à jour et laissent les deux champs Geotab vides lors d’une création ; les autres colonnes restent modifiables. **Leurs suppressions de véhicules sont ignorées pendant la délégation**, ce qui reporte également les nettoyages ou fusions qui reposent sur ces suppressions. Ce filtre concerne toutes les requêtes `service_role` sur ces tables, pas seulement Apps Script. Les écritures desktop authentifiées restent soumises à leurs RPC et au bail de collecte.

Apps Script reste actif : son historique, ses courriels, PDF, jobs et fonctions RH/Drive continuent. La délégation SQL ne coupe pas ses appels de lecture à Geotab. Elle n’est pas un basculement automatique de secours : si le PC cesse de collecter, les protections restent actives jusqu’à un retour arrière explicite.

Pour revenir au flux existant, **arrêter d’abord Geotab dans Ludy et confirmer qu’aucun poste desktop ne le collecte**, puis exécuter entièrement [return-geotab-to-legacy.sql](return-geotab-to-legacy.sql). Cette transaction désactive uniquement les deux protections nommées, avec le même ordre de verrouillage et les mêmes délais. Ne pas utiliser `DISABLE TRIGGER ALL`. Vérifier ensuite que le flux existant reprend ses écritures de positions et d’associations ; ses suppressions de véhicules sont de nouveau autorisées. Les autres connecteurs desktop peuvent rester actifs. Aucun effacement de données ni retour arrière global du schéma n’est nécessaire.

Le workflow GitHub actuel publie le dossier racine `site/`, Apps Script et la fonction Geotab. Il ne distribue pas ces paquets desktop et n'applique pas leur SQL. Un push seul ne réalise donc pas cette bascule. Les commandes `git add`, `git commit` et `git push` restent à effectuer par l'utilisateur.

## Limites de cette livraison

- Le suivi Geotab récent, ses capteurs et événements sont partagés par Supabase. Les vues de détail, historique et rapport qui interrogent Geotab directement demandent encore le poste qui collecte.
- Le portail chauffeur accessible depuis un téléphone demande un hébergement public et son propre accès authentifié. Le serveur sur `127.0.0.1` ne le publie pas sur Internet. L'administration des comptes chauffeurs reste disponible dans Ludy.
- La collecte exige un administrateur Ludy connecté et un poste éveillé. Elle ne devient pas un service indépendant de la session de l'application.
- Windows 0.2.4 a démarré sur le PC fixe dans la session interactive normale ; Bolt, les contrats MyClicar et Uber LiveMap ont continué à recevoir des données pendant le masquage de la fenêtre. Les rapports Uber et Earnings, les contrats non associés et le suivi prolongé restent à traiter. Le premier lancement graphique et les parcours métier Mac restent à vérifier ; la signature ad hoc n’est pas une notarisation Apple.
- Les montants financiers conservent leurs preuves, leurs devises et leur couverture. Les prix observés par les API Bolt ne deviennent pas des relevés comptables, et le total Uber Earnings n'est pas assimilé au net après commissions.

## Vérifications et retour arrière

Les tests locaux couvrent l'élection concurrente de quatre postes, le refus des anciennes générations, les révocations, les droits d'agence, le transport JWT, les états Geotab partagés et la conservation des lignes historiques synthétiques. Les répétitions SQL vérifient aussi le rollback du lot complet après erreur injectée, y compris celui du marqueur d’environnement. La copie reconstruite passe désormais le contrôle exact de l’inventaire de production avec les fonctions et le déclencheur fournis. Voir [le contrat SQL](desktop-workers.md) et [l'intégration du runtime](runtime-adaptation.md).

Pour arrêter les nouvelles collectes, suspendre la participation des postes ou quitter leurs applications. Conserver les tables ajoutées et les données reçues pendant le diagnostic ; ne pas utiliser de `DROP` ni rejouer le socle historique. Le retour à l'ancien site demande de rétablir explicitement ses collectes. Restaurer une sauvegarde après de nouvelles écritures peut perdre ces dernières : préparer leur récupération avant cette opération.
