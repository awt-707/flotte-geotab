// ============================================================================
// CONSTANTES (reprises du Sheet v6)
// ============================================================================
const TZ = 'Africa/Casablanca';
const PARC_ID_DEFAULT = '14HGWlCDPb3aCNZOZVQi2wgHHoZXCOrWBhekbyCPYxys';
const MAX_RUN_MS = 4.6 * 60 * 1000;
const ENGINE_V = '5.3';
const SYNC_CHUNK_DAYS = 2;
const SYNC_PARALLEL = 4;
const GEO_MAX_RESULTS = 50000;
const HOUR = 3600000, MIN = 60000, DAY = 86400000;
const HORS = 'HORS_CONTRAT';
const H = {
  VEH: ['Plaque', 'Clé', 'Marque', 'Modèle', 'Carburant', 'VIN', 'Geotab ID', 'Nom Geotab',
    'Réservoir (L)', 'Conso réf (L/100)', 'Recette/contrat (MAD)', 'Actif', 'Dernière synchro', 'Autres plaques'],
  DRV: ['Code', 'Nom', 'Autres noms', 'Téléphone', 'Email', 'Premier contrat', 'Dernier contrat',
    'Nb contrats', 'Statut', 'Détecté le', 'Note'],
  CTR: ['N° contrat', 'Code client', 'Nom', 'Plaque', 'Clé plaque', 'Modèle', 'Début', 'Fin', 'Statut',
    'Origine', 'Téléphone', 'Email', 'Commentaire', 'Importé le', 'Mis à jour le'],
  TRIP: ['ID', 'Clé plaque', 'Plaque', 'Date', 'Début', 'Fin', 'Km', 'Conduite (min)', 'Ralenti contact (min)', 'Moteur éteint à l\'arrêt (min)',
    'Ralenti moteur tournant (min)', 'Source ralenti', 'Ralenti prolongé (min)', 'Nb ralentis prolongés', 'Vmax (km/h)',
    'Vmoy (km/h)', 'Vmax GPS (contrôle)', 'Limite à Vmax', 'Source limite', 'Pire dépassement (km/h)', 'Vitesse au pire', 'Limite au pire',
    'Heure pire', 'Carburant (L)', 'Source carburant', 'Contrôle calculateur (L)', 'Carburant ralenti (L)', 'Source carburant ralenti',
    'Lat arrêt', 'Lon arrêt', 'Code chauffeur', 'Chauffeur', 'Contrat'],
  IDL: ['Clé', 'Clé plaque', 'Plaque', 'Trajet ID', 'Date', 'Début', 'Fin', 'Durée arrêt (min)', 'Moteur tournant (min)',
    'Vérification moteur', 'Litres', 'Source litres', 'Lat', 'Lon', 'Code chauffeur', 'Chauffeur', 'Contrat'],
  SRC: ['Clé', 'Clé plaque', 'Plaque', 'Diagnostic ID', 'Nom', 'Unité', 'Lectures', 'Rôle', 'Analysé le'],
  EVT: ['ID', 'Clé plaque', 'Plaque', 'Date', 'Début', 'Fin', 'Durée (s)', 'Distance (km)', 'Règle ID',
    'Règle', 'Code chauffeur', 'Chauffeur', 'Contrat'],
  FUEL: ['Clé', 'Clé plaque', 'Plaque', 'Date', 'Type', 'Arrêt début', 'Arrêt fin', 'Durée arrêt (min)', 'Moteur',
    'Niveau avant (%)', 'Niveau après (%)', 'Écart (%)', 'Litres (jauge)', 'Litres Geotab', 'Source', 'Lat', 'Lon',
    'Code chauffeur', 'Chauffeur', 'Contrat', 'Chauffeur suivant', 'Statut'],
  LVL: ['Clé', 'Clé plaque', 'Horodatage', 'Niveau (%)'],
  SYNC: ['Clé', 'Clé plaque', 'Date', 'Synchronisé le', 'Trajets', 'Événements', 'Lectures jauge',
    'Compteur carburant', 'Limites vitesse'],
  JRN: ['Clé', 'Date', 'Plaque', 'Modèle', 'Code chauffeur', 'Chauffeur', 'Contrat', 'Début contrat', 'Fin contrat',
    'Durée contrat (h)', 'Trajets', 'Km', 'Conduite (h)', 'Ralenti (h)', 'Source ralenti', 'Ralenti prolongé (h)', 'Nb ralentis prolongés',
    'Carburant (L)', 'Km mesurés carburant', 'L/100 km', 'Source carburant', 'Carburant ralenti (L)', 'Source carburant ralenti',
    'Coût carburant (MAD)', 'Coût ralenti (MAD)', 'Vmax (km/h)', 'Limite à Vmax', 'Pire dépassement (km/h)',
    'Événements', 'Points danger', 'Score /100 km', 'Pleins', 'Litres pleins (jauge)', 'Siphonages suspects',
    'Litres suspects', 'Km hors contrat'],
  ALERT: ['Clé', 'Date', 'Heure', 'Plaque', 'Code chauffeur', 'Chauffeur', 'Type', 'Gravité', 'Détail',
    'Valeur', 'Statut', 'Commentaire'],
  RULE: ['Règle ID', 'Règle', 'Poids danger', 'Catégorie', 'Événements (total)', 'Note'],
  LOG: ['Horodatage', 'Action', 'Détail', 'Durée (s)']
};
const PARAM_DEFS = [
  ['geoDb', 'Base Geotab', 'clicar', 'Nom de la base (my.geotab.com/clicar)'],
  ['geoServer', 'Serveur Geotab', 'my.geotab.com', 'Laisser my.geotab.com, le serveur réel est détecté à la connexion'],
  ['geoUser', 'Utilisateur Geotab', '', 'Rempli via le menu "Configurer accès Geotab"'],
  ['parcId', 'ID Sheet Parc', PARC_ID_DEFAULT, 'Sheet ETAT PARC'],
  ['parcTab', 'Onglet Parc', 'Parc Automobile', ''],
  ['parcCol', 'Colonne plaque', 'G', 'Immatriculation définitive'],
  ['priceDiesel', 'Prix gasoil (MAD/L)', '', 'Prix réellement payé. Vide = coûts non calculés'],
  ['priceGas', 'Prix essence (MAD/L)', '', 'Prix réellement payé. Vide = coûts non calculés'],
  ['siphonPct', 'Siphonage : chute jauge mini (%)', 7, 'Chute entre arrêt moteur et redémarrage, sans trajet'],
  ['siphonL', 'Siphonage : chute mini (L)', 5, ''],
  ['pleinPct', 'Plein : hausse jauge mini (%)', 10, ''],
  ['stopMin', 'Arrêt mini contrôlé (min)', 10, 'Arrêts plus courts ignorés pour le siphonage'],
  ['idleLongMin', 'Ralenti prolongé : durée mini (min)', 10, 'Arrêt continu moteur allumé compté comme prolongé (en dessous : feux, bouchons)'],
  ['idleAlertMin', 'Ralenti prolongé : alerte (min)', 20, 'Alerte sur un seul arrêt moteur allumé'],
  ['idleDayMin', 'Ralenti prolongé par journée : alerte (min)', 60, 'Cumul sur un contrat (journée de travail)'],
  ['minFuelKm', 'Km mesurés mini pour afficher L/100', 30, 'En dessous, la conso n\'est pas affichée'],
  ['rpmMin', 'Régime moteur tournant (tr/min)', 300, 'Au-dessus : moteur thermique en marche'],
  ['fullPct', 'Plein complet : jauge après (%)', 90, 'Pour la conso plein à plein'],
  ['osmOn', 'Limites OpenStreetMap si Geotab n\'en fournit pas', 'OUI', 'OUI / NON'],
  ['vmaxAlert', 'Vitesse max : alerte (km/h)', 130, ''],
  ['overAlert', 'Dépassement limite : alerte (km/h)', 30, 'Vitesse moins limite de la route'],
  ['scoreY', 'Score danger : seuil Modéré', 29, 'Calé sur la flotte réelle 01-05/10/2026 (quartile), règles de conduite uniquement'],
  ['scoreO', 'Score danger : seuil Élevé', 36, 'Calé sur la flotte réelle 01-05/10/2026 (quartile), règles de conduite uniquement'],
  ['scoreR', 'Score danger : seuil Dangereux', 74, 'Calé sur la flotte réelle 01-05/10/2026 (quartile), règles de conduite uniquement'],
  ['kmMin', 'Km mini pour le score', 20, 'Évite les scores gonflés sur très peu de km'],
  ['overConsPct', 'Surconsommation : alerte (% au-dessus réf.)', 30, 'Actif seulement si la conso de référence est saisie dans VEHICULES'],
  ['ctrTolMin', 'Tolérance début/fin contrat (min)', 20, 'Trajet rattaché au contrat le plus proche'],
  ['emails', 'Emails rapport quotidien', '', 'Séparés par des virgules (rapport à 7h)'],
  ['lvlDays', 'Historique jauge conservé (jours)', 30, ''],
  ['catchupDays', 'Rattrapage auto (jours)', 7, 'Journées passées finalisées automatiquement si elles manquent'],
  ['liveMin', 'Temps réel : collecte toutes les (min)', 5, '1, 5, 10, 15 ou 30. Trajets terminés, positions et état des véhicules'],
  ['autoRenderMin', 'Tableaux mis à jour automatiquement toutes les (min)', 15, 'Tableau de bord, Du jour, En direct. Les autres onglets : toutes les 3 h et sur ACTUALISER'],
  ['retentionDays', 'Données détaillées conservées (jours)', 62, 'Au-delà, archivées chaque mois dans le classeur « Flotte Geotab - Archive » (Drive)'],
  ['shiftDay', 'Équipe de jour : début (heure)', 7, 'Bilan de fin de shift : l\'équipe de jour finit quand commence l\'équipe de nuit'],
  ['shiftNight', 'Équipe de nuit : début (heure)', 19, 'L\'équipe de nuit finit le lendemain à l\'heure de début de l\'équipe de jour']
];
const MODEL_DEFAULTS = { STARIA: { tank: 75 }, SONATA: { tank: 50 }, _: { tank: '' } };
const HORS_PERIODE = 'Hors période des contrats';
const RULE_W = { 'Collision': 10, 'Vitesse': 3, 'Ceinture': 3, 'Freinage': 2, 'Accélération': 2, 'Virage': 1.5 };
const LEASE_MS = 35 * 60 * 1000;
const CORE_DIAGS = {
  ign: 'DiagnosticIgnitionId', rpm: 'DiagnosticEngineSpeedId', spd: 'DiagnosticEngineRoadSpeedId',
  fuel: 'DiagnosticDeviceTotalFuelId', ecu: 'DiagnosticTotalFuelUsedId', idleFuel: 'DiagnosticDeviceTotalIdleFuelId',
  lvlL: 'DiagnosticFuelUnitsId', lvlPct: 'DiagnosticFuelLevelId', odo: 'DiagnosticOdometerId'
};
const C_MIN = 60000, C_HOUR = 3600000;
const ATTR_TIME = { TRIP: 'Début', IDL: 'Début', EVT: 'Début', FUEL: 'Arrêt début' };
const LIVE_SETTLE = 5 * MIN;
const LIVE_CTX = HOUR;
const LIVE_EVBACK = 3 * HOUR;
const LIVE_SPAN = 8 * HOUR;
const LIVE_KM_WAIT = HOUR;
const G_ORDER = { 'Critique': 0, 'Haute': 1, 'Moyenne': 2, 'Info': 3 };