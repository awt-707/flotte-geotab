// Met l'application Android en téléchargement : Ludy.apk dans le seau public « app » de Supabase Storage (comme Ludy.dmg),
// et android.json (version, empreinte SHA-256 du certificat de signature, à recopier dans site/.well-known/assetlinks.json).
// Variables : SUPABASE_URL, SUPABASE_SERVICE_KEY (secret GitHub). Usage : node scripts/publish-apk.js Ludy.apk "AA:BB:…"
const fs = require('fs'), path = require('path');
(async () => {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_KEY, [file, sha] = process.argv.slice(2);
  if (!url || !key) throw new Error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont nécessaires (Settings > Secrets du dépôt GitHub)');
  if (!file || !fs.existsSync(file)) throw new Error((file || 'Ludy.apk') + ' absent');
  if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(sha || '')) throw new Error('empreinte SHA-256 du certificat attendue (AA:BB:…)');
  const h = { apikey: key }; if (!/^sb_/.test(key)) h.Authorization = 'Bearer ' + key;
  const put = async (name, type, body, cache) => {
    const r = await fetch(url + '/storage/v1/object/app/' + name, { method: 'POST', headers: Object.assign({ 'Content-Type': type, 'x-upsert': 'true', 'cache-control': cache }, h), body });
    if (!r.ok) throw new Error(name + ' : ' + r.status + ' ' + await r.text());
  };
  const body = fs.readFileSync(file);
  await put('Ludy.apk', 'application/vnd.android.package-archive', body, '300');
  console.log('Ludy.apk publié (' + Math.round(body.length / 1e5) / 10 + ' Mo) : ' + url + '/storage/v1/object/public/app/Ludy.apk');
  const g = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8');
  const version = (g.match(/versionName '([^']+)'/) || [])[1], code = +(g.match(/versionCode (\d+)/) || [])[1];
  await put('android.json', 'application/json', JSON.stringify({ version, versionCode: code, sha256: sha, at: new Date().toISOString() }), '60');
  console.log('version Android ' + version + ' annoncée, certificat ' + sha);
})().catch(e => { console.error(e.message); process.exit(1); });
