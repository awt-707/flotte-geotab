import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { assertLocalProject } from './guard.mjs';
import { CLI, LOCAL_DIR, PROJECT_ID, STAGING_ROOT, ensureLocalDir, localCliEnv } from './paths.mjs';

assertLocalProject();
ensureLocalDir();
if (!fs.existsSync(CLI)) throw new Error('CLI absent : executer npm ci dans staging/.');
const inspect = spawnSync('docker', ['network', 'inspect', PROJECT_ID], { encoding: 'utf8' });
if (inspect.status !== 0) {
  const create = spawnSync('docker', ['network', 'create', '--label', 'ludy.environment=staging', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', PROJECT_ID], { encoding: 'utf8' });
  if (create.status !== 0) throw new Error('Docker indisponible ou creation du reseau local impossible. Verifier que Docker fonctionne.');
} else {
  const network = JSON.parse(inspect.stdout)[0];
  if (network.Options?.['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1') throw new Error('Le reseau ludy-staging existant ne limite pas les ports a la boucle locale.');
}
console.log('Demarrage de Supabase local ludy-staging (premier lancement : telechargement des images Docker).');
const logPath = path.join(LOCAL_DIR, 'supabase-start.log');
const log = fs.openSync(logPath, 'w', 0o600);
fs.chmodSync(logPath, 0o600);
const child = spawn(CLI, ['start', '--workdir', STAGING_ROOT, '--network-id', PROJECT_ID, '--yes'], { cwd: STAGING_ROOT, env: localCliEnv(), stdio: ['ignore', log, log] });
const timer = setInterval(() => console.log('Supabase local : demarrage en cours, journal dans staging/.local/supabase-start.log.'), 30000);
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
clearInterval(timer);
fs.closeSync(log);
if (code !== 0) throw new Error('Supabase local n’a pas demarre. Consulter staging/.local/supabase-start.log (aucune base cloud contactée).');
const { bootstrap } = await import('./bootstrap.mjs');
await bootstrap();
const { migrateLocal } = await import('./migrate-local.mjs');
migrateLocal();
if (!process.argv.includes('--no-serve')) await import('./serve.mjs');
