import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_URL, LOCAL_DIR, PROJECT_ID, STAGING_ROOT } from './paths.mjs';

export function assertLocalUrl(value) {
  if (value !== API_URL) throw new Error('Staging refuse : seule la base locale http://127.0.0.1:57421 est autorisee.');
}
export function assertLocalProject() {
  const config = fs.readFileSync(path.join(STAGING_ROOT, 'supabase/config.toml'), 'utf8');
  if (!new RegExp('^project_id = "' + PROJECT_ID + '"$', 'm').test(config)) throw new Error('Identifiant du projet staging invalide.');
  for (const port of [57421, 57422, 57423, 57424]) {
    if (!config.includes('port = ' + port)) throw new Error('Ports du staging modifies : verifier la configuration.');
  }
  if (/https:\/\//i.test(config)) throw new Error('Configuration cloud refusee pour le staging local.');
  for (const file of ['supabase/.temp/project-ref', '.supabase/project.json']) {
    if (fs.existsSync(path.join(STAGING_ROOT, file))) throw new Error('Projet cloud lie : demarrage local refuse.');
  }
  for (const key of ['SUPABASE_URL', 'SUPABASE_REST', 'SUPABASE_DB_URL']) {
    if (process.env[key]) throw new Error('Retirer ' + key + ' de l’environnement : le staging utilise sa configuration locale uniquement.');
  }
  return true;
}
export function readRuntime() {
  assertLocalProject();
  const filename = path.join(LOCAL_DIR, 'runtime.json');
  if (!fs.existsSync(filename)) throw new Error('Staging non initialise : lancer npm start dans staging/.');
  const runtime = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (runtime.projectId !== PROJECT_ID) throw new Error('Runtime du mauvais projet.');
  assertLocalUrl(runtime.supabaseUrl);
  if (!runtime.anonKey || !runtime.serviceKey) throw new Error('Cles locales absentes : relancer npm run bootstrap.');
  return runtime;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assertLocalProject();
  console.log('Configuration locale ludy-staging verifiee.');
}
