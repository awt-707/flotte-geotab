// Assemble les fichiers de collector/src en un seul Collecteur.gs (tests et copie manuelle dans Apps Script).
// L'ordre est celui de .clasp.json (filePushOrder) : c'est aussi l'ordre de chargement dans Apps Script.
const fs = require('fs'), path = require('path');
const ORDER = ['00_head.gs', '05_constants.gs', '10_db.gs', '15_engine.gs', '17_stops.gs', '18_fills.gs', '19_speed.gs', '20_ref.gs', '30_run.gs', '40_install.gs', '45_update.gs', '50_notify.gs', '55_cashsheet.gs', '56_study.gs', '57_rhdrive.gs'];
// Calculs partagés avec le site : rapports (site/report.js, 60_report), ressources humaines (site/rh_calc.js, 61_rh : alertes RH par e-mail)
const SHARED = [['60_report', path.join(__dirname, '..', 'site', 'report.js')], ['61_rh', path.join(__dirname, '..', 'site', 'rh_calc.js')]];
const src = f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const code = ORDER.map(src).concat(SHARED.map(x => fs.readFileSync(x[1], 'utf8'))).join('\n');
const out = path.join(__dirname, 'dist', 'Collecteur.gs');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, code);
if (require.main === module) console.log(path.relative(process.cwd(), out), code.split('\n').length, 'lignes');
module.exports = { ORDER, SHARED, out };
