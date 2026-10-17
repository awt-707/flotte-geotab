// Serveur de test : site statique + API locale imitant Supabase (/rest/v1 -> PostgREST, /auth/v1 -> connexion simulée)
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'site'), PORT = +process.env.PORT || 8080;
const ADMIN = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@x', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' };
const TOKEN = fs.readFileSync(path.join(__dirname, (process.env.WHO || 'admin') + '.jwt'), 'utf8').trim();
// Utilisateur connecté = celui du jeton (admin@x ou new@x)
const SUB = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url').toString()).sub;
if (SUB !== ADMIN.id) Object.assign(ADMIN, { id: SUB, email: 'new@x' });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
// Faux Supabase Storage (en mémoire) : dépôt d'un fichier, lien signé, lecture (site et collecteur)
const STORE = new Map();
// En-têtes de sécurité de production (site/_headers), avec l'adresse Supabase remplacée par ce serveur de test
const HEADERS = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split('\n/').shift().split('\n').slice(1).map(l => l.trim()).filter(Boolean)
  .map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim().replace(/https:\/\/cgiiwumbblimvmrypxlc\.supabase\.co/g, 'http://localhost:' + PORT).replace(/wss:\/\/cgiiwumbblimvmrypxlc\.supabase\.co/g, 'ws://localhost:' + PORT)]);
http.createServer((req, res) => {
  HEADERS.forEach(([k, v]) => { if (k !== 'Strict-Transport-Security') res.setHeader(k, v); });
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/auth/v1/')) {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (u.pathname === '/auth/v1/token') return res.end(JSON.stringify({ access_token: TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: ADMIN }));
      if (u.pathname === '/auth/v1/user') return res.end(JSON.stringify(ADMIN));
      if (u.pathname === '/auth/v1/logout') { res.statusCode = 204; return res.end(); }
      res.end('{}');
    }); return;
  }
  if (u.pathname.startsWith('/rest/v1/')) {
    const h = Object.assign({}, req.headers); delete h.host; delete h.apikey;
    const p = http.request({ host: 'localhost', port: 3001, path: req.url.replace('/rest/v1', ''), method: req.method, headers: h }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(p); return;
  }
  // Relais Geotab en direct : la vraie fonction (supabase/functions/geotab-live/live.mjs) branchée sur le faux Geotab ;
  // l'horloge du faux Geotab avance d'une minute à chaque appel (les véhicules roulent sur leurs vraies traces)
  if (u.pathname === '/functions/v1/geotab-live') { liveCall(req, res); return; }
  if (u.pathname.startsWith('/realtime/')) { res.statusCode = 404; return res.end(); }
  if (u.pathname.startsWith('/storage/v1/')) { storage(req, res, u); return; }
  let f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
  if (u.pathname === '/config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(`window.FLOTTE_CONFIG = { SUPABASE_URL: 'http://localhost:${PORT}', SUPABASE_ANON_KEY: 'anon' };`); }
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(PORT, () => console.log('site test sur', PORT));

let LIVE_T = Date.parse(process.env.LIVE_START || '2026-10-03T12:20:00Z');
async function liveCall(req, res) {
  if (process.env.LIVE_OFF) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end('{"code":"NOT_FOUND","message":"Requested function was not found"}'); }
  const { handle, resetMemory } = await import('../../supabase/functions/geotab-live/live.mjs'), geo = require('./geotab_fake');
  resetMemory(); LIVE_T += 60000; global.__NOW = LIVE_T;
  const fetchFn = async (url, opt) => {
    if (/geotab\.com\/apiv1$/.test(url)) { const b = JSON.parse(opt.body), p = b.params;
      if (b.method === 'Authenticate') p.password = 'secret';
      if (b.method === 'ExecuteMultiCall') p.calls.forEach(c => { const s = c.params.search; if (s && s.fromDate === s.toDate && s.diagnosticSearch && s.diagnosticSearch.id === 'DiagnosticIgnitionId') s.fromDate = s.toDate = new Date(LIVE_T).toISOString(); });
      return new Response(JSON.stringify(geo.handle(b.method, p))); }
    return fetch(url, opt);
  };
  const env = { SUPABASE_REST: 'http://localhost:3001', SUPABASE_ANON_KEY: 'anon', GEO_USER: 'a', GEO_PWD: 'x' };
  const r = await handle(new Request('http://x' + req.url, { method: req.method, headers: { authorization: req.headers.authorization || '' } }), { env: k => env[k], fetch: fetchFn, now: () => LIVE_T });
  res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(await r.text());
}

function storage(req, res, u) {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks), p = decodeURIComponent(u.pathname.replace(/^\/storage\/v1\/object\//, ''));
    res.setHeader('Content-Type', 'application/json');
    if (process.env.STORAGE_OFF) { res.statusCode = 400; return res.end('{"statusCode":"404","error":"Bucket not found","message":"Bucket not found"}'); }
    if (req.method === 'POST' && p.startsWith('sign/')) {
      const k = p.slice(5); if (!STORE.has(k)) { res.statusCode = 400; return res.end('{"error":"not_found","message":"Object not found"}'); }
      return res.end(JSON.stringify({ signedURL: '/object/sign/' + k + '?token=jeton-' + JSON.parse(body.toString() || '{}').expiresIn }));
    }
    if (req.method === 'POST') {   // dépôt (multipart du client Supabase) : le PDF lui-même
      const a = body.indexOf('%PDF-'), e = body.lastIndexOf('%%EOF');
      if (a < 0 || e < 0 || STORE.has(p)) { res.statusCode = 400; return res.end('{"error":"invalid","message":"refusé"}'); }
      STORE.set(p, body.slice(a, e + 5)); return res.end(JSON.stringify({ Key: p, Id: 'x' }));
    }
    const k = p.replace(/^sign\//, ''), f = STORE.get(k);
    if (!f || (p.startsWith('sign/') && !/^jeton-/.test(u.searchParams.get('token') || '')) || (!p.startsWith('sign/') && !/Bearer \S/.test(req.headers.authorization || ''))) { res.statusCode = 400; return res.end('{"error":"not_found"}'); }
    res.setHeader('Content-Type', 'application/pdf'); res.end(f);
  });
}
