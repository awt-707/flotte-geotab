// Serveur de test : site statique + API locale imitant Supabase (/rest/v1 -> PostgREST, /auth/v1 -> connexion simulée)
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'site'), PORT = +process.env.PORT || 8080;
const ADMIN = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@x', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' };
const TOKEN = fs.readFileSync(path.join(__dirname, (process.env.WHO || 'admin') + '.jwt'), 'utf8').trim();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
  if (u.pathname.startsWith('/realtime/')) { res.statusCode = 404; return res.end(); }
  let f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
  if (u.pathname === '/config.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(`window.FLOTTE_CONFIG = { SUPABASE_URL: 'http://localhost:${PORT}', SUPABASE_ANON_KEY: 'anon' };`); }
  fs.readFile(f, (e, d) => { if (e) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream'); res.end(d); });
}).listen(PORT, () => console.log('site test sur', PORT));
