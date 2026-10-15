// Banc de test : faux Google Sheets + faux Geotab au format réel (relevé sur la base clicar)
const vm = require('vm'), fs = require('fs');
let NOW0 = Date.UTC(2026, 9, 6, 9, 0);
class FakeDate extends Date { constructor(...a) { if (a.length === 0) super(NOW0); else super(...a); } static now() { return NOW0; } }
const setNow = t => { NOW0 = t; };
const TZ = 'Africa/Casablanca';
// Heure du Maroc des tests = table du collecteur (MA_TZ, heure réelle UTC+1) quelle que soit la version des fuseaux de Node
const MA_TZ = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'collector', 'src', '05_constants.gs'), 'utf8').match(/const MA_TZ = (\[.*\]);/)[1]);
function maOff(t) { let lo = 0, hi = MA_TZ.length - 1; while (lo < hi) { const k = (lo + hi + 1) >> 1; if (MA_TZ[k][0] <= t) lo = k; else hi = k - 1; } return MA_TZ[lo][1]; }
function parts(d, tz) { if (tz === 'Africa/Casablanca') { d = new Date(d.getTime() + maOff(d.getTime()) * 60000); tz = 'UTC'; }
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); const o = {}; f.formatToParts(d).forEach(p => { o[p.type] = p.value; }); return o; }
const Utilities = { sleep: () => { },
  formatDate(d, tz, pat) { d = new Date(d); const p = parts(d, tz);
    if (pat === 'Z') { const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); const off = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000); const s = off >= 0 ? '+' : '-', a = Math.abs(off); return s + String(Math.floor(a / 60)).padStart(2, '0') + String(a % 60).padStart(2, '0'); }
    return pat.replace(/'([^']*)'/g, '$1').replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute); },
  base64Decode: s => Buffer.from(s, 'base64'), base64DecodeWebSafe: s => Array.from(Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64')), base64Encode: b => Buffer.from(b.map(x => x & 255)).toString('base64'), gzip: bl => ({ getBytes: () => Array.from(require('zlib').gzipSync(Buffer.from(bl.getBytes().map(x => x & 255)))).map(x => x > 127 ? x - 256 : x) }), newBlob: c => ({ getDataAsString: () => Buffer.from(c).toString('utf8'), getBytes: () => c, getAs: () => { pdfs.push(c); return { setName(n) { this.name = n; return this; } }; } })
};
const pdfs = [], toasts = [], mails = [], scriptApi = [];
let scriptApiReply = () => ({ getResponseCode: () => 200, getContentText: () => '{}' });
function chain(extra) { const t = Object.assign({}, extra || {}); const p = new Proxy(t, { get(o, k) { if (k in o) return o[k]; if (k === 'build') return () => ({}); return () => p; } }); return p; }
function a1(ref) { const m = ref.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/); const col = s => s.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); const r = +m[2], c = col(m[1]); return m[3] ? [r, c, +m[4] - r + 1, col(m[3]) - c + 1] : [r, c, 1, 1]; }
class Sheet {
  constructor(n) { this.name = n; this.data = []; this.maxR = 1000; this.maxC = 26; this.charts = []; }
  _get(r, c) { return (this.data[r - 1] && this.data[r - 1][c - 1] !== undefined) ? this.data[r - 1][c - 1] : ''; }
  _set(r, c, v) { if (r > this.maxR) throw new Error(this.name + ' row ' + r + ' > ' + this.maxR); if (c > this.maxC) throw new Error(this.name + ' col ' + c + ' > ' + this.maxC); while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  getName() { return this.name; }
  getRange(a, b, c, d) { if (typeof a === 'string') return new Range(this, ...a1(a)); return new Range(this, a, b, c || 1, d || 1); }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getLastRow() { for (let i = this.data.length; i > 0; i--) if ((this.data[i - 1] || []).some(v => v !== '' && v != null)) return i; return 0; }
  getLastColumn() { let m = 0; this.data.forEach(r => { for (let j = r.length; j > m; j--) if (r[j - 1] !== '' && r[j - 1] != null) { m = j; break; } }); return m; }
  getMaxRows() { return this.maxR; } getMaxColumns() { return this.maxC; }
  insertRowsAfter(a, n) { if (a < this.data.length) this.data.splice(a, 0, ...Array.from({ length: n }, () => [])); this.maxR += n; } insertColumnsAfter(a, n) { this.maxC += n; }
  insertRowAfter(a) { this.data.splice(a, 0, []); this.maxR++; } deleteRows(s, n) { this.data.splice(s - 1, n); this.maxR -= n; }
  getImages() { return []; } insertImage() { return { assignScript() { }, remove() { } }; }
  getCharts() { return this.charts; } removeChart(c) { this.charts = this.charts.filter(x => x !== c); }
  newChart() { return chain({ build: () => ({ chart: 1, getAs: () => ({ getBytes: () => [137, 80, 78, 71] }) }) }); } insertChart(c) { this.charts.push(c); }
  setConditionalFormatRules(r) { this.cf = r; }
}
['hideSheet', 'setTabColor', 'setFrozenRows', 'setFrozenColumns', 'setColumnWidth', 'setRowHeight', 'setHiddenGridlines'].forEach(m => { Sheet.prototype[m] = function () { return this; }; });
class Range {
  constructor(s, r, c, nr, nc) { if (nr < 1 || nc < 1) throw new Error('Bad range ' + s.name + ' ' + [r, c, nr, nc]); Object.assign(this, { s, r, c, nr, nc });
    const px = new Proxy(this, { get(t, k) { if (k in t) { const v = t[k]; return typeof v === 'function' ? (...a) => { const r = v.apply(t, a); return r === t ? px : r; } : v; } return () => px; } }); return px; }
  getSheet() { return this.s; } getRow() { return this.r; } getColumn() { return this.c; } getA1Notation() { const c = n => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }; return c(this.c) + this.r + (this.nr > 1 || this.nc > 1 ? ":" + c(this.c + this.nc - 1) + (this.r + this.nr - 1) : ""); }
  getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.s._get(this.r + i, this.c + j)); o.push(row); } return o; }
  getValue() { return this.s._get(this.r, this.c); }
  setValues(v) { if (v.length !== this.nr || v.some(r => r.length !== this.nc)) throw new Error('setValues dims ' + this.s.name + ' ' + this.nr + 'x' + this.nc + ' vs ' + v.length + 'x' + (v[0] || []).length);
    v.forEach((row, i) => row.forEach((x, j) => { if (x === undefined || x === null || (typeof x === 'number' && !isFinite(x))) throw new Error('Bad value ' + this.s.name + ' r' + (this.r + i) + ' c' + (this.c + j) + ': ' + x); if (x instanceof Date && isNaN(x)) throw new Error('Invalid date ' + this.s.name); this.s._set(this.r + i, this.c + j, x); })); return this; }
  setNumberFormats(f) { if (f.length !== this.nr || f.some(r => r.length !== this.nc)) throw new Error('setNumberFormats dims ' + this.s.name); return this; }
  setValue(x) { this.s._set(this.r, this.c, x); return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) if (this.s.data[this.r + i - 1]) this.s.data[this.r + i - 1][this.c + j - 1] = ''; return this; }
  clear() { return this.clearContent(); }
  sort(spec) { const vals = this.getValues(); const k = spec.column - this.c; vals.sort((a, b) => { const x = a[k], y = b[k]; const d = (x > y) - (x < y); return spec.ascending ? d : -d; }); this.setValues(vals); return this; }
}
class SS { constructor() { this.sheets = []; } getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; } insertSheet(n) { if (this.getSheetByName(n)) throw new Error('dup ' + n); const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; } deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); } toast(m, t) { toasts.push((t || '') + ': ' + m); } setActiveSheet(s) { return s; } moveActiveSheet() { } getUrl() { return 'https://x'; } setSpreadsheetTimeZone() { } }
const main = new SS(); main.insertSheet('Feuille 1');
const parc = new SS(); const ps = parc.insertSheet('Parc Automobile');
ps.data = [['Double', 'N', 'ORG', 'DS', 'A', 'Liv', 'Immatriculation DEFINITIVE', 'Marque', 'Modèle', 'NUM CHASSIS', 'D1', 'IP', 'BA', 'U', 'G', 'TA', 'F', 'Carburant']];
const VEHS = [['WW968194', 'SONATA', 'EH', 'KMHL341JBRA084312'], ['WW968199', 'STARIA', 'GO', 'KMHYC811BTU266920']];
VEHS.forEach(v => ps.data.push(['OUI', '', '', '', '', '', v[0], 'HYUNDAI', v[1], v[3], '', '', '', '', '', '', '', v[2]]));
const stats = { calls: 0, bytes: 0, batches: 0, db: 0, dbms: 0, dbBytes: 0 };
const { execFileSync } = require('child_process');
function dbFetch(url, opt) {
  stats.db++; const t = Date.now();
  const args = ['-s', '-w', '\n%{http_code}', '-X', String(opt.method || 'get').toUpperCase(), url];
  Object.entries(opt.headers || {}).forEach(([k, v]) => args.push('-H', k + ': ' + v));
  if (opt.contentType) args.push('-H', 'Content-Type: ' + opt.contentType);
  if (opt.payload !== undefined) { args.push('--data-binary', '@-'); stats.dbBytes += opt.payload.length; }
  const out = execFileSync('curl', args, { input: opt.payload || '', maxBuffer: 1 << 30 }).toString();
  stats.dbms += Date.now() - t;
  const i = out.lastIndexOf('\n'), body = out.slice(0, i), code = +out.slice(i + 1);
  if (process.env.DBLOG) console.log('DB', opt.method, url.slice(0, 160), code, body.length);
  return { getContentText: () => body, getResponseCode: () => code };
} const books = {}; const props = {}, triggers = [], folders = [], cache = {};
const ctx = vm.createContext({ console, Utilities, Date: FakeDate, Math, JSON,
  SpreadsheetApp: { getActive: () => main, openById: id => (id && books[id]) || parc, create: n => { const b = new SS(); b.name = n; b.id = 'ARCH' + Object.keys(books).length; b.getId = () => b.id; b.getUrl = () => 'https://archive/' + b.id; books[b.id] = b; return b; }, getUi: () => { throw new Error('no ui'); }, newConditionalFormatRule: () => chain(), newDataValidation: () => chain(), InterpolationType: { PERCENTILE: 'P' }, BorderStyle: { SOLID: 1, SOLID_THICK: 2 } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props), setProperties: o => { Object.keys(o).forEach(k => { props[k] = String(o[k]); }); } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() { } }) },
  ScriptApp: { getScriptId: () => 'SCRIPT_ID', getOAuthToken: () => 'tok', getProjectTriggers: () => triggers.slice(), deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); }, newTrigger: fn => chain({ create: () => { const t = { getHandlerFunction: () => fn }; triggers.push(t); return t; } }) },
  MailApp: { sendEmail: o => mails.push(o) }, HtmlService: { createHtmlOutput: () => chain() }, Charts: { ChartType: { LINE: 'L', COLUMN: 'C', BAR: 'B' } },
  DriveApp: { getFoldersByName: n => { const f = folders.filter(x => x.name === n); return { hasNext: () => f.length > 0, next: () => f[0] }; },
    createFolder: n => { const files = []; const f = { name: n, files, createFile: (a, c) => { const x = { name: a.name || a, content: c, trashed: false, getName() { return this.name; }, setTrashed(v) { this.trashed = v; }, getUrl: () => 'https://drive/' + (a.name || a) }; files.push(x); return x; },
      getFiles: () => { const l = files.filter(x => !x.trashed); let k = 0; return { hasNext: () => k < l.length, next: () => l[k++] }; } }; folders.push(f); return f; } },
  CacheService: { getScriptCache: () => ({ get: k => k in cache ? cache[k] : null, put: (k, v) => { cache[k] = v; } }) },
  UrlFetchApp: { fetch: (url, opt) => { if (url.indexOf('script.googleapis.com') >= 0) { scriptApi.push({ url, opt }); return scriptApiReply(url, opt); } if (url.indexOf('/apiv1') < 0) return dbFetch(url, opt); stats.calls++; global.__NOW = NOW0; const req = JSON.parse(opt.payload); const res = require('./geotab_fake.js').handle(req.method, req.params); const txt = JSON.stringify(res); stats.bytes += txt.length; return { getContentText: () => txt, getResponseCode: () => 200 }; }, fetchAll: reqs => { stats.batches++; return reqs.map(r => ctx.UrlFetchApp.fetch(r.url, r)); } }
});
vm.runInContext(fs.readFileSync(process.env.CODE, 'utf8'), ctx, { filename: 'Collecteur.gs' });
module.exports = { scriptApi, setScriptApiReply: f => { scriptApiReply = f; }, folders, triggers, books, stats, ctx, main, toasts, mails, props, pdfs, setNow, run: c => vm.runInContext(c, ctx) };
