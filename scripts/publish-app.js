// Met l'application Ludy (Mac / Windows) en téléchargement : seau public « app » de Supabase Storage (créé au premier passage).
// Variables : SUPABASE_URL, SUPABASE_SERVICE_KEY (secret GitHub). Usage : node scripts/publish-app.js dossier
const fs = require('fs'), path = require('path');
(async () => {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_KEY, dir = process.argv[2] || 'out';
  if (!url || !key) throw new Error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont nécessaires (Settings > Secrets du dépôt GitHub)');
  const h = { apikey: key }; if (!/^sb_/.test(key)) h.Authorization = 'Bearer ' + key;
  // seau public, 50 Mo max par fichier (limite du plan gratuit) ; déjà créé : réponse 400/409 ignorée
  const b = await fetch(url + '/storage/v1/bucket', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h),
    body: JSON.stringify({ id: 'app', name: 'app', public: true, file_size_limit: 52428800 }) });
  if (!b.ok && ![400, 409].includes(b.status)) throw new Error('seau app : ' + b.status + ' ' + await b.text());
  const files = { 'Ludy.dmg': 'application/x-apple-diskimage', 'Ludy-setup.exe': 'application/vnd.microsoft.portable-executable' };
  for (const [name, type] of Object.entries(files)) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) throw new Error(f + ' absent');
    const body = fs.readFileSync(f);
    const r = await fetch(url + '/storage/v1/object/app/' + name, { method: 'POST', headers: Object.assign({ 'Content-Type': type, 'x-upsert': 'true', 'cache-control': '300' }, h), body });
    if (!r.ok) throw new Error(name + ' : ' + r.status + ' ' + await r.text());
    console.log(name + ' publié (' + Math.round(body.length / 1e5) / 10 + ' Mo) : ' + url + '/storage/v1/object/public/app/' + name);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
