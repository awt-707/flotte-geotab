/*******************************************************************************
 * FLOTTE GEOTAB - Suivi véhicules & chauffeurs (Clicar Maroc)
 * -----------------------------------------------------------------------------
 * Installation : Extensions > Apps Script > coller ce fichier (Code.gs) >
 * Enregistrer > recharger le Sheet > menu "Flotte Geotab" > "1. Installer".
 * Le mot de passe Geotab est stocké dans les propriétés du script, jamais
 * dans la feuille.
 *
 * V6 (temps réel) : collecte toutes les 5 min (onglet EN DIRECT + trajets terminés
 * dans LIVE_*), journée finalisée une seule fois le lendemain midi (ajout en bas des
 * DATA_*, jamais de réécriture), journalier et alertes recalculés sur les derniers
 * jours seulement, archivage mensuel au-delà de 62 jours, plaques d'un même châssis
 * regroupées. Mise à jour depuis la V5 : coller ce fichier, puis menu
 * « 1. Installer / réparer » (migration automatique en arrière-plan, suivie dans LOG).
 ******************************************************************************/

// ============================================================================
// 1. CONSTANTES
// ============================================================================
const TZ = 'Africa/Casablanca';
const PARC_ID_DEFAULT = '14HGWlCDPb3aCNZOZVQi2wgHHoZXCOrWBhekbyCPYxys';
const MAX_RUN_MS = 4.6 * 60 * 1000;          // marge sous la limite de 6 min
const ENGINE_V = '5.3';                      // version du moteur de calcul (un jour calculé par une autre version est recalculé)
const SYNC_CHUNK_DAYS = 2;                   // jours consécutifs téléchargés en un seul appel par véhicule (fenêtre ±12 h partagée)
const SYNC_PARALLEL = 4;                     // véhicules téléchargés en parallèle (UrlFetchApp.fetchAll)
const GEO_MAX_RESULTS = 50000;               // plafond Geotab par requête : atteint = données tronquées, le bloc est redécoupé
const HOUR = 3600000, MIN = 60000, DAY = 86400000;

const S = {
  DASH: 'TABLEAU DE BORD', TODAY: 'DU JOUR', RANK: 'CLASSEMENT CHAUFFEURS', DRIVE: 'CLASSEMENT CONDUITE', FUELP: 'CARBURANT PÉRIODE',
  IDLE: 'RALENTI & CARBURANT', ALERT: 'ALERTES', VEH: 'VEHICULES',
  DRV: 'CHAUFFEURS', CTR: 'CONTRATS', RULE: 'REGLES', PARAM: 'PARAMETRES',
  FILL: 'PLEINS', CTRL: 'SOURCES & CONTRÔLE', SRC: 'DATA_SOURCES', PROBE: 'SONDE GEOTAB', TRIP: 'DATA_TRAJETS', EVT: 'DATA_EVENEMENTS', FUEL: 'DATA_CARBURANT', IDL: 'DATA_RALENTI',
  LVL: 'DATA_NIVEAU', JRN: 'DATA_JOURNALIER', SYNC: 'DATA_SYNC', LOG: 'LOG',
  LIVE: 'EN DIRECT', FICHE: 'FICHE VÉHICULE', PLATES: 'PLAQUES',
  // Couche temps réel : trajets terminés du jour, calculés toutes les 5 min (provisoires jusqu'à la finalisation du jour, le lendemain midi)
  LTRIP: 'LIVE_TRAJETS', LEVT: 'LIVE_EVENEMENTS', LFUEL: 'LIVE_CARBURANT', LIDL: 'LIVE_RALENTI', LLVL: 'LIVE_NIVEAU'
};
const SCHEMA_V = '6';                         // structure des données (v6 : temps réel + ajout seul + archivage)
const LIVE_OF = { TRIP: 'LTRIP', EVT: 'LEVT', FUEL: 'LFUEL', IDL: 'LIDL', LVL: 'LLVL' };
const VEH_PREFIX = 'VHL ';
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
H.PLATES = ['Ancienne plaque (WW / W18)', 'Plaque définitive', 'Date du changement', 'Véhicule', 'Statut', 'Note'];
H.LTRIP = H.TRIP; H.LEVT = H.EVT; H.LFUEL = H.FUEL; H.LIDL = H.IDL; H.LLVL = H.LVL;

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

/** Réservoirs constructeur (à vérifier sur la fiche technique). Sert uniquement à convertir la jauge % en litres. */
const MODEL_DEFAULTS = { STARIA: { tank: 75 }, SONATA: { tank: 50 }, _: { tank: '' } };

const LEVELS = [
  { name: 'Faible', bg: '#C6EFCE', fg: '#006100' },
  { name: 'Modéré', bg: '#FFEB9C', fg: '#9C5700' },
  { name: 'Élevé', bg: '#F8CBAD', fg: '#843C0C' },
  { name: 'Dangereux', bg: '#FFC7CE', fg: '#9C0006' }
];
const GRAV = { 'Critique': ['#C00000', '#FFFFFF'], 'Haute': ['#F8CBAD', '#843C0C'],
  'Moyenne': ['#FFEB9C', '#9C5700'], 'Info': ['#DDEBF7', '#1F3864'] };

const C_HEAD = '#1F3864', C_SEC = '#2E75B6', C_GREY = '#F2F2F2';

const BTN = {
  INJECT: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAAoCAMAAACMwkUuAAAAYFBMVEXZ3eWVobZ4h6FhcpG5wc6ut8cJCQkAGUweOGUAAH9CV3w7UXhVVVUeOGQAAP8ABz4eN2MiOmb8/P0OKViLmK8XMV4wR3BUZ4gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABecmPQAAAAGHRSTlP///////8A/6cC//8DSgH//v7///////918d6iAAADrUlEQVR42u1Z6ZLbIAzGJj7iZFsJcbz/m1YSYOPsJk36ozPxRDNLGHTgTwfCazOOv87j1wxvS/PXeP41jmY8n8cZ8X2BIM6CgYFc5zeGoVDmKwO5vj0ORXI14/vjECSj+ToADkbyZeZjAJkNHIQ+QD5A/isQlFaPOuoc14WymOfrSjNdxfbmWrVitTW+N7JpQcuFb4b/CoSIAHkIKHMey6AUZMMgMwhUCSpX9YpqfaAsLFPIInkCKouNkVZV7WDLzdrhFSDW98iDtwGi94kuPARZELK8UbC97xIkX0nkhLIe/6YVRxHWp49iNBICW+wBAxtojOBOtedNoeVS7IWLTwNBMM7FwANzL875KfFAsirEs3jS2eBdJUx1EopYVxxbhWWnLG96CCKeAg3OUWNkU2U1kcSWmzK7J3wayMAmguxviYF0lERdVsUziaJg9N4YdlenU/arc6ccERHrWOICktaAVTiSygrLikV5zI7xNUYaVerloRNtXDZkOj/w4zwP5FSBGHGML0B4dWIK8kAD5yskHpCBTpy6LGJ/TxOpMk1eHC5ANmFk/IyGFv7RiLh+6nSlGgmtqnHDyQ20bcHqnn+WBV4GYozrd0CcRCTSSTKPo18yQDKBSkQsiHKM7NuoEQlVGESEvYmST1HmjIf/pHaKkUY1WIbTZyOVyw7wdqEfA/IYyCk5s+yACFmuAt0e6zNQBiJ0qmImlXNrFSZbRNnlC4unwVm/ASEFUlUl6YiTSQqichetEWPD6xFh53HK3o/IHsgaEd1PS+RRRNLizPAjkAtIZUlhcW5XLhuA1A9SWi9HxIQlH1O7GiFJ+y5o2kMLRGpkyqmVShxyjRThmxqxgugWSFGV6GVa6haAKdLEVeXiT0Xy4NSSQfe6f2oJELOLiI9Zry/H5INTy9KyAslGYFWdyl75sDcZiDGDaGcPvdRHjHpjjUg55QfaWoM6c2hqxEUy6jNTPHe/j1g9/lzcjMCqmspZKCEKmQu1yzxfI2tnl97LzTZN2b+ls2sVW+m76kxt9dqqlaIqa8/OO7bC2ptrZ5ekkfawGoFNtRc2W01isHIxSWePAV+/a+UbT6w9qhC21yfQBcDdXUuKfL1u3btryYPujcCqmqV0mpXUVKjrL99+dao9tif8fvvFVRb2t9/tevv49rsK7WzdbHO7xb++j/D57ftLwLd8H7lBcjeeb/aGeD+en1fdD5APkPcBcph/mR7mn9iH+axwnA89R/n0dpyPoQf5PP0H8oLtlmLtuCAAAAAASUVORK5CYII=',
  SYNC: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAAoCAMAAACMwkUuAAAAYFBMVEWdyLlbo4rQ5N0ACQk3j3GFuqgAcUoAXTMAfwAAVVUAcEmozsEAqlUA/wAAcEr5+/sAbEUAZTyz1MktiGlDlXlsrJbZ6uRzsZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACFi+d4AAAAGHRSTlP///8A//+n/wIDSv8DAf7//v////////+npvV4AAAC9klEQVR42u2Z2bqjIAyAAbcu5yQBXN7/TScJWJejnvnaualTLtRihPxkIVVTFN+X4lYTvGmj+lZcvovCFJdLUcNbt1oYGORaA9H7YrDu9ZVBrl9vbg+1ydfVFCfgEO8yN6D35yC4mfocILUhOEUjAydpH5APyAfkNRAiKV/SMZ2nS5id00lvTjJzAVh3EM0FV507kz4NMo6UcvV6x6F8azkJLc5rAfL0OK7m2dKV1ro8B0JQOURnIgXsI4/k0IFBtHyJ2Hmg0vSIgX8bvgMUpbdEaa5T5Wxw2N/bia4LfC90/CgmOe6bpHrMbfA8GcoulwWdPd65j0FMHrVhDYNoi9azIljK6J2nLk8LQprmHJo2dwpoNV5n+4h22qJvR5C51ASShinpQcxTPwsiy873o+EVH3igKEtEAmJk2buGD70FsCaBkFhENRjIIt6J+NJFaFm9mNyTHzYRog1RR0idM6lExSfwBvtsdRlPV/I1EPKyEsRL2auyAXVGUZkt1PoU4GoRaDOIbUChjSw9eKaqdJBkWO8bfmoCWUh5AaHkuxU6mkDMC65lxfZiENWB1VaVw8B8sloMN0qGhU8EiQR2i6ACuiCUx2Pnt9ZW5ehaZiWVQBQLojJl1+pfiRGyd3Hqiofwg3iUqhzY0+0hSHZp2gRR2ao5BtFpOParB8gYZ8+l34ZVl3lIPdkmEOc7dIeuFVhjSXPbrtVWWezAtSI+kpq6liTLQ5Mcx4jp4hykyxZJyWfYD3bNA2Yv2EU1OwNZSCUQoRoN244gkV4I9tH8cxCnqydOspd+OzVGSfvpd8rSsJTKrtWLZwGLhzGYfgmSY9eyst+5CuYgRiwiSyupsd3eEHmLiY7z78aGOPCT/WxDRFhKKYjPfiw/IHlZb+ILMeJpWRwsLw5KFAKCnRIFjksUWlUm/6REgalyW9Rw8/7tovFnVfl3ReN4NXv4RxX6+T/yAfmA/N8gp3lBd5pXpqd5iX2azwrn+dBzlk9v5/kYepLP038Ay/i1p0RVeMsAAAAASUVORK5CYII=',
  FUEL: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAAoCAYAAAC7HLUcAAAHuElEQVR4nO2de1BU1x3HP/tggZX3w8WIBh8Y0YrxkYrQRKvmYR2NaVMyCRiTOCbQzLTaSZxOrLUZ204nNjFRp5hxnMYHIU1bkzbaljZxnBjA9zMBDCooAvJaYHku+7j9Y911Ze+9LhAw0z2f/+49v3t+3/Pb891z7t3dWQ0KFD0TLSm1CQT/b2S836KRO+9zUhhDEMj0NYrW+0CYQxDo9PWAVqlBIAhUvL2g7XtCIBDc8oT2ToECQSCjEauHQKCMWEEEAhWEQQQCFYRBBAIVhEEEAhWEQQQCFYRBBAIVhEECFK0hlNnbvmTCC2/dbSnfaoRBApTEZWvovnGZK7vX3W0p32ruygeFEffNZfTSnxGe/AC60DDs7S10VpdS/ubTOG3Wm8o0zHr7LMFxYwA4sy6N7pqvPX3M3v4VhuhRrgPJia29GUv5Uar2vYa1uUYmRsLe2YrlYglX3ltHr7n2tpiKvBwav/gQgAmrt2Kan01j0V+o+ONLfufzR7d3Xz31lZx5dQ6Sw07Y+BmkbvoMR5eFY6uTmLOzCp0xQrGGp9bcj7Xxmmy/bmyWRtq/Ps7VD35Nd91l2Rg3516bR+fVC/2qq3fNAGIfWMqoxbmMuHcaGp2enrpL1B/eS91/doIk+eR32qzYLE20Vxyn9sA2OirPKo6lr87hYthXkPjvZfKdDZ8QNmEmFXk5HH9xAqWbn6K3tQ6NVueJi5ic7plkruueku2vIi+Hoy8k0lZaROx3lzL++T/IxpSsNNF8/B/EzPoBE1dvHbD+O+XzVzdAiGkcIx96Rrbt2OokirNiOPrcrUlyYeMjFGfFUJwV42OOvhpLnh1JXeFOYmYvIeXVD9EGBfvEuPsqzorxmXT+1NWbexbnct+a3ejDornwq0WcXjsTa3MN4579vWy9K/JyOPmTyVwt2EhU6gKmvV5IzMzHZOPUdA41w2oQXWg441e+ARotVfm/pOXsf3H0dNBZdY5LO17GYe3yxMZnZALQWXXedZz+JGhkf9OCs7eHttLPAQhJmCgbIznstH3lihmRlDqocajl649uJInEJ15BozcMSo9s1w47Nz7d5dJoGodxzJR+9+FPXQH0YdGMzdwAQNW+9XTVXKS3pY7Lu9YgOR2MnJdF+MRZPtfZu9poKtnPtT9vQqMLYvyqLUNSi8EwrAaJTMnwbBvMp/6lGKcNCiZ2zjIAqvI3YO9sJThuDBGT0+XjDSFETnkIgJYzhbIxGq2OyCkPArcm70BRytdf3U3HPiY4NpGEBSsHpWeo8Keu4Noyaw0hAFjKijzne1tu0F13CYDIaQsUr3fPBUOUibBx0wet+5tkWA0SFBEHuPaeju52xbjoGY+gN0ZiszTSVlbkeXHc787eJOfuIO1PtcSlLaf1/CGuFmyUjZm7txHTwueQ7L3UHNg24DGo5euPboD6Q7uxNlUz+vGfow0KGbAmOTQ6PQmLVgHQU19JV3WpzzjS882k55tJe6/O53p/6uomKDwGcK04nnvIm9g7zDdjYhWvt1kavfqK65fOoWZYDWKzNLmSBgWjCw1XjHNPKPPpQpCcNJ84CEDcnMdl99Kn186kt6WOqNQFjFqc69NfRV4OxdlxlG9ZgUZvYPLaPejDXC+q++ZRFskp25dSvv7oBpDsvVz/aDOGKBMJD69S1tFPknN3MHdPA6MefRHzqX9StjnTZ+J67+2973P8GWdfbO0uE2gNIT7jdNfZbRQ5giLib/XlZRZ/dA41w2qQtrIiz8ohd0MGoB8RRfT9DwNgmp9Ner6ZyWv3AKAzRhA941Gfa3oaqqj55B0Axix/Ba0h1LdjyYn55EEkhx1daDgjxk4F8DyZ0RsjvTRE3tbmT76B6AZoOPIBPTcuE5f2hGz7QHBPqhO5kyh/K9vzBKu/+FVXwHKxBGdvDwARKRme84boBEJHue5dWs9/ppgnZvYSAHpb6+moPDcgrUPFsBrE0d1O5e5fgCSRlPUboqYvRBcyAuPYqUx8aTu6YCOxacvR6A20lX1x29ML9xIf/6D8U6GGzwtwWLvQGSOIT/+Rb4BGQ8zsJWh0epw2K121FwFoPvYxAHHpTxIUHosxMYWoqfOQHHbMJw4ojqVvvoHqlhx2qve/oXwjf5e5Y10Be0cL1/76OwCSsn9L6OhJGKITmLDqbTRaHQ1HCmi/dMrnOp0xgri5P2Rs5nokh40ru9YiOWxDOp7+oh/uhA1HCrA2VXPP0p8y6eWd6ELCsHe10XXtSySng/iMHwPQeu72d5yWs59y79OvEz190a3tkReO7naaSvZjmp+NaeHz1B/e52lLzt1Bcu4OHF0W2itOcP2jzdhaGwCo/fe7SBKYvr+Cme+cQ7JZ6awu5frf37ztufyd8jltPX7plttqNBb/jdHL1mBMTPGviN8A7pq4Kd+yAvPJgz5xanX1pvbgdtfr+lguqZsOodHq6Llxmcq966krfNc3f07ezc9BGmm7cJiaA1vpuHJmwDqHCvGLQoFABfFVE4FABWEQgUAFYRCBQAVhEIFABWEQgUAFYRCBQAVhEIFABWEQgUAFYRCBQAWt0j/rCASBTsb7LRqxgggEKmhB+f/ZBIJAxe0Jbd8TAkGg4+0FrVKDQBCI9PWAoiHE1+AFgYTS4vA/GyGb9FsCbLwAAAAASUVORK5CYII=',
  ALL: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAAoCAMAAACMwkUuAAAASFBMVEXJqtHp3OyYW6e5j8Oxg70AAAB4KIyBK5Z/AH9mC3x5Jo0/AH8AAP9VAKpVVaqAKZaqVar/AP93J4v8+vxvGoR+MpGXWaaCOJQxONohAAAAGHRSTlP//////wCs/gL/SgQBAwONAwH+///////ORvfoAAACiElEQVR42u2ZiY7jIAyGjZN0ks7NEd7/Tdc25up0dlbbarVFQWpKyY/jD2xADSzL57qc3+3Dlvfzsn4uCyzr+nyyT48L8mRPz+u6wMv6enpgDEE5va4v8Pbx6BxM8vEGy+NzMMkCZztEOcMIE8JTAnaQcoAcIAfIATIQSMiF6p5+ypWb87UVlC5a86zwrSbUjo2ydEgV39xXy+nb3wBinJbJWwTjDCC17s6ht9E46ATiBVJ9T7ST4Q4Bs8RYoI/1kzPYKJM1atDKRDYN7ORZ6oZ8g5rMfBeQTc26WR49E4i7AiINwPWot/ALCFnCqvTJms0VKPYyyJYtoP/70IpWHhstGTN72A2PYgXxsQhSYZkzHA7UDBgRtDPYGDqQrLwA4XmOcQdkEBMlOunGlGzckOwUCDwS/HSKA46HiUcogxRBUZsUIeyn95pTKm1BqrIHCRyw1qs6SlqybqMZBH8LSAkEGWdxae9AVJAjCzy7IsTluVdAivICxE4chJKKbY6YmRzY/xlIyteZL9+BhNShUV6AyKIiYdQn+08p8ocgbWhJzErwfAGBkvoSWrYPLV9mJDbKS5CNxkglNbSA1jKD9wCpyY6ckAYDpDFqQfJKxf6WZPe2TafJkg3TKFMqR0rqlCMwY2xBgubI7u6TIxK7svx6cUjd7UCYlhepmWcvuzpXkLokb41SA8eFBKK/amjp4qIxccuqpVOqG6LYQtnrYi/QZBZ/yW/dELE0ZBssr8oJGxBM+y7voxVEd0o0v19/fzxr5RNEOjr47vTRHzFKLZ9piujKsaUqy1GknIRSt/aIkrTxODQeIAfIAXKA/H8gw/xlOsyf2MO8VhjmRc8wr96GeRk6yuvpX3QuHh0CSrldAAAAAElFTkSuQmCC',
  REFRESH: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAAoCAMAAACMwkUuAAAAYFBMVEXWm17pyqr26NvNhToAAADHdiF/fwDEYwC9XwD/VQDCYQC2SgB/PwCqVQD/AAD//wDfsIC+YQD9+/nCZgi8WwDqy6v159jiuY0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoS1hXAAAAGHRSTlP/////AP8CqaMDSv8EAwEB//7//v/////yBTgCAAACZUlEQVR42u2Z3basIAiA0az2zOy/hOz93/QAkTnNvurCdcaVF2moxSegrIIQfoZwHyec3rLgNN7D8BMChGH4HPFNMRQFx89hCPA9fI1vjKEo49fwDbfbu3MIye0G4ePtOZjkI8AdWwDBO7RgEDEJTI0UwDY4sB2LXCAXyH8GQpT3cGnLxYq0ihF0qK2BRT+torXGuiCIdpAiETf1YmVau/KAQ20NnSD6l9OkorogPkZHKBzdnLgNEK14nGNifX6j7wlJ5B0rRyqdrEH4y7PS3BHfagHq1ulQEQTXl/bsB2QA6QVkkQFIjkULIx9Alk39yVnrsT0BCOuBLDF5eaMQJUCEhb2iZ8uwg1ABQizzzHa0CProEDsHtN6Km3XCwDRzPRBiPWCJnnRlYQtxlLXfVDYQiEkVxBeQRYLbLJVBHmguWwVE/Qk79X2ny61bjaz+7kTmWolFThb54FriR54NMm0x0ovIgZOn1gNh1VB1fALBVxAwd+npAEIwe42eJ5DzIXIKRJbe4lpiGezkKEAia6ogLgew6U9bsDx4/9WBpWvN4GPqa1kk71S2Z1qwbyDaDdilmERiyEUsaGOG/g8QeHQ1g52dapZXc0UZCneLcMe+ozLlBOL4ZhwJGdbcZvEDNrkO1ttTQQLnDhEQV9Ijj51dD8R1LxMQpN6pSNyJTWEd8wayBrvMSgvSLtfHUu/PmeSURfakA3OKUnZkUZmePGcw9HeKYqlLtXOEinpLGgt5FpV5Yk4O9bJ24iFpfEourzT+ArlArs9BTX8OauaTaTMfsZv5rdDMj55mfr018zO0ld/T/wBJfhAfZZ6ODgAAAABJRU5ErkJggg=='
};

// ============================================================================
// 2. UTILITAIRES
// ============================================================================
function ss_() { return SpreadsheetApp.getActive(); }
function sh_(name) { return ss_().getSheetByName(name); }
function idx_(headers) { const o = {}; headers.forEach((h, i) => { o[String(h).trim()] = i; }); return o; }
function num_(v, d) { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return isNaN(n) ? (d === undefined ? 0 : d) : n; }
function r1_(x) { return Math.round(x * 10) / 10; }
function r2_(x) { return Math.round(x * 100) / 100; }
function deacc_(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function normTxt_(s) { return deacc_(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

/** Plaque normalisée : chiffres puis lettres. WW968193 et 968193WW donnent 968193WW. */
function normPlate_(s) {
  const t = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return t.replace(/[^0-9]/g, '') + t.replace(/[^A-Z]/g, '');
}

function tzOffsetMin_(date) {
  const z = Utilities.formatDate(date, TZ, 'Z');
  const sign = z[0] === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10));
}
function localToDate_(y, mo, d, h, mi) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0));
  return new Date(guess.getTime() - tzOffsetMin_(guess) * MIN);
}
function localDay_(d) { return Utilities.formatDate(new Date(d), TZ, 'yyyy-MM-dd'); }
function localHM_(d) { return Utilities.formatDate(new Date(d), TZ, 'HH:mm'); }
function fmtDay_(day) { const p = day.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
function fmtDT_(d) { return d ? Utilities.formatDate(new Date(d), TZ, 'dd/MM HH:mm') : ''; }
function dayBounds_(day) {
  const p = day.split('-').map(Number);
  const start = localToDate_(p[0], p[1], p[2], 0, 0);
  const n = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
  const end = localToDate_(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0);
  return { start, end };
}
function dayToDate_(day) { return new Date(dayBounds_(day).start.getTime() + 12 * HOUR); }
function addDays_(day, n) {
  const p = day.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}
function mondayOf_(day) {
  const p = day.split('-').map(Number);
  const wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  return addDays_(day, -((wd + 6) % 7));
}
function toDate_(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (v === '' || v == null) return null;
  return parseLocalDT_(v);
}
function toDayStr_(v) {
  if (v instanceof Date) return isNaN(v) ? '' : localDay_(v);
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2); }
  return '';
}
/** "05/10/2026 à 13h30", "05/10/2026 13:30", "2026-10-05 13:30", "05/10/2026" */
function parseLocalDT_(v) {
  if (v instanceof Date) return v;
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\D+?(\d{1,2})\s*[hH:]\s*(\d{2})?)?/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return localToDate_(y, +m[2], +m[1], +(m[4] || 0), +(m[5] || 0)); }
  m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return localToDate_(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
/** Durées Geotab : "02:03:04.123", "1.02:03:04" -> secondes */
function parseDur_(s) {
  if (s == null || s === '') return 0;
  if (typeof s === 'number') return s;
  const m = String(s).match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + parseFloat(m[4]);
}
function median_(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function clean_(rows) { return rows.map(r => r.map(v => (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) ? '' : v)); }

// ---------- Feuilles ----------
function ensureSheet_(name, headers, color) {
  let s = sh_(name);
  if (!s) { s = ss_().insertSheet(name); if (color) s.setTabColor(color); }
  if (headers) {
    if (s.getMaxColumns() < headers.length) s.insertColumnsAfter(s.getMaxColumns(), headers.length - s.getMaxColumns());
    const lc = s.getLastColumn();
    const cur = lc ? s.getRange(1, 1, 1, lc).getValues()[0].map(String) : [];
    while (cur.length && cur[cur.length - 1] === '') cur.pop();
    if (cur.join('|') !== headers.join('|')) {
      const lr = s.getLastRow();
      if (lr > 1 && cur.length) {
        if (DATA_SHEETS.indexOf(keyOfSheet_(name)) >= 0) {
          // Données Geotab : structure changée, on vide (re-synchronisation nécessaire)
          s.getRange(1, 1, lr, Math.max(lc, headers.length)).clearContent();
          PropertiesService.getScriptProperties().setProperty('NEED_RESYNC', '1');
        } else {
          // Onglets de configuration : migration colonne par colonne selon les en-têtes
          const old = s.getRange(2, 1, lr - 1, lc).getValues(), oi = idx_(cur);
          const rows = old.map(r => headers.map(h => oi[h] !== undefined ? r[oi[h]] : ''));
          // V1 -> V2 : la conso de référence avait une valeur par défaut, elle doit venir de l'utilisateur
          if (name === S.VEH && oi['Ralenti (L/h)'] !== undefined) { const j = headers.indexOf('Conso réf (L/100)'); rows.forEach(r => { r[j] = ''; }); }
          s.getRange(1, 1, lr, Math.max(lc, headers.length)).clearContent();
          s.getRange(2, 1, rows.length, headers.length).setValues(clean_(rows));
        }
      } else if (lc > headers.length) s.getRange(1, 1, 1, lc).clearContent();
      s.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    s.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground(C_HEAD).setFontColor('#FFFFFF').setWrap(true);
    s.setFrozenRows(1);
  }
  return s;
}
function readTable_(name) {
  const s = sh_(name);
  if (!s) return { s: null, headers: H[keyOfSheet_(name)] || [], rows: [], I: idx_(H[keyOfSheet_(name)] || []) };
  const lr = s.getLastRow(), lc = s.getLastColumn();
  if (lr < 1 || lc < 1) return { s, headers: [], rows: [], I: {} };
  const vals = getChunked_(s, 1, lr, lc);
  const headers = vals[0].map(String);
  const rows = vals.slice(1).filter(r => r.some(v => v !== ''));
  return { s, headers, rows, I: idx_(headers) };
}
/** Lecture / écriture des grands tableaux par paquets de lignes (évite l'« expiration du délai » du service Sheets) */
const IO_CHUNK = 8000;
function getChunked_(s, row, n, nc) {
  if (n <= IO_CHUNK) return s.getRange(row, 1, n, nc).getValues();
  let out = [];
  for (let i = 0; i < n; i += IO_CHUNK) out = out.concat(s.getRange(row + i, 1, Math.min(IO_CHUNK, n - i), nc).getValues());
  return out;
}
function setChunked_(s, row, values, nc) {
  for (let i = 0; i < values.length; i += IO_CHUNK) s.getRange(row + i, 1, Math.min(IO_CHUNK, values.length - i), nc).setValues(values.slice(i, i + IO_CHUNK));
}
function keyOfSheet_(name) { for (const k in S) if (S[k] === name) return k; return ''; }
/** Formats date/heure explicites sur les lignes écrites (les lignes ajoutées par Google n'héritent pas toujours du format) */
const DT_COLS = ['Début', 'Fin', 'Horodatage', 'Arrêt début', 'Arrêt fin', 'Synchronisé le', 'Dernière synchro', 'Analysé le', 'Importé le',
  'Mis à jour le', 'Début contrat', 'Fin contrat'];
function fmtDates_(s, headers, start, n) {
  if (!n) return;
  headers.forEach((h, i) => {
    const f = h === 'Date' ? 'dd/MM/yyyy' : DT_COLS.indexOf(h) >= 0 ? (s.getName() === S.LOG ? 'dd/MM/yyyy HH:mm:ss' : 'dd/MM/yyyy HH:mm') : null;
    if (f) s.getRange(start, i + 1, n, 1).setNumberFormat(f);
  });
}
function writeTable_(name, headers, rows) {
  idxClear_(name);
  const s = ensureSheet_(name, headers);
  const lr = s.getLastRow();
  if (lr > 1) s.getRange(2, 1, lr - 1, Math.max(s.getLastColumn(), headers.length)).clearContent();
  if (rows.length) {
    if (s.getMaxRows() < rows.length + 1) s.insertRowsAfter(s.getMaxRows(), rows.length + 1 - s.getMaxRows());
    textCols_(s, headers, 2, rows.length);
    fmtDates_(s, headers, 2, rows.length);
    setChunked_(s, 2, clean_(rows.map(r => fit_(r, headers.length))), headers.length);
  }
}
function rowOf_(headers, obj) { return headers.map(h => obj[h] === undefined || obj[h] === null ? '' : obj[h]); }
function fit_(r, n) { const o = r.slice(0, n); while (o.length < n) o.push(''); return o; }
const TEXT_COLS = ['Téléphone', 'Heure', 'Heure pire'];
const DATA_SHEETS = ['TRIP', 'EVT', 'FUEL', 'IDL', 'LVL', 'JRN', 'SYNC', 'LTRIP', 'LEVT', 'LFUEL', 'LIDL', 'LLVL'];
function textCols_(s, headers, row, n) {
  headers.forEach((h, i) => { if (TEXT_COLS.indexOf(h) >= 0) s.getRange(row, i + 1, n, 1).setNumberFormat('@'); });
}
/** Insère ou met à jour des lignes selon la clé en colonne A. */
function upsert_(name, headers, newRows) {
  if (!newRows.length) return { added: 0, updated: 0 };
  const s = ensureSheet_(name, headers);
  const lr = s.getLastRow();
  const keys = lr > 1 ? s.getRange(2, 1, lr - 1, 1).getValues().map(r => String(r[0])) : [];
  const pos = {}; keys.forEach((k, i) => { if (k) pos[k] = i; });
  const dedup = {}; newRows.forEach(r => { dedup[String(r[0])] = r; });
  const upd = [], add = [];
  Object.keys(dedup).forEach(k => { (pos[k] !== undefined ? upd : add).push(dedup[k]); });
  if (upd.length) idxClear_(name);
  if (upd.length > 40) {
    const all = lr > 1 ? s.getRange(2, 1, lr - 1, headers.length).getValues() : [];
    upd.forEach(r => { all[pos[String(r[0])]] = r; });
    textCols_(s, headers, 2, all.length);
    fmtDates_(s, headers, 2, all.length);
    s.getRange(2, 1, all.length, headers.length).setValues(clean_(all.map(r => fit_(r, headers.length))));
  } else {
    upd.forEach(r => { s.getRange(pos[String(r[0])] + 2, 1, 1, headers.length).setValues(clean_([fit_(r, headers.length)])); });
  }
  if (add.length) {
    const start = s.getLastRow() + 1;
    if (s.getMaxRows() < start + add.length) s.insertRowsAfter(s.getMaxRows(), start + add.length - s.getMaxRows());
    textCols_(s, headers, start, add.length);
    fmtDates_(s, headers, start, add.length);
    s.getRange(start, 1, add.length, headers.length).setValues(clean_(add.map(r => fit_(r, headers.length))));
  }
  return { added: add.length, updated: upd.length };
}
// ---------- Lecture partielle des grands tableaux (v6) ----------
// Les tableaux DATA_* ne reçoivent que des ajouts en fin de tableau, dans l'ordre des journées : les lignes récentes sont
// en bas. On ne lit donc que la fin du tableau, à partir de la première ligne de la date demandée.
const DATE_COL = { TRIP: 'Date', EVT: 'Date', FUEL: 'Date', IDL: 'Date', LVL: 'Horodatage', SYNC: 'Date', JRN: 'Date', ALERT: 'Date' };
let MEMO_ = {};
function memoClear_() { MEMO_ = {}; }
/** Efface l'index des positions par jour d'un tableau (après réécriture ou suppression de lignes) */
function idxClear_(name) { try { PropertiesService.getScriptProperties().deleteProperty('IDX|' + keyOfSheet_(name)); } catch (e) { } }
/** Lignes d'un tableau dont la date est >= fromDay (toutes si fromDay vide). Retourne {s, headers, rows, I, start} (start = n° de ligne de rows[0]). */
function readFrom_(name, fromDay) {
  const k = keyOfSheet_(name), s = sh_(name), headers = H[k] || [];
  const empty = { s, headers, rows: [], I: idx_(headers), start: 2 };
  if (!s) return empty;
  const lr = s.getLastRow(); if (lr < 2) return empty;
  const ci = idx_(headers)[DATE_COL[k] || DATE_COL[k.replace(/^L/, '')] || 'Date'];
  let first = 2;
  if (fromDay && ci !== undefined) {
    // Index mémorisé par jour : n° de la première ligne de date >= fromDay (vérifié sur 2 cellules), ou -m = aucune
    // dans les m premières lignes (seules les lignes ajoutées depuis sont relues). Les tableaux ne reçoivent que des ajouts ;
    // toute réécriture ou suppression efface l'index (idxClear_).
    const props = PropertiesService.getScriptProperties(), ik = 'IDX|' + k;
    let idx = {}; try { idx = JSON.parse(props.getProperty(ik) || '{}'); } catch (e) { idx = {}; }
    const c = idx[fromDay]; let found = 0, scanFrom = 2;
    if (c > 0 && c <= lr) {
      const v = s.getRange(Math.max(2, c - 1), ci + 1, c > 2 ? 2 : 1, 1).getValues();
      if ((c === 2 || !(toDayStr_(v[0][0]) >= fromDay)) && toDayStr_(v[v.length - 1][0]) >= fromDay) found = c;
    } else if (c < 0 && -c <= lr) scanFrom = -c + 1;
    if (!found) {
      const dv = scanFrom <= lr ? s.getRange(scanFrom, ci + 1, lr - scanFrom + 1, 1).getValues() : [];
      let i = 0; while (i < dv.length && !(toDayStr_(dv[i][0]) >= fromDay)) i++;
      const keys = Object.keys(idx).sort(); while (keys.length >= 12) delete idx[keys.shift()];
      idx[fromDay] = i < dv.length ? scanFrom + i : -lr;
      try { props.setProperty(ik, JSON.stringify(idx)); } catch (e) { }
      if (i >= dv.length) return empty;
      found = scanFrom + i;
    }
    first = found;
  }
  const rows = getChunked_(s, first, lr - first + 1, headers.length);
  // lignes plus anciennes égarées après le début (resynchro manuelle d'un vieux jour) : à filtrer avec keep, la position reste exacte
  return { s, headers, rows, I: idx_(headers), start: first, keep: fromDay && ci !== undefined ? r => toDayStr_(r[ci]) >= fromDay : null };
}
/** Données d'analyse (lecture seule) : DATA_* finalisées + LIVE_* du temps réel, à partir de fromDay. Mémorisé pour l'exécution. */
function readData_(name, fromDay) {
  const k = keyOfSheet_(name), mk = k + '|' + (fromDay || '');
  if (MEMO_[mk]) return MEMO_[mk];
  const A = readFrom_(name, fromDay), rows = A.keep ? A.rows.filter(A.keep) : A.rows.filter(r => r.some(v => v !== ''));
  const seen = {}; rows.forEach(r => { seen[String(r[0])] = 1; });
  if (LIVE_OF[k]) {
    const L = readFrom_(S[LIVE_OF[k]], fromDay);
    (L.keep ? L.rows.filter(L.keep) : L.rows).forEach(r => { if (r[0] !== '' && !seen[String(r[0])]) rows.push(r); });
  }
  return (MEMO_[mk] = { s: A.s, headers: A.headers, rows, I: A.I });
}
/**
 * Remplace les lignes d'un tableau trié par date décroissante (JOURNALIER, ALERTES) dont la date est >= fromDay :
 * seul le haut du tableau est réécrit. keepOld(r) = garder quand même une ancienne ligne du bloc.
 */
function replaceTop_(name, fromDay, newRows, sortFn, keepOld) {
  const k = keyOfSheet_(name), headers = H[k], s = ensureSheet_(name, headers), I = idx_(headers), ci = I[DATE_COL[k]];
  const lr = s.getLastRow();
  let n = 0, old = [];
  if (lr > 1) {
    const dv = s.getRange(2, ci + 1, lr - 1, 1).getValues();
    for (let i = dv.length - 1; i >= 0; i--) { const d = toDayStr_(dv[i][0]); if (d && d >= fromDay) { n = i + 1; break; } }
    if (n) old = s.getRange(2, 1, n, headers.length).getValues();
  }
  const kept = old.filter(r => { const d = toDayStr_(r[ci]); return (d && d < fromDay) || (keepOld && keepOld(r)); });
  const block = newRows.concat(kept).map(r => fit_(r, headers.length));
  if (sortFn) block.sort(sortFn);
  if (block.length > n) s.insertRowsAfter(1 + n, block.length - n);
  else if (block.length < n) {
    if (s.getMaxRows() <= 1 + n) s.insertRowsAfter(s.getMaxRows(), 1);   // Google refuse de supprimer toutes les lignes non figées
    s.deleteRows(2 + block.length, n - block.length);
  }
  if (block.length) {
    const rg = s.getRange(2, 1, block.length, headers.length);
    rg.setFontWeight('normal').setFontColor('#000000').setBackground(null);   // lignes insérées sous l'en-tête : pas son format
    textCols_(s, headers, 2, block.length); fmtDates_(s, headers, 2, block.length);
    rg.setValues(clean_(block));
  }
  memoClear_();
  return { before: n, after: block.length };
}
/** Ajoute des lignes en fin de tableau (aucune relecture) */
function appendRows_(name, rows) {
  if (!rows.length) return;
  const headers = H[keyOfSheet_(name)], s = ensureSheet_(name, headers), start = s.getLastRow() + 1;
  if (s.getMaxRows() < start + rows.length) s.insertRowsAfter(s.getMaxRows(), start + rows.length - s.getMaxRows());
  textCols_(s, headers, start, rows.length); fmtDates_(s, headers, start, rows.length);
  s.getRange(start, 1, rows.length, headers.length).setValues(clean_(rows.map(r => fit_(r, headers.length))));
  memoClear_();
}
/** Supprime des lignes d'un petit tableau (LIVE_*) selon un filtre : réécriture complète (tableau petit) */
function removeRows_(name, drop) {
  const T = readTable_(name); if (!T.rows.length) return 0;
  const keep = T.rows.filter(r => !drop(r));
  if (keep.length !== T.rows.length) { writeTable_(name, H[keyOfSheet_(name)], keep); memoClear_(); }
  return T.rows.length - keep.length;
}

function log_(action, detail, t0) {
  try {
    const s = ensureSheet_(S.LOG, H.LOG);
    s.insertRowAfter(1);
    s.getRange(2, 1, 1, 4).setNumberFormats([['dd/MM/yyyy HH:mm:ss', '@', '@', '0.0']]).setFontWeight('normal').setBackground(null).setFontColor('#000000');
    s.getRange(2, 1, 1, 4).setValues([[new Date(), action, String(detail).slice(0, 4000), t0 ? r1_((Date.now() - t0) / 1000) : '']]);
    if (s.getLastRow() > 600) s.deleteRows(501, s.getLastRow() - 500);
  } catch (e) { /* journal best effort */ }
}
function tms_(v) { const d = toDate_(v); return d ? d.getTime() : 0; }
function toast_(msg, title, sec) { try { ss_().toast(msg, title || 'Flotte Geotab', sec || 6); } catch (e) { } }
function ui_() { try { return SpreadsheetApp.getUi(); } catch (e) { return null; } }

// ---------- Paramètres ----------
function params_() {
  if (MEMO_.__P) return Object.assign({}, MEMO_.__P);
  const P = {};
  PARAM_DEFS.forEach(d => { P[d[0]] = d[2]; });
  const s = sh_(S.PARAM);
  if (s && s.getLastRow() >= 4) {
    const byLabel = {}; PARAM_DEFS.forEach(d => { byLabel[d[1]] = d[0]; });
    s.getRange(4, 1, s.getLastRow() - 3, 2).getValues().forEach(r => {
      const k = byLabel[String(r[0]).trim()];
      if (k && r[1] !== '') P[k] = r[1];
    });
  }
  ['priceDiesel', 'priceGas', 'siphonPct', 'siphonL', 'pleinPct', 'stopMin', 'idleLongMin', 'idleAlertMin', 'idleDayMin', 'minFuelKm',
    'vmaxAlert', 'overAlert', 'scoreY', 'scoreO', 'scoreR', 'kmMin', 'overConsPct', 'ctrTolMin', 'lvlDays',
    'catchupDays', 'rpmMin', 'fullPct', 'shiftDay', 'shiftNight', 'liveMin', 'autoRenderMin', 'retentionDays'].forEach(k => { P[k] = num_(P[k]); });
  MEMO_.__P = P;
  return Object.assign({}, P);
}
function setParam_(key, value) {
  memoClear_();
  const s = sh_(S.PARAM); if (!s) return;
  const def = PARAM_DEFS.find(d => d[0] === key); if (!def) return;
  const vals = s.getRange(4, 1, Math.max(1, s.getLastRow() - 3), 1).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === def[1]) { s.getRange(i + 4, 2).setValue(value); return; }
}

// ============================================================================
// 3. API GEOTAB (JSON-RPC)
// ============================================================================
function geoRaw_(server, method, params) {
  const resp = UrlFetchApp.fetch('https://' + server + '/apiv1', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ method: method, params: params })
  });
  return geoParse_(resp, method);
}
/**
 * Plusieurs appels Geotab envoyés en même temps (téléchargements en parallèle).
 * Retourne une fonction de lecture par requête : la réponse n'est décodée qu'au moment de son traitement,
 * une à la fois, pour limiter la mémoire. Lecture -> {res} ou {err}.
 */
function geoFetchAll_(reqs) {
  const go = s => UrlFetchApp.fetchAll(reqs.map(r => ({ url: 'https://' + s.server + '/apiv1', method: 'post', contentType: 'application/json',
    muteHttpExceptions: true, payload: JSON.stringify({ method: r.method, params: Object.assign({}, r.params, { credentials: s.credentials }) }) })));
  const authErr = r => { const t = r.getContentText(); return t.length < 5000 && /"error"/.test(t) && /InvalidUser|Credential|DbUnavailable/i.test(t); };
  let resps = go(geoAuth_(false));
  if (resps.some(authErr)) resps = go(geoAuth_(true));
  return resps.map((resp, i) => () => { try { return { res: geoParse_(resp, reqs[i].method) }; } catch (e) { return { err: e }; } });
}
function geoParse_(resp, method) {
  let j;
  try { j = JSON.parse(resp.getContentText()); }
  catch (e) { throw new Error('Réponse Geotab illisible (HTTP ' + resp.getResponseCode() + ')'); }
  if (j.error) {
    const er = j.error;
    const name = (er.errors && er.errors[0] && er.errors[0].name) || (er.data && er.data.type) || er.name || '';
    const e = new Error('Geotab ' + method + ' : ' + (er.message || name));
    e.geoName = name;
    throw e;
  }
  return j.result;
}
function geoAuth_(force) {
  const props = PropertiesService.getScriptProperties();
  if (!force) { const c = props.getProperty('GEO_SESSION'); if (c) return JSON.parse(c); }
  const P = params_();
  const pwd = props.getProperty('GEO_PWD');
  const user = props.getProperty('GEO_USER') || P.geoUser;
  if (!user || !pwd) throw new Error('Accès Geotab non configuré : menu Flotte Geotab > Configurer accès Geotab.');
  const base = String(P.geoServer || 'my.geotab.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const res = geoRaw_(base, 'Authenticate', { database: String(P.geoDb), userName: user, password: pwd });
  const server = res.path && res.path !== 'ThisServer' ? res.path : base;
  const sess = { server: server, credentials: res.credentials };
  props.setProperty('GEO_SESSION', JSON.stringify(sess));
  return sess;
}
function geoCall_(method, params) {
  let s = geoAuth_(false);
  try { return geoRaw_(s.server, method, Object.assign({}, params, { credentials: s.credentials })); }
  catch (e) {
    if (/InvalidUser|Credential|session|DbUnavailable/i.test((e.geoName || '') + ' ' + e.message)) {
      s = geoAuth_(true);
      return geoRaw_(s.server, method, Object.assign({}, params, { credentials: s.credentials }));
    }
    throw e;
  }
}
function geoMulti_(calls) { return geoCall_('ExecuteMultiCall', { calls: calls }); }
function iso_(d) { return new Date(d).toISOString(); }

// ============================================================================
// 4. MENU, INSTALLATION, BOUTONS
// ============================================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Flotte Geotab')
    .addItem('1. Installer / réparer l\'outil', 'setup')
    .addItem('2. Configurer accès Geotab', 'configureGeotab')
    .addItem('3. Tester la connexion Geotab', 'testGeotab')
    .addSeparator()
    .addItem('Importer véhicules (Parc Automobile)', 'importVehicles')
    .addItem('Associer véhicules Geotab', 'mapGeotabDevices')
    .addItem('Analyser les sources de mesure Geotab', 'analyzeSources')
    .addItem('Sonde Geotab (réponses brutes de l\'API)', 'sondeGeotab')
    .addItem('Injecter contrats (xlsx)', 'openInjectDialog')
    .addItem('Appliquer les changements de plaques (onglet PLAQUES)', 'appliquerPlaques')
    .addSeparator()
    .addItem('Mettre à jour maintenant (temps réel)', 'syncNow')
    .addItem('Synchroniser hier', 'syncYesterday')
    .addItem('Synchroniser une période passée...', 'syncPeriod')
    .addItem('Recalculer (chauffeurs, alertes)', 'recompute')
    .addItem('Vérifier et réparer les données', 'verifierDonnees')
    .addItem('Compte rendu chauffeur (PDF)', 'openReportDialog')
    .addItem('Bilan de la semaine, tous les chauffeurs (PDF)', 'openWeeklyDialog')
    .addItem('Bilan de fin de shift (PDF, FR ou FR + darija)', 'openShiftDialog')
    .addItem('Carburant consommé entre deux dates', 'openFuelPeriodDialog')
    .addItem('Actualiser les tableaux', 'actualiser')
    .addItem('TOUT ACTUALISER (véhicules, chauffeurs, tous les onglets)', 'toutActualiser')
    .addItem('Archiver les données anciennes maintenant', 'archiveNow')
    .addSeparator()
    .addItem('Activer l\'automatisation', 'installTriggers')
    .addItem('Désactiver l\'automatisation', 'removeTriggers')
    .addItem('Envoyer le rapport email maintenant', 'sendDailyReport')
    .addToUi();
}
function btnInjecter() { openInjectDialog(); }
function btnSync() { syncNow(); }
function btnActualiser() { actualiser(); }
function btnToutActualiser() { toutActualiser(); }

function setup() {
  const t0 = Date.now(), ss = ss_(), props = PropertiesService.getScriptProperties(), errs = [];
  const step = (lbl, fn) => { try { fn(); } catch (e) { errs.push(lbl + ' : ' + e.message); } };
  const migrate = props.getProperty('SCHEMA_V') !== SCHEMA_V;
  if (migrate) {
    // Passage v5 -> v6 : on arrête les anciennes boucles de synchro et la migration démarre en arrière-plan (reprise auto si Google coupe)
    if (!props.getProperty('MIG_AUTO') && ScriptApp.getProjectTriggers().some(t => ['autoSync', 'collect'].indexOf(t.getHandlerFunction()) >= 0)) props.setProperty('MIG_AUTO', '1');
    ['runSyncQueue', 'runRefreshQueue', 'migrateV6'].forEach(clearTriggers_);
    ['SYNC_QUEUE', 'REPAIR_ROUND', 'AFTER_SYNC_REFRESH', 'REFRESH_STEPS', 'SYNC_LIGHT'].forEach(k => props.deleteProperty(k));
    ScriptApp.newTrigger('migrateV6').timeBased().after(60 * 1000).create();
  }
  step('fuseau', () => ss.setSpreadsheetTimeZone(TZ));
  step('onglets', () => {
    [S.DASH, S.TODAY, S.RANK, S.DRIVE, S.IDLE, S.FILL, S.CTRL].forEach(n => ensureSheet_(n, null, '#1F3864'));
    [S.LIVE, S.FICHE].forEach(n => { const x = ensureSheet_(n, null, '#00704A'); x.setHiddenGridlines(true); });
    ensureSheet_(S.PLATES, H.PLATES, '#2E75B6');
    ensureSheet_(S.SRC, H.SRC, '#999999');
    ensureSheet_(S.ALERT, H.ALERT, '#C00000');
    ensureSheet_(S.VEH, H.VEH, '#2E75B6');
    ensureSheet_(S.DRV, H.DRV, '#2E75B6');
    ensureSheet_(S.CTR, H.CTR, '#2E75B6');
    ensureSheet_(S.RULE, H.RULE, '#2E75B6');
  });
  step('paramètres', () => setupParams_());
  step('tableaux de données', () => DATA_SHEETS.concat(['LOG']).forEach(k => ensureSheet_(S[k], H[k], '#999999')));
  if (props.getProperty('NEED_RESYNC')) step('remise à zéro', () => {
    DATA_SHEETS.forEach(k => { const s = sh_(S[k]); if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).clearContent(); });
  });
  step('feuille vide', () => ['Feuille 1', 'Sheet1', 'Feuille1'].forEach(n => { const s = sh_(n); if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s); }));
  // mise en forme des colonnes : une seule fois (sur un gros classeur c'est long)
  if (!props.getProperty('FORMAT_V6')) step('mise en forme', () => { formatDataSheets_(); props.setProperty('FORMAT_V6', '1'); });
  step('boutons', () => setupControls_());
  step('ordre des onglets', () => ['DASH', 'LIVE', 'TODAY', 'FICHE', 'RANK', 'DRIVE', 'IDLE', 'FILL', 'ALERT', 'VEH', 'PLATES', 'DRV', 'CTR', 'RULE', 'CTRL', 'PARAM']
    .forEach((k, i) => { const s = sh_(S[k]); if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); } }));
  if (!migrate) {
    step('véhicules', () => importVehicles(true));
    step('rendu', () => refreshViews(true));
  }
  // Classeur sans données (première installation) : la « migration » est immédiate
  if (migrate) step('migration', () => { const t = sh_(S.TRIP), e = sh_(S.EVT); if ((!t || t.getLastRow() < 2) && (!e || e.getLastRow() < 2)) { migrateV6(); } });
  const migrating = migrate && props.getProperty('SCHEMA_V') !== SCHEMA_V;
  if (migrate && !migrating) { step('véhicules', () => importVehicles(true)); step('rendu', () => refreshViews(true)); }
  step('activation', () => ss.setActiveSheet(sh_(S.DASH)));
  log_('Installation', errs.length ? 'Terminée avec des erreurs (reprise automatique) : ' + errs.join(' | ') : 'OK', t0);
  const ui = ui_();
  if (migrating) {
    if (ui) ui.alert('Mise à jour v6 lancée', 'Les données sont réorganisées en arrière-plan (environ 10 à 15 minutes, par étapes, reprise automatique si Google coupe). ' +
      'Suivi dans l\'onglet LOG (« Mise à jour v6 »). Vous pouvez fermer le Sheet.\n\nRien d\'autre à faire : l\'automatisation se réactive toute seule à la fin.', ui.ButtonSet.OK);
    return;
  }
  if (props.getProperty('NEED_RESYNC')) {
    props.deleteProperty('NEED_RESYNC');
    if (ui) ui.alert('Mise à jour installée', 'La structure des données a changé. Relancez "Synchroniser une période" sur toute la période voulue (vos contrats, chauffeurs, paramètres et statuts d\'alertes sont conservés).', ui.ButtonSet.OK);
    return;
  }
  if (ui) ui.alert('Installation terminée',
    'Étapes suivantes :\n1. Menu Flotte Geotab > Configurer accès Geotab\n2. Associer véhicules Geotab\n3. Injecter contrats\n4. Synchroniser une période (ex. 7 derniers jours)\n5. Activer l\'automatisation (temps réel toutes les 5 min)', ui.ButtonSet.OK);
}

function setupParams_() {
  const s = ensureSheet_(S.PARAM, null, '#7F7F7F');
  s.getRange('A1').setValue('Paramètres de l\'outil').setFontSize(14).setFontWeight('bold');
  s.getRange('A2').setValue('Cellules jaunes : valeurs modifiables. Ne pas renommer la colonne A.').setFontColor('#7F7F7F');
  s.getRange(3, 1, 1, 3).setValues([['Paramètre', 'Valeur', 'Note']]).setFontWeight('bold').setBackground(C_HEAD).setFontColor('#FFFFFF');
  const existing = {};
  if (s.getLastRow() >= 4) s.getRange(4, 1, s.getLastRow() - 3, 2).getValues().forEach(r => { existing[String(r[0]).trim()] = r[1]; });
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PARAMS_V2')) {
    // Anciens prix indicatifs de la V1 retirés : seul le prix réel saisi compte
    if (existing['Prix gasoil (MAD/L)'] === 11.5) existing['Prix gasoil (MAD/L)'] = '';
    if (existing['Prix essence (MAD/L)'] === 13.5) existing['Prix essence (MAD/L)'] = '';
    props.setProperty('PARAMS_V2', '1');
  }
  if (!props.getProperty('PARAMS_V5')) {
    // Anciens seuils de danger (trop bas pour le volume réel d'événements) remplacés par les seuils calés sur la flotte
    [['Score danger : seuil Modéré', 10], ['Score danger : seuil Élevé', 25], ['Score danger : seuil Dangereux', 50]].forEach(x => { if (existing[x[0]] === x[1]) existing[x[0]] = ''; });
    props.setProperty('PARAMS_V5', '1');
  }
  if (!props.getProperty('PARAMS_V6')) {
    // V6 : le score ne compte plus que les règles de conduite (sans doublons) -> seuils recalés
    [['Score danger : seuil Modéré', 47], ['Score danger : seuil Élevé', 58], ['Score danger : seuil Dangereux', 104]].forEach(x => { if (existing[x[0]] === x[1]) existing[x[0]] = ''; });
    props.setProperty('PARAMS_V6', '1');
  }
  const rows = PARAM_DEFS.map(d => [d[1], existing[d[1]] !== undefined && existing[d[1]] !== '' ? existing[d[1]] : d[2], d[3]]);
  if (s.getLastRow() > 3) s.getRange(4, 1, s.getLastRow() - 3, 3).clearContent();
  s.getRange(4, 1, rows.length, 3).setValues(rows);
  s.getRange(4, 2, rows.length, 1).setBackground('#FFF2CC').setHorizontalAlignment('left');
  s.getRange(4, 3, rows.length, 1).setFontColor('#7F7F7F');
  s.setColumnWidth(1, 300); s.setColumnWidth(2, 330); s.setColumnWidth(3, 420);
  s.setFrozenRows(3);
}

function formatDataSheets_() {
  const fmt = (name, map) => {
    const s = sh_(name); if (!s) return;
    const I = idx_(H[keyOfSheet_(name)]);
    Object.keys(map).forEach(h => { if (I[h] !== undefined) s.getRange(2, I[h] + 1, s.getMaxRows() - 1, 1).setNumberFormat(map[h]); });
  };
  const dt = 'dd/MM/yyyy HH:mm', d = 'dd/MM/yyyy';
  fmt(S.TRIP, { 'Date': d, 'Début': dt, 'Fin': dt, 'Km': '0.0', 'Conduite (min)': '0', 'Ralenti (min)': '0', 'Carburant (L)': '0.00', 'Carburant ralenti (L)': '0.00', 'ID': '@', 'Heure pire': '@' });
  fmt(S.IDL, { 'Date': d, 'Début': dt, 'Fin': dt, 'Durée arrêt (min)': '0', 'Moteur tournant (min)': '0', 'Trajet ID': '@' });
  fmt(S.SRC, { 'Analysé le': dt });
  const sr = sh_(S.SRC), ISR = idx_(H.SRC);
  sr.getRange(2, ISR['Rôle'] + 1, sr.getMaxRows() - 1, 1).setBackground('#FFF2CC').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Carburant total', 'Carburant ralenti', 'Débit carburant', 'Régime moteur', 'Jauge', 'Bilan trajet', 'Ignorer'], true).build());
  fmt(S.EVT, { 'Date': d, 'Début': dt, 'Fin': dt, 'ID': '@' });
  fmt(S.FUEL, { 'Date': d, 'Arrêt début': dt, 'Arrêt fin': dt, 'Litres (jauge)': '0.0', 'Écart (%)': '0.0' });
  fmt(S.LVL, { 'Horodatage': dt });
  fmt(S.LOG, { 'Horodatage': 'dd/MM/yyyy HH:mm:ss' });
  fmt(S.JRN, { 'Date': d, 'Début contrat': dt, 'Fin contrat': dt });
  fmt(S.ALERT, { 'Heure': '@' });
  fmt(S.ALERT, { 'Date': d });
  fmt(S.CTR, { 'Début': dt, 'Fin': dt, 'Importé le': dt, 'Mis à jour le': dt, 'Téléphone': '@' });
  fmt(S.DRV, { 'Premier contrat': d, 'Dernier contrat': d, 'Détecté le': d, 'Téléphone': '@' });
  fmt(S.VEH, { 'Dernière synchro': dt });
  // Listes déroulantes et couleurs
  const a = sh_(S.ALERT), IA = idx_(H.ALERT);
  a.getRange(2, IA['Statut'] + 1, a.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['À traiter', 'En cours', 'Traité', 'Faux positif'], true).build());
  const gr = a.getRange(2, IA['Gravité'] + 1, a.getMaxRows() - 1, 1);
  a.setConditionalFormatRules(Object.keys(GRAV).map(g => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(g).setBackground(GRAV[g][0]).setFontColor(GRAV[g][1]).setRanges([gr]).build()));
  a.setColumnWidth(IA['Détail'] + 1, 420);
  const dv = sh_(S.DRV), ID = idx_(H.DRV);
  dv.getRange(2, ID['Statut'] + 1, dv.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['NOUVEAU', 'ACTIF', 'INACTIF', 'BLACKLIST'], true).build());
  dv.setConditionalFormatRules([SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('NOUVEAU')
    .setBackground('#FFEB9C').setFontColor('#9C5700').setRanges([dv.getRange(2, 1, dv.getMaxRows() - 1, H.DRV.length)]).build()]);
  const v = sh_(S.VEH), IV = idx_(H.VEH);
  ['Réservoir (L)', 'Conso réf (L/100)', 'Recette/contrat (MAD)', 'Actif'].forEach(h =>
    v.getRange(2, IV[h] + 1, v.getMaxRows() - 1, 1).setBackground('#FFF2CC'));
  const r = sh_(S.RULE), IR = idx_(H.RULE);
  r.getRange(2, IR['Poids danger'] + 1, r.getMaxRows() - 1, 1).setBackground('#FFF2CC');
  r.setColumnWidth(2, 320); r.setColumnWidth(6, 300);
}

function setupControls_() {
  const dash = sh_(S.DASH);
  dash.getRange('A3:A5').setValues([['Période'], ['Du'], ['Au']]).setFontWeight('bold');
  if (!dash.getRange('B3').getValue()) dash.getRange('B3').setValue('7 derniers jours');
  dash.getRange('B3').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(
    ['Aujourd\'hui', 'Hier', '7 derniers jours', '30 derniers jours', 'Semaine en cours', 'Mois en cours', 'Personnalisé'], true).build());
  dash.getRange('B3:B5').setBackground('#FFF2CC');
  dash.getRange('B4:B5').setNumberFormat('dd/MM/yyyy');
  dash.getRange('C4').setValue('(Du / Au utilisés si Personnalisé)').setFontColor('#7F7F7F');
  const tod = sh_(S.TODAY);
  tod.getRange('A3').setValue('Date').setFontWeight('bold');
  tod.getRange('B3').setBackground('#FFF2CC').setNumberFormat('dd/MM/yyyy');
  tod.getRange('C3').setValue('(vide = aujourd\'hui)').setFontColor('#7F7F7F');
  [dash, tod].forEach(s => {
    s.getImages().forEach(im => im.remove());
    addButton_(s, 'INJECT', 'btnInjecter', 5, 0);
    addButton_(s, 'SYNC', 'btnSync', 5, 210);
    addButton_(s, 'REFRESH', 'btnActualiser', 5, 420);
    addButton_(s, 'ALL', 'btnToutActualiser', 5, 630);
    addButton_(s, 'FUEL', 'btnCarburantPeriode', 5, 840);
    s.setHiddenGridlines(true);
  });
  [S.RANK, S.DRIVE, S.IDLE, S.FILL, S.CTRL].forEach(n => sh_(n).setHiddenGridlines(true));
}
function addButton_(s, key, fn, col, offX) {
  if (!BTN[key]) return;
  try {
    const img = s.insertImage(Utilities.newBlob(Utilities.base64Decode(BTN[key]), 'image/png', key + '.png'), col, 1, offX, 4);
    img.assignScript(fn);
  } catch (e) { log_('Bouton', e.message); }
}

// ---------- Accès Geotab ----------
function configureGeotab() {
  const P = params_();
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;font-size:13px">' +
    '<p>Base : <b>' + P.geoDb + '</b></p>' +
    '<p>Utilisateur Geotab<br><input id="u" style="width:100%" value="' + (P.geoUser || '') + '"></p>' +
    '<p>Mot de passe<br><input id="p" type="password" style="width:100%"></p>' +
    '<button onclick="go()" style="background:#1F3864;color:#fff;border:0;padding:8px 16px;border-radius:6px">Enregistrer et tester</button>' +
    '<p id="s" style="color:#555"></p></div>' +
    '<script>function go(){document.getElementById("s").innerText="Connexion...";' +
    'google.script.run.withSuccessHandler(function(r){document.getElementById("s").innerText=r;})' +
    '.withFailureHandler(function(e){document.getElementById("s").innerText="Erreur : "+e.message;})' +
    '.saveGeotabCreds(document.getElementById("u").value,document.getElementById("p").value);}</script>'
  ).setWidth(380).setHeight(270);
  SpreadsheetApp.getUi().showModalDialog(html, 'Accès Geotab');
}
function saveGeotabCreds(user, pwd) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('GEO_USER', String(user).trim());
  if (pwd) props.setProperty('GEO_PWD', pwd);
  props.deleteProperty('GEO_SESSION');
  setParam_('geoUser', String(user).trim());
  const s = geoAuth_(true);
  const dev = geoCall_('Get', { typeName: 'Device', resultsLimit: 5000 }) || [];
  let extra = '';
  try {
    if (!readTable_(S.VEH).rows.length) importVehicles(true); else mapGeotabDevices(true);
    const vs = Object.values(vehicles_());
    extra = ' ' + vs.filter(v => v.geoId).length + '/' + vs.length + ' véhicules du parc associés.';
    syncRules_();
  } catch (e) { extra = ' Association : ' + e.message; }
  return 'Connecté (serveur ' + s.server + '). ' + dev.length + ' boîtiers visibles.' + extra + ' Vous pouvez fermer.';
}
function testGeotab() {
  const u = ui_(); let msg;
  try {
    const s = geoAuth_(true);
    const dev = geoCall_('Get', { typeName: 'Device', resultsLimit: 5000 }) || [];
    const vs = Object.values(vehicles_()), ok = vs.filter(v => v.geoId).length;
    msg = ['Connexion OK', 'Serveur : ' + s.server + '\nBoîtiers visibles : ' + dev.length + '\nVéhicules du parc associés : ' + ok + ' / ' + vs.length];
  } catch (e) { msg = ['Échec connexion', e.message]; }
  log_('Test connexion', msg.join(' : '));
  if (u) u.alert(msg[0], msg[1], u.ButtonSet.OK); else toast_(msg[1], msg[0]);
  return msg.join(' : ');
}

// ============================================================================
// 5. VÉHICULES (Parc Automobile) ET ASSOCIATION GEOTAB
// ============================================================================
function modelDefaults_(model) {
  const m = String(model || '').toUpperCase();
  for (const k in MODEL_DEFAULTS) if (k !== '_' && m.indexOf(k) >= 0) return MODEL_DEFAULTS[k];
  return MODEL_DEFAULTS._;
}
function colToIndex_(col) {
  let n = 0; String(col).toUpperCase().replace(/[^A-Z]/g, '').split('').forEach(c => { n = n * 26 + c.charCodeAt(0) - 64; });
  return n;
}
function importVehicles(silent) {
  const t0 = Date.now(), P = params_();
  const src = SpreadsheetApp.openById(String(P.parcId)).getSheetByName(String(P.parcTab));
  if (!src) throw new Error('Onglet "' + P.parcTab + '" introuvable dans le Sheet Parc.');
  const data = src.getDataRange().getValues();
  const head = data[0].map(h => normTxt_(h));
  const find = (re, dflt) => { const i = head.findIndex(h => re.test(h)); return i >= 0 ? i : dflt; };
  const cPl = colToIndex_(P.parcCol) - 1;
  const cMa = find(/^marque/, 7), cMo = find(/^modele/, 8), cVin = find(/chassis|vin/, 9), cCa = find(/^carburant/, 17);
  const T = readTable_(S.VEH), I = idx_(H.VEH);
  const byKey = {}, known = {}; T.rows.forEach(r => { byKey[String(r[I['Clé']])] = r; platesOf_(r, I).forEach(p => { known[normPlate_(p)] = 1; }); });
  let added = 0;
  const out = {};
  data.slice(1).forEach(r => {
    const plate = String(r[cPl] || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!plate || plate.length < 4) return;
    const key = normPlate_(plate);
    const old = byKey[key];
    const d = modelDefaults_(r[cMo]);
    const row = old ? old.slice() : new Array(H.VEH.length).fill('');
    while (row.length < H.VEH.length) row.push('');
    row[I['Plaque']] = plate; row[I['Clé']] = key;
    row[I['Marque']] = r[cMa]; row[I['Modèle']] = r[cMo]; row[I['VIN']] = r[cVin]; row[I['Carburant']] = r[cCa];
    if (row[I['Réservoir (L)']] === '') row[I['Réservoir (L)']] = d.tank;
    if (row[I['Actif']] === '') row[I['Actif']] = 'OUI';
    if (!old && !known[key]) added++;
    out[key] = row;
  });
  T.rows.forEach(r => { const k = String(r[I['Clé']]); if (!out[k]) out[k] = r; });
  // Un même véhicule (même châssis) peut apparaître sous deux plaques : plaque W18/WW provisoire puis plaque définitive.
  // Une seule ligne est gardée (la plaque qui a l'historique), l'autre devient « Autres plaques » : pas de double comptage.
  const mg = mergeAliases_(out, I);
  const rows = Object.values(out).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  // journal : seulement les regroupements nouveaux ou modifiés
  const prev = {}; T.rows.forEach(r => { prev[String(r[I['Clé']])] = String(r[I['Plaque']]) + '|' + String(r[I['Autres plaques']] || ''); });
  const merged = rows.filter(r => String(r[I['Autres plaques']] || '') && prev[String(r[I['Clé']])] !== String(r[I['Plaque']]) + '|' + String(r[I['Autres plaques']] || ''))
    .map(r => r[I['Plaque']] + ' = ' + r[I['Autres plaques']]);
  writeTable_(S.VEH, H.VEH, rows);
  const s = sh_(S.VEH);
  s.getRange(2, I['Réservoir (L)'] + 1, rows.length, 1).setNote('Capacité constructeur (Staria 75 L, Sonata Hybrid 50 L), à vérifier sur la fiche technique. Sert uniquement à convertir la jauge en litres.');
  log_('Import véhicules', rows.length + ' véhicules (' + added + ' nouveaux)' + (merged.length ? ' | même véhicule, plaques regroupées : ' + merged.join(' ; ') : ''), t0);
  if (silent !== true) toast_(rows.length + ' véhicules, ' + added + ' nouveaux.', 'Import véhicules');
  memoClear_();
  const nCtr = canonContracts_();
  // Une plaque devenue « autre plaque » d'un véhicule : ses données éventuelles sont rattachées à la clé historique
  const was = {}; T.rows.forEach(r => { was[String(r[I['Clé']])] = 1; });
  const gone = mg.aliased.filter(k => was[k]);
  if ((gone.length || nCtr) && PropertiesService.getScriptProperties().getProperty('SCHEMA_V') === SCHEMA_V) { try { rekeyAll_(); } catch (e) { log_('Plaques', e.message); } }
  try { mapGeotabDevices(true); } catch (e) { log_('Association Geotab', e.message); }
  try { syncPlatesTab_(); } catch (e) { log_('Plaques', e.message); }
  return rows.length;
}
/** Contrats saisis sous une autre plaque du même véhicule : rattachés à la clé du véhicule */
function canonContracts_() {
  const s = sh_(S.CTR); if (!s || s.getLastRow() < 2) return 0;
  const I = idx_(H.CTR), cm = canonMap_(), rg = s.getRange(2, I['Clé plaque'] + 1, s.getLastRow() - 1, 1), v = rg.getValues(); let n = 0;
  v.forEach(r => { if (r[0] === '') return; const k = canonKey_(r[0], cm); if (k !== String(r[0])) { r[0] = k; n++; } });
  if (n) rg.setValues(v);
  return n;
}
/** Regroupe les lignes véhicule de même châssis (VIN). Modifie out, retourne la liste des regroupements. */
/** Plaque provisoire (WW / W18) : sinon plaque définitive */
function isTempPlate_(p) { const n = normPlate_(p); return /WW$/.test(n) || /W18/.test(String(p).toUpperCase()) || /^W\d/.test(String(p).toUpperCase()); }
function platesOf_(r, I) { return [String(r[I['Plaque']] || '')].concat(String(r[I['Autres plaques']] || '').split(/[,;]\s*/)).map(x => x.trim()).filter(Boolean); }
/** Changements de plaque saisis dans l'onglet PLAQUES : [{old, neu, oldK, newK, row}] */
function platePairs_() {
  const s = sh_(S.PLATES); if (!s || s.getLastRow() < 2) return [];
  const v = s.getRange(2, 1, s.getLastRow() - 1, 2).getValues(), out = [];
  v.forEach((r, i) => {
    const o = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, ''), n = String(r[1] || '').trim().toUpperCase().replace(/\s+/g, '');
    if (o.length >= 4 && n.length >= 4) out.push({ old: o, neu: n, oldK: normPlate_(o), newK: normPlate_(n), row: i + 2 });
  });
  return out;
}
/**
 * Regroupe les lignes véhicule qui sont le même véhicule : même châssis (VIN), même boîtier Geotab, ou changement de plaque
 * saisi dans PLAQUES. Une seule ligne est gardée : la clé qui a l'historique (données, contrats) ; la plaque affichée est la
 * plaque définitive ; les autres plaques vont dans « Autres plaques ». Modifie out, retourne {msgs, aliased: [clés absorbées]}.
 */
function mergeAliases_(out, I) {
  const keys = Object.keys(out), parent = {}, msgs = [], aliased = [];
  keys.forEach(k => { parent[k] = k; });
  const find = k => { while (parent[k] !== k) k = parent[k] = parent[parent[k]]; return k; };
  const union = (a, b) => { if (parent[a] === undefined || parent[b] === undefined) return; a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const by = {};
  keys.forEach(k => {
    const vin = String(out[k][I['VIN']] || '').toUpperCase().replace(/\s+/g, ''), g = String(out[k][I['Geotab ID']] || '');
    if (vin.length >= 8) (by['V' + vin] = by['V' + vin] || []).push(k);
    if (g) (by['G' + g] = by['G' + g] || []).push(k);
    platesOf_(out[k], I).forEach(p => union(k, normPlate_(p)));
  });
  Object.keys(by).forEach(x => by[x].slice(1).forEach(k => union(by[x][0], k)));
  const pairs = platePairs_(), pk = {};
  pairs.forEach(p => { union(p.oldK, p.newK); pk[p.oldK] = p; pk[p.newK] = p; });
  const hist = {};
  try { readTable_(S.SYNC).rows.forEach(r => { const k = String(r[1]); hist[k] = (hist[k] || 0) + 1; }); } catch (e) { }
  try { const C = readTable_(S.CTR), IC = idx_(H.CTR); C.rows.forEach(r => { const k = String(r[IC['Clé plaque']]); hist[k] = (hist[k] || 0) + 1; }); } catch (e) { }
  const groups = {}; keys.forEach(k => { const g = find(k); (groups[g] = groups[g] || []).push(k); });
  Object.values(groups).forEach(ks => {
    ks.sort((a, b) => (hist[b] || 0) - (hist[a] || 0) || isTempPlate_(out[b][I['Plaque']]) - isTempPlate_(out[a][I['Plaque']]) || a.localeCompare(b));
    const keep = out[ks[0]];
    let plates = [];
    ks.forEach(k => platesOf_(out[k], I).forEach(p => { if (plates.indexOf(p) < 0) plates.push(p); }));
    // plaques de PLAQUES concernant ce véhicule (même si la plaque définitive n'est pas encore dans le Parc)
    pairs.forEach(p => { if (ks.indexOf(p.oldK) >= 0 || ks.indexOf(p.newK) >= 0 || plates.some(x => normPlate_(x) === p.oldK || normPlate_(x) === p.newK)) [p.old, p.neu].forEach(x => { if (!plates.some(y => normPlate_(y) === normPlate_(x))) plates.push(x); }); });
    if (plates.length < 2 && ks.length < 2) return;
    const declared = pairs.filter(p => plates.some(x => normPlate_(x) === p.newK)).map(p => p.neu);
    const display = declared[declared.length - 1] || plates.find(p => !isTempPlate_(p)) || keep[I['Plaque']];
    ks.slice(1).forEach(k => {
      const r = out[k];
      if (keep[I['Geotab ID']] === '' && r[I['Geotab ID']] !== '') { keep[I['Geotab ID']] = r[I['Geotab ID']]; keep[I['Nom Geotab']] = r[I['Nom Geotab']]; }
      if (keep[I['VIN']] === '' && r[I['VIN']] !== '') keep[I['VIN']] = r[I['VIN']];
      delete out[k]; aliased.push(k);
    });
    const others = plates.filter(p => normPlate_(p) !== normPlate_(display));
    const before = String(keep[I['Plaque']]) + '|' + String(keep[I['Autres plaques']] || '');
    keep[I['Plaque']] = display; keep[I['Autres plaques']] = others.join(', ');
    if (ks.length > 1 || before !== display + '|' + others.join(', ')) msgs.push(display + ' = ' + others.join(', '));
  });
  return { msgs, aliased };
}
/** Plaque normalisée -> clé du véhicule (toutes les plaques d'un véhicule, y compris PLAQUES, renvoient à sa clé historique) */
function canonMap_() {
  if (MEMO_.__canon) return MEMO_.__canon;
  const T = readTable_(S.VEH), I = idx_(H.VEH), m = {};
  T.rows.forEach(r => {
    const k = String(r[I['Clé']] || ''); if (!k) return;
    m[k] = k;
    platesOf_(r, I).forEach(p => { m[normPlate_(p)] = k; });
  });
  platePairs_().forEach(p => { if (m[p.oldK] && !m[p.newK]) m[p.newK] = m[p.oldK]; else if (m[p.newK] && !m[p.oldK]) m[p.oldK] = m[p.newK]; });
  return (MEMO_.__canon = m);
}
/** Clé véhicule d'une plaque quelconque (provisoire ou définitive) */
function plateKey_(p) { return canonKey_(normPlate_(p)); }
function canonKey_(key, cm) { key = String(key || ''); const m = cm || canonMap_(); return m[key] || key; }
function mapGeotabDevices(silent) {
  const devs = geoCall_('Get', { typeName: 'Device', resultsLimit: 5000 }) || [];
  const T = readTable_(S.VEH), I = idx_(H.VEH);
  const now = Date.now();
  const active = devs.filter(d => !d.activeTo || new Date(d.activeTo).getTime() > now);
  let mapped = 0; const missing = [];
  const rows = T.rows.map(r => {
    const key = String(r[I['Clé']]), vin = String(r[I['VIN']] || '').toUpperCase();
    const keys = [key].concat(platesOf_(r, I).map(normPlate_));
    const d = active.find(x => keys.indexOf(normPlate_(x.name)) >= 0 || keys.indexOf(normPlate_(x.licensePlate)) >= 0 ||
      (vin && String(x.vehicleIdentificationNumber || '').toUpperCase() === vin));
    if (d) { r[I['Geotab ID']] = d.id; r[I['Nom Geotab']] = d.name; mapped++; } else missing.push(r[I['Plaque']]);
    return r;
  });
  writeTable_(S.VEH, H.VEH, rows);
  memoClear_();
  log_('Association Geotab', mapped + ' associés' + (missing.length ? ', non trouvés : ' + missing.join(', ') : ''));
  if (silent !== true) toast_(mapped + ' véhicules associés à Geotab' + (missing.length ? ' (' + missing.length + ' non trouvés)' : ''), 'Geotab');
}
function vehicles_() {
  if (MEMO_.__veh) return MEMO_.__veh;
  const T = readTable_(S.VEH), I = T.I, P = params_();
  const map = {};
  T.rows.forEach(r => {
    const key = String(r[I['Clé']] || ''); if (!key) return;
    const fuelTxt = String(r[I['Carburant']] || '').toUpperCase();
    const diesel = /GO|GAS ?OIL|GASOIL|DIESEL|GAZOIL/.test(fuelTxt);
    map[key] = {
      key, plate: String(r[I['Plaque']]), model: String(r[I['Modèle']] || ''), brand: String(r[I['Marque']] || ''),
      fuelType: diesel ? 'Gasoil' : 'Essence', price: diesel ? P.priceDiesel : P.priceGas,
      geoId: String(r[I['Geotab ID']] || ''), geoName: String(r[I['Nom Geotab']] || ''),
      tank: num_(r[I['Réservoir (L)']], 0), ref: num_(r[I['Conso réf (L/100)']], 0), revenue: num_(r[I['Recette/contrat (MAD)']], 0),
      active: String(r[I['Actif']] || 'OUI').toUpperCase() !== 'NON',
      aliases: String(r[I['Autres plaques']] || '').split(/[,;]\s*/).filter(Boolean)
    };
  });
  return (MEMO_.__veh = map);
}

// ============================================================================
// 6. INJECTION DES CONTRATS (xlsx) ET CHAUFFEURS
// ============================================================================
function openInjectDialog() {
  const html = HtmlService.createHtmlOutput(
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>' +
    '<div style="font-family:Arial;font-size:13px">' +
    '<p>Sélectionnez l\'extract des contrats (.xlsx, .xls ou .csv). Les doublons sont ignorés, les contrats modifiés sont mis à jour.</p>' +
    '<input type="file" id="f" accept=".xlsx,.xls,.csv"><br><br>' +
    '<button id="b" onclick="go()" style="background:#1F3864;color:#fff;border:0;padding:8px 16px;border-radius:6px">Injecter</button>' +
    '<pre id="s" style="white-space:pre-wrap;color:#333"></pre></div>' +
    '<script>function st(t){document.getElementById("s").innerText=t;}' +
    'function go(){var f=document.getElementById("f").files[0];if(!f){st("Choisissez un fichier.");return;}' +
    'document.getElementById("b").disabled=true;st("Lecture du fichier...");var r=new FileReader();' +
    'r.onload=function(e){try{var wb=XLSX.read(new Uint8Array(e.target.result),{type:"array"});' +
    'var ws=wb.Sheets[wb.SheetNames[0]];var rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:"",dateNF:"dd/mm/yyyy hh:mm"});' +
    'st("Injection de "+(rows.length-1)+" lignes...");' +
    'google.script.run.withSuccessHandler(function(m){st(m);document.getElementById("b").disabled=false;})' +
    '.withFailureHandler(function(er){st("Erreur : "+er.message);document.getElementById("b").disabled=false;})' +
    '.injectContractsFromDialog(rows);}catch(x){st("Erreur lecture : "+x.message);}};r.readAsArrayBuffer(f);}</script>'
  ).setWidth(460).setHeight(330);
  SpreadsheetApp.getUi().showModalDialog(html, 'Injecter des contrats');
}

/** Appelé par la boîte de dialogue. rows = tableau 2D avec en-têtes. */
function injectContractsFromDialog(rows) {
  const t0 = Date.now();
  const res = injectContracts_(rows);
  const dr = refreshDrivers_();
  let msg = 'Contrats lus : ' + res.read + '\nNouveaux : ' + res.added + '\nMis à jour : ' + res.updated +
    '\nDoublons ignorés : ' + res.skipped + (res.invalid ? '\nLignes invalides : ' + res.invalid : '');
  if (dr.newDrivers.length) msg += '\n\nNOUVEAUX CHAUFFEURS (' + dr.newDrivers.length + ') :\n' + dr.newDrivers.join('\n');
  if (dr.dupes.length) msg += '\n\nDoublons de nom possibles :\n' + dr.dupes.join('\n');
  try {
    // v6 : tout le reste est automatique (données Geotab, chauffeurs, journalier, alertes, onglets)
    const from = res.minStart ? localDay_(res.minStart) : '';
    if (res.unknown && res.unknown.length) msg += '\n\nPLAQUES NON RECONNUES (absentes de VEHICULES) (' + res.unknown.length + ') : ' + res.unknown.join(', ') +
      '\n→ Si c\'est une nouvelle plaque d\'un véhicule existant, ajoutez-la dans l\'onglet ' + S.PLATES + ' (ancienne plaque / plaque définitive) : les contrats seront rattachés automatiquement.';
    if (from) {
      const done = withLock_('Calcul après injection', () => afterInject_(from), true);
      if (done) msg += '\n\nCalcul automatique terminé : ' + (done.length ? done.join(', ') + '. ' : '') + 'Tableau de bord et Du jour à jour, les autres onglets dans 1 à 2 minutes.';
      else {
        const props = PropertiesService.getScriptProperties(), cur = props.getProperty('INJECT_PENDING');
        if (!cur || from < cur) props.setProperty('INJECT_PENDING', from);
        msg += '\n\nUne collecte Geotab est en cours : le calcul se fera automatiquement dans les 5 minutes, rien d\'autre à faire.';
      }
    }
  } catch (e) { msg += '\n\nRecalcul : ' + e.message; }
  log_('Injection contrats', msg.replace(/\n/g, ' | '), t0);
  return msg + '\n\nTerminé. Vous pouvez fermer.';
}

function injectContracts_(rows) {
  if (!rows || rows.length < 2) throw new Error('Fichier vide.');
  // Trouve la ligne d'en-tête (celle qui contient "contrat")
  let hr = rows.findIndex(r => r.some(c => /num.*contrat/.test(normTxt_(c))));
  if (hr < 0) hr = 0;
  const head = rows[hr].map(normTxt_);
  const col = (re) => head.findIndex(h => re.test(h));
  const c = {
    num: col(/num.*contrat/), code: col(/code client/), nom: col(/nom du client|^client|chauffeur/),
    plate: col(/^immatriculation$/), plateTmp: col(/immatriculation temp/),
    depEff: col(/depart effectif/), retEff: col(/retour effectif/), dep: col(/date de depart/), ret: col(/date de retour/),
    statut: col(/statut/), origine: col(/origine/), tel: col(/telephone/), mail: col(/e-?mail/),
    comment: col(/commentaire/), model: col(/modele/)
  };
  if (c.num < 0 || c.plate < 0) throw new Error('Colonnes "Numéro de contrat" ou "Immatriculation" introuvables.');
  const g = (r, k) => c[k] >= 0 ? String(r[c[k]] == null ? '' : r[c[k]]).trim() : '';
  const T = readTable_(S.CTR), I = idx_(H.CTR), cm = canonMap_();
  const existing = {}; T.rows.forEach(r => { existing[String(r[I['N° contrat']])] = r; });
  const now = new Date();
  const out = [], seen = {};
  let added = 0, updated = 0, skipped = 0, invalid = 0, read = 0; const oldStarts = [];
  rows.slice(hr + 1).forEach(r => {
    const num = g(r, 'num'); if (!num) return;
    read++;
    if (seen[num]) { skipped++; return; }
    seen[num] = true;
    const plate = (g(r, 'plate') || g(r, 'plateTmp')).toUpperCase().replace(/\s+/g, '');
    const start = parseLocalDT_(g(r, 'depEff')) || parseLocalDT_(g(r, 'dep'));
    if (!plate || !start) { invalid++; return; }
    const statut = g(r, 'statut');
    let end = parseLocalDT_(g(r, 'retEff'));
    if (!end && !/cours/i.test(statut)) { const d = parseLocalDT_(g(r, 'ret')); if (d) end = new Date(dayBounds_(localDay_(d)).end.getTime() - 1); }
    const row = [num, g(r, 'code') || ('N-' + normTxt_(g(r, 'nom')).replace(/[^a-z]/g, '').slice(0, 12)), g(r, 'nom'), plate, canonKey_(normPlate_(plate), cm),
      g(r, 'model'), start, end || '', statut, g(r, 'origine'), g(r, 'tel').replace(/^'/, ''), g(r, 'mail'), g(r, 'comment'), now, now];
    const old = existing[num];
    if (old) {
      const sig = x => [x[1], x[2], x[4], toDate_(x[6]) ? toDate_(x[6]).getTime() : '', toDate_(x[7]) ? toDate_(x[7]).getTime() : '', x[8]].join('|');
      if (sig(old) === sig(row)) { skipped++; return; }
      row[I['Importé le']] = old[I['Importé le']] || now;
      const oa = toDate_(old[I['Début']]); if (oa) oldStarts.push(oa);
      updated++;
    } else added++;
    out.push(row);
  });
  upsert_(S.CTR, H.CTR, out);
  memoClear_();
  let minStart = null;
  out.map(r => toDate_(r[I['Début']])).concat(oldStarts).forEach(a => { if (a && (!minStart || a < minStart)) minStart = a; });
  // Tri : plus récent en haut
  const s = sh_(S.CTR);
  if (s.getLastRow() > 2) s.getRange(2, 1, s.getLastRow() - 1, H.CTR.length).sort({ column: I['Début'] + 1, ascending: false });
  const veh = vehicles_(), unknown = [];
  out.forEach(r => { const k = String(r[I['Clé plaque']]); if (!veh[k] && unknown.indexOf(r[I['Plaque']]) < 0) unknown.push(r[I['Plaque']]); });
  return { read, added, updated, skipped, invalid, minStart, unknown };
}

/** Reconstruit la liste des chauffeurs depuis les contrats et détecte les nouveaux. */
function refreshDrivers_() {
  const C = readTable_(S.CTR), IC = idx_(H.CTR);
  const D = readTable_(S.DRV), ID = idx_(H.DRV);
  const old = {}; D.rows.forEach(r => { old[String(r[ID['Code']])] = r; });
  const by = {};
  C.rows.forEach(r => {
    const code = String(r[IC['Code client']] || ''); if (!code) return;
    const st = toDate_(r[IC['Début']]); if (!st) return;
    const o = by[code] || (by[code] = { code, names: {}, last: null, first: null, n: 0, tel: '', mail: '', lastName: '' });
    o.n++;
    const nm = String(r[IC['Nom']] || '').trim();
    o.names[nm] = (o.names[nm] || 0) + 1;
    if (!o.first || st < o.first) o.first = st;
    if (!o.last || st >= o.last) { o.last = st; o.lastName = nm; o.tel = String(r[IC['Téléphone']] || ''); o.mail = String(r[IC['Email']] || ''); }
  });
  const now = new Date(), newDrivers = [], dupes = [];
  const rows = Object.values(by).map(o => {
    const prev = old[o.code];
    const others = Object.keys(o.names).filter(n => n && n !== o.lastName);
    let statut = prev ? prev[ID['Statut']] : 'NOUVEAU';
    const detected = prev ? prev[ID['Détecté le']] : now;
    if (!prev) newDrivers.push(o.lastName + ' (' + o.code + ')');
    if (statut === 'NOUVEAU' && toDate_(detected) && now - toDate_(detected) > 7 * DAY) statut = 'ACTIF';
    return [o.code, o.lastName, others.join(' / '), o.tel.replace(/^'/, ''), o.mail, o.first, o.last, o.n,
      statut || 'ACTIF', detected, prev ? prev[ID['Note']] : ''];
  });
  // Doublons possibles : même nom normalisé, codes différents
  const byName = {};
  rows.forEach(r => { const k = normTxt_(r[1]).replace(/[^a-z]/g, ''); (byName[k] = byName[k] || []).push(r[0]); });
  Object.keys(byName).forEach(k => { if (byName[k].length > 1) dupes.push(byName[k].join(' = ')); });
  rows.forEach(r => {
    const k = normTxt_(r[1]).replace(/[^a-z]/g, '');
    if (byName[k].length > 1 && !String(r[10]).includes('Doublon')) r[10] = (r[10] ? r[10] + ' | ' : '') + 'Doublon possible : ' + byName[k].join(', ');
  });
  rows.sort((a, b) => (b[6] ? b[6].getTime() : 0) - (a[6] ? a[6].getTime() : 0));
  writeTable_(S.DRV, H.DRV, rows);
  if (newDrivers.length) toast_(newDrivers.join(', '), newDrivers.length + ' nouveau(x) chauffeur(s)', 10);
  return { newDrivers, dupes };
}

/** Index contrats par véhicule pour rattacher trajets / événements aux chauffeurs. */
/**
 * Index des contrats par véhicule (rattachement des trajets aux chauffeurs). Mémorisé pour l'exécution.
 * Seuls les contrats des données conservées (+ 45 jours) sont chargés en entier ; le premier contrat connu de chaque
 * véhicule (__first) et la dernière information de l'extract (__range) viennent de tout l'historique.
 */
function contractIndex_() {
  if (MEMO_.__cidx) return MEMO_.__cidx;
  const map = {}, now = Date.now(), cm = canonMap_(), first = {}, s = sh_(S.CTR), P = params_();
  Object.defineProperty(map, '__range', { value: null, writable: true, enumerable: false });
  Object.defineProperty(map, '__first', { value: first, writable: true, enumerable: false });
  if (!s || s.getLastRow() < 2) return (MEMO_.__cidx = map);
  const I = idx_(H.CTR), n = s.getLastRow() - 1, since = now - ((P.retentionDays || 62) + 45) * DAY;
  const kc = s.getRange(2, I['Clé plaque'] + 1, n, 1).getValues(), dc = s.getRange(2, I['Début'] + 1, n, 1).getValues();
  let last = -1;
  for (let i = 0; i < n; i++) {
    const st = toDate_(dc[i][0]); if (!st) continue;
    const key = canonKey_(kc[i][0], cm); if (!key) continue;
    if (first[key] === undefined || st.getTime() < first[key]) first[key] = st.getTime();
    if (st.getTime() >= since) last = i;
  }
  if (last >= 0) {
    const w = Math.max(I['N° contrat'], I['Code client'], I['Nom'], I['Clé plaque'], I['Début'], I['Fin']) + 1;
    s.getRange(2, 1, last + 1, w).getValues().forEach(r => {
      const st = toDate_(r[I['Début']]); if (!st || st.getTime() < since) return;
      const key = canonKey_(r[I['Clé plaque']], cm); if (!key) return;
      const en = toDate_(r[I['Fin']]);
      (map[key] = map[key] || []).push({ start: st.getTime(), end: en ? en.getTime() : now + HOUR, open: !en,
        code: String(r[I['Code client']]), nom: String(r[I['Nom']]), num: String(r[I['N° contrat']]) });
    });
  }
  Object.keys(map).forEach(k => map[k].sort((a, b) => a.start - b.start));
  return (MEMO_.__cidx = map);
}
function findContract_(cidx, key, t, tolMs) {
  const a = cidx[key] || []; let best = null;
  for (const c of a) if (t >= c.start && t <= c.end) best = c;
  if (best) return best;
  let bd = Infinity;
  for (const c of a) {
    const d = t < c.start ? c.start - t : (t > c.end ? t - c.end : 0);
    if (d <= tolMs && d < bd) { bd = d; best = c; }
  }
  return best;
}
function attrib_(cidx, key, t, tolMs) {
  const c = findContract_(cidx, key, t, tolMs);
  if (c) return { code: c.code, nom: c.nom, num: c.num };
  // Avant le premier contrat connu ou après la dernière information de l'extract : personne n'est mis en cause
  if (!cidx.__range) { let hi = 0; Object.keys(cidx).forEach(k => cidx[k].forEach(x => { hi = Math.max(hi, x.start, x.open ? 0 : x.end); })); cidx.__range = [0, hi]; }
  const f0 = (cidx[key] || [])[0], first = cidx.__first && cidx.__first[key] !== undefined ? cidx.__first[key] : (f0 ? f0.start : null);
  // Avant le premier contrat connu de CE véhicule (contrat démarré avant l'extract) ou après la dernière info de l'extract
  if (first === null || t < first - tolMs || t > cidx.__range[1] + tolMs) return { code: HORS, nom: HORS_PERIODE, num: '' };
  return { code: HORS, nom: 'Hors contrat', num: '' };
}
const HORS_PERIODE = 'Hors période des contrats';

// ============================================================================
// 7. RÈGLES GEOTAB ET POIDS DE DANGER
// ============================================================================
/** Catégorie d'une règle Geotab. Seules les catégories de CONDUITE comptent dans le score de danger. */
function ruleCategory_(name) {
  const n = normTxt_(name);
  if (/debranch|unplug|tamper|alimentation du boitier|perte d.alimentation|deconnexion/.test(n)) return 'Boîtier';
  if (/odo|notification|myclicar|rapport|report|etat de parc|zone|entree|entre en|pays|port\b|fourriere|vol\b|vole|antidemarr|immobili|continuous|tow|battery|batterie|tire|pneu|esr|intramuros|72h|72 ?heures/.test(n)) return 'Hors conduite';
  if (/collision|accident|crash/.test(n)) return 'Collision';
  if (/vitesse|speed/.test(n)) return 'Vitesse';
  if (/ceinture|seat ?belt/.test(n)) return 'Ceinture';
  if (/frein|brak/.test(n)) return 'Freinage';
  if (/accel|jackrabbit/.test(n)) return 'Accélération';
  if (/virage|corner/.test(n)) return 'Virage';
  if (/ralenti|idl/.test(n)) return 'Ralenti';
  if (/fault|defaut|moteur|engine|panne/.test(n)) return 'Moteur';
  return 'Hors conduite';
}
const RULE_W = { 'Collision': 10, 'Vitesse': 3, 'Ceinture': 3, 'Freinage': 2, 'Accélération': 2, 'Virage': 1.5 };
/**
 * Poids par défaut. Geotab a souvent 2 versions d'une même règle (ex. « Speeding » et « Speeding (New) »,
 * « Hard Acceleration » et « Harsh Acceleration (New) ») qui se déclenchent sur le même évènement :
 * une seule est comptée, la plus récente « (New) ».
 */
function defaultWeight_(name, allNames) {
  if (/^Règle inconnue/.test(name)) return [0, 'Hors conduite', 'Règle non lisible avec ce compte Geotab (non comptée)'];
  const cat = ruleCategory_(name), w = RULE_W[cat] || 0;
  if (!w) return [0, cat, cat === 'Hors conduite' ? 'Règle hors conduite (non comptée)' : 'Non comptée dans le score'];
  const isNew = /\((new|nouveau)\)/i.test(name);
  if (cat !== 'Collision' && !isNew && allNames.some(o => o !== name && ruleCategory_(o) === cat && /\((new|nouveau)\)/i.test(o)))
    return [0, cat, 'Doublon : la version (New) de cette règle est comptée'];
  return [w, cat, ''];
}
function syncRules_() {
  const list = geoCall_('Get', { typeName: 'Rule' }) || [];
  // Règles présentes dans les événements mais absentes de la liste (autre groupe, règle système) : on cherche leur nom
  const known = {}; list.forEach(r => { known[r.id] = 1; });
  const E = readData_(S.EVT, addDays_(localDay_(new Date()), -7)), IE0 = idx_(H.EVT), miss = {};
  E.rows.forEach(r => { const id = String(r[IE0['Règle ID']] || ''); if (id && !known[id]) miss[id] = 1; });
  Object.keys(miss).slice(0, 50).forEach(id => {
    let name = '';
    try { const g = geoCall_('Get', { typeName: 'Rule', search: { id: id } }) || []; name = g[0] && g[0].name; } catch (e) { }
    list.push({ id: id, name: name || ('Règle inconnue ' + id) });
  });
  const T = readTable_(S.RULE), I = idx_(H.RULE), props = PropertiesService.getScriptProperties();
  const reset = !props.getProperty('RULES_V6');   // V6 : nouveaux poids (conduite uniquement, sans doublons)
  const old = {}; T.rows.forEach(r => { old[String(r[I['Règle ID']])] = r; });
  const names = list.map(r => r.name || '');
  const rows = list.map(r => {
    const o = old[r.id], d = defaultWeight_(r.name, names);
    if (o && !reset) { o[I['Règle']] = r.name; o[I['Catégorie']] = d[1]; return o; }
    return [r.id, r.name, d[0], d[1], o ? o[I['Événements (total)']] : 0, d[2]];
  });
  T.rows.forEach(r => { if (!list.find(x => x.id === r[I['Règle ID']])) rows.push(r); });
  rows.sort((a, b) => (b[2] > 0) - (a[2] > 0) || String(a[3]).localeCompare(String(b[3])) || String(a[1]).localeCompare(String(b[1])));
  writeTable_(S.RULE, H.RULE, rows);
  if (reset) props.setProperty('RULES_V6', '1');
  memoClear_();
}
function rulesMap_() {
  if (MEMO_.__rules) return MEMO_.__rules;
  const T = readTable_(S.RULE), I = idx_(H.RULE), m = {};
  T.rows.forEach(r => { m[String(r[I['Règle ID']])] = { name: String(r[I['Règle']]), w: num_(r[I['Poids danger']]), cat: String(r[I['Catégorie']]) }; });
  return (MEMO_.__rules = m);
}

// ============================================================================
// 8. SYNCHRONISATION GEOTAB (jour par jour, véhicule par véhicule)
// ============================================================================
function syncToday() { syncNow(); }
function syncYesterday() {
  const d = addDays_(localDay_(new Date()), -1);
  if (dayBounds_(d).end.getTime() + 12 * HOUR > Date.now()) { syncNow(); return; }   // pas encore finalisable : temps réel
  queueSync_([d], true);
}
function syncPeriod() {
  const ui = ui_();
  const r = ui.prompt('Synchroniser une période', 'Dates au format jj/mm/aaaa - jj/mm/aaaa (ex. 28/09/2026 - 05/10/2026)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const m = r.getResponseText().match(/(\d{1,2}\/\d{1,2}\/\d{2,4}).*?(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!m) { ui.alert('Format non reconnu.'); return; }
  let a = toDayStr_(m[1]), b = toDayStr_(m[2]);
  if (a > b) { const t = a; a = b; b = t; }
  const days = []; for (let d = a; d <= b; d = addDays_(d, 1)) days.push(d);
  checkEngine_();
  const done = doneVehDays_(), list = Object.values(vehicles_()).filter(v => v.active && v.geoId);
  let nDone = 0; days.forEach(d => list.forEach(v => { if (done[v.key + '|' + d]) nDone++; }));
  let skip = null;
  if (nDone) {
    const r2 = ui.alert('Synchroniser une période', nDone + ' véhicule-jours sur ' + days.length * list.length + ' sont déjà synchronisés et complets avec la version actuelle du calcul.\n\n' +
      'OUI = les ignorer (beaucoup plus rapide)\nNON = tout retélécharger depuis Geotab', ui.ButtonSet.YES_NO_CANCEL);
    if (r2 === ui.Button.CANCEL || r2 === ui.Button.CLOSE) return;
    if (r2 === ui.Button.YES) skip = done;
  }
  queueSync_(days, true, skip);
}
/** Version du moteur : à chaque changement de version, les jours calculés avant ne comptent plus comme « à jour » */
function checkEngine_() {
  const props = PropertiesService.getScriptProperties(), cur = props.getProperty('ENGINE_V');
  if (cur === ENGINE_V) return;
  if (cur) props.setProperty('ENGINE_SINCE', String(Date.now()));   // 1re installation : les jours déjà calculés par le moteur V5 restent valables
  props.setProperty('ENGINE_V', ENGINE_V);
}
/** Véhicule-jours complets : synchronisés après la fin de la fenêtre d'analyse (fin de journée + 12 h) avec le moteur actuel */
function doneVehDays_() {
  if (MEMO_.__done) return MEMO_.__done;
  const since = +(PropertiesService.getScriptProperties().getProperty('ENGINE_SINCE') || 0);
  const T = readTable_(S.SYNC), I = idx_(H.SYNC), o = {};
  T.rows.forEach(r => {
    const key = String(r[I['Clé']] || ''), d = key.split('|')[1], t = toDate_(r[I['Synchronisé le']]);
    if (!d || !t || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (t.getTime() >= since && t.getTime() >= dayBounds_(d).end.getTime() + 12 * HOUR) o[key] = 1;
  });
  return (MEMO_.__done = o);
}
/** Plus ancienne date de synchro par jour (tous véhicules) */
function syncState_() {
  const T = readTable_(S.SYNC), I = idx_(H.SYNC), o = {};
  T.rows.forEach(r => {
    const d = toDayStr_(r[I['Date']]), t = toDate_(r[I['Synchronisé le']]);
    if (!d || !t) return;
    o[d] = o[d] === undefined ? t.getTime() : Math.min(o[d], t.getTime());
  });
  return o;
}
function queueSync_(days, interactive, skip) {
  const veh = vehicles_();
  const list = Object.values(veh).filter(v => v.active && v.geoId);
  if (!list.length) {
    const msg = 'Aucun véhicule associé à Geotab. Lancez "Associer véhicules Geotab".';
    if (interactive && ui_()) ui_().alert(msg); else log_('Synchro', msg);
    return;
  }
  // Journées pas encore terminées depuis 12 h : calculées par le temps réel (collecte toutes les 5 min), pas par la file
  const nowMs = Date.now(), liveDays = days.filter(d => dayBounds_(d).end.getTime() + 12 * HOUR > nowMs);
  days = days.filter(d => liveDays.indexOf(d) < 0);
  if (liveDays.length && interactive) toast_(liveDays.map(fmtDay_).join(', ') + ' : couvert par le temps réel (bouton SYNCHRO GEOTAB pour forcer la mise à jour).', 'Synchro Geotab', 8);
  const q = [];
  days.forEach(d => list.forEach(v => { if (!skip || !skip[v.key + '|' + d]) q.push({ d, k: v.key }); }));
  if (!q.length) { const m = 'Tout est déjà synchronisé sur cette période. Cliquez sur TOUT ACTUALISER pour recalculer les tableaux.'; if (interactive && ui_()) ui_().alert(m); else log_('Synchro', m); return; }
  const props = PropertiesService.getScriptProperties();
  const cur = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]');
  const seen = {}; const merged = [];
  cur.concat(q).forEach(x => { const id = x.d + '|' + x.k; if (!seen[id]) { seen[id] = 1; merged.push(x); } });
  props.setProperty('SYNC_QUEUE', JSON.stringify(merged));
  if (interactive) { const eta = etaMin_(merged.length); toast_(merged.length + ' véhicule-jours à synchroniser' + (eta ? ', environ ' + eta + ' min' : '') + '. Avancement dans l\'onglet LOG.', 'Synchro Geotab', 10); }
  runSyncQueue();
}
/**
 * Un seul paquet de synchro à la fois : verrou Google + « bail » enregistré dans les propriétés
 * (le verrou seul ne suffit pas quand une exécution dure longtemps). Un paquet bloqué reprogramme la suite.
 */
const LEASE_MS = 35 * 60 * 1000;
let HOLDS_LOCK_ = false;
function syncLease_() {
  const l = JSON.parse(PropertiesService.getScriptProperties().getProperty('SYNC_LEASE') || 'null');
  return l && l.until > Date.now() ? l : null;
}
function ensureSyncTrigger_(delayMs) {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'runSyncQueue')) return;
  ScriptApp.newTrigger('runSyncQueue').timeBased().after(Math.max(60 * 1000, delayMs || 0)).create();
}
/** Exécute fn seulement si aucune synchro n'écrit dans les données en ce moment (sinon message et report) */
function withLock_(label, fn, quiet) {
  if (HOLDS_LOCK_) return fn();
  const lock = LockService.getScriptLock();
  const busy = () => {
    const n = JSON.parse(PropertiesService.getScriptProperties().getProperty('SYNC_QUEUE') || '[]').length;
    const m = 'Synchro Geotab en cours' + (n ? ' (' + n + ' véhicule-jours restants)' : '') + ' : « ' + label + ' » est reporté. ' +
      'Tout est recalculé automatiquement à la fin de la synchro. Vous pouvez aussi réessayer dans 1 à 2 minutes.';
    PropertiesService.getScriptProperties().setProperty('AFTER_SYNC_REFRESH', '1');
    log_(label, m); if (!quiet) toast_(m, 'Flotte Geotab', 10);
    return null;
  };
  if (!lock.tryLock(30000)) return busy();
  if (syncLease_()) { lock.releaseLock(); return busy(); }
  HOLDS_LOCK_ = true;
  try { return fn(); } finally { HOLDS_LOCK_ = false; lock.releaseLock(); }
}
/** Tant que la mise à jour v6 n'est pas terminée, les traitements de fond attendent (reprise automatique) */
function waitMigration_(fn) {
  if (PropertiesService.getScriptProperties().getProperty('SCHEMA_V') === SCHEMA_V) return false;
  clearTriggers_(fn); ScriptApp.newTrigger(fn).timeBased().after(2 * 60 * 1000).create();
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'migrateV6')) ScriptApp.newTrigger('migrateV6').timeBased().after(60 * 1000).create();
  return true;
}
function runSyncQueue() {
  if (waitMigration_('runSyncQueue')) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { ensureSyncTrigger_(); log_('Synchro', 'Un traitement est en cours, la synchro reprend automatiquement'); return; }
  const props = PropertiesService.getScriptProperties();
  const other = syncLease_();
  if (other) { lock.releaseLock(); ensureSyncTrigger_(Math.min(other.until - Date.now() + 30000, 5 * 60 * 1000)); log_('Synchro', 'Un autre paquet est en cours, reprise automatique'); return; }
  HOLDS_LOCK_ = true;
  const t0 = Date.now();
  try {
    clearTriggers_('runSyncQueue');
    const r = syncQueueStep_(t0, MAX_RUN_MS);
    if (r.stop) return;
    if (r.left) {
      ScriptApp.newTrigger('runSyncQueue').timeBased().after(60 * 1000).create();
      const eta = etaMin_(r.left);
      log_('Synchro', r.done + ' traités, ' + r.left + ' restants' + (eta ? ' (environ ' + eta + ' min)' : '') + ', reprise auto dans 1 min' + r.tm + (r.warn.length ? ' | ' + r.warn.join(' ; ') : ''), t0);
      toast_(r.left + ' restants' + (eta ? ', environ ' + eta + ' min' : '') + '. Reprise automatique dans 1 minute.', 'Synchro Geotab');
      return;
    }
    // File terminée : journalier, alertes et tableaux légers mis à jour (les autres onglets suivent par étapes)
    const dirty = props.getProperty('DERIVED_DIRTY');
    if (dirty) { updateDerived_(dirty); props.deleteProperty('DERIVED_DIRTY'); }
    renderLight_();
    if (props.getProperty('AFTER_SYNC_REFRESH') === '1') { props.deleteProperty('AFTER_SYNC_REFRESH'); queueRender_(false); }
    log_('Synchro', r.done + ' véhicule-jours finalisés' + r.tm + (r.warn.length ? ' | ' + r.warn.join(' ; ') : ''), t0);
    toast_('Synchro terminée : ' + r.done + ' véhicule-jours' + (r.warn.length ? ' (' + r.warn.length + ' avertissements, voir LOG)' : ''), 'Synchro Geotab');
  } finally { HOLDS_LOCK_ = false; lock.releaseLock(); }
}
/**
 * Un paquet de la file de synchro (journées complètes) : téléchargement, calcul, ajout en bas des DATA_*.
 * Appelé par runSyncQueue et par le collecteur. Retourne {done, left, warn, tm, stop}.
 */
function syncQueueStep_(t0, budgetMs) {
  const props = PropertiesService.getScriptProperties();
  const me = String(Date.now()) + Math.random().toString(36).slice(2, 7);
  const lease = () => props.setProperty('SYNC_LEASE', JSON.stringify({ id: me, until: Date.now() + LEASE_MS }));
  lease();
  try {
    checkEngine_();
    let q = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]');
    // Les journées pas encore terminées depuis 12 h sont couvertes par le temps réel, pas par la file
    const nowMs = Date.now(); q = q.filter(x => dayBounds_(x.d).end.getTime() + 12 * HOUR <= nowMs);
    if (!q.length) { props.setProperty('SYNC_QUEUE', '[]'); return { done: 0, left: 0, warn: [], tm: '' }; }
    const handled = {};
    const P = params_(), veh = vehicles_();
    try { syncRules_(); } catch (e) { log_('Règles', e.message); }
    const acc = newAcc_();
    let done = 0, lastBatch = 0, failed = false;
    const flushEst = Math.min(+(props.getProperty('SYNC_FLUSH_MS') || 30000), 90000);
    let nBatch = 0;
    while (q.length && (nBatch++ === 0 || Date.now() - t0 + Math.max(60000, 1.3 * lastBatch) + flushEst < budgetMs)) {
      const tb = takeBatch_(q, veh), tb0 = Date.now();
      const kept = {}; tb.rest.forEach(x => { kept[x.d + '|' + x.k] = 1; });
      if (!tb.blocks.length) { q.forEach(x => { if (!kept[x.d + '|' + x.k]) handled[x.d + '|' + x.k] = 1; }); q = tb.rest; break; }
      let r;
      try { r = syncBlocks_(tb.blocks, P, acc); }
      catch (e) { acc.warn.push('Téléchargement Geotab : ' + e.message); failed = true; break; }
      const again = {}; r.retry.concat(r.later).forEach(x => { again[x.d + '|' + x.k] = 1; });
      q.forEach(x => { const id = x.d + '|' + x.k; if (!kept[id] && !again[id]) handled[id] = 1; });
      q = r.retry.concat(tb.rest).concat(r.later);
      done += r.done; lastBatch = Date.now() - tb0;
      lease();
      if (r.limited) { acc.warn.push('Limite d\'appels Geotab atteinte : reprise dans 1 min'); break; }
    }
    const f0 = Date.now();
    flush_(acc);
    if (acc.days.length) {
      props.setProperty('SYNC_FLUSH_MS', String(Date.now() - f0));
      markDirty_(acc.days.map(id => id.split('|')[1]).sort()[0]);
    }
    acc.warn = acc.warn.filter((w, i, a) => a.indexOf(w) === i);
    const stored = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]'), seen = {};
    q = q.concat(stored).filter(x => { const id = x.d + '|' + x.k; if (handled[id] || seen[id]) return false; seen[id] = 1; return true; });
    props.setProperty('SYNC_QUEUE', JSON.stringify(q));
    const fails = failed ? +(props.getProperty('SYNC_FAILS') || 0) + 1 : 0;
    props.setProperty('SYNC_FAILS', String(fails));
    if (done >= 4) {
      const old = +(props.getProperty('SYNC_RATE') || 0), now = (Date.now() - t0) / done;
      props.setProperty('SYNC_RATE', String(old ? 0.6 * old + 0.4 * now : now));
    }
    const tm = acc.tm ? ' [Geotab ' + Math.round(acc.tm.dl / 1000) + ' s, calcul ' + Math.round(acc.tm.calc / 1000) + ' s, écriture ' + Math.round((Date.now() - f0) / 1000) + ' s]' : '';
    if (q.length && fails >= 3) {
      log_('Synchro', 'Arrêt après 3 échecs de suite, ' + q.length + ' véhicule-jours en attente. Vérifiez la connexion Geotab. ' + acc.warn.join(' ; '), t0);
      props.setProperty('SYNC_QUEUE', '[]'); props.setProperty('SYNC_FAILS', '0');
      return { done, left: 0, warn: acc.warn, tm, stop: true };
    }
    return { done, left: q.length, warn: acc.warn, tm };
  } finally {
    const l = JSON.parse(props.getProperty('SYNC_LEASE') || 'null');
    if (l && l.id === me) props.deleteProperty('SYNC_LEASE');
  }
}
/**
 * Contrôle d'intégrité des données Geotab :
 *  - doublons (même identifiant) supprimés, la dernière version est gardée ;
 *  - pour chaque véhicule-jour synchronisé, le nombre de trajets et d'événements présents doit être celui calculé à la synchro.
 * Retourne { dup, bad: ['plaque|jour', ...] }.
 */
function repairData_() {
  const out = { dup: 0, bad: [] };
  [S.TRIP, S.EVT, S.FUEL, S.IDL, S.LVL].forEach(name => {
    const T = readTable_(name), seen = {}, rows = [];
    for (let i = T.rows.length - 1; i >= 0; i--) { const id = String(T.rows[i][0]); if (id && seen[id]) { out.dup++; continue; } seen[id] = 1; rows.push(T.rows[i]); }
    if (rows.length < T.rows.length) writeTable_(name, H[keyOfSheet_(name)], rows.reverse());
  });
  const count = (name, timeCol) => {
    const T = readTable_(name), I = idx_(H[keyOfSheet_(name)]), c = {};
    T.rows.forEach(r => { const t = toDate_(r[I[timeCol]]); if (t) { const id = String(r[I['Clé plaque']]) + '|' + localDay_(t); c[id] = (c[id] || 0) + 1; } });
    return c;
  };
  const ct = count(S.TRIP, 'Début'), ce = count(S.EVT, 'Début');
  const Sy = readTable_(S.SYNC), IS = idx_(H.SYNC), synced = {};
  Sy.rows.forEach(r => {
    const id = String(r[IS['Clé']]); if (!id || id.indexOf('|') < 0) return;
    synced[id] = 1;
    if ((ct[id] || 0) !== num_(r[IS['Trajets']]) || (ce[id] || 0) !== num_(r[IS['Événements']])) out.bad.push(id);
  });
  out.missing = missingContractDays_(synced);
  return out;
}
/**
 * Journées où un chauffeur avait un contrat sur un véhicule relié à Geotab mais qui n'ont jamais été téléchargées
 * (sinon ce chauffeur apparaîtrait à 0 alors qu'il a travaillé). Retourne ['plaque|jour', ...].
 */
function missingContractDays_(synced, sinceDay) {
  const veh = vehicles_(), C = readTable_(S.CTR), I = idx_(H.CTR), today = localDay_(new Date()), need = {}, cm = canonMap_();
  C.rows.forEach(r => {
    const key = canonKey_(r[I['Clé plaque']], cm), v = veh[key]; if (!v || !v.geoId || !v.active) return;
    const a = toDate_(r[I['Début']]); if (!a || (sinceDay && localDay_(a) < sinceDay)) return;
    const z = toDate_(r[I['Fin']]) || new Date(Math.min(Date.now(), a.getTime() + 16 * HOUR));
    for (let d = localDay_(a), last = localDay_(z), g = 0; d <= last && d <= today && g < 10; d = addDays_(d, 1), g++) need[key + '|' + d] = 1;
  });
  return Object.keys(need).filter(id => !synced[id]).sort();
}
/** Menu : vérifier les données et retélécharger ce qui est incomplet */
function verifierDonnees() {
  withLock_('Vérifier les données', () => {
    const t0 = Date.now(), chk = repairData_();
    let msg = 'Doublons supprimés : ' + chk.dup + '\nVéhicule-jours incomplets : ' + chk.bad.length +
      '\nJournées de contrat jamais téléchargées : ' + chk.missing.length + (chk.missing.length ? ' (ex. ' + chk.missing.slice(0, 3).join(', ') + ')' : '');
    chk.bad = chk.bad.concat(chk.missing);
    if (chk.bad.length) {
      const props = PropertiesService.getScriptProperties();
      props.deleteProperty('REPAIR_ROUND');
      const cur = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]'), seen = {};
      const q = cur.concat(chk.bad.map(id => ({ d: id.split('|')[1], k: id.split('|')[0], solo: 1 }))).filter(x => { const k = x.d + '|' + x.k; if (seen[k]) return false; seen[k] = 1; return true; });
      props.setProperty('SYNC_QUEUE', JSON.stringify(q));
      ensureSyncTrigger_();
      msg += '\n\nIls sont retéléchargés automatiquement (suivi dans LOG).';
    } else msg += '\n\nToutes les journées de contrat sont téléchargées et complètes.';
    log_('Vérifier les données', msg.replace(/\n/g, ' | '), t0);
    const u = ui_(); if (u) u.alert('Vérification des données', msg, u.ButtonSet.OK); else toast_(msg.replace(/\n/g, ' '), 'Vérification');
  });
}
function clearTriggers_(fn) { ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); }); }

// ============================================================================
// 8b. SOURCES DE MESURE : inventaire de ce que chaque boîtier remonte vraiment
// ============================================================================
function classifyDiag_(id, name) {
  const n = deacc_(String(id) + ' ' + String(name)).toLowerCase();
  const fuel = /fuel|carbur|gazole|gasoil|diesel/.test(n);
  if (id === 'DiagnosticFuelLevelId' || (fuel && /level|niveau|jauge|reservoir|tank/.test(n) && !/rate|debit|consom|used|utilise/.test(n))) return 'Jauge';
  if (id === 'DiagnosticEngineSpeedId' || /engine ?speed|\brpm\b|regime|vitesse (du|de) moteur|tr\/min|tours? par minute/.test(n)) return 'Régime moteur';
  if (fuel && /rate|debit/.test(n) && !/econom/.test(n)) return 'Débit carburant';
  if (fuel && /idl|ralenti/.test(n) && /total|used|consom|consum|quantite|utilise/.test(n)) return 'Carburant ralenti';
  if (fuel && /total|used|consom|consum|quantite|utilise/.test(n) && !/idl|ralenti|level|niveau|rate|debit|econom|trip|trajet|ratio|percent|pourcent/.test(n)) return 'Carburant total';
  return '';
}
/** Facteur de conversion vers litres (compteurs) ou L/h (débit). null = unité non reconnue : source non utilisée. */
function unitFactor_(unit, role) {
  const u = String(unit || '').toLowerCase();
  if (role === 'Débit carburant') {
    if (/hour|heure/.test(u)) return /gallon/.test(u) ? 3.785 : (/milli/.test(u) ? 0.001 : 1);
    if (/second/.test(u)) return 3600 * (/milli/.test(u) ? 0.001 : 1);
    if (/minute/.test(u)) return 60;
    return null;
  }
  if (role === 'Carburant total' || role === 'Carburant ralenti') {
    if (/gallon/.test(u)) return 3.785;
    if (/milli/.test(u)) return 0.001;
    if (!u || /lit/.test(u)) return 1;   // Geotab stocke les volumes en litres
    return null;
  }
  return 1;
}
/** Analyse, pour chaque véhicule, tous les diagnostics réellement remontés sur son dernier trajet. */
function analyzeSources(silent) {
  const t0 = Date.now(), now = Date.now();
  const veh = Object.values(vehicles_()).filter(v => v.active && v.geoId);
  const diagIds = {}, found = {};
  veh.forEach(v => {
    try {
      const ds = { id: v.geoId };
      const trips = geoCall_('Get', { typeName: 'Trip', search: { deviceSearch: ds, fromDate: iso_(now - 7 * DAY), toDate: iso_(now) } }) || [];
      const last = trips.sort((a, b) => new Date(b.stop) - new Date(a.stop))[0];
      if (!last) return;
      const b = new Date(last.stop).getTime(), a = b - 24 * HOUR;   // 24 h d'activité : capte aussi les mesures enregistrées rarement
      const sd = geoCall_('Get', { typeName: 'StatusData', search: { deviceSearch: ds, fromDate: iso_(a), toDate: iso_(b) }, resultsLimit: 50000 }) || [];
      const counts = {};
      sd.forEach(x => { const id = x.diagnostic && x.diagnostic.id ? x.diagnostic.id : x.diagnostic; if (id) { counts[id] = (counts[id] || 0) + 1; diagIds[id] = 1; } });
      let fae = 0;
      try { fae = (geoCall_('Get', { typeName: 'FuelAndEnergyUsed', search: { deviceSearch: ds, fromDate: iso_(now - 7 * DAY), toDate: iso_(now) } }) || []).length; } catch (e) { }
      found[v.key] = { v, counts, fae };
    } catch (e) { log_('Sources ' + v.plate, e.message); }
  });
  const ids = Object.keys(diagIds), info = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let res;
    try { res = geoMulti_(chunk.map(id => ({ method: 'Get', params: { typeName: 'Diagnostic', search: { id } } }))); }
    catch (e) { res = chunk.map(id => { try { return geoCall_('Get', { typeName: 'Diagnostic', search: { id } }); } catch (x) { return []; } }); }
    chunk.forEach((id, j) => {
      const d = (res[j] || [])[0] || {}, u = d.unitOfMeasure;
      info[id] = { name: d.name || id, unit: u ? (typeof u === 'string' ? u : (u.id || u.name || '')) : '' };
    });
  }
  const old = readTable_(S.SRC), IS = idx_(H.SRC), oldRole = {};
  old.rows.forEach(r => { oldRole[String(r[0])] = r[IS['Rôle']]; });
  const order = { 'Carburant total': 1, 'Carburant ralenti': 2, 'Débit carburant': 3, 'Régime moteur': 4, 'Jauge': 5, 'Bilan trajet': 6, '': 9, 'Ignorer': 9 };
  const rows = [];
  Object.values(found).forEach(f => {
    Object.keys(f.counts).forEach(id => {
      const inf = info[id] || { name: id, unit: '' }, key = f.v.key + '|' + id;
      const role = oldRole[key] !== undefined && oldRole[key] !== '' ? oldRole[key] : classifyDiag_(id, inf.name);
      rows.push([key, f.v.key, f.v.plate, id, inf.name, inf.unit, f.counts[id], role, new Date()]);
    });
    if (f.fae) { const key = f.v.key + '|FuelAndEnergyUsed';
      rows.push([key, f.v.key, f.v.plate, 'FuelAndEnergyUsed', 'Bilan carburant par trajet (Geotab)', 'L', f.fae, oldRole[key] || 'Bilan trajet', new Date()]); }
  });
  old.rows.forEach(r => { if (!found[String(r[1])]) rows.push(r); });
  // Priorité : compteur du calculateur moteur avant compteur calculé par le boîtier
  rows.sort((a, b) => String(a[2]).localeCompare(String(b[2])) || (order[a[7]] || 9) - (order[b[7]] || 9) ||
    (/Device/.test(a[3]) ? 1 : 0) - (/Device/.test(b[3]) ? 1 : 0) || b[6] - a[6]);
  writeTable_(S.SRC, H.SRC, rows);
  log_('Sources de mesure', Object.keys(found).length + ' véhicules analysés, ' + rows.length + ' diagnostics', t0);
  if (silent !== true) toast_(Object.keys(found).length + ' véhicules analysés. Détail dans ' + S.CTRL + '.', 'Sources Geotab', 8);
  return rows.length;
}
/** Rôles par véhicule, dans l'ordre de priorité de DATA_SOURCES (modifiable à la main). */
function srcMap_() {
  const T = readTable_(S.SRC), I = idx_(H.SRC), m = {};
  T.rows.forEach(r => {
    const k = String(r[I['Clé plaque']]), role = String(r[I['Rôle']] || ''), id = String(r[I['Diagnostic ID']]);
    const o = m[k] || (m[k] = { fuelTotal: [], idleFuel: [], rate: [], rpm: [], level: [], fae: false });
    if (role === 'Bilan trajet') { o.fae = true; return; }
    const f = unitFactor_(r[I['Unité']], role);
    if (f === null) return;
    if (role === 'Carburant total') o.fuelTotal.push({ id, f });
    if (role === 'Carburant ralenti') o.idleFuel.push({ id, f });
    if (role === 'Débit carburant') o.rate.push({ id, f });
    if (role === 'Régime moteur') o.rpm.push({ id, f: 1 });
    if (role === 'Jauge') o.level.push({ id, f: 1, n: num_(r[I['Lectures']]) });
  });
  return m;
}
/** Limite de vitesse OpenStreetMap au point donné (null si absente ou ambiguë). */
function parseSpeed_(s) { const m = String(s || '').trim().match(/^(\d+)\s*(mph)?$/); return m ? (m[2] ? Math.round(+m[1] * 1.609) : +m[1]) : null; }
function osmLimit_(lat, lon) {
  if (lat === '' || lon === '' || lat == null || lon == null) return null;
  const cache = CacheService.getScriptCache(), k = 'osm|' + (+lat).toFixed(4) + '|' + (+lon).toFixed(4);
  const c = cache.get(k); if (c !== null) return c === '' ? null : +c;
  osmLimit_.n = (osmLimit_.n || 0) + 1; if (osmLimit_.n > 80) return null;
  try {
    const q = '[out:json][timeout:10];way(around:25,' + lat + ',' + lon + ')[highway][maxspeed];out tags;';
    const r = UrlFetchApp.fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return null;
    const vals = (JSON.parse(r.getContentText()).elements || []).map(e => parseSpeed_(e.tags && e.tags.maxspeed)).filter(x => x);
    // Plusieurs routes avec des limites différentes (carrefour) : ambigu, donc pas de valeur
    const val = vals.length && vals.every(x => x === vals[0]) ? vals[0] : null;
    cache.put(k, val === null ? '' : String(val), 21600);
    return val;
  } catch (e) { return null; }
}

// ============================================================================
// 8a. MOTEUR DE MESURES V5 (validé sur les données réelles Geotab clicar)
// ============================================================================
// MOTEUR DE MESURES V5 (fonctions pures, identiques dans Apps Script et en test)
// Unité de base : le CYCLE CONTACT (contact mis -> contact coupé), lu sur le
// diagnostic Geotab DiagnosticIgnitionId. Toutes les mesures sont des capteurs :
//  - ralenti  = contact mis + régime moteur > seuil + vitesse < 2 km/h
//  - litres   = compteur carburant du boîtier, lu moteur coupé (valeur figée)
//  - contrôle = compteur du calculateur moteur (si remonté)
//  - ralenti L= compteur carburant au ralenti du boîtier
//  - limites  = GetRoadMaxSpeeds (valeur constante jusqu'au point suivant, -1 = inconnue)
// ============================================================================
const CORE_DIAGS = {
  ign: 'DiagnosticIgnitionId', rpm: 'DiagnosticEngineSpeedId', spd: 'DiagnosticEngineRoadSpeedId',
  fuel: 'DiagnosticDeviceTotalFuelId', ecu: 'DiagnosticTotalFuelUsedId', idleFuel: 'DiagnosticDeviceTotalIdleFuelId',
  lvlL: 'DiagnosticFuelUnitsId', lvlPct: 'DiagnosticFuelLevelId', odo: 'DiagnosticOdometerId'
};
const C_MIN = 60000, C_HOUR = 3600000;

/** StatusData -> [{t,v}] trié, sans doublons, sans les points artificiels posés aux bornes de la requête */
function cSeries_(raw, from, to) {
  const m = {};
  (raw || []).forEach(x => {
    const t = new Date(x.dateTime).getTime(), v = +x.data;
    if (isNaN(t) || !isFinite(v)) return;
    if (t === from || t === to) return;            // Geotab ajoute une valeur aux bornes de la fenêtre
    m[t] = v;
  });
  return Object.keys(m).map(Number).sort((a, b) => a - b).map(t => ({ t, v: m[t] }));
}
function cLb_(s, x) { let lo = 0, hi = s.length; while (lo < hi) { const k = (lo + hi) >> 1; if (s[k].t < x) lo = k + 1; else hi = k; } return lo; }
/** dernière lecture <= t et >= floor */
function cLast_(s, t, floor) { const i = cLb_(s, t + 1) - 1; return i >= 0 && s[i].t >= floor ? s[i] : null; }
/** première lecture >= t et <= ceil */
function cFirst_(s, t, ceil) { const i = cLb_(s, t); return i < s.length && s[i].t <= ceil ? s[i] : null; }
function cMedian_(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }
function cIn_(s, a, b) { const o = []; for (let i = cLb_(s, a); i < s.length && s[i].t <= b; i++) o.push(s[i]); return o; }

/** Cycles contact à partir des transitions d'allumage */
function cCycles_(ign, winFrom, winTo, now) {
  const out = []; let on = null, prev = null;
  ign.forEach(p => {
    if (p.v >= 1 && on === null && (prev === null || prev.v < 1)) on = p.t;
    if (p.v < 1 && on !== null) { out.push({ a: on, b: p.t, open: false }); on = null; }
    prev = p;
  });
  if (on !== null) out.push({ a: on, b: Math.min(winTo, now), open: true });
  // un cycle dont on n'a pas vu le début (déjà allumé avant la fenêtre) est écarté
  return out.filter(c => c.b > c.a);
}

/** Valeur d'un compteur figée moteur coupé : avant le cycle et après le cycle */
function cCounter_(s, cyc, prevOff, nextOn) {
  const v1 = cLast_(s, cyc.a + 30000, prevOff != null ? prevOff - 10000 : cyc.a - 6 * C_HOUR);
  const v2 = cyc.open ? null : cFirst_(s, cyc.b - 10000, (nextOn != null ? nextOn : cyc.b + 6 * C_HOUR) + 30000);
  if (!v1 || !v2) return null;
  const d = v2.v - v1.v;
  return d >= 0 ? d : null;
}

/** Chronologie d'un cycle : conduite, arrêt contact mis, ralenti moteur tournant, segments de ralenti */
function cTimeline_(rpm, spd, a, b, P) {
  const bp = [a, b];
  cIn_(rpm, a, b).forEach(p => bp.push(p.t));
  cIn_(spd, a, b).forEach(p => bp.push(p.t));
  const ts = Array.from(new Set(bp.filter(t => t >= a && t <= b))).sort((x, y) => x - y);
  let drive = 0, still = 0, idle = 0, evOff = 0, unknown = 0, segs = [], cur = null;
  for (let k = 0; k < ts.length - 1; k++) {
    const t0 = ts[k], dt = ts[k + 1] - t0;
    const r = cLast_(rpm, t0, a - 2000), v = cLast_(spd, t0, a - 2000);
    let state;
    if (!v) state = r && r.v > P.rpmMin ? 'unk' : 'unk';
    else if (v.v >= 2) state = 'drive';
    else if (!r) state = 'stillUnk';
    else state = r.v > P.rpmMin ? 'idle' : 'evOff';
    if (state === 'drive') drive += dt;
    if (state === 'idle' || state === 'evOff' || state === 'stillUnk') still += dt;
    if (state === 'idle') idle += dt;
    if (state === 'evOff') evOff += dt;
    if (state === 'unk' || state === 'stillUnk') unknown += dt;
    if (state === 'idle') { if (!cur) cur = { a: t0, b: t0 }; cur.b = t0 + dt; }
    else if (cur) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  return { drive, still, idle, evOff, unknown, coverage: (b - a) ? 1 - unknown / (b - a) : 0, segs };
}

/** Limites de vitesse Geotab : [{k,v}] ou [{key,value}] -> [{t,v}] (v = -1 conservé = inconnue) */
/** Point de jauge Geotab -> % (les Staria remontent la jauge en litres : source EstimateFuelUnits) */
function cPct_(pt, cap) {
  const v = +pt.data, c = cap && cap.volume ? +cap.volume : 0;
  return /Units/i.test(String(pt.source || '')) && c > 0 ? v / c * 100 : v;
}
function cRoad_(res) {
  let arr = res || [];
  if (!Array.isArray(arr) && typeof arr === 'object') arr = Object.keys(arr).map(k => ({ k, v: arr[k] }));
  return arr.map(x => ({ t: new Date(x.k || x.key || x.dateTime).getTime(), v: +(x.v != null ? x.v : x.value) }))
    .filter(x => !isNaN(x.t) && isFinite(x.v)).sort((a, b) => a.t - b.t);
}

/**
 * Vitesse : capteur de vitesse du véhicule (calculateur, DiagnosticEngineRoadSpeedId), enregistré sur changement.
 * Une valeur n'est retenue que si la lecture suivante la confirme (min des 2) : élimine les pics isolés.
 * Le GPS ne sert que de contrôle (vmaxGps) et pour la position.
 */
function cSpeed_(spd, logs, road, a, b) {
  const pts = cIn_(spd, a, b);
  let vmax = 0, tMax = null, worst = null, nLim = 0, nKnown = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1], s = Math.min(p.v, q.v);
    if (s > vmax) { vmax = s; tMax = p.t; }
    if (s >= 30) {
      nLim++;
      const lp = cLast_(road, p.t, a - 60000), lq = cLast_(road, q.t, a - 60000);
      if (lp && lq && lp.v > 0 && lp.v === lq.v) {
        nKnown++;
        const ex = s - lp.v;
        if (!worst || ex > worst.ex) { const g = cLast_(logs, p.t, p.t - 60000) || cFirst_(logs, p.t, p.t + 60000); worst = { ex, v: s, lim: lp.v, t: p.t, lat: g ? g.lat : '', lon: g ? g.lon : '' }; }
      }
    }
  }
  let vg = 0; const g = cIn_(logs, a, b);
  for (let i = 0; i + 1 < g.length; i++) vg = Math.max(vg, Math.min(g[i].v, g[i + 1].v));
  const limAtMax = tMax ? cLast_(road, tMax, a - 60000) : null;
  return { vmax: Math.round(vmax), vmaxGps: Math.round(vg), tMax, limAtMax: limAtMax && limAtMax.v > 0 ? limAtMax.v : null, worst, limCoverage: nLim ? nKnown / nLim : null };
}

/**
 * Analyse d'un véhicule sur une fenêtre de données.
 * d = { trips, exc, logs, fills, road, sd: {ign, rpm, spd, fuel, ecu, idleFuel, lvlL, lvlPct} } (bruts Geotab)
 * Retourne les cycles qui DÉMARRENT dans [dayFrom, dayTo[, les arrêts moteur coupé (siphonage) qui démarrent
 * dans la journée, les pleins Geotab et les événements.
 */
/** Décodage des données téléchargées, fait une seule fois par bloc (réutilisé pour chaque jour du bloc) */
function cPrep_(d, win) {
  if (d._pre && d._pre.from === win.from && d._pre.to === win.to && d._pre.now === win.now) return d._pre;
  const S = {};
  Object.keys(CORE_DIAGS).forEach(k => { S[k] = cSeries_(d.sd[k], win.from, win.to); });
  const logs = (d.logs || []).map(x => ({ t: new Date(x.dateTime).getTime(), v: +x.speed || 0, lat: x.latitude, lon: x.longitude }))
    .filter(x => !isNaN(x.t)).sort((a, b) => a.t - b.t);
  const road = cRoad_(d.road);
  const trips = (d.trips || []).map(t => ({ a: new Date(t.start).getTime(), b: new Date(t.stop).getTime(), km: +t.distance || 0,
    gIdle: t.idlingDuration, lat: t.stopPoint ? t.stopPoint.y : '', lon: t.stopPoint ? t.stopPoint.x : '' })).sort((x, y) => x.a - y.a);
  const cyc = cCycles_(S.ign, win.from, win.to, win.now);
  const lvl = S.lvlL.length ? { s: S.lvlL, unit: 'L' } : { s: S.lvlPct, unit: '%' };
  return (d._pre = { from: win.from, to: win.to, now: win.now, S, logs, road, trips, cyc, lvl });
}
function cAnalyze_(d, win, P) {
  const pre = cPrep_(d, win), S = pre.S, logs = pre.logs, road = pre.road, trips = pre.trips, cyc = pre.cyc, lvl = pre.lvl;
  const out = { cycles: [], idles: [], offStops: [], fills: [], evts: [], sources: {} };
  // nombre de lectures sur la fenêtre d'analyse du jour (jour ± 12 h), quelle que soit la taille du bloc téléchargé
  const wA = win.dayFrom - 12 * C_HOUR, wB = Math.min(win.dayTo + 12 * C_HOUR, win.to);
  Object.keys(S).forEach(k => { out.sources[k] = cIn_(S[k], wA + 1, wB - 1).length; });   // bornes exclues, comme cSeries_
  out.sources.logs = cIn_(logs, win.dayFrom - 6 * C_HOUR, wB).length; out.sources.road = cIn_(road, win.dayFrom, wB).length;

  cyc.forEach((c, i) => {
    if (c.a < win.dayFrom || c.a >= win.dayTo) return;
    const prevOff = i > 0 ? cyc[i - 1].b : null, nextOn = i + 1 < cyc.length ? cyc[i + 1].a : null;
    const tl = cTimeline_(S.rpm, S.spd, c.a, c.b, P);
    const km = trips.filter(t => t.a >= c.a - 60000 && t.a < c.b).reduce((s, t) => s + t.km, 0);
    const fuel = cCounter_(S.fuel, c, prevOff, nextOn), ecu = cCounter_(S.ecu, c, prevOff, nextOn), idleL = cCounter_(S.idleFuel, c, prevOff, nextOn);
    const hours = (c.b - c.a) / C_HOUR, plaus = L => L != null && L <= km * 0.4 + hours * 4 + 1;
    const sp = cSpeed_(S.spd, logs, road, c.a, c.b);
    const lastLog = cLast_(logs, c.b, c.a);
    const long = tl.segs.filter(s => s.b - s.a >= P.idleLongMin * C_MIN);
    const hist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];   // nb et minutes : <1, 1-3, 3-5, 5-10, >=10 min
    tl.segs.forEach(s => { const m = (s.b - s.a) / C_MIN, k = m < 1 ? 0 : m < 3 ? 1 : m < 5 ? 2 : m < 10 ? 3 : 4; hist[k]++; hist[5 + k] += m; });
    long.forEach(s => {
      const pos = cLast_(logs, s.a + 1000, c.a) || cFirst_(logs, s.a, s.b);
      out.idles.push({ a: s.a, b: s.b, min: (s.b - s.a) / C_MIN, cycleA: c.a, lat: pos ? pos.lat : '', lon: pos ? pos.lon : '' });
    });
    let gap = null;
    if (plaus(fuel) && plaus(ecu) && ecu > 0.5) gap = fuel - ecu;
    out.cycles.push({
      a: c.a, b: c.b, open: c.open, km,
      driveMin: tl.drive / C_MIN, stillMin: tl.still / C_MIN, idleMin: tl.idle / C_MIN, evOffMin: tl.evOff / C_MIN,
      coverage: tl.coverage, hist, nLong: long.length, longMin: long.reduce((s, x) => s + (x.b - x.a), 0) / C_MIN,
      fuelL: plaus(fuel) ? fuel : null, ecuL: plaus(ecu) ? ecu : null, gapL: gap, idleL: plaus(idleL) ? idleL : null,
      vmax: sp.vmax, vmaxGps: sp.vmaxGps, limAtMax: sp.limAtMax, worst: sp.worst, limCoverage: sp.limCoverage,
      lat: lastLog ? lastLog.lat : '', lon: lastLog ? lastLog.lon : ''
    });
  });

  // Arrêts moteur coupé : variation de jauge sans aucun cycle contact
  for (let i = 0; i + 1 < cyc.length; i++) {
    const off = cyc[i].b, on = cyc[i + 1].a;
    if (off < win.dayFrom || off >= win.dayTo || cyc[i].open) continue;
    const before = cMedian_(cIn_(lvl.s, off - 10 * C_MIN, off + 2 * C_MIN).map(p => p.v));
    const after = cMedian_(cIn_(lvl.s, on - C_MIN, on + 10 * C_MIN).map(p => p.v));
    const pos = cLast_(logs, off, off - 2 * C_HOUR);
    // Compteur kilométrique du véhicule : s'il avance moteur « coupé », le boîtier ne transmettait plus (trajet non enregistré)
    const o1 = cLast_(S.odo, off + 60000, off - 2 * C_HOUR), o2 = cFirst_(S.odo, on - 60000, on + 30 * C_MIN);
    // km enregistrés par le compteur du véhicule moins les km réellement roulés autour de l'arrêt (capteur de vitesse) :
    // le compteur n'est relevé que toutes les 2-3 min, cette correction évite les faux écarts
    const kmSpd = (x, y) => { let km = 0; const pts = cIn_(S.spd, x - 30 * C_MIN, y); for (let k = 0; k < pts.length; k++) { const t0 = Math.max(x, pts[k].t), t1 = Math.min(y, k + 1 < pts.length ? pts[k + 1].t : y); if (t1 > t0) km += pts[k].v * (t1 - t0) / C_HOUR; } return km; };
    const odoKm = o1 && o2 ? (o2.v - o1.v) / 1000 - kmSpd(o1.t, off) - kmSpd(on, o2.t) : null;
    const p2 = cFirst_(logs, on, on + 10 * C_MIN);
    out.offStops.push({ off, on, min: (on - off) / C_MIN, before, after, delta: before != null && after != null ? after - before : null, unit: lvl.unit,
      lat: pos ? pos.lat : '', lon: pos ? pos.lon : '', odoKm, lat2: p2 ? p2.lat : '', lon2: p2 ? p2.lon : '', v2: p2 ? p2.v : null });
  }
  out.lvl = []; const bk = {};
  lvl.s.forEach(p => { if (p.t < win.dayFrom || p.t >= win.dayTo) return; const k = Math.floor(p.t / (15 * C_MIN)); (bk[k] = bk[k] || []).push(p.v); });
  Object.keys(bk).forEach(k => out.lvl.push({ t: +k * 15 * C_MIN, v: cMedian_(bk[k]), unit: lvl.unit }));
  (d.fills || []).forEach(f => {
    const t = new Date(f.dateTime).getTime(); if (isNaN(t) || t < win.dayFrom || t >= win.dayTo) return;
    const ex = f.tankLevelExtrema || {};
    out.fills.push({ t, volume: f.volume != null ? +f.volume : null, derived: f.derivedVolume != null ? +f.derivedVolume : null,
      min: ex.minimaPoint ? cPct_(ex.minimaPoint, f.tankCapacity) : null, max: ex.maximaPoint ? cPct_(ex.maximaPoint, f.tankCapacity) : null,
      cap: f.tankCapacity ? +f.tankCapacity.volume : null, lat: f.location ? f.location.y : '', lon: f.location ? f.location.x : '',
      conf: String(f.confidence || '') });
  });
  (d.exc || []).forEach(e => {
    if (e.state === 'Invalid' || e.state === 1) return;
    const t = new Date(e.activeFrom).getTime(); if (isNaN(t) || t < win.dayFrom || t >= win.dayTo) return;
    out.evts.push({ id: String(e.id), t, end: e.activeTo ? new Date(e.activeTo).getTime() : null, rule: e.rule && e.rule.id ? String(e.rule.id) : '',
      durS: e.duration, km: +e.distance || 0 });
  });
  return out;
}

/** Appels Geotab nécessaires pour un véhicule-jour (Get filtré : méthode recommandée par Geotab pour ce cas) */
function cCalls_(devId, win) {
  const ds = { id: devId }, iso = t => new Date(t).toISOString();
  const sd = diag => ({ method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: ds, diagnosticSearch: { id: diag }, fromDate: iso(win.from), toDate: iso(win.to) }, resultsLimit: 50000 } });
  const calls = [
    { method: 'Get', params: { typeName: 'Trip', search: { deviceSearch: ds, fromDate: iso(win.from), toDate: iso(win.to), includeOverlappedTrips: true } } },
    { method: 'Get', params: { typeName: 'ExceptionEvent', search: { deviceSearch: ds, fromDate: iso(win.dayFrom), toDate: iso(win.dayTo) } } },
    { method: 'Get', params: { typeName: 'LogRecord', search: { deviceSearch: ds, fromDate: iso(win.dayFrom - 6 * C_HOUR), toDate: iso(win.to) }, resultsLimit: 50000,
      propertySelector: { fields: ['dateTime', 'speed', 'latitude', 'longitude'], isIncluded: true } } },
    { method: 'Get', params: { typeName: 'FillUp', search: { deviceSearch: ds, fromDate: iso(win.dayFrom), toDate: iso(win.dayTo) } } }
  ];
  const keys = Object.keys(CORE_DIAGS);
  keys.forEach(k => calls.push(sd(CORE_DIAGS[k])));
  return { calls, map: res => { const d = { trips: res[0], exc: res[1], logs: res[2], fills: res[3], sd: {} }; keys.forEach((k, i) => { d.sd[k] = res[4 + i]; }); return d; } };
}

/** Temps restant estimé (min) d'après la vitesse mesurée sur les paquets précédents, pauses de reprise comprises */
function etaMin_(n) {
  const rate = +(PropertiesService.getScriptProperties().getProperty('SYNC_RATE') || 0);
  if (!rate || !n) return 0;
  const perRun = Math.max(1, Math.floor(MAX_RUN_MS / rate));
  return Math.max(1, Math.ceil((n * rate + Math.floor((n - 1) / perRun) * 75000) / 60000));
}
/** Prend dans la file un lot de blocs : un bloc = un véhicule + jusqu'à SYNC_CHUNK_DAYS jours consécutifs */
function takeBatch_(q, veh) {
  const blocks = [], used = {}, inBatch = {};
  for (let i = 0; i < q.length && blocks.length < SYNC_PARALLEL; i++) {
    if (used[i]) continue;
    const it = q[i], v = veh[it.k];
    if (!v || !v.geoId) { used[i] = 1; continue; }
    if (inBatch[it.k]) continue;
    const b = { v, days: [it.d], tries: it.tries || 0 }; used[i] = 1; inBatch[it.k] = 1;
    for (let j = i + 1; !it.solo && j < q.length && b.days.length < SYNC_CHUNK_DAYS; j++)
      if (!used[j] && !q[j].solo && q[j].k === it.k && q[j].d === addDays_(b.days[b.days.length - 1], 1)) { b.days.push(q[j].d); used[j] = 1; }
    blocks.push(b);
  }
  return { blocks, rest: q.filter((x, i) => !used[i]) };
}
/** Fenêtre téléchargée pour un bloc de jours : du début du 1er jour - 12 h à la fin du dernier + 12 h */
function blockWin_(days, now) {
  const dayFrom = dayBounds_(days[0]).start.getTime(), dayTo = dayBounds_(days[days.length - 1]).end.getTime();
  return { dayFrom, dayTo, from: dayFrom - 12 * HOUR, to: Math.min(dayTo + 12 * HOUR, now), now };
}
/** Télécharge un lot de blocs en parallèle puis calcule chaque véhicule-jour */
function syncBlocks_(blocks, P, acc) {
  const now = Date.now(), reqs = [], meta = [], retry = [], later = [];
  let done = 0, limited = false;
  blocks.forEach(b => {
    const days = b.days.filter(d => dayBounds_(d).start.getTime() <= now);
    done += b.days.length - days.length;
    if (!days.length) return;
    const bw = blockWin_(days, now), cq = cCalls_(b.v.geoId, bw);
    meta.push({ v: b.v, days, bw, cq, i: reqs.length, tries: b.tries || 0 });
    reqs.push({ method: 'ExecuteMultiCall', params: { calls: cq.calls } },
      { method: 'GetRoadMaxSpeeds', params: { deviceSearch: { id: b.v.geoId }, fromDate: iso_(bw.dayFrom), toDate: iso_(bw.to) } });
  });
  const tf = Date.now(), res = reqs.length ? geoFetchAll_(reqs) : [];
  acc.tm = acc.tm || { dl: 0, calc: 0 }; acc.tm.dl += Date.now() - tf; const tc = Date.now();
  const isLimit = e => /limit|quota|429|too many|OverLimit/i.test((e.geoName || '') + ' ' + e.message);
  meta.forEach(m => {
    const r0 = res[m.i](), r1 = res[m.i + 1](), lbl = m.v.plate + ' ' + m.days.join(', ');
    res[m.i] = res[m.i + 1] = null;   // réponse brute libérée
    if (r0.err) {
      if (isLimit(r0.err)) { limited = true; m.days.forEach(d => retry.push({ d, k: m.v.key })); return; }
      if (m.days.length > 1) { m.days.forEach(d => retry.push({ d, k: m.v.key, solo: 1 })); return; }   // nouvel essai jour par jour
      // Erreur passagère (ex. « Service temporarily unavailable ») : nouvel essai en fin de file, 3 essais au total
      if (m.tries < 2) { later.push({ d: m.days[0], k: m.v.key, solo: 1, tries: m.tries + 1 }); return; }
      acc.warn.push(lbl + ' : ' + r0.err.message + ' (abandon après 3 essais, relancez « Vérifier et réparer les données »)'); done += m.days.length; return;
    }
    const data = m.cq.map(r0.res);
    const trunc = [data.logs].concat(Object.keys(data.sd).map(k => data.sd[k])).some(a => (a || []).length >= GEO_MAX_RESULTS);
    if (trunc && m.days.length > 1) { m.days.forEach(d => retry.push({ d, k: m.v.key, solo: 1 })); return; }   // trop de points : jour par jour
    if (trunc) acc.warn.push(lbl + ' : plus de ' + GEO_MAX_RESULTS + ' points Geotab sur la journée, données incomplètes');
    if (r1.err) { if (isLimit(r1.err)) { limited = true; m.days.forEach(d => retry.push({ d, k: m.v.key, solo: m.days.length === 1 ? 1 : undefined })); return; }
      acc.warn.push(lbl + ' : limites de vitesse indisponibles'); data.road = []; }
    else data.road = r1.res;
    m.days.forEach(d => {
      try { emitVehicleDay_(m.v, d, data, m.bw, P, acc); }
      catch (e) { acc.warn.push(m.v.plate + ' ' + d + ' : ' + e.message); }
      done++;
    });
  });
  acc.tm.calc += Date.now() - tc;
  return { retry, later, limited, done };
}
/** Un seul véhicule-jour (téléchargement simple) */
function processVehicleDay_(v, day, P, acc) {
  const r = syncBlocks_([{ v, days: [day] }], P, acc);
  if (r.retry.length) throw new Error('Limite d\'appels Geotab atteinte, réessayez dans une minute');
}
/** Calcule un véhicule-jour à partir des données d'un bloc (fenêtre de téléchargement bw) */
function emitVehicleDay_(v, day, data, bw, P, acc) {
  const b = dayBounds_(day);
  const win = { dayFrom: b.start.getTime(), dayTo: b.end.getTime(), from: bw.from, to: bw.to, now: bw.now };
  if (win.dayFrom > bw.now) return;
  const o = cAnalyze_(data, win, P);
  o.evts = o.evts.filter(e => keepEvt_(acc.rules, e.rule));
  emitRows_(v, o, P, acc);
  acc.days.push(v.key + '|' + day);
  acc.sync.push([v.key + '|' + day, v.key, dayToDate_(day), new Date(), o.cycles.length, o.evts.length, o.sources.lvlL || o.sources.lvlPct,
    o.sources.fuel ? 'OUI' : 'NON', o.sources.road ? 'OUI' : 'NON']);
}
/**
 * Événements Geotab enregistrés : règles qui comptent dans le score, collisions, boîtier, moteur, et règles pas encore classées.
 * Les règles hors conduite (zones, pays, notifications MyClicar, odomètre…) ne sont pas stockées : moitié moins de lignes.
 */
function keepEvt_(rules, rid) {
  if (!rules) return true;
  const r = rules[String(rid)]; if (!r) return true;
  return r.w > 0 || r.cat === 'Collision' || r.cat === 'Boîtier' || r.cat === 'Moteur';
}
/** Lignes de données (trajets, ralentis, pleins, arrêts, événements, jauge) d'une analyse cAnalyze_ */
function emitRows_(v, o, P, acc) {
  const tank = v.tank > 0 ? v.tank : 0;
  o.cycles.forEach(c => {
    const w = c.worst;
    acc.trips.push(rowOf_(H.TRIP, { 'ID': v.key + '|' + iso_(c.a), 'Clé plaque': v.key, 'Plaque': v.plate, 'Date': dayToDate_(localDay_(c.a)),
      'Début': new Date(c.a), 'Fin': new Date(c.b), 'Km': r2_(c.km), 'Conduite (min)': r1_(c.driveMin),
      'Ralenti contact (min)': r1_(c.stillMin), 'Moteur éteint à l\'arrêt (min)': r1_(c.evOffMin), 'Ralenti moteur tournant (min)': r1_(c.idleMin),
      'Source ralenti': c.coverage >= 0.8 ? 'Régime moteur' : 'Régime moteur (couverture ' + Math.round(c.coverage * 100) + ' %)',
      'Ralenti prolongé (min)': Math.round(c.longMin), 'Nb ralentis prolongés': c.nLong,
      'Vmax (km/h)': c.vmax, 'Vmax GPS (contrôle)': c.vmaxGps, 'Vmoy (km/h)': c.driveMin > 0 ? Math.round(c.km / (c.driveMin / 60)) : '', 'Limite à Vmax': c.limAtMax || '',
      'Source limite': c.limAtMax ? 'Geotab (vitesse capteur véhicule)' : '', 'Pire dépassement (km/h)': w ? Math.round(w.ex) : '', 'Vitesse au pire': w ? Math.round(w.v) : '',
      'Limite au pire': w ? w.lim : '', 'Heure pire': w ? localHM_(w.t) : '',
      'Carburant (L)': c.fuelL != null ? r2_(c.fuelL) : '', 'Source carburant': c.fuelL != null ? 'Compteur' : 'Non mesuré',
      'Contrôle calculateur (L)': c.ecuL != null ? r2_(c.ecuL) : '', 'Carburant ralenti (L)': c.idleL != null ? r2_(c.idleL) : '',
      'Source carburant ralenti': c.idleL != null ? 'Compteur ralenti' : '', 'Lat arrêt': c.lat, 'Lon arrêt': c.lon }));
  });
  o.idles.forEach(s => {
    acc.idles.push(rowOf_(H.IDL, { 'Clé': v.key + '|' + iso_(s.a), 'Clé plaque': v.key, 'Plaque': v.plate, 'Trajet ID': v.key + '|' + iso_(s.cycleA),
      'Date': dayToDate_(localDay_(s.a)), 'Début': new Date(s.a), 'Fin': new Date(s.b), 'Durée arrêt (min)': Math.round(s.min),
      'Moteur tournant (min)': Math.round(s.min), 'Vérification moteur': 'Régime moteur', 'Litres': '', 'Source litres': '', 'Lat': s.lat, 'Lon': s.lon }));
  });
  o.fills.forEach(f => {
    acc.fuels.push(rowOf_(H.FUEL, { 'Clé': v.key + '|' + iso_(f.t) + '|PLEIN', 'Clé plaque': v.key, 'Plaque': v.plate, 'Date': dayToDate_(localDay_(f.t)),
      'Type': 'PLEIN', 'Arrêt début': new Date(f.t), 'Arrêt fin': new Date(f.t), 'Moteur': '', 'Niveau avant (%)': f.min != null ? r1_(f.min) : '',
      'Niveau après (%)': f.max != null ? r1_(f.max) : '', 'Écart (%)': f.min != null && f.max != null ? r1_(f.max - f.min) : '',
      'Litres (jauge)': f.derived != null ? r1_(f.derived) : '', 'Litres Geotab': f.volume != null ? r1_(f.volume) : '', 'Source': 'Geotab FillUp',
      'Lat': f.lat, 'Lon': f.lon, 'Statut': 'Info' }));
  });
  o.offStops.forEach(s => {
    if (s.odoKm != null && s.odoKm >= 10) {   // seuil 10 km : en dessous, écarts de relevé ou mode électrique des hybrides
      // Le véhicule a roulé alors que le boîtier ne voyait pas le contact : trajet non enregistré, pas un siphonage
      acc.fuels.push(rowOf_(H.FUEL, { 'Clé': v.key + '|' + iso_(s.off) + '|TRAJET_NON_ENREGISTRE', 'Clé plaque': v.key, 'Plaque': v.plate,
        'Date': dayToDate_(localDay_(s.off)), 'Type': 'TRAJET_NON_ENREGISTRE', 'Arrêt début': new Date(s.off), 'Arrêt fin': new Date(s.on),
        'Durée arrêt (min)': Math.round(s.min), 'Moteur': r1_(s.odoKm) + ' km non enregistrés', 'Niveau avant (%)': s.before != null ? r1_(s.before) : '',
        'Niveau après (%)': s.after != null ? r1_(s.after) : '', 'Écart (%)': s.delta != null ? r1_(s.delta) : '',
        'Litres (jauge)': s.delta != null ? r1_(s.unit === 'L' ? s.delta : (tank ? s.delta / 100 * tank : s.delta)) : '', 'Source': 'Compteur km véhicule + jauge',
        'Lat': s.lat, 'Lon': s.lon, 'Statut': 'À vérifier' }));
      return;
    }
    if (s.delta == null || s.min < P.stopMin) return;
    const litres = s.unit === 'L' ? s.delta : (tank ? s.delta / 100 * tank : null);
    const suspect = s.unit === 'L' ? -s.delta >= P.siphonL : (-s.delta >= P.siphonPct && (litres === null || -litres >= P.siphonL));
    if (!suspect) return;
    acc.fuels.push(rowOf_(H.FUEL, { 'Clé': v.key + '|' + iso_(s.off) + '|SIPHONAGE_SUSPECT', 'Clé plaque': v.key, 'Plaque': v.plate,
      'Date': dayToDate_(localDay_(s.off)), 'Type': 'SIPHONAGE_SUSPECT', 'Arrêt début': new Date(s.off), 'Arrêt fin': new Date(s.on),
      'Durée arrêt (min)': Math.round(s.min), 'Moteur': 'Coupé', 'Niveau avant (%)': r1_(s.before), 'Niveau après (%)': r1_(s.after),
      'Écart (%)': r1_(s.delta), 'Litres (jauge)': litres != null ? r1_(litres) : '', 'Source': 'Jauge (' + s.unit + ')', 'Lat': s.lat, 'Lon': s.lon, 'Statut': 'À vérifier' }));
  });
  o.evts.forEach(e => {
    acc.evts.push(rowOf_(H.EVT, { 'ID': e.id, 'Clé plaque': v.key, 'Plaque': v.plate, 'Date': dayToDate_(localDay_(e.t)), 'Début': new Date(e.t),
      'Fin': e.end ? new Date(e.end) : '', 'Durée (s)': Math.round(parseDur_(e.durS)), 'Distance (km)': r2_(e.km), 'Règle ID': e.rule }));
  });
  o.lvl.forEach(x => { acc.lvls.push([v.key + '|' + x.t, v.key, new Date(x.t), r1_(x.unit === 'L' && tank ? x.v / tank * 100 : x.v)]); });
}

function normRoad_(res) {
  let arr = res || [];
  if (!Array.isArray(arr) && typeof arr === 'object') arr = Object.keys(arr).map(k => ({ key: k, value: arr[k] }));
  const out = [];
  arr.forEach(x => {
    let t, v;
    if (Array.isArray(x)) { t = x[0]; v = x[1]; }
    else { t = x.key || x.Key || x.dateTime || x.date; v = x.value != null ? x.value : (x.Value != null ? x.Value : x.speed); }
    const tm = new Date(t).getTime();
    if (!isNaN(tm) && v != null && +v > 0 && +v < 200) out.push({ t: tm, v: +v });
  });
  return out.sort((a, b) => a.t - b.t);
}
function series_(raw, field) {
  return (raw || []).map(x => ({ t: new Date(x.dateTime).getTime(), v: +x[field || 'data'] }))
    .filter(x => !isNaN(x.t) && isFinite(x.v)).sort((a, b) => a.t - b.t);
}
/** Recherche binaire : premier index avec t >= x */
function lb_(s, x) { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].t < x) lo = m + 1; else hi = m; } return lo; }
function inWindow_(s, a, b) { const out = []; for (let i = lb_(s, a); i < s.length && s[i].t <= b; i++) out.push(s[i].v); return out; }
function nearest_(s, t, maxMs) {
  if (!s.length) return null;
  const i = lb_(s, t); let best = null, bd = Infinity;
  [i - 1, i].forEach(j => { if (j >= 0 && j < s.length) { const d = Math.abs(s[j].t - t); if (d < bd) { bd = d; best = s[j]; } } });
  return bd <= maxMs ? best : null;
}
/** Valeur d'un compteur cumulatif à l'instant t (interpolation linéaire) */
function counterAt_(s, t, maxGapMs) {
  if (!s.length) return null;
  const i = lb_(s, t);
  if (i < s.length && s[i].t === t) return s[i].v;
  const a = s[i - 1], b = s[i];
  if (a && b) return (b.t - a.t) > 6 * HOUR ? (t - a.t < maxGapMs ? a.v : (b.t - t < maxGapMs ? b.v : null)) : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
  if (a && t - a.t <= maxGapMs) return a.v;
  if (b && b.t - t <= maxGapMs) return b.v;
  return null;
}
/** Niveau de jauge médian autour d'un instant (fenêtre étroite puis élargie) */
function levelBefore_(s, t) {
  let w = inWindow_(s, t - 20 * MIN, t + 2 * MIN);
  if (w.length < 2) w = inWindow_(s, t - 60 * MIN, t + 5 * MIN).slice(-5);
  return median_(w);
}
function levelAfter_(s, t) {
  let w = inWindow_(s, t + 1 * MIN, t + 20 * MIN);
  if (w.length < 2) w = inWindow_(s, t, t + 60 * MIN).slice(0, 5);
  return median_(w);
}

/** Baisse de jauge (%) sur [a,b] par régression linéaire : robuste au bruit du capteur (±3 %) */
function fitDrop_(s, a, b) {
  const pts = []; for (let i = lb_(s, a); i < s.length && s[i].t <= b; i++) pts.push(s[i]);
  if (pts.length < 3 || (pts[pts.length - 1].t - pts[0].t) < 0.5 * (b - a)) return null;
  const n = pts.length, mx = pts.reduce((x, p) => x + p.t, 0) / n, my = pts.reduce((x, p) => x + p.v, 0) / n;
  let sxy = 0, sxx = 0; pts.forEach(p => { sxy += (p.t - mx) * (p.v - my); sxx += (p.t - mx) * (p.t - mx); });
  if (!sxx) return null;
  const drop = -(sxy / sxx) * (b - a);
  return drop < 0 ? 0 : (drop > 60 ? null : drop);
}

/** Arrêts véhicule immobile pendant un trajet (contact mis), reconstitués depuis le GPS (vitesse < 2 km/h). */
function idleSegments_(logs, a, b, minMs) {
  const out = []; let s = null, lat = '', lon = '';
  const i0 = lb_(logs, a);
  for (let i = i0; i < logs.length && logs[i].t <= b; i++) {
    const p = logs[i];
    if (p.v < 2) { if (s === null) { s = (i === i0 && p.t - a < 5 * MIN) ? a : p.t; lat = p.lat; lon = p.lon; } }
    else if (s !== null) { if (p.t - s >= minMs) out.push({ a: s, b: p.t, lat, lon }); s = null; }
  }
  if (s !== null && b - s >= minMs) out.push({ a: s, b: b, lat, lon });
  return out;
}
/** Plein pendant un trajet (moteur tournant à la pompe) : saut de jauge entre médianes de 3 lectures */
function inTripRefuels_(fuel, a, b, pct) {
  const pts = []; for (let i = lb_(fuel, a); i < fuel.length && fuel[i].t <= b; i++) pts.push(fuel[i]);
  const out = [];
  for (let i = 3; i + 3 <= pts.length; i++) {
    const before = median_(pts.slice(i - 3, i).map(p => p.v)), after = median_(pts.slice(i, i + 3).map(p => p.v));
    if (after - before >= pct && pts[i + 2].t - pts[i - 3].t <= 40 * MIN) { out.push({ t: pts[i].t, before, after }); i += 5; }
  }
  return out;
}
/** Dernière lecture à l'instant t, si elle a moins de maxAge */
function lastAt_(s, t, maxAge) { const i = lb_(s, t + 1) - 1; return i >= 0 && t - s[i].t <= maxAge ? s[i] : null; }
/** Idem, en ignorant les lectures antérieures à "floor" (ex. trajet précédent) */
function lastIn_(s, t, floor, maxAge) { const i = lb_(s, t + 1) - 1; return i >= 0 && s[i].t >= floor && t - s[i].t <= maxAge ? s[i] : null; }
const HOLD = 120 * MIN;   // Geotab enregistre régime et débit sur changement : la valeur reste vraie jusqu'à la lecture suivante
/** Minutes où le régime dépasse le seuil sur [a,b] (valeur maintenue 30 min au plus entre deux lectures) */
function runMinutes_(s, a, b, thr, floor) {
  if (!s.length || b <= a) return null;
  floor = floor == null ? a - 30 * MIN : floor;
  let i = lb_(s, a); const pts = []; if (i > 0 && s[i - 1].t >= floor) pts.push(s[i - 1]); for (; i < s.length && s[i].t < b; i++) pts.push(s[i]);
  let run = 0, known = 0;
  pts.forEach((p, k) => {
    const from = Math.max(a, p.t), to = Math.min(b, k + 1 < pts.length ? pts[k + 1].t : b, p.t + HOLD);
    if (to > from) { known += to - from; if (p.v > thr) run += to - from; }
  });
  return { run: run / MIN, known: known / MIN };
}
/** Litres consommés sur [a,b] par intégration du débit carburant mesuré (L/h). null si couverture < 80 %. */
function integrateRate_(s, a, b, floor) {
  floor = floor == null ? a - 30 * MIN : floor;
  const r = runMinutes_(s, a, b, -1, floor); if (!r || r.known < 0.8 * (b - a) / MIN) return null;
  let i = lb_(s, a); const pts = []; if (i > 0 && s[i - 1].t >= floor) pts.push(s[i - 1]); for (; i < s.length && s[i].t < b; i++) pts.push(s[i]);
  let lit = 0;
  pts.forEach((p, k) => { const from = Math.max(a, p.t), to = Math.min(b, k + 1 < pts.length ? pts[k + 1].t : b, p.t + HOLD);
    if (to > from) lit += Math.max(0, p.v) * (to - from) / HOUR; });
  return lit;
}
/** Ralenti vérifié sur un trajet : véhicule immobile ET moteur thermique tournant (+ litres via débit si dispo) */
function verifiedIdle_(logs, rpm, rate, a, b, thr) {
  const bp = [a, b];
  for (let i = lb_(logs, a); i < logs.length && logs[i].t < b; i++) bp.push(logs[i].t);
  for (let i = lb_(rpm, a); i < rpm.length && rpm[i].t < b; i++) bp.push(rpm[i].t);
  if (rate) for (let i = lb_(rate, a); i < rate.length && rate[i].t < b; i++) bp.push(rate[i].t);
  const ts = bp.filter((t, i, x) => x.indexOf(t) === i).sort((x, y) => x - y);
  let idle = 0, known = 0, lit = 0, litKnown = 0, stillMs = 0;
  for (let k = 0; k < ts.length - 1; k++) {
    const t0 = ts[k], dt = ts[k + 1] - t0, sp = lastAt_(logs, t0, 12 * HOUR);
    const still = sp && sp.v < 2;
    if (still) stillMs += dt;
    const rp = lastIn_(rpm, t0, a - MIN, HOLD);
    if (rp) { known += dt; if (still && rp.v > thr) idle += dt; }
    if (still && rate) { const rr = lastIn_(rate, t0, a - MIN, HOLD); if (rr) { lit += Math.max(0, rr.v) * dt / HOUR; litKnown += dt; } }
  }
  return { idle: idle / MIN, known: known / MIN, lit: stillMs && litKnown >= 0.8 * stillMs ? lit : null };
}
/**
 * Litres d'un compteur cumulatif sur un trajet. Véhicule coupé, le compteur ne bouge pas :
 * la dernière lecture depuis la fin du trajet précédent et la première avant le trajet suivant sont exactes.
 */
function tripCounter_(s, start, stop, prevStop, nextStart) {
  if (!s.length) return null;
  const lo = prevStop != null ? prevStop - MIN : start - 12 * HOUR, hi = nextStart != null ? nextStart + MIN : stop + 12 * HOUR;
  let v1 = null, v2 = null;
  const i = lb_(s, start + MIN + 1) - 1;
  if (i >= 0 && s[i].t >= lo) v1 = s[i].v; else v1 = counterAt_(s, start, 30 * MIN);
  const j = lb_(s, stop - MIN);
  if (j < s.length && s[j].t <= hi) v2 = s[j].v; else v2 = counterAt_(s, stop, 30 * MIN);
  return v1 != null && v2 != null && v2 - v1 >= 0 ? v2 - v1 : null;
}
/** Contrôle d'ordre de grandeur : écarte une source manifestement fausse (erreur d'unité, compteur remis à zéro) */
function plausibleFuel_(L, km, idleH) { return L != null && isFinite(L) && L >= 0 && L <= km * 0.5 + idleH * 5 + 2; }

// ============================================================================
// 8c. SONDE GEOTAB : réponses brutes de l'API pour chaque véhicule
// ============================================================================
function sondeGeotab() {
  const t0 = Date.now(), now = Date.now(), out = [];
  const veh = Object.values(vehicles_()).filter(v => v.active && v.geoId);
  const add = (plate, item, res, det) => out.push([plate, item, String(res), String(det === undefined || det === null ? '' : det).slice(0, 3000)]);
  const js = o => { try { return JSON.stringify(o); } catch (e) { return String(o); } };
  const safe = fn => { try { return { ok: true, v: fn() }; } catch (e) { return { ok: false, e: e.message }; } };
  const diagInfo = {};
  veh.forEach(v => {
    if (Date.now() - t0 > MAX_RUN_MS - 40000) { add(v.plate, 'Arrêt', 'Temps dépassé', 'Relancer la sonde pour les véhicules restants'); return; }
    const ds = { id: v.geoId };
    add(v.plate, 'Boîtier Geotab', v.geoId, v.geoName);
    const tr = safe(() => geoCall_('Get', { typeName: 'Trip', search: { deviceSearch: ds, fromDate: iso_(now - 7 * DAY), toDate: iso_(now) } }) || []);
    if (!tr.ok) { add(v.plate, 'Trajets 7 jours', 'ERREUR', tr.e); return; }
    const trips = tr.v.sort((a, b) => new Date(a.start) - new Date(b.start)), last = trips[trips.length - 1];
    add(v.plate, 'Trajets 7 jours', trips.length, last ? 'dernier : ' + fmtDT_(last.start) + ' → ' + fmtDT_(last.stop) + ', ' + r1_(+last.distance) + ' km' : 'aucun trajet');
    if (!last) return;
    add(v.plate, 'Exemple de trajet (brut)', '', js(last));
    const b = new Date(last.stop).getTime(), a = b - 24 * HOUR;
    add(v.plate, 'Fenêtre analysée', fmtDT_(a) + ' → ' + fmtDT_(b), '');
    const lr = safe(() => geoCall_('Get', { typeName: 'LogRecord', search: { deviceSearch: ds, fromDate: iso_(a), toDate: iso_(b) } }) || []);
    add(v.plate, 'Positions GPS (LogRecord)', lr.ok ? lr.v.length : 'ERREUR', lr.ok ? (lr.v[0] ? js(lr.v[0]) : '') : lr.e);
    const sd = safe(() => geoCall_('Get', { typeName: 'StatusData', search: { deviceSearch: ds, fromDate: iso_(a), toDate: iso_(b) }, resultsLimit: 50000 }) || []);
    if (!sd.ok) add(v.plate, 'Données moteur (StatusData)', 'ERREUR', sd.e);
    else {
      add(v.plate, 'Données moteur (StatusData)', sd.v.length + ' lectures', sd.v.length >= 50000 ? 'limite atteinte, fenêtre tronquée' : '');
      const g = {};
      sd.v.forEach(x => { const id = x.diagnostic && x.diagnostic.id ? x.diagnostic.id : String(x.diagnostic); (g[id] = g[id] || []).push({ t: new Date(x.dateTime).getTime(), v: x.data }); });
      const ids = Object.keys(g).filter(id => !diagInfo[id]);
      for (let i = 0; i < ids.length; i += 100) {
        const ch = ids.slice(i, i + 100);
        const res = safe(() => geoMulti_(ch.map(id => ({ method: 'Get', params: { typeName: 'Diagnostic', search: { id } } }))));
        ch.forEach((id, j) => { const d = res.ok ? ((res.v[j] || [])[0] || {}) : {}; const u = d.unitOfMeasure;
          diagInfo[id] = { name: d.name || id, unit: u ? (typeof u === 'string' ? u : (u.id || '')) : '' }; });
      }
      Object.keys(g).sort((x, y) => g[y].length - g[x].length).forEach(id => {
        const s = g[id].sort((x, y) => x.t - y.t), vals = s.map(x => +x.v).filter(isFinite), inf = diagInfo[id] || { name: id, unit: '' };
        const gaps = []; for (let k = 1; k < s.length; k++) gaps.push((s[k].t - s[k - 1].t) / MIN);
        add(v.plate, 'Capteur : ' + inf.name, s.length + ' lectures', 'id ' + id + ' | unité ' + (inf.unit || '?') + ' | rôle détecté : ' + (classifyDiag_(id, inf.name) || '-') +
          (vals.length ? ' | min ' + Math.min.apply(null, vals) + ' / max ' + Math.max.apply(null, vals) : '') +
          ' | première ' + fmtDT_(s[0].t) + ' = ' + s[0].v + ' | dernière ' + fmtDT_(s[s.length - 1].t) + ' = ' + s[s.length - 1].v +
          (gaps.length ? ' | intervalle médian ' + r1_(median_(gaps)) + ' min' : ''));
      });
    }
    ['FuelAndEnergyUsed', 'FillUp', 'FuelUsed', 'FuelTransaction'].forEach(tn => {
      const r = safe(() => geoCall_('Get', { typeName: tn, search: { deviceSearch: ds, fromDate: iso_(now - 7 * DAY), toDate: iso_(now) } }) || []);
      add(v.plate, tn, r.ok ? r.v.length : 'ERREUR', r.ok ? (r.v[0] ? js(r.v[r.v.length - 1]) : 'aucun') : r.e);
    });
    const rm = safe(() => geoCall_('GetRoadMaxSpeeds', { deviceSearch: ds, fromDate: iso_(new Date(last.start)), toDate: iso_(b) }));
    add(v.plate, 'Limites de vitesse (GetRoadMaxSpeeds)', rm.ok ? (Array.isArray(rm.v) ? rm.v.length + ' valeurs' : typeof rm.v) : 'ERREUR',
      rm.ok ? js(Array.isArray(rm.v) ? rm.v.slice(0, 5) : rm.v) : rm.e);
    const ex = safe(() => geoCall_('Get', { typeName: 'ExceptionEvent', search: { deviceSearch: ds, fromDate: iso_(a), toDate: iso_(b) } }) || []);
    add(v.plate, 'Événements (ExceptionEvent)', ex.ok ? ex.v.length : 'ERREUR', ex.ok ? (ex.v[0] ? js(ex.v[0]) : '') : ex.e);
    if (lr.ok && lr.v.length) {
      const p = lr.v.reduce((m, x) => (+x.speed > +m.speed ? x : m), lr.v[0]);
      const q = '[out:json][timeout:10];way(around:25,' + p.latitude + ',' + p.longitude + ')[highway];out tags;';
      const o = safe(() => { const r = UrlFetchApp.fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q), { muteHttpExceptions: true });
        return 'HTTP ' + r.getResponseCode() + ' | ' + r.getContentText().slice(0, 1200); });
      add(v.plate, 'OpenStreetMap au point le plus rapide (' + Math.round(+p.speed) + ' km/h)', p.latitude + ', ' + p.longitude, o.ok ? o.v : o.e);
    }
  });
  writeTable_(S.PROBE, ['Plaque', 'Élément', 'Résultat', 'Détail'], out);
  const s = sh_(S.PROBE);
  s.setColumnWidth(1, 95); s.setColumnWidth(2, 300); s.setColumnWidth(3, 170); s.setColumnWidth(4, 900);
  s.getRange(2, 4, Math.max(out.length, 1), 1).setWrap(true);
  ss_().setActiveSheet(s);
  log_('Sonde Geotab', out.length + ' lignes', t0);
  toast_('Sonde terminée : onglet ' + S.PROBE, 'Geotab', 8);
}

function flush_(acc) {
  const synced = {}; acc.days.forEach(k => { synced[k] = 1; });
  // Remplace toutes les lignes des véhicule-jours resynchronisés (les identifiants de trajet Geotab changent en cours de trajet)
  const replace = (name, headers, rows, timeCol, keepCols) => {
    // Cas courant (jours jamais synchronisés) : ajout en fin de tableau, sans relire ni réécrire tout le tableau
    const s0 = ensureSheet_(name, headers), I0 = idx_(headers), lr = s0.getLastRow(), n = Math.max(0, lr - 1);
    let clash = false;
    if (n) {
      // v6 : seules les lignes datées à partir de la veille du plus ancien jour écrit sont relues (fin du tableau)
      const k0 = keyOfSheet_(name), dc = I0[DATE_COL[k0]], minDay = addDays_(acc.days.map(id => id.split('|')[1]).sort()[0], -1);
      const dv = s0.getRange(2, dc + 1, n, 1).getValues(); let i0 = 0; while (i0 < n && !(toDayStr_(dv[i0][0]) >= minDay)) i0++;
      const m = n - i0;
      const ids = m ? s0.getRange(2 + i0, 1, m, 1).getValues() : [], ks = m ? s0.getRange(2 + i0, I0['Clé plaque'] + 1, m, 1).getValues() : [], ts = m ? s0.getRange(2 + i0, I0[timeCol] + 1, m, 1).getValues() : [];
      const newIds = {}; rows.forEach(r => { newIds[String(r[0])] = 1; });
      for (let i = 0; i < m && !clash; i++) {
        if (ids[i][0] === '' && ks[i][0] === '') continue;
        const t = toDate_(ts[i][0]);
        if (newIds[String(ids[i][0])] || synced[String(ks[i][0]) + '|' + localDay_(t || new Date(0))]) clash = true;
      }
    }
    if (!clash) {
      if (!rows.length) return;
      const seen = {}, add = rows.filter(r => { const k = String(r[0]); if (seen[k]) return false; seen[k] = 1; return true; });
      const start = lr + 1;
      if (s0.getMaxRows() < start + add.length) s0.insertRowsAfter(s0.getMaxRows(), start + add.length - s0.getMaxRows());
      textCols_(s0, headers, start, add.length);
      fmtDates_(s0, headers, start, add.length);
      s0.getRange(start, 1, add.length, headers.length).setValues(clean_(add.map(r => fit_(r, headers.length))));
      return;
    }
    // Resynchro : les lignes des véhicule-jours concernés sont remplacées (réécriture complète)
    const T = readTable_(name), I = idx_(headers), keep = {};
    if (keepCols) T.rows.forEach(r => { keep[String(r[0])] = keepCols.map(c => r[I[c]]); });
    const kept = T.rows.filter(r => !synced[String(r[I['Clé plaque']]) + '|' + localDay_(toDate_(r[I[timeCol]]) || new Date(0))]);
    if (keepCols) rows.forEach(r => { const k = keep[String(r[0])]; if (k) keepCols.forEach((c, j) => { if (k[j] !== '' && k[j] != null) r[I[c]] = k[j]; }); });
    const seen = {}, merged = kept.concat(rows).filter(r => { const k = String(r[0]); if (seen[k]) return false; seen[k] = 1; return true; });
    if (rows.length || kept.length !== T.rows.length) writeTable_(name, headers, merged);
  };
  if (!acc.days.length) return;
  // v6 : chauffeur rattaché au moment de l'écriture (plus de réécriture globale des tableaux)
  const actx = attribCtx_();
  attribRows_('TRIP', acc.trips, actx); attribRows_('IDL', acc.idles, actx); attribRows_('EVT', acc.evts, actx); attribRows_('FUEL', acc.fuels, actx);
  replace(S.TRIP, H.TRIP, acc.trips, 'Début');
  replace(S.IDL, H.IDL, acc.idles, 'Début');
  replace(S.EVT, H.EVT, acc.evts, 'Début');
  replace(S.FUEL, H.FUEL, acc.fuels, 'Arrêt début', ['Statut']);
  replace(S.LVL, H.LVL, acc.lvls, 'Horodatage');
  upsert_(S.SYNC, H.SYNC, acc.sync);
  const T = readTable_(S.VEH), I = idx_(H.VEH), now = new Date(), keys = {};
  acc.sync.forEach(s => { keys[s[1]] = 1; });
  T.rows.forEach(r => { if (keys[r[I['Clé']]]) r[I['Dernière synchro']] = now; });
  writeTable_(S.VEH, H.VEH, T.rows);
  // Journées finalisées : leurs lignes provisoires du temps réel sont retirées
  removeLive_(acc.days);
  memoClear_();
}

// ============================================================================
// 8c. V6 : RATTACHEMENT À L'ÉCRITURE, TEMPS RÉEL, FINALISATION, DÉRIVÉS
// ----------------------------------------------------------------------------
// Principe :
//  - toutes les 5 min (collect), Geotab est interrogé seulement sur ce qui est nouveau : état des véhicules
//    (onglet EN DIRECT) et contacts coupés depuis le dernier passage. Chaque cycle contact terminé est calculé
//    avec le même moteur (cAnalyze_) puis écrit dans LIVE_* (provisoire) ;
//  - le lendemain à midi (fin de journée + 12 h, comme avant), chaque véhicule-jour est recalculé une seule fois
//    sur la journée complète et AJOUTÉ en bas des DATA_* (définitif) ; ses lignes LIVE_* sont retirées ;
//  - JOURNALIER et ALERTES ne sont recalculés que pour les derniers jours (haut des tableaux).
// ============================================================================
function newAcc_() { return { trips: [], evts: [], fuels: [], lvls: [], idles: [], sync: [], days: [], warn: [], rules: rulesMap_() }; }

/** Contexte de rattachement chauffeur */
function attribCtx_() { const P = params_(); return { cidx: contractIndex_(), tol: P.ctrTolMin * MIN, rules: rulesMap_() }; }
const ATTR_TIME = { TRIP: 'Début', IDL: 'Début', EVT: 'Début', FUEL: 'Arrêt début' };
/** Remplit chauffeur / contrat (et nom de règle, chauffeur suivant) sur des lignes avant écriture */
function attribRows_(k, rows, ctx) {
  if (!rows || !rows.length) return;
  const I = idx_(H[k]), tc = I[ATTR_TIME[k]];
  rows.forEach(r => {
    const key = String(r[I['Clé plaque']]), a = attrib_(ctx.cidx, key, tms_(r[tc]), ctx.tol);
    r[I['Code chauffeur']] = a.code; r[I['Chauffeur']] = a.nom; r[I['Contrat']] = a.num;
    if (k === 'EVT') { const rid = String(r[I['Règle ID']]); r[I['Règle']] = ctx.rules[rid] ? ctx.rules[rid].name : rid; }
    if (k === 'FUEL') { const b = attrib_(ctx.cidx, key, tms_(r[I['Arrêt fin']]), ctx.tol); r[I['Chauffeur suivant']] = b.code === a.code ? '' : b.nom; }
  });
}
/** Véhicule-jour d'une ligne de données ('clé|aaaa-mm-jj') : jour de début du cycle contact (comme le calcul journalier) */
function rowDay_(k, r, I) {
  if (k === 'IDL') { const m = String(r[I['Trajet ID']] || '').split('|')[1]; if (m) return localDay_(new Date(m)); }
  if (k === 'LVL') return localDay_(toDate_(r[I['Horodatage']]) || new Date(0));
  return localDay_(toDate_(r[I[ATTR_TIME[k]]]) || new Date(0));
}
/** Retire des LIVE_* les lignes des véhicule-jours désormais finalisés */
function removeLive_(ids) {
  if (!ids || !ids.length) return;
  const set = {}; ids.forEach(id => { set[id] = 1; });
  Object.keys(LIVE_OF).forEach(k => {
    const I = idx_(H[k]);
    removeRows_(S[LIVE_OF[k]], r => set[String(r[I['Clé plaque']]) + '|' + rowDay_(k, r, I)]);
  });
}

// ---------- Temps réel ----------
const LIVE_SETTLE = 5 * MIN;        // un cycle n'est calculé que 5 min après la coupure du contact (données arrivées)
const LIVE_CTX = HOUR;              // contexte téléchargé avant le dernier cycle calculé (compteurs, jauge, odomètre)
const LIVE_EVBACK = 3 * HOUR;       // événements et pleins recalculés par Geotab avec retard : fenêtre relue
const LIVE_SPAN = 8 * HOUR;         // rattrapage par tranches de 8 h au plus
const LIVE_KM_WAIT = HOUR;          // trajet Geotab (km) pas encore calculé : on attend jusqu'à 1 h

/** Premier passage pour un véhicule : on part du premier jour non finalisé (hier ou aujourd'hui) */
function initLive_(v, fin, today) {
  const y = addDays_(today, -1), d = fin[v.key + '|' + y] ? today : y;
  return { done: dayBounds_(d).start.getTime(), init: 1, span: LIVE_SPAN };
}
/** Coupe une liste en paquets */
function chunks_(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

/**
 * Collecte temps réel. opt.all = traiter tous les véhicules quel que soit le budget (bouton SYNCHRO).
 * Retourne { status: {clé: {...}}, wrote, n, warn }.
 */
function liveRun_(t0, budgetMs, opt) {
  opt = opt || {};
  const P = params_(), veh = vehicles_(), list = Object.values(veh).filter(v => v.active && v.geoId);
  const out = { status: {}, wrote: 0, n: 0, warn: [], pending: 0, more: 0 };
  if (!list.length) return out;
  const props = PropertiesService.getScriptProperties(), allP = props.getProperties();
  const now = Date.now(), today = localDay_(now), fin = doneVehDays_(), st = {}, changed = {};
  list.forEach(v => {
    let x = null; try { x = JSON.parse(allP['LIVE|' + v.key] || 'null'); } catch (e) { }
    if (!x || !(x.done > 0)) { x = initLive_(v, fin, today); changed[v.key] = 1; }
    // jour finalisé entre-temps : on repart après lui (ses données sont dans DATA_*)
    for (let d = localDay_(x.done); d < today && fin[v.key + '|' + d]; d = addDays_(d, 1)) { x = { done: dayBounds_(d).end.getTime(), init: 1, span: LIVE_SPAN }; changed[v.key] = 1; }
    st[v.key] = x;
  });
  // 1) État des véhicules + contact depuis le dernier cycle calculé : un seul aller-retour pour toute la flotte
  const calls = [];
  list.forEach(v => calls.push(
    { method: 'Get', params: { typeName: 'DeviceStatusInfo', search: { deviceSearch: { id: v.geoId } } } },
    { method: 'Get', params: { typeName: 'StatusData', search: { deviceSearch: { id: v.geoId }, diagnosticSearch: { id: CORE_DIAGS.ign },
      fromDate: iso_(st[v.key].done - LIVE_CTX), toDate: iso_(now) } } }));
  const parts = chunks_(calls, 100), resp = geoFetchAll_(parts.map(c => ({ method: 'ExecuteMultiCall', params: { calls: c } })));
  const flat = [];
  resp.forEach((rd, i) => { const r = rd(); if (r.err) throw r.err; parts[i].forEach((c, j) => flat.push(r.res[j])); });
  const cand = [];
  list.forEach((v, i) => {
    const dsi = (flat[2 * i] || [])[0] || null, ign = flat[2 * i + 1] || [], s0 = st[v.key].done, from = s0 - LIVE_CTX;
    let ser = cSeries_(ign, from, now);
    const lastIgn = ser.length ? ser[ser.length - 1] : null;
    out.status[v.key] = { dsi, ignOn: lastIgn ? lastIgn.v >= 1 : null, ignAt: lastIgn ? lastIgn.t : null };
    if (!st[v.key].init && !ser.some(p => p.t === s0 - 1000)) { ser = ser.concat([{ t: s0 - 1000, v: 1 }]).sort((a, b) => a.t - b.t); }
    const cyc = cCycles_(ser, from, now, now).filter(c => c.a >= s0 && !c.open && c.b <= now - LIVE_SETTLE);
    if (!cyc.length) return;
    let k = 0; while (k + 1 < cyc.length && cyc[k + 1].b <= s0 + (st[v.key].span || LIVE_SPAN)) k++;
    cand.push({ v, s0, from, lastB: cyc[k].b, to: Math.min(now, cyc[k].b + 30 * MIN), more: k < cyc.length - 1 });
  });
  out.pending = cand.length;
  // 2) Cycles terminés : téléchargement de la seule fenêtre utile, 8 véhicules en parallèle
  const acc = newAcc_();
  for (const grp of chunks_(cand, 8)) {
    if (Date.now() - t0 > budgetMs) { out.more += 1; break; }
    const reqs = [], meta = [];
    grp.forEach(c => {
      const cq = cCalls_(c.v.geoId, { from: c.from, to: c.to, dayFrom: c.s0 - LIVE_EVBACK, dayTo: c.to });
      cq.calls[2].params.search.fromDate = iso_(c.from);   // positions GPS : fenêtre de calcul seulement
      meta.push({ c, cq, i: reqs.length });
      reqs.push({ method: 'ExecuteMultiCall', params: { calls: cq.calls } },
        { method: 'GetRoadMaxSpeeds', params: { deviceSearch: { id: c.v.geoId }, fromDate: iso_(c.from), toDate: iso_(c.to) } });
    });
    const res = geoFetchAll_(reqs);
    meta.forEach(m => {
      const c = m.c, v = c.v, x = st[v.key], r0 = res[m.i](), r1 = res[m.i + 1]();
      if (r0.err) { out.warn.push(v.plate + ' : ' + r0.err.message); return; }
      const data = m.cq.map(r0.res);
      if ([data.logs].concat(Object.keys(data.sd).map(q => data.sd[q])).some(a => (a || []).length >= GEO_MAX_RESULTS)) {
        x.span = Math.max(HOUR, (x.span || LIVE_SPAN) / 2); changed[v.key] = 1; out.warn.push(v.plate + ' : trop de points, tranche réduite'); return;
      }
      data.road = r1.err ? [] : r1.res;
      if (!x.init) data.sd.ign = (data.sd.ign || []).concat([{ dateTime: iso_(c.s0 - 1000), data: 1 }]);   // fin du cycle précédent = c.s0
      const win = { dayFrom: c.s0 - LIVE_EVBACK, dayTo: c.to + 1, from: c.from, to: c.to, now };
      const o = cAnalyze_(data, win, P);
      const emit = [];
      for (const cy of o.cycles.filter(q => q.a >= c.s0).sort((a, b) => a.a - b.a)) {
        if (cy.open || cy.b > c.lastB || cy.b > now - LIVE_SETTLE) break;
        if (cy.driveMin > 1 && cy.km === 0 && now - cy.b < LIVE_KM_WAIT) break;   // trajet Geotab (km) pas encore calculé
        emit.push(cy);
      }
      if (!emit.length) return;
      const newDone = emit[emit.length - 1].b, okDay = t => !fin[v.key + '|' + localDay_(t)], starts = {};
      emit.forEach(cy => { starts[cy.a] = 1; });
      const sel = {
        cycles: emit.filter(cy => okDay(cy.a)),
        idles: o.idles.filter(q => starts[q.cycleA] && okDay(q.cycleA)),
        offStops: o.offStops.filter(q => q.off >= c.s0 && q.off < newDone && okDay(q.off)),
        fills: o.fills.filter(q => okDay(q.t)),
        evts: o.evts.filter(e => keepEvt_(acc.rules, e.rule) && okDay(e.t)),
        lvl: o.lvl.filter(q => q.t >= c.from && q.t + 15 * MIN <= c.to && okDay(q.t))
      };
      emitRows_(v, sel, P, acc);
      st[v.key] = { done: newDone, init: 0, span: LIVE_SPAN }; changed[v.key] = 1;
      out.n += emit.length;
      if (c.more || newDone < c.lastB) out.more++;
    });
  }
  // 3) Écriture (mise à jour par clé : un trajet recalculé remplace sa version précédente)
  const actx = attribCtx_();
  attribRows_('TRIP', acc.trips, actx); attribRows_('IDL', acc.idles, actx); attribRows_('EVT', acc.evts, actx); attribRows_('FUEL', acc.fuels, actx);
  [['LTRIP', acc.trips], ['LIDL', acc.idles], ['LEVT', acc.evts], ['LFUEL', acc.fuels], ['LLVL', acc.lvls]].forEach(x => {
    if (x[1].length) { upsert_(S[x[0]], H[x[0]], x[1]); out.wrote += x[1].length; }
  });
  if (out.wrote) memoClear_();
  const upd = {}; Object.keys(changed).forEach(k => { upd['LIVE|' + k] = JSON.stringify(st[k]); });
  if (Object.keys(upd).length) props.setProperties(upd);
  props.setProperty('LIVE_LAST', String(Date.now()));
  return out;
}
/** Temps réel jusqu'à rattrapage complet (tranches de 8 h successives), dans la limite du temps donné */
function liveCatchUp_(budgetMs) {
  const t0 = Date.now(); let r = null, n = 0;
  for (let i = 0; i < 8; i++) {
    const x = liveRun_(t0, budgetMs, { all: true }); n += x.n;
    r = r ? Object.assign(x, { n, wrote: r.wrote + x.wrote, warn: r.warn.concat(x.warn) }) : x;
    if (!x.more || Date.now() - t0 > budgetMs) break;
    memoClear_();
  }
  return r;
}
/** Couverture des données : véhicule-jours finalisés + journées couvertes par le temps réel (jusqu'à l'heure du dernier calcul) */
function coverage_() {
  const fin = doneVehDays_(), o = Object.assign({}, fin), all = PropertiesService.getScriptProperties().getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('LIVE|') !== 0) return;
    let x = null; try { x = JSON.parse(all[k]); } catch (e) { }
    if (!x || !(x.done > 0)) return;
    const key = k.slice(5), today = localDay_(new Date());
    for (let d = addDays_(today, -2); d <= today; d = addDays_(d, 1)) if (x.done >= dayBounds_(d).start.getTime()) o[key + '|' + d] = 1;
  });
  return o;
}

// ---------- Tableaux triés du plus récent au plus ancien (JOURNALIER, ALERTES) ----------
/** Lignes du haut du tableau dont la date est >= fromDay */
function readTop_(name, fromDay) {
  const k = keyOfSheet_(name), headers = H[k], s = sh_(name), I = idx_(headers), ci = I[DATE_COL[k]];
  if (!s || s.getLastRow() < 2) return { s, headers, rows: [], I };
  const lr = s.getLastRow();
  if (!fromDay) return { s, headers, rows: s.getRange(2, 1, lr - 1, headers.length).getValues().filter(r => r.some(v => v !== '')), I };
  const dv = s.getRange(2, ci + 1, lr - 1, 1).getValues();
  let n = 0; for (let i = dv.length - 1; i >= 0; i--) { const d = toDayStr_(dv[i][0]); if (d && d >= fromDay) { n = i + 1; break; } }
  const rows = n ? s.getRange(2, 1, n, headers.length).getValues().filter(r => { const d = toDayStr_(r[ci]); return d && d >= fromDay; }) : [];
  return { s, headers, rows, I };
}
function jrnSort_(x, y) { return tms_(y[1]) - tms_(x[1]) || tms_(y[7]) - tms_(x[7]) || String(x[2]).localeCompare(String(y[2])); }
const G_ORDER = { 'Critique': 0, 'Haute': 1, 'Moyenne': 2, 'Info': 3 };
function alertSort_(a, b) { return tms_(b[1]) - tms_(a[1]) || (G_ORDER[a[7]] || 0) - (G_ORDER[b[7]] || 0) || String(b[2]).localeCompare(String(a[2])); }
/** Statuts « Faux positif » saisis dans ALERTES */
function fauxPositifs_() {
  const s = sh_(S.ALERT), faux = {}; if (!s || s.getLastRow() < 2) return faux;
  const I = idx_(H.ALERT), v = s.getRange(2, 1, s.getLastRow() - 1, I['Statut'] + 1).getValues();
  v.forEach(r => { if (r[I['Statut']] === 'Faux positif') faux[String(r[0])] = 1; });
  return faux;
}
/**
 * Recalcule JOURNALIER et ALERTES à partir de fromDay - 3 jours (le haut des deux tableaux seulement).
 * Données lues : à partir de fromDay - 4 jours (une journée de travail de nuit commence la veille).
 */
function updateDerived_(fromDay) {
  const t0 = Date.now(), P = params_(), veh = vehicles_(), rules = rulesMap_(), cidx = contractIndex_();
  const cut = addDays_(fromDay, -3), dataFrom = addDays_(fromDay, -4);
  const T = readData_(S.TRIP, dataFrom), E = readData_(S.EVT, dataFrom), F = readData_(S.FUEL, dataFrom), Il = readData_(S.IDL, dataFrom);
  const IJ = idx_(H.JRN);
  const jrn = buildJournalier_(T, E, F, veh, rules, P, fauxPositifs_(), contractInfo_()).filter(r => toDayStr_(r[IJ['Date']]) >= cut);
  replaceTop_(S.JRN, cut, jrn, jrnSort_);
  const al = buildAlerts_(T, E, F, Il, jrn, veh, rules, P, cidx, cut);
  replaceTop_(S.ALERT, cut, al, alertSort_);
  PropertiesService.getScriptProperties().setProperty('DERIVED_LAST', String(Date.now()));
  return { jrn: jrn.length, alerts: al.length, ms: Date.now() - t0 };
}

// ---------- Onglet EN DIRECT ----------
/** "1.02:13:00" / "02:13:00" -> minutes */
function durMin_(s) { const m = String(s || '').match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/); return m ? (+(m[1] || 0)) * 1440 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 60 : null; }
function renderLive_(status) {
  const s = sh_(S.LIVE) || ensureSheet_(S.LIVE, null, '#00704A');
  const P = params_(), veh = vehicles_(), cidx = contractIndex_(), now = Date.now(), today = localDay_(now);
  resetView_(s, 4);
  title_(s, 'En direct', 'Mis à jour le ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm') + ' (automatique toutes les ' + (P.liveMin || 5) +
    ' min). Totaux du jour : trajets terminés (contact coupé), le trajet en cours est ajouté à la coupure du contact.');
  const T = readData_(S.TRIP, today), IT = T.I, tot = {};
  T.rows.forEach(r => {
    if (toDayStr_(r[IT['Date']]) !== today) return;
    const o = tot[String(r[IT['Clé plaque']])] = tot[String(r[IT['Clé plaque']])] || { km: 0, drive: 0, idle: 0, fuel: 0, fuelN: 0, n: 0 };
    o.n++; o.km += num_(r[IT['Km']]); o.drive += num_(r[IT['Conduite (min)']]); o.idle += num_(r[IT['Ralenti moteur tournant (min)']]);
    if (r[IT['Carburant (L)']] !== '') { o.fuel += num_(r[IT['Carburant (L)']]); o.fuelN++; }
  });
  const A = readTop_(S.ALERT, today), IA = A.I, nAl = {};
  A.rows.forEach(r => { const k = plateKey_(r[IA['Plaque']]); nAl[k] = (nAl[k] || 0) + 1; });
  let nRun = 0, nIdle = 0, nOff = 0, nMute = 0;
  const rows = Object.values(veh).filter(v => v.active).map(v => {
    const x = status[v.key] || {}, d = x.dsi, o = tot[v.key] || { km: 0, drive: 0, idle: 0, fuel: 0, fuelN: 0, n: 0 };
    const c = findContract_(cidx, v.key, now, 0);
    const last = d && d.dateTime ? new Date(d.dateTime) : null, age = last ? (now - last.getTime()) / MIN : null;
    let etat;
    if (!v.geoId) etat = 'Non relié à Geotab';
    else if (!d) etat = 'Pas de réponse Geotab';
    else if (d.isDeviceCommunicating === false && age > 30) { etat = 'Boîtier hors ligne'; nMute++; }
    else if (d.isDriving) { etat = 'En route'; nRun++; }
    else if (x.ignOn) { etat = 'Arrêté, contact mis'; nIdle++; }
    else { etat = 'Garé'; nOff++; }
    const dm = d ? durMin_(d.currentStateDuration) : null;
    return [v.plate + (v.aliases && v.aliases.length ? ' / ' + v.aliases.join(', ') : ''), v.model, etat, d && d.isDriving ? Math.round(+d.speed || 0) : 0, dm != null ? hv_(dm / 60) : '', last || '',
      c ? c.nom : 'Aucun contrat', c ? c.num : '', r1_(o.km), hv_(o.drive / 60), hv_(o.idle / 60), o.fuelN ? r1_(o.fuel) : NM, nAl[v.key] || 0,
      d ? mapLink_(d.latitude, d.longitude) : ''];
  });
  const order = { 'En route': 0, 'Arrêté, contact mis': 1, 'Garé': 2, 'Boîtier hors ligne': 3 };
  rows.sort((a, b) => (order[a[2]] !== undefined ? order[a[2]] : 9) - (order[b[2]] !== undefined ? order[b[2]] : 9) || String(a[0]).localeCompare(String(b[0])));
  cards_(s, 4, [['En route', nRun, F0, '#00704A'], ['Arrêtés contact mis', nIdle, F0, nIdle ? '#BF8F00' : null], ['Garés', nOff, F0],
    ['Boîtiers hors ligne', nMute, F0, nMute ? '#C00000' : null]]);
  const t = table_(s, 7, 'Véhicules', ['Plaque', 'Modèle', 'État', 'Vitesse (km/h)', 'Depuis', 'Dernière position', 'Chauffeur sous contrat', 'Contrat',
    'Km aujourd\'hui', 'Conduite aujourd\'hui', 'Ralenti aujourd\'hui', 'Carburant aujourd\'hui (L)', 'Alertes du jour', 'Carte'], rows,
    [null, null, null, F0, FH, FDT, null, null, F1, FH, FH, F1, F0, null]);
  const cf = [];
  [['En route', '#C6EFCE', '#006100'], ['Arrêté, contact mis', '#FFEB9C', '#9C5700'], ['Boîtier hors ligne', '#FFC7CE', '#9C0006']].forEach(x =>
    cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(x[0]).setBackground(x[1]).setFontColor(x[2]).setBold(true).setRanges([colRange_(s, t, 2)]).build()));
  cf.push(greyNM_(colRange_(s, t, 11)));
  s.setConditionalFormatRules(cf);
  widths_(s, 1, [175, 85, 150, 80, 80, 115, 190, 80, 85, 90, 90, 95, 75, 280]);
}

// ---------- Collecteur (déclencheur toutes les 5 min) ----------
/** Véhicule-jours à finaliser : journées terminées depuis plus de 12 h, pas encore finalisées (au plus catchupDays jours en arrière) */
function dueFinal_(P) {
  const fin = doneVehDays_(), list = Object.values(vehicles_()).filter(v => v.active && v.geoId), now = Date.now(), today = localDay_(now), q = [];
  for (let i = Math.max(1, P.catchupDays || 7); i >= 1; i--) {
    const d = addDays_(today, -i); if (dayBounds_(d).end.getTime() + 12 * HOUR > now) continue;
    list.forEach(v => { if (!fin[v.key + '|' + d]) q.push({ d, k: v.key }); });
  }
  return q;
}
function collect() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;                     // une action est en cours : prochain passage dans 5 min
  if (syncLease_()) { lock.releaseLock(); return; }
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_V') !== SCHEMA_V) { lock.releaseLock(); migrateV6(); return; }
  HOLDS_LOCK_ = true;
  const t0 = Date.now(), P = params_(), msg = [];
  try {
    let live = null;
    try {
      live = liveRun_(t0, 100000); renderLive_(live.status);
      if (live.n) props.setProperty('LIVE_COUNT', String(+(props.getProperty('LIVE_COUNT') || 0) + live.n));
      if (live.warn.length) msg.push(live.warn.join(' ; '));
    } catch (e) { msg.push('Erreur temps réel : ' + e.message); }
    // Contrats injectés pendant une collecte : calcul complet maintenant
    const pend = props.getProperty('INJECT_PENDING');
    if (pend) { props.deleteProperty('INJECT_PENDING'); try { afterInject_(pend); } catch (e) { msg.push('Après injection : ' + e.message); } }
    // Priorité à ce que l'utilisateur voit : JOURNALIER / ALERTES des derniers jours, puis tableau de bord et jour
    const every = Math.max(5, P.autoRenderMin || 15) * MIN, lastD = +(props.getProperty('DERIVED_LAST') || 0);
    if (live && live.wrote) markDirty_(localDay_(Date.now() - DAY));
    const dirty = props.getProperty('DERIVED_DIRTY');
    if (dirty && Date.now() - lastD >= every - 30000 && Date.now() - t0 < 150000) {
      try { updateDerived_(dirty); props.deleteProperty('DERIVED_DIRTY'); renderLight_(); props.setProperty('RENDER_LAST', String(Date.now())); }
      catch (e) { msg.push('Tableaux : ' + e.message); }
    }
    // Finalisation des journées terminées avec le temps restant (une seule fois par véhicule-jour, ajout en bas des DATA_*)
    if (Date.now() - t0 < 180000) {
      const due = dueFinal_(P), cur = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]'), seen = {};
      const q = cur.concat(due).filter(x => { const id = x.d + '|' + x.k; if (seen[id]) return false; seen[id] = 1; return true; });
      if (q.length) {
        props.setProperty('SYNC_QUEUE', JSON.stringify(q));
        const r = syncQueueStep_(t0, MAX_RUN_MS - 60000);
        if (r.done) msg.push(r.done + ' véhicule-jours finalisés' + (r.left ? ', ' + r.left + ' restants' : ''));
      }
    }
    // Tous les onglets toutes les 3 h (par étapes)
    const lastFull = +(props.getProperty('RENDER_FULL_LAST') || 0);
    if (Date.now() - lastFull > 3 * HOUR && !props.getProperty('REFRESH_STEPS') && Date.now() - t0 < MAX_RUN_MS - 60000) {
      props.setProperty('RENDER_FULL_LAST', String(Date.now()));
      queueRender_(false);
    }
    // Archivage mensuel des données anciennes
    if (Date.now() - t0 < MAX_RUN_MS - 90000) { try { const a = archiveStep_(); if (a) msg.push(a); } catch (e) { msg.push('Archivage : ' + e.message); } }
    // Journal : événements notables tout de suite, sinon un résumé par heure (pas une ligne toutes les 5 min)
    const lastLog = +(props.getProperty('LIVE_LOG_LAST') || 0);
    if (Date.now() - lastLog >= HOUR) {
      msg.unshift((+(props.getProperty('LIVE_COUNT') || 0)) + ' trajets terminés ajoutés depuis ' + (lastLog ? Utilities.formatDate(new Date(lastLog), TZ, 'HH:mm') : 'le démarrage'));
      props.setProperty('LIVE_LOG_LAST', String(Date.now())); props.setProperty('LIVE_COUNT', '0');
    }
    if (msg.length) log_('Temps réel', msg.join(' | '), t0);
  } catch (e) { log_('Temps réel', 'Erreur : ' + e.message, t0); }
  finally { HOLDS_LOCK_ = false; lock.releaseLock(); }
}
/** Bouton SYNCHRO GEOTAB : collecte immédiate de tous les véhicules + tableaux du jour */
function syncNow() {
  const r = withLock_('Synchro temps réel', () => {
    const t0 = Date.now(), live = liveCatchUp_(MAX_RUN_MS - 150000);
    renderLive_(live.status);
    updateDerived_(localDay_(Date.now() - DAY));
    PropertiesService.getScriptProperties().deleteProperty('DERIVED_DIRTY');
    renderLight_();
    log_('Synchro temps réel', live.n + ' trajets terminés ajoutés' + (live.warn.length ? ' | ' + live.warn.join(' ; ') : ''), t0);
    return live;
  });
  if (r) toast_((r.n ? r.n + ' trajets terminés ajoutés. ' : 'Aucun nouveau trajet terminé. ') + 'Tableau de bord, Du jour et En direct à jour.', 'Synchro Geotab', 8);
}

/** JOURNALIER / ALERTES à recalculer à partir de ce jour (on garde le plus ancien) */
function markDirty_(day) {
  const props = PropertiesService.getScriptProperties(), cur = props.getProperty('DERIVED_DIRTY');
  if (!cur || day < cur) props.setProperty('DERIVED_DIRTY', day);
}
/** Onglets à rendre par étapes (file « Tout actualiser ») ; full = aussi véhicules, règles, chauffeurs */
function queueRender_(full) {
  const props = PropertiesService.getScriptProperties();
  const steps = (full ? ['vehicules', 'regles', 'chauffeurs', 'derives'] : []).concat(['dash', 'today', 'live', 'rank', 'drive', 'idle', 'fills', 'ctrl', 'fiche', 'fin']);
  props.setProperty('REFRESH_STEPS', JSON.stringify(steps));
  props.setProperty('REFRESH_T0', String(Date.now()));
  clearTriggers_('runRefreshQueue');
  ScriptApp.newTrigger('runRefreshQueue').timeBased().after(60 * 1000).create();
}

// ---------- Archivage mensuel ----------
/** Conservation par tableau (jours). Au-delà : copié dans le classeur d'archive puis retiré (la jauge est simplement supprimée). */
function retention_(k, P) {
  return { TRIP: P.retentionDays, EVT: P.retentionDays, FUEL: P.retentionDays, IDL: P.retentionDays, LVL: P.lvlDays || 30, SYNC: (P.retentionDays || 62) + 30, JRN: 400, ALERT: 180 }[k];
}
function archiveBook_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('ARCHIVE_ID'), book = null;
  if (id) { try { book = SpreadsheetApp.openById(id); } catch (e) { book = null; } }
  const cells = b => b.getSheets().reduce((n, s) => n + s.getMaxRows() * s.getMaxColumns(), 0);
  if (!book || cells(book) > 8000000) {
    const n = +(props.getProperty('ARCHIVE_N') || 0) + 1;
    book = SpreadsheetApp.create('Flotte Geotab - Archive' + (n > 1 ? ' ' + n : ''));
    props.setProperty('ARCHIVE_ID', book.getId()); props.setProperty('ARCHIVE_N', String(n));
    log_('Archivage', 'Nouveau classeur d\'archive : ' + book.getUrl());
  }
  return book;
}
/** Une étape d'archivage (un tableau par passage), une fois par mois */
function archiveStep_() {
  const props = PropertiesService.getScriptProperties(), month = localDay_(new Date()).slice(0, 7);
  if (props.getProperty('ARCH_MONTH') === month) return '';
  let todo = JSON.parse(props.getProperty('ARCH_TODO') || 'null');
  if (!todo || !todo.length) todo = ['TRIP', 'EVT', 'FUEL', 'IDL', 'LVL', 'SYNC', 'JRN', 'ALERT'];
  const k = todo.shift(), n = archiveTable_(k);
  if (todo.length) props.setProperty('ARCH_TODO', JSON.stringify(todo));
  else { props.deleteProperty('ARCH_TODO'); props.setProperty('ARCH_MONTH', month); }
  return n ? S[k] + ' : ' + n + ' lignes archivées' : '';
}
function archiveTable_(k) {
  const P = params_(), days = retention_(k, P); if (!(days > 0)) return 0;
  const s = sh_(S[k]); if (!s || s.getLastRow() < 2) return 0;
  const headers = H[k], I = idx_(headers), ci = I[DATE_COL[k]], cutoff = addDays_(localDay_(new Date()), -days);
  const n = s.getLastRow() - 1, dv = s.getRange(2, ci + 1, n, 1).getValues().map(r => toDayStr_(r[0]));
  const old = []; dv.forEach((d, i) => { if (d && d < cutoff) old.push(i); });
  if (!old.length) return 0;
  const prefix = old[old.length - 1] === old.length - 1, suffix = old[0] === n - old.length && old[old.length - 1] === n - 1;
  let rows;
  if (prefix || suffix) rows = s.getRange(2 + old[0], 1, old.length, headers.length).getValues();
  else { const all = s.getRange(2, 1, n, headers.length).getValues(), set = {}; old.forEach(i => { set[i] = 1; }); rows = all.filter((r, i) => set[i]); writeTable_(S[k], headers, all.filter((r, i) => !set[i])); }
  if (k !== 'LVL') {
    const book = archiveBook_(); let a = book.getSheetByName(S[k]);
    if (!a) { a = book.insertSheet(S[k]); a.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold'); a.setFrozenRows(1); }
    const st = a.getLastRow() + 1;
    if (a.getMaxRows() < st + rows.length) a.insertRowsAfter(a.getMaxRows(), st + rows.length - a.getMaxRows());
    if (a.getMaxColumns() < headers.length) a.insertColumnsAfter(a.getMaxColumns(), headers.length - a.getMaxColumns());
    a.getRange(st, 1, rows.length, headers.length).setValues(clean_(rows.map(r => fit_(r, headers.length))));
  }
  if (prefix || suffix) {
    if (s.getMaxRows() <= 1 + old.length) s.insertRowsAfter(s.getMaxRows(), 1);
    s.deleteRows(2 + old[0], old.length);
  }
  idxClear_(S[k]); memoClear_();
  return old.length;
}

// ---------- Changements de plaque (onglet PLAQUES) ----------
/**
 * Lignes de données d'une plaque devenue « autre plaque » d'un véhicule : rattachées à la clé historique du véhicule.
 * Une ligne déjà présente sous la clé historique (même trajet, même événement) est un doublon : retirée.
 */
function rekeyRows_(k, rows, cm) {
  const I = idx_(H[k]), ids = {}, out = [];
  const isAlias = r => { const key = String(r[I['Clé plaque']]); return cm[key] && cm[key] !== key; };
  rows.forEach(r => { if (!isAlias(r)) { ids[String(r[0])] = 1; out.push(r); } });
  rows.forEach(r => {
    if (!isAlias(r)) return;
    const key = String(r[I['Clé plaque']]), c = cm[key], swap = v => String(v).indexOf(key + '|') === 0 ? c + String(v).slice(key.length) : v;
    const id = String(swap(r[0]));
    if (ids[id]) return;
    r[0] = id; r[I['Clé plaque']] = c;
    if (I['Trajet ID'] !== undefined) r[I['Trajet ID']] = swap(r[I['Trajet ID']]);
    ids[id] = 1; out.push(r);
  });
  return out;
}
/** Applique les regroupements de plaques à toutes les données (DATA_*, LIVE_*, DATA_SYNC) : seulement les tableaux concernés */
function rekeyAll_() {
  const cm = canonMap_(), t0 = Date.now(), msg = []; let minDay = '';
  ['TRIP', 'IDL', 'EVT', 'FUEL', 'LVL', 'SYNC', 'LTRIP', 'LIDL', 'LEVT', 'LFUEL', 'LLVL'].forEach(k => {
    const s = sh_(S[k]); if (!s || s.getLastRow() < 2) return;
    const I = idx_(H[k]), col = s.getRange(2, I['Clé plaque'] + 1, s.getLastRow() - 1, 1).getValues();
    if (!col.some(r => { const x = String(r[0]); return cm[x] && cm[x] !== x; })) return;
    const T = readTable_(S[k]), base = k.replace(/^L(?=TRIP|IDL|EVT|FUEL|LVL)/, '');
    T.rows.forEach(r => { const x = String(r[I['Clé plaque']]); if (cm[x] && cm[x] !== x) { const d = k === 'SYNC' ? String(r[0]).split('|')[1] : rowDay_(base, r, I); if (d && (!minDay || d < minDay)) minDay = d; } });
    const rows = rekeyRows_(k, T.rows, cm);
    writeTable_(S[k], H[k], rows);
    msg.push(S[k] + ' : ' + (T.rows.length - rows.length) + ' doublons retirés');
  });
  // état du temps réel des plaques absorbées
  const props = PropertiesService.getScriptProperties(), all = props.getProperties();
  Object.keys(all).forEach(x => { if (x.indexOf('LIVE|') === 0) { const key = x.slice(5); if (cm[key] && cm[key] !== key) props.deleteProperty(x); } });
  memoClear_();
  if (minDay) markDirty_(minDay);
  if (msg.length) log_('Plaques', 'Données rattachées à la plaque historique : ' + msg.join(' | '), t0);
  return minDay;
}
/** Crée / complète l'onglet PLAQUES : changements détectés automatiquement (même châssis) + état de chaque ligne */
function syncPlatesTab_() {
  const s = ensureSheet_(S.PLATES, H.PLATES, '#2E75B6'), I = idx_(H.PLATES);
  const T = readTable_(S.VEH), IV = idx_(H.VEH), cm = canonMap_(), veh = vehicles_();
  const lr = s.getLastRow(), cur = lr > 1 ? s.getRange(2, 1, lr - 1, H.PLATES.length).getValues() : [];
  const seen = {}; cur.forEach(r => { if (r[0] !== '' || r[1] !== '') seen[normPlate_(r[0]) + '>' + normPlate_(r[1])] = 1; });
  // regroupements trouvés par le châssis / le boîtier : proposés dans le tableau (une ligne par ancienne plaque provisoire)
  T.rows.forEach(r => {
    const plates = platesOf_(r, IV), def = plates.filter(p => !isTempPlate_(p)), tmp = plates.filter(isTempPlate_);
    if (!def.length) return;
    tmp.forEach(o => { const k = normPlate_(o) + '>' + normPlate_(def[0]); if (!seen[k]) { seen[k] = 1; cur.push([o, def[0], '', '', '', 'Détecté automatiquement (même châssis / même boîtier Geotab)']); } });
  });
  cur.forEach(r => {
    const o = String(r[0] || '').trim(), n = String(r[1] || '').trim();
    if (!o && !n) return;
    if (!o || !n) { r[3] = ''; r[4] = 'À compléter : ancienne ET nouvelle plaque'; return; }
    const ko = cm[normPlate_(o)], kn = cm[normPlate_(n)];
    const v = veh[ko || kn];
    r[3] = v ? v.plate : '';
    if (ko && kn && ko === kn) r[4] = 'OK : même véhicule, historique conservé';
    else if (ko || kn) r[4] = 'OK : la plaque ' + (ko ? n : o) + ' sera reconnue dans les contrats';
    else r[4] = 'Plaques inconnues (ni dans le Parc ni dans Geotab) : vérifiez l\'orthographe';
  });
  const rows = cur.filter(r => String(r[0]).trim() || String(r[1]).trim());
  if (lr > 1) s.getRange(2, 1, lr - 1, H.PLATES.length).clearContent();
  if (rows.length) {
    s.getRange(2, I['Date du changement'] + 1, rows.length, 1).setNumberFormat('dd/MM/yyyy');
    s.getRange(2, 1, rows.length, H.PLATES.length).setValues(clean_(rows.map(r => fit_(r, H.PLATES.length))));
  }
  s.getRange(2, 1, Math.max(rows.length + 50, 50), 3).setBackground('#FFF2CC');
  s.getRange(2, 6, Math.max(rows.length + 50, 50), 1).setBackground('#FFF2CC');
  s.setColumnWidth(1, 190); s.setColumnWidth(2, 160); s.setColumnWidth(3, 130); s.setColumnWidth(4, 130); s.setColumnWidth(5, 380); s.setColumnWidth(6, 330);
  s.getRange(1, 1).setNote('Saisissez ici chaque changement de plaque : ancienne plaque (WW / W18) et plaque définitive. ' +
    'L\'historique reste rattaché au même véhicule et les contrats saisis avec l\'une ou l\'autre plaque sont reconnus. Mise à jour automatique à la saisie.');
  return rows.length;
}
/** Menu / saisie dans PLAQUES : regroupe les plaques, rattache contrats et données, recalcule */
function appliquerPlaques(silent) {
  return withLock_('Plaques', () => {
    const t0 = Date.now();
    ensureSheet_(S.PLATES, H.PLATES, '#2E75B6');
    importVehicles(true);
    const minDay = rekeyAll_();
    const n = canonContracts_();
    rebuild_(minDay || addDays_(localDay_(new Date()), -7));
    PropertiesService.getScriptProperties().deleteProperty('DERIVED_DIRTY');
    renderLight_(); queueRender_(false);
    log_('Plaques', 'Changements de plaques appliqués' + (n ? ', ' + n + ' contrats rattachés' : ''), t0);
    if (silent !== true) toast_('Plaques appliquées : historique et contrats rattachés, tableaux mis à jour.', 'Plaques', 8);
    return true;
  }, silent === true);
}
/** Déclencheur « modification » : plaque choisie dans FICHE VÉHICULE, ou saisie dans PLAQUES */
function onSheetEdit(e) {
  try {
    if (!e || !e.range) return;
    const name = e.range.getSheet().getName();
    if (name === S.FICHE && e.range.getA1Notation() === 'J1') { withLock_('Fiche véhicule', () => renderFiche_(viewCtx_()), true); return; }
    if (name === S.PLATES && e.range.getColumn() <= 2 && e.range.getRow() >= 2) {
      const r = e.range.getSheet().getRange(e.range.getRow(), 1, 1, 2).getValues()[0];
      if (String(r[0]).trim() && String(r[1]).trim()) appliquerPlaques(true);
    }
  } catch (x) { log_('Modification', x.message); }
}
function onFicheEdit(e) { onSheetEdit(e); }

// ---------- Injection des contrats : tout le reste est automatique ----------
/**
 * Après une injection : automatisation activée si besoin, données Geotab à jour (temps réel + journées passées
 * manquantes des contrats), chauffeurs rattachés à partir du premier contrat modifié, journalier, alertes, tous les onglets.
 */
function afterInject_(fromDay) {
  const t0 = Date.now(), msg = [];
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'collect')) { installTriggers(true); msg.push('automatisation activée (toutes les 5 min)'); }
  try { const live = liveCatchUp_(90000); if (live && live.n) msg.push(live.n + ' trajets récents ajoutés'); } catch (e) { msg.push('temps réel : ' + e.message); }
  // journées passées des contrats jamais téléchargées (dans la période conservée) : file de fond
  try {
    const P = params_(), since = [fromDay, addDays_(localDay_(new Date()), -Math.max(7, P.retentionDays || 62))].sort()[1];
    const miss = missingContractDays_(coverage_(), since).filter(id => dayBounds_(id.split('|')[1]).end.getTime() + 12 * HOUR <= Date.now());
    if (miss.length) {
      const props = PropertiesService.getScriptProperties(), cur = JSON.parse(props.getProperty('SYNC_QUEUE') || '[]'), seen = {};
      const q = cur.concat(miss.map(id => ({ d: id.split('|')[1], k: id.split('|')[0], solo: 1 }))).filter(x => { const k = x.d + '|' + x.k; if (seen[k]) return false; seen[k] = 1; return true; });
      props.setProperty('SYNC_QUEUE', JSON.stringify(q)); ensureSyncTrigger_();
      msg.push(miss.length + ' journées passées à télécharger (en arrière-plan, quelques minutes)');
    }
  } catch (e) { msg.push('journées manquantes : ' + e.message); }
  rebuild_(addDays_(fromDay, -1));
  PropertiesService.getScriptProperties().deleteProperty('DERIVED_DIRTY');
  renderLight_(); queueRender_(false);
  log_('Après injection', msg.join(' | ') || 'OK', t0);
  return msg;
}

// ---------- Migration vers la v6 (une fois, par étapes) ----------
function migrateV6() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { clearTriggers_('migrateV6'); ScriptApp.newTrigger('migrateV6').timeBased().after(60 * 1000).create(); return; }
  HOLDS_LOCK_ = true;
  const t0 = Date.now(), props = PropertiesService.getScriptProperties();
  try {
    clearTriggers_('migrateV6');
    if (props.getProperty('SCHEMA_V') === SCHEMA_V) return;
    let steps = JSON.parse(props.getProperty('MIG_STEPS') || 'null');
    if (!steps) {
      steps = ['tabs', 'sheets', 'veh', 'ctr', 'TRIP', 'IDL', 'EVT', 'FUEL', 'LVL', 'SYNC', 'derived', 'live', 'done'];
      ensureSheet_(S.PLATES, H.PLATES, '#2E75B6');
      const auto = ScriptApp.getProjectTriggers().some(t => ['autoSync', 'collect'].indexOf(t.getHandlerFunction()) >= 0);
      if (props.getProperty('MIG_AUTO') !== '1') props.setProperty('MIG_AUTO', auto ? '1' : '0');
      ['runSyncQueue', 'runRefreshQueue'].forEach(clearTriggers_);
      ['SYNC_QUEUE', 'REPAIR_ROUND', 'AFTER_SYNC_REFRESH', 'REFRESH_STEPS'].forEach(k => props.deleteProperty(k));
      log_('Mise à jour v6', 'Début de la migration des données (' + steps.length + ' étapes)');
    }
    const info = [];
    while (steps.length && Date.now() - t0 < MAX_RUN_MS - 90000) {
      const st = steps[0];
      if (st === 'sheets') DATA_SHEETS.forEach(k => ensureSheet_(S[k], H[k], '#999999'));
      else if (st === 'veh') { try { importVehicles(true); } catch (e) { info.push('véhicules : ' + e.message); } }
      else if (st === 'ctr') info.push(canonContracts_() + ' contrats rattachés à la plaque principale');
      else if (['TRIP', 'IDL', 'EVT', 'FUEL', 'LVL'].indexOf(st) >= 0) info.push(migrateTable_(st));
      else if (st === 'SYNC') info.push(migrateSync_());
      else if (st === 'tabs') {
        ss_().getSheets().filter(x => x.getName().indexOf(VEH_PREFIX) === 0).forEach(x => ss_().deleteSheet(x));
        if (!sh_(S.LIVE)) { const x = ss_().insertSheet(S.LIVE); x.setTabColor('#00704A'); x.setHiddenGridlines(true); }
        if (!sh_(S.FICHE)) { const x = ss_().insertSheet(S.FICHE); x.setTabColor('#00704A'); x.setHiddenGridlines(true); }
        try { const ss = ss_(); [S.DASH, S.LIVE, S.TODAY].forEach((n, i) => { const x = sh_(n); if (x) { ss.setActiveSheet(x); ss.moveActiveSheet(i + 1); } }); } catch (e) { }
      }
      else if (st === 'derived') {
        const P = params_(), from = addDays_(localDay_(new Date()), -Math.max(7, P.retentionDays || 62)), veh = vehicles_(), rules = rulesMap_();
        const T = readData_(S.TRIP, from), E = readData_(S.EVT, from), F = readData_(S.FUEL, from), Il = readData_(S.IDL, from);
        const jrn = buildJournalier_(T, E, F, veh, rules, P, fauxPositifs_(), contractInfo_());
        writeTable_(S.JRN, H.JRN, jrn);
        buildAlerts_(T, E, F, Il, jrn, veh, rules, P, contractIndex_());
        info.push(jrn.length + ' journées de travail');
      }
      else if (st === 'live') { const all = props.getProperties(); Object.keys(all).filter(k => k.indexOf('LIVE|') === 0).forEach(k => props.deleteProperty(k)); }
      else if (st === 'done') {
        props.setProperty('SCHEMA_V', SCHEMA_V);
        ['NEED_RESYNC', 'SYNC_LIGHT', 'REPAIR_ROUND', 'AFTER_SYNC_REFRESH'].forEach(k => props.deleteProperty(k));
        if (props.getProperty('MIG_AUTO') === '1') installTriggers(true);
        props.deleteProperty('MIG_STEPS'); props.deleteProperty('MIG_AUTO');
        markDirty_(addDays_(localDay_(new Date()), -1));
        queueRender_(false);
      }
      steps.shift(); props.deleteProperty('MIG_FAIL');
      if (steps.length) props.setProperty('MIG_STEPS', JSON.stringify(steps));
    }
    memoClear_();
    if (steps.length) {
      ScriptApp.newTrigger('migrateV6').timeBased().after(60 * 1000).create();
      log_('Mise à jour v6', info.filter(Boolean).join(' | ') + ' | ' + steps.length + ' étapes restantes, reprise dans 1 min', t0);
    } else log_('Mise à jour v6', 'Terminée. ' + info.filter(Boolean).join(' | '), t0);
  } catch (e) {
    const nf = +(props.getProperty('MIG_FAIL') || 0) + 1; props.setProperty('MIG_FAIL', String(nf));
    const wait = nf >= 5 ? 15 : 1;
    log_('Mise à jour v6', 'Interruption Google : ' + e.message + ' (reprise automatique dans ' + wait + ' min, rien à faire)', t0);
    clearTriggers_('migrateV6'); ScriptApp.newTrigger('migrateV6').timeBased().after(wait * 60 * 1000).create();
  } finally { HOLDS_LOCK_ = false; lock.releaseLock(); }
}
/**
 * Nettoyage d'un tableau DATA_* : lignes des plaques en double (même véhicule) retirées, événements hors conduite retirés,
 * lignes provisoires des journées pas encore finalisées retirées (refaites par le temps réel / la finalisation),
 * chauffeurs rattachés, tri chronologique (les ajouts suivants se font en bas).
 */
function migrateTable_(k) {
  const T = readTable_(S[k]); if (!T.rows.length) return '';
  const P = params_(), I = idx_(H[k]), cm = canonMap_(), fin = doneVehDays_(), rules = rulesMap_();
  const lim = addDays_(localDay_(new Date()), -Math.max(1, P.catchupDays || 7));
  let dupV = 0, evt = 0, prov = 0;
  const n0 = T.rows.length, rk = rekeyRows_(k, T.rows, cm); dupV = n0 - rk.length;
  const keep = rk.filter(r => {
    const key = String(r[I['Clé plaque']]);
    if (k === 'EVT' && !keepEvt_(rules, r[I['Règle ID']])) { evt++; return false; }
    const d = rowDay_(k, r, I);
    if (d >= lim && !fin[key + '|' + d]) { prov++; return false; }
    return true;
  });
  if (k !== 'LVL') attribRows_(k, keep, attribCtx_());
  const tc = k === 'LVL' ? I['Horodatage'] : I[ATTR_TIME[k]];
  keep.sort((a, b) => tms_(a[tc]) - tms_(b[tc]));
  writeTable_(S[k], H[k], keep);
  memoClear_();
  return S[k] + ' : ' + keep.length + ' lignes' + (dupV ? ', ' + dupV + ' en double (autre plaque du même véhicule, déjà présentes sous la plaque historique)' : '') +
    (evt ? ', ' + evt + ' événements hors conduite retirés' : '') + (prov ? ', ' + prov + ' provisoires retirées' : '');
}
function migrateSync_() {
  const T = readTable_(S.SYNC); if (!T.rows.length) return '';
  const P = params_(), I = idx_(H.SYNC), cm = canonMap_(), fin = doneVehDays_();
  const lim = addDays_(localDay_(new Date()), -Math.max(1, P.catchupDays || 7));
  const E = readTable_(S.EVT), IE = idx_(H.EVT), ne = {};
  E.rows.forEach(r => { const id = String(r[IE['Clé plaque']]) + '|' + rowDay_('EVT', r, IE); ne[id] = (ne[id] || 0) + 1; });
  const keep = rekeyRows_('SYNC', T.rows, cm).filter(r => {
    const key = String(r[I['Clé plaque']]), id = String(r[I['Clé']]), d = id.split('|')[1];
    if (d >= lim && !fin[id]) return false;
    return true;
  });
  keep.forEach(r => { r[I['Événements']] = ne[String(r[I['Clé']])] || 0; });
  keep.sort((a, b) => String(a[I['Clé']].split('|')[1]).localeCompare(String(b[I['Clé']].split('|')[1])) || String(a[1]).localeCompare(String(b[1])));
  writeTable_(S.SYNC, H.SYNC, keep);
  return S.SYNC + ' : ' + keep.length + ' véhicule-jours finalisés';
}
/** Menu : archivage immédiat (tous les tableaux) */
function archiveNow() {
  withLock_('Archivage', () => {
    const t0 = Date.now(), out = [];
    ['TRIP', 'EVT', 'FUEL', 'IDL', 'LVL', 'SYNC', 'JRN', 'ALERT'].forEach(k => { const n = archiveTable_(k); if (n) out.push(S[k] + ' : ' + n); });
    log_('Archivage', out.length ? out.join(' | ') : 'Rien à archiver', t0);
    toast_(out.length ? 'Archivé : ' + out.join(', ') : 'Rien à archiver.', 'Archivage', 8);
  });
}

// ============================================================================
// 9. RECALCUL : RATTACHEMENT CHAUFFEURS, JOURNÉES (CONTRATS), ALERTES
// ============================================================================
/** Menu « Recalculer » : chauffeurs rattachés de nouveau (31 derniers jours), journalier, alertes, tous les onglets */
function recompute() {
  withLock_('Recalculer', () => {
    const t0 = Date.now();
    const r = rebuild_();
    PropertiesService.getScriptProperties().deleteProperty('DERIVED_DIRTY');
    renderAll_();
    log_('Recalcul', 'OK (' + r.jrn + ' journées de travail, ' + r.alerts + ' alertes sur 31 jours)', t0);
    toast_('Tableaux à jour.', 'Flotte Geotab');
  });
}
/** Bouton ACTUALISER : journalier et alertes de la période affichée, puis tous les onglets (les données sont déjà à jour) */
function actualiser() {
  withLock_('Actualiser', () => {
    const t0 = Date.now(), today = localDay_(new Date()), p = period_(), props = PropertiesService.getScriptProperties();
    const dirty = props.getProperty('DERIVED_DIRTY'), from = [p.from, addDays_(today, -2), dirty || today].sort()[0];
    updateDerived_(from); props.deleteProperty('DERIVED_DIRTY');
    renderAll_();
    log_('Actualiser', 'OK', t0);
    toast_('Tableaux à jour.', 'Flotte Geotab');
  });
}
function refreshViews(silent) { withLock_('Actualiser les tableaux', () => { renderAll_(); if (silent !== true) toast_('Tableaux à jour.', 'Flotte Geotab'); }, silent === true); }

/**
 * TOUT ACTUALISER : véhicules, association Geotab, règles, chauffeurs, rattachement aux contrats, alertes,
 * puis tous les onglets. Exécuté par étapes : si Google approche la limite de 6 min, la suite reprend toute seule.
 */
function toutActualiser() {
  const steps = ['vehicules', 'regles', 'chauffeurs', 'derives', 'dash', 'today', 'live', 'rank', 'drive', 'idle', 'fills', 'ctrl', 'fiche', 'fin'];
  PropertiesService.getScriptProperties().setProperty('REFRESH_STEPS', JSON.stringify(steps));
  PropertiesService.getScriptProperties().setProperty('REFRESH_T0', String(Date.now()));
  toast_('Mise à jour complète lancée (' + steps.length + ' étapes).', 'Tout actualiser', 8);
  runRefreshQueue();
}
function runRefreshQueue() {
  if (waitMigration_('runRefreshQueue')) return;
  const lock = LockService.getScriptLock();
  const retry = () => { clearTriggers_('runRefreshQueue'); ScriptApp.newTrigger('runRefreshQueue').timeBased().after(60 * 1000).create(); };
  if (!lock.tryLock(20000)) { retry(); toast_('Collecte en cours : la mise à jour des onglets démarre dans 1 minute.', 'Tout actualiser', 8); return; }
  const t0 = Date.now(), props = PropertiesService.getScriptProperties();
  if (syncLease_()) { lock.releaseLock(); retry(); toast_('Finalisation des journées en cours : la mise à jour des onglets démarre dans 1 minute.', 'Tout actualiser', 8); return; }
  HOLDS_LOCK_ = true;
  try {
    clearTriggers_('runRefreshQueue');
    let steps = JSON.parse(props.getProperty('REFRESH_STEPS') || '[]');
    let ctx = null; const getCtx = () => ctx || (ctx = viewCtx_());
    const errs = [];
    while (steps.length && Date.now() - t0 < MAX_RUN_MS - 45000) {
      const st = steps[0];
      // la collecte temps réel passe en priorité : si elle attend depuis plus de 6 min, on lui laisse la place
      const lastLive = +(props.getProperty('LIVE_LAST') || 0), auto = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'collect');
      if (auto && lastLive && Date.now() - lastLive > 6 * MIN && Date.now() - t0 > 5000) break;
      try {
        if (st === 'vehicules') { importVehicles(true); }
        else if (st === 'regles') { syncRules_(); }
        else if (st === 'chauffeurs') { refreshDrivers_(); }
        else if (st === 'recalcul' || st === 'derives') { const p = period_(), d = [p.from, addDays_(localDay_(new Date()), -7)].sort()[0]; updateDerived_(d); props.deleteProperty('DERIVED_DIRTY'); ctx = null; }
        else if (st === 'live') { try { renderLive_(liveRun_(Date.now(), 60000).status); } catch (e) { errs.push('live : ' + e.message); } }
        else if (st === 'fiche') renderFiche_(getCtx());
        else if (st === 'dash') renderDashboard_(getCtx());
        else if (st === 'today') renderToday_(getCtx());
        else if (st === 'rank') renderRanking_(getCtx());
        else if (st === 'drive') renderDriving_(getCtx());
        else if (st === 'idle') renderIdle_(getCtx());
        else if (st === 'fills') renderFills_(getCtx());
        else if (st === 'ctrl') renderControl_(getCtx());
        else if (st === 'fin') { log_('Tout actualiser', 'Terminé', Number(props.getProperty('REFRESH_T0')) || t0); toast_('Tout est à jour.', 'Tout actualiser', 8); }
      } catch (e) { errs.push(st + ' : ' + e.message); }
      steps.shift();
      props.setProperty('REFRESH_STEPS', JSON.stringify(steps));
    }
    if (errs.length) log_('Tout actualiser', 'Erreurs : ' + errs.join(' | '), t0);
    if (steps.length) {
      ScriptApp.newTrigger('runRefreshQueue').timeBased().after(60 * 1000).create();
      log_('Tout actualiser', steps.length + ' étapes restantes, reprise automatique dans 1 min', t0);
      toast_(steps.length + ' étapes restantes, reprise automatique dans 1 minute.', 'Tout actualiser', 8);
    }
  } finally { HOLDS_LOCK_ = false; lock.releaseLock(); }
}


/**
 * Recalcul v6 à partir de fromDay (par défaut 31 jours) : chauffeurs rattachés de nouveau sur la fin des tableaux
 * (DATA_* et LIVE_*), puis JOURNALIER et ALERTES. Les données plus anciennes ne bougent pas.
 */
function rebuild_(fromDay) {
  const today = localDay_(new Date()), P = params_();
  const oldest = addDays_(today, -Math.max(7, P.retentionDays || 62));
  fromDay = fromDay && fromDay > oldest ? fromDay : (fromDay ? oldest : addDays_(today, -31));
  reattribute_(fromDay);
  return updateDerived_(fromDay);
}
/** Réécrit seulement les colonnes chauffeur (et nom de règle / chauffeur suivant) des lignes datées à partir de fromDay */
function reattribute_(fromDay) {
  const ctx = attribCtx_();
  ['TRIP', 'IDL', 'EVT', 'FUEL'].forEach(k => [S[k], S[LIVE_OF[k]]].forEach(name => {
    const A = readFrom_(name, fromDay); if (!A.rows.length) return;
    const I = idx_(H[k]), cols = ['Code chauffeur', 'Chauffeur', 'Contrat'].concat(k === 'EVT' ? ['Règle'] : k === 'FUEL' ? ['Chauffeur suivant'] : []).map(h => I[h]);
    const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
    const rows = A.rows.map(r => r.slice()), live = rows.filter(r => r[0] !== '');
    attribRows_(k, live, ctx);
    A.s.getRange(A.start, c0 + 1, rows.length, c1 - c0 + 1).setValues(clean_(rows.map(r => r.slice(c0, c1 + 1))));
  }));
  memoClear_();
}

/** Contrats par numéro (horaires réels) */
function contractInfo_() {
  const T = readTable_(S.CTR), I = idx_(H.CTR), m = {};
  T.rows.forEach(r => { m[String(r[I['N° contrat']])] = { start: toDate_(r[I['Début']]), end: toDate_(r[I['Fin']]), code: String(r[I['Code client']]), nom: String(r[I['Nom']]), key: String(r[I['Clé plaque']]) }; });
  return m;
}

/**
 * Une ligne par contrat = une journée de travail selon les horaires du contrat (ex. 20h43 → 08h01).
 * Les trajets sans contrat sont regroupés par jour calendaire et par véhicule.
 */
function buildJournalier_(T, E, F, veh, rules, P, faux, ctrs) {
  faux = faux || {}; ctrs = ctrs || {};
  const IT = idx_(H.TRIP), IE = idx_(H.EVT), IF = idx_(H.FUEL);
  const agg = {};
  const get = (num, day, key, code, nom) => {
    const k = num ? 'C|' + num : 'H|' + day + '|' + key;
    return agg[k] || (agg[k] = { k, num, day, key, code, nom, n: 0, km: 0, drive: 0, idle: 0, idleLong: 0, nLong: 0, idleSrcs: {}, idleFuelSrcs: {},
      fuel: 0, fuelKm: 0, srcs: {}, idleFuel: 0, idleFuelN: 0, vmax: 0, limVmax: '', worst: null, evts: 0, pts: 0,
      pleins: 0, pleinsL: 0, siph: 0, siphL: 0, kmHors: 0 });
  };
  T.rows.forEach(r => {
    const a = get(String(r[IT['Contrat']] || ''), toDayStr_(r[IT['Date']]), String(r[IT['Clé plaque']]), String(r[IT['Code chauffeur']]), String(r[IT['Chauffeur']]));
    const km = num_(r[IT['Km']]);
    a.n++; a.km += km; a.drive += num_(r[IT['Conduite (min)']]);
    const isrc = String(r[IT['Source ralenti']] || 'Régime moteur');
    a.idle += num_(r[IT['Ralenti moteur tournant (min)']]); a.idleSrcs[isrc] = 1;
    a.idleLong += num_(r[IT['Ralenti prolongé (min)']]); a.nLong += num_(r[IT['Nb ralentis prolongés']]);
    const src = String(r[IT['Source carburant']] || 'Non mesuré');
    if (src !== 'Non mesuré' && r[IT['Carburant (L)']] !== '') { a.fuel += num_(r[IT['Carburant (L)']]); a.fuelKm += km; a.srcs[src] = 1; }
    if (r[IT['Carburant ralenti (L)']] !== '') { a.idleFuel += num_(r[IT['Carburant ralenti (L)']]); a.idleFuelN++; a.idleFuelSrcs[r[IT['Source carburant ralenti']]] = 1; }
    const vm = num_(r[IT['Vmax (km/h)']]);
    if (vm > a.vmax) { a.vmax = vm; a.limVmax = r[IT['Limite à Vmax']]; }
    const w = r[IT['Pire dépassement (km/h)']];
    if (w !== '' && (a.worst === null || num_(w) > a.worst)) a.worst = num_(w);
    if (r[IT['Code chauffeur']] === HORS) a.kmHors += km;
  });
  E.rows.forEach(r => {
    const rid = String(r[IE['Règle ID']]), w = rules[rid] ? rules[rid].w : 0;
    if (w <= 0) return;
    const a = get(String(r[IE['Contrat']] || ''), toDayStr_(r[IE['Date']]), String(r[IE['Clé plaque']]), String(r[IE['Code chauffeur']]), String(r[IE['Chauffeur']]));
    a.evts++; a.pts += w;
  });
  F.rows.forEach(r => {
    const type = r[IF['Type']];
    const a = get(String(r[IF['Contrat']] || ''), toDayStr_(r[IF['Date']]), String(r[IF['Clé plaque']]), String(r[IF['Code chauffeur']]), String(r[IF['Chauffeur']]));
    if (type === 'PLEIN') { a.pleins++; a.pleinsL += num_(r[IF['Litres (jauge)']]); }
    if (type === 'SIPHONAGE_SUSPECT' && r[IF['Statut']] !== 'Faux positif' && !faux['SIPH|' + r[0]]) { a.siph++; a.siphL += -num_(r[IF['Litres (jauge)']]); }
  });
  const now = Date.now();
  return Object.values(agg).map(a => {
    const v = veh[a.key] || { plate: a.key, model: '', price: 0 };
    const c = a.num ? ctrs[a.num] : null;
    const day = c && c.start ? localDay_(c.start) : a.day;
    if (!day) return null;
    const cEnd = c ? (c.end ? c.end.getTime() : now) : null;
    const score = a.km > 0 || a.pts > 0 ? a.pts / Math.max(a.km, P.kmMin) * 100 : 0;
    const srcs = Object.keys(a.srcs), isr = Object.keys(a.idleSrcs), ifs = Object.keys(a.idleFuelSrcs);
    const one = (l, dflt) => l.length ? (l.length > 1 ? 'Mixte' : l[0]) : dflt;
    const fuelOk = a.fuelKm > 0;
    return rowOf_(H.JRN, {
      'Clé': a.k, 'Date': dayToDate_(day), 'Plaque': v.plate, 'Modèle': v.model, 'Code chauffeur': a.code, 'Chauffeur': a.nom,
      'Contrat': a.num, 'Début contrat': c && c.start ? c.start : '', 'Fin contrat': c && c.end ? c.end : '',
      'Durée contrat (h)': c && c.start ? r2_((cEnd - c.start.getTime()) / HOUR) : '', 'Trajets': a.n, 'Km': r1_(a.km),
      'Conduite (h)': r2_(a.drive / 60), 'Ralenti (h)': r2_(a.idle / 60), 'Source ralenti': one(isr, ''), 'Ralenti prolongé (h)': r2_(a.idleLong / 60),
      'Nb ralentis prolongés': a.nLong, 'Carburant (L)': fuelOk ? r1_(a.fuel) : '', 'Km mesurés carburant': r1_(a.fuelKm),
      'L/100 km': a.fuelKm >= P.minFuelKm ? r1_(a.fuel / a.fuelKm * 100) : '',
      'Source carburant': srcs.length ? (srcs.length > 1 ? 'Mixte' : srcs[0]) : 'Non mesuré',
      'Carburant ralenti (L)': a.idleFuelN ? r2_(a.idleFuel) : '', 'Source carburant ralenti': one(ifs, ''),
      'Coût carburant (MAD)': fuelOk && v.price > 0 ? Math.round(a.fuel * v.price) : '',
      'Coût ralenti (MAD)': a.idleFuelN && v.price > 0 ? Math.round(a.idleFuel * v.price) : '',
      'Vmax (km/h)': a.vmax, 'Limite à Vmax': a.limVmax, 'Pire dépassement (km/h)': a.worst === null ? '' : a.worst,
      'Événements': a.evts, 'Points danger': r1_(a.pts), 'Score /100 km': r1_(score), 'Pleins': a.pleins,
      'Litres pleins (jauge)': r1_(a.pleinsL), 'Siphonages suspects': a.siph, 'Litres suspects': r1_(a.siphL), 'Km hors contrat': r1_(a.kmHors)
    });
  }).filter(Boolean).sort((x, y) => y[1] - x[1] || tms_(y[7]) - tms_(x[7]) || String(x[2]).localeCompare(String(y[2])));
}

function buildAlerts_(T, E, F, Il, jrn, veh, rules, P, cidx, cut) {
  const IT = idx_(H.TRIP), IE = idx_(H.EVT), IF = idx_(H.FUEL), II = idx_(H.IDL), IJ = idx_(H.JRN);
  const out = [];
  const add = (key, date, plate, code, nom, type, grav, detail, val, noTime) => {
    const d = date instanceof Date ? date : toDate_(date);
    out.push([key, d ? dayToDate_(localDay_(d)) : '', d && !noTime ? localHM_(d) : '', plate, code, nom, type, grav, detail, val, '', '']);
  };
  const map = (la, lo) => la !== '' && lo !== '' && la != null ? ' https://maps.google.com/?q=' + la + ',' + lo : '';
  // Siphonage
  F.rows.forEach(r => {
    if (r[IF['Type']] !== 'SIPHONAGE_SUSPECT') return;
    const nxt = r[IF['Chauffeur suivant']] ? ' / redémarré par ' + r[IF['Chauffeur suivant']] : '';
    add('SIPH|' + r[0], r[IF['Arrêt début']], r[IF['Plaque']], r[IF['Code chauffeur']], r[IF['Chauffeur']], 'Siphonage suspect', 'Critique',
      'Jauge ' + r[IF['Niveau avant (%)']] + ' % → ' + r[IF['Niveau après (%)']] + ' % pendant un arrêt moteur coupé de ' + r[IF['Durée arrêt (min)']] +
      ' min, sans trajet (' + fmtDT_(r[IF['Arrêt début']]) + ' → ' + fmtDT_(r[IF['Arrêt fin']]) + ')' + nxt + map(r[IF['Lat']], r[IF['Lon']]),
      r[IF['Litres (jauge)']] !== '' ? Math.abs(num_(r[IF['Litres (jauge)']])) + ' L' : r[IF['Écart (%)']] + ' %');
  });
  // Trajets non enregistrés : le compteur km du véhicule avance pendant une coupure du boîtier
  F.rows.forEach(r => {
    if (r[IF['Type']] !== 'TRAJET_NON_ENREGISTRE') return;
    add('TNE|' + r[0], r[IF['Arrêt début']], r[IF['Plaque']], r[IF['Code chauffeur']], r[IF['Chauffeur']], 'Trajet non enregistré (boîtier coupé)', 'Critique',
      'Boîtier Geotab sans contact de ' + fmtDT_(r[IF['Arrêt début']]) + ' à ' + fmtDT_(r[IF['Arrêt fin']]) + ' mais le compteur kilométrique du véhicule a avancé de ' +
      String(r[IF['Moteur']]).split(' ')[0] + ' km' + (r[IF['Litres (jauge)']] !== '' ? ', jauge ' + r[IF['Litres (jauge)']] + ' L' : '') +
      '. Le véhicule a roulé sans être suivi : boîtier débranché, privé d\'alimentation ou en panne' + map(r[IF['Lat']], r[IF['Lon']]), String(r[IF['Moteur']]).split(' ')[0] + ' km');
  });
  // Vitesse
  T.rows.forEach(r => {
    const vm = num_(r[IT['Vmax (km/h)']]), w = r[IT['Pire dépassement (km/h)']];
    if (vm >= P.vmaxAlert) add('VIT|' + r[0], r[IT['Début']], r[IT['Plaque']], r[IT['Code chauffeur']], r[IT['Chauffeur']], 'Vitesse excessive', 'Haute',
      'Vmax ' + vm + ' km/h' + (r[IT['Limite à Vmax']] !== '' ? ' (limite de la route ' + r[IT['Limite à Vmax']] + ' km/h)' : '') + ', trajet du ' + fmtDT_(r[IT['Début']]), vm + ' km/h');
    if (w !== '' && num_(w) >= P.overAlert) add('DEP|' + r[0], r[IT['Début']], r[IT['Plaque']], r[IT['Code chauffeur']], r[IT['Chauffeur']], 'Dépassement limite', 'Haute',
      r[IT['Vitesse au pire']] + ' km/h pour ' + r[IT['Limite au pire']] + ' km/h autorisés à ' + r[IT['Heure pire']], '+' + w + ' km/h');
  });
  // Ralenti prolongé : chaque arrêt moteur allumé au-delà du seuil d'alerte
  Il.rows.forEach(r => {
    const d = idleCounted_(r);
    if (d < P.idleAlertMin) return;
    const ver = r[II['Vérification moteur']] === 'Régime moteur';
    add('RALP|' + r[0], r[II['Début']], r[II['Plaque']], r[II['Code chauffeur']], r[II['Chauffeur']], 'Ralenti prolongé', d >= 2 * P.idleAlertMin ? 'Haute' : 'Moyenne',
      'Véhicule immobile de ' + localHM_(toDate_(r[II['Début']])) + ' à ' + localHM_(toDate_(r[II['Fin']])) + ' (' + r[II['Durée arrêt (min)']] + ' min), ' +
      (ver ? 'moteur thermique tournant ' + d + ' min (régime moteur)' : 'contact mis, régime moteur non disponible') +
      (r[II['Litres']] !== '' ? ', ' + r[II['Litres']] + ' L (' + r[II['Source litres']] + ')' : '') + map(r[II['Lat']], r[II['Lon']]), d + ' min');
  });
  // Événements moteur / boîtier
  const motor = {};
  E.rows.forEach(r => {
    const rid = String(r[IE['Règle ID']]), cat = rules[rid] ? rules[rid].cat : '';
    if (cat === 'Moteur') { const k = toDayStr_(r[IE['Date']]) + '|' + r[IE['Clé plaque']]; (motor[k] = motor[k] || { r, n: 0 }).n++; }
    if (cat === 'Collision') add('COL|' + r[0], r[IE['Début']], r[IE['Plaque']], r[IE['Code chauffeur']], r[IE['Chauffeur']], 'Collision', 'Critique', r[IE['Règle']] + ' détectée par le boîtier Geotab', '');
    if (cat === 'Boîtier') add('BOI|' + r[0], r[IE['Début']], r[IE['Plaque']], r[IE['Code chauffeur']], r[IE['Chauffeur']], 'Boîtier Geotab', 'Critique', r[IE['Règle']], '');
  });
  Object.keys(motor).forEach(k => { const m = motor[k], r = m.r;
    add('MOT|' + k, r[IE['Début']], r[IE['Plaque']], r[IE['Code chauffeur']], r[IE['Chauffeur']], 'Défaut moteur', 'Moyenne',
      m.n + ' événement(s) ' + r[IE['Règle']] + ', premier à ' + localHM_(toDate_(r[IE['Début']])), m.n, true); });
  // Par journée de travail (contrat)
  jrn.forEach(j => {
    const key = j[IJ['Clé']], d = j[IJ['Date']], code = j[IJ['Code chauffeur']], nom = j[IJ['Chauffeur']], pl = j[IJ['Plaque']];
    const horaires = j[IJ['Début contrat']] ? ' (contrat ' + j[IJ['Contrat']] + ', ' + fmtDT_(j[IJ['Début contrat']]) + ' → ' + (j[IJ['Fin contrat']] ? fmtDT_(j[IJ['Fin contrat']]) : 'en cours') + ')' : '';
    const longMin = Math.round(num_(j[IJ['Ralenti prolongé (h)']]) * 60);
    if (longMin >= P.idleDayMin) add('RALJ|' + key, d, pl, code, nom, 'Ralenti prolongé sur la journée', longMin >= 2 * P.idleDayMin ? 'Haute' : 'Moyenne',
      j[IJ['Nb ralentis prolongés']] + ' arrêts moteur allumé totalisant ' + fmtH_(longMin / 60) + horaires +
      (j[IJ['Carburant ralenti (L)']] !== '' ? ', ' + j[IJ['Carburant ralenti (L)']] + ' L au ralenti' : ''), fmtH_(longMin / 60), true);
    if (code === HORS && nom === 'Hors contrat' && num_(j[IJ['Km']]) >= 1) add('HC|' + key, d, pl, code, nom, 'Usage hors contrat', 'Haute',
      j[IJ['Km']] + ' km roulés sans contrat actif (' + j[IJ['Trajets']] + ' trajets)', j[IJ['Km']] + ' km', true);
    const v = veh[plateKey_(pl)], l100 = j[IJ['L/100 km']];
    if (v && v.ref > 0 && l100 !== '' && num_(l100) > v.ref * (1 + P.overConsPct / 100))
      add('CONSO|' + key, d, pl, code, nom, 'Surconsommation', 'Moyenne', l100 + ' L/100 km mesurés (' + j[IJ['Source carburant']] + ') pour ' + v.ref + ' de référence' + horaires, l100 + ' L/100', true);
    const sc = num_(j[IJ['Score /100 km']]);
    if (code !== HORS && sc >= P.scoreR && num_(j[IJ['Km']]) >= P.kmMin) add('DANG|' + key, d, pl, code, nom, 'Conduite dangereuse', 'Haute',
      j[IJ['Événements']] + ' événements, ' + j[IJ['Points danger']] + ' points sur ' + j[IJ['Km']] + ' km' + horaires, sc + ' /100 km', true);
  });
  // Aucune donnée Geotab alors qu'un contrat est actif
  const Sy = readTable_(S.SYNC), IS = idx_(H.SYNC);
  Sy.rows.forEach(r => {
    if (num_(r[IS['Trajets']]) > 0) return;
    const key = String(r[IS['Clé plaque']]), day = toDayStr_(r[IS['Date']]); if (!day || (cut && day < cut)) return;
    const b = dayBounds_(day), end = Math.min(b.end.getTime(), Date.now());
    let covered = 0, who = null;
    (cidx[key] || []).forEach(c => { const ov = Math.min(c.end, end) - Math.max(c.start, b.start.getTime()); if (ov > 0) { covered += ov; who = c; } });
    if (covered >= 3 * HOUR && who) add('NODATA|' + key + '|' + day, dayToDate_(day), (veh[key] || {}).plate || key, who.code, who.nom, 'Aucune donnée Geotab', 'Haute',
      'Contrat actif ' + Math.round(covered / HOUR) + ' h sans aucun trajet remonté : véhicule immobile ou boîtier débranché', Math.round(covered / HOUR) + ' h', true);
  });
  // Nouveaux chauffeurs
  const D = readTable_(S.DRV), ID = idx_(H.DRV);
  D.rows.forEach(r => { if (r[ID['Statut']] === 'NOUVEAU') add('NEW|' + r[0], r[ID['Détecté le']] || r[ID['Premier contrat']], '', r[0], r[1], 'Nouveau chauffeur', 'Info',
    'Premier contrat le ' + fmtDT_(r[ID['Premier contrat']]) + (r[ID['Note']] ? ' | ' + r[ID['Note']] : ''), '', true); });
  // v6 : seulement les alertes datées à partir de cut (le reste du tableau n'est pas touché)
  const outC = cut ? out.filter(r => r[1] && toDayStr_(r[1]) >= cut) : out;
  // Fusion avec les statuts existants
  const A = cut ? readTop_(S.ALERT, cut) : readTable_(S.ALERT), IA = idx_(H.ALERT), old = {};
  A.rows.forEach(r => { old[String(r[0])] = r; });
  outC.forEach(r => { const o = old[r[0]]; r[IA['Statut']] = o ? o[IA['Statut']] : 'À traiter'; r[IA['Commentaire']] = o ? o[IA['Commentaire']] : ''; });
  outC.sort(alertSort_);
  if (!cut) writeTable_(S.ALERT, H.ALERT, outC);
  return outC;
}

/** 2,58 h -> "2h35" */
function fmtH_(h) { const m = Math.round(num_(h) * 60); return Math.floor(m / 60) + 'h' + ('0' + (m % 60)).slice(-2); }

/** Minutes de ralenti prolongé retenues pour un arrêt : moteur tournant si vérifié, sinon durée de l'arrêt contact mis */
function idleCounted_(r) {
  const I = idx_(H.IDL);
  return r[I['Vérification moteur']] === 'Régime moteur' ? num_(r[I['Moteur tournant (min)']]) : num_(r[I['Durée arrêt (min)']]);
}

// ============================================================================
// 10. RENDU DES TABLEAUX
// ============================================================================
function renderAll_() {
  const t0 = Date.now(), ctx = viewCtx_();
  const parts = [renderDashboard_, renderToday_, renderRanking_, renderDriving_, renderIdle_, renderFills_, renderControl_, renderFiche_];
  const keys = ['dash', 'today', 'rank', 'drive', 'idle', 'fills', 'ctrl', 'fiche'];
  const errs = [];
  for (let i = 0; i < parts.length; i++) {
    if (Date.now() - t0 > MAX_RUN_MS - 60000) {   // trop long : on termine via la file « Tout actualiser »
      const props = PropertiesService.getScriptProperties();
      props.setProperty('REFRESH_STEPS', JSON.stringify(keys.slice(i).concat(['fin'])));
      props.setProperty('REFRESH_T0', String(t0));
      clearTriggers_('runRefreshQueue');
      ScriptApp.newTrigger('runRefreshQueue').timeBased().after(60 * 1000).create();
      log_('Rendu', 'Suite des onglets reportée de 1 min (limite de temps Google)');
      break;
    }
    try { parts[i](ctx); } catch (e) { errs.push(parts[i].name + ' : ' + e.message); }
  }
  if (errs.length) log_('Rendu', 'Erreurs : ' + errs.join(' | '), t0);
}
/** Rendu rapide (automatique toutes les 15 min) : tableau de bord et jour, en ne lisant que les jours nécessaires */
function renderLight_() {
  const today = localDay_(new Date()), s = sh_(S.TODAY), d = s ? toDayStr_(s.getRange('B3').getValue()) : '';
  const ctx = viewCtx_([period_().from, addDays_(today, -1), d || today].sort()[0]);
  renderDashboard_(ctx); renderToday_(ctx);
}

/** Contexte des onglets. fromDay = premier jour lu (par défaut : début de la période affichée ou 31 jours, le plus ancien) */
function viewCtx_(fromDay) {
  const P = params_(), veh = vehicles_(), rules = rulesMap_(), today0 = localDay_(new Date());
  if (!fromDay) fromDay = [period_().from, addDays_(today0, -31)].sort()[0];
  const J = readTop_(S.JRN, addDays_(fromDay, -1)), IJ = idx_(H.JRN);
  const jrn = J.rows.map(r => ({ r, day: toDayStr_(r[IJ['Date']]), key: plateKey_(r[IJ['Plaque']]), code: String(r[IJ['Code chauffeur']]), num: String(r[IJ['Contrat']] || '') }));
  const E = readData_(S.EVT, fromDay), IE = idx_(H.EVT);
  const evts = E.rows.map(r => ({ r, day: toDayStr_(r[IE['Date']]), key: String(r[IE['Clé plaque']]), code: String(r[IE['Code chauffeur']]), num: String(r[IE['Contrat']] || ''), rid: String(r[IE['Règle ID']]) }));
  const F = readData_(S.FUEL, fromDay), IF = idx_(H.FUEL);
  const fuels = F.rows.map(r => ({ r, day: toDayStr_(r[IF['Date']]), key: String(r[IF['Clé plaque']]), code: String(r[IF['Code chauffeur']]), t: tms_(r[IF['Arrêt début']]) }));
  const Id = readData_(S.IDL, fromDay), II = idx_(H.IDL);
  const idles = Id.rows.map(r => ({ r, key: String(r[II['Clé plaque']]), code: String(r[II['Code chauffeur']]), num: String(r[II['Contrat']] || ''), t: tms_(r[II['Début']]) }));
  const A = readTop_(S.ALERT, fromDay), IA = idx_(H.ALERT);
  const alerts = A.rows.map(r => ({ r, day: toDayStr_(r[IA['Date']]) }));
  const D = readTable_(S.DRV), ID = idx_(H.DRV), drvName = { [HORS]: 'Hors contrat' };
  D.rows.forEach(r => { drvName[String(r[ID['Code']])] = String(r[ID['Nom']]); });
  const L = readData_(S.LVL, addDays_(today0, -Math.min(31, P.lvlDays || 30))), IL = idx_(H.LVL), lvl = {};
  L.rows.forEach(r => { const t = toDate_(r[IL['Horodatage']]); if (t) (lvl[String(r[IL['Clé plaque']])] = lvl[String(r[IL['Clé plaque']])] || []).push({ t, v: num_(r[IL['Niveau (%)']]) }); });
  Object.keys(lvl).forEach(k => lvl[k].sort((a, b) => a.t - b.t));
  // Jour de la journée de travail (contrat) pour chaque arrêt prolongé
  const ctrDay = {}; jrn.forEach(x => { if (x.num) ctrDay[x.num] = x.day; });
  idles.forEach(x => { x.day = x.num && ctrDay[x.num] ? ctrDay[x.num] : localDay_(x.t); });
  return { P, veh, rules, jrn, evts, fuels, idles, alerts, drvName, lvl, IJ, IE, IF, II, IA, ctrDay, today: localDay_(new Date()), cidx: contractIndex_(), from: fromDay };
}
function period_() {
  const s = sh_(S.DASH), today = localDay_(new Date());
  const sel = (s && s.getRange('B3').getValue()) || '7 derniers jours';
  let from = addDays_(today, -6), to = today;
  switch (sel) {
    case 'Aujourd\'hui': from = today; break;
    case 'Hier': from = to = addDays_(today, -1); break;
    case '30 derniers jours': from = addDays_(today, -29); break;
    case 'Semaine en cours': from = mondayOf_(today); break;
    case 'Mois en cours': from = today.slice(0, 8) + '01'; break;
    case 'Personnalisé': from = toDayStr_(s.getRange('B4').getValue()) || from; to = toDayStr_(s.getRange('B5').getValue()) || to; break;
  }
  return { from, to, label: sel + ' : journées de travail du ' + fmtDay_(from) + ' au ' + fmtDay_(to) };
}
function inP_(day, p) { return day >= p.from && day <= p.to; }
function levelOf_(score, P) { return score >= P.scoreR ? 'Dangereux' : score >= P.scoreO ? 'Élevé' : score >= P.scoreY ? 'Modéré' : 'Faible'; }

// ---------- Agrégations (sur les journées de travail) ----------
function emptyAgg_() {
  return { km: 0, drive: 0, idle: 0, idleLong: 0, nLong: 0, fuel: 0, fuelKm: 0, fuelN: 0, idleFuel: 0, idleFuelN: 0, cost: 0, costN: 0,
    idleCost: 0, idleCostN: 0, ctrH: 0, vmax: 0, limVmax: '', worst: null, evts: 0, pts: 0, pleins: 0, pleinsL: 0, siph: 0, siphL: 0,
    kmHors: 0, trips: 0, days: {}, ctr: {}, names: {}, plates: {}, srcs: {}, idleSrcs: {}, l100: null };
}
function aggJrn_(rows, IJ, keyFn, P) {
  const o = {}, minKm = P ? P.minFuelKm : 30;
  rows.forEach(x => {
    const r = x.r, k = keyFn(x);
    const a = o[k] || (o[k] = Object.assign(emptyAgg_(), { k }));
    a.km += num_(r[IJ['Km']]); a.drive += num_(r[IJ['Conduite (h)']]); a.idle += num_(r[IJ['Ralenti (h)']]);
    if (r[IJ['Source ralenti']]) a.idleSrcs[r[IJ['Source ralenti']]] = 1;
    a.idleLong += num_(r[IJ['Ralenti prolongé (h)']]); a.nLong += num_(r[IJ['Nb ralentis prolongés']]); a.ctrH += num_(r[IJ['Durée contrat (h)']]);
    if (r[IJ['Carburant (L)']] !== '') { a.fuel += num_(r[IJ['Carburant (L)']]); a.fuelKm += num_(r[IJ['Km mesurés carburant']]); a.fuelN++; a.srcs[r[IJ['Source carburant']]] = 1; }
    if (r[IJ['Carburant ralenti (L)']] !== '') { a.idleFuel += num_(r[IJ['Carburant ralenti (L)']]); a.idleFuelN++; }
    if (r[IJ['Coût carburant (MAD)']] !== '') { a.cost += num_(r[IJ['Coût carburant (MAD)']]); a.costN++; }
    if (r[IJ['Coût ralenti (MAD)']] !== '') { a.idleCost += num_(r[IJ['Coût ralenti (MAD)']]); a.idleCostN++; }
    const vm = num_(r[IJ['Vmax (km/h)']]); if (vm > a.vmax) { a.vmax = vm; a.limVmax = r[IJ['Limite à Vmax']]; }
    const w = r[IJ['Pire dépassement (km/h)']]; if (w !== '' && (a.worst === null || num_(w) > a.worst)) a.worst = num_(w);
    a.evts += num_(r[IJ['Événements']]); a.pts += num_(r[IJ['Points danger']]); a.pleins += num_(r[IJ['Pleins']]);
    a.pleinsL += num_(r[IJ['Litres pleins (jauge)']]); a.siph += num_(r[IJ['Siphonages suspects']]); a.siphL += num_(r[IJ['Litres suspects']]);
    a.kmHors += num_(r[IJ['Km hors contrat']]); a.trips += num_(r[IJ['Trajets']]);
    a.days[x.day] = 1; a.names[r[IJ['Chauffeur']]] = 1; a.plates[r[IJ['Plaque']]] = 1;
    if (r[IJ['Contrat']]) a.ctr[r[IJ['Contrat']]] = 1;
  });
  Object.values(o).forEach(a => { a.l100 = a.fuelKm >= minKm ? a.fuel / a.fuelKm * 100 : null; });
  return o;
}
function scoreOf_(a, P) { return a.pts / Math.max(a.km, P.kmMin) * 100; }
function idleSrcTxt_(a) { const s = Object.keys(a.idleSrcs); return s.length ? (s.length > 1 ? 'Mixte' : s[0]) : ''; }
/** Ligne standard d'un arrêt prolongé (preuve) */
const IDLE_HEAD = ['Début', 'Fin', 'Durée arrêt', 'Moteur thermique tournant', 'Vérification', 'Retenu', 'Plaque', 'Chauffeur', 'Contrat', 'Litres', 'Source litres', 'Lieu'];
const IDLE_FMT = ['dd/MM HH:mm', 'dd/MM HH:mm', '[h]:mm', '[h]:mm', null, null, null, null, null, '#,##0.0'];
function idleRow_(ctx, x) {
  const r = x.r, I = ctx.II, ver = r[I['Vérification moteur']] === 'Régime moteur', cnt = idleCounted_(r);
  return [r[I['Début']], r[I['Fin']], num_(r[I['Durée arrêt (min)']]) / 1440, ver ? num_(r[I['Moteur tournant (min)']]) / 1440 : 'non vérifiable',
    ver ? 'Régime moteur' : 'Contact (Geotab)', cnt >= ctx.P.idleLongMin ? 'OUI' : 'NON (moteur arrêté)', r[I['Plaque']], ctx.drvName[x.code] || r[I['Chauffeur']],
    r[I['Contrat']], r[I['Litres']] === '' ? NM : r[I['Litres']], r[I['Source litres']], mapLink_(r[I['Lat']], r[I['Lon']])];
}
function srcTxt_(a) { const s = Object.keys(a.srcs); return s.length ? (s.length > 1 ? 'Mixte' : s[0]) : 'Non mesuré'; }
const NM = 'non mesuré';
function fuelVal_(a) { return a.fuelN ? r1_(a.fuel) : NM; }
function idleFuelVal_(a) { return a.idleFuelN ? r1_(a.idleFuel) : NM; }
function l100Val_(a) { return a.l100 !== null ? r1_(a.l100) : (a.fuelN ? 'km insuffisants' : NM); }
function costVal_(n, v) { return n ? Math.round(v) : ''; }
function hv_(h) { return num_(h) / 24; }   // heures -> valeur durée Sheets

// ---------- Mise en page ----------
const F1 = '#,##0.0', F0 = '#,##0', FP = '0.0"%"', FD = 'dd/MM/yyyy', FH = '[h]:mm', FDT = 'dd/MM HH:mm';
function resetView_(s, fromRow) {
  const mr = s.getMaxRows(), mc = s.getMaxColumns();
  if (mr >= fromRow) { const rg = s.getRange(fromRow, 1, mr - fromRow + 1, mc); rg.breakApart(); rg.clear(); rg.clearDataValidations(); }
  s.setConditionalFormatRules([]);
  s.getCharts().forEach(c => { try { s.removeChart(c); } catch (e) { } });
}
function ensureSize_(s, rows, cols) {
  if (s.getMaxRows() < rows) s.insertRowsAfter(s.getMaxRows(), rows - s.getMaxRows());
  if (s.getMaxColumns() < cols) s.insertColumnsAfter(s.getMaxColumns(), cols - s.getMaxColumns());
}
function title_(s, text, sub) {
  s.getRange('A1').setValue(text).setFontSize(18).setFontWeight('bold').setFontColor(C_HEAD);
  if (sub !== undefined) s.getRange('A2').setValue(sub).setFontColor('#7F7F7F');
}
/** Tableau : valeurs + formats en un seul appel chacun */
function table_(s, row, title, headers, rows, fmts) {
  ensureSize_(s, row + rows.length + 4, headers.length + 1);
  if (title) { s.getRange(row, 1).setValue(title).setFontWeight('bold').setFontSize(12).setFontColor(C_SEC); row++; }
  s.getRange(row, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground(C_HEAD)
    .setFontColor('#FFFFFF').setWrap(true).setVerticalAlignment('middle');
  s.setRowHeight(row, 36);
  const first = row + 1;
  if (rows.length) {
    const rg = s.getRange(first, 1, rows.length, headers.length);
    rg.setValues(clean_(rows.map(r => fit_(r, headers.length))));
    if (fmts) { const f = headers.map((h, i) => fmts[i] || 'General'); rg.setNumberFormats(rows.map(() => f)); }
    rg.setBorder(true, true, true, true, true, true, '#D9D9D9', SpreadsheetApp.BorderStyle.SOLID).setVerticalAlignment('middle');
  } else s.getRange(first, 1).setValue('Aucune donnée sur la période').setFontColor('#7F7F7F');
  return { hdr: row, first, n: rows.length, next: first + Math.max(rows.length, 1) + 1 };
}
function cards_(s, row, items) {
  ensureSize_(s, row + 2, items.length + 1);
  s.getRange(row, 1, 1, items.length).setValues([items.map(i => i[0])]).setFontColor('#595959').setFontSize(9)
    .setBackground(C_GREY).setWrap(true).setVerticalAlignment('bottom');
  const vr = s.getRange(row + 1, 1, 1, items.length);
  vr.setValues([items.map(i => i[1] === null || i[1] === undefined ? '' : i[1])]).setFontSize(16).setFontWeight('bold')
    .setFontColor(C_HEAD).setBackground(C_GREY).setHorizontalAlignment('left');
  vr.setNumberFormats([items.map(i => i[2] || 'General')]);
  items.forEach((it, i) => { if (it[3]) s.getRange(row + 1, i + 1).setFontColor(it[3]); });
}
function colRange_(s, t, col) { return s.getRange(t.first, col + 1, Math.max(t.n, 1), 1); }
function gradRule_(rg, min, mid, max) {
  const b = SpreadsheetApp.newConditionalFormatRule().setRanges([rg]);
  b.setGradientMinpoint(min || '#FFFFFF');
  if (mid) b.setGradientMidpointWithValue(mid, SpreadsheetApp.InterpolationType.PERCENTILE, '50');
  b.setGradientMaxpoint(max || '#F8696B');
  return b.build();
}
function levelRules_(rg) { return LEVELS.map(l => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(l.name).setBackground(l.bg).setFontColor(l.fg).setBold(true).setRanges([rg]).build()); }
function gravRules_(rg) { return Object.keys(GRAV).map(g => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(g).setBackground(GRAV[g][0]).setFontColor(GRAV[g][1]).setRanges([rg]).build()); }
function greyNM_(rg) { return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(NM).setFontColor('#A6A6A6').setItalic(true).setRanges([rg]).build(); }
function widths_(s, first, widths) { widths.forEach((w, i) => s.setColumnWidth(first + i, w)); }
function mapLink_(la, lo) { return la !== '' && lo !== '' && la != null && isFinite(+la) && isFinite(+lo) ? 'https://maps.google.com/?q=' + (+la).toFixed(5) + ',' + (+lo).toFixed(5) : ''; }

/** Classement chauffeurs (hors "Hors contrat") avec détail par règle */
function driverStats_(ctx, p) {
  const P = ctx.P;
  const agg = aggJrn_(ctx.jrn.filter(x => inP_(x.day, p) && x.code !== HORS), ctx.IJ, x => x.code, P);
  const ruleCnt = {}, used = {};
  ctx.evts.forEach(e => {
    if (e.code === HORS || !agg[e.code]) return;
    const day = e.num && ctx.ctrDay[e.num] ? ctx.ctrDay[e.num] : e.day;
    if (!inP_(day, p)) return;
    const rl = ctx.rules[e.rid]; if (!rl || rl.w <= 0) return;
    (ruleCnt[e.code] = ruleCnt[e.code] || {})[e.rid] = (ruleCnt[e.code][e.rid] || 0) + 1;
    used[e.rid] = (used[e.rid] || 0) + 1;
  });
  const ruleIds = Object.keys(used).sort((a, b) => used[b] - used[a]);
  const list = Object.values(agg).map(a => { const sc = scoreOf_(a, P); return { a, code: a.k, nom: ctx.drvName[a.k] || a.k, score: sc, level: levelOf_(sc, P), rules: ruleCnt[a.k] || {} }; })
    .sort((x, y) => y.score - x.score || y.a.pts - x.a.pts);
  return { list, ruleIds };
}

// ---------- TABLEAU DE BORD ----------
const VEH_HEAD = ['Plaque', 'Modèle', 'Contrats', 'Heures sous contrat', 'Km', 'Conduite', 'Ralenti total', 'dont ralenti prolongé',
  'Arrêts prolongés', 'Carburant (L)', 'Km mesurés', 'L/100 km', 'Source carburant', 'Carburant ralenti (L)', 'Coût carburant (MAD)',
  'Coût ralenti (MAD)', 'Pleins', 'Vmax (km/h)', 'Pire dépassement (km/h)', 'Événements', 'Score /100 km', 'Siphonages suspects',
  'Km hors contrat', 'Alertes'];
const VEH_FMT = [null, null, F0, FH, F1, FH, FH, FH, F0, F1, F1, F1, null, F1, F0, F0, F0, F0, F0, F0, F1, F0, F1, F0];
function vehRow_(v, a, ctx, alertsN) {
  return [v.plate, v.model, Object.keys(a.ctr).length, hv_(a.ctrH), r1_(a.km), hv_(a.drive), hv_(a.idle), hv_(a.idleLong), a.nLong,
    fuelVal_(a), r1_(a.fuelKm), l100Val_(a), srcTxt_(a), idleFuelVal_(a), costVal_(a.costN, a.cost), costVal_(a.idleCostN, a.idleCost),
    a.pleins, a.vmax, a.worst === null ? '' : a.worst, a.evts, r1_(scoreOf_(a, ctx.P)), a.siph, r1_(a.kmHors), alertsN];
}
function renderDashboard_(ctx) {
  const s = sh_(S.DASH); if (!s) return;
  const p = period_(), P = ctx.P;
  resetView_(s, 6);
  title_(s, 'Tableau de bord flotte', 'Mis à jour le ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm') + '. Données mesurées par Geotab uniquement, « non mesuré » quand Geotab ne fournit pas la valeur.');
  s.getRange('A6').setValue(p.label).setFontWeight('bold').setFontColor(C_SEC);
  const rows = ctx.jrn.filter(x => inP_(x.day, p));
  const t = aggJrn_(rows, ctx.IJ, () => 'ALL', P).ALL || emptyAgg_();
  const al = ctx.alerts.filter(x => inP_(x.day, p));
  const crit = al.filter(x => x.r[ctx.IA['Gravité']] === 'Critique').length, high = al.filter(x => x.r[ctx.IA['Gravité']] === 'Haute').length;
  cards_(s, 8, [['Km parcourus', r1_(t.km), F0], ['Carburant mesuré (L)', fuelVal_(t), F0], ['Conso moyenne (L/100)', l100Val_(t), F1],
    ['Heures de ralenti', hv_(t.idle), FH], ['dont ralenti prolongé', hv_(t.idleLong), FH, '#C00000'], ['Arrêts moteur allumé prolongés', t.nLong, F0],
    ['Carburant au ralenti (L)', idleFuelVal_(t), F1]]);
  const tne = ctx.fuels.filter(x => inP_(x.day, p) && x.r[ctx.IF['Type']] === 'TRAJET_NON_ENREGISTRE');
  cards_(s, 11, [['Pleins détectés', t.pleins, F0], ['Siphonages suspects', t.siph, F0, t.siph ? '#C00000' : null],
    ['Trajets non enregistrés (boîtier coupé)', tne.length, F0, tne.length ? '#C00000' : null],
    ['Km hors contrat', r1_(t.kmHors), F1, t.kmHors ? '#C00000' : null], ['Vmax flotte (km/h)', t.vmax, F0],
    ['Coût carburant (MAD)', costVal_(t.costN, t.cost), F0], ['Alertes critiques', crit, F0, crit ? '#C00000' : null], ['Alertes hautes', high, F0]]);
  const cf = [];
  const byV = aggJrn_(rows, ctx.IJ, x => x.key, P);
  const vRows = Object.values(ctx.veh).filter(v => v.active).map(v => vehRow_(v, byV[v.key] || emptyAgg_(), ctx,
    al.filter(x => plateKey_(x.r[ctx.IA['Plaque']]) === v.key).length));
  const tv = table_(s, 14, 'Véhicules', VEH_HEAD, vRows, VEH_FMT);
  [6, 7, 8, 13, 21, 22].forEach(c => cf.push(gradRule_(colRange_(s, tv, c))));
  cf.push(gradRule_(colRange_(s, tv, 20), '#63BE7B', '#FFEB84', '#F8696B'), greyNM_(s.getRange(tv.first, 1, Math.max(tv.n, 1), VEH_HEAD.length)));
  const ds = driverStats_(ctx, p);
  const dRows = ds.list.slice(0, 15).map((d, i) => [i + 1, d.nom, d.code, d.level, r1_(d.score), d.a.evts, r1_(d.a.km), hv_(d.a.idle),
    hv_(d.a.idleLong), d.a.nLong, fuelVal_(d.a), l100Val_(d.a), d.a.vmax, d.a.worst === null ? '' : d.a.worst, d.a.siph]);
  const td = table_(s, tv.next + 1, 'Chauffeurs les plus dangereux (top 15, détail et diagrammes dans ' + S.RANK + ')',
    ['Rang', 'Chauffeur', 'Code', 'Niveau', 'Score /100 km', 'Événements', 'Km', 'Ralenti total', 'dont prolongé', 'Arrêts prolongés',
      'Carburant (L)', 'L/100 km', 'Vmax (km/h)', 'Pire dépassement (km/h)', 'Siphonages suspects'],
    dRows, [F0, null, null, null, F1, F0, F1, FH, FH, F0, F1, F1, F0, F0, F0]);
  cf.push.apply(cf, levelRules_(colRange_(s, td, 3)));
  cf.push(gradRule_(colRange_(s, td, 4), '#63BE7B', '#FFEB84', '#F8696B'), gradRule_(colRange_(s, td, 8)));
  const aRows = al.filter(x => /Critique|Haute/.test(x.r[ctx.IA['Gravité']])).slice(0, 25)
    .map(x => [x.r[ctx.IA['Date']], x.r[ctx.IA['Heure']], x.r[ctx.IA['Plaque']], x.r[ctx.IA['Chauffeur']], x.r[ctx.IA['Type']],
      x.r[ctx.IA['Gravité']], x.r[ctx.IA['Valeur']], x.r[ctx.IA['Détail']], x.r[ctx.IA['Statut']]]);
  const ta = table_(s, td.next + 1, 'Alertes critiques et hautes (25 plus récentes, toutes dans ' + S.ALERT + ')',
    ['Date', 'Heure', 'Plaque', 'Chauffeur', 'Type', 'Gravité', 'Valeur', 'Détail', 'Statut'], aRows, [FD, '@']);
  cf.push.apply(cf, gravRules_(colRange_(s, ta, 5)));
  s.setConditionalFormatRules(cf);
  widths_(s, 1, [125, 160].concat(new Array(22).fill(92)));
}

// ---------- DU JOUR (journées = horaires des contrats) ----------
function renderToday_(ctx) {
  const s = sh_(S.TODAY); if (!s) return;
  const day = toDayStr_(s.getRange('B3').getValue()) || ctx.today, P = ctx.P, now = Date.now();
  resetView_(s, 5);
  title_(s, 'Véhicules et chauffeurs du ' + fmtDay_(day), 'Mis à jour le ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm') +
    '. Chaque ligne de contrat couvre toute la journée de travail, selon les horaires du contrat.');
  const b = dayBounds_(day), b0 = b.start.getTime(), b1 = b.end.getTime();
  const al = ctx.alerts.filter(x => x.day === day);
  const cf = [];
  // État des véhicules
  const vRows = Object.values(ctx.veh).filter(v => v.active).map(v => {
    const cs = ctx.cidx[v.key] || [];
    const cur = cs.filter(c => c.start <= now && c.end >= now).pop();
    const lv = (ctx.lvl[v.key] || []).filter(x => x.t.getTime() <= b1).pop();
    return [v.plate, v.model, cur ? 'En contrat' : 'Libre', cur ? cur.nom : '', cur ? cur.num : '', cur ? new Date(cur.start) : '',
      lv ? lv.v : '', lv ? lv.t : '', al.filter(x => plateKey_(x.r[ctx.IA['Plaque']]) === v.key).length];
  });
  const tv = table_(s, 5, 'État actuel des véhicules (maintenant, quelle que soit la date choisie)', ['Plaque', 'Modèle', 'Statut', 'Chauffeur actuel', 'Contrat', 'Depuis', 'Dernière jauge (%)', 'Relevée le', 'Alertes du jour'],
    vRows, [null, null, null, null, null, FDT, F0, FDT, F0]);
  cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('En contrat').setBackground('#C6EFCE').setFontColor('#006100').setRanges([colRange_(s, tv, 2)]).build());
  // Journées de travail actives ce jour-là
  const IJ = ctx.IJ;
  const rows = ctx.jrn.filter(x => {
    const st = tms_(x.r[IJ['Début contrat']]);
    if (!st) return x.day === day;
    const en = tms_(x.r[IJ['Fin contrat']]) || now;
    return st < b1 && en > b0;
  }).map(x => {
    const r = x.r, sc = num_(r[IJ['Score /100 km']]);
    return [r[IJ['Plaque']], ctx.drvName[x.code] || r[IJ['Chauffeur']], r[IJ['Contrat']] || 'Hors contrat', r[IJ['Début contrat']], r[IJ['Fin contrat']] || (r[IJ['Contrat']] ? 'en cours' : ''),
      hv_(r[IJ['Durée contrat (h)']]), r[IJ['Km']], hv_(r[IJ['Conduite (h)']]), hv_(r[IJ['Ralenti (h)']]), hv_(r[IJ['Ralenti prolongé (h)']]),
      r[IJ['Nb ralentis prolongés']], r[IJ['Carburant (L)']] === '' ? NM : r[IJ['Carburant (L)']], r[IJ['L/100 km']] === '' ? (r[IJ['Carburant (L)']] === '' ? NM : 'km insuffisants') : r[IJ['L/100 km']],
      r[IJ['Carburant ralenti (L)']] === '' ? NM : r[IJ['Carburant ralenti (L)']], r[IJ['Vmax (km/h)']], r[IJ['Limite à Vmax']], r[IJ['Pire dépassement (km/h)']],
      r[IJ['Événements']], sc, x.code === HORS ? '' : levelOf_(sc, P), r[IJ['Pleins']], r[IJ['Siphonages suspects']], r[IJ['Source ralenti']], r[IJ['Source carburant']]];
  }).sort((a, b) => b[18] - a[18]);
  const tc = table_(s, tv.next + 1, 'Journées de travail actives le ' + fmtDay_(day) + ' (classées de la plus dangereuse à la moins dangereuse)',
    ['Plaque', 'Chauffeur', 'Contrat', 'Début', 'Fin', 'Durée contrat', 'Km', 'Conduite', 'Ralenti total', 'dont prolongé', 'Arrêts prolongés',
      'Carburant (L)', 'L/100 km', 'Carburant ralenti (L)', 'Vmax (km/h)', 'Limite route à Vmax', 'Pire dépassement (km/h)', 'Événements',
      'Score /100 km', 'Niveau', 'Pleins', 'Siphonages suspects', 'Source ralenti', 'Source carburant'], rows,
    [null, null, null, FDT, FDT, FH, F1, FH, FH, FH, F0, F1, F1, F1, F0, F0, F0, F0, F1, null, F0, F0]);
  cf.push.apply(cf, levelRules_(colRange_(s, tc, 19)));
  cf.push(gradRule_(colRange_(s, tc, 9)), gradRule_(colRange_(s, tc, 16)), gradRule_(colRange_(s, tc, 18), '#63BE7B', '#FFEB84', '#F8696B'),
    greyNM_(s.getRange(tc.first, 12, Math.max(tc.n, 1), 3)));
  // Arrêts moteur allumé prolongés du jour
  const iRows = ctx.idles.filter(x => x.t >= b0 && x.t < b1).sort((a, b) => a.t - b.t).map(x => idleRow_(ctx, x));
  const ti = table_(s, tc.next + 1, 'Arrêts véhicule immobile contact mis ≥ ' + P.idleLongMin + ' min, du jour (retenus si le moteur thermique tournait)', IDLE_HEAD, iRows, IDLE_FMT);
  cf.push(gradRule_(colRange_(s, ti, 3)), greyNM_(s.getRange(ti.first, 1, Math.max(ti.n, 1), IDLE_HEAD.length)));
  const aRows = al.map(x => [x.r[ctx.IA['Heure']], x.r[ctx.IA['Plaque']], x.r[ctx.IA['Chauffeur']], x.r[ctx.IA['Type']], x.r[ctx.IA['Gravité']],
    x.r[ctx.IA['Valeur']], x.r[ctx.IA['Détail']], x.r[ctx.IA['Statut']]]);
  const ta = table_(s, ti.next + 1, 'Alertes du jour', ['Heure', 'Plaque', 'Chauffeur', 'Type', 'Gravité', 'Valeur', 'Détail', 'Statut'], aRows, ['@']);
  cf.push.apply(cf, gravRules_(colRange_(s, ta, 4)));
  s.setConditionalFormatRules(cf);
  widths_(s, 1, [110, 190, 95, 110, 110].concat(new Array(17).fill(88)));
}

// ---------- CLASSEMENT CHAUFFEURS + DIAGRAMMES ----------
function renderRanking_(ctx) {
  const s = sh_(S.RANK); if (!s) return;
  const p = period_(), P = ctx.P;
  resetView_(s, 1);
  title_(s, 'Classement des chauffeurs', p.label + '. Score = points danger pour 100 km (poids dans ' + S.RULE + '). Seuils : Modéré ' + P.scoreY +
    ', Élevé ' + P.scoreO + ', Dangereux ' + P.scoreR + '. Les nombres d\'événements sont les données brutes Geotab.');
  const ds = driverStats_(ctx, p);
  const head = ['Rang', 'Chauffeur', 'Code', 'Niveau', 'Score /100 km', 'Points danger', 'Événements', 'Journées', 'Heures sous contrat', 'Km', 'Conduite',
    'Ralenti total', 'dont prolongé', 'Arrêts prolongés', 'Carburant (L)', 'Km mesurés', 'L/100 km', 'Litres par journée', 'Carburant ralenti (L)',
    'Vmax (km/h)', 'Pire dépassement (km/h)'].concat(ds.ruleIds.map(id => ctx.rules[id].name + ' (x' + ctx.rules[id].w + ')'))
    .concat(['Pleins', 'Siphonages suspects', 'Véhicules']);
  const rows = ds.list.map((d, i) => { const a = d.a, nd = Object.keys(a.ctr).length || Object.keys(a.days).length;
    return [i + 1, d.nom, d.code, d.level, r1_(d.score), r1_(a.pts), a.evts, nd, hv_(a.ctrH), r1_(a.km), hv_(a.drive), hv_(a.idle), hv_(a.idleLong), a.nLong,
      fuelVal_(a), r1_(a.fuelKm), l100Val_(a), a.fuelN && nd ? r1_(a.fuel / nd) : NM, idleFuelVal_(a), a.vmax, a.worst === null ? '' : a.worst]
      .concat(ds.ruleIds.map(id => d.rules[id] || 0)).concat([a.pleins, a.siph, Object.keys(a.plates).join(', ')]); });
  const n = ds.ruleIds.length;
  const fm = [F0, null, null, null, F1, F1, F0, F0, FH, F1, FH, FH, FH, F0, F1, F1, F1, F1, F1, F0, F0].concat(ds.ruleIds.map(() => F0)).concat([F0, F0, null]);
  const t = table_(s, 4, null, head, rows, fm);
  const cf = levelRules_(colRange_(s, t, 3));
  cf.push(gradRule_(colRange_(s, t, 4), '#63BE7B', '#FFEB84', '#F8696B'));
  [11, 12, 13, 16, 18, 20].concat(ds.ruleIds.map((x, i) => 21 + i)).forEach(c => cf.push(gradRule_(colRange_(s, t, c))));
  cf.push(greyNM_(s.getRange(t.first, 15, Math.max(t.n, 1), 5)));
  s.setConditionalFormatRules(cf);
  s.setFrozenRows(t.hdr); s.setFrozenColumns(4);
  widths_(s, 1, [50, 200, 70, 100]); for (let c = 5; c <= head.length; c++) s.setColumnWidth(c, 95);
  s.setRowHeight(t.hdr, 60);
  if (!rows.length) return;
  // Données des diagrammes (colonnes à droite, texte gris)
  const C0 = head.length + 3, h = Math.max(260, rows.length * 24 + 90);
  ensureSize_(s, t.first + rows.length + 5, C0 + 14);
  const g1 = [['Chauffeur', 'Faible', 'Modéré', 'Élevé', 'Dangereux']].concat(ds.list.map(d => [d.nom].concat(LEVELS.map(l => l.name === d.level ? r1_(d.score) : 0))));
  s.getRange(t.hdr, C0, g1.length, 5).setValues(g1).setFontColor('#A6A6A6');
  const byIdle = ds.list.slice().sort((a, b) => b.a.idle - a.a.idle);
  const g2 = [['Chauffeur', 'Ralenti court (h)', 'Ralenti prolongé (h)']].concat(byIdle.map(d => [d.nom, r2_(Math.max(0, d.a.idle - d.a.idleLong)), r2_(d.a.idleLong)]));
  s.getRange(t.hdr, C0 + 6, g2.length, 3).setValues(g2).setFontColor('#A6A6A6');
  const byCons = ds.list.filter(d => d.a.l100 !== null).sort((a, b) => b.a.l100 - a.a.l100);
  const g3 = [['Chauffeur', 'L/100 km']].concat(byCons.map(d => [d.nom, r1_(d.a.l100)]));
  s.getRange(t.hdr, C0 + 10, g3.length, 2).setValues(g3).setFontColor('#A6A6A6');
  const top = t.next + 1;
  s.getRange(top, 1).setValue('Diagrammes : classement général, ralenti et consommation par chauffeur').setFontWeight('bold').setFontSize(12).setFontColor(C_SEC);
  const bar = (rg, title, colors, stacked, col) => s.insertChart(s.newChart().setChartType(Charts.ChartType.BAR).addRange(rg)
    .setPosition(top + 1, col, 0, 0).setOption('title', title).setOption('isStacked', stacked).setOption('colors', colors)
    .setOption('legend', { position: stacked ? 'top' : 'none' }).setOption('width', 560).setOption('height', h)
    .setOption('chartArea', { left: 170, width: '60%' }).build());
  bar(s.getRange(t.hdr, C0, g1.length, 5), 'Classement danger (score pour 100 km)', ['#63BE7B', '#FFD966', '#F4B183', '#C00000'], true, 1);
  bar(s.getRange(t.hdr, C0 + 6, g2.length, 3), 'Heures de ralenti par chauffeur', ['#9DC3E6', '#C00000'], true, 7);
  if (g3.length > 1) bar(s.getRange(t.hdr, C0 + 10, g3.length, 2), 'Consommation mesurée (L/100 km)', ['#2E75B6'], false, 13);
}

// ---------- CLASSEMENT CONDUITE (du plus dangereux au plus sûr, chiffres bruts) ----------
const DRIVE_CATS = ['Vitesse', 'Freinage', 'Accélération', 'Virage', 'Ceinture', 'Collision'];
/** Statistiques de conduite par chauffeur sur la période : événements Geotab par type, vitesses mesurées, dépassements */
function drivingStats_(ctx, p) {
  const P = ctx.P, ds = driverStats_(ctx, p), by = {};
  ds.list.forEach(d => { by[d.code] = { d, cat: {}, speedS: 0, vmax: 0, vmaxAt: null, worst: null, nOver: 0, trips: 0 }; });
  DRIVE_CATS.forEach(c => Object.keys(by).forEach(k => { by[k].cat[c] = 0; }));
  const IE = ctx.IE;
  ctx.evts.forEach(e => {
    const o = by[e.code]; if (!o) return;
    const day = e.num && ctx.ctrDay[e.num] ? ctx.ctrDay[e.num] : e.day;
    if (!inP_(day, p)) return;
    const rl = ctx.rules[e.rid]; if (!rl || rl.w <= 0) return;   // règles de conduite uniquement, doublons « (New) » exclus
    const cat = rl.cat || ruleCategory_(rl.name);
    if (o.cat[cat] === undefined) return;
    o.cat[cat]++;
    if (cat === 'Vitesse') o.speedS += num_(e.r[IE['Durée (s)']]);
  });
  const T = readData_(S.TRIP, addDays_(p.from, -1)), IT = idx_(H.TRIP);
  T.rows.forEach(r => {
    const o = by[String(r[IT['Code chauffeur']])]; if (!o) return;
    const num = String(r[IT['Contrat']] || ''), day = num && ctx.ctrDay[num] ? ctx.ctrDay[num] : toDayStr_(r[IT['Date']]);
    if (!day || !inP_(day, p)) return;
    o.trips++;
    const when = toDate_(r[IT['Début']]), plate = String(r[IT['Plaque']]);
    const vm = num_(r[IT['Vmax (km/h)']]);
    if (vm > o.vmax) { o.vmax = vm; o.vmaxAt = { when, plate, lim: r[IT['Limite à Vmax']] }; }
    const ex = r[IT['Pire dépassement (km/h)']];
    if (ex !== '' && ex !== null && isFinite(+ex)) {
      if (+ex >= P.overAlert) o.nOver++;
      if (!o.worst || +ex > o.worst.ex) {
        // date réelle du dépassement : jour du départ, ou lendemain si l'heure est passée minuit pendant le trajet
        const hm = String(r[IT['Heure pire']] || ''), d0 = when ? Utilities.formatDate(when, TZ, 'yyyy-MM-dd') : day;
        const wd = when && hm && hm < Utilities.formatDate(when, TZ, 'HH:mm') ? addDays_(d0, 1) : d0;
        o.worst = { ex: +ex, v: r[IT['Vitesse au pire']], lim: r[IT['Limite au pire']], hm, day: wd, plate };
      }
    }
  });
  return Object.values(by);
}
function renderDriving_(ctx) {
  const s = sh_(S.DRIVE); if (!s) return;
  const p = period_(), P = ctx.P;
  resetView_(s, 1);
  title_(s, 'Classement conduite : du plus dangereux au plus sûr',
    p.label + '. Chiffres bruts, rien n\'est estimé : événements détectés par le boîtier Geotab (règles de conduite de ' + S.RULE +
    ', une seule version par règle), vitesse lue sur le capteur du véhicule, limite de la route fournie par Geotab. ' +
    'Score = points danger pour 100 km. Classés : au moins ' + P.kmMin + ' km sur la période.');
  const all = drivingStats_(ctx, p);
  const ranked = all.filter(o => o.d.a.km >= P.kmMin).sort((x, y) => y.d.score - x.d.score || y.d.a.pts - x.d.a.pts);
  const small = all.filter(o => o.d.a.km < P.kmMin).sort((x, y) => y.d.a.km - x.d.a.km);
  const nEv = o => DRIVE_CATS.reduce((t, c) => t + o.cat[c], 0);
  const best = ranked.length ? ranked[ranked.length - 1] : null, worst = ranked.length ? ranked[0] : null;
  const kmTot = all.reduce((t, o) => t + o.d.a.km, 0), evTot = all.reduce((t, o) => t + nEv(o), 0);
  cards_(s, 4, [
    ['Le plus dangereux', worst ? worst.d.nom : 'Aucun chauffeur classé', null, '#C00000'],
    ['Son score /100 km', worst ? r1_(worst.d.score) : '', F1, '#C00000'],
    ['Le plus sûr', best && best !== worst ? best.d.nom : (best ? best.d.nom : ''), null, '#00704A'],
    ['Son score /100 km', best ? r1_(best.d.score) : '', F1, '#00704A'],
    ['Chauffeurs classés', ranked.length + ' / ' + all.length],
    ['Km analysés', Math.round(kmTot), F0],
    ['Événements de conduite', evTot, F0]
  ]);
  const head = ['Rang', 'Chauffeur', 'Code', 'Niveau', 'Score /100 km', 'Km', 'Heures de conduite', 'Événements /100 km',
    'Excès de vitesse', 'Temps en excès de vitesse', 'Freinages brusques', 'Accélérations brusques', 'Virages brusques', 'Ceinture non bouclée', 'Collisions',
    'Vmax mesurée (km/h)', 'Vmax : véhicule et départ du trajet', 'Pire dépassement (km/h)', 'Vitesse / limite', 'Pire dépassement : véhicule, date et heure',
    'Trajets dépassant la limite de ' + P.overAlert + ' km/h ou plus', 'Trajets', 'Journées'];
  const fm = [F0, null, null, null, F1, F0, FH, F1, F0, FH, F0, F0, F0, F0, F0, F0, null, F0, null, null, F0, F0, F0];
  const fmtWhen = w => w && w.when ? w.plate + ' le ' + Utilities.formatDate(w.when, TZ, 'dd/MM HH:mm') : '';
  const row = (o, i) => {
    const a = o.d.a, nd = Object.keys(a.ctr).length || Object.keys(a.days).length, w = o.worst;
    return [i === null ? '' : i + 1, o.d.nom, o.d.code, i === null ? 'Non classé' : o.d.level, r1_(o.d.score), r1_(a.km), hv_(a.drive),
      a.km > 0 ? r1_(nEv(o) / a.km * 100) : 0, o.cat['Vitesse'], o.speedS / 86400, o.cat['Freinage'], o.cat['Accélération'], o.cat['Virage'],
      o.cat['Ceinture'], o.cat['Collision'], o.vmax || '', fmtWhen(o.vmaxAt) + (o.vmaxAt && o.vmaxAt.lim ? ' (limite ' + o.vmaxAt.lim + ')' : ''),
      w ? w.ex : '', w ? w.v + ' / ' + w.lim : '', w ? w.plate + ' le ' + fmtDay_(w.day).slice(0, 5) + ' ' + w.hm : '', o.nOver, o.trips, nd];
  };
  const t = table_(s, 7, 'Classement (1 = le plus dangereux, dernier = le plus sûr)', head, ranked.map((o, i) => row(o, i)), fm);
  const cf = levelRules_(colRange_(s, t, 3));
  cf.push(gradRule_(colRange_(s, t, 4), '#63BE7B', '#FFEB84', '#F8696B'));
  [7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 20].forEach(c => cf.push(gradRule_(colRange_(s, t, c))));
  let next = t.next;
  if (small.length) {
    const t2 = table_(s, next + 1, 'Non classés : moins de ' + P.kmMin + ' km sur la période (trop peu de km pour un score juste, chiffres donnés pour information)',
      head, small.map(o => row(o, null)), fm);
    next = t2.next;
  }
  s.setConditionalFormatRules(cf);
  s.setFrozenRows(0); s.setFrozenColumns(2);
  widths_(s, 1, [50, 200, 70, 100]); for (let c = 5; c <= head.length; c++) s.setColumnWidth(c, 100);
  [17, 20].forEach(c => s.setColumnWidth(c, 190));
  s.setRowHeight(t.hdr, 60);
  if (!ranked.length) return;
  // Diagramme : score par chauffeur, couleur du niveau (données en gris à droite)
  const C0 = head.length + 3;
  ensureSize_(s, t.first + ranked.length + 5, C0 + 6);
  const g = [['Chauffeur', 'Faible', 'Modéré', 'Élevé', 'Dangereux']].concat(ranked.map(o => [o.d.nom].concat(LEVELS.map(l => l.name === o.d.level ? r1_(o.d.score) : 0))));
  s.getRange(t.hdr, C0, g.length, 5).setValues(g).setFontColor('#A6A6A6');
  s.insertChart(s.newChart().setChartType(Charts.ChartType.BAR).addRange(s.getRange(t.hdr, C0, g.length, 5))
    .setPosition(next + 1, 2, 0, 0).setOption('title', 'Du plus dangereux (en haut) au plus sûr : score pour 100 km').setOption('isStacked', true)
    .setOption('colors', ['#63BE7B', '#FFD966', '#F4B183', '#C00000']).setOption('legend', { position: 'top' })
    .setOption('width', 760).setOption('height', Math.max(260, ranked.length * 26 + 90)).setOption('chartArea', { left: 190, width: '65%' }).build());
}

// ---------- RALENTI & CARBURANT ----------
function renderIdle_(ctx) {
  const s = sh_(S.IDLE); if (!s) return;
  const P = ctx.P, td = ctx.today;
  resetView_(s, 1);
  title_(s, 'Ralenti (moteur allumé à l\'arrêt) et consommation',
    'Heures au format h:mm. Ralenti = véhicule immobile moteur thermique tournant (régime moteur) ; si le régime n\'est pas remonté, temps contact mis mesuré par Geotab. ' +
    'Ralenti prolongé = arrêts ≥ ' + P.idleLongMin + ' min reconstitués depuis le GPS (feux et bouchons exclus). Journée = horaires du contrat. Litres : compteur, bilan Geotab, débit moteur ou jauge, jamais estimés. Sources détaillées dans ' + S.CTRL + '.');
  const per = [['Aujourd\'hui', td, td], ['Hier', addDays_(td, -1), addDays_(td, -1)], ['Semaine', mondayOf_(td), td],
    ['Mois', td.slice(0, 8) + '01', td], ['Depuis le début', '0000-00-00', '9999-99-99']];
  const cf = [];
  const build = (keyFn, label) => {
    const aggs = per.map(p => aggJrn_(ctx.jrn.filter(x => x.day >= p[1] && x.day <= p[2]), ctx.IJ, keyFn, P));
    const all = aggs[4], mo = aggs[3];
    return Object.keys(all).map(k => [label(k)].concat(aggs.map(a => hv_(a[k] ? a[k].idle : 0))).concat(aggs.map(a => hv_(a[k] ? a[k].idleLong : 0)))
      .concat([mo[k] ? mo[k].nLong : 0, mo[k] ? idleFuelVal_(mo[k]) : NM, idleFuelVal_(all[k])])).sort((a, b) => b[10] - a[10]);
  };
  const head = first => [first, 'Ralenti aujourd\'hui', 'Ralenti hier', 'Ralenti semaine', 'Ralenti mois', 'Ralenti depuis le début',
    'Prolongé aujourd\'hui', 'Prolongé hier', 'Prolongé semaine', 'Prolongé mois', 'Prolongé depuis le début',
    'Arrêts prolongés (mois)', 'Litres ralenti mois (compteur)', 'Litres ralenti depuis le début'];
  const fm = [null, FH, FH, FH, FH, FH, FH, FH, FH, FH, FH, F0, F1, F1];
  const t1 = table_(s, 4, 'Heures de ralenti par chauffeur', head('Chauffeur'), build(x => x.code, k => (ctx.drvName[k] || k) + (k === HORS ? '' : ' (' + k + ')')), fm);
  for (let c = 1; c <= 11; c++) cf.push(gradRule_(colRange_(s, t1, c)));
  const t2 = table_(s, t1.next + 1, 'Heures de ralenti par véhicule', head('Véhicule'), build(x => x.key, k => (ctx.veh[k] || {}).plate || k), fm);
  for (let c = 1; c <= 11; c++) cf.push(gradRule_(colRange_(s, t2, c)));
  // Consommation par chauffeur (période du tableau de bord)
  const p = period_();
  const cons = aggJrn_(ctx.jrn.filter(x => inP_(x.day, p) && x.code !== HORS), ctx.IJ, x => x.code, P);
  const cRows = Object.values(cons).map(a => { const nd = Object.keys(a.ctr).length;
    return [ctx.drvName[a.k] || a.k, nd, r1_(a.km), r1_(a.fuelKm), fuelVal_(a), l100Val_(a), a.fuelN && nd ? r1_(a.fuel / nd) : NM, srcTxt_(a)]; })
    .sort((a, b) => (typeof b[5] === 'number' ? b[5] : -1) - (typeof a[5] === 'number' ? a[5] : -1));
  const t3 = table_(s, t2.next + 1, 'Consommation par chauffeur (' + p.label + ')',
    ['Chauffeur', 'Journées', 'Km', 'Km mesurés', 'Carburant (L)', 'L/100 km', 'Litres par journée', 'Source'], cRows, [null, F0, F1, F1, F1, F1, F1, null]);
  cf.push(gradRule_(colRange_(s, t3, 5)), gradRule_(colRange_(s, t3, 6)), greyNM_(s.getRange(t3.first, 5, Math.max(t3.n, 1), 3)));
  // Cartes de chaleur 14 jours : litres et heures de ralenti par journée de travail
  const days = []; for (let i = 13; i >= 0; i--) days.push(addDays_(td, -i));
  const heat = (valFn, title, fmt) => {
    const m = {}, has = {};
    ctx.jrn.forEach(x => { if (x.day < days[0] || x.code === HORS) return; const v = valFn(x.r); if (v === null) return;
      m[x.code] = m[x.code] || {}; m[x.code][x.day] = (m[x.code][x.day] || 0) + v; has[x.code] = 1; });
    const rows = Object.keys(has).map(k => { const tot = days.reduce((acc, d) => acc + (m[k][d] || 0), 0);
      return [ctx.drvName[k] || k].concat(days.map(d => m[k][d] !== undefined ? (fmt === FH ? hv_(m[k][d]) : r1_(m[k][d])) : '')).concat([fmt === FH ? hv_(tot) : r1_(tot)]); })
      .filter(r => r[r.length - 1] > 0).sort((a, b) => b[b.length - 1] - a[a.length - 1]);
    return { title, rows, fmt };
  };
  let row = t3.next + 1;
  [heat(r => r[ctx.IJ['Carburant (L)']] === '' ? null : num_(r[ctx.IJ['Carburant (L)']]), 'Litres consommés par chauffeur et par journée (14 jours, mesurés)', F1),
   heat(r => num_(r[ctx.IJ['Ralenti (h)']]), 'Heures de ralenti par chauffeur et par journée (14 jours)', FH),
   heat(r => num_(r[ctx.IJ['Ralenti prolongé (h)']]), 'Heures de ralenti prolongé par chauffeur et par journée (14 jours)', FH)].forEach(hm => {
    const t = table_(s, row, hm.title, ['Chauffeur'].concat(days.map(d => d.slice(8) + '/' + d.slice(5, 7))).concat(['Total']), hm.rows,
      [null].concat(days.map(() => hm.fmt)).concat([hm.fmt]));
    if (t.n) cf.push(gradRule_(s.getRange(t.first, 2, t.n, days.length)));
    row = t.next + 1;
  });
  // Liste des arrêts prolongés (preuves)
  const lim = dayBounds_(addDays_(td, -29)).start.getTime();
  const iRows = ctx.idles.filter(x => x.t >= lim).sort((a, b) => b.t - a.t).map(x => idleRow_(ctx, x));
  const ti = table_(s, row, 'Arrêts véhicule immobile contact mis, 30 derniers jours (heure, durée, moteur, lieu)', IDLE_HEAD, iRows, IDLE_FMT);
  cf.push(gradRule_(colRange_(s, ti, 3)), greyNM_(s.getRange(ti.first, 1, Math.max(ti.n, 1), IDLE_HEAD.length)),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('NON').setFontColor('#A6A6A6').setRanges([colRange_(s, ti, 5)]).build());
  s.setConditionalFormatRules(cf);
  widths_(s, 1, [230]); for (let c = 2; c <= 16; c++) s.setColumnWidth(c, 88);
}

// ---------- PLEINS ----------
function renderFills_(ctx) {
  const s = sh_(S.FILL); if (!s) return;
  resetView_(s, 1);
  title_(s, 'Pleins détectés', 'Pleins détectés par Geotab (FillUp) : date, heure, lieu, jauge avant/après en %. Litres (jauge) = quantité vue par la jauge ; ' +
    'Litres Geotab = carburant consommé depuis le plein précédent au compteur (= quantité à remettre pour un plein complet). Sur les Staria la jauge plafonne : le compteur fait foi.');
  const I = ctx.IF;
  const fl = ctx.fuels.filter(x => x.r[I['Type']] === 'PLEIN').sort((a, b) => b.t - a.t);
  const rows = fl.map(x => { const r = x.r; return [r[I['Arrêt début']], Utilities.formatDate(new Date(x.t), TZ, 'HH:mm'), r[I['Plaque']],
    x.code === HORS ? r[I['Chauffeur']] : (ctx.drvName[x.code] || r[I['Chauffeur']]), r[I['Contrat']], r[I['Moteur']], r[I['Niveau avant (%)']], r[I['Niveau après (%)']],
    r[I['Litres (jauge)']], r[I['Litres Geotab']], r[I['Durée arrêt (min)']], r[I['Source']], mapLink_(r[I['Lat']], r[I['Lon']])]; });
  const cf = [];
  const t1 = table_(s, 4, 'Pleins (' + rows.length + ')', ['Date', 'Heure', 'Plaque', 'Chauffeur', 'Contrat', 'Moteur', 'Jauge avant (%)', 'Jauge après (%)',
    'Litres (jauge)', 'Litres Geotab', 'Durée arrêt (min)', 'Source', 'Lieu'], rows, [FD, '@', null, null, null, null, F0, F0, F1, F1, F0]);
  // Récapitulatif mois x véhicule
  const rec = {};
  fl.forEach(x => { const k = x.day.slice(0, 7) + '|' + x.r[I['Plaque']]; const o = rec[k] || (rec[k] = { m: x.day.slice(0, 7), p: x.r[I['Plaque']], n: 0, lj: 0, lg: 0, ng: 0 });
    o.n++; o.lj += num_(x.r[I['Litres (jauge)']]); if (x.r[I['Litres Geotab']] !== '') { o.lg += num_(x.r[I['Litres Geotab']]); o.ng++; } });
  const rRows = Object.values(rec).sort((a, b) => b.m.localeCompare(a.m) || a.p.localeCompare(b.p))
    .map(o => [o.m.slice(5) + '/' + o.m.slice(0, 4), o.p, o.n, r1_(o.lj), o.ng ? r1_(o.lg) : '']);
  const t2 = table_(s, t1.next + 1, 'Récapitulatif par mois et par véhicule', ['Mois', 'Plaque', 'Nombre de pleins', 'Litres (jauge)', 'Litres Geotab'], rRows, ['@', null, F0, F1, F1]);
  // Consommation plein à plein (méthode de référence : litres remis à la pompe / km roulés)
  const ff = fullToFull_(ctx);
  const ffRows = ff.map(x => [x.plate, new Date(x.from), new Date(x.to), r1_(x.km), r1_(x.litres), x.l100 !== null ? r1_(x.l100) : 'km insuffisants',
    x.names.join(', '), x.single || 'Plusieurs chauffeurs', x.measured !== null ? r1_(x.measured) : NM, x.gap !== null ? r1_(x.gap) : '']);
  const tff = table_(s, t2.next + 1, 'Consommation plein à plein (entre deux pleins complets, jauge ≥ ' + ctx.P.fullPct + ' % après le plein)',
    ['Plaque', 'Plein de départ', 'Plein d\'arrivée', 'Km roulés', 'Litres remis', 'L/100 km', 'Chauffeur(s)', 'Attribuable à', 'Litres mesurés par trajet', 'Écart (%)'],
    ffRows, [null, FDT, FDT, F1, F1, F1, null, null, F1, FP]);
  if (tff.n) cf.push(SpreadsheetApp.newConditionalFormatRule().whenNumberNotBetween(-15, 15).setBackground('#FFC7CE').setRanges([colRange_(s, tff, 9)]).build());
  // Siphonages suspects
  const sp = ctx.fuels.filter(x => x.r[I['Type']] === 'SIPHONAGE_SUSPECT').sort((a, b) => b.t - a.t).map(x => { const r = x.r;
    return [r[I['Arrêt début']], r[I['Arrêt fin']], r[I['Plaque']], ctx.drvName[x.code] || r[I['Chauffeur']], r[I['Chauffeur suivant']], r[I['Durée arrêt (min)']],
      r[I['Niveau avant (%)']], r[I['Niveau après (%)']], r[I['Litres (jauge)']], r[I['Statut']], mapLink_(r[I['Lat']], r[I['Lon']])]; });
  const t3 = table_(s, tff.next + 1, 'Siphonages suspects (baisse de jauge moteur coupé, sans trajet)', ['Arrêt', 'Redémarrage', 'Plaque', 'Chauffeur à l\'arrêt',
    'Chauffeur au redémarrage', 'Durée arrêt (min)', 'Jauge avant (%)', 'Jauge après (%)', 'Litres (jauge)', 'Statut', 'Lieu'], sp, [FDT, FDT, null, null, null, F0, F1, F1, F1]);
  if (t3.n) cf.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=TRUE').setBackground('#FFC7CE').setRanges([s.getRange(t3.first, 1, t3.n, 11)]).build());
  s.setConditionalFormatRules(cf);
  widths_(s, 1, [95, 70, 95, 190, 110, 90, 90, 90, 90, 90, 90, 110, 70]);
}

// ---------- FICHE VÉHICULE (un seul onglet, plaque choisie dans la liste en J1) ----------
function renderFiche_(ctx) {
  let s = sh_(S.FICHE);
  if (!s) { s = ss_().insertSheet(S.FICHE); s.setTabColor('#00704A'); s.setHiddenGridlines(true); }
  const list = Object.values(ctx.veh).filter(v => v.active).sort((a, b) => a.plate.localeCompare(b.plate));
  if (!list.length) return;
  const cm = canonMap_(), cur = String(s.getRange('J1').getValue() || '');
  const v = ctx.veh[canonKey_(normPlate_(cur), cm)] || list[0];
  renderVehicle_(s, v, ctx, period_());
  s.getRange('I1').setValue('Véhicule :').setFontWeight('bold').setHorizontalAlignment('right');
  s.getRange('J1').setValue(v.plate).setBackground('#FFF2CC').setFontWeight('bold').setFontSize(12)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list.map(x => x.plate), true).build());
  s.getRange('K1').setValue('← choisissez une plaque, la fiche se met à jour').setFontColor('#7F7F7F');
}
function renderVehicle_(s, v, ctx, p) {
  const P = ctx.P, IJ = ctx.IJ, now = Date.now();
  resetView_(s, 1);
  title_(s, v.plate + (v.aliases && v.aliases.length ? ' (' + v.aliases.join(', ') + ')' : '') + '  ·  ' + v.brand + ' ' + v.model, v.fuelType + ' · réservoir ' + (v.tank || '?') + ' L · Geotab ' + (v.geoName || 'non associé') + ' · ' + p.label);
  const mine = ctx.jrn.filter(x => x.key === v.key);
  const a = aggJrn_(mine.filter(x => inP_(x.day, p)), IJ, () => 'A', P).A || emptyAgg_();
  cards_(s, 4, [['Km', r1_(a.km), F0], ['Carburant (L)', fuelVal_(a), F1], ['L/100 km', l100Val_(a), F1], ['Ralenti total', hv_(a.idle), FH],
    ['dont prolongé', hv_(a.idleLong), FH, '#C00000'], ['Arrêts prolongés', a.nLong, F0], ['Carburant ralenti (L)', idleFuelVal_(a), F1],
    ['Pleins', a.pleins, F0], ['Siphonages suspects', a.siph, F0, a.siph ? '#C00000' : null], ['Événements', a.evts, F0],
    ['Score /100 km', r1_(scoreOf_(a, P)), F1], ['Vmax (km/h)', a.vmax, F0]]);
  const cs = ctx.cidx[v.key] || [];
  const cur = cs.filter(c => c.start <= now && c.end >= now).pop(), last = cs[cs.length - 1];
  const lv = ctx.lvl[v.key] || [], lastLv = lv[lv.length - 1];
  s.getRange('A7:F7').setValues([['Contrat en cours', cur ? cur.nom + ' (' + cur.num + ') depuis ' + fmtDT_(cur.start) : (last ? 'Aucun. Dernier : ' + last.nom + ' le ' + fmtDT_(last.start) : 'Aucun'),
    'Dernière jauge', lastLv ? lastLv.v + ' %' : '', 'Relevée le', lastLv ? fmtDT_(lastLv.t) : '']]);
  ['A7', 'C7', 'E7'].forEach(c => s.getRange(c).setFontWeight('bold'));
  const from31 = addDays_(ctx.today, -30), cf = [];
  const jRows = mine.filter(x => x.day >= from31).sort((x, y) => tms_(y.r[IJ['Début contrat']]) - tms_(x.r[IJ['Début contrat']]) || y.day.localeCompare(x.day)).map(x => { const r = x.r;
    return [r[IJ['Date']], ctx.drvName[x.code] || r[IJ['Chauffeur']], r[IJ['Contrat']] || 'Hors contrat', r[IJ['Début contrat']], r[IJ['Fin contrat']] || (r[IJ['Contrat']] ? 'en cours' : ''),
      r[IJ['Km']], hv_(r[IJ['Conduite (h)']]), hv_(r[IJ['Ralenti (h)']]), hv_(r[IJ['Ralenti prolongé (h)']]), r[IJ['Nb ralentis prolongés']],
      r[IJ['Carburant (L)']] === '' ? NM : r[IJ['Carburant (L)']], r[IJ['L/100 km']], r[IJ['Vmax (km/h)']], r[IJ['Limite à Vmax']],
      r[IJ['Pire dépassement (km/h)']], r[IJ['Événements']], r[IJ['Score /100 km']], r[IJ['Pleins']], r[IJ['Siphonages suspects']], r[IJ['Source ralenti']], r[IJ['Source carburant']]]; });
  const tj = table_(s, 9, 'Journées de travail (31 derniers jours, horaires des contrats)', ['Date', 'Chauffeur', 'Contrat', 'Début', 'Fin', 'Km', 'Conduite',
    'Ralenti total', 'dont prolongé', 'Arrêts prolongés', 'Carburant (L)', 'L/100 km', 'Vmax (km/h)', 'Limite route à Vmax', 'Pire dépassement (km/h)',
    'Événements', 'Score /100 km', 'Pleins', 'Siphonages', 'Source ralenti', 'Source carburant'], jRows, [FD, null, null, FDT, FDT, F1, FH, FH, FH, F0, F1, F1, F0, F0, F0, F0, F1, F0, F0]);
  [7, 8, 14].forEach(c => cf.push(gradRule_(colRange_(s, tj, c))));
  cf.push(gradRule_(colRange_(s, tj, 16), '#63BE7B', '#FFEB84', '#F8696B'), greyNM_(colRange_(s, tj, 10)));
  const er = {};
  ctx.evts.filter(e => e.key === v.key && inP_(e.num && ctx.ctrDay[e.num] ? ctx.ctrDay[e.num] : e.day, p)).forEach(e => {
    const k = e.rid + '|' + e.code; const o = er[k] || (er[k] = { rule: ctx.rules[e.rid] ? ctx.rules[e.rid].name : e.rid, nom: ctx.drvName[e.code] || e.code, n: 0, dur: 0, w: ctx.rules[e.rid] ? ctx.rules[e.rid].w : 0 });
    o.n++; o.dur += num_(e.r[ctx.IE['Durée (s)']]); });
  const eRows = Object.values(er).sort((x, y) => y.n * y.w - x.n * x.w || y.n - x.n).map(o => [o.rule, o.nom, o.n, hv_(o.dur / 3600), o.w, r1_(o.n * o.w)]);
  const te = table_(s, tj.next + 1, 'Événements Geotab par règle et chauffeur (période du tableau de bord)', ['Règle', 'Chauffeur', 'Nombre', 'Durée cumulée', 'Poids', 'Points'], eRows, [null, null, F0, FH, F1, F1]);
  cf.push(gradRule_(colRange_(s, te, 5)));
  const lim = dayBounds_(from31).start.getTime();
  const iRows = ctx.idles.filter(x => x.key === v.key && x.t >= lim).sort((a, b) => b.t - a.t).map(x => idleRow_(ctx, x));
  const ti = table_(s, te.next + 1, 'Arrêts véhicule immobile contact mis (31 jours)', IDLE_HEAD, iRows, IDLE_FMT);
  cf.push(gradRule_(colRange_(s, ti, 3)), greyNM_(s.getRange(ti.first, 1, Math.max(ti.n, 1), IDLE_HEAD.length)));
  const fRows = ctx.fuels.filter(x => x.key === v.key && x.t >= lim).sort((a, b) => b.t - a.t).map(x => { const r = x.r, J = ctx.IF;
    return [r[J['Arrêt début']], r[J['Type']], r[J['Moteur']], r[J['Niveau avant (%)']], r[J['Niveau après (%)']], r[J['Litres (jauge)']], r[J['Litres Geotab']], ctx.drvName[x.code] || r[J['Chauffeur']], r[J['Chauffeur suivant']], r[J['Statut']]]; });
  const tf = table_(s, ti.next + 1, 'Pleins et siphonages suspects (31 jours)', ['Date / heure', 'Type', 'Moteur', 'Jauge avant (%)', 'Jauge après (%)', 'Litres (jauge)', 'Litres Geotab', 'Chauffeur', 'Chauffeur au redémarrage', 'Statut'], fRows,
    [FDT, null, null, F1, F1, F1, F1]);
  cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('SIPHONAGE_SUSPECT').setBackground('#C00000').setFontColor('#FFFFFF').setRanges([colRange_(s, tf, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('PLEIN').setBackground('#C6EFCE').setFontColor('#006100').setRanges([colRange_(s, tf, 1)]).build());
  const aRows = ctx.alerts.filter(x => plateKey_(x.r[ctx.IA['Plaque']]) === v.key).slice(0, 30).map(x => [x.r[ctx.IA['Date']], x.r[ctx.IA['Heure']], x.r[ctx.IA['Chauffeur']], x.r[ctx.IA['Type']], x.r[ctx.IA['Gravité']], x.r[ctx.IA['Valeur']], x.r[ctx.IA['Détail']], x.r[ctx.IA['Statut']]]);
  const ta = table_(s, tf.next + 1, 'Alertes (30 plus récentes)', ['Date', 'Heure', 'Chauffeur', 'Type', 'Gravité', 'Valeur', 'Détail', 'Statut'], aRows, [FD, '@']);
  cf.push.apply(cf, gravRules_(colRange_(s, ta, 4)));
  s.setConditionalFormatRules(cf);
  widths_(s, 1, [110, 190, 95, 105, 105].concat(new Array(14).fill(85)));
  // Graphiques (données en colonnes AF+)
  const CH = 32; ensureSize_(s, Math.max(s.getMaxRows(), 400), CH + 5);
  const g1 = lv.filter(x => x.t.getTime() >= now - 72 * HOUR).map(x => [x.t, x.v]);
  s.getRange(1, CH, 1, 2).setValues([['Horodatage', 'Jauge (%)']]).setFontColor('#A6A6A6');
  if (g1.length) { s.getRange(2, CH, g1.length, 2).setValues(g1).setFontColor('#A6A6A6'); s.getRange(2, CH, g1.length, 1).setNumberFormat(FDT); }
  const byDay = aggJrn_(mine.filter(x => x.day >= from31), IJ, x => x.day, P);
  const g2 = Object.keys(byDay).sort().map(d => [dayToDate_(d), r2_(byDay[d].idle), r2_(byDay[d].idleLong)]);
  s.getRange(1, CH + 2, 1, 3).setValues([['Journée', 'Ralenti total (h)', 'Ralenti prolongé (h)']]).setFontColor('#A6A6A6');
  if (g2.length) { s.getRange(2, CH + 2, g2.length, 3).setValues(g2).setFontColor('#A6A6A6'); s.getRange(2, CH + 2, g2.length, 1).setNumberFormat('dd/MM'); }
  if (g1.length > 1) s.insertChart(s.newChart().setChartType(Charts.ChartType.LINE).addRange(s.getRange(1, CH, g1.length + 1, 2))
    .setPosition(9, 21, 10, 0).setOption('title', 'Jauge carburant, 72 dernières heures (%)').setOption('legend', { position: 'none' })
    .setOption('vAxis', { minValue: 0, maxValue: 100 }).setOption('width', 620).setOption('height', 300).build());
  if (g2.length > 1) s.insertChart(s.newChart().setChartType(Charts.ChartType.COLUMN).addRange(s.getRange(1, CH + 2, g2.length + 1, 3))
    .setPosition(25, 21, 10, 0).setOption('title', 'Heures de ralenti par journée').setOption('colors', ['#9DC3E6', '#C00000'])
    .setOption('width', 620).setOption('height', 300).build());
}

// ============================================================================
// 11. RAPPORT EMAIL ET AUTOMATISATION
// ============================================================================
/** Tâche quotidienne : rendu complet puis email */
function dailyJob() { try { withLock_('Rendu quotidien', () => renderAll_(), true); } catch (e) { log_('Rendu quotidien', e.message); } if (String(params_().emails || '').trim()) sendDailyReport(); }
function sendDailyReport() {
  const P = params_();
  const to = String(P.emails || '').trim();
  if (!to) { const u = ui_(); if (u) u.alert('Renseignez "Emails rapport quotidien" dans ' + S.PARAM + '.'); return; }
  const ctx = viewCtx_(), day = addDays_(ctx.today, -1);
  const tbl = (head, rows) => '<table style="border-collapse:collapse;font-family:Arial;font-size:12px">' +
    '<tr>' + head.map(h => '<th style="background:#1F3864;color:#fff;padding:4px 8px;text-align:left">' + h + '</th>').join('') + '</tr>' +
    rows.map(r => '<tr>' + r.map(c => '<td style="border:1px solid #ddd;padding:4px 8px">' + (c === null || c === undefined ? '' : c) + '</td>').join('') + '</tr>').join('') + '</table>';
  const al = ctx.alerts.filter(x => x.day === day && /Critique|Haute/.test(x.r[ctx.IA['Gravité']]));
  const yRows = ctx.jrn.filter(x => x.day === day);
  const byD = aggJrn_(yRows.filter(x => x.code !== HORS), ctx.IJ, x => x.code, P);
  const ds7 = driverStats_(ctx, { from: addDays_(ctx.today, -7), to: day }).list.slice(0, 5);
  let html = '<div style="font-family:Arial"><h2 style="color:#1F3864">Rapport flotte, journées de travail du ' + fmtDay_(day) + '</h2>';
  html += '<h3>Alertes critiques et hautes (' + al.length + ')</h3>' + tbl(['Heure', 'Plaque', 'Chauffeur', 'Type', 'Gravité', 'Détail'],
    al.map(x => [x.r[ctx.IA['Heure']], x.r[ctx.IA['Plaque']], x.r[ctx.IA['Chauffeur']], x.r[ctx.IA['Type']], x.r[ctx.IA['Gravité']], x.r[ctx.IA['Détail']]]));
  html += '<h3>Chauffeurs : ralenti et consommation</h3>' + tbl(['Chauffeur', 'Km', 'Ralenti total', 'dont prolongé', 'Arrêts prolongés', 'Carburant (L)', 'L/100 km', 'Vmax'],
    Object.values(byD).sort((a, b) => b.idleLong - a.idleLong).map(a => [ctx.drvName[a.k] || a.k, r1_(a.km), fmtH_(a.idle), fmtH_(a.idleLong), a.nLong, fuelVal_(a), l100Val_(a), a.vmax]));
  html += '<h3>Top 5 chauffeurs dangereux (7 jours)</h3>' + tbl(['Chauffeur', 'Niveau', 'Score /100 km', 'Événements', 'Km', 'Vmax'],
    ds7.map(d => [d.nom, d.level, r1_(d.score), d.a.evts, r1_(d.a.km), d.a.vmax]));
  html += '<p><a href="' + ss_().getUrl() + '">Ouvrir le tableau de bord</a></p></div>';
  MailApp.sendEmail({ to: to, subject: 'Flotte : rapport du ' + fmtDay_(day) + (al.length ? ' (' + al.length + ' alertes)' : ''), htmlBody: html });
  log_('Rapport email', 'Envoyé à ' + to);
  toast_('Rapport envoyé à ' + to, 'Email');
}
function installTriggers(silent) {
  removeTriggers(true);
  const m = [1, 5, 10, 15, 30].indexOf(params_().liveMin) >= 0 ? params_().liveMin : 5;
  ScriptApp.newTrigger('collect').timeBased().everyMinutes(m).create();
  ScriptApp.newTrigger('dailyJob').timeBased().atHour(7).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss_()).onEdit().create();
  log_('Automatisation', 'Activée : collecte temps réel toutes les ' + m + ' min');
  const u = silent === true ? null : ui_();
  if (u) u.alert('Automatisation activée', 'Toutes les ' + m + ' min : état des véhicules (EN DIRECT) et trajets terminés.\n' +
    'Toutes les 15 min : tableau de bord et jour. Toutes les 3 h : tous les onglets.\n' +
    'Chaque jour vers midi : journée de la veille finalisée (calcul complet, définitif).\nChaque jour à 7h : rapport email.', u.ButtonSet.OK);
}
function removeTriggers(silent) {
  ['autoSync', 'collect', 'sendDailyReport', 'dailyJob', 'runSyncQueue', 'runRefreshQueue', 'onFicheEdit', 'onSheetEdit', 'migrateV6'].forEach(clearTriggers_);
  if (silent !== true) { log_('Automatisation', 'Désactivée'); toast_('Automatisation désactivée.'); }
}
/** Ancien déclencheur horaire (v5) : remplacé par collect */
function autoSync() { collect(); }

/** Intervalles plein complet → plein complet par véhicule, avec km, litres remis et chauffeurs */
function fullToFull_(ctx) {
  const P = ctx.P, I = ctx.IF;
  if (ctx._ff) return ctx._ff;
  const T = readData_(S.TRIP, ctx.from), IT = idx_(H.TRIP), tripsBy = {};
  T.rows.forEach(r => { const k = String(r[IT['Clé plaque']]); (tripsBy[k] = tripsBy[k] || []).push({ t: tms_(r[IT['Début']]), km: num_(r[IT['Km']]), code: String(r[IT['Code chauffeur']]),
    fuel: r[IT['Carburant (L)']], src: String(r[IT['Source carburant']]) }); });
  const fills = {}, out = [];
  ctx.fuels.filter(x => x.r[I['Type']] === 'PLEIN').forEach(x => { (fills[x.key] = fills[x.key] || []).push(x); });
  const litresOf = x => x.r[I['Litres Geotab']] !== '' ? num_(x.r[I['Litres Geotab']]) : (x.r[I['Litres (jauge)']] !== '' ? num_(x.r[I['Litres (jauge)']]) : null);
  const full = x => x.r[I['Niveau après (%)']] !== '' && num_(x.r[I['Niveau après (%)']]) >= P.fullPct;
  Object.keys(fills).forEach(k => {
    const f = fills[k].sort((a, b) => a.t - b.t);
    for (let i = 0; i < f.length; i++) {
      if (!full(f[i])) continue;
      let added = 0, ok = true, j = i + 1;
      for (; j < f.length; j++) { const l = litresOf(f[j]); if (l === null) { ok = false; break; } added += l; if (full(f[j])) break; }
      if (!ok || j >= f.length) continue;
      const tr = (tripsBy[k] || []).filter(x => x.t > f[i].t && x.t < f[j].t);
      const km = tr.reduce((s, x) => s + x.km, 0);
      const codes = tr.map(x => x.code).filter((c, n, a) => a.indexOf(c) === n);
      const allMeasured = tr.length && tr.every(x => x.fuel !== '' && x.src !== 'Non mesuré');
      const measured = allMeasured ? tr.reduce((s, x) => s + num_(x.fuel), 0) : null;
      out.push({ key: k, plate: (ctx.veh[k] || {}).plate || k, from: f[i].t, to: f[j].t, km, litres: added,
        l100: km >= 50 ? added / km * 100 : null, codes, names: codes.map(c => ctx.drvName[c] || c),
        single: codes.length === 1 && codes[0] !== HORS ? (ctx.drvName[codes[0]] || codes[0]) : '',
        measured, gap: measured !== null && added > 0 ? (measured / added - 1) * 100 : null });
      i = j - 1;
    }
  });
  ctx._ff = out.sort((a, b) => b.to - a.to);
  return ctx._ff;
}

// ---------- SOURCES & CONTRÔLE ----------
function renderControl_(ctx) {
  const s = sh_(S.CTRL); if (!s) return;
  resetView_(s, 1);
  title_(s, 'Sources de mesure et contrôle de fiabilité', 'Pour chaque véhicule, la part des cycles contact où chaque mesure Geotab a réellement été lue (30 derniers jours), ' +
    'puis le contrôle croisé entre sources indépendantes. Rien n\'est estimé : une mesure absente reste vide dans les tableaux.');
  const cf = [], vs = Object.values(ctx.veh).filter(v => v.active);
  const T = readData_(S.TRIP, addDays_(ctx.today, -30)), IT = idx_(H.TRIP), lim = dayBounds_(addDays_(ctx.today, -29)).start.getTime(), cov = {};
  T.rows.forEach(r => { if (tms_(r[IT['Début']]) < lim) return; const k = String(r[IT['Clé plaque']]), km = num_(r[IT['Km']]);
    const o = cov[k] || (cov[k] = { n: 0, km: 0, fuel: 0, ecu: 0, idleL: 0, rpm: 0, fast: 0, limOk: 0, gps: 0, chk: { a: 0, b: 0, n: 0 } });
    o.n++; o.km += km;
    if (r[IT['Carburant (L)']] !== '') o.fuel++;
    if (r[IT['Contrôle calculateur (L)']] !== '') o.ecu++;
    if (r[IT['Carburant ralenti (L)']] !== '') o.idleL++;
    if (r[IT['Source ralenti']] === 'Régime moteur') o.rpm++;
    if (num_(r[IT['Vmax (km/h)']]) >= 30) { o.fast++; if (r[IT['Limite à Vmax']] !== '') o.limOk++; }
    if (r[IT['Vmax GPS (contrôle)']] !== '' && num_(r[IT['Vmax GPS (contrôle)']]) > num_(r[IT['Vmax (km/h)']]) + 20) o.gps++;
    if (r[IT['Carburant (L)']] !== '' && r[IT['Contrôle calculateur (L)']] !== '') { o.chk.a += num_(r[IT['Carburant (L)']]); o.chk.b += num_(r[IT['Contrôle calculateur (L)']]); o.chk.n++; } });
  const Sy = readTable_(S.SYNC), ISy = idx_(H.SYNC), last = {};
  Sy.rows.forEach(r => { const k = String(r[ISy['Clé plaque']]), t = toDate_(r[ISy['Synchronisé le']]); if (t && (!last[k] || t > last[k])) last[k] = t; });
  const pct = (x, n) => n ? r1_(x / n * 100) : '';
  const t1 = table_(s, 4, 'Mesures Geotab réellement lues (30 derniers jours, % des cycles contact)', ['Plaque', 'Modèle', 'Cycles contact', 'Km',
    'Litres : compteur boîtier', 'Contrôle : calculateur moteur', 'Litres au ralenti : compteur', 'Ralenti : régime moteur couvert ≥ 80 %',
    'Limite de vitesse connue (cycles > 30 km/h)', 'Sauts GPS écartés', 'Dernière synchro'],
    vs.map(v => { const o = cov[v.key]; if (!o) return [v.plate, v.model, 0, 0, '', '', '', '', '', '', last[v.key] || 'jamais'];
      return [v.plate, v.model, o.n, r1_(o.km), pct(o.fuel, o.n), o.ecu ? pct(o.ecu, o.n) : 'non remonté', pct(o.idleL, o.n), pct(o.rpm, o.n), pct(o.limOk, o.fast), o.gps, last[v.key] || 'jamais']; }),
    [null, null, F0, F0, FP, FP, FP, FP, FP, F0, FDT]);
  [4, 6, 7, 8].forEach(c => cf.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(80).setBackground('#FFC7CE').setFontColor('#9C0006').setRanges([colRange_(s, t1, c)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(95).setBackground('#C6EFCE').setFontColor('#006100').setRanges([colRange_(s, t1, c)]).build()));
  // Contrôle croisé
  const ff = fullToFull_(ctx).filter(x => x.to >= lim), byV = {};
  ff.forEach(x => { const o = byV[x.key] || (byV[x.key] = { km: 0, l: 0, m: 0, ml: 0, n: 0 }); o.km += x.km; o.l += x.litres; o.n++; if (x.measured !== null) { o.m += x.measured; o.ml += x.litres; } });
  const verdict = gaps => { const g = gaps.filter(x => x !== null); if (!g.length) return 'Pas de comparaison possible'; return g.every(x => Math.abs(x) <= 15) ? 'Cohérent' : 'À vérifier'; };
  const t3 = table_(s, t1.next + 1, 'Contrôle croisé des consommations, 30 derniers jours (sources indépendantes, mêmes cycles ou mêmes intervalles)',
    ['Plaque', 'Cycles comparés boîtier vs calculateur', 'Litres compteur boîtier', 'Litres calculateur moteur', 'Écart boîtier vs calculateur (%)', 'Intervalles plein à plein',
      'L/100 plein à plein', 'Litres mesurés trajets', 'Litres consommés entre pleins (Geotab)', 'Écart (%)', 'Verdict'],
    vs.map(v => { const o = cov[v.key] || { chk: { a: 0, b: 0, n: 0 } }, f = byV[v.key];
      const g1 = o.chk.n && o.chk.b ? (o.chk.a / o.chk.b - 1) * 100 : null, g2 = f && f.ml ? (f.m / f.ml - 1) * 100 : null;
      return [v.plate, o.chk.n, o.chk.n ? r1_(o.chk.a) : '', o.chk.n ? r1_(o.chk.b) : '', g1 !== null ? r1_(g1) : '', f ? f.n : 0,
        f && f.km >= 50 ? r1_(f.l / f.km * 100) : '', f && f.ml ? r1_(f.m) : '', f && f.ml ? r1_(f.ml) : '', g2 !== null ? r1_(g2) : '', verdict([g1, g2])]; }),
    [null, F0, F1, F1, FP, F0, F1, F1, F1, FP, null]);
  cf.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Cohérent').setBackground('#C6EFCE').setFontColor('#006100').setRanges([colRange_(s, t3, 10)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('À vérifier').setBackground('#FFC7CE').setFontColor('#9C0006').setRanges([colRange_(s, t3, 10)]).build());
  // Constats calculés à partir des mesures lues
  const notes = vs.map(v => { const o = cov[v.key], miss = [];
    if (!o) return [v.plate, 'Aucun cycle synchronisé sur 30 jours : lancer « Synchroniser une période »'];
    if (o.fuel / o.n < 0.95) miss.push('litres mesurés sur ' + pct(o.fuel, o.n) + ' % des cycles seulement (compteur carburant du boîtier non relevé à la coupure)');
    if (o.idleL / o.n < 0.95) miss.push('litres au ralenti mesurés sur ' + pct(o.idleL, o.n) + ' % des cycles');
    if (o.rpm / o.n < 0.8) miss.push('régime moteur couvert sur ' + pct(o.rpm, o.n) + ' % des cycles : sur les autres, le ralenti n\'est pas certifié');
    if (o.fast && o.limOk / o.fast < 0.7) miss.push('limite de vitesse inconnue sur ' + r1_(100 - o.limOk / o.fast * 100) + ' % des cycles rapides (cartographie Geotab)');
    if (!o.ecu) miss.push(/SONATA/i.test(v.model) ? 'pas de compteur calculateur moteur (normal sur la Sonata hybride) : le contrôle se fait par les pleins' : 'compteur calculateur moteur non remonté');
    return [v.plate, miss.length ? miss.join(' | ') : 'Toutes les mesures sont lues et concordent']; });
  const t4 = table_(s, t3.next + 1, 'Constats', ['Plaque', 'Constat'], notes, null);
  if (t4.n) s.getRange(t4.first, 2, t4.n, 1).setWrap(true);
  s.setConditionalFormatRules(cf);
  widths_(s, 1, [110, 380].concat(new Array(11).fill(110)));
  s.setColumnWidth(2, 380);
}

// ============================================================================
// 12. COMPTE RENDU CHAUFFEUR (PDF)
// ============================================================================
function openReportDialog() {
  const D = readTable_(S.DRV), ID = idx_(H.DRV);
  const opts = D.rows.map(r => [String(r[ID['Code']]), String(r[ID['Nom']])]).sort((a, b) => a[1].localeCompare(b[1]))
    .map(o => '<option value="' + o[0] + '">' + o[1].replace(/</g, '') + ' (' + o[0] + ')</option>').join('');
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;font-size:13px">' +
    '<p>Chauffeur<br><select id="c" style="width:100%;padding:4px">' + opts + '</select></p>' +
    '<p style="color:#666">Le PDF contient la synthèse depuis le début, le détail par mois, par semaine et par journée de travail (horaires des contrats), ' +
    'les arrêts moteur allumé avec heure et lieu, les excès de vitesse, les événements Geotab, les pleins et les alertes.</p>' +
    '<button id="b" onclick="go()" style="background:#1F3864;color:#fff;border:0;padding:8px 16px;border-radius:6px">Générer le PDF</button>' +
    '<p id="s"></p></div>' +
    '<script>function go(){var b=document.getElementById("b");b.disabled=true;document.getElementById("s").innerText="Génération en cours (10 à 30 s)...";' +
    'google.script.run.withSuccessHandler(function(r){b.disabled=false;document.getElementById("s").innerHTML="PDF prêt : <a target=\\"_blank\\" href=\\""+r.url+"\\">"+r.name+"</a><br><small>Enregistré dans Drive, dossier "+r.folder+"</small>";})' +
    '.withFailureHandler(function(e){b.disabled=false;document.getElementById("s").innerText="Erreur : "+e.message;})' +
    '.generateDriverReport(document.getElementById("c").value);}</script>'
  ).setWidth(460).setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, 'Compte rendu chauffeur');
}

/** Génère le PDF et le range dans Drive. Retourne {url, name, folder}. */
function generateDriverReport(code) {
  const t0 = Date.now();
  const html = driverReportHtml_(code);
  const ctxName = (readTable_(S.DRV).rows.find(r => String(r[0]) === String(code)) || [code, code])[1];
  const name = 'Compte rendu ' + ctxName + ' ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH\'h\'mm');
  const pdf = htmlToPdf_(html, name);
  const folderName = 'Comptes rendus chauffeurs';
  const it = DriveApp.getFoldersByName(folderName);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
  const file = folder.createFile(pdf);
  log_('Compte rendu', ctxName + ' (' + code + ')', t0);
  return { url: file.getUrl(), name: name + '.pdf', folder: folderName };
}

// ---------- PDF : mise en page compatible avec le moteur Google Docs ----------
/** Encadré coloré (tableau d'une cellule : seul élément dont Google garde le fond et la bordure) */
/** Ligne de titre de section à placer en tête d'un tableau (colspan) */
function titleRow_(inner, cols) {
  return '<tr><td colspan="' + cols + '" style="background:#1F3864;border:1px solid #1F3864;padding:6px 8px;color:#FFFFFF;font-size:12pt;font-weight:bold">' +
    String(inner).replace(/<div class="ar" dir="rtl">/g, '<div class="ar" dir="rtl" style="color:#FFFFFF;font-size:11pt;font-weight:bold">') + '</td></tr>';
}
function msgBox_(inner, bg, bar) {
  return '<table style="width:100%;border-collapse:collapse;margin:6px 0"><tr>' +
    (bar ? '<td style="width:6px;background:' + bar + ';border:1px solid ' + bar + '">&nbsp;</td>' : '') +
    '<td style="background:' + bg + ';border:1px solid ' + bg + ';padding:7px 9px">' + inner + '</td></tr></table>';
}
/** Adapte le HTML des rapports au convertisseur Google : titres de section en bandeau (tableau), bordures invisibles par défaut */
function docify_(html) {
  html = html.replace(/<h2>([\s\S]*?)<\/h2>/g, (m, x) => '<table style="width:100%;border-collapse:collapse;margin-top:12px"><tr><td style="background:#1F3864;border:1px solid #1F3864;padding:6px 8px;color:#FFFFFF;font-size:12pt;font-weight:bold">' +
    x.replace(/<div class="ar" dir="rtl">/g, '<div class="ar" dir="rtl" style="color:#FFFFFF;font-size:11pt;font-weight:bold">') + '</td></tr></table>');
  return html.replace('</style>', 'td{border:1px solid #FFFFFF}</style>');
}
/**
 * HTML -> PDF avec le moteur de conversion de Google Docs (rendu fidèle, arabe correct) :
 * le HTML est importé en document Google (API Drive), mis en page A4 marges étroites, exporté en PDF, puis le document est supprimé.
 * Si l'import échoue, conversion directe (rendu plus simple).
 */
function htmlToPdf_(html, name) {
  html = docify_(html);
  try {
    const boundary = 'b' + Date.now();
    const meta = JSON.stringify({ name: name + ' (temp)', mimeType: 'application/vnd.google-apps.document' });
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary +
      '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + boundary + '--';
    const r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: Utilities.newBlob(body).getBytes(),
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    const id = JSON.parse(r.getContentText()).id;
    if (!id) throw new Error('import ' + r.getResponseCode());
    try {
      const doc = DocumentApp.openById(id), bd = doc.getBody();
      bd.setPageWidth(595.3).setPageHeight(841.9).setMarginTop(28).setMarginBottom(28).setMarginLeft(28).setMarginRight(28);
      doc.saveAndClose();
    } catch (e) { }
    const f = DriveApp.getFileById(id), pdf = f.getAs('application/pdf').setName(name + '.pdf');
    f.setTrashed(true);
    return pdf;
  } catch (e) {
    log_('PDF', 'Import Google Docs indisponible (' + e.message + '), conversion simple utilisée');
    return Utilities.newBlob(html, 'text/html', name + '.html').getAs('application/pdf').setName(name + '.pdf');
  }
}

function esc_(v) { return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function htmlTable_(head, rows, opt) {
  opt = opt || {};
  if (!rows.length) return '<p class="nd">' + (opt.empty || 'Aucune donnée.') + '</p>';
  return '<table><tr>' + head.map(h => '<th>' + esc_(h) + '</th>').join('') + '</tr>' +
    rows.map((r, i) => '<tr' + (opt.total && i === rows.length - 1 ? ' class="tot"' : '') + '>' +
      r.map((c, j) => '<td' + (j > 0 && typeof c === 'number' ? ' class="n"' : '') + '>' + esc_(c) + '</td>').join('') + '</tr>').join('') + '</table>';
}

function driverReportHtml_(code) {
  code = String(code);
  const ctx = viewCtx_(addDays_(localDay_(new Date()), -Math.max(7, params_().retentionDays || 62))), P = ctx.P, IJ = ctx.IJ;
  const nom = ctx.drvName[code] || code;
  const D = readTable_(S.DRV), ID = idx_(H.DRV), drv = D.rows.find(r => String(r[ID['Code']]) === code) || [];
  const mine = ctx.jrn.filter(x => x.code === code).sort((a, b) => (tms_(a.r[IJ['Début contrat']]) || dayBounds_(a.day).start.getTime()) - (tms_(b.r[IJ['Début contrat']]) || dayBounds_(b.day).start.getTime()));
  if (!mine.length) throw new Error('Aucune journée de travail synchronisée pour ' + nom + '.');
  const nums = {}; mine.forEach(x => { if (x.num) nums[x.num] = 1; });
  const all = aggJrn_(mine, IJ, () => 'A', P).A;
  const allP = { from: '0000-00-00', to: '9999-99-99' };
  const rk = driverStats_(ctx, allP), pos = rk.list.findIndex(d => d.code === code), me = rk.list[pos];
  const H2 = h => fmtH_(h);
  const fuelTxt = a => a.fuelN ? r1_(a.fuel) : NM, l100Txt = a => a.l100 !== null ? r1_(a.l100) : (a.fuelN ? 'km insuffisants' : NM);
  const line = (label, a) => [label, Object.keys(a.ctr).length, H2(a.ctrH), r1_(a.km), H2(a.drive), H2(a.idle), H2(a.idleLong), a.nLong,
    fuelTxt(a), l100Txt(a), a.idleFuelN ? r1_(a.idleFuel) : NM, a.vmax, a.worst === null ? '' : '+' + a.worst, a.evts, r1_(scoreOf_(a, P)), a.pleins, a.siph];
  const HEAD = ['Période', 'Journées', 'Heures contrat', 'Km', 'Conduite', 'Ralenti total', 'dont prolongé', 'Arrêts prolongés', 'Carburant (L)',
    'L/100 km', 'Ralenti (L)', 'Vmax', 'Pire dépassement', 'Événements', 'Score /100 km', 'Pleins', 'Siphonages'];
  const group = keyFn => { const g = {}; mine.forEach(x => { const k = keyFn(x); (g[k] = g[k] || []).push(x); }); return g; };
  // Par mois
  const byM = group(x => x.day.slice(0, 7));
  const mRows = Object.keys(byM).sort().map(k => line(k.slice(5) + '/' + k.slice(0, 4), aggJrn_(byM[k], IJ, () => 'A', P).A));
  // Par semaine
  const byW = group(x => mondayOf_(x.day));
  const wRows = Object.keys(byW).sort().map(k => line('Sem. du ' + fmtDay_(k).slice(0, 5) + ' au ' + fmtDay_(addDays_(k, 6)), aggJrn_(byW[k], IJ, () => 'A', P).A));
  // Par journée de travail (contrat)
  const jRows = mine.map(x => { const r = x.r;
    return [fmtDay_(x.day), r[IJ['Contrat']] || 'Hors contrat', r[IJ['Plaque']], r[IJ['Début contrat']] ? fmtDT_(r[IJ['Début contrat']]) : '',
      r[IJ['Fin contrat']] ? fmtDT_(r[IJ['Fin contrat']]) : (r[IJ['Contrat']] ? 'en cours' : ''), r[IJ['Km']], H2(r[IJ['Conduite (h)']]), H2(r[IJ['Ralenti (h)']]),
      H2(r[IJ['Ralenti prolongé (h)']]), r[IJ['Nb ralentis prolongés']], r[IJ['Carburant (L)']] === '' ? NM : r[IJ['Carburant (L)']],
      r[IJ['L/100 km']] === '' ? '-' : r[IJ['L/100 km']], r[IJ['Vmax (km/h)']], r[IJ['Limite à Vmax']], r[IJ['Pire dépassement (km/h)']] === '' ? '' : '+' + r[IJ['Pire dépassement (km/h)']],
      r[IJ['Événements']], r[IJ['Score /100 km']], r[IJ['Pleins']], r[IJ['Siphonages suspects']], (r[IJ['Source ralenti']] || '') + ' / ' + r[IJ['Source carburant']]]; });
  // Arrêts moteur allumé prolongés
  const iRows = ctx.idles.filter(x => x.code === code).sort((a, b) => a.t - b.t).map(x => { const r = x.r, I = ctx.II, ver = r[I['Vérification moteur']] === 'Régime moteur';
    return [fmtDT_(r[I['Début']]), localHM_(toDate_(r[I['Fin']])), r[I['Durée arrêt (min)']] + ' min', ver ? r[I['Moteur tournant (min)']] + ' min' : 'non vérifiable',
      idleCounted_(r) >= P.idleLongMin ? 'Oui' : 'Non (moteur arrêté)', r[I['Plaque']], r[I['Contrat']],
      r[I['Litres']] === '' ? NM : r[I['Litres']] + ' L (' + r[I['Source litres']] + ')', r[I['Lat']] !== '' ? r1x_(r[I['Lat']]) + ', ' + r1x_(r[I['Lon']]) : ''] ; });
  // Vitesse : trajets avec dépassement de la limite ou Vmax au-dessus du seuil
  const T = readData_(S.TRIP, ctx.from), IT = idx_(H.TRIP);
  const sRows = T.rows.filter(r => String(r[IT['Code chauffeur']]) === code && (num_(r[IT['Pire dépassement (km/h)']]) >= 10 || num_(r[IT['Vmax (km/h)']]) >= P.vmaxAlert))
    .sort((a, b) => tms_(a[IT['Début']]) - tms_(b[IT['Début']]))
    .map(r => [fmtDT_(r[IT['Début']]), r[IT['Plaque']], r[IT['Km']], r[IT['Vmax (km/h)']], r[IT['Limite à Vmax']], r[IT['Vitesse au pire']],
      r[IT['Limite au pire']], r[IT['Pire dépassement (km/h)']] === '' ? '' : '+' + r[IT['Pire dépassement (km/h)']], r[IT['Heure pire']], r[IT['Source limite']]]);
  // Événements : nombre par règle et liste détaillée
  const ev = ctx.evts.filter(e => e.code === code);
  const byR = {}; ev.forEach(e => { const rl = ctx.rules[e.rid] || { name: e.rid, w: 0 }; const o = byR[e.rid] || (byR[e.rid] = { n: rl.name, w: rl.w, c: 0, d: 0 }); o.c++; o.d += num_(e.r[ctx.IE['Durée (s)']]); });
  const rRows = Object.values(byR).sort((a, b) => b.c - a.c).map(o => [o.n, o.c, o.w, r1_(o.c * o.w), Math.round(o.d / 60) + ' min']);
  const evList = ev.filter(e => (ctx.rules[e.rid] || { w: 0 }).w > 0).sort((a, b) => tms_(b.r[ctx.IE['Début']]) - tms_(a.r[ctx.IE['Début']]));
  const eRows = evList.slice(0, 300).map(e => [fmtDT_(e.r[ctx.IE['Début']]), e.r[ctx.IE['Plaque']], (ctx.rules[e.rid] || {}).name || e.rid, e.r[ctx.IE['Durée (s)']] + ' s', e.r[ctx.IE['Contrat']]]);
  // Carburant
  const IF = ctx.IF;
  const pRows = ctx.fuels.filter(x => x.code === code && x.r[IF['Type']] === 'PLEIN').sort((a, b) => a.t - b.t)
    .map(x => [fmtDT_(x.t), x.r[IF['Plaque']], x.r[IF['Moteur']], x.r[IF['Niveau avant (%)']], x.r[IF['Niveau après (%)']], x.r[IF['Litres (jauge)']], x.r[IF['Litres Geotab']]]);
  const spRows = ctx.fuels.filter(x => x.r[IF['Type']] === 'SIPHONAGE_SUSPECT' && (x.code === code || x.r[IF['Chauffeur suivant']] === nom)).sort((a, b) => a.t - b.t)
    .map(x => [fmtDT_(x.r[IF['Arrêt début']]), fmtDT_(x.r[IF['Arrêt fin']]), x.r[IF['Plaque']], x.r[IF['Niveau avant (%)']] + ' % → ' + x.r[IF['Niveau après (%)']] + ' %',
      x.r[IF['Litres (jauge)']], x.code === code ? 'Véhicule garé par lui' : 'Redémarré par lui', x.r[IF['Statut']]]);
  const alRows = ctx.alerts.filter(a => String(a.r[ctx.IA['Code chauffeur']]) === code && a.r[ctx.IA['Statut']] !== 'Faux positif')
    .map(a => [fmtDay_(a.day), a.r[ctx.IA['Heure']], a.r[ctx.IA['Type']], a.r[ctx.IA['Gravité']], a.r[ctx.IA['Détail']], a.r[ctx.IA['Statut']]]);
  const first = mine[0], last = mine[mine.length - 1];
  const css = '<style>body{font-family:Arial,sans-serif;font-size:8pt;color:#222}h1{font-size:15pt;color:#1F3864;margin:0}h2{font-size:10.5pt;color:#fff;background:#1F3864;padding:4px 6px;margin:14px 0 6px}' +
    'table{border-collapse:collapse;width:100%;margin-bottom:6px}th{background:#D9E1F2;font-size:7pt;padding:3px;border:1px solid #B4C6E7;text-align:left}' +
    'td{font-size:7pt;padding:2px 3px;border:1px solid #D9D9D9}td.n{text-align:right}tr.tot td{font-weight:bold;background:#F2F2F2}.nd{color:#888;font-style:italic}' +
    '.k{display:inline-block;width:23%;margin:0 1% 6px 0;background:#F2F2F2;padding:5px;vertical-align:top}.k b{display:block;font-size:12pt;color:#1F3864}.small{color:#666;font-size:7pt}</style>';
  const kk = [], k = (l, v) => { kk.push('<td style="background:#F2F2F2;border:3px solid #FFFFFF;padding:5px;width:25%;vertical-align:top;font-size:8pt;color:#555">' + esc_(l) +
    '<br><b style="font-size:12pt;color:#1F3864">' + esc_(v) + '</b></td>'); return ''; };
  let h = '<html><head><meta charset="utf-8">' + css + '</head><body>';
  h += '<h1>Compte rendu chauffeur : ' + esc_(nom) + '</h1>';
  h += '<p>Code client ' + esc_(code) + (drv[ID['Téléphone']] ? ' · Tél. ' + esc_(drv[ID['Téléphone']]) : '') + ' · Édité le ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy à HH:mm') +
    '<br>Historique du ' + fmtDay_(first.day) + ' au ' + fmtDay_(last.day) + ' · ' + Object.keys(nums).length + ' contrats · véhicules ' + esc_(Object.keys(all.plates).join(', ')) + '</p>';
  h += '<h2>1. Synthèse depuis le début</h2>';
  h += k('Classement danger', me ? (pos + 1) + ' / ' + rk.list.length + ' (' + me.level + ')' : '-') + k('Score danger', r1_(scoreOf_(all, P)) + ' pts / 100 km') +
    k('Km parcourus', r1_(all.km)) + k('Heures sous contrat', H2(all.ctrH)) + k('Conduite', H2(all.drive)) + k('Ralenti total (moteur allumé à l\'arrêt)', H2(all.idle)) +
    k('dont ralenti prolongé', H2(all.idleLong) + ' (' + all.nLong + ' arrêts)') + k('Carburant mesuré', all.fuelN ? r1_(all.fuel) + ' L' : NM) +
    k('Consommation', all.l100 !== null ? r1_(all.l100) + ' L/100 km' : NM) + k('Carburant au ralenti', all.idleFuelN ? r1_(all.idleFuel) + ' L' : NM) +
    k('Vitesse max', all.vmax + ' km/h') + k('Pire dépassement de limite', all.worst === null ? '-' : '+' + all.worst + ' km/h') +
    k('Événements de conduite', all.evts) + k('Pleins effectués', all.pleins) + k('Siphonages suspects', all.siph) + k('Alertes', alRows.length);
  for (let i = 0; i < kk.length; i += 4) h += (i ? '' : '<table style="width:100%;border-collapse:collapse">') + '<tr>' + kk.slice(i, i + 4).join('') + '</tr>';
  h += '</table>';
  h += '<h2>2. Détail par mois</h2>' + htmlTable_(HEAD, mRows.concat([line('Total', all)]), { total: true });
  h += '<h2>3. Détail par semaine</h2>' + htmlTable_(HEAD, wRows.concat([line('Total', all)]), { total: true });
  h += '<h2>4. Détail par journée de travail (horaires du contrat)</h2>' + htmlTable_(['Date', 'Contrat', 'Véhicule', 'Début', 'Fin', 'Km', 'Conduite', 'Ralenti', 'dont prolongé',
    'Arrêts prol.', 'Carburant (L)', 'L/100', 'Vmax', 'Limite à Vmax', 'Pire dépass.', 'Évén.', 'Score', 'Pleins', 'Siph.', 'Sources ralenti / carburant'], jRows);
  h += '<h2>5. Arrêts véhicule immobile contact mis (≥ ' + P.idleLongMin + ' min), un par un</h2>' + htmlTable_(['Début', 'Fin', 'Durée arrêt', 'Moteur thermique tournant', 'Retenu', 'Véhicule', 'Contrat', 'Carburant consommé', 'Position GPS'], iRows, { empty: 'Aucun arrêt prolongé.' });
  h += '<h2>6. Vitesse : trajets avec dépassement de la limite de 10 km/h et plus, ou Vmax ≥ ' + P.vmaxAlert + ' km/h</h2>' +
    htmlTable_(['Trajet du', 'Véhicule', 'Km', 'Vmax', 'Limite à Vmax', 'Vitesse au pire', 'Limite au pire', 'Dépassement', 'Heure', 'Source limite'], sRows, { empty: 'Aucun dépassement relevé (ou limites de route non fournies par Geotab).' });
  h += '<h2>7. Événements de conduite Geotab</h2>' + htmlTable_(['Règle', 'Nombre', 'Poids', 'Points', 'Durée cumulée'], rRows, { empty: 'Aucun événement.' });
  h += '<p class="small">Liste détaillée' + (evList.length > 300 ? ' (300 plus récents sur ' + evList.length + ')' : '') + ' :</p>' +
    htmlTable_(['Date / heure', 'Véhicule', 'Règle', 'Durée', 'Contrat'], eRows, { empty: 'Aucun événement.' });
  h += '<h2>8. Carburant : pleins et anomalies de jauge</h2>' + htmlTable_(['Date / heure', 'Véhicule', 'Moteur', 'Jauge avant (%)', 'Jauge après (%)', 'Litres (jauge)', 'Litres Geotab'], pRows, { empty: 'Aucun plein détecté pendant ses contrats.' });
  const ffRows = fullToFull_(ctx).filter(x => x.codes.indexOf(code) >= 0).sort((a, b) => a.from - b.from)
    .map(x => [fmtDT_(x.from), fmtDT_(x.to), x.plate, r1_(x.km), r1_(x.litres), x.l100 !== null ? r1_(x.l100) : 'km insuffisants', x.single ? 'Lui seul' : 'Partagé : ' + x.names.join(', ')]);
  h += '<p class="small">Consommation plein à plein (litres remis à la pompe entre deux pleins complets / km roulés) :</p>' +
    htmlTable_(['Plein de départ', 'Plein d\'arrivée', 'Véhicule', 'Km', 'Litres remis', 'L/100 km', 'Chauffeur(s) sur l\'intervalle'], ffRows, { empty: 'Aucun intervalle plein à plein le concernant.' });
  h += htmlTable_(['Arrêt', 'Redémarrage', 'Véhicule', 'Jauge', 'Litres (jauge)', 'Rôle', 'Statut'], spRows, { empty: 'Aucun siphonage suspect le concernant.' });
  h += '<h2>9. Alertes</h2>' + htmlTable_(['Date', 'Heure', 'Type', 'Gravité', 'Détail', 'Statut'], alRows, { empty: 'Aucune alerte.' });
  h += '<h2>Méthode et sources</h2><p class="small">Toutes les valeurs proviennent du boîtier télématique Geotab installé sur le véhicule (base ' + esc_(P.geoDb) + '). ' +
    'Une journée de travail correspond aux horaires du contrat de location (départ effectif → retour effectif). Un trajet est attribué au chauffeur dont le contrat couvre l\'heure de départ ' +
    '(tolérance ' + P.ctrTolMin + ' min). Ralenti : véhicule immobile avec moteur thermique tournant, vérifié par le régime moteur (> ' + P.rpmMin + ' tr/min) ; ' +
    'quand le véhicule ne remonte pas son régime, temps contact mis mesuré par Geotab (source indiquée). Ralenti prolongé : arrêts continus d\'au moins ' +
    P.idleLongMin + ' min reconstitués à partir des positions GPS (feux et bouchons exclus), retenus seulement si le moteur thermique tournait. ' +
    'Carburant, par ordre de priorité : compteur carburant du véhicule, bilan carburant Geotab par trajet, débit carburant du moteur intégré dans le temps, évolution de la jauge ; ' +
    '« non mesuré » quand aucune mesure n\'existe, aucune valeur n\'est estimée. Consommation plein à plein : litres remis à la pompe entre deux pleins complets divisés par les km roulés. ' +
    'Limites de vitesse : cartographie Geotab, sinon OpenStreetMap (source indiquée). Score danger : somme des événements pondérés (poids : ' +
    esc_(Object.values(byR).filter(o => o.w > 0).map(o => o.n + ' x' + o.w).join(', ')) + ') pour 100 km.</p>';
  return h + '</body></html>';
}
function r1x_(v) { return Math.round(num_(v) * 100000) / 100000; }

// ============================================================================
// 14. RAPPORT HEBDOMADAIRE FLOTTE (PDF à présenter aux chauffeurs)
// ============================================================================
const WK_COLORS = { 'Faible': '#63BE7B', 'Modéré': '#FFD966', 'Élevé': '#F4B183', 'Dangereux': '#C00000' };
const WK_LABEL = { 'Faible': 'Conduite sûre', 'Modéré': 'À surveiller', 'Élevé': 'Risquée', 'Dangereux': 'Dangereuse' };

function openWeeklyDialog() {
  const today = localDay_(new Date()), m0 = mondayOf_(today), opts = [];
  for (let i = 0; i < 10; i++) {
    const m = addDays_(m0, -7 * i), s = addDays_(m, 6);
    opts.push('<option value="' + m + '"' + (i === 1 ? ' selected' : '') + '>Semaine du ' + fmtDay_(m).slice(0, 5) + ' au ' + fmtDay_(s) + (i === 0 ? ' (en cours)' : '') + '</option>');
  }
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;font-size:13px">' +
    '<p>Semaine<br><select id="w" style="width:100%;padding:4px">' + opts.join('') + '</select></p>' +
    '<p style="color:#666">PDF simple à présenter aux chauffeurs : répartition de la conduite (camembert), classement du plus sûr au plus dangereux, ' +
    'consommation par modèle de véhicule, carburant brûlé au ralenti, vitesse maximale et tableau récapitulatif. Données Geotab mesurées.</p>' +
    '<button id="b" onclick="go()" style="background:#1F3864;color:#fff;border:0;padding:8px 16px;border-radius:6px">Générer le PDF</button>' +
    '<p id="s"></p></div>' +
    '<script>function go(){var b=document.getElementById("b");b.disabled=true;document.getElementById("s").innerText="Génération en cours (20 à 60 s)...";' +
    'google.script.run.withSuccessHandler(function(r){b.disabled=false;document.getElementById("s").innerHTML="PDF prêt : <a target=\\"_blank\\" href=\\""+r.url+"\\">"+r.name+"</a><br><small>Enregistré dans Drive, dossier "+r.folder+"</small>";})' +
    '.withFailureHandler(function(e){b.disabled=false;document.getElementById("s").innerText="Erreur : "+e.message;})' +
    '.generateWeeklyReport(document.getElementById("w").value);}</script>'
  ).setWidth(480).setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, 'Rapport de la semaine');
}

/** Génère le PDF de la semaine qui commence le lundi `monday` (aaaa-mm-jj). Retourne {url, name, folder}. */
function generateWeeklyReport(monday) {
  const t0 = Date.now();
  monday = mondayOf_(monday ? toDayStr_(monday) || String(monday) : addDays_(localDay_(new Date()), -7));
  const html = weeklyReportHtml_(monday);
  const name = 'Bilan conduite semaine du ' + fmtDay_(monday).slice(0, 5) + ' au ' + fmtDay_(addDays_(monday, 6)).replace(/\//g, '-');
  const pdf = htmlToPdf_(html, name.replace(/\//g, '-'));
  const folderName = 'Rapports hebdomadaires flotte';
  const it = DriveApp.getFoldersByName(folderName);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
  const file = folder.createFile(pdf);
  log_('Rapport semaine', 'Semaine du ' + fmtDay_(monday), t0);
  return { url: file.getUrl(), name: name.replace(/\//g, '-') + '.pdf', folder: folderName };
}

/** Couleur sur une échelle vert -> jaune -> rouge (t de 0 à 1) */
function wkGrad_(t) {
  const c = [[99, 190, 123], [255, 217, 102], [248, 105, 107]], k = t <= 0.5 ? 0 : 1, u = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
  const m = c[k].map((v, i) => Math.round(v + (c[k + 1][i] - v) * u));
  return '#' + m.map(v => ('0' + v.toString(16)).slice(-2)).join('');
}
/** Diagramme en barres horizontales en HTML pur (rendu fiable dans le PDF Google) */
function wkBars_(items, opt) {
  opt = opt || {};
  if (!items.length) return '<p class="nd">' + (opt.empty || 'Pas de données mesurées cette semaine.') + '</p>';
  const max = opt.max || Math.max.apply(null, items.map(i => i.value).concat([1e-9]));
  let h = '<table class="bars">';
  items.forEach((it, i) => {
    const w = Math.max(1, Math.min(100, Math.round(it.value / max * 100)));
    h += '<tr><td class="rk">' + (opt.noRank ? '' : (i + 1)) + '</td><td class="lb">' + esc_(it.label) + (it.sub ? '<br><span class="sub">' + esc_(it.sub) + '</span>' : '') + '</td>' +
      '<td class="br"><table class="b"><tr><td style="width:' + w + '%;background:' + it.color + '">&nbsp;</td>' + (w < 100 ? '<td style="width:' + (100 - w) + '%"></td>' : '') + '</tr></table></td>' +
      '<td class="vl">' + esc_(it.text) + '</td></tr>';
  });
  return h + '</table>';
}
/** Camembert : image d'un graphique Google Sheets (onglet temporaire), sinon barre de répartition en HTML */
// ---------- Camembert en image PNG, dessiné en JavaScript (aucune dépendance, rendu identique partout) ----------
const PNG_DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], 3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
};
function pngCrc_(bytes) {
  let c, crc = -1;
  if (!pngCrc_.t) { pngCrc_.t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; pngCrc_.t[n] = c >>> 0; } }
  for (let i = 0; i < bytes.length; i++) crc = pngCrc_.t[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
const u32_ = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const signed_ = a => a.map(x => (x & 255) > 127 ? (x & 255) - 256 : (x & 255));
/** Compression zlib (deflate) via Utilities.gzip ; repli : blocs non compressés */
function pngZlib_(raw) {
  let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  const adler = u32_(((b << 16) | a) >>> 0);
  try {
    const gz = Utilities.gzip(Utilities.newBlob(signed_(Array.from(raw)))).getBytes().map(x => x & 255);
    if (gz[0] !== 31 || gz[1] !== 139 || gz[2] !== 8) throw new Error('gzip');
    const flg = gz[3]; let o = 10;
    if (flg & 4) o += 2 + gz[o] + (gz[o + 1] << 8);
    if (flg & 8) { while (gz[o] !== 0) o++; o++; }
    if (flg & 16) { while (gz[o] !== 0) o++; o++; }
    if (flg & 2) o += 2;
    return [0x78, 0x9C].concat(gz.slice(o, gz.length - 8), adler);
  } catch (e) {
    const out = [0x78, 0x01];
    for (let i = 0; i < raw.length || i === 0; i += 65535) {
      const n = Math.min(65535, raw.length - i), last = i + n >= raw.length ? 1 : 0;
      out.push(last, n & 255, n >>> 8, ~n & 255, (~n >>> 8) & 255);
      for (let j = 0; j < n; j++) out.push(raw[i + j]);
      if (!raw.length) break;
    }
    return out.concat(adler);
  }
}
function pngEncode_(w, h, rgb) {   // rgb : Uint8Array w*h*3
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const chunk = (type, data) => { const td = type.split('').map(c => c.charCodeAt(0)).concat(data); return u32_(data.length).concat(td, u32_(pngCrc_(td))); };
  const ihdr = u32_(w).concat(u32_(h), [8, 2, 0, 0, 0]);
  return [137, 80, 78, 71, 13, 10, 26, 10].concat(chunk('IHDR', ihdr), chunk('IDAT', pngZlib_(raw)), chunk('IEND', []));
}
/** parts = [{n, color '#RRGGBB'}] -> PNG base64 du camembert (nombre de chauffeurs écrit sur chaque part) */
function pngPie_(parts, size) {
  size = size || 280;
  const nz = parts.filter(p => p.n > 0), tot = nz.reduce((s, p) => s + p.n, 0);
  const hex = c => [1, 3, 5].map(i => parseInt(c.substr(i, 2), 16));
  const cols = nz.map(p => hex(p.color)), ends = []; let acc = 0;
  nz.forEach(p => { acc += p.n / tot * 2 * Math.PI; ends.push(acc); });
  const cx = size / 2, cy = size / 2, R = size / 2 - 3, SS = 3, rgb = new Uint8Array(size * size * 3).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) {
      const dx = x + (i + 0.5) / SS - cx, dy = y + (j + 0.5) / SS - cy;
      if (dx * dx + dy * dy > R * R) { r += 255; g += 255; b += 255; continue; }
      let ang = Math.atan2(dx, -dy); if (ang < 0) ang += 2 * Math.PI;
      let k = 0; while (k < ends.length - 1 && ang >= ends[k]) k++;
      // fine séparation blanche entre les parts
      const st = k ? ends[k - 1] : 0, dist = Math.sqrt(dx * dx + dy * dy);
      if (nz.length > 1 && (Math.abs(ang - st) * dist < 1.2 || Math.abs(ends[k] - ang) * dist < 1.2)) { r += 255; g += 255; b += 255; continue; }
      r += cols[k][0]; g += cols[k][1]; b += cols[k][2];
    }
    const o = (y * size + x) * 3; rgb[o] = r / (SS * SS); rgb[o + 1] = g / (SS * SS); rgb[o + 2] = b / (SS * SS);
  }
  // Nombres sur les parts (police 5x7 agrandie)
  const sc = Math.max(3, Math.round(size / 70));
  nz.forEach((p, k) => {
    const st = k ? ends[k - 1] : 0, mid = (st + ends[k]) / 2, txt = String(p.n);
    const lx = cx + 0.6 * R * Math.sin(mid), ly = cy - 0.6 * R * Math.cos(mid);
    const w = txt.length * 6 * sc - sc, h = 7 * sc, x0 = Math.round(lx - w / 2), y0 = Math.round(ly - h / 2);
    const c = cols[k], dark = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 < 140, ink = dark ? 255 : 34;
    txt.split('').forEach((d, di) => PNG_DIGITS[d].forEach((row, ry) => row.split('').forEach((bit, rx) => {
      if (bit !== '1') return;
      for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc + Math.ceil(sc / 2); xx++) {
        const X = x0 + di * 6 * sc + rx * sc + xx, Y = y0 + ry * sc + yy;
        if (X >= 0 && Y >= 0 && X < size && Y < size) { const o = (Y * size + X) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = ink; }
      }
    })));
  });
  return Utilities.base64Encode(signed_(pngEncode_(size, size, rgb)));
}

function wkPie_(parts) {
  const nz = parts.filter(p => p.n > 0), tot = nz.reduce((s, p) => s + p.n, 0);
  const legend = '<table class="lg" style="width:100%">' + nz.map(p => '<tr><td style="background:' + p.color + ';width:8%">&nbsp;</td><td style="width:52%">' + esc_(p.label) +
    '</td><td class="vl" style="width:40%">' + p.n + ' (' + Math.round(p.n / tot * 100) + ' %)</td></tr>').join('') + '</table>';
  if (!tot) return '<p class="nd">Aucun chauffeur classé cette semaine.</p>';
  let img = '';
  try { img = '<img src="data:image/png;base64,' + pngPie_(nz, 280) + '" width="210" height="210">'; } catch (e) { img = ''; }
  if (!img) {   // repli : barre de répartition 100 %
    img = '<table class="b" style="height:26px"><tr>' + nz.map(p => '<td style="width:' + Math.max(1, Math.round(p.n / tot * 100)) + '%;background:' + p.color +
      ';text-align:center;font-weight:bold">' + p.n + '</td>').join('') + '</tr></table>';
  }
  return '<table class="pie"><tr><td style="width:55%">' + img + '</td><td>' + legend + '</td></tr></table>';
}

function weeklyReportHtml_(monday) {
  const ctx = viewCtx_(addDays_(monday, -1)), P = ctx.P, IJ = ctx.IJ, sunday = addDays_(monday, 6);
  const p = { from: monday, to: sunday };
  const all = drivingStats_(ctx, p);
  // Tous les chauffeurs qui ont eu un contrat dans la semaine (8 véhicules x 2 shifts par jour), même sans données
  const C = readTable_(S.CTR), IC = idx_(H.CTR), roster = {}, wStart = dayBounds_(monday).start.getTime(), wEnd = dayBounds_(sunday).end.getTime();
  let nCtr = 0;
  C.rows.forEach(r => {
    const a = toDate_(r[IC['Début']]); if (!a || a.getTime() < wStart || a.getTime() >= wEnd) return;
    const z = toDate_(r[IC['Fin']]), zt = z ? z.getTime() : Math.min(Date.now(), a.getTime() + 16 * HOUR), key = String(r[IC['Clé plaque']]);
    const code = String(r[IC['Code client']]), o = roster[code] || (roster[code] = { code, nom: String(r[IC['Nom']]), ctrs: [] });
    o.ctrs.push({ num: String(r[IC['N° contrat']]), key, plate: plateOf_(ctx.veh, key, String(r[IC['Plaque']])), a: a.getTime(), z: zt }); nCtr++;
  });
  const byCode = {}; all.forEach(o => { byCode[o.d.code] = o; o.nShifts = roster[o.d.code] ? roster[o.d.code].ctrs.length : Object.keys(o.d.a.ctr).length; });
  const missing = Object.values(roster).filter(x => !byCode[x.code]);
  if (missing.length) {
    const synced = coverage_();
    const T0 = readData_(S.TRIP, addDays_(monday, -1)), I0 = idx_(H.TRIP), vTrips = {};
    T0.rows.forEach(r => { const t = tms_(r[I0['Début']]); if (t < wStart || t >= wEnd + DAY) return;
      (vTrips[String(r[I0['Clé plaque']])] = vTrips[String(r[I0['Clé plaque']])] || []).push({ t, code: String(r[I0['Code chauffeur']] || HORS), nom: String(r[I0['Chauffeur']] || ''), num: String(r[I0['Contrat']] || '') }); });
    missing.forEach(x => { x.why = zeroWhy_(x, ctx.veh, synced, vTrips); x.nom = ctx.drvName[x.code] || x.nom; });
  }
  if (!all.length && !missing.length) throw new Error('Aucun contrat ni trajet sur la semaine du ' + fmtDay_(monday) + ' au ' + fmtDay_(sunday) + '.');
  const ranked = all.filter(o => o.d.a.km >= P.kmMin).sort((x, y) => x.d.score - y.d.score || x.d.a.pts - y.d.a.pts);   // du plus sûr au plus dangereux
  const small = all.filter(o => o.d.a.km < P.kmMin);
  const nEv = o => DRIVE_CATS.reduce((t, c) => t + o.cat[c], 0);
  const sum = f => all.reduce((t, o) => t + f(o), 0);
  const kmT = sum(o => o.d.a.km), drvT = sum(o => o.d.a.drive), fuelT = sum(o => o.d.a.fuelN ? o.d.a.fuel : 0), idleLT = sum(o => o.d.a.idleFuelN ? o.d.a.idleFuel : 0);
  const idleHT = sum(o => o.d.a.idle), speedT = sum(o => o.cat['Vitesse']), brakeT = sum(o => o.cat['Freinage']);
  const vTop = all.slice().sort((a, b) => b.vmax - a.vmax)[0];
  const plates = {}; all.forEach(o => Object.keys(o.d.a.plates).forEach(k => { plates[k] = 1; }));
  // Consommation par modèle de véhicule (comparer un chauffeur de Staria diesel à un chauffeur de Sonata hybride n'aurait pas de sens)
  const modelOf = x => String(x.r[IJ['Modèle']] || (ctx.veh[x.key] && ctx.veh[x.key].model) || 'Autre').toUpperCase();
  const byCM = aggJrn_(ctx.jrn.filter(x => inP_(x.day, p) && x.code !== HORS), IJ, x => x.code + '|' + modelOf(x), P);
  const models = {};
  Object.values(byCM).forEach(a => { const [code, model] = a.k.split('|'); if (a.l100 !== null) (models[model] = models[model] || []).push({ code, a }); });

  const css = '<style>body{font-family:Arial,sans-serif;font-size:9pt;color:#222;margin:0}' +
    'h1{font-size:19pt;color:#1F3864;margin:0 0 2px 0}h2{font-size:12pt;color:#fff;background:#1F3864;padding:5px 8px;margin:16px 0 6px 0}' +
    '.sub0{color:#555;font-size:10pt;margin:0 0 8px 0}.msg{background:#FFF2CC;border-left:5px solid #C00000;padding:7px 9px;font-size:9.5pt;margin:8px 0}' +
    'table{border-collapse:collapse}.kp{width:100%;margin:6px 0}.kp td{background:#F2F2F2;padding:6px;border:3px solid #fff;width:16.6%;vertical-align:top;font-size:8pt;color:#555}' +
    '.kp b{display:block;font-size:14pt;color:#1F3864}.bars{width:100%}.bars td{padding:1px 3px;font-size:8pt;vertical-align:middle}' +
    '.bars td.rk{width:18px;color:#888;text-align:right}.bars td.lb{width:34%}.bars td.br{width:48%}.bars td.vl{width:14%;text-align:right;font-weight:bold;white-space:nowrap}' +
    '.b{width:100%;height:14px}.b td{padding:0;height:14px;font-size:8pt}.sub{color:#777;font-size:7.5pt}.nd{color:#888;font-style:italic}' +
    '.pie{width:100%}.pie td{vertical-align:middle}.lg td{padding:4px 6px;font-size:10pt}.lg td.vl{font-weight:bold}' +
    '.pod{width:100%}.pod td{width:50%;padding:8px;vertical-align:top;font-size:9pt}.pod b{font-size:13pt;display:block}' +
    '.rec{width:100%}.rec th{background:#D9E1F2;font-size:7.5pt;padding:3px;border:1px solid #B4C6E7;text-align:left}.rec td{font-size:7.5pt;padding:3px;border:1px solid #D9D9D9}' +
    '.rec td.n{text-align:right}.small{color:#666;font-size:7.5pt}.keep{page-break-inside:avoid}</style>';
  let h = '<html><head><meta charset="utf-8">' + css + '</head><body>';
  h += '<h1>Bilan conduite de la semaine</h1>';
  const nDays = Math.max(1, Math.min(7, Math.round((Math.min(Date.now(), wEnd) - wStart) / DAY)));
  h += '<p class="sub0">Du lundi ' + fmtDay_(monday) + ' au dimanche ' + fmtDay_(sunday) + ' · ' + Object.keys(plates).length + ' véhicules · ' +
    nCtr + ' shifts sous contrat (' + r1_(nCtr / nDays) + ' par jour) · ' + (all.length + missing.length) + ' chauffeurs · édité le ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy à HH:mm') + '</p>';
  h += msgBox_('<b>Tous nos véhicules sont suivis en temps réel par boîtier Geotab.</b> Chaque trajet, chaque excès de vitesse, chaque freinage ou accélération brusque, ' +
    'chaque minute moteur allumé à l\'arrêt et chaque litre consommé sont enregistrés automatiquement et rattachés au chauffeur sous contrat. Ce bilan est établi uniquement à partir de ces mesures.', '#FFF2CC', '#C00000');
  const kp = (l, v) => '<td>' + esc_(l) + '<br><b style="font-size:14pt;color:#1F3864">' + esc_(v) + '</b></td>';
  h += '<table class="kp"><tr>' + kp('Km parcourus', String(Math.round(kmT)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')) + kp('Heures de conduite', fmtH_(drvT)) +
    kp('Carburant consommé', Math.round(fuelT) + ' L') + kp('Brûlé moteur à l\'arrêt', r1_(idleLT) + ' L (' + fmtH_(idleHT) + ')') +
    kp('Excès de vitesse', speedT) + kp('Vitesse max de la semaine', vTop && vTop.vmax ? vTop.vmax + ' km/h' : '-') + '</tr></table>';

  // 1. Répartition + podium
  h += '<div class="keep"><h2>1. Comment nos chauffeurs ont conduit cette semaine</h2>';
  h += wkPie_(LEVELS.map(l => ({ label: WK_LABEL[l.name], color: WK_COLORS[l.name], n: ranked.filter(o => o.d.level === l.name).length })));
  if (ranked.length) {
    const best = ranked[0], worst = ranked[ranked.length - 1];
    h += '<table class="pod"><tr><td style="background:#E2F0D9;border:1px solid #E2F0D9"><span class="sub">Le plus sûr de la semaine</span><br><b style="font-size:13pt">' + esc_(best.d.nom) + '</b><br>' +
      r1_(best.d.score) + ' points pour 100 km · ' + Math.round(best.d.a.km) + ' km · ' + nEv(best) + ' événement' + (nEv(best) > 1 ? 's' : '') + '</td>' +
      (worst !== best ? '<td style="background:#FBE5D6;border:1px solid #FBE5D6"><span class="sub">Le plus à risque de la semaine</span><br><b style="font-size:13pt">' + esc_(worst.d.nom) + '</b><br>' +
        r1_(worst.d.score) + ' points pour 100 km · ' + worst.cat['Vitesse'] + ' excès de vitesse · Vmax ' + worst.vmax + ' km/h</td>' : '<td></td>') + '</tr></table>';
  }
  h += '</div>';

  // 2. Classement conduite
  h += '<div class="keep"><h2>2. Classement conduite : du plus sûr au plus dangereux</h2>';
  const pl = (n, s, pp) => n + ' ' + (n > 1 ? pp : s);
  h += wkBars_(ranked.map(o => ({ label: o.d.nom, sub: WK_LABEL[o.d.level] + ' · ' + pl(o.nShifts, 'shift', 'shifts') + ' · ' + Math.round(o.d.a.km) + ' km · ' + o.cat['Vitesse'] + ' excès vit. · ' +
    o.cat['Freinage'] + ' frein. · ' + o.cat['Accélération'] + ' accél.', value: Math.max(o.d.score, 0.5), color: WK_COLORS[o.d.level], text: r1_(o.d.score) + ' pts' })),
    { empty: 'Aucun chauffeur n\'a roulé au moins ' + P.kmMin + ' km cette semaine.' });
  h += '<p class="small">Points de danger pour 100 km : chaque événement détecté par le boîtier compte (collision 10, excès de vitesse 3, ceinture 3, freinage brusque 2, accélération brusque 2, virage brusque 1,5). Moins il y a de points, plus la conduite est sûre.</p></div>';

  // 3. Consommation par modèle
  h += '<div class="keep"><h2>3. Consommation de carburant (litres pour 100 km)</h2>';
  const mk = Object.keys(models).sort();
  if (!mk.length) h += '<p class="nd">Pas assez de km mesurés cette semaine.</p>';
  mk.forEach(model => {
    const L = models[model].sort((a, b) => a.a.l100 - b.a.l100), n = L.length;
    const avg = L.reduce((t, x) => t + x.a.fuel, 0) / L.reduce((t, x) => t + x.a.fuelKm, 0) * 100;
    h += '<p style="margin:8px 0 2px 0"><b>' + esc_(model) + '</b> <span class="sub">(moyenne flotte ' + r1_(avg) + ' L/100 km, chauffeurs comparés sur le même modèle)</span></p>';
    h += wkBars_(L.map((x, i) => ({ label: ctx.drvName[x.code] || x.code, sub: Math.round(x.a.fuelKm) + ' km · ' + r1_(x.a.fuel) + ' L',
      value: x.a.l100, color: wkGrad_(n > 1 ? i / (n - 1) : 0), text: r1_(x.a.l100) + ' L' })));
  });
  h += '</div>';

  // 4. Ralenti
  const idl = all.filter(o => o.d.a.idleFuelN || o.d.a.idle > 0).sort((a, b) => (a.d.a.idleFuel - b.d.a.idleFuel) || (a.d.a.idle - b.d.a.idle));
  h += '<div class="keep"><h2>4. Carburant brûlé moteur allumé à l\'arrêt (ralenti)</h2>';
  h += wkBars_(idl.map((o, i) => ({ label: o.d.nom, sub: fmtH_(o.d.a.idle) + ' moteur allumé à l\'arrêt' + (o.d.a.nLong ? ' · ' + o.d.a.nLong + ' arrêts de ' + P.idleLongMin + ' min et plus' : ''),
    value: o.d.a.idleFuelN ? Math.max(o.d.a.idleFuel, 0.05) : 0.05, color: wkGrad_(idl.length > 1 ? i / (idl.length - 1) : 0),
    text: o.d.a.idleFuelN ? r1_(o.d.a.idleFuel) + ' L' : 'non mesuré' })));
  h += '<p class="small">Un moteur qui tourne à l\'arrêt consomme du carburant pour rien. Coupez le moteur dès que l\'arrêt dure.</p></div>';

  // 5. Vitesse max
  const vm = all.filter(o => o.vmax > 0).sort((a, b) => a.vmax - b.vmax);
  const vmMax = Math.max.apply(null, vm.map(o => o.vmax).concat([P.vmaxAlert]));
  h += '<div class="keep"><h2>5. Vitesse maximale atteinte</h2>';
  h += wkBars_(vm.map(o => {
    const w = o.worst, bad = o.vmax >= P.vmaxAlert || (w && w.ex >= P.overAlert), mid = !bad && w && w.ex >= 10;
    return { label: o.d.nom, sub: w && w.ex > 0 ? 'pire dépassement : ' + w.v + ' km/h pour une limite de ' + w.lim + ' (+' + w.ex + ')' + (w.day ? ', le ' + fmtDay_(w.day).slice(0, 5) + ' à ' + w.hm : '') : 'limite de vitesse respectée',
      value: o.vmax, color: bad ? '#C00000' : mid ? '#F4B183' : '#63BE7B', text: o.vmax + ' km/h' };
  }), { max: vmMax });
  h += '<p class="small">Vitesse lue sur le capteur du véhicule ; limite de la route fournie par Geotab. Rouge : ' + P.vmaxAlert + ' km/h et plus, ou limite dépassée de ' + P.overAlert + ' km/h et plus.</p></div>';

  // 6. Tableau récapitulatif
  const recHead = ['Rang', 'Chauffeur', 'Shifts', 'Conduite', 'Points /100 km', 'Km', 'L/100 km', 'Ralenti', 'Litres ralenti', 'Vmax', 'Excès vitesse', 'Freinages', 'Accélérations', 'Virages'];
  const recW = [5, 20, 6, 10, 7, 6, 6, 6, 6, 6, 6, 6, 6, 4];
  const rows = ranked.map((o, i) => [i + 1, o.d.nom, o.nShifts, WK_LABEL[o.d.level], r1_(o.d.score), Math.round(o.d.a.km), o.d.a.l100 !== null ? r1_(o.d.a.l100) : '-', fmtH_(o.d.a.idle),
    o.d.a.idleFuelN ? r1_(o.d.a.idleFuel) : '-', o.vmax || '-', o.cat['Vitesse'], o.cat['Freinage'], o.cat['Accélération'], o.cat['Virage']])
    .concat(small.map(o => ['-', o.d.nom, o.nShifts, 'Non classé (< ' + P.kmMin + ' km)', '-', Math.round(o.d.a.km), '-', fmtH_(o.d.a.idle),
      o.d.a.idleFuelN ? r1_(o.d.a.idleFuel) : '-', o.vmax || '-', o.cat['Vitesse'], o.cat['Freinage'], o.cat['Accélération'], o.cat['Virage']]))
    .concat(missing.map(x => ['-', x.nom, x.ctrs.length, 'Pas de données', '-', 0, '-', '-', '-', '-', '-', '-', '-', '-']));
  h += '<div class="keep"><table class="rec" style="margin-top:12px">' + titleRow_('6. Récapitulatif', recHead.length) + '<tr>' + recHead.map((x, i) => '<th style="width:' + recW[i] + '%">' + esc_(x) + '</th>').join('') + '</tr>' +
    rows.map(r => '<tr>' + r.map((c, j) => '<td' + (j === 2 && WK_COLORS[Object.keys(WK_LABEL).find(k => WK_LABEL[k] === c)] ?
      ' style="background:' + WK_COLORS[Object.keys(WK_LABEL).find(k => WK_LABEL[k] === c)] + (c === WK_LABEL['Dangereux'] ? ';color:#fff;font-weight:bold' : '') + '"' : (typeof c === 'number' ? ' class="n"' : '')) + '>' + esc_(c) + '</td>').join('') + '</tr>').join('') + '</table></div>';
  if (missing.length) h += '<p class="small"><b>Chauffeurs sous contrat sans données cette semaine :</b><br>' + missing.map(x => esc_(x.nom + ' (' + x.ctrs.length + ' shift' + (x.ctrs.length > 1 ? 's' : '') + ') : ' +
    fill_(WHY[x.why[0]][0], x.why[1]))).join('<br>') + '</p>';
  h += '<p class="small">Source : boîtiers Geotab (base ' + esc_(P.geoDb) + '). Journées de travail = horaires des contrats de location ; un trajet est attribué au chauffeur dont le contrat couvre l\'heure de départ. ' +
    'Consommation : compteur carburant du véhicule (L/100 km calculé sur au moins ' + P.minFuelKm + ' km). Aucune valeur n\'est estimée : ce qui n\'est pas mesuré est indiqué « non mesuré ».</p>';
  return h + '</body></html>';
}

// ============================================================================
// 15. BILAN DE FIN DE SHIFT (équipe de jour / équipe de nuit), français ou français + darija
// ============================================================================
/** Textes : [français, darija]. La darija est écrite en arabe. */
const TXT = {
  title: ['Bilan de fin de shift', 'الحصيلة ديال آخر الشيفت'],
  day: ['Équipe de jour', 'الفرقة ديال النهار'],
  night: ['Équipe de nuit', 'الفرقة ديال الليل'],
  msg: ['Tous nos véhicules sont suivis en temps réel par boîtier Geotab. Chaque trajet, chaque excès de vitesse, chaque freinage ou accélération brusque, chaque minute moteur allumé à l\'arrêt et chaque litre consommé sont enregistrés automatiquement et rattachés au chauffeur sous contrat.',
    'جميع الطوموبيلات ديالنا متبوعة فالوقت الحقيقي بجهاز Geotab. كل طريق، كل سرعة زايدة، كل فرانة ولا أكسيليراسيون قوية، كل دقيقة والموطور خدام والطوموبيل واقفة، وكل لتر ديال المازوط، كيتسجلو أوطوماتيكيا وكيتحسبو على السائق اللي عندو الكونطرا.'],
  advice: ['Respectez les limitations de vitesse, évitez les freinages et accélérations brusques, coupez le moteur dès que vous êtes à l\'arrêt.',
    'احترم السرعة المحددة، تجنب الفرانات والأكسيليراسيون القوية، وطفي الموطور ملي تكون واقف.'],
  kDrivers: ['Chauffeurs', 'السائقين'], kKm: ['Km parcourus', 'الكيلومترات'], kFuel: ['Carburant consommé', 'المازوط المستهلك'],
  kIdle: ['Moteur allumé à l\'arrêt', 'الموطور خدام وهو واقف'], kSpeed: ['Excès de vitesse', 'السرعة الزايدة'], kVmax: ['Vitesse max du shift', 'أقصى سرعة فالشيفت'],
  alerts: ['Alertes du shift', 'التنبيهات ديال هاد الشيفت'],
  noAlert: ['Aucune alerte pendant ce shift. Bravo à toute l\'équipe !', 'ماكاين حتى تنبيه فهاد الشيفت. برافو على الفرقة كاملة!'],
  rank: ['Classement du shift : du plus sûr au plus dangereux', 'الترتيب ديال الشيفت: من أحسن سائق حتى للأخطر'],
  best: ['Le plus sûr du shift', 'أحسن سائق فالشيفت'], worst: ['Le plus à risque du shift', 'أخطر سياقة فالشيفت'],
  detail: ['Détail par chauffeur', 'التفاصيل ديال كل سائق'],
  hDriver: ['Chauffeur', 'السائق'], hVeh: ['Véhicule', 'الطوموبيل'], hKm: ['Km', 'كلم'], hDrive: ['Conduite', 'وقت السياقة'], hLevel: ['Conduite', 'السياقة'],
  hPts: ['Points /100 km', 'النقط /100 كلم'], hSpeed: ['Excès de vitesse', 'سرعة زايدة'], hBrake: ['Freinages brusques', 'فرانات قوية'],
  hAcc: ['Accélérations brusques', 'أكسيليراسيون قوية'], hVmax: ['Vitesse max', 'أقصى سرعة'], hIdle: ['Moteur allumé à l\'arrêt', 'الموطور خدام وهو واقف'],
  hL100: ['L/100 km', 'لتر/100 كلم'],
  Faible: ['Conduite sûre', 'سياقة مزيانة'], 'Modéré': ['À surveiller', 'خاص الانتباه'], 'Élevé': ['Risquée', 'فيها الخطر'], Dangereux: ['Dangereuse', 'خطيرة'],
  notRanked: ['Non classé (moins de {km} km)', 'ماتصنفش (أقل من {km} كلم)'],
  noTrip: ['Aucun trajet', 'ماكاين حتى طريق'],
  ptsNote: ['Points de danger pour 100 km : collision 10, excès de vitesse 3, ceinture 3, freinage brusque 2, accélération brusque 2, virage brusque 1,5. Moins il y a de points, plus la conduite est sûre.',
    'النقط ديال الخطر على كل 100 كلم: حادثة 10، سرعة زايدة 3، السمطة 3، فرانة قوية 2، أكسيليراسيون قوية 2، دورة قوية 1,5. كلما قلّو النقط كلما كانت السياقة مزيانة.'],
  source: ['Source : boîtiers Geotab, données mesurées, aucune estimation. Un trajet est attribué au chauffeur dont le contrat couvre l\'heure de départ.',
    'المصدر: أجهزة Geotab، معطيات مقاسة بلا تقدير. كل طريق كيتحسب على السائق اللي الكونطرا ديالو كتغطي ساعة الانطلاق.'],
  pending: ['Shift en cours : bilan provisoire', 'الشيفت مازال خدام: حصيلة مؤقتة']
};
/** Alertes : textes à trous {v} {lim} {h} {p} {n} {m} */
const ATXT = {
  speed: ['{n} : {v} km/h pour une limite de {lim} km/h (+{ex}), à {h}, véhicule {p}', '{n}: {v} كلم/س فبلاصة {lim} كلم/س (+{ex})، مع {h}، الطوموبيل {p}'],
  vmax: ['{n} : vitesse de {v} km/h à {h}, véhicule {p}', '{n}: سرعة {v} كلم/س مع {h}، الطوموبيل {p}'],
  collision: ['{n} : collision détectée par le boîtier à {h}, véhicule {p}', '{n}: الجهاز سجل صدمة مع {h}، الطوموبيل {p}'],
  belt: ['{n} : {c} alerte(s) ceinture non bouclée', '{n}: {c} تنبيه ديال السمطة ماكانتش مسدودة'],
  idle: ['{n} : moteur allumé à l\'arrêt pendant {m} min à partir de {h}, véhicule {p}', '{n}: الموطور بقى خدام والطوموبيل واقفة {m} دقيقة من {h}، الطوموبيل {p}'],
  harsh: ['{n} : {c} freinages/accélérations brusques', '{n}: {c} ديال الفرانات/الأكسيليراسيون القوية'],
  hors: ['Véhicule {p} : {km} km roulés sans contrat (de {h})', 'الطوموبيل {p}: {km} كلم بلا كونطرا (من {h})'],
  danger: ['{n} : conduite dangereuse ({s} points pour 100 km)', '{n}: سياقة خطيرة ({s} نقطة على 100 كلم)'],
  conflict: ['Contrats en conflit sur {p} : {n} a un contrat ({c}) mais les {k} trajets du véhicule sur ce créneau sont comptés pour {o}. Vérifiez les heures de départ et de retour des contrats.',
    'تداخل فالكونطرات ديال {p}: {n} عندو كونطرا ({c}) ولكن {k} طرقان ديال الطوموبيل فهاد الوقت تحسبو على {o}. شوف ساعات الخروج والرجوع فالكونطرات.']
};
/** Pourquoi un chauffeur de l'équipe est à 0 */
const WHY = {
  noGeo: ['Véhicule {p} non relié à Geotab', 'الطوموبيل {p} ماشي مربوطة بـ Geotab'],
  notSynced: ['Données Geotab de {p} du {d} pas encore téléchargées', 'المعطيات ديال {p} ديال {d} مازال ماتحملوش'],
  other: ['Trajets de {p} comptés pour {n}', 'الطرقان ديال {p} تحسبو على {n}'],
  noMove: ['{p} n\'a pas roulé pendant son contrat', '{p} ماتحركاتش فوقت الكونطرا ديالو']
};

/** Bornes d'un shift. key = 'J|aaaa-mm-jj' (jour) ou 'N|aaaa-mm-jj' (nuit qui commence ce soir-là) */
function shiftBounds_(key, P) {
  P = P || params_();
  const [t, d] = String(key).split('|'), hD = num_(P.shiftDay, 7), hN = num_(P.shiftNight, 19), p = d.split('-').map(Number);
  if (t === 'J') return { key, type: 'J', day: d, start: localToDate_(p[0], p[1], p[2], hD, 0).getTime(), end: localToDate_(p[0], p[1], p[2], hN, 0).getTime() };
  const n = addDays_(d, 1).split('-').map(Number);
  return { key, type: 'N', day: d, start: localToDate_(p[0], p[1], p[2], hN, 0).getTime(), end: localToDate_(n[0], n[1], n[2], hD, 0).getTime() };
}
/** Shifts récents (le plus récent d'abord), le shift en cours compris */
function recentShifts_(n, P) {
  P = P || params_();
  const now = Date.now(), out = [];
  let d = localDay_(new Date(now + DAY)), t = 'N';
  while (out.length < n) {
    const b = shiftBounds_(t + '|' + d, P);
    if (b.start <= now) out.push(Object.assign(b, { running: b.end > now }));
    if (t === 'N') t = 'J'; else { t = 'N'; d = addDays_(d, -1); }
  }
  return out;
}
function shiftLabel_(b) {
  const f = t => Utilities.formatDate(new Date(t), TZ, 'dd/MM HH\'h\'mm');
  return (b.type === 'J' ? 'Jour' : 'Nuit') + ' : ' + f(b.start) + ' → ' + f(b.end);
}

function openShiftDialog() {
  const sh = recentShifts_(8);
  const firstDone = sh.findIndex(b => !b.running);
  const opts = sh.map((b, i) => '<option value="' + b.key + '"' + (i === firstDone ? ' selected' : '') + '>' + shiftLabel_(b) + (b.running ? ' (en cours)' : '') + '</option>').join('');
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;font-size:13px">' +
    '<p>Shift<br><select id="w" style="width:100%;padding:4px">' + opts + '</select></p>' +
    '<p>Langue<br><label><input type="radio" name="l" value="fr" checked> Français</label>&nbsp;&nbsp;' +
    '<label><input type="radio" name="l" value="ar"> Français + Darija</label></p>' +
    '<p><label><input type="checkbox" id="sy" checked> Mettre à jour les données Geotab avant (1 à 3 min)</label></p>' +
    '<button id="b" onclick="go()" style="background:#1F3864;color:#fff;border:0;padding:8px 16px;border-radius:6px">Générer le PDF</button>' +
    '<p id="s"></p></div>' +
    '<script>function go(){var b=document.getElementById("b");b.disabled=true;document.getElementById("s").innerText="Génération en cours...";' +
    'var l=document.querySelector("input[name=l]:checked").value;' +
    'google.script.run.withSuccessHandler(function(r){b.disabled=false;document.getElementById("s").innerHTML=r.busy?r.busy:("PDF prêt : <a target=\\"_blank\\" href=\\""+r.url+"\\">ouvrir</a>"+(r.dl?" · <a target=\\"_blank\\" href=\\""+r.dl+"\\">télécharger</a>":"")+"<br><small>"+r.name+"<br>Drive, dossier "+r.folder+"</small>");})' +
    '.withFailureHandler(function(e){b.disabled=false;document.getElementById("s").innerText="Erreur : "+e.message;})' +
    '.generateShiftReport(document.getElementById("w").value,l,document.getElementById("sy").checked);}</script>'
  ).setWidth(480).setHeight(330);
  SpreadsheetApp.getUi().showModalDialog(html, 'Bilan de fin de shift');
}

/** Met à jour depuis Geotab les journées couvrant le shift (tous les véhicules), puis rattache aux contrats */
function syncShiftNow_(b) {
  const days = [];
  for (let d = localDay_(new Date(b.start)); d <= localDay_(new Date(Math.min(b.end, Date.now()) - 1)); d = addDays_(d, 1)) days.push(d);
  return ensureData_(days, 40);
}
/**
 * Données à jour pour des journées : journées terminées depuis 12 h -> finalisées tout de suite (au plus maxVd véhicule-jours,
 * sinon mises en file) ; journées récentes -> collecte temps réel immédiate. Retourne un message.
 */
function ensureData_(days, maxVd) {
  const P = params_(), veh = vehicles_(), list = Object.values(veh).filter(v => v.active && v.geoId), fin = doneVehDays_(), now = Date.now();
  const old = [], recent = [];
  days.forEach(d => { if (dayBounds_(d).end.getTime() + 12 * HOUR <= now) list.forEach(v => { if (!fin[v.key + '|' + d]) old.push({ d, k: v.key }); }); else recent.push(d); });
  let msg = '';
  if (old.length && old.length <= maxVd) {
    const acc = newAcc_();
    let q = old.slice();
    for (let g = 0; q.length && g < 40; g++) {
      const tb = takeBatch_(q, veh); if (!tb.blocks.length) break;
      const r = syncBlocks_(tb.blocks, P, acc); q = r.retry.concat(tb.rest).concat(r.later);
      if (r.limited) Utilities.sleep(20000);
    }
    flush_(acc);
    if (acc.days.length) { markDirty_(acc.days.map(id => id.split('|')[1]).sort()[0]); msg += acc.days.length + ' véhicule-jours finalisés. '; }
  } else if (old.length) {
    queueSync_(old.map(x => x.d).filter((d, i, a) => a.indexOf(d) === i), false);
    msg += old.length + ' véhicule-jours anciens mis en file (suivi dans LOG). ';
  }
  if (recent.length) {
    const live = liveCatchUp_(MAX_RUN_MS - 180000);
    if (live.wrote) markDirty_(recent[0]);
    msg += live.n + ' trajets récents ajoutés. ';
  }
  return msg;
}

/** Génère le bilan du shift. lang = 'fr' ou 'ar' (français + darija). Retourne {url, dl, name, folder} ou {busy}. */
function generateShiftReport(key, lang, doSync) {
  const t0 = Date.now(), P = params_(), b = shiftBounds_(key, P);
  lang = lang === 'ar' ? 'ar' : 'fr';
  let html = null;
  const res = withLock_('Bilan de fin de shift', () => {
    if (doSync && b.start <= Date.now()) syncShiftNow_(b);
    html = shiftReportHtml_(b, lang);
    return true;
  }, true);
  if (!res) return { busy: 'Une synchro Geotab est en cours : réessayez dans quelques minutes (ou décochez « Mettre à jour les données »).' };
  const f = t => Utilities.formatDate(new Date(t), TZ, 'yyyy-MM-dd HH\'h\'');
  const name = 'Bilan shift ' + (b.type === 'J' ? 'jour' : 'nuit') + ' ' + f(b.start) + ' - ' + Utilities.formatDate(new Date(b.end), TZ, 'HH\'h\'') + (lang === 'ar' ? ' FR-Darija' : '');
  const pdf = htmlToPdf_(html, name);
  const folderName = 'Bilans de shift';
  const it = DriveApp.getFoldersByName(folderName);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
  const file = folder.createFile(pdf);
  let dl = ''; try { dl = file.getDownloadUrl ? file.getDownloadUrl() : ''; } catch (e) { }
  log_('Bilan de shift', shiftLabel_(b) + (lang === 'ar' ? ' (FR + darija)' : ''), t0);
  return { url: file.getUrl(), dl, name: name + '.pdf', folder: folderName };
}

/** Statistiques du shift par chauffeur, directement sur les trajets et événements de la fenêtre du shift */
/** Pourquoi un chauffeur sous contrat n'a aucun trajet : ['noGeo'|'notSynced'|'other'|'noMove', {…}] */
function zeroWhy_(o, veh, synced, vTrips) {
  for (const c of o.ctrs || []) {
    const v = veh[c.key];
    if (!v || !v.geoId) return ['noGeo', { p: c.plate }];
    for (let d = localDay_(new Date(c.a)); d <= localDay_(new Date(c.z - 1)); d = addDays_(d, 1))
      if (!synced[c.key + '|' + d]) return ['notSynced', { p: c.plate, d: fmtDay_(d).slice(0, 5) }];
    const others = (vTrips[c.key] || []).filter(x => x.t >= c.a && x.t <= c.z && x.code !== o.code);
    if (others.length) {
      const who = {}; others.forEach(x => { const k = x.code === HORS ? 'Hors contrat' : x.nom + (x.num ? ' (' + x.num + ')' : ''); who[k] = (who[k] || 0) + 1; });
      return ['other', { p: c.plate, n: Object.keys(who).join(', '), k: others.length, num: c.num }];
    }
  }
  return ['noMove', { p: (o.ctrs || []).map(c => c.plate).filter((x, i, a) => a.indexOf(x) === i).join(', ') }];
}
function fill_(s, v) { return String(s).replace(/\{(\w+)\}/g, (m, k) => v[k] !== undefined ? v[k] : m); }
function plateOf_(veh, key, fallback) { return veh[key] ? veh[key].plate : (fallback || key); }
function shiftStats_(b) {
  const P = params_(), rules = rulesMap_(), drvName = { [HORS]: 'Hors contrat' };
  const ID = idx_(H.DRV); readTable_(S.DRV).rows.forEach(r => { drvName[String(r[ID['Code']])] = String(r[ID['Nom']]); });
  const inW = t => t && t.getTime() >= b.start && t.getTime() < b.end;
  const by = {}, get = code => by[code] || (by[code] = { code, nom: drvName[code] || code, km: 0, drive: 0, idleMin: 0, idleL: 0, idleLN: 0, fuel: 0, fuelKm: 0,
    pts: 0, cat: { Vitesse: 0, Freinage: 0, 'Accélération': 0, Virage: 0, Ceinture: 0, Collision: 0 }, vmax: 0, vmaxAt: null, worst: null, plates: {}, trips: 0, firstHors: null });
  // Équipe du shift : chauffeurs dont le contrat se passe en majorité dans ce shift (un chauffeur de nuit rendu à 10h n'est pas de l'équipe de jour)
  const veh = vehicles_(), C = readTable_(S.CTR), IC = idx_(H.CTR);
  C.rows.forEach(r => {
    const a = toDate_(r[IC['Début']]); if (!a) return;
    const z = toDate_(r[IC['Fin']]), zt = z ? z.getTime() : Math.min(Date.now(), a.getTime() + 16 * HOUR);   // contrat sans retour : au plus 16 h
    const dur = zt - a.getTime(); if (dur <= 0) return;
    const ov = Math.min(zt, b.end) - Math.max(a.getTime(), b.start);
    if (ov < 30 * MIN || ov < dur / 2) return;
    const key = String(r[IC['Clé plaque']]), pl = plateOf_(veh, key, String(r[IC['Plaque']]));
    const o = get(String(r[IC['Code client']])); o.plates[pl] = 1; o.team = true;
    (o.ctrs = o.ctrs || []).push({ num: String(r[IC['N° contrat']]), key, plate: pl, a: Math.max(a.getTime(), b.start), z: Math.min(zt, b.end) });
  });
  const dFrom = addDays_(localDay_(new Date(b.start)), -1);
  const T = readData_(S.TRIP, dFrom), IT = idx_(H.TRIP), vTrips = {};
  T.rows.forEach(r => {
    const t = toDate_(r[IT['Début']]); if (!inW(t)) return;
    (vTrips[String(r[IT['Clé plaque']])] = vTrips[String(r[IT['Clé plaque']])] || []).push({ t: t.getTime(), code: String(r[IT['Code chauffeur']] || HORS),
      nom: String(r[IT['Chauffeur']] || ''), num: String(r[IT['Contrat']] || '') });
    const o = get(String(r[IT['Code chauffeur']] || HORS));
    o.trips++; o.km += num_(r[IT['Km']]); o.drive += num_(r[IT['Conduite (min)']]) / 60; o.plates[plateOf_(veh, String(r[IT['Clé plaque']]), String(r[IT['Plaque']]))] = 1;
    o.idleMin += num_(r[IT['Ralenti moteur tournant (min)']]);
    if (r[IT['Carburant ralenti (L)']] !== '') { o.idleL += num_(r[IT['Carburant ralenti (L)']]); o.idleLN++; }
    if (r[IT['Carburant (L)']] !== '') { o.fuel += num_(r[IT['Carburant (L)']]); o.fuelKm += num_(r[IT['Km']]); }
    const vm = num_(r[IT['Vmax (km/h)']]);
    if (vm > o.vmax) { o.vmax = vm; o.vmaxAt = { t, plate: String(r[IT['Plaque']]), lim: r[IT['Limite à Vmax']] }; }
    const ex = r[IT['Pire dépassement (km/h)']];
    if (ex !== '' && isFinite(+ex) && (!o.worst || +ex > o.worst.ex)) o.worst = { ex: +ex, v: r[IT['Vitesse au pire']], lim: r[IT['Limite au pire']], hm: String(r[IT['Heure pire']] || ''), plate: String(r[IT['Plaque']]) };
    if (o.code === HORS && (!o.firstHors || t < o.firstHors)) o.firstHors = t;
  });
  const E = readData_(S.EVT, dFrom), IE = idx_(H.EVT), collisions = [];
  E.rows.forEach(r => {
    const t = toDate_(r[IE['Début']]); if (!inW(t)) return;
    const rl = rules[String(r[IE['Règle ID']])]; if (!rl || rl.w <= 0) return;
    const o = get(String(r[IE['Code chauffeur']] || HORS)), cat = rl.cat || ruleCategory_(rl.name);
    o.pts += rl.w; if (o.cat[cat] !== undefined) o.cat[cat]++;
    if (cat === 'Collision') collisions.push({ o, t, plate: String(r[IE['Plaque']]) });
  });
  const Il = readData_(S.IDL, dFrom), II = idx_(H.IDL), idles = [];
  Il.rows.forEach(r => {
    const t = toDate_(r[II['Début']]); if (!inW(t)) return;
    const m = idleCounted_(r); if (m < P.idleAlertMin) return;
    idles.push({ o: get(String(r[II['Code chauffeur']] || HORS)), t, m: Math.round(m), plate: String(r[II['Plaque']]) });
  });
  const list = Object.values(by);
  list.forEach(o => { o.score = o.pts / Math.max(o.km, P.kmMin) * 100; o.level = levelOf_(o.score, P); o.l100 = o.fuelKm >= P.minFuelKm ? o.fuel / o.fuelKm * 100 : null; });
  // Chauffeur de l'équipe sans aucun trajet : on dit pourquoi (jamais un 0 sans explication)
  const synced = coverage_(), conflicts = [];
  list.filter(o => o.code !== HORS && !o.trips && o.ctrs).forEach(o => {
    o.why = zeroWhy_(o, veh, synced, vTrips);
    if (o.why[0] === 'other') conflicts.push({ o, plate: o.why[1].p, names: o.why[1].n, num: o.why[1].num, k: o.why[1].k });
  });
  return { P, list, collisions, idles, conflicts };
}

function shiftReportHtml_(b, lang) {
  const st = shiftStats_(b), P = st.P, ar = lang === 'ar';
  const drivers = st.list.filter(o => o.code !== HORS), hors = st.list.find(o => o.code === HORS);
  const team = drivers.filter(o => o.team);                       // chauffeurs dont le contrat est dans ce shift
  const extra = drivers.filter(o => !o.team && o.trips);          // ont roulé un peu dans le shift (fin ou début de leur contrat)
  const ranked = team.filter(o => o.km >= P.kmMin).sort((x, y) => x.score - y.score || x.pts - y.pts);
  const others = team.filter(o => o.km < P.kmMin).sort((x, y) => y.km - x.km);
  const hm = t => Utilities.formatDate(new Date(t), TZ, 'HH:mm');
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => v[k] !== undefined ? v[k] : m);
  const T = k => TXT[k][0], A = k => ar ? TXT[k][1] : '';
  // Bloc bilingue : français puis darija (arabe, de droite à gauche)
  const bi = (fr, da, tag) => '<' + (tag || 'div') + '>' + esc_(fr) + (ar && da ? '<div class="ar" dir="rtl">' + esc_(da) + '</div>' : '') + '</' + (tag || 'div') + '>';
  const tx = k => bi(T(k), A(k));
  const css = '<style>body{font-family:Arial,sans-serif;font-size:9.5pt;color:#222;margin:0}' +
    'h1{font-size:18pt;color:#1F3864;margin:0}h2{font-size:12pt;color:#fff;background:#1F3864;padding:5px 8px;margin:14px 0 6px 0}' +
    'h2 .ar{color:#fff;font-size:12pt}.ar{direction:rtl;text-align:right;font-size:10.5pt;color:#333;margin-top:2px}' +
    '.sub0{color:#555;font-size:10pt;margin:2px 0 8px 0}.msg{background:#FFF2CC;border-left:5px solid #C00000;padding:7px 9px;margin:8px 0}' +
    'table{border-collapse:collapse}.kp{width:100%}.kp td{background:#F2F2F2;padding:6px;border:3px solid #fff;width:16.6%;vertical-align:top;font-size:8pt;color:#555}' +
    '.kp b{display:block;font-size:14pt;color:#1F3864}.kp .ar{font-size:8pt}.al{width:100%}.al td{padding:5px 7px;border-bottom:1px solid #eee;vertical-align:top}' +
    '.al td.g{width:70px;font-weight:bold;color:#fff;text-align:center;font-size:8pt}' +
    '.bars{width:100%}.bars td{padding:2px 3px;font-size:9pt;vertical-align:middle}.bars td.rk{width:18px;color:#888;text-align:right}.bars td.lb{width:34%}' +
    '.bars td.br{width:48%}.bars td.vl{width:14%;text-align:right;font-weight:bold;white-space:nowrap}.b{width:100%;height:14px}.b td{padding:0;height:14px}' +
    '.sub{color:#777;font-size:7.5pt}.pod{width:100%}.pod td{width:50%;padding:8px;vertical-align:top}.pod b{font-size:13pt;display:block}' +
    '.rec{width:100%}.rec th{background:#D9E1F2;font-size:7.5pt;padding:3px;border:1px solid #B4C6E7;text-align:left;vertical-align:top}' +
    '.rec th .ar{font-size:7.5pt;text-align:left;direction:rtl}.rec td{font-size:8pt;padding:3px;border:1px solid #D9D9D9}.rec td.n{text-align:right}' +
    '.small{color:#666;font-size:7.5pt}.ok{background:#E2F0D9;padding:8px;font-weight:bold}.keep{page-break-inside:avoid}</style>';
  const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const fr = t => { const d = localDay_(new Date(t)).split('-').map(Number); return jours[new Date(Date.UTC(d[0], d[1] - 1, d[2])).getUTCDay()] + ' ' +
    Utilities.formatDate(new Date(t), TZ, 'dd/MM/yyyy HH\'h\'mm'); };
  let h = '<html><head><meta charset="utf-8">' + css + '</head><body>';
  h += '<h1>' + esc_(T('title')) + ' · ' + esc_(T(b.type === 'J' ? 'day' : 'night')) + '</h1>';
  if (ar) h += '<div class="ar" dir="rtl" style="font-size:15pt;color:#1F3864"><b>' + esc_(TXT.title[1] + ' · ' + TXT[b.type === 'J' ? 'day' : 'night'][1]) + '</b></div>';
  h += '<p class="sub0">Du ' + fr(b.start) + ' au ' + fr(b.end) + ' · édité le ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy à HH:mm') + '</p>';
  if (b.end > Date.now()) h += msgBox_('<b>' + tx('pending') + '</b>', '#FCE4D6', '#ED7D31');
  h += msgBox_(bi(T('msg'), A('msg')), '#FFF2CC', '#C00000');
  const sumD = fn => drivers.reduce((t, o) => t + fn(o), 0);
  const all = st.list, vTop = all.slice().sort((x, y) => y.vmax - x.vmax)[0];
  const kp = (k, v) => '<td>' + esc_(T(k)) + (ar ? '<div class="ar" dir="rtl">' + esc_(TXT[k][1]) + '</div>' : '<br>') + '<b style="font-size:14pt;color:#1F3864">' + esc_(v) + '</b></td>';
  h += '<table class="kp"><tr>' + kp('kDrivers', team.length) + kp('kKm', Math.round(all.reduce((t, o) => t + o.km, 0))) +
    kp('kFuel', Math.round(all.reduce((t, o) => t + o.fuel, 0)) + ' L') + kp('kIdle', fmtH_(all.reduce((t, o) => t + o.idleMin, 0) / 60)) +
    kp('kSpeed', sumD(o => o.cat.Vitesse)) + kp('kVmax', vTop && vTop.vmax ? vTop.vmax + ' km/h' : '-') + '</tr></table>';

  // Alertes
  const al = [];   // [gravité, couleur, fr, darija, tri]
  const push = (g, col, key, v, t) => al.push([g, col, fill(ATXT[key][0], v), fill(ATXT[key][1], v), t || 0]);
  st.collisions.forEach(c => push('CRITIQUE', '#C00000', 'collision', { n: c.o.nom, h: hm(c.t), p: c.plate }, 0));
  drivers.forEach(o => {
    if (o.worst && o.worst.ex >= P.overAlert) push('VITESSE', '#C00000', 'speed', { n: o.nom, v: o.worst.v, lim: o.worst.lim, ex: o.worst.ex, h: o.worst.hm, p: o.worst.plate }, 1);
    else if (o.vmax >= P.vmaxAlert && o.vmaxAt) push('VITESSE', '#C00000', 'vmax', { n: o.nom, v: o.vmax, h: hm(o.vmaxAt.t), p: o.vmaxAt.plate }, 1);
    if (o.team && o.km >= P.kmMin && o.level === 'Dangereux') push('DANGER', '#C00000', 'danger', { n: o.nom, s: r1_(o.score) }, 2);
    if (o.cat.Ceinture) push('CEINTURE', '#ED7D31', 'belt', { n: o.nom, c: o.cat.Ceinture }, 3);
    const hz = o.cat.Freinage + o.cat['Accélération'];
    if (hz >= 5) push('BRUSQUE', '#ED7D31', 'harsh', { n: o.nom, c: hz }, 4);
  });
  st.idles.sort((x, y) => y.m - x.m).forEach(i => push('RALENTI', '#BF8F00', 'idle', { n: i.o.nom, m: i.m, h: hm(i.t), p: i.plate }, 5));
  st.conflicts.forEach(c => push('CONTRATS', '#7030A0', 'conflict', { p: c.plate, n: c.o.nom, c: c.num, k: c.k, o: c.names }, 7));
  if (hors && hors.km >= 1) push('HORS CONTRAT', '#7030A0', 'hors', { p: Object.keys(hors.plates).join(', '), km: Math.round(hors.km), h: hors.firstHors ? hm(hors.firstHors) : '' }, 6);
  al.sort((x, y) => x[4] - y[4]);
  h += '<div class="keep"><h2>' + tx('alerts') + '</h2>';
  h += al.length ? '<table class="al">' + al.map(a => '<tr><td class="g" style="background:' + a[1] + '">' + a[0] + '</td><td>' + bi(a[2], a[3]) + '</td></tr>').join('') + '</table>'
    : msgBox_('<b>' + tx('noAlert') + '</b>', '#E2F0D9', '#63BE7B');
  h += '</div>';

  // Classement
  h += '<div class="keep"><h2>' + tx('rank') + '</h2>';
  if (ranked.length) {
    const best = ranked[0], worst = ranked[ranked.length - 1];
    h += '<table class="pod"><tr><td style="background:#E2F0D9;border:1px solid #E2F0D9"><span class="sub">' + tx('best') + '</span><b style="font-size:13pt">' + esc_(best.nom) + '</b><br>' + r1_(best.score) + ' pts / 100 km · ' + Math.round(best.km) + ' km</td>' +
      (worst !== best ? '<td style="background:#FBE5D6;border:1px solid #FBE5D6"><span class="sub">' + tx('worst') + '</span><b style="font-size:13pt">' + esc_(worst.nom) + '</b><br>' + r1_(worst.score) + ' pts / 100 km · Vmax ' + worst.vmax + ' km/h</td>' : '<td></td>') + '</tr></table>';
  }
  h += wkBars_(ranked.map(o => ({ label: o.nom, sub: TXT[o.level][0] + ' · ' + Math.round(o.km) + ' km · ' + o.cat.Vitesse + ' excès de vitesse · ' + (o.cat.Freinage + o.cat['Accélération']) + ' freinages/accélérations brusques',
    value: Math.max(o.score, 0.5), color: WK_COLORS[o.level], text: r1_(o.score) + ' pts' })), { empty: TXT.noTrip[0] });
  h += '<p class="small">' + bi(T('ptsNote'), A('ptsNote')) + '</p></div>';

  // Détail
  const head = ['hDriver', 'hVeh', 'hLevel', 'hPts', 'hKm', 'hSpeed', 'hBrake', 'hAcc', 'hVmax', 'hIdle', 'hL100'];
  const W = [19, 10, 12, 7, 6, 8, 8, 8, 8, 8, 6];
  const zeros = [];
  const rowOf = o => [o.nom, Object.keys(o.plates).join(', '), o.km >= P.kmMin ? TXT[o.level][0] + (ar ? ' ' + TXT[o.level][1] : '') :
      (o.trips ? (ar ? '< ' + P.kmMin + ' km' : 'Non classé (< ' + P.kmMin + ' km)') : (zeros.push(o), 'Pas de trajet (' + zeros.length + ')')),
    o.km >= P.kmMin ? r1_(o.score) : '-', Math.round(o.km), o.cat.Vitesse, o.cat.Freinage, o.cat['Accélération'],
    o.vmax ? o.vmax : '-', Math.round(o.idleMin) + ' min', o.l100 !== null ? r1_(o.l100) : '-'];
  h += '<div class="keep"><table class="rec" style="margin-top:12px">' + titleRow_(tx('detail'), head.length) + '<tr>' + head.map((k, i) => '<th style="width:' + W[i] + '%">' + esc_(TXT[k][0]) +
    (ar ? '<div class="ar" dir="rtl" style="font-size:7.5pt;color:#333">' + esc_(TXT[k][1]) + '</div>' : '') + '</th>').join('') + '</tr>' +
    ranked.concat(others).map(o => '<tr>' + rowOf(o).map((c, j) => '<td' + (j === 2 && o.km >= P.kmMin ? ' style="background:' + WK_COLORS[o.level] + (o.level === 'Dangereux' ? ';color:#fff;font-weight:bold' : '') + '"' :
      (typeof c === 'number' ? ' class="n"' : '')) + '>' + esc_(c) + '</td>').join('') + '</tr>').join('') + '</table>';
  if (extra.length) h += '<p class="small" style="margin-top:4px">' + esc_('Ont aussi roulé pendant ce shift (fin ou début de leur contrat, hors classement) : ' +
    extra.map(o => o.nom + ' ' + Math.round(o.km) + ' km').join(', ')) + '</p>';
  if (zeros.length) h += '<p class="small" style="margin-top:4px"><b>' + (ar ? 'Pourquoi 0 ? / علاش 0؟' : 'Pourquoi 0 ?') + '</b><br>' + zeros.map((o, i) => '(' + (i + 1) + ') ' + esc_(o.nom) + ' : ' +
    esc_(o.why ? fill(WHY[o.why[0]][0], o.why[1]) : TXT.noTrip[0]) + (ar && o.why ? '<br><span dir="rtl">' + esc_(fill(WHY[o.why[0]][1], o.why[1])) + '</span>' : '')).join('<br>') + '</p>';
  h += '</div>';
  h += msgBox_(bi(T('advice'), A('advice')), '#DDEBF7', '#1F3864');
  h += '<p class="small">' + bi(T('source'), A('source')) + '</p>';
  return h + '</body></html>';
}

// ============================================================================
// 16. CARBURANT CONSOMMÉ ENTRE DEUX DATES (bouton + menu)
// ============================================================================
function btnCarburantPeriode() { openFuelPeriodDialog(); }
function openFuelPeriodDialog() {
  const veh = Object.values(vehicles_()).filter(v => v.active).sort((a, b) => a.plate.localeCompare(b.plate));
  const now = new Date(), f = d => Utilities.formatDate(d, TZ, 'yyyy-MM-dd\'T\'HH:mm');
  const d0 = localDay_(now).slice(0, 8) + '01';
  const opts = '<option value="">Tous les véhicules</option>' + veh.map(v => '<option value="' + v.key + '">' + esc_(v.plate + ' ' + v.model) + '</option>').join('');
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;font-size:13px">' +
    '<table style="width:100%"><tr><td>Du<br><input id="a" type="datetime-local" value="' + d0 + 'T00:00" style="width:95%;padding:3px"></td>' +
    '<td>Au<br><input id="z" type="datetime-local" value="' + f(now) + '" style="width:95%;padding:3px"></td></tr></table>' +
    '<p>Véhicule<br><select id="v" style="width:100%;padding:4px">' + opts + '</select></p>' +
    '<p><label><input type="checkbox" id="sy" checked> Télécharger d\'abord les journées manquantes depuis Geotab</label></p>' +
    '<button id="b" onclick="go()" style="background:#C55A11;color:#fff;border:0;padding:8px 16px;border-radius:6px">Calculer</button>' +
    '<div id="s" style="margin-top:10px"></div></div>' +
    '<script>function go(){var b=document.getElementById("b");b.disabled=true;document.getElementById("s").innerText="Calcul en cours...";' +
    'google.script.run.withSuccessHandler(function(r){b.disabled=false;document.getElementById("s").innerHTML=r;})' +
    '.withFailureHandler(function(e){b.disabled=false;document.getElementById("s").innerText="Erreur : "+e.message;})' +
    '.fuelPeriod(document.getElementById("a").value,document.getElementById("z").value,document.getElementById("v").value,document.getElementById("sy").checked);}</script>'
  ).setWidth(520).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Carburant consommé entre deux dates');
}
/** "aaaa-mm-jjThh:mm" (heure locale) -> Date */
function parseLocalInput_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) throw new Error('Date invalide : ' + s);
  return localToDate_(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
}
/**
 * Calcule le carburant consommé entre deux instants (tous les véhicules ou un seul), écrit l'onglet CARBURANT PÉRIODE
 * et retourne un résumé HTML pour la fenêtre. Source : compteur carburant du véhicule, trajet par trajet.
 */
function fuelPeriod(fromStr, toStr, vehKey, doSync) {
  const t0 = Date.now(), P = params_(), veh = vehicles_();
  const a = parseLocalInput_(fromStr).getTime(), z = Math.min(parseLocalInput_(toStr).getTime(), Date.now());
  if (!(z > a)) throw new Error('La date de fin doit être après la date de début.');
  const list = Object.values(veh).filter(v => v.active && v.geoId && (!vehKey || v.key === vehKey));
  if (!list.length) throw new Error('Aucun véhicule relié à Geotab.');
  const days = []; for (let d = localDay_(new Date(a)); d <= localDay_(new Date(z - 1)); d = addDays_(d, 1)) days.push(d);
  // Journées manquantes : ni finalisées ni couvertes par le temps réel
  let synced = coverage_();
  let missing = [];
  days.forEach(d => list.forEach(v => { if (!synced[v.key + '|' + d]) missing.push({ d, k: v.key }); }));
  let syncMsg = '';
  if (doSync && (missing.length || days.indexOf(localDay_(new Date())) >= 0)) {
    const res = withLock_('Carburant entre deux dates', () => ensureData_(days, 24), true);
    if (res !== null) { syncMsg = res; synced = coverage_(); }
    else syncMsg = 'Une synchro est en cours : calcul fait avec les données déjà présentes. ';
    missing = missing.filter(x => !synced[x.k + '|' + x.d]);
  }
  // Agrégation trajet par trajet (un trajet compte dans la période s'il y démarre)
  const T = readData_(S.TRIP, addDays_(days[0], -1)), IT = idx_(H.TRIP), keys = {}; list.forEach(v => { keys[v.key] = v; });
  const mk = () => ({ trips: 0, km: 0, drive: 0, fuel: 0, fuelKm: 0, fuelN: 0, noFuel: 0, idleL: 0, idleMin: 0, pleins: 0, pleinsL: 0, pleinsEst: 0 });
  const byV = {}, byD = {}, byDay = {}, tot = mk();
  const add = (o, r) => {
    const km = num_(r[IT['Km']]); o.trips++; o.km += km; o.drive += num_(r[IT['Conduite (min)']]) / 60; o.idleMin += num_(r[IT['Ralenti moteur tournant (min)']]);
    if (r[IT['Carburant (L)']] !== '') { o.fuel += num_(r[IT['Carburant (L)']]); o.fuelKm += km; o.fuelN++; } else o.noFuel++;
    if (r[IT['Carburant ralenti (L)']] !== '') o.idleL += num_(r[IT['Carburant ralenti (L)']]);
  };
  T.rows.forEach(r => {
    const key = String(r[IT['Clé plaque']]); if (!keys[key]) return;
    const t = tms_(r[IT['Début']]); if (t < a || t >= z) return;
    const code = String(r[IT['Code chauffeur']] || HORS), nom = code === HORS ? 'Hors contrat' : String(r[IT['Chauffeur']] || code);
    add(byV[key] = byV[key] || mk(), r); add(tot, r);
    const dk = code + '|' + nom; add(byD[dk] = byD[dk] || mk(), r);
    const day = localDay_(new Date(t)); byDay[day] = byDay[day] || {};
    if (r[IT['Carburant (L)']] !== '') byDay[day][key] = (byDay[day][key] || 0) + num_(r[IT['Carburant (L)']]);
  });
  // Pleins détectés par Geotab dans la période.
  // Litres (jauge) = hausse de la jauge pendant le plein (le plus proche de ce qui a été mis dans le réservoir ; la jauge Staria plafonne à 73,5 L).
  // Estimation Geotab = carburant consommé depuis le plein précédent : égale au volume pompé seulement si les deux pleins sont complets.
  const F = readData_(S.FUEL, addDays_(days[0], -1)), IF = idx_(H.FUEL), fills = [];
  F.rows.forEach(r => {
    if (r[IF['Type']] !== 'PLEIN') return;
    const key = String(r[IF['Clé plaque']]); if (!keys[key]) return;
    const t = tms_(r[IF['Arrêt début']]); if (t < a || t >= z) return;
    const Lj = num_(r[IF['Litres (jauge)']]), Lg = num_(r[IF['Litres Geotab']]);
    [byV[key] = byV[key] || mk(), tot].forEach(o => { o.pleins++; o.pleinsL += Lj; o.pleinsEst += Lg; });
    fills.push([keys[key].plate, new Date(t), String(r[IF['Chauffeur']] || ''), r[IF['Niveau avant (%)']], r[IF['Niveau après (%)']], r1_(Lj), r1_(Lg),
      mapLink_(r[IF['Lat']], r[IF['Lon']])]);
  });
  fills.sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]);
  const l100 = o => o.fuelKm >= P.minFuelKm ? r1_(o.fuel / o.fuelKm * 100) : '';
  const cov = o => o.trips ? Math.round(o.fuelN / o.trips * 100) + ' %' : '-';
  const cost = (L, v) => v && v.price > 0 ? Math.round(L * v.price) : '';
  // ---------- Onglet ----------
  const s = ensureSheet_(S.FUELP, null, '#C55A11');
  resetView_(s, 1); s.setHiddenGridlines(true);
  const fdt = t => Utilities.formatDate(new Date(t), TZ, 'dd/MM/yyyy HH:mm');
  title_(s, 'Carburant consommé du ' + fdt(a) + ' au ' + fdt(z),
    (vehKey ? 'Véhicule ' + keys[vehKey].plate : 'Tous les véhicules (' + list.length + ')') + '. Litres = compteur carburant du véhicule, trajet par trajet (aucune estimation). ' +
    'Un trajet compte dans la période s\'il y démarre. Pleins = détectés par Geotab (hausse de jauge) : à comparer aux tickets de carburant.' + (missing.length ? ' ATTENTION : ' + missing.length + ' véhicule-jours pas encore téléchargés, total incomplet.' : ''));
  const costT = list.reduce((t, v) => t + (byV[v.key] && v.price > 0 ? byV[v.key].fuel * v.price : 0), 0);
  cards_(s, 4, [['Carburant consommé (L)', r1_(tot.fuel), F1, '#C55A11'], ['Km', Math.round(tot.km), F0], ['Consommation (L/100 km)', l100(tot) || '-', F1],
    ['Dont moteur allumé à l\'arrêt (L)', r1_(tot.idleL), F1], ['Pleins détectés', tot.pleins, F0], ['Litres pleins (jauge)', r1_(tot.pleinsL), F1], ['Coût (MAD)', costT ? Math.round(costT) : '-', F0],
    ['Trajets mesurés', cov(tot)]]);
  const vRows = list.filter(v => byV[v.key]).map(v => { const o = byV[v.key];
    return [v.plate, v.model, o.trips, r1_(o.km), r1_(o.fuel), l100(o), r1_(o.idleL), hv_(o.idleMin / 60), o.pleins, r1_(o.pleinsL), r1_(o.pleinsEst), cost(o.fuel, v), cov(o)]; });
  let t = table_(s, 7, 'Par véhicule', ['Véhicule', 'Modèle', 'Trajets', 'Km', 'Carburant (L)', 'L/100 km', 'Litres moteur à l\'arrêt', 'Temps moteur à l\'arrêt',
    'Pleins détectés', 'Litres pleins (jauge)', 'Estimation Geotab (conso depuis plein précédent)', 'Coût (MAD)', 'Trajets mesurés'], vRows, [null, null, F0, F1, F1, F1, F1, FH, F0, F1, F1, F0, null]);
  const dRows = Object.keys(byD).map(k => { const o = byD[k], p = k.split('|');
    return [p.slice(1).join('|'), p[0] === HORS ? '' : p[0], o.trips, r1_(o.km), r1_(o.fuel), l100(o), r1_(o.idleL), hv_(o.idleMin / 60), cov(o)]; })
    .sort((x, y) => y[4] - x[4]);
  t = table_(s, t.next + 1, 'Par chauffeur (contrats)', ['Chauffeur', 'Code', 'Trajets', 'Km', 'Carburant (L)', 'L/100 km', 'Litres moteur à l\'arrêt', 'Temps moteur à l\'arrêt', 'Trajets mesurés'],
    dRows, [null, null, F0, F1, F1, F1, F1, FH, null]);
  const vk = list.filter(v => byV[v.key]);
  const dayRows = Object.keys(byDay).sort().map(d => [dayToDate_(d)].concat(vk.map(v => r1_(byDay[d][v.key] || 0)), [r1_(vk.reduce((x, v) => x + (byDay[d][v.key] || 0), 0))]));
  t = table_(s, t.next + 1, 'Par jour (litres)', ['Jour'].concat(vk.map(v => v.plate), ['Total']), dayRows, [FD].concat(vk.map(() => F1), [F1]));
  t = table_(s, t.next + 1, 'Pleins détectés, un par un (à pointer avec les tickets de carburant)', ['Véhicule', 'Date / heure', 'Chauffeur', 'Jauge avant (%)', 'Jauge après (%)',
    'Litres (jauge)', 'Estimation Geotab', 'Lieu'], fills, [null, FDT, null, F1, F1, F1, F1, null]);
  if (missing.length) table_(s, t.next + 1, 'Journées pas encore téléchargées (lancez « Synchroniser une période » ou recalculez avec la case cochée)',
    ['Véhicule', 'Jour'], missing.map(x => [veh[x.k] ? veh[x.k].plate : x.k, dayToDate_(x.d)]), [null, FD]);
  widths_(s, 1, [200, 110]); for (let c = 3; c <= Math.max(12, vk.length + 2); c++) s.setColumnWidth(c, 105);
  log_('Carburant période', fdt(a) + ' → ' + fdt(z) + ' : ' + r1_(tot.fuel) + ' L, ' + Math.round(tot.km) + ' km', t0);
  try { ss_().setActiveSheet(s); } catch (e) { }
  // ---------- Résumé pour la fenêtre ----------
  const tr = (cells, b) => '<tr>' + cells.map(c => '<td style="padding:3px 6px;border-bottom:1px solid #eee' + (b ? ';font-weight:bold' : '') + '">' + esc_(c) + '</td>').join('') + '</tr>';
  return (syncMsg ? '<p style="color:#7F6000">' + esc_(syncMsg) + '</p>' : '') +
    '<p style="font-size:15px"><b>' + r1_(tot.fuel) + ' L</b> consommés · ' + Math.round(tot.km) + ' km' + (l100(tot) ? ' · <b>' + l100(tot) + ' L/100 km</b>' : '') + '</p>' +
    '<p>Dont moteur allumé à l\'arrêt : ' + r1_(tot.idleL) + ' L · Pleins détectés : ' + tot.pleins + ' (' + r1_(tot.pleinsL) + ' L à la jauge)' + (costT ? ' · Coût : ' + Math.round(costT) + ' MAD' : '') + '</p>' +
    '<table style="border-collapse:collapse;font-size:12px;width:100%">' + tr(['Véhicule', 'Km', 'Litres', 'L/100', 'Pleins'], true) +
    vRows.map(r => tr([r[0], r[3], r[4], r[5] || '-', r[8]])).join('') + '</table>' +
    (missing.length ? '<p style="color:#C00000">Total incomplet : ' + missing.length + ' véhicule-jours pas encore téléchargés.</p>' : '') +
    '<p style="color:#666">Détail par véhicule, chauffeur et jour : onglet ' + S.FUELP + '.</p>';
}

// Export pour tests Node (ignoré par Apps Script)
if (typeof module !== 'undefined') module.exports = { analyzeDay_, idleSegments_, inTripRefuels_, parseLocalDT_, normPlate_, fmtH_, runMinutes_, integrateRate_, verifiedIdle_, classifyDiag_, unitFactor_, parseSpeed_ };
