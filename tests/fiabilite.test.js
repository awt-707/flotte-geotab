// Fiabilité du collecteur (relecture du 16/10/2026) : contrats longs, rapports planifiés, alertes par e-mail, finalisation.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6');
const NOW = Date.UTC(2026, 9, 6, 14, 0);
let B;
test.before(() => { B = collector(NOW); B.run('installer()'); });

test('contrat long encore en cours (commencé il y a plus de 107 jours) : chauffeur bien rattaché', () => {
  env.psql(`insert into contracts (num, client_code, name, plate, vehicle_key, start_at) values ('LONG', 'CL', 'Contrat Long', 'WW968194', '968194WW', '2026-05-01 08:00+00')`);
  const r = JSON.parse(B.run("JSON.stringify(attrib_(contractIndex_(), '968194WW', Date.UTC(2026, 9, 5, 10, 0), 20 * 60000))"));
  assert.strictEqual(r.num, 'LONG');
  env.psql("delete from contracts where num = 'LONG'"); B.run('memoClear_()');
});

test('rapport planifié : pas avant la finalisation de ses journées, renvoyé après un échec', () => {
  env.psql("delete from report_schedules; insert into report_schedules (name, frequency, recipients) values ('Jour', 'jour', 'dir@x')");
  B.run("PropertiesService.getScriptProperties().deleteProperty('DERIVED_DIRTY'); PropertiesService.getScriptProperties().setProperty('SYNC_QUEUE', '[]')");
  B.setNow(Date.UTC(2026, 9, 6, 9, 0)); B.run("setParam_('reportHour', '0')");
  assert.strictEqual(B.run('reportsStep_()'), '', 'rapport de la veille envoyé avant midi (journée pas finalisée)');
  B.setNow(Date.UTC(2026, 9, 6, 13, 0));
  // file vide mais journée de la veille pas finalisée (Geotab en panne à midi, file abandonnée) : pas de rapport sur des lignes provisoires
  env.psql("delete from vehicle_days where day = '2026-10-05'"); B.run('memoClear_()');
  assert.strictEqual(B.run('reportsStep_()'), '', 'rapport envoyé sur une journée pas finalisée');
  env.psql("insert into vehicle_days (id, vehicle_key, day, synced_at) select key || '|2026-10-05', key, '2026-10-05', '2026-10-06 14:01+00' from vehicles on conflict (id) do update set synced_at = excluded.synced_at"); B.run('memoClear_()');
  const send = B.ctx.MailApp.sendEmail; B.ctx.MailApp.sendEmail = () => { throw new Error('Exception: You do not have permission to call MailApp.sendEmail'); };
  try { assert.match(B.run('reportsStep_()'), /Erreur/); } finally { B.ctx.MailApp.sendEmail = send; }
  assert.strictEqual(env.psql("select coalesce(last_period, '-') from report_schedules"), '-', 'période notée envoyée malgré l\'échec');
  B.setNow(Date.UTC(2026, 9, 6, 14, 5));
  B.mails.length = 0;
  assert.match(B.run('reportsStep_()'), /envoyé à 1 destinataire/);
  assert.strictEqual(env.psql('select last_period from report_schedules'), '2026-10-05');
  B.run("setParam_('reportHour', '13')");
});

test('alertes par e-mail : pas perdues tant que l\'envoi d\'e-mails n\'est pas autorisé', () => {
  env.psql(`delete from alert_recipients; insert into alert_recipients (email, min_severity) values ('chef@x', 'Info');
    insert into alerts (id, day, time, plate, vehicle_key, type, severity, detail) values ('F1', '2026-10-06', '13:00', 'WW968194', '968194WW', 'Vitesse excessive', 'Haute', 'x')`);
  B.run("PropertiesService.getScriptProperties().setProperty('NOTIFY_FROM', '2026-10-01')");
  const send = B.ctx.MailApp.sendEmail; B.ctx.MailApp.sendEmail = () => { throw new Error('Exception: You do not have permission to call MailApp.sendEmail'); };
  try { B.run('notifyAlerts_()'); } finally { B.ctx.MailApp.sendEmail = send; }
  assert.strictEqual(env.psql("select notified_at is null from alerts where id = 'F1'"), 't', 'alerte marquée envoyée alors que rien n\'est parti');
  B.mails.length = 0; B.run('notifyAlerts_()');
  assert.strictEqual(B.mails.length, 1); assert.match(B.mails[0].htmlBody, /Vitesse excessive/);
  assert.strictEqual(env.psql("select notified_at is not null from alerts where id = 'F1'"), 't');
});

test('erreur passagère de finalisation : pas prise pour une migration absente (arrêts moteur conservés)', () => {
  assert.strictEqual(B.run("stopsMissing_(new Error('Supabase post rpc/finalize_vdays : HTTP 503 upstream timeout'))"), false);
  assert.strictEqual(B.run(`stopsMissing_(new Error('Supabase post rpc/finalize_vdays : HTTP 404 {"code":"PGRST202","message":"Could not find the function"}'))`), true);
});
