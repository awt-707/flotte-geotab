/**
 * FLOTTE GEOTAB — COLLECTEUR (Google Apps Script autonome) -> base Supabase -> site web
 * ----------------------------------------------------------------------------------------------
 * Toutes les 5 min : état des véhicules et trajets terminés (temps réel), demandes du site
 * (contrats importés, plaques, synchro immédiate), journal et alertes, finalisation des journées
 * terminées (le lendemain midi), alertes par e-mail, rapports PDF planifiés. Une fois par jour : véhicules
 * du parc (liste gérée sur le site), règles Geotab, chauffeurs, sauvegarde dans Drive. Une fois par mois : archivage dans Drive des données anciennes.
 *
 * Installation (une seule fois) :
 *  1. Paramètres du projet (roue dentée) > Propriétés du script :
 *       GEO_USER      = identifiant Geotab
 *       GEO_PWD       = mot de passe Geotab
 *       SUPABASE_KEY  = clé service_role (Supabase > Project Settings > API Keys > Legacy > service_role) : à ne jamais communiquer
 *     (SUPABASE_URL et OLD_SHEET_ID ont des valeurs par défaut ci-dessous, modifiables par propriété du même nom)
 *  2. Choisir la fonction « installer » puis Exécuter, accepter les autorisations.
 * Le calcul (moteur v6) est identique à celui du Google Sheet : seules la lecture et l'écriture changent.
 */
const COLLECTOR_V = PropertiesService.getScriptProperties().getProperty('CODE_VERSION') || '1.0';   // version installée (mise à jour automatique)
const DEFAULT_SUPABASE_URL = 'https://cgiiwumbblimvmrypxlc.supabase.co';          // projet Supabase « flotte_luxury »
const SITE_URL = 'https://flotte-geotab-clicar.netlify.app';                     // site (liens dans les e-mails)
const DEFAULT_OLD_SHEET_ID = '1VxAV7P5SlaeSIZRC_EAQKjl3CFICQS4idJre4YLif1k';      // ancien Google Sheet Flotte Geotab (reprise de l'historique)
/** Tables (mêmes clés que le Sheet v6 : le code de calcul est repris tel quel) */
const S = { VEH: 'VEH', DRV: 'DRV', CTR: 'CTR', RULE: 'RULE', TRIP: 'TRIP', EVT: 'EVT', FUEL: 'FUEL', IDL: 'IDL', STP: 'STP', LVL: 'LVL',
  SYNC: 'SYNC', JRN: 'JRN', ALERT: 'ALERT', PLATES: 'PLATES' };
let HOLDS_LOCK_ = false;
// Pas d'interface Sheets dans le collecteur
function toast_() { }
function ui_() { return null; }
/** La file de finalisation est traitée par collect toutes les 5 min : pas de déclencheur à part */
function ensureSyncTrigger_() { }
