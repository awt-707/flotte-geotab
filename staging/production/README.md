# Déployer Ludy avec les collecteurs dans les applications

Chaque application Ludy 0.2.1 contient son serveur local. Les postes utilisent le même Supabase de production et les comptes Ludy existants. Un seul poste administrateur participant détient le bail de collecte ; les autres consultent les données partagées et peuvent prendre le relais. Il faut laisser au moins un poste préparé, connecté et éveillé pour poursuivre la collecte.

Cette architecture ne demande pas de VM. Elle conserve les données, Auth, Storage et les services Apps Script existants. Le serveur embarqué écoute seulement `127.0.0.1:4173`. Les applications contiennent la configuration publique Supabase ; aucune clé `service_role` n'est installée sur les postes.

**État au 4 novembre 2026 : schéma déployé et vérifié sur `flotte_luxury` (`cgiiwumbblimvmrypxlc`).** La migration `20261104103135_ludy_embedded_desktop_0_2_0` a été appliquée par le plugin Supabase. Les trois tables desktop, les huit RPC et leurs droits passent le contrôle ; les 50 tables historiques, leurs protections et les deux fonctions propres à la production sont conservées. Leurs nombres de lignes sont identiques avant/après, sauf `params` qui reçoit le marqueur `environment=production`. Ces comptages ne prouvent pas que chaque ligne est inchangée pendant les écritures concurrentes.

Le [relevé de déploiement](../.local/production/deployment-2026-11-04.json) conserve les contrôles et les empreintes. Une sauvegarde physique du 4 novembre à 06:47:42 UTC est visible dans le tableau de bord fourni par l’utilisateur ; aucune restauration réelle n’a été effectuée. Les services existants sont restés actifs pendant le lot atomique, avec une attente de verrou limitée à cinq secondes. Les collecteurs desktop ne sont pas encore configurés, et le premier lancement Windows reste à vérifier. **Ne pas rejouer le lot de promotion sur ce projet.**

La version **0.2.1** rétablit la page de téléchargement de l’extension Uber et ajoute le formulaire des accès API Bolt sur chaque poste. Elle distingue la configuration locale des données partagées et affiche les échecs de lecture sans faux succès. La mise à jour conserve le profil utilisateur existant et ne demande aucune nouvelle migration.

| Cible | Paquet à installer |
| --- | --- |
| Windows x64 | [Ludy Windows 0.2.1](../.local/livraison-collegues/Ludy-Windows-0.2.1.zip) |
| Mac Apple Silicon | [Ludy Mac Apple Silicon 0.2.1](../.local/livraison-collegues/Ludy-Mac-Apple-Silicon-0.2.1.zip) |
| Mac Intel | [Ludy Mac Intel 0.2.1](../.local/livraison-collegues/Ludy-Mac-Intel-0.2.1.zip) |

Les archives Mac sont produites par le workflow [Ludy macOS et contrôle Windows](../../.github/workflows/ludy-embedded-macos.yml), sur leurs architectures natives, avec contrôle de signature ad hoc et réextraction du ZIP. Le même workflow vérifie sur Windows la sauvegarde et la relecture des accès Bolt, ainsi que les permissions réelles du fichier. Les lancements graphiques et les connexions fournisseurs doivent encore être vérifiés sur les postes destinataires. Aucune connexion fournisseur réelle n’est effectuée par ces tests.

La livraison précédente 0.2.0 et son [relevé](../.local/releases/embedded-desktop/delivery-2026-11-04.json) sont conservés dans `staging/.local/releases/embedded-desktop/`. Les 1 400 tests de cette livraison restent le socle de régression ; le correctif 0.2.1 ajoute des vérifications ciblées des connecteurs, du stockage privé et du téléchargement depuis le paquet réel.

## Première mise en service avec les services existants

