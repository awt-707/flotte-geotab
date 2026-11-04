# Connecteur Uber Fleet pour Ludy local

Le serveur de préparation doit fonctionner sur `http://127.0.0.1:4173`. Ce connecteur ne transmet à aucune autre destination. Dans **Connecteurs** de Ludy, un administrateur génère un code d’association valable au maximum 90 jours, expirant après 30 jours sans activité. Une nouvelle génération révoque son ancien code. Le serveur vérifie toujours que cet administrateur conserve son rôle.

## Installation

Depuis la racine de `flotte-geotab` :

```sh
node staging/uber-extension/build.mjs
```

Les archives `ludy-uber-chromium.zip` et `ludy-uber-firefox.zip` sont également générées pour le téléchargement depuis Ludy. Extraire l’archive puis sélectionner son dossier ou son `manifest.json` selon le navigateur.

- **Chrome, Chromium, Edge** : ouvrir `chrome://extensions` (ou `edge://extensions`), activer le mode développeur, **Charger l’extension non empaquetée**, sélectionner `staging/uber-extension/chromium`.
- **Firefox** : ouvrir `about:debugging#/runtime/this-firefox`, **Charger un module temporaire**, sélectionner `staging/uber-extension/firefox/manifest.json`. Firefox demande de recharger ce module temporaire après redémarrage. Une distribution permanente nécessitera un module signé.

Dans Firefox, autoriser également l’accès demandé à `http://127.0.0.1:4173` dans les permissions de l’extension.

Pour passer à la version **0.6.6**, reconstruire ou réextraire l'archive dans le dossier réellement chargé par le navigateur, puis cliquer sur **Recharger** dans la page des extensions. **Recharger ensuite les pages Uber Fleet**, puis ouvrir l'extension et cliquer sur **Démarrer la lecture**. Le popup doit afficher **v0.6.6**. Recharger la page retire l'ancien lecteur déjà injecté ; recharger seulement l'extension ne suffit pas. Une liaison persistante déjà fonctionnelle se conserve. Le lecteur Live Map 0.6.6 coordonne désormais la fin du parcours avant chaque actualisation ; les rapports utilisent leur propre lecteur.

## Utilisation

1. Ouvrir Uber Fleet et se connecter normalement dans le navigateur. Afficher la **Live Map** de la flotte et sa liste de chauffeurs sur le second écran.
2. Ouvrir le bouton de l’extension, coller le code temporaire fourni par Ludy, puis **Associer ce navigateur**.
3. Depuis cet onglet Live Map, cliquer sur **Démarrer la lecture**. L'extension fait défiler la liste pour lire les chauffeurs suivants, y compris au-delà des dix premières lignes. Le popup indique le nombre total de chauffeurs lus pendant ce parcours, sa couverture et le dernier envoi.
4. Pour retrouver la lecture après fermeture de l'onglet ou du navigateur, cocher **Reprendre automatiquement** dans l'extension et accepter l'autorisation demandée par Chromium. L'extension attend uniquement la Live Map de la flotte déjà choisie, visible sur le second écran. Elle n'ouvre aucune page et ne reconnecte pas votre compte Uber. Si plusieurs onglets de cette flotte sont visibles, en conserver un seul pour lever l'ambiguïté.
5. Garder la page visible, avec la liste ouverte. Le premier parcours commence immédiatement, puis une nouvelle lecture est demandée toutes les 15 secondes sans chevauchement. Le défilement se limite à la liste reconnue et retrouve sa position initiale à la fin. Un clic, une touche ou votre défilement interrompt le parcours ; l'extension vous laisse alors la main. Un rechargement du même onglet Live Map est repris automatiquement. Sans l'option de reprise, cliquer de nouveau sur **Démarrer la lecture** après fermeture de l'onglet ou du navigateur ; le code reste enregistré. Si le code expire ou est révoqué, en générer un autre dans Ludy.
6. **Arrêter** suspend réellement la collecte Live Map, même avec la reprise automatique activée, jusqu'au prochain clic sur **Démarrer**. **Effacer l’association** retire le code enregistré dans ce navigateur et arrête aussi les rapports ; la connexion Uber reste inchangée. Désactiver la reprise suspend la lecture Live Map et retire l'autorisation optionnelle si elle n'est pas utilisée par la collecte des rapports ; le démarrage manuel reste disponible.

