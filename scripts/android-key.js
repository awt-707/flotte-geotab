// Clé de signature de l'application Android : gardée dans le seau privé « app-keys » de Supabase Storage (jamais dans le dépôt),
// pour signer chaque version avec la même clé (sinon Android refuse d'installer la mise à jour par-dessus l'ancienne).
// Usage : node scripts/android-key.js fetch <fichier>   (code 2 = aucune clé enregistrée)
//         node scripts/android-key.js store <fichier>   (première fois seulement : une clé enregistrée n'est jamais remplacée)
// Variables : SUPABASE_URL, SUPABASE_SERVICE_KEY (secret GitHub).
const fs = require('fs');
const NAME = 'ludy-android.jks';
(async () => {
  const [cmd, file] = process.argv.slice(2), url = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !file || !['fetch', 'store'].includes(cmd)) throw new Error('usage : android-key.js fetch|store <fichier> (SUPABASE_URL, SUPABASE_SERVICE_KEY)');
  const h = { apikey: key }; if (!/^sb_/.test(key)) h.Authorization = 'Bearer ' + key;
  if (cmd === 'fetch') {
    const r = await fetch(url + '/storage/v1/object/app-keys/' + NAME, { headers: h });
    if (r.ok) { fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); console.log('clé de signature reprise'); return; }
    const t = await r.text();
    // seulement « absente » (seau ou fichier introuvable) : toute autre erreur arrête la fabrication (jamais une nouvelle clé par erreur)
    if (r.status === 404 || (r.status === 400 && /not.?found/i.test(t))) { console.log('aucune clé de signature enregistrée'); process.exit(2); }
    throw new Error('lecture de la clé : ' + r.status + ' ' + t.slice(0, 200));
  }
  const b = await fetch(url + '/storage/v1/bucket', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h),
    body: JSON.stringify({ id: 'app-keys', name: 'app-keys', public: false }) });
  if (!b.ok && ![400, 409].includes(b.status)) throw new Error('seau app-keys : ' + b.status + ' ' + await b.text());
  const r = await fetch(url + '/storage/v1/object/app-keys/' + NAME, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, h), body: fs.readFileSync(file) });
  if (!r.ok) throw new Error('enregistrement de la clé (déjà enregistrée ?) : ' + r.status + ' ' + (await r.text()).slice(0, 200));
  console.log('clé de signature enregistrée');
})().catch(e => { console.error(e.message); process.exit(1); });
