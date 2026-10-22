// Navigateur de test : bibliothèques du CDN servies depuis node_modules (mêmes versions, épinglées), sans réseau
const path = require('path'), fs = require('fs'), { spawn } = require('child_process'), { chromium } = require('playwright');
const env = require('./env');
const NM = path.join(env.ROOT, 'node_modules');
async function startSite(who) {
  const srv = spawn(process.execPath, [path.join(__dirname, 'site_server.js')], { stdio: 'ignore', env: Object.assign({}, process.env, { WHO: who || 'admin' }) });
  for (let i = 0; i < 50; i++) { try { await fetch('http://localhost:8080/'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  return srv;
}
async function openBrowser(opts) {
  const br = await chromium.launch(env.CHROMIUM ? { executablePath: env.CHROMIUM } : {});
  const ctx = await br.newContext(Object.assign({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR', timezoneId: 'Africa/Casablanca' }, opts || {}));
  await ctx.route(/cdn\.jsdelivr\.net\/npm\//, r => {
    const m = r.request().url().match(/\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/);
    const pkg = m && JSON.parse(fs.readFileSync(path.join(NM, m[1], 'package.json'), 'utf8'));
    if (!m || pkg.version !== m[2]) return r.fulfill({ status: 404, body: 'version ' + (m ? m[2] : '?') + ' absente de node_modules' });
    const f = path.join(NM, m[1], m[3]);
    r.fulfill({ status: 200, contentType: f.endsWith('.css') ? 'text/css' : f.endsWith('.png') ? 'image/png' : 'text/javascript', body: fs.readFileSync(f) });
  });
  // Autocomplétion d'adresses (Photon) : jamais de réseau en test, aucune proposition (les tests qui en ont besoin la simulent eux-mêmes)
  await ctx.route(/photon\.komoot\.io/, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"features":[]}' }));
  // Polices Google (Barlow) servies depuis @fontsource : captures d'écran fidèles sans réseau
  await ctx.route(/fonts\.googleapis\.com/, r => {
    const css = [['barlow', [400, 500, 600, 700]], ['barlow-semi-condensed', [500, 600]]].map(([f, ws]) => ws.map(w =>
      fs.readFileSync(path.join(NM, '@fontsource', f, w + '.css'), 'utf8').replace(/url\(\.\/files\//g, 'url(https://fonts.gstatic.com/fs/' + f + '/')).join('\n')).join('\n');
    r.fulfill({ status: 200, contentType: 'text/css', body: css });
  });
  await ctx.route(/fonts\.gstatic\.com\/fs\//, r => { const m = r.request().url().match(/\/fs\/([^/]+)\/(.+)$/);
    r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(NM, '@fontsource', m[1], 'files', m[2])) }); });
  await ctx.route(/tile\.openstreetmap\.org/, r => r.fulfill({ status: 200, body: '' }));
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push('JS : ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/realtime|websocket|Failed to load resource/i.test(m.text())) errors.push('console : ' + m.text()); });
  return { br, ctx, page, errors };
}
async function login(page, hash) {
  await page.goto('http://localhost:8080/' + (hash || ''));
  await page.fill('#le', 'admin@x'); await page.fill('#lp', 'secret123'); await page.click('#lf button[type=submit]');
  await page.waitForSelector('.side nav');
}
module.exports = { startSite, openBrowser, login };
