// Réglages communs des tests (surchargeables par variables d'environnement, utilisées en CI)
// Fuseau du processus = fuseau du projet Apps Script (le moteur v6 et le faux Google Sheets s'appuient dessus)
process.env.TZ = 'Africa/Casablanca';
const path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const PG = process.env.PG_URL || 'postgresql://postgres@localhost:54322/flotte?host=/tmp';
const env = {
  ROOT,
  REF: path.join(ROOT, 'tests', 'reference'),
  FIX: path.join(ROOT, 'tests', 'fixtures'),
  COLLECTOR: path.join(ROOT, 'collector', 'dist', 'Collecteur.gs'),
  POSTGREST: process.env.POSTGREST_URL || 'http://localhost:3001',
  OUT: process.env.TEST_OUT || path.join(ROOT, 'tests', 'out'),
  CHROMIUM: process.env.CHROMIUM_PATH || undefined,
  psql: sql => execFileSync('psql', [PG, '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: sql, maxBuffer: 1 << 28 }).toString().trim(),
  contrats: () => JSON.parse(require('fs').readFileSync(path.join(ROOT, 'tests', 'fixtures', 'contrats.json'), 'utf8')),
  resetDb: () => env.psql('truncate trips, idles, engine_stops, events, fuel, levels, vehicle_days, journal, alerts, live_status, logs, jobs, contracts, drivers, vehicles, plate_changes, rules, params, releases, parc, alert_recipients, report_schedules, user_agencies, agencies restart identity cascade'),
  svcKey: () => require('fs').readFileSync(path.join(__dirname, 'svc.jwt'), 'utf8').trim()
};
require('fs').mkdirSync(env.OUT, { recursive: true });
module.exports = env;
