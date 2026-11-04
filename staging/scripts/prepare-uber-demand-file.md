# Préparer un CSV Uber pour les zones, uniquement en local

`prepare-uber-demand-file.mjs` est un contrôle en lecture seule des données
Ludy. Il ne possède **aucun mode d’application** et ne change jamais le réglage
global du fuseau. Il utilise le compte administrateur du staging local, vérifie
le projet et les deux URL locales fixes, puis lit la configuration existante.
Aucune requête n’est envoyée à Uber, à une production ou à un géocodeur.

```sh
node staging/scripts/prepare-uber-demand-file.mjs --file '/chemin/absolu/rapport.csv'
```

Le script conserve l’original, sans modification, sous
`staging/.local/uber-reports/manual-imports/<sha256>/original.csv`.
Les répertoires sont privés (0700), les fichiers privés (0600), et un original
existant n’est jamais écrasé. Le résumé affiché contient seulement des comptes,
des bornes de dates et des identifiants techniques d’agences ; aucune adresse,
identité de chauffeur ou identité de course n’est affichée.

Un fuseau inconnu produit `ready: false` et `timezone_required`. Le nom du
fichier ne prouve ni le fuseau ni les bornes réelles des courses. La
[documentation officielle Uber Trip Activity](https://developer.uber.com/docs/vehicles/references/api/v1/vehicle-suppliers/suppliers/performance-based-reports-fleet)
décrit la colonne « Trip request time » sans préciser le fuseau des valeurs
CSV sans suffixe. Il faut une confirmation concernant **cet export** avant
d’utiliser une dérogation par fichier :

```sh
node staging/scripts/prepare-uber-demand-file.mjs \
  --file '/chemin/absolu/rapport.csv' \
  --timezone UTC \
  --timezone-evidence 'Confirmation du fuseau de cet export par son auteur'
```

`Africa/Casablanca` est aussi accepté. Un fuseau différent impose d’adapter le
parseur après vérification ; il ne doit pas être remplacé arbitrairement par
UTC. L’égalité de deux fuseaux sur une période ne prouve pas le fuseau source.
Le script n’écrit pas cette confirmation dans `uber_report_settings`.

Après confirmation, le contrôle utilise les bornes réellement observées,
limitées à 32 dates marocaines, puis le normaliseur existant `normalizeUberCsv`.
Les associations ville/agence doivent correspondre exactement à la
configuration locale et à `agencies.city`. Les adresses passent par
`publicPickupLabel`. Casablanca et Marrakech sont reconnues dans les adresses ;
les autres lieux ne sont pas attribués à une ville par supposition. Les courses
annulées restent distinctes des terminées ; `delivery_failed` est exclu.

Le contrôle relit les courses existantes des agences concernées, par pages
de 1 000 lignes et avec un plafond de 50 000 lignes. Il sépare nouvelles
courses, courses strictement identiques et conflits. Un identifiant de course
présent dans une autre agence du périmètre est aussi un conflit. Tout conflit
empêche `ready: true` ; aucune course existante n’est corrigée ni remplacée.

Un contrôle complet produit un résumé `review-<review_id>.json` et, seulement
si `ready` est vrai, un `plan-<review_id>.json` privé contenant les lots
normalisés. Le plan contient des identifiants de courses et des libellés de
lieux réduits : il reste sous `.local` et ne doit pas être commité ou publié.
Le résumé reste un état à un instant donné, pas une réservation transactionnelle
des données. Avant toute application autorisée, refaire le contrôle et vérifier
le SHA du CSV, le fuseau, les associations d’agences et les conflits.

L’application doit utiliser la route locale authentifiée existante
`POST /api/operations/demand/import`, jamais un SQL arbitraire ni une base cloud.
Cette route est atomique par lot d’une agence ; plusieurs agences ne constituent
pas une transaction globale. Elle peut mettre à jour une course déjà présente :
le contrôle des conflits doit donc précéder chaque application. Ce script
prépare seulement les lots pour cette étape distincte.

```sh
node --test staging/tests/prepare-uber-demand-file.test.mjs
```
