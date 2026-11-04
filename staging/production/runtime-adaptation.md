# Runtime embarqué de production

L'intégration choisie place le serveur dans chaque application de bureau. Supabase hébergé arbitre la collecte et conserve les données communes. Le point d'entrée de production est distinct du staging local ; aucune VM n'est nécessaire. Le [guide de déploiement](README.md) décrit les paquets, la préparation de la base et les essais entre postes.

## Composants intégrés

| Composant | Rôle |
| --- | --- |
| `desktop/embedded-main.cjs` et `embedded-supervisor.cjs` | Fenêtre Electron isolée, verrou d'instance, processus serveur, arrêt et veille, installation du navigateur Uber |
| `desktop-runtime/server.mjs` | Serveur HTTP limité à `127.0.0.1:4173`, ressources publiques explicites, contrôle d'origine, aucune collecte au chargement |
| `desktop-runtime/session.mjs` | Vérification du JWT auprès d'Auth et du rôle auprès de Supabase ; jeton serveur en mémoire |
| `desktop-runtime/coordinator.mjs` | Participation désactivée par défaut, bail global de 90 s, renouvellement toutes les 25 s, arrêt conservateur avant 70 s |
| `desktop-runtime/services.mjs` | Contexte par projet/utilisateur, remplacement des services à chaque génération, fermeture des navigateurs lors de la perte du bail |
| `desktop-runtime/transport.mjs` | Requêtes utilisateur avec JWT/RLS ; collectes via RPC bornées et génération fixe, sans clé privilégiée de production |
| `desktop-runtime/admin-context.mjs` | Actions administrateur et gestionnaire séparées des collectes, limitées à la requête HTTP et aux ressources prévues |
| `desktop-runtime/stack.mjs` | Assemblage des services de flotte, opérations, parking, performances, télémétrie et finances |
| `desktop-runtime/uber-browser.mjs` | Profil privé, connexion Uber manuelle, Reports et Earnings ; ferme le navigateur lors de la perte du bail |
| `server/shared-geotab.mjs` et `desktop-live.sql` | Capteurs et événements récents partagés, état daté et droits selon les véhicules visibles |
| `server/database-target.mjs` | Cible de production explicitement validée ; refus du cloud par défaut dans les anciens points d'entrée |
| `server/private-files.mjs` | Écriture privée et contrôles POSIX/Windows des fichiers locaux |
| `scripts/build-embedded-desktop.mjs` | Configuration publique seule, sources autorisées, dépendances verrouillées, inventaire et empreintes du paquet |

Les RPC de [desktop-workers.sql](desktop-workers.sql), [desktop-admin.sql](desktop-admin.sql) et [desktop-manager.sql](desktop-manager.sql) gardent les claims de l'utilisateur. Le rôle `service_role` n'est jamais fabriqué par le transport. Une génération perdue ne peut pas être remplacée implicitement pendant une opération : le runtime reconstruit les services avec le nouveau bail.

Les lectures ordinaires des gestionnaires passent par RLS. Leurs écritures ajoutées sont limitées aux règles de rush et aux imports de demande de leurs agences. Seul un administrateur peut faire participer un poste à la collecte. La présence des fichiers fournisseurs n'est pas un critère d'élection : préparer chaque poste éligible avant la mise en service.

## Portée conservée

Le staging et ses commandes restent locaux. Les outils `runtime-config.mjs` et `hosting/` décrivent l'ancienne préparation d'un serveur séparé ; ils ne sont pas les lanceurs de cette architecture. Les paquets clients 0.1.1, leur diagnostic hors connexion et l'ancien kit Mac ne valident pas le serveur intégré 0.2.0.

Le frontend utilise directement Supabase pour Auth, les données utilisateur et Storage. Le serveur local ne remplace pas les fonctions Apps Script de courriels, PDF, jobs ou RH/Drive. Le portail mobile chauffeur nécessite encore un service public distinct. Les lectures Geotab à la demande restent sur le poste actif ; les données de suivi récentes sont partagées.

Les fichiers de configuration privés, journaux de reprise et profils fournisseurs restent par utilisateur sous le dossier du projet dans les données de l'application. Les identifiants fournisseurs doivent être configurés sur chaque poste de secours ; ne pas cloner l'identifiant d'appareil ou la session d'un autre utilisateur.

## Validation

```sh
node --test staging/tests/*.test.mjs staging/scripts/guard.test.mjs staging/production/*.test.mjs
node staging/tests/desktop-workers.integration.mjs
node staging/tests/desktop-workers-concurrency.integration.mjs
node staging/tests/desktop-admin.integration.mjs
node staging/tests/desktop-manager.integration.mjs
node staging/tests/desktop-transport.integration.mjs
node staging/production/prepare.mjs --rehearse
node staging/production/prepare.mjs --rehearse-atomic
```

Les tests SQL utilisent la base locale sous transaction annulée ou une base jetable. Ils n'appliquent rien en production. La recette du vrai paquet Linux se déroule dans un réseau isolé, sans accès aux fournisseurs ni à Supabase hébergé. Les essais natifs Windows/Mac, la restauration de sauvegarde réelle et la bascule des collecteurs existants restent distincts de ces contrôles.
