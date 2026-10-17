// Mise en téléchargement de l'application Ludy (scripts/publish-app.js) : seau public créé, fichiers envoyés, clé jamais en clair ailleurs
const test = require('node:test'), assert = require('node:assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');

test('application : seau « app » public créé (ou déjà là), Ludy.dmg et Ludy-setup.exe envoyés avec la clé de service', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { let n = 0; req.on('data', c => { n += c.length; }); req.on('end', () => {
    seen.push({ m: req.method, u: req.url, key: req.headers.apikey, auth: req.headers.authorization, upsert: req.headers['x-upsert'], type: req.headers['content-type'], n });
    if (req.url === '/storage/v1/bucket') { res.writeHead(409); res.end('{"error":"Duplicate"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"Key":"ok"}'); }); });
  await new Promise(r => srv.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-')); fs.writeFileSync(path.join(dir, 'Ludy.dmg'), Buffer.alloc(3000)); fs.writeFileSync(path.join(dir, 'Ludy-setup.exe'), Buffer.alloc(2000));
  try {
    const out = await new Promise((ok, ko) => execFile('node', ['scripts/publish-app.js', dir], { env: Object.assign({}, process.env, { SUPABASE_URL: 'http://localhost:' + srv.address().port, SUPABASE_SERVICE_KEY: 'sb_secret_' + '-faux' }) },
      (e, so, se) => e ? ko(new Error(se || e.message)) : ok(so)));
    assert.match(out, /Ludy\.dmg publié/); assert.match(out, /Ludy-setup\.exe publié/);
    assert.deepStrictEqual(seen.map(s => s.m + ' ' + s.u), ['POST /storage/v1/bucket', 'POST /storage/v1/object/app/Ludy.dmg', 'POST /storage/v1/object/app/Ludy-setup.exe', 'POST /storage/v1/object/app/version.json']);
    assert.match(out, new RegExp('version ' + require('../desktop/src-tauri/tauri.conf.json').version.replace(/\./g, '\\.') + ' annoncée'));
    assert.ok(seen.every(s => s.key === 'sb_secret_-faux' && !s.auth), 'nouvelle clé sb_… : en-tête apikey seul');
    assert.deepStrictEqual(seen.slice(1, 3).map(s => [s.upsert, s.n]), [['true', 3000], ['true', 2000]]);
    assert.strictEqual(seen[1].type, 'application/x-apple-diskimage');
  } finally { srv.close(); }
});
