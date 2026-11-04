# Intégration Teksat — staging

Vérifications effectuées le 3 novembre 2026. Le fournisseur est **Teksat**, dont le [site officiel renvoie vers Minton](https://www.teksat.fr/acces-client/). Les clés historiques `TEXAT_*` et les chemins internes `texat-*` conservent leur orthographe.

## Accès et véhicules

Le premier compte fourni fonctionne. L’inventaire accessible a été parcouru entièrement : 2 192 véhicules, 220 pages, total stable et identifiants uniques. La filiale Maroc contient 8 véhicules ; les 8 rapprochements avec les anciennes plaques enregistrées dans Ludy sont uniques dans cet inventaire. Six autres correspondances fondées seulement sur un libellé restent exclues. Aucun rapprochement approximatif n’est appliqué.

Les deux mots de passe proposés pour le second compte ont chacun reçu HTTP 401. Aucun autre essai n’a été effectué et le premier accès a été conservé. Les identifiants, preuves détaillées et profils navigateur restent privés ; aucun n’est reproduit ici.

La filiale et les preuves sont liées à l’empreinte du compte. Chaque cycle revalide les mêmes paires véhicule fournisseur / tracker / véhicule Ludy et les anciennes plaques courantes. `mappingBasis=current_at_receipt` signifie **association vérifiée lors de la réception**, sans certifier une affectation passée. La présence d’un véhicule dans Geotab et Teksat ne prouve pas qu’il possède deux boîtiers physiques distincts : une preuve matérielle ou fournisseur reste nécessaire.

## Collecte et conservation brutes

`createTeksatService()` reçoit la configuration privée, le scope, le chemin des preuves, `archiveDirectory` et un callback local `loadVehicles()`. Seul `start()` lance la collecte ; les cycles sont espacés de 60 secondes après leur fin. `getStatus()`, `refreshReadOnly()` et `close()` permettent le contrôle. Les routes admin locales sont `GET /api/fleet/texat/status` et `POST /api/fleet/texat/refresh`. Le statut courant fait foi sur l’activation effective.

Le serveur local démarre ce service uniquement après acquisition de son port ; une seconde instance ne récupère ni n'écrit le journal. La collecte réelle a été activée le 3 novembre 2026 à 17:30 UTC. Deux cycles ont confirmé huit positions et huit associations à chaque passage, avec 16 observations archivées, aucune attente d'écriture et aucune erreur. Le journal se trouve dans `.local/texat/raw/`. Ces compteurs constituent un relevé de validation ; l'écran **Connecteurs** affiche leur état courant.

Le journal JSONL conserve les dates GPS/source **inchangées**, `receivedAt` en UTC, la provenance, les références source/tracker/Ludy et la preuve d’association. `timeZone=null` et `normalized=false` restent explicites. Il ne conserve ni identifiants de connexion, ni plaques, ni adresses, ni noms de chauffeurs. Le mode privé du fournisseur supprime les coordonnées.

- Dossier 0700, fichiers 0600, écritures synchronisées sur disque.
- Rotation par segments de 8 MiB ; **aucune purge automatique**.
- Plafond de 512 MiB, avertissement à 80 %, arrêt `teksat_archive_full` avec marge d’écriture. Les anciens segments sont conservés.
- Lot en attente durable, reprise au redémarrage, déduplication par empreinte et conservation des corrections en versions distinctes.
- Une fin de fichier interrompue est conservée séparément ; son préfixe valide est relu sans perdre l’historique.
- Arrêt immédiat sur refus d’authentification, changement d’association ou capacité atteinte ; au plus trois échecs de transport consécutifs avant suspension.

Le statut expose notamment octets, segments, écritures, attente, dernière sauvegarde et motif d’arrêt. Cette conservation locale ne constitue pas une sauvegarde sur un autre support.

## Normalisation encore bloquée

Geotab reste primaire ; aucun secours cartographique normalisé ni total kilométrique/carburant Teksat n’est activé. Les dates de `positions-fuseau` sont sans zone explicite. Lors du contrôle, les plus récentes étaient environ une heure en avance sur l’UTC serveur. Cela ne suffit pas à choisir Europe/Paris, un décalage fixe ou un paramétrage de société. Profil, filiale, collaborateur et en-têtes normaux n’ont fourni aucun réglage probant ; aucun indicateur de fix valide/précision n’a été confirmé.

Le code client Minton chargé normalement apporte une réserve supplémentaire : certains gestionnaires d’événements contact, conducteur et mode privé réécrivent `dateGps` sans fournir de nouvelles coordonnées. Le nom du champ ne suffit donc pas à certifier l’heure de mesure d’un fix GPS dans tous les flux. Les indications commerciales de [précision GPS](https://www.teksat.fr/dipi_faq/la-geolocalisation-est-elle-precise/) ne prouvent pas non plus la qualité d’une mesure donnée.

Question exacte à faire confirmer par Teksat : **« Quel champ date réellement la mesure des coordonnées, indépendamment des événements contact/conducteur/mode privé ? Quel fuseau IANA ou décalage, avec quelles transitions datées, s’applique aux champs `dateGps`, `datePosition`, `derniereDateGps`, `gpsDate` et aux bornes des trajets pour ce compte ? Quels codes et champs distinguent l’heure de mesure, la réception serveur, la validité du fix GPS et sa précision ? »**

Pour les 8 véhicules, l’affichage CAN est désactivé et aucun compteur CAN positif n’a été observé. Un historique d’activité fournit des kilomètres GPS, tandis que ses champs CAN/carburant restent à zéro : ces zéros ne prouvent pas une consommation nulle. Le secours carburant exige un **compteur cumulatif de carburant consommé en litres avec horodatage et gestion des remises à zéro**, ou des litres consommés sur un intervalle explicitement couvert. Une jauge de réservoir, une consommation théorique ou un zéro par défaut ne convient pas. Les kilomètres GPS doivent rester identifiés comme estimations.

Pour chaque tracker des 8 véhicules, il reste aussi à établir les dates de validité de son affectation. Les anciennes plaques vérifiées à réception ne permettent pas d’attribuer rétroactivement les mesures. Pour les kilomètres, la source et les bornes de couverture doivent distinguer un compteur véhicule d’une distance reconstituée, distinction également décrite par [Teksat](https://www.teksat.fr/application-geolocalisation/releve-kilometrique-flotte-automatique/). La présence commerciale d’une [fonction carburant](https://www.teksat.fr/suivi-consommation-reelle-carburant/) ne prouve pas son équipement ni sa disponibilité pour ces huit véhicules.

## Prévisualisation préparatoire disponible

`server/texat-normalization.mjs` prépare le raccordement GPS au moteur existant, **sans l’activer**. `validateTeksatNormalizationContract()` et `checkTeksatNormalizationContract()` exigent un contrat borné : empreinte du compte, version de l’interface observée, références documentaires, empreintes des preuves de collecte admises, champ d’heure de mesure, codes de qualité et calendrier explicite des décalages UTC. Aucun fuseau ou code fiable n’est présélectionné.

L’approbation opérateur est distincte du contrat et liée à son empreinte SHA-256 exacte, avec opérateur et date de revue. Une référence documentaire renseignée ne constitue pas une vérification automatique du fournisseur. Une modification du contrat demande une nouvelle approbation ; celle-ci ne rend pas les seules associations à réception valides pour le passé.

`normalizeTeksatRawBatch()` contrôle l’intégrité des versions archivées et exige une association temporelle confirmée à l’heure de mesure. Les heures civiles ambiguës ou inexistantes sont refusées ; l’heure de réception ne rajeunit pas une ancienne position. Un mode privé plus récent empêche de réutiliser les anciennes coordonnées comme secours. Aucun kilométrage, carburant, état réseau ou précision GPS n’est déduit.

`previewTeksatContinuity()` fournit une prévisualisation privée par véhicule à travers le vrai moteur : attente avant secours, retour stable à Geotab, conservation des versions contradictoires et réconciliation sans double compte. Ses observations, références et diagnostics restent limités au véhicule demandé. Le résultat indique toujours `effectiveActivation=false`. Le module ne lit aucun fichier de configuration ou journal à l’importation, ne fait aucun appel fournisseur et n’est appelé par aucune route, page ou collecteur actif. Son code peut figurer dans le paquet source serveur ; les journaux, preuves, configurations et approbations privés restent exclus des paquets clients et source.

## Validation

```sh
node --test tests/texat-normalization.test.mjs tests/telemetry-continuity.test.mjs tests/telemetry-mapping.test.mjs
```

Ce lot ciblé passe **37 tests : 10 nouveaux tests de préparation, 21 du moteur de continuité et 6 des associations temporelles**. Il comprend un parcours utilisant le vrai journal privé sur disque, puis la normalisation et le moteur, avec panne, retour Geotab, doublons et confidentialité. Les données, décalages, codes de qualité et approbations sont synthétiques ; ils ne certifient aucun contrat du compte réel. Le test d’intervalles carburant est explicitement une fixture du moteur, sans raccordement carburant Teksat.

Les contrôles distincts de collecte, d’accès et de journal restent disponibles avec `node --test tests/texat*.test.mjs tests/telemetry-mapping.test.mjs`. Le nombre 37 ci-dessus concerne uniquement le lot ciblé, pas cette suite plus large. La revue indépendante du module n’a trouvé aucun blocage restant après correction du périmètre des diagnostics.
