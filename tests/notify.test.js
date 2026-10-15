// Alertes par e-mail (destinataires choisis, filtrés par agence / gravité / type, envoyées une seule fois)
// et rapports PDF planifiés (une fois par période, données finalisées, agence).
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6');
const NOW = Date.UTC(2026, 9, 6, 9, 0);   // 06/10/2026 09:00, heure du Maroc (UTC+0)
let B;
const alert = (id, day, key, plate, sev, type) => `('${id}', '${day}', '10:00', '${plate}', '${key}', 'Chauffeur ${id}', '${type || 'Vitesse'}', '${sev}', 'détail ${id}', '')`;

test.before(() => {
  B = collector(NOW); B.run('installer()');
  env.psql(`insert into agencies (name) values ('Casablanca'), ('Marrakech');
    update parc set agency_id = 1 where plate = 'WW968194'; update parc set agency_id = 2 where plate = 'WW968199';
    insert into alerts (id, day, time, plate, vehicle_key, driver_name, type, severity, detail, value) values ${alert('old', '2026-10-01', '968194WW', 'WW968194', 'Critique')};`);
});

test('agence des véhicules reprise du parc', () => {
  assert.strictEqual(env.psql("select string_agg(key || '=' || agency_id, ' ' order by key) from vehicles"), '968194WW=1 968199WW=2');
});

test('premier passage : l\'historique n\'est pas envoyé', () => {
  env.psql("insert into alert_recipients (email, min_severity) values ('chef@x', 'Haute')");
  B.run('notifyAlerts_()');
  assert.strictEqual(B.mails.length, 0);
  assert.strictEqual(env.psql('select count(*) from alerts where notified_at is null'), '0');
});

test('nouvelles alertes : chaque destinataire reçoit celles qui le concernent, une seule fois', () => {
  env.psql(`insert into alert_recipients (email, agency_id, min_severity) values ('casa@x', 1, 'Critique');
    insert into alert_recipients (email, min_severity, types) values ('carbu@x', 'Info', 'Siphonage suspect');
    insert into alert_recipients (email, min_severity, active) values ('inactif@x', 'Info', false);
    insert into alerts (id, day, time, plate, vehicle_key, driver_name, type, severity, detail, value) values
      ${alert('a1', '2026-10-06', '968194WW', 'WW968194', 'Critique')}, ${alert('a2', '2026-10-05', '968199WW', 'WW968199', 'Haute')},
      ${alert('a3', '2026-10-03', '968194WW', 'WW968194', 'Critique')}, ${alert('a4', '2026-10-06', '968199WW', 'WW968199', 'Moyenne', 'Siphonage suspect')}`);
  const res = B.run('notifyAlerts_()');
  assert.match(res, /3 destinataires/);
  const by = {}; B.mails.forEach(m => { by[m.to] = m; });
  assert.deepStrictEqual(Object.keys(by).sort(), ['carbu@x', 'casa@x', 'chef@x']);
  assert.match(by['chef@x'].htmlBody, /détail a1/); assert.match(by['chef@x'].htmlBody, /détail a2/);
  assert.doesNotMatch(by['chef@x'].htmlBody, /détail a3|détail a4/, 'alerte ancienne ou moins grave envoyée');
  assert.match(by['chef@x'].subject, /2 alertes \(critique\)/);
  assert.match(by['casa@x'].htmlBody, /détail a1/); assert.doesNotMatch(by['casa@x'].htmlBody, /détail a2/);
  assert.match(by['carbu@x'].htmlBody, /détail a4/); assert.doesNotMatch(by['carbu@x'].htmlBody, /détail a1/);
  assert.strictEqual(env.psql('select count(*) from alerts where notified_at is null'), '0');
  B.run('notifyAlerts_()');
  assert.strictEqual(B.mails.length, 3, 'alertes renvoyées');
});

test('rapport quotidien : envoyé une fois, après l\'heure prévue et la finalisation, avec le PDF de l\'agence', () => {
  B.mails.length = 0;
  env.psql(`insert into journal (id, day, plate, vehicle_key, driver_code, driver_name, contract_num, km, drive_h, idle_h, fuel_l, fuel_km, n_events, danger_pts, n_trips) values
      ('j1', '2026-10-05', 'WW968194', '968194WW', 'C1', 'Chauffeur Un', 'K1', 120.4, 2.5, 0.5, 9.1, 120.4, 3, 12, 4),
      ('j2', '2026-10-05', 'WW968199', '968199WW', 'C2', 'Chauffeur Deux', 'K2', 80, 1.5, 0.2, null, null, 1, 3, 2);
    insert into report_schedules (name, agency_id, frequency, recipients) values ('Casa jour', 1, 'jour', 'dir@x, adj@x');`);
  B.run("PropertiesService.getScriptProperties().deleteProperty('DERIVED_DIRTY'); PropertiesService.getScriptProperties().deleteProperty('SYNC_QUEUE')");
  assert.strictEqual(B.run('reportsStep_()'), '', 'envoyé avant 13 h');
  B.setNow(Date.UTC(2026, 9, 6, 14, 0));
  B.run("PropertiesService.getScriptProperties().setProperty('DERIVED_DIRTY', '2026-10-05')");
  assert.strictEqual(B.run('reportsStep_()'), '', 'envoyé avant le calcul du journal');
  B.run("PropertiesService.getScriptProperties().deleteProperty('DERIVED_DIRTY')");
  assert.match(B.run('reportsStep_()'), /Casa jour : du 05\/10\/2026 envoyé à 2 destinataires/);
  assert.strictEqual(B.mails.length, 1);
  const m = B.mails[0];
  assert.strictEqual(m.to, 'dir@x,adj@x');
  assert.strictEqual(m.attachments.length, 1);
  assert.match(m.attachments[0].name, /^rapport_flotte_Casablanca_2026-10-05\.pdf$/);
  const pdfHtml = String(B.pdfs[B.pdfs.length - 1]);
  assert.match(pdfHtml, /Rapport quotidien de la flotte/);
  assert.match(pdfHtml, /Chauffeur Un/); assert.doesNotMatch(pdfHtml, /Chauffeur Deux/, 'autre agence dans le rapport');
  assert.match(pdfHtml, /120/);
  assert.match(m.htmlBody, /Km parcourus/);
  assert.strictEqual(env.psql("select last_period from report_schedules"), '2026-10-05');
  assert.strictEqual(B.run('reportsStep_()'), '');
  assert.strictEqual(B.mails.length, 1, 'rapport envoyé deux fois');
});

test('« Envoyer maintenant » depuis le site et rapport hebdomadaire de toutes les agences', () => {
  B.mails.length = 0;
  env.psql("insert into report_schedules (name, frequency, recipients) values ('Semaine', 'semaine', 'dg@x'); insert into jobs (kind, arg) values ('send_report', '2')");
  B.run('processJobs_(Date.now())');
  assert.strictEqual(B.mails.length, 1);
  assert.match(B.mails[0].subject, /hebdomadaire de la flotte du 28\/09\/2026 au 04\/10\/2026$/);
  assert.match(env.psql("select result from jobs where kind = 'send_report'"), /envoyé à 1 destinataire/);
  assert.match(String(B.pdfs[B.pdfs.length - 1]), /Toutes les agences/);
});

test('aucune erreur dans le journal technique', () => {
  assert.strictEqual(env.psql("select coalesce(string_agg(detail, ' | '), '') from logs where detail ~* 'erreur'"), '');
});
