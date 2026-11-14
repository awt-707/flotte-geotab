# Quitter Supabase pour OVH

Ludy n'utilise pas seulement PostgreSQL. Supabase fournit aussi quatre services, et chacun doit avoir un équivalent chez OVH.

| Service Supabase | Ce que Ludy en fait | Où dans le code |
|---|---|---|
| **PostgREST** (`/rest/v1`) | Toutes les lectures et écritures du site (supabase-js) et du collecteur (`sbReq_`). Pagination à 1 000 lignes, `count=exact`, `Prefer: return=…` | `site/*.js`, `collector/src/10_db.gs` |
| **Auth / GoTrue** (`/auth/v1`) | Comptes, mots de passe, mot de passe oublié, jetons JWT. Dans la base : `auth.uid()` (83 appels), `auth.users`, le déclencheur `on_auth_user_created` (le premier compte devient administrateur) | `site/app.js`, `site/jeton.js`, toutes les règles RLS |
| **Storage** (`/storage/v1`) | PDF des manifestes, devis, plannings, contrats ; dossiers RH ; justificatifs et fiches de la caisse ; applications à télécharger (seau public `app`). Liens signés, règles par dossier | `plateforme/stockage.sql`, `site/*.js`, collecteur (`57_rhdrive`, `58_cashdrive`, `50_notify`) |
| **Realtime** | Bandeau d'alertes et page En direct, mis à jour à l'instant | `plateforme/temps_reel.sql`, `site/app.js` |
| **Edge Functions** | Relais `geotab-live`, la position Geotab toutes les 5 s (Deno, secrets `GEO_USER` / `GEO_PWD`) | `supabase/functions/geotab-live/` |

PostgreSQL seul n'en fournit aucun.

Tout le reste est du PostgreSQL standard : plpgsql, jsonb, séquences. Aucune extension n'est indispensable, ni pg_cron, ni pg_net, ni Vault.

## Option A (conseillée) : Supabase auto-hébergé sur un serveur OVH

Le **même logiciel**, en open source, tourne dans Docker sur un serveur OVH (VPS ou Public Cloud). Le code du site, du collecteur et des applications ne change pas : seules l'adresse et les clés changent.

- **Serveur** : 4 Go de RAM au moins (8 Go conseillés), 2 vCPU, 80 Go de disque. Ordre de prix : 15 à 30 €/mois.
- **À votre charge** :
  - les mises à jour de Supabase et du système ;
  - le certificat HTTPS (Caddy ou Nginx avec Let's Encrypt) ;
  - **les sauvegardes** (`pg_dump` chaque nuit vers OVH Object Storage, avec un essai de restauration) ;
  - la surveillance.

Supabase en ligne fait aujourd'hui tout cela à votre place.

Étapes :
1. Installer Supabase auto-hébergé (`docker compose`, guide « Self-Hosting with Docker » de Supabase). Générer de **nouvelles** clés (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`) et les garder hors du dépôt.
2. Installer la base de Ludy :
   ```
   DB_URL=postgresql://postgres:…@serveur:5432/postgres bash database/installer.sh
   ```
3. Juste avant la bascule, arrêter les écritures : site en maintenance, déclencheur du collecteur arrêté dans Apps Script.
4. Reprendre les données et les comptes. Les mots de passe sont gardés : personne n'a à recréer son compte.
   ```
   SOURCE_URL=… CIBLE_URL=… bash database/ovh/transfert.sh --avec-comptes
   ```
5. Copier les fichiers :
   ```
   SOURCE_URL=… SOURCE_KEY=… CIBLE_URL=… CIBLE_KEY=… node database/ovh/copie_fichiers.js
   ```
   Ensuite, remettre l'auteur de chaque fichier : les règles des devis et manifestes s'en servent. Pour cela, lancer sur la source la requête ci-dessous, puis exécuter les lignes produites sur la cible :
   ```sql
   select format('update storage.objects set owner_id = %L where bucket_id = %L and name = %L;', owner_id, bucket_id, name) from storage.objects where owner_id is not null;
   ```
6. Publier le relais en direct : `supabase functions deploy geotab-live` vers le nouveau serveur, avec les secrets `GEO_USER` et `GEO_PWD`.
7. Changer les adresses et les clés, puis contrôler :
   - `site/config.js` : `SUPABASE_URL` + clé **anon** (`npm run check` vérifie le format) ;
   - propriétés du script Apps Script : `SUPABASE_URL` et `SUPABASE_KEY` (service_role), adresse par défaut de `collector/loader/Code.gs` ;
   - secrets GitHub Actions (`SUPABASE_SERVICE_KEY`) et `scripts/publish-*.js` (adresse du seau `app`) ;
   - **liens de téléchargement des applications** (Mac, Windows, Android) écrits dans CLAUDE.md et dans la page Application ;
   - adresse de redirection des e-mails de connexion (Site URL / Redirect URLs dans la configuration de GoTrue) ;
   - contrôler avec `node database/outils/schema.js check` et une comparaison du nombre de lignes source / cible (fin de `transfert.sh`).
8. Garder Supabase en ligne en lecture une à deux semaines, puis le fermer.

## Option B : PostgreSQL géré par OVH + logiciels séparés

OVH fournit une base PostgreSQL gérée, avec sauvegardes, mais rien d'autre. Il faudrait installer et maintenir chacun des services ci-dessous :
- **PostgREST** (connexion par le rôle `authenticator`) ;
- **GoTrue** (le service de connexion de Supabase), ou un autre service. Dans ce cas, réécrire `auth.uid()`, la connexion du site (`supabase-js`) et `site/jeton.js` ;
- un **stockage S3** (OVH Object Storage) avec un petit service qui signe les liens et applique les règles de `plateforme/stockage.sql` (dossier = agence, salarié ou véhicule) : c'est le plus gros travail de réécriture ;
- un relais Node à la place de la fonction Deno. `live.mjs` est déjà sans dépendance et testé sous Node ;
- le temps réel : soit Supabase Realtime seul, soit une lecture périodique.

Installation de la base : `DB_URL=… bash database/installer.sh --hors-supabase`. Elle crée les rôles `anon`, `authenticated`, `service_role`, `authenticator` et `auth.uid()` (`plateforme/roles_hors_supabase.sql`). Vérifié sur un PostgreSQL vierge.

Reprise des comptes : GoTrue garde ses tables `auth.*` (même chemin que l'option A). Un autre service ne relit pas les mots de passe chiffrés de Supabase (bcrypt), sauf s'il accepte l'import de hachages bcrypt ; sinon chaque utilisateur refait son mot de passe.

**Conclusion** : l'option B coûte plusieurs semaines de réécriture (connexion, fichiers, relais) pour un prix proche de l'option A. L'option A garde tout le code tel quel.

## Avant de migrer

- Rapprocher la production et le dépôt : `node database/outils/production.js ecarts` doit répondre « production identique au dépôt ».
- Décider avec Raphael du sort du module de bureau : `--sans-module-bureau` l'écarte. Ses fonctions `refresh_drivers`, `bump_usage` et `usage_stats` remplacent alors les versions de Ludy.
- Prévoir l'heure du Maroc : le serveur et la base restent en UTC ; l'heure locale est calculée par `MA_TZ` (collecteur) et `tzRules` (site), jamais par les tables de fuseaux du système.
