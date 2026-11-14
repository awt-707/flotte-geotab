// Rangement des objets du schéma public par domaine (database/schema/<nn>_<fichier>.sql).
// Une nouvelle table ou fonction doit être ajoutée ici : « node database/outils/schema.js build » refuse un objet sans domaine.
'use strict';
const DOMAINS = {
  '00': { file: 'socle', title: 'Socle : fonctions de droits, paramètres, demandes du site, journal technique, versions du collecteur, suivi des limites',
    about: ['Fonctions de droits (is_admin, my_role, my_vehicle_keys, rh_scope, plan_can_edit…), paramètres (params), règles de score (rules), demandes du site au collecteur (jobs), journal technique (logs),',
      'versions du collecteur (releases), compteurs d\'usage (usage_daily), session Geotab du relais, coffre des intégrations.'],
    tables: ['params', 'rules', 'jobs', 'logs', 'releases', 'usage_daily', 'geotab_session', 'integration_secrets'],
    functions: [
      // fonctions de droits (utilisées par les règles RLS et le stockage de tous les domaines)
      'is_admin', 'my_role', 'my_agency_ids', 'my_vehicle_keys', 'my_driver_codes', 'is_rh', 'rh_scope', 'rh_agency_ids', 'rh_driver_codes', 'rh_staff_users', 'hr_can', 'hr_can_emp', 'wc_can', 'plan_can_read', 'plan_can_edit', 'plan_driver_in', 'cash_folder_ok',
      'norm_name', 'norm_plate', 'name_key', 'db_size', 'usage_stats', 'bump_usage', 'integration_set', 'integration_status'] },
  '10': { file: 'comptes_agences', title: 'Comptes, agences et droits',
    about: ['Profils (rôle admin / manager / viewer / rh / pending), agences, rattachements, connexions en temps réel,',
      'planning des gestionnaires, destinataires des alertes et des rapports. Fonctions de droits utilisées par toutes les règles RLS.'],
    tables: ['profiles', 'agencies', 'user_agencies', 'user_sessions', 'manager_shifts', 'alert_recipients', 'report_schedules'],
    functions: ['handle_new_user', 'session_ping', 'user_sessions_guard', 'menu_set', 'shift_plan'] },
  '20': { file: 'flotte', title: 'Flotte : véhicules, parc, données Geotab, alertes, journal',
    about: ['Véhicules et parc (plaques, agences, sociétés), changements de plaque, données Geotab finalisées ou en direct',
      '(trajets, ralentis, arrêts moteur, événements, carburant, jauge), alertes, journal par contrat, tickets de carte carburant.'],
    tables: ['vehicles', 'parc', 'plate_changes', 'vehicle_days', 'trips', 'idles', 'engine_stops', 'events', 'fuel', 'levels', 'alerts', 'journal', 'live_status', 'fuel_card_tx'],
    functions: ['finalize_vdays', 'put_rows', 'purge_before', 'replace_alerts', 'replace_journal', 'alert_counts', 'driver_rule_counts', 'rekey_vehicle',
      'key_stats', 'parc_agency_for', 'parc_agency_trg', 'vehicles_agency_trg', 'import_fuel_card', 'mark_notified'] },
  '30': { file: 'chauffeurs_contrats', title: 'Chauffeurs et contrats de location',
    about: ['Contrats injectés depuis l\'extract (import_contracts) et chauffeurs qui en sont déduits (refresh_drivers).'],
    tables: ['drivers', 'contracts'],
    functions: ['import_contracts', 'refresh_drivers', 'contract_first', 'drivers_guard_trg'] },
  '40': { file: 'courses_manifestes', title: 'Courses privées, grilles tarifaires et manifestes',
    about: ['Courses et devis (missions, validation par l\'administrateur, double réservation refusée), grilles par ville de départ,',
      'manifestes et sociétés émettrices (manifest_config).'],
    tables: ['missions', 'pricing_grid', 'manifests', 'manifest_config'],
    functions: ['mission_guard', 'mission_quick_guard', 'mission_booking', 'mission_number', 'manifest_config_keep'] },
  '50': { file: 'caisse', title: 'Caisse : encaissements, dépenses, Uber, Bolt, justificatifs',
    about: ['Journal unique des mouvements (cash_moves, garde cash_guard, historique cash_log), exports Uber et Bolt,',
      'fiches d\'encaissement et justificatifs déposés (cash_sheets, cash_files).'],
    tables: ['cash_moves', 'cash_log', 'uber_payments', 'uber_drivers', 'bolt_sessions', 'cash_sheets', 'cash_files'],
    functions: ['cash_guard', 'cash_log_trg', 'cash_agency_trg'] },
  '60': { file: 'planning_chauffeurs', title: 'Planning des chauffeurs',
    about: ['Réglages par chauffeur (driver_roster), cases jour / nuit (driver_plan), absences, semaines publiées ou verrouillées, historique.'],
    tables: ['driver_roster', 'driver_plan', 'driver_absences', 'plan_weeks', 'plan_log'],
    functions: ['plan_save', 'plan_week_set', 'plan_replace_driver', 'plan_log_trg', 'plan_absence_guard'] },
  '65': { file: 'suivi', title: 'Pauses chauffeurs et suivi des courses privées',
    about: ['Pauses déclenchées par le gestionnaire (2 h par chauffeur et par shift, véhicule qui bouge pendant la pause noté),',
      'suivi d\'une course privée de la prise en charge à l\'arrivée (positions GPS Geotab relevées).'],
    tables: ['driver_pauses', 'mission_tracks'],
    functions: ['suivi_guard'] },
  '70': { file: 'rh', title: 'Ressources humaines et contrats de travail',
    about: ['Salariés (chauffeurs et staff), événements (congés, absences, avances, avenants…), pointage du staff, dossiers,',
      'sociétés employeuses et contrats de travail. Rôle « rh » limité ou non à des agences (rh_scope).'],
    tables: ['hr_employees', 'hr_events', 'hr_clock', 'hr_documents', 'employers', 'work_contracts'],
    functions: ['hr_clock_do', 'hr_me', 'hr_state',
      'hr_touch', 'hr_user_guard', 'rh_drive_set', 'rh_drive_reset', 'employers_touch', 'work_contracts_guard'] },
};
const T = {}, F = {};
for (const [d, x] of Object.entries(DOMAINS)) { x.tables.forEach(t => { T[t] = d; }); x.functions.forEach(f => { F[f] = d; }); }
const domainOfTable = t => T[t] || (/_seq$/.test(t) ? T[t.replace(/_id_seq$|_seq$/, '')] || T[t.replace(/_number_seq$/, 's')] : undefined);
const domainOfFunction = f => F[f];
module.exports = { DOMAINS, domainOfTable, domainOfFunction };