Le paquet [Windows à transmettre aux collègues](../.local/livraison-collegues/Ludy-Windows-0.2.1.zip) est accompagné des [instructions d’installation](../.local/livraison-collegues/INSTALLER-LUDY.txt). Il contient exactement la version vérifiée ci-dessus. Installer et vérifier d’abord un poste Windows pilote ; conserver la participation désactivée chez les collègues qui consultent seulement. Ils utilisent leurs comptes Ludy existants et n’ont pas besoin des identifiants fournisseurs.

**Conserver Apps Script et laisser Geotab desktop désactivé lors de cette première mise en service.** Les autres connecteurs desktop peuvent être configurés sur le poste administrateur désigné. Le bail desktop arbitre les nouvelles applications ; il ne bloque pas les écritures de l’ancien collecteur Apps Script.

La lecture du collecteur existant confirme que son unique déclencheur traite aussi les courriels, PDF, jobs, caisse Sheets et RH/Drive. `arreter()` arrête cet ensemble. Il n’existe pas de pause Geotab seule : `liveMin=0` ne désactive pas la collecte. Apps Script conserve aussi l’alimentation historique que le desktop ne remplace pas entièrement.

Avant d’activer Geotab desktop, il reste à déléguer explicitement dans Apps Script les écritures de `live_status` et des associations `vehicles.geotab_id/geotab_name`. L’ancien rapprochement ne respecte pas le nouveau verrou manuel `geotab_auto_link_disabled`. Le relais Edge Geotab n’écrit pas ces tables ; fermer l’ancien onglet « En direct » arrête ses lectures automatiques. Cette première mise en service ne valide donc pas encore le remplacement complet de Geotab par les applications.

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

Fermer Ludy, extraire **tout** le ZIP `Ludy-Windows-0.2.1.zip` dans un nouveau dossier utilisateur, puis lancer `Ludy.exe`. Garder les DLL et le dossier `resources` à côté de l'exécutable. Node.js, Docker et Supabase local ne sont pas nécessaires sur le PC utilisateur. Le paquet n'est pas signé ; la recette native Windows de ce nouveau serveur embarqué reste à effectuer.

### Linux

Extraire tout le ZIP `Ludy-0.2.1-Linux-x64-….zip` et lancer `Ludy`. Le démarrage du vrai paquet, sa connexion au serveur embarqué et son arrêt sont testés dans un réseau isolé. Cette recette ne se connecte pas à Supabase de production.

Le port 4173 doit être libre : fermer l'ancien staging local avant de lancer la nouvelle application. Ludy refuse de remplacer un service déjà présent sur ce port.

### Mac

Le workflow [Ludy macOS embarqué](../../.github/workflows/ludy-embedded-macos.yml) construit deux archives contenant directement **Ludy.app** : **Apple Silicon** (`arm64`) et **Intel** (`x64`). Il se déclenche après le push de ces fichiers sur la branche `staging`. Les collègues utilisant ces archives n’ont pas besoin de Node.js ni de construire l’application.

La variable GitHub `LUDY_DESKTOP_PUBLIC_CONFIG` est configurée sur le dépôt avec l’adresse et la clé publique validées du Supabase de production. Le workflow refuse un autre projet et toute clé privilégiée. Il utilise uniquement les sources suivies et les dépendances verrouillées ; il n’exécute aucune migration ni collecte et ne reçoit aucun secret fournisseur.

Chaque archive est construite sur un Mac de son architecture, signée ad hoc, réextraite et vérifiée avant publication dans les artifacts du workflow. Le contrôle indépendant vérifie les exécutables Mach-O, les permissions, les liens, les ressources et la signature. Il ne lance pas l’interface : le premier lancement et la connexion restent à vérifier sur un Mac pilote. Les artifacts sont conservés sept jours ; conserver une copie locale du ZIP livré et de sa somme SHA-256.

