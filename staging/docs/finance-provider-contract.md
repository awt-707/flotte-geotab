# Contrat financier des fournisseurs

Périmètre : staging Ludy, CA et Caisse. Révision du 3 novembre 2026. Les définitions ci-dessous décrivent les indicateurs métier de Ludy ; elles ne définissent pas un chiffre d’affaires fiscal ni un bénéfice comptable.

## Uber : revenus, brut et net

Uber distingue les revenus, les remboursements/dépenses, les paiements et les soldes dans son relevé. Les libellés et catégories varient selon le marché. L’aide explique notamment la décomposition de `Total earnings` et la séparation des encaissements et virements. [Aide officielle sur les relevés](https://help.uber.com/driving-and-delivering/article/understanding-earnings-statements?nodeId=4dd34dcd-7a75-4950-88d8-c32d78e0fa94).

| Indicateur Ludy | Champ | Définition retenue |
| --- | --- | --- |
| Revenus déclarés | `revenue_minor` | Montant `Total earnings` du relevé exact. |
| Brut avant frais et Taxes | `gross_minor` | `Fare + Tip + Promotion`. |
| Net après commissions, avant Taxes Uber | `net_minor` | Brut + `Service Fee` **signée**. |
| Taxes déclarées par Uber | `taxes_minor` | Valeur `Taxes` **signée**, conservée séparément. |
| « Net earnings » affiché par Uber | `reported_net_earnings_minor` | Valeur fournisseur distincte, pouvant inclure des mouvements de règlement ; jamais assimilée au net précédent. |
| Versements et espèces | `payout_minor`, `cash_minor` | Mouvements déclarés ; ils ne s’ajoutent pas aux revenus pour calculer le CA. |
| Soldes, ajustements, remboursements | Champs dédiés | Hors des formules de brut/net ; les soldes sont des stocks de compte. |

Les formules sont autorisées seulement si les enfants immédiats du détail développé de `Total earnings` sont entièrement lus, reconnus et rapprochés au centime :

```text
brut = Fare + Tip + Promotion
net avant Taxes Uber = brut + Service Fee signée
revenus déclarés = net avant Taxes Uber + Taxes signées
```

Exemple synthétique en MAD : `847 − 148 = 699` de net avant Taxes Uber ; `699 − 29 = 670` de revenus déclarés. Un « Net earnings » affiché à 315, un versement à −382 ou un ajustement à 27 restent des valeurs distinctes. Ils ne modifient pas ces formules.

Le libellé « Taxes » ne précise pas leur nature fiscale : aucune retenue, TVA ou qualification HT n’est supposée. Une commission positive ou une taxe positive reste positive : aucune valeur absolue ni convention de signe supplémentaire n’est appliquée. Les corrections négatives sont conservées.

## Preuve et valeurs inconnues

Le calcul partagé est dans [provider-earnings-calculation.js](../site/provider-earnings-calculation.js). Il accepte uniquement `Fare`, `Service Fee`, `Taxes`, `Tip`/`Tips`, `Promotion`/`Promotions`. Un libellé comme `Net fare`, un sous-détail de Fare ou un intitulé inconnu ne suffit pas à prouver ce brut.

Une catégorie optionnelle absente vaut zéro uniquement dans une liste exhaustive validée. Une valeur déjà observée qui contredit cette absence interdit le calcul ; elle n’est pas écrasée. Doublon, détail partiel, composante inconnue, montant non entier, débordement ou écart avec `Total earnings` donnent une provenance `unavailable`. Les montants explicitement observés restent conservés ; aucun brut/net nouveau n’est fabriqué.

Une preuve `verified` contient les composantes, leurs libellés, leurs montants, les définitions de brut/net et le contrôle `reconciliation: exact`. [La migration 28](../supabase/migrations/20261228000000_provider_earnings_calculations.sql) vérifie à nouveau les équations et la cohérence des composantes avant stockage. La correction 29 refuse aussi les métadonnées de preuve malformées au lieu de laisser passer un résultat SQL NULL. Elle ne recalcule pas les anciens relevés. Les valeurs nulles restent inconnues ; elles ne deviennent pas zéro.

Tous les calculs utilisent des entiers en unités monétaires mineures. Les devises restent séparées ; aucune conversion de change n’est implicite. La convention historique `MAD_LEGACY` et la devise inconnue restent distinctes d’un MAD confirmé.

## Périodes et absence de double comptage

La semaine métier commence le lundi à **04:00, Africa/Casablanca**, avec une borne de fin exclusive. Jour et mois utilisent minuit local. L’aide Uber indique également un cycle hebdomadaire commençant le lundi à 04:00 locale ; cela ne prouve pas que chaque page Earnings est déjà réglée sur cette plage. [Cycle de paiement officiel](https://help.uber.com/driving-and-delivering/article/my-weekly-payment-is-missing?nodeId=93f46763-ca8d-4f98-a823-69616d81743f).

Le collecteur utilise maintenant le sélecteur normal `Custom range` pour lire la semaine courante et la semaine précédente. Les deux champs visibles ne proposent que des dates. Le comportement réel observé diffère entre une fin passée (inclusive) et une date future saisie (exclusive) : le collecteur relit les bornes, autorise au maximum une correction d’un jour calendaire, puis exige exactement lundi 04 h → lundi 04 h. Les réponses provoquées par cette navigation normale confirment ensuite les instants exacts ; aucun endpoint privé n’est rejoué. Si le contrôle échoue, le relevé n’est pas transmis.

La semaine courante est un relevé de toute la fenêtre hebdomadaire **observé à une date donnée**, pas une capture exacte jusqu’à l’heure du chargement de Ludy. Seul le filtre semaine canonique peut utiliser cette base ; les écritures individuelles gardent leur véritable borne de lecture. L’interface et le CSV distinguent ces bornes et désactivent la comparaison à durée égale. Les jours, mois et dates libres conservent leurs critères de correspondance stricte. Une capture faite avant la clôture d’une semaine ne devient pas un relevé définitif après la clôture : une nouvelle lecture est nécessaire.

Chaque capture conserve ses bornes fournisseur exactes, y compris les secondes/millisecondes lorsqu’elles sont établies. `observed_at` désigne la lecture, pas la date des courses. Une semaine fournisseur n’est jamais divisée artificiellement en jours, chauffeurs, véhicules ou services de caisse. Une date sans heure qui traverse une borne reste dans un sous-total non attribuable.

Un relevé direct remplace les imports Uber uniquement si organisation, agence/chauffeur demandé, période exacte, devise, population, pagination et rapprochements sont prouvés complets. Toutes les devises historiques concernées doivent être confirmées et couvertes. Sinon les imports restent la base du total et le relevé apparaît séparément.

Le total flotte et les lignes chauffeurs sont deux vues du même argent : ils ne s’additionnent pas. Un champ flotte manquant peut provenir de la somme de toutes les lignes chauffeurs seulement si leur couverture et leurs montants sont complets ; cette origine est affichée. Un total flotte connu, même nul, reste prioritaire. Soldes, versements, ajustements et « Net earnings » brut ne servent pas de repli pour calculer le net.

La sélection charge la fenêtre exacte et le dernier relevé complet pertinent par organisation/devise, ou le dernier partiel en l’absence de complet. Ces fenêtres chevauchantes restent distinctes. Le dernier relevé présenté dans un mois ne prétend pas couvrir tout le mois. Une comparaison exige des périodes comparables et une base financière cohérente ; une source illisible ne devient pas un revenu nul.

## Chauffeurs, agences et véhicules

Le rattachement exige l’UUID chauffeur Uber dans la bonne organisation, une identité locale non provisoire, un seul chauffeur local, un code Ludy existant et des agences concordantes. Les associations locales admises sont `manual`, `exact_name` ou `name_spacing`, déjà validées dans le référentiel. Le nom affiché seul ne fournit jamais une agence. Les lignes non rapprochées restent hors des totaux d’agence/chauffeur et dans un contrôle administrateur distinct.

Les managers lisent les lignes de leurs agences sous RLS, pas les totaux de flotte réservés aux administrateurs. Les droits sont revérifiés avant publication. Le véhicule actuellement affecté à un chauffeur ne prouve pas quel véhicule a produit ses revenus historiques : un CA par véhicule nécessite une liaison de course/véhicule explicite.

Les rapports Uber décrivent notamment des identifiants de transaction, chauffeur et course ainsi que des colonnes financières variables selon le pays. Leur documentation ne garantit ni l’accès API du compte ni la présence de chaque colonne dans chaque export. [Référence officielle des rapports financiers](https://developer.uber.com/docs/vehicles/references/api/v1/vehicle-suppliers/suppliers/payment-based-reports-fleet).

## Bolt, inDrive et courses privées

| Source | Base financière utilisable actuellement | Limite |
| --- | --- | --- |
| Bolt | Relevés importés `bolt_sessions`, avec les composantes effectivement présentes. | L’API publique vérifiée expose les courses et leurs prix, pas un relevé certifiant revenus, commissions, espèces encaissées ou versements. |
| inDrive | Non utilisé actuellement, hors du périmètre demandé. | Aucun montant ni zéro n’est ajouté pour cette plateforme. |
| Courses privées | `cash_moves` non annulés, `kind=course` : prix de course saisi pour revenus/brut ; remise d’espèces séparée. | Prime chauffeur et remise d’espèces ne suffisent pas à déduire un net. Une course privée n’est pas automatiquement une course inDrive. |

Pour Bolt, `price.total`, ses composantes et le mode de paiement restent des informations de course. Ils ne sont pas ajoutés aux sessions financières ni utilisés pour solder un service de caisse. Le statut exact est défini dans [bolt-finance.mjs](../server/bolt-finance.mjs). La [spécification publique Bolt](https://apidocs.bolt.eu/fleetIntegration/fleetIntegrationGatewayV2Auth/open-api.json), relue le 3 novembre 2026, liste sept opérations de flotte, dont `getRideHistory`, sans opération de relevé financier.

L’utilisateur a confirmé qu’inDrive n’est pas encore en place. Son absence n’est pas un blocage du staging actuel. Une intégration future nécessiterait une source autorisée et des champs financiers explicitement définis.

## Collecte, imports et limites confirmées

Le navigateur dédié relit chaque détail depuis le bouton de sa propre ligne. Avant de joindre les composantes, il vérifie le nom complet et les cinq montants du tableau dans le tiroir ouvert. Une catégorie inconnue, une modification du tableau pendant la lecture ou une discordance monétaire empêche de publier une décomposition incorrecte. Une rubrique sans enfants après un seul clic reste inconnue ; elle ne déclenche pas une boucle de clics et ne fabrique pas un zéro.

La prochaine collecte commence au moins cinq minutes après la fin de la précédente. Une réponse 429 observée pendant la navigation suspend la lecture et espace les tentatives de 15, 30 puis 60 minutes. La semaine précédente complète est relue au démarrage, lors du changement de semaine et au moins chaque 24 heures. Le rafraîchissement de Ludy toutes les 30 secondes ne déclenche pas lui-même des demandes chez Uber.

Validation réelle de la session autorisée puis réception dans le staging local le 3 novembre 2026 : la semaine du 2 au 9 novembre a livré 34 lignes sur 4 pages, 31 UUID prouvés, une décomposition flotte exacte et 33 détails chauffeurs vérifiés. Le dernier détail absent correspondait à des revenus déclarés nuls, mais son brut/net est resté inconnu. La semaine du 26 octobre au 2 novembre a livré 37 lignes, 34 UUID et 37 décompositions vérifiées. Les lectures fournisseur ont été observées respectivement à 17:31:42 et 17:32:28 UTC. La base confirme 23 rattachements à un chauffeur et une agence pour la semaine courante, 24 pour la précédente ; aucune preuve invalide ni ligne d’une autre révision n’a été trouvée. Ces compteurs décrivent les lectures réalisées, pas un engagement de couverture future. Les trois noms sans correspondance textuelle exacte n’ont pas été rattachés par approximation. Les rattachements aux agences demeurent soumis au référentiel confirmé.

Pour Bolt, ouvrir **Caisse → Import → Bolt**, puis choisir le `Journal d’activité des services` exporté du portail. Le parseur exige notamment `Date`, `Chauffeur`, `Total des paiements|DH` et `Espèce|DH` (MAD explicite accepté). Un montant obligatoire absent ou malformé, une devise non confirmée, un en-tête dupliqué ou deux lignes d’une même session avec des montants contradictoires annule l’import du fichier. Les vrais zéros et les montants signés sont conservés. Le journal ne fournit pas à lui seul les commissions ni le brut/net ; ces indicateurs restent indisponibles tant qu’un relevé approprié n’est pas intégré. Les prix de course obtenus par l’API restent accessibles dans la performance et ne deviennent pas un CA comptable. La recherche ciblée de CSV/tableurs dans le projet et les Téléchargements le 3 novembre n’a trouvé aucun relevé financier Bolt disponible ; les exports Uber trouvés ne comportent que l’activité et la qualité.

## Rapprochement explicite des identités

La migration locale 31 prépare une file réservée à l’administrateur et une confirmation atomique utilisant les identités et l’audit déjà présents. La file reste liée à la flotte configurée et à la révision du relevé. Pour les huit UUID prouvés mais non associés de l’audit initial, l’administrateur choisit la fiche Ludy et son agence, indique une référence de preuve vérifiée et confirme explicitement la correspondance. Une agence connue contradictoire est refusée ; une agence absente ne peut être renseignée qu’avec la confirmation supplémentaire affichée dans le formulaire.

La confirmation refuse une révision périmée, un rôle révoqué, une identité déjà liée à une autre personne et un conflit de véhicules entre profils. Elle réutilise la fusion qui préserve les références historiques, conserve les modes de véhicules existants et inscrit l’auteur, la preuve, l’UUID, la fiche et l’agence dans `fleet_link_audit`. Elle ne modifie ni montant ni relevé financier historique. La prochaine collecte normale rapproche les nouveaux relevés à partir de cette identité explicite.

Les trois lignes sans UUID fournisseur ne peuvent pas être confirmées : le dialogue explique quel profil ou export autorisé obtenir et ne stocke aucune proposition spéculative. Ni un nom proche, ni un montant identique, ni l’affectation actuelle d’un véhicule ne vaut preuve d’identité. Aucun des huit rattachements possibles n’est confirmé automatiquement pendant la préparation.

## Validation

Les régressions ciblées se trouvent dans `tests/uber-earnings-calculation.test.mjs`, `tests/provider-earnings-data.test.mjs`, `tests/revenue-data.test.mjs` et `tests/provider-earnings-calculations.integration.mjs`. La répétition SQL est locale et transactionnelle avec rollback ; elle ne vaut pas confirmation de déploiement. Aucun mot de passe, jeton, nom réel de chauffeur ni extrait de relevé réel n’appartient à ce document.

Le contrôle navigateur authentifié local du 3 novembre 2026 à 17:33 UTC a vérifié le CA de la semaine ouverte, le relevé de la semaine précédente et la Caisse par agence. Le brut/net calculé, la définition avant Taxes, la date de lecture et les bornes 04:00 sont visibles ; la semaine ouverte ne présente aucune comparaison à durée égale. La Caisse garde le relevé hebdomadaire distinct de sa sélection par jours et ne modifie aucun encaissement. Les panneaux financiers tiennent à 390 px de largeur ; la navigation libère leurs abonnements. Aucune erreur JavaScript ou HTTP n’a été observée. Le harnais bloque les écritures, y compris le signal de présence facultatif de la session ; seules l’authentification locale et les lectures sont autorisées.
