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

test('Android : Ludy.apk et android.json (version, empreinte du certificat) envoyés dans le seau « app »', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { const b = []; req.on('data', c => b.push(c)); req.on('end', () => {
    seen.push({ m: req.method, u: req.url, key: req.headers.apikey, upsert: req.headers['x-upsert'], type: req.headers['content-type'], body: Buffer.concat(b) });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"Key":"ok"}'); }); });
  await new Promise(r => srv.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-')), apk = path.join(dir, 'Ludy.apk'); fs.writeFileSync(apk, Buffer.alloc(4000));
  const sha = Array.from({ length: 32 }, (x, i) => ('0' + (i * 7 % 256).toString(16).toUpperCase()).slice(-2)).join(':');
  const run = args => new Promise((ok, ko) => execFile('node', ['scripts/publish-apk.js'].concat(args), { env: Object.assign({}, process.env, { SUPABASE_URL: 'http://localhost:' + srv.address().port, SUPABASE_SERVICE_KEY: 'sb_secret_' + '-faux' }) },
    (e, so, se) => e ? ko(new Error(se || e.message)) : ok(so)));
  try {
    await assert.rejects(run([apk, 'pas-une-empreinte']), /empreinte SHA-256/);
    const out = await run([apk, sha]);
    assert.match(out, /Ludy\.apk publié/);
    assert.deepStrictEqual(seen.map(s => s.m + ' ' + s.u + ' ' + s.type), ['POST /storage/v1/object/app/Ludy.apk application/vnd.android.package-archive', 'POST /storage/v1/object/app/android.json application/json']);
    assert.ok(seen.every(s => s.key === 'sb_secret_-faux' && s.upsert === 'true'));
    const j = JSON.parse(seen[1].body.toString());
    const gv = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8');
    assert.deepStrictEqual([j.version, j.versionCode, j.sha256], [gv.match(/versionName '([^']+)'/)[1], +gv.match(/versionCode (\d+)/)[1], sha]);
  } finally { srv.close(); }
});

test('Android : clé de signature jamais remplacée (fetch : code 2 seulement si absente ; store sans écrasement)', async () => {
  const seen = []; let has = false;
  const srv = http.createServer((req, res) => { const b = []; req.on('data', c => b.push(c)); req.on('end', () => {
    seen.push(req.method + ' ' + req.url + (req.headers['x-upsert'] ? ' upsert' : ''));
    if (req.url === '/storage/v1/bucket') { res.writeHead(409); res.end('{}'); return; }
    if (req.method === 'GET') { if (has) { res.writeHead(200); res.end('CLE'); } else { res.writeHead(400); res.end('{"statusCode":"404","error":"not_found","message":"Object not found"}'); } return; }
    has = true; res.writeHead(200); res.end('{"Key":"ok"}'); }); });
  await new Promise(r => srv.listen(0, r));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'key-')), 'k.jks'); fs.writeFileSync(f, 'CLE');
  const run = args => new Promise(ok => execFile('node', ['scripts/android-key.js'].concat(args), { env: Object.assign({}, process.env, { SUPABASE_URL: 'http://localhost:' + srv.address().port, SUPABASE_SERVICE_KEY: 'sb_secret_' + '-faux' }) },
    (e, so) => ok({ code: e ? e.code : 0, out: so })));
  try {
    assert.strictEqual((await run(['fetch', f])).code, 2, 'aucune clé : code 2');
    assert.strictEqual((await run(['store', f])).code, 0);
    const g = await run(['fetch', f]); assert.strictEqual(g.code, 0); assert.match(g.out, /reprise/);
    assert.ok(!seen.some(s => / upsert$/.test(s)), 'jamais d\'écrasement');
  } finally { srv.close(); }
});

test('écran d\'accueil (iPhone, Android) : manifeste, icônes et balises de la page', () => {
  const site = path.join(__dirname, '..', 'site'), m = JSON.parse(fs.readFileSync(path.join(site, 'manifest.webmanifest'), 'utf8'));
  assert.deepStrictEqual([m.short_name, m.display, m.start_url], ['Ludy', 'standalone', '/']);
  m.icons.forEach(i => assert.ok(fs.existsSync(path.join(site, i.src)), i.src));
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  ['rel="manifest" href="manifest.webmanifest"', 'rel="apple-touch-icon" href="icon-180.png"', 'apple-mobile-web-app-capable'].forEach(t => assert.ok(html.includes(t), t));
  assert.ok(fs.existsSync(path.join(site, 'icon-180.png')));
});

test('Android : lien site ↔ application (assetlinks.json) pour le paquet et un certificat SHA-256', () => {
  const a = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'site', '.well-known', 'assetlinks.json'), 'utf8'));
  const g = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8');
  assert.strictEqual(a[0].target.package_name, g.match(/applicationId '([^']+)'/)[1]);
  assert.ok(a[0].target.sha256_cert_fingerprints.every(f => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f)));
  assert.deepStrictEqual(a[0].relation, ['delegate_permission/common.handle_all_urls']);
});

test('Android 1.1 : vue web de l\'application (sans Chrome), liens externes, fichiers à joindre, PDF enregistrés', () => {
  const a = p => fs.readFileSync(path.join(__dirname, '..', 'android', p), 'utf8');
  const java = a('app/src/main/java/com/ludy/flotte/MainActivity.java'), man = a('app/src/main/AndroidManifest.xml'), g = a('app/build.gradle');
  assert.match(java, /HOME = "https:\/\/ludy-flotte\.pages\.dev\/"/);
  assert.match(java, /onShowFileChooser/, 'justificatifs, reçus, fiches : choix d\'un fichier');
  assert.match(java, /url\.startsWith\("blob:"\)/, 'PDF créés par le site enregistrés');
  assert.match(java, /HOST\.equals\(u\.getHost\(\)\)/, 'liens hors du site ouverts par le téléphone');
  assert.match(man, /android:name="\.MainActivity" android:exported="true"/);
  assert.doesNotMatch(g, /androidbrowserhelper/, 'plus de dépendance à Chrome');
  assert.ok(+g.match(/versionCode (\d+)/)[1] >= 2);
});

test('Android 1.2 : PDF (manifeste, devis) envoyés tels quels dans WhatsApp au numéro donné, fichier servi sans bibliothèque', () => {
  const a = p => fs.readFileSync(path.join(__dirname, '..', 'android', p), 'utf8');
  const java = a('app/src/main/java/com/ludy/flotte/MainActivity.java'), prov = a('app/src/main/java/com/ludy/flotte/FilesProvider.java'), man = a('app/src/main/AndroidManifest.xml'), g = a('app/build.gradle');
  assert.match(java, /@JavascriptInterface public void share\(String b64, String name, String mime, String text, String phone\)/);
  assert.match(java, /"com\.whatsapp", "com\.whatsapp\.w4b"/); assert.match(java, /putExtra\("jid", digits \+ "@s\.whatsapp\.net"\)/);
  assert.match(java, /FLAG_GRANT_READ_URI_PERMISSION/); assert.match(java, /LudyAndroid\/1\.[2-9]/);
  assert.match(prov, /contains\("\.\."\)/, 'aucun fichier hors du dossier de partage');
  assert.match(prov, /lecture seule/);
  assert.match(man, /android:name="\.FilesProvider" android:authorities="com\.ludy\.flotte\.files" android:exported="false" android:grantUriPermissions="true"/);
  assert.match(man, /<package android:name="com\.whatsapp" \/>/);
  assert.ok(+g.match(/versionName '1\.(\d+)'/)[1] >= 2); assert.ok(+g.match(/versionCode (\d+)/)[1] >= 3);
});
