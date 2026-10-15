// Publie la version testée du collecteur dans la table « releases » (appelé par GitHub Actions après tests réussis).
// Le collecteur Apps Script l'installe tout seul au passage suivant.
// Variables : SUPABASE_URL, SUPABASE_SERVICE_KEY (secret GitHub), GITHUB_SHA ; SUPABASE_REST_PATH (tests uniquement).
const fs = require('fs'), path = require('path');
async function main() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_KEY, rest = process.env.SUPABASE_REST_PATH || '/rest/v1/';
  if (!url || !key) throw new Error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont nécessaires (Settings > Secrets du dépôt GitHub)');
  const sha = (process.env.GITHUB_SHA || require('child_process').execSync('git rev-parse HEAD').toString()).trim().slice(0, 12);
  const dir = path.join(__dirname, '..', 'collector', 'src');
  const files = fs.readdirSync(dir).filter(f => /\.(gs|json)$/.test(f)).sort().map(f => ({
    name: f.replace(/\.(gs|json)$/, ''), type: f.endsWith('.json') ? 'JSON' : 'SERVER_JS', source: fs.readFileSync(path.join(dir, f), 'utf8') }));
  require(path.join(__dirname, '..', 'collector', 'build.js')).SHARED.forEach(([name, file]) => files.push({ name, type: 'SERVER_JS', source: fs.readFileSync(file, 'utf8') }));
  const version = new Date().toISOString().slice(0, 10) + '.' + sha.slice(0, 7);
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' };
  if (!/^sb_/.test(key)) headers.Authorization = 'Bearer ' + key;
  const r = await fetch(url + rest + 'releases?on_conflict=sha', { method: 'POST', headers, body: JSON.stringify([{ version, sha, files }]) });
  if (!r.ok) throw new Error('Publication refusée : HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  console.log('Collecteur publié : version ' + version + ' (' + files.length + ' fichiers)');
}
main().catch(e => { console.error(e.message); process.exit(1); });