## Actualisation de la Live Map

Pendant la collecte, la Live Map est rechargée toutes les vingt minutes. Le parcours en cours et sa transmission à Ludy se terminent avant le rechargement ; aucun autre parcours ne démarre entre cette fin et la navigation. La lecture reprend sur la même flotte avec le code conservé. Une page cachée ou une interaction récente reporte cette actualisation. **Arrêter** annule aussi les actualisations. L’onglet Rapports reste indépendant. Une actualisation du navigateur ne prouve pas que les données du fournisseur ont changé ; les dates de source ne sont jamais inventées.

## Rapports dans un navigateur local dédié

L'extension continue à lire la **Live Map** sur le second écran. Pour télécharger les rapports en fichiers locaux, utiliser le navigateur Ludy dédié et arrêter uniquement **les rapports** dans le popup de l'extension.

1. Démarrer Ludy local. Dans **Rapports automatiques**, enregistrer la flotte Uber, le nom exact de l'organisation, les villes/agences et le format des dates, puis activer les rapports.
2. Dans l'extension, cliquer sur **Arrêter les rapports**. Ne pas arrêter **Démarrer la lecture / Live Map** et ne pas effacer l'association existante.
3. Depuis la racine de `flotte-geotab`, lancer dans un autre terminal :

```sh
npm --prefix staging run uber:reports-browser
```

4. Se connecter manuellement à Uber dans la fenêtre qui s'ouvre, avec les éventuelles vérifications demandées par Uber. La session est conservée dans le profil privé `staging/.local/uber-reports-browser/profile` ; elle peut nécessiter une nouvelle connexion après expiration. Aucun nouveau code d'association Ludy n'est demandé.
5. Garder ce navigateur, son terminal et le serveur local ouverts. Les rapports **Trip activity**, **Driver activity** et **Driver quality** sont lus séparément sur les sept journées complètes précédentes, avec de nouveaux passages toutes les six heures. Le téléchargement utilise le bouton ou lien CSV normal de la page Uber.

Le collecteur utilise le Chromium fourni avec Playwright, avec son sandbox activé. `LUDY_REPORTS_CHROMIUM` permet de choisir explicitement un autre exécutable compatible. Après la connexion habituelle, `--headless` conserve la session dédiée sans fenêtre ; une demande de connexion ou de validation reste à traiter en mode visible.

Le contexte est fixé à **Africa/Casablanca**. Uber interprète les dates du formulaire dans le fuseau du navigateur ; la colonne visible **Report time range** prévaut donc sur les dates du nom de fichier. Le collecteur sélectionne 00:00 au début puis 00:00 le lendemain de la dernière journée. Si cette dernière borne est indisponible, une période de sept jours décalée d’un jour est conservée et affichée explicitement. Le journal de demandes pour ce contexte est privé : `staging/.local/uber-reports-browser/morocco-calendar/report-jobs.json`. Il ne faut pas l’effacer pour relancer une génération.

Ce profil est séparé de celui du navigateur habituel ; le programme n'explore pas le dossier Téléchargements général. Un bail serveur de **90 secondes**, renouvelé par le navigateur dédié, empêche une collecte concurrente. Les rapports de l'extension sont refusés pendant ce bail, sans interrompre la Live Map. Ne pas réactiver les rapports de l'extension pendant l'utilisation de ce navigateur.

