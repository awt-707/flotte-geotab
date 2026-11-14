#!/usr/bin/env node
// Copie des fichiers stockés (seaux manifestes, devis, plannings, contrats, rh, caisse, app, app-keys) d'un Supabase vers un autre
// (Supabase auto-hébergé sur OVH, même API de stockage). Les fichiers déjà présents à la cible sont gardés (pas d'écrasement).
//   SOURCE_URL=https://<ref>.supabase.co SOURCE_KEY=<clé service_role> CIBLE_URL=https://<nouveau> CIBLE_KEY=<clé service_role> node database/ovh/copie_fichiers.js
// Les clés service_role donnent tous les droits : à passer en variables d'environnement, jamais dans un fichier du dépôt.
'use strict';
const { SOURCE_URL, SOURCE_KEY, CIBLE_URL, CIBLE_KEY } = process.env;
if (!SOURCE_URL || !SOURCE_KEY || !CIBLE_URL || !CIBLE_KEY) { console.error('SOURCE_URL, SOURCE_KEY, CIBLE_URL et CIBLE_KEY sont requis'); process.exit(2); }
const h = k => ({ apikey: k, Authorization: 'Bearer ' + k });
async function api(base, key, p, opt = {}) {
  const r = await fetch(base.replace(/\/$/, '') + '/storage/v1/' + p, { ...opt, headers: { ...h(key), ...(opt.headers || {}) } });
  if (!r.ok && r.status !== 409) throw new Error(`${p} : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}
async function list(bucket, prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await api(SOURCE_URL, SOURCE_KEY, 'object/list/' + bucket, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) });
    const rows = await r.json();
    for (const x of rows) {
      const p = prefix ? prefix + '/' + x.name : x.name;
      if (x.id === null) out.push(...await list(bucket, p)); else out.push(p);   // id vide = dossier
    }
    if (rows.length < 1000) return out;
  }
}
(async () => {
  const buckets = await (await api(SOURCE_URL, SOURCE_KEY, 'bucket')).json();
  let n = 0, kept = 0;
  for (const b of buckets) {
    await api(CIBLE_URL, CIBLE_KEY, 'bucket', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: b.id, name: b.name, public: b.public, file_size_limit: b.file_size_limit, allowed_mime_types: b.allowed_mime_types }) });
    const files = await list(b.id, '');
    for (const f of files) {
      const src = await api(SOURCE_URL, SOURCE_KEY, `object/${b.id}/${f.split('/').map(encodeURIComponent).join('/')}`);
      const r = await api(CIBLE_URL, CIBLE_KEY, `object/${b.id}/${f.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', headers: { 'Content-Type': src.headers.get('content-type') || 'application/octet-stream', 'x-upsert': 'false' }, body: Buffer.from(await src.arrayBuffer()) });
      if (r.status === 409) kept++; else n++;
    }
    console.log(`${b.id} : ${files.length} fichiers`);
  }
  console.log(`${n} fichiers copiés, ${kept} déjà présents`);
})().catch(e => { console.error(e.message); process.exit(1); });
