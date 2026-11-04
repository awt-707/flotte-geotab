# Serveur de tests Ludy sur Oracle ARM64

Ce dossier prépare un serveur **staging indépendant** : le Supabase de production n’est jamais utilisé. Rien ici ne crée de VM, n’installe de paquet, ne publie de port ou ne déplace les données sans exécution explicite des commandes sur le futur serveur. La machine Oracle, son accès SSH et le nom DNS restent à fournir.

## Architecture et limites

```text
Testeurs → HTTPS 443 / Caddy → 127.0.0.1:4174 / compte Ludy
                                     ↓
                           127.0.0.1:4173 / Ludy
                                     ↓
                       Supabase du serveur de tests
                       127.0.0.1:57421…57429

Opérateur → SSH → VNC 127.0.0.1:5999 → bureau :99 / Uber
```

Chaque testeur se connecte avec son compte Ludy et ses droits habituels. Aucun jeton administrateur, mot de passe de fournisseur, profil navigateur ou donnée métier ne figure dans le paquet source ni dans les applications clientes. Les ports internes, Studio, PostgreSQL et VNC ne doivent jamais être accessibles depuis Internet ou le réseau Oracle privé.

**La stack Supabase CLI est un environnement de développement/test, pas une distribution de production.** Supabase recommande sa distribution Docker pour un véritable auto-hébergement. Cette préparation garde la CLI épinglée à 2.122.0 pour les essais Ludy, derrière la passerelle authentifiée ; elle remplace ses cinq clés Auth/API et sa clé privée ES256. Les secrets internes de développement non configurables (notamment base et services internes) restent confinés au réseau Docker dédié et aux ports loopback. Cela ne transforme pas la CLI en distribution durcie pour la production. Une migration vers la distribution officielle est nécessaire avant cet usage. [Guide Supabase](https://supabase.com/docs/guides/self-hosting), [distribution Docker](https://supabase.com/docs/guides/self-hosting/docker).

La passerelle refuse de démarrer si la préparation privée manque, si les clés actives diffèrent, si Realtime/REST/Storage acceptent une autre clé de signature, si le marqueur de base n’est pas `staging`, si un accès Auth privilégié est accepté avec la clé anonyme, ou si un port interne est publié hors loopback. Le contrôle est répété par `host.mjs`, qui ferme la passerelle en cas d’échec. La possibilité de joindre le socket Docker donne au compte système des privilèges importants : ce serveur doit rester dédié à Ludy, sans utilisateurs système non fiables.

## Prérequis à réaliser sur Oracle

- VM Ubuntu 24.04 ARM64, Ampere A1, 2 OCPU / 12 Go RAM, volume de démarrage de 80 Go conseillé, au moins 40 Go libres. Les quotas, la région principale et la disponibilité A1 sont à vérifier dans le compte Oracle ; ne pas créer de ressource affichant un tarif payant. L’offre gratuite et la capacité disponible ne garantissent pas un SLA. [Ressources Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
- Nom DNS dédié, par exemple `staging.exemple.fr`, avec un enregistrement A vers la VM. Ne publier AAAA que si IPv6 est également configuré et filtré.
- Règles Oracle **et** pare-feu de la VM : SSH 22 limité à l’IP de l’opérateur ; TCP 80/443 pour Caddy. Aucun 4173/4174/574xx/5999/2019 public. Ne pas compter uniquement sur UFW pour filtrer Docker : les bindings loopback sont obligatoires et vérifiés. [Docker sur Ubuntu ARM64](https://docs.docker.com/engine/install/ubuntu/).
- Node.js 24 LTS, npm, Docker Engine et Compose plugin, Caddy, `tar`, `ss`, systemd installés et vérifiés **avant** les commandes Ludy. Installer depuis les sources officielles, sans exécuter un script distant via `curl | sudo sh`. Le paquet Caddy peut démarrer son service à l’installation : conserver son site par défaut et ne charger Ludy qu’après les contrôles. [Caddy](https://caddyserver.com/docs/install).
- Un compte système dédié `ludy`, propriétaire de `/opt/ludy/current/staging`, membre du groupe Docker. Les chemins des modèles sont ajustables avec `prepare.mjs`. Les commandes `sudo` ci-dessous sont réservées à cette VM, jamais au poste de développement.

## Paquet source, sans secrets

Depuis le dépôt local, vérifier puis créer un paquet dans un dossier privé existant :

```sh
node staging/hosting/bundle.mjs
node staging/hosting/bundle.mjs --out /chemin/prive/ludy-staging-source.tar.gz
```

Le manifeste SHA-256 accompagne le paquet. L’allowlist inclut uniquement les sources nécessaires au staging : application, migrations, scripts, extension et modèles. `.local`, données/exportations, `.env`, profils navigateur, Git, dépendances installées et applications clientes en sont exclus. Les liens symboliques et fichiers liés sont refusés. Le paquet n’exige aucun fichier de la version de production.

Transférer ce paquet par SCP, vérifier son empreinte, puis extraire **dans un répertoire vide** `/opt/ludy/current/staging` appartenant à `ludy`. Ne pas recopier tout le dépôt ou `.local` par-dessus. Le paquet contient les fichiers du staging à sa racine.

Sur la VM, comme utilisateur `ludy` :

```sh
cd /opt/ludy/current/staging
npm ci
node uber-extension/build.mjs
node hosting/preflight.mjs
node hosting/prepare.mjs --origin https://staging.exemple.fr
node hosting/prepare.mjs --origin https://staging.exemple.fr --out /opt/ludy/rendered
```

`npm ci` conserve la CLI dans les dépendances de développement ; ne pas utiliser `--omit=dev`. Toutes les dépendances servies au navigateur sont installées dans `staging/node_modules` ; aucun `node_modules` du dépôt de production n’est nécessaire. La commande `uber-extension/build.mjs` reconstruit les dossiers d’extension et leurs ZIP téléchargeables à partir des sources incluses : les ZIP préexistants ne sont pas transportés dans le paquet. Le préflight ne modifie rien. `prepare` sans `--out` décrit les fichiers ; avec `--out`, il crée un nouveau dossier privé, sans écraser ni installer d’unité.

## Initialisation privée de la VM neuve

Toujours comme `ludy`, **avant le premier démarrage de Supabase** :

```sh
node hosting/initialize.mjs --initialize-server --origin https://staging.exemple.fr
install -m 600 /opt/ludy/rendered/hosting.json .local/hosting.json
node hosting/initialize.mjs --check
```

Cette commande refuse un runtime existant ou un conteneur portant le nom du projet. Elle crée des clés aléatoires propres au serveur dans `.local/hosting/` (répertoire 700, fichiers 600), conserve la configuration initiale et ajoute uniquement des références `env(...)` au fichier TOML. Elle ne démarre rien. Les unités chargent le fichier privé `auth.env`. Ne jamais afficher, envoyer dans une conversation ou versionner ce dossier. Une préparation interrompue ou une future rotation de clés exige une revue explicite ; le script ne les écrase pas.

Le réglage repose sur les champs de la version **2.122.0**, vérifiés dans le [code officiel Auth](https://github.com/supabase/cli/blob/v2.122.0/apps/cli-go/pkg/config/auth.go) et la [génération des clés API](https://github.com/supabase/cli/blob/v2.122.0/apps/cli-go/pkg/config/apikeys.go). Une mise à jour de CLI demande de revoir les contrôles, pas de changer seulement le numéro de version.

## Services et ouverture HTTPS

Après revue des modèles, installer uniquement les trois services de base :

```sh
sudo install -m 644 /opt/ludy/rendered/ludy-stack.service /etc/systemd/system/
sudo install -m 644 /opt/ludy/rendered/ludy-app.service /etc/systemd/system/
sudo install -m 644 /opt/ludy/rendered/ludy-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start ludy-app.service
node hosting/preflight.mjs --stack
node scripts/host.mjs --check
sudo systemctl start ludy-gateway.service
sudo caddy validate --config /opt/ludy/rendered/Caddyfile --adapter caddyfile
sudo install -m 644 /opt/ludy/rendered/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Ne poursuivre après aucune erreur. Les services dépendent de la stack, qui crée uniquement sa base de tests et ses propres migrations. Caddy conserve le Host et remplace `X-Real-IP` par l’adresse du client, pour que le contrôle des tentatives de connexion ne dépende pas d’un en-tête fourni par le navigateur. Il transporte aussi les WebSockets. DNS et ports 80/443 doivent être corrects pour le certificat automatique. [HTTPS Caddy](https://caddyserver.com/docs/quick-starts/https), [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Depuis une connexion extérieure, vérifier le certificat, la connexion avec un compte test, ses droits d’agence, le temps réel et l’impossibilité de joindre les ports internes. Créer chaque compte par le mécanisme Ludy prévu ; ne pas distribuer le compte administrateur. Après validation seulement, activer le démarrage automatique :

```sh
sudo systemctl enable ludy-stack.service ludy-app.service ludy-gateway.service caddy
```

Les liens Auth de courriel et le SMTP de développement restent locaux. Le parcours prévu est une connexion par compte créé par l’administrateur ; les invitations par courriel et réinitialisations de mot de passe externes demanderaient une configuration dédiée. En cas de panne, consulter `journalctl -u ludy-gateway -u ludy-app -u ludy-stack` localement, sans publier les journaux privés de Supabase.

## Uber sur le serveur, même quand le PC est éteint

La carte Uber et le collecteur de rapports ont besoin d’un navigateur ouvert avec une session valide. Une VM headless n’élimine ni l’authentification humaine ni les expirations/2FA. Installer sur la VM Xvfb, xauth, x11vnc, Openbox et les dépendances Chromium. Les rapports utilisent automatiquement le Chromium fourni par **Playwright 1.64.1** (Chromium 156 pour cette version), installé sur la VM en ARM64. Le Chromium système 154 a provoqué des interruptions de téléchargement pendant les essais : l’unité rapports enlève explicitement `LUDY_REPORTS_CHROMIUM` de son environnement pour ne pas le sélectionner. [Navigateurs Playwright](https://playwright.dev/docs/browsers).

L’installation système des dépendances et le téléchargement du navigateur sont deux opérations distinctes. Après installation des dépendances, comme `ludy` :

```sh
node node_modules/playwright/cli.js install chromium
node --input-type=module -e "import {chromium} from 'playwright'; console.log(chromium.executablePath())"
```

Régénérer dans un nouveau dossier les modèles avec `--chromium /chemin/absolu/affiche/chrome` pour la **Live Map**, puis installer les cinq unités de bureau/navigateur nécessaires (display, desktop, vnc, uber-live, uber-reports). Le collecteur de **rapports** ignore cette option et utilise `chromium.executablePath()` de Playwright, sous le compte `ludy` qui a téléchargé le navigateur. Ce chemin doit être lisible/exécutable par `ludy`. Ne pas copier le navigateur du poste x86 vers Oracle ARM64 et ne pas désactiver son sandbox. Si Ubuntu refuse les espaces de noms requis, résoudre la politique de la distribution ; ne pas ajouter `--no-sandbox` ni substituer silencieusement un Chromium système aux rapports.

Avant de démarrer `ludy-uber-live`, créer comme `ludy` le fichier `.local/hosting/uber-live.json`, en mode 600. Copier **l’UUID de l’organisation confirmée** depuis son adresse Live Map Uber : `https://fleethub.uber.com/orgs/UUID/livemap`. Ne pas utiliser un nom commercial ou l’UUID d’une autre flotte. Le fichier contient uniquement :

```json
{"organizationId":"REMPLACER_PAR_UUID_ORGANISATION_CONFIRMEE"}
```

Le texte de remplacement est volontairement invalide : il doit être remplacé par l’UUID réel. Vérifier sans ouvrir de navigateur, avec le même chemin Chromium que dans les unités :

```sh
chmod 600 .local/hosting/uber-live.json
LUDY_LIVE_CHROMIUM=/chemin/absolu/affiche/chrome node hosting/uber-live.mjs --check
```

Au redémarrage, le lanceur ouvre directement `https://fleethub.uber.com/orgs/UUID/livemap` dans `.local/uber-live-browser`. Il refuse un fichier absent, invalide ou non privé, et n’ouvre jamais par défaut la page d’accueil Uber. Il ne supprime aucun profil, cookie ou verrou Chromium. Cela prépare la reprise sur la bonne page ; une session expirée, une demande 2FA ou une extension arrêtée exigent toujours l’intervention humaine. Le lancement de Chromium ne vaut pas confirmation de collecte : vérifier les observations récentes dans Ludy.

Créer le mot de passe VNC **interactivement**, comme `ludy` :

```sh
x11vnc -storepasswd /opt/ludy/current/staging/.local/hosting/vnc.pass
chmod 600 /opt/ludy/current/staging/.local/hosting/vnc.pass
sudo systemctl start ludy-desktop.service ludy-vnc.service ludy-uber-live.service
```

Le cookie X11 est généré automatiquement dans un fichier privé, Xvfb n’écoute pas en TCP et VNC écoute exclusivement sur loopback. Depuis le poste de l’opérateur :

```sh
ssh -L 5999:127.0.0.1:5999 ubuntu@ADRESSE_VM
```

Connecter un client VNC à `127.0.0.1:5999`. Dans le navigateur du serveur, se connecter normalement à Uber, charger l’extension décompressée `staging/uber-extension/chromium`, associer l’extension au Ludy **du serveur**, ouvrir la Live Map et démarrer la lecture. Activer aussi « Reprendre automatiquement après fermeture de l’onglet ou du navigateur » et accorder l’autorisation demandée : l’ouverture de la page seule ne réactive pas une extension arrêtée. Un clic sur « Arrêter » suspend cette reprise jusqu’au prochain démarrage manuel. Garder la page visible dans ce bureau. Les rapports utilisent un second profil ; après activation manuelle de leur collecte et démarrage de `ludy-uber-reports`, effectuer aussi la connexion humaine si demandée. Le navigateur Live Map n’est jamais le profil personnel du poste ni celui des rapports. Contrôler les dernières observations dans Ludy avant d’activer ces unités au démarrage.

## Données existantes et bascule — opération distincte

Le paquet source démarre une base neuve. Il ne transfère pas la base locale actuelle, les références réelles, contrats, connecteurs, comptes, pièces jointes, profils Uber, secrets fournisseurs ou archive de rapports.

Une commande de sauvegarde **du staging local uniquement** est disponible :

```sh
node staging/hosting/backup.mjs
node staging/hosting/backup.mjs --export
```

Sans option, elle affiche seulement un inventaire agrégé. Avec `--export`, elle crée un dossier privé daté dans `staging/.local/backups/transfer-…/`. Ce dossier contient un `staging.dump` PostgreSQL custom, les fichiers fournisseurs explicitement autorisés (`geotab.json`, `myclicar.json`, `bolt.env`), la référence d’import, les CSV Uber et leurs reçus, les éventuels documents Storage, un manifeste SHA-256 et `RESTORE-REVIEW.md`. Répertoires 700 et fichiers 600. **Ce dossier contient des données métier et des secrets fournisseurs : transfert SSH réservé à l’opérateur, jamais dans le bundle source, une application cliente, Git ou un lien destiné aux testeurs.**

Le dump et ses compteurs utilisent le même snapshot PostgreSQL READ ONLY. Les noms des schémas sont fixés (`public`, `auth`, `storage`, `supabase_migrations`) ; aucun paramètre de connexion cloud n’est accepté. Les comptes et leurs hashes de mot de passe sont conservés, les sessions Auth/refresh tokens, sessions du portail et sessions techniques Geotab sont exclus. L’historique métier `bolt_sessions` est bien conservé. Le manifeste liste chaque table incluse/exclue et son compteur. La présence de Vault, de facteurs MFA/SSO/OAuth/WebAuthn persistants non pris en charge ou de jetons Auth temporaires non vides bloque l’export pour permettre une revue ; rien de cela n’est abandonné silencieusement.

Les objets Storage sont lus par l’API locale authentifiée et hachés individuellement ; l’export refuse un objet absent, tronqué ou un inventaire modifié pendant la copie. Un simple dump SQL ne contient pas les fichiers Storage. Les fichiers locaux sont copiés séparément après vérification de leur empreinte. Aucun collecteur n’est arrêté : cette copie datée est cohérente pour PostgreSQL, mais ne prétend pas former une transaction commune avec fichiers et fournisseurs. Le script est borné à 10 Gio au total, 64 Mio par objet et 120 secondes pour pg_dump ; les copies incomplètes sont supprimées. [Archives PostgreSQL portables et snapshots](https://www.postgresql.org/docs/17/app-pgdump.html).

Il n’y a aucune restauration automatique. Les UUID Auth et profils doivent rester cohérents, tandis que les nouvelles clés ES256/API serveur doivent être conservées ; les utilisateurs se reconnecteront. Le manifeste enregistre les versions des migrations Auth/Storage et les extensions afin de comparer la cible. Le dump contient aussi des définitions internes déjà présentes sur une stack neuve : **ne pas lancer un `pg_restore --clean` global**. L’administrateur créé par bootstrap sur une base neuve doit être rapproché des comptes restaurés, sans réinitialisation involontaire. La revue jointe détaille aussi l’ordre de restauration Storage et la reprise des CSV. Les préférences de reprise originales sont uniquement documentaires ; une variante `connector-state.paused.json` garde les trois fournisseurs arrêtés jusqu’à la bascule autorisée.

Avant une bascule, préparer et vérifier une **sauvegarde privée du staging local uniquement**, ainsi que la liste des volumes/fichiers nécessaires. Le transfert doit passer par SSH et rester hors du paquet source. Ne pas restaurer aveuglément des rôles PostgreSQL, clés Auth/JWT, `runtime.json`, secrets d’hébergement ou configurations de production : les nouvelles clés serveur doivent rester celles de la préparation. Prévoir une procédure de restauration et de validation des comptes, Storage, références et automations, puis tester la reprise sur la VM avant d’arrêter le poste.

Pendant cette préparation, laisser les collecteurs du nouveau serveur arrêtés. Au moment d’une **bascule explicitement autorisée**, arrêter les collecteurs du poste, transférer le dernier état cohérent, activer les collecteurs serveur et contrôler les données reçues. Ne pas faire tourner deux collecteurs de rapports sur le même compte Uber en parallèle. Le bail local du navigateur ne coordonne pas deux bases séparées.

Restent à effectuer : VM/SSH/DNS, installation système, vérification ARM64 réelle des images, contrôles réseau extérieurs, initialisation privée serveur, reprise privée du staging, sessions Uber, comptes testeurs et recette de bout en bout. Aucun de ces éléments n’est déclaré accompli par la génération des modèles.