La connexion, le formulaire et les téléchargements CSV ont été vérifiés sur le compte réel. Les imports Activité et Qualité ont été vérifiés sur leur période exacte ; les horodatages Courses demandent un fuseau confirmé avant analyse. Une fenêtre ouverte ou une session conservée ne prouve pas qu'un nouveau rapport a été reçu. Les étapes qui nécessitent une reconnexion ou une intervention restent visibles ; aucun rapport fictif n'est créé.

### Fichiers conservés par Ludy

Après validation de leur format, les CSV acceptés sont enregistrés intégralement dans `staging/.local/uber-reports/files/<organisation>/` avant l'import en base. Le serveur génère les noms avec le type de rapport, la période et l'empreinte SHA-256 ; un même contenu pour la même organisation, le même type et la même période réutilise le même fichier. La limite est de **6 Mio** par export.

Les fichiers restent disponibles après import pour contrôle local. Les reçus JSON dans `staging/.local/uber-reports/receipts/` portent `pending`, `imported` ou `failed`, les dates, la taille et l'empreinte ; ils ne contiennent ni CSV ni message libre. Les dossiers sont en **0700**, les fichiers en **0600**, ignorés par Git et non servis par le site. Aucune suppression automatique des archives n'est activée.

Les **tables d'analyse** ne conservent que les colonnes nécessaires au rapprochement et aux calculs. Les **CSV privés** conservent l'export entier, y compris les colonnes ignorées par ces tables. Le stockage de l'extension ne conserve toujours pas de copie du CSV.

## Rapports via l'extension 0.6.6 — solution alternative

Ce parcours reste disponible lorsque le navigateur dédié est arrêté et que le navigateur utilise **Africa/Casablanca**. Un autre fuseau bloque seulement les rapports, pour éviter un export décalé ; utiliser alors le collecteur dédié, qui fixe ce contexte automatiquement. Il ne faut pas activer simultanément les deux collecteurs. Les étapes ci-dessous concernent uniquement la solution utilisant l'extension.