Sur le Mac, ouvrir **À propos de ce Mac** pour choisir Apple Silicon lorsque la ligne « Puce » affiche Apple M1/M2/M3/etc., ou Intel lorsque la ligne « Processeur » indique Intel. Extraire le ZIP adapté, copier **Ludy.app** dans **Applications**, puis l’ouvrir et utiliser le compte Ludy habituel. Conserver la participation à la collecte désactivée sur les postes de consultation.

Cette construction ne possède pas de certificat **Developer ID** ni de notarisation Apple. Si macOS refuse son premier lancement et si l’application provient bien de cette livraison vérifiée, suivre la procédure Apple propre à cette application dans **Réglages Système → Confidentialité et sécurité → Ouvrir quand même**. Ne pas désactiver Gatekeeper globalement ni supprimer les protections de quarantaine par commande. Un Mac administré peut refuser cette exception. Voir [les instructions Apple](https://support.apple.com/fr-fr/102445). Une distribution reconnue directement par Gatekeeper demande encore le certificat Developer ID et la notarisation.

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
- **Bolt (0.2.1)** : ouvrir **Connecteurs → Bolt**, renseigner l’identifiant client et le secret de l’API Bolt Fleet, puis **Enregistrer les accès sur ce poste**. Cet enregistrement local ne vérifie pas encore les accès et ne démarre pas la collecte. Dans **Application**, activer la participation et attendre **Collecte active sur ce poste**, puis activer le suivi Bolt. Vérifier la date de dernière lecture et les véhicules suivis ; un échec avec reprise automatique reste affiché comme avertissement. Les anciens fichiers `bolt.env` restent lisibles et les accès ne sont jamais intégrés aux ZIP.
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

Le workflow GitHub actuel publie le dossier racine `site/`, Apps Script et la fonction Geotab. Il ne distribue pas ces paquets desktop et n'applique pas leur SQL. Un push seul ne réalise donc pas cette bascule. Les commandes `git add`, `git commit` et `git push` restent à effectuer par l'utilisateur.

## Limites de cette livraison

- Le suivi Geotab récent, ses capteurs et événements sont partagés par Supabase. Les vues de détail, historique et rapport qui interrogent Geotab directement demandent encore le poste qui collecte.
- Le portail chauffeur accessible depuis un téléphone demande un hébergement public et son propre accès authentifié. Le serveur sur `127.0.0.1` ne le publie pas sur Internet. L'administration des comptes chauffeurs reste disponible dans Ludy.
- La collecte exige un administrateur Ludy connecté et un poste éveillé. Elle ne devient pas un service indépendant de la session de l'application.
- Windows et macOS demandent encore leur recette graphique et métier sur les postes utilisateurs. Le diagnostic Windows 0.1.1 déjà reçu concernait l'ancien conteneur hors connexion.
- Les montants financiers conservent leurs preuves, leurs devises et leur couverture. Les prix observés par les API Bolt ne deviennent pas des relevés comptables, et le total Uber Earnings n'est pas assimilé au net après commissions.

## Vérifications et retour arrière

Les tests locaux couvrent l'élection concurrente de quatre postes, le refus des anciennes générations, les révocations, les droits d'agence, le transport JWT, les états Geotab partagés et la conservation des lignes historiques synthétiques. Les répétitions SQL vérifient aussi le rollback du lot complet après erreur injectée, y compris celui du marqueur d’environnement. La copie reconstruite passe désormais le contrôle exact de l’inventaire de production avec les fonctions et le déclencheur fournis. Voir [le contrat SQL](desktop-workers.md) et [l'intégration du runtime](runtime-adaptation.md).

Pour arrêter les nouvelles collectes, suspendre la participation des postes ou quitter leurs applications. Conserver les tables ajoutées et les données reçues pendant le diagnostic ; ne pas utiliser de `DROP` ni rejouer le socle historique. Le retour à l'ancien site demande de rétablir explicitement ses collectes. Restaurer une sauvegarde après de nouvelles écritures peut perdre ces dernières : préparer leur récupération avant cette opération.
