import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertLocalProject, assertLocalUrl } from './guard.mjs';
import { API_URL, CLI, LOCAL_DIR, PROJECT_ID, SITE_URL, STAGING_ROOT, ensureLocalDir, localCliEnv, writePrivateJson } from './paths.mjs';

export async function bootstrap() {
  assertLocalProject();
  ensureLocalDir();
  const status = spawnSync(CLI, ['status', '--workdir', STAGING_ROOT, '-o', 'json'], { cwd: STAGING_ROOT, env: localCliEnv(), encoding: 'utf8' });
  if (status.status !== 0) throw new Error('Supabase local indisponible : lancer npm start.');
  let keys;
  try { keys = JSON.parse(status.stdout); } catch { throw new Error('Statut Supabase local illisible.'); }
  assertLocalUrl(keys.API_URL);
  const anonKey = keys.ANON_KEY || keys.PUBLISHABLE_KEY;
  const serviceKey = keys.SERVICE_ROLE_KEY || keys.SECRET_KEY;
  if (!anonKey || !serviceKey) throw new Error('Cles Supabase locales introuvables.');
  const headers = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  const call = async (route, options = {}) => {
    const response = await fetch(API_URL + route, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Initialisation locale : HTTP ' + response.status + ' pour ' + route.split('?')[0]);
    return response.status === 204 ? null : response.json();
  };
  const marker = await call('/rest/v1/params?select=value&key=eq.environment');
  if (marker?.[0]?.value !== 'staging') throw new Error('La base ne porte pas le marqueur staging : initialisation refusee.');
  const credentialsPath = path.join(LOCAL_DIR, 'credentials.json');
  const previous = fs.existsSync(credentialsPath) ? JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) : null;
  const email = 'raphaelsebag71@gmail.com';
  const password = previous?.email === email && previous?.password ? previous.password : randomBytes(24).toString('base64url');
  const listing = await call('/auth/v1/admin/users?page=1&per_page=1000');
  let user = listing.users?.find(item => item.email === email);
  if (!user) {
    user = await call('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name: 'Administrateur staging', environment: 'staging' } }) });
  } else if (!previous || previous.email !== email) {
    await call('/auth/v1/admin/users/' + encodeURIComponent(user.id), { method: 'PUT', body: JSON.stringify({ password, email_confirm: true }) });
  }
  await call('/rest/v1/profiles?user_id=eq.' + encodeURIComponent(user.id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ role: 'admin', name: 'Administrateur staging' }) });
  writePrivateJson('runtime.json', { projectId: PROJECT_ID, supabaseUrl: API_URL, anonKey, serviceKey, createdAt: new Date().toISOString() });
  writePrivateJson('credentials.json', { environment: 'staging-local-only', siteUrl: SITE_URL, email, password, userId: user.id });
  console.log('Supabase local initialise : Auth, PostgreSQL, Storage et Realtime.');
  console.log('Compte administrateur local : staging/.local/credentials.json (fichier prive, ignore par Git).');
  console.log('Interface : ' + SITE_URL + ' | Studio : http://127.0.0.1:57423 | Courriels de test : http://127.0.0.1:57424');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await bootstrap();