Le parcours suit la procédure normale décrite par [Uber](https://help.uber.com/driving-and-delivering/article/reports?nodeId=764c22ab-3caa-4f11-b380-d4fca5fe211f) : choix du rapport détaillé de courses, de la période, génération puis téléchargement. Il utilise un **onglet Rapports séparé** et ne navigue jamais à la place de la Live Map.

1. Dans l’analyse Uber de Ludy, un administrateur renseigne la flotte Uber, les agences correspondant à Casablanca/Marrakech et le format explicite des dates, puis active l’import automatique. La période couvre les sept journées complètes précédentes à l’heure du Maroc.
2. Dans le popup de l’extension, cliquer **Activer les rapports** et accepter l’autorisation sur Uber Fleet. Un onglet `/orgs/<flotte>/reports` est réutilisé ou ouvert en arrière-plan, sans remplacer la carte.
3. Se connecter normalement à Uber dans cet onglet si nécessaire. Le lecteur ne lit aucun mot de passe, cookie ou jeton Uber. Il ne reçoit que l’identifiant de flotte et la période ; le code d’association reste dans le fond de l’extension.
4. Le bouton « Generate Report » ouvre d’abord le formulaire, sans créer de rapport ni de planification. Lorsque le formulaire est reconnu, les types « Trip activity », « Driver activity » et « Driver quality » sont traités séparément avec les deux dates et le bouton Générer. Une seule lecture s’exécute à la fois. Un type indisponible est signalé dans le popup, sans bloquer les autres ni la Live Map. La même demande ne se répète pas pendant l’attente de génération. Une fois prêt, le lien rendu dans la ligne du rapport exact est lu et le CSV transmis uniquement à Ludy local.

Les contrôles reconnus sont un sélecteur de type natif ou accessible, deux champs de date explicitement identifiables (`YYYY-MM-DD` ou `YYYY/MM/DD`) et un bouton de génération. Les heures présentes sont vérifiées à 00:00 et 23:59. Le sélecteur d’organisations utilise l’UUID ou le nom exact renseigné dans Ludy, jamais le premier choix ou « toutes les organisations ». Un calendrier en lecture seule avec une mauvaise période demande une correction dans Uber. Une interface différente, plusieurs exports indistinguables, un lien sur un autre domaine ou un téléchargement non CSV produisent un message **à configurer**. L’extension n’invente pas d’endpoint privé et ne contourne pas les permissions ni une protection du navigateur. La lecture réelle du formulaire de ce compte reste à valider après installation ; les tests sur des pages simulées ne prouvent pas sa compatibilité.

Le lecteur vérifie une période de 31 jours maximum et un CSV de 6 Mo maximum. Le serveur choisit les jours à importer et vérifie les colonnes et les dates des courses. Après un succès, le rapport visible est relu toutes les six heures pour recevoir ses éventuelles corrections ; un fichier inchangé reste dédupliqué côté Ludy. Une génération déjà demandée est contrôlée chaque minute pendant quinze minutes, puis toutes les six heures si elle tarde, sans nouvelle demande. Le rechargement de l’onglet ou le redémarrage du navigateur conserve le délai de six heures. Un clic volontaire sur **Activer les rapports** relance la période sélectionnée. **Arrêter les rapports** suspend ce seul workflow. Fermer l’onglet met la lecture en attente ; le code d’association et la Live Map sont conservés.

Les courses peuvent alimenter les fiches chauffeur par UUID exact ou, uniquement sans UUID, par nom complet unique dans cette flotte. La distance reste absente sans unité explicite. La date de demande et la date de fin ne sont pas assimilées à une durée avec passager. Les rapports activité/qualité fournissent les heures et taux officiels pour leur période exacte ; ils ne sont pas proratisés et ne prouvent aucune pause. Aucun revenu n’est fabriqué à partir de ces trois types.

Le CSV n’est pas enregistré dans le stockage de l’extension. Il est toutefois conservé intégralement dans les fichiers privés de Ludy décrits ci-dessus lorsqu'il est accepté par le serveur. Seuls l’état de suivi, la période demandée/importée et les horodatages restent dans le stockage de l'extension. Un bouton Download sans lien lisible est signalé sans demander un export supplémentaire. Les URL de téléchargement potentiellement signées ne sont pas transmises à Ludy ; seule l’adresse de la page Rapports, sans paramètres de session, accompagne l’import.

Le code local est conservé dans le stockage local privé de l’extension, jamais dans le DOM Uber, la page web Ludy ou le diagnostic du popup. Dans Chromium, l'accès à ce stockage est limité aux contextes de confiance de l'extension. Le serveur n'enregistre que son empreinte cryptographique dans un fichier privé. Le renouvellement de l'activité est enregistré au maximum toutes les cinq minutes.

## Continuité de lecture

- Une panne du serveur local entraîne des tentatives espacées de 15, 30, 60 puis 120 secondes. Un délai de quota demandé par le serveur est respecté jusqu'à cinq minutes. Le lecteur reste démarré ; seules de nouvelles observations sont envoyées lors de la reprise. Aucune file d'anciennes positions ou d'anciens statuts n'est rejouée.
- Une alarme du navigateur contrôle le lecteur toutes les minutes. Elle permet la reprise après suspension du service worker ou rechargement du même onglet. En mode automatique, une navigation hors de la Live Map suspend la collecte jusqu'au retour à la même flotte ; une autre flotte n'est jamais adoptée. En mode manuel, cette navigation arrête le suivi.
- Une page cachée, une session Uber expirée, une région en cours de chargement, un réseau déconnecté ou une bannière de reconnexion explicite est signalé comme interrompu. Le lecteur continue de vérifier la page et reprend quand celle-ci redevient exploitable ; ces situations ne créent aucun chauffeur hors ligne.
- Un code refusé (`401`/`403`) arrête la transmission et demande une nouvelle association. Une commande **Arrêter** n'est jamais annulée par le mécanisme de reprise.
- Deux collecteurs concurrents ne sont pas présentés comme deux transmissions réussies : un refus de propriété (`409`) affiche le conflit et attend une nouvelle tentative. Une réponse ignorée ou trop ancienne n'actualise jamais la dernière transmission réussie. Une absence de réponse du fond de l'extension libère le lecteur après 12 secondes pour permettre une nouvelle observation.
- Par défaut, l'autorisation reste limitée à `activeTab`. La reprise après redémarrage utilise une permission **optionnelle**, demandée dans le navigateur seulement lors de l'activation de cette fonction, sur `https://fleethub.uber.com/*`. Le code limite ensuite la lecture à la Live Map de la flotte choisie. Retirer cette permission arrête la collecte ([documentation Chrome](https://developer.chrome.com/docs/extensions/reference/api/permissions)).

## Lecture et états

La palette demandée pour ce projet est **gris `#545454` = disponible**, **bleu `#276ef1` = en course**, **vert `#05944f` = en approche**. Un libellé explicite « Hors ligne » / « Offline » donne hors ligne. Une contradiction entre la pastille et ses libellés accessibles donne un état inconnu, jamais une décision arbitraire. Les autres couleurs/libellés restent inconnus. Un chauffeur absent ou une erreur de lecture ne deviennent jamais hors ligne.

Le lecteur reconnaît les tableaux avec colonnes Chauffeur/Statut et les cartes visibles portant avatar et pastille. Le parcours fait défiler uniquement leur conteneur reconnu, attend l'affichage des lignes suivantes et relit les éléments rendus à l'écran. Après les statuts, il peut ouvrir les détails en cliquant sur le nom d'une carte reconnue et cliquable, jamais sur le menu « … », les filtres ou la carte géographique. La carte initialement ouverte et le défilement sont restaurés si le parcours n'a pas été interrompu par l'utilisateur. Les éléments encore masqués, tronqués, recouverts ou hors écran sont exclus. Les noms servent uniquement quand aucun identifiant chauffeur visible n'est disponible ; les homonymes à des positions distinctes sont ignorés et signalés.

**Liste affichée parcourue** signifie que le parcours a atteint le bas de cette liste. Cela ne garantit pas la présence de toute la flotte : une recherche ou un filtre Uber peut en retirer des chauffeurs. Retirer les filtres inutiles pour une couverture plus large. Une limite atteinte, une interaction ou une liste instable produit une lecture partielle ; elle ne transforme jamais les lignes manquantes en statut hors ligne. Chaque parcours des statuts reste borné à 200 chauffeurs et 40 déplacements ; la lecture des détails partage la même limite globale de 18 secondes. Si la liste dépasse ces limites, le popup le signale.

Une plaque peut être transmise lorsqu'elle figure dans une colonne d'immatriculation ou dans les détails visibles du même chauffeur, y compris une ligne « 86121-T-1 · 2026 Hyundai Staria ». La plaque est séparée du modèle ; le modèle seul ne permet jamais une association. Les numéros de téléphone et attributs invisibles sont exclus. Jusqu'à 12 fiches sont ouvertes par passage, avec rotation des fiches restantes et sous la limite globale de 18 secondes. Le popup indique séparément la couverture des plaques.

Fermer une fiche ne rajeunit pas sa preuve : un cache en mémoire conserve la plaque et le modèle au maximum 180 secondes, avec `vehicleReadAt` et `vehicleState` décrivant l'heure et l'état réellement lus avec cette plaque. `readAt` reste l'heure du statut actuel. Une nouvelle plaque remplace l'ancienne ; une fiche ouverte sans plaque exploitable révoque son cache. Une interruption, un changement de flotte ou une identité ambiguë invalide les preuves concernées. Les champs véhicule ne prouvent pas à eux seuls une affectation : le serveur recoupe l'état en ligne, les autres plateformes, les contrats et les éventuels changements de shift.

Les lectures Live Map portent `observedAt`/`readAt`. Chaque chauffeur garde l'heure à laquelle sa ligne a réellement été lue pendant le parcours ; la fin du défilement ne rajeunit pas les premières observations. `sourceAt` reste nul : un écran relu récemment ne prouve pas que les données Uber ont été mises à jour. Le lecteur de Live Map n'appelle aucun endpoint Uber, ne lit ni cookie ni mot de passe, et ne conserve aucun HTML, téléphone ou portrait. Le lecteur Rapports utilise uniquement le lien de téléchargement normalement rendu par cette autre page.

## Vérifications locales

```sh
node --test staging/tests/uber-extension.test.mjs
node --test staging/tests/uber-pairing.test.mjs staging/tests/uber-durability.test.mjs
node --test staging/tests/uber-scanner.test.mjs
node --test staging/tests/uber-vehicle-details.test.mjs
node --test staging/tests/uber-reports-extension.test.mjs
```

Les tests utilisent uniquement des chauffeurs fictifs et une page locale interceptée. Ils vérifient la palette, les états explicites, le périmètre visible, le parcours d'une liste plus longue que l'écran, les erreurs, le contrat de transmission et l'interdiction des destinations distantes. Aucun compte Uber réel n'est ouvert ; la vérification du parcours sur la Live Map utilisée reste à faire après rechargement de l'extension et de la page. Le stockage des CSV et l'API commune sont vérifiés séparément avec des fichiers et comptes de test ; le premier téléchargement réel dans le navigateur dédié reste à valider.


### Diagnostic et reprise des rapports de l'extension (0.6.6)

L’écran **Rapports automatiques** reçoit désormais la version et l’état du collecteur local, sans contenu du rapport ni secret. Un contact de plus de 150 secondes est affiché comme ancien. Après mise à jour, recharger l’extension et les pages Uber, puis cliquer sur **Activer les rapports** dans le menu de l’extension ; l’activation du réglage Ludy ne démarre pas à elle seule un navigateur.

Les interactions utilisateur et interruptions temporaires sont réessayées après une minute. Un arrêt puis redémarrage conserve les demandes déjà enregistrées et les échéances de six heures. Avant de cliquer sur Générer, le lecteur réserve durablement cette demande dans le stockage de l’extension. En cas d’accusé perdu, il attend l’export au lieu de demander un doublon ; si aucune génération n’apparaît dans Uber, l’opérateur doit la vérifier dans cet onglet. Les appels au navigateur sont bornés et une lecture sans réponse ne bloque plus les suivantes.

La version 0.6.6 conserve les erreurs du bouton Activer dans le popup au lieu de les effacer à la seconde suivante. Le diagnostic transmis à Ludy se limite à une liste fermée de catégories (formulaire, période, organisation, téléchargement), sans DOM, texte de page ou donnée de rapport.

La version 0.6.6 reconnaît également les sélecteurs dont le libellé est à côté d’un champ de recherche vide, et recherche les champs dans le tiroir du rapport indépendamment du tableau en arrière-plan. Une relance efface les anciens messages de formulaire tout en conservant les demandes déjà réservées. Le diagnostic structurel se limite aux types de contrôles, rôles, catégories de champs et compteurs, sous 2 Ko par rapport ; il ne contient aucun libellé libre, valeur de saisie, identifiant DOM ou nom d’organisation.

La version 0.6.6 associe aussi les libellés et contrôles placés comme frères dans le tiroir Uber, en s’arrêtant au prochain champ. Sans libellé exploitable, seul un sélecteur unique montrant un type de rapport reconnu peut servir de secours ; un champ de recherche libre n’est pas une sélection. Si les libellés d’heures sont présents mais leurs contrôles illisibles, aucune génération n’est demandée.
