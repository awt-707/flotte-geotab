// Rejoue les réponses brutes réelles de Geotab (base clicar) capturées le 06/10/2026
const fx = JSON.parse(require('zlib').gunzipSync(require('fs').readFileSync(require('path').join(__dirname, '..', 'fixtures', 'geotab_2026-09-26_10-06.json.gz'))).toString());
const ms = s => Date.parse(s);
const DEV = {}; fx.devices.forEach(d => { DEV[d.id] = { dev: d, wins: [] }; });
fx.data.forEach(w => DEV[w.id].wins.push(w));
const uniq = (arr, key) => { const m = {}; arr.forEach(x => { m[key(x)] = x; }); return Object.values(m); };
function all(id, field) {
  const W = DEV[id] ? DEV[id].wins : [];
  if (field === 'sd') return null;
  return uniq([].concat(...W.map(w => w[field])), x => JSON.stringify(x));
}
function sd(id, diag) {
  const W = DEV[id] ? DEV[id].wins : [];
  const pts = uniq([].concat(...W.map(w => (w.sd[diag] || []))), x => x[0]).sort((a, b) => ms(a[0]) - ms(b[0]));
  return pts;
}
const covered = (id, f, t) => (DEV[id] ? DEV[id].wins : []).some(w => ms(w.f) <= f && ms(w.t) >= t);
const inR = (t, s) => { const x = ms(t); return x >= ms(s.fromDate) && x <= ms(s.toDate); };
function get(p) {
  const s = p.search || {};
  if (p.typeName === 'Device') return fx.devices;
  if (p.typeName === 'Rule') return fx.rules;
  if (p.typeName === 'Diagnostic') return [{ id: s.id, name: s.id }];
  const id = s.deviceSearch && s.deviceSearch.id;
  if (p.typeName === 'DeviceStatusInfo' && !id) return fx.devices.flatMap(d => get({ typeName: 'DeviceStatusInfo', search: { deviceSearch: { id: d.id } } }));   // sans filtre : toute la flotte
  if (p.typeName === 'DeviceStatusInfo') { const L = all(id, 'logs').filter(l => ms(l[0]) <= (global.__NOW || Date.now())).sort((a, b) => ms(a[0]) - ms(b[0])).pop(); return L ? [{ device: { id }, dateTime: L[0], speed: L[1], latitude: L[2], longitude: L[3], isDriving: L[1] > 2, currentStateDuration: '00:12:00', isDeviceCommunicating: true }] : []; }
  switch (p.typeName) {
    case 'Trip': return all(id, 'trips').filter(t => ms(t.stop) >= ms(s.fromDate) && ms(t.start) <= ms(s.toDate));
    case 'ExceptionEvent': return id ? all(id, 'exc').filter(e => inR(e.activeFrom, s))
      : fx.devices.flatMap(d => all(d.id, 'exc').filter(e => ms(e.activeFrom) >= ms(s.fromDate) && ms(e.activeFrom) <= (s.toDate ? ms(s.toDate) : (global.__NOW || Date.now()))).map(e => Object.assign({ device: { id: d.id } }, e)));
    case 'LogRecord': return all(id, 'logs').filter(l => inR(l[0], s)).map(l => ({ dateTime: l[0], speed: l[1], latitude: l[2], longitude: l[3] }));
    // Geotab calcule ses pleins après coup : global.__FILL_DELAY_MS les cache tant qu'ils sont plus récents que ce délai
    case 'FillUp': return all(id, 'fills').filter(f => inR(f.dateTime, s) && ms(f.dateTime) <= (global.__NOW || Date.now()) - (global.__FILL_DELAY_MS || 0));
    case 'StatusData': {
      if (!s.diagnosticSearch) return [];
      const arr = sd(id, s.diagnosticSearch.id);
      const res = arr.filter(x => inR(x[0], s)).map(x => ({ dateTime: x[0], data: x[1] }));
      const prev = arr.filter(x => ms(x[0]) < ms(s.fromDate)).pop();
      if (prev) res.unshift({ dateTime: new Date(ms(s.fromDate)).toISOString(), data: prev[1] });   // point de borne, comme Geotab
      return res;
    }
  }
  return [];
}
function handle(method, params) {
  try {
    if (method === 'Authenticate') return params.password === 'secret' ? { result: { credentials: { sessionId: 'S1', database: 'clicar', userName: 'a' }, path: 'ThisServer' } } : { error: { message: 'Incorrect', errors: [{ name: 'InvalidUserException' }] } };
    if (!params.credentials || params.credentials.sessionId !== 'S1') return { error: { message: 'bad session', errors: [{ name: 'InvalidUserException' }] } };
    if (method === 'Get') return { result: get(params) };
    if (method === 'ExecuteMultiCall' && process.env.LIMIT_ONCE && !global.__lim) { global.__lim = 1; return { error: { message: 'API calls quota exceeded', errors: [{ name: 'OverLimitException' }] } }; }
    if (method === 'ExecuteMultiCall') return { result: params.calls.map(c => get(c.params)) };
    if (method === 'GetRoadMaxSpeeds') { const r = all(params.deviceSearch.id, 'road').filter(x => inR(x[0], params)).map(x => ({ k: x[0], v: x[1] })); return { result: r }; }
    return { error: { message: 'unknown ' + method } };
  } catch (e) { return { error: { message: e.message } }; }
}
module.exports = { handle, covered };
