import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readRuntime } from './guard.mjs';
import { LOCAL_DIR, SITE_URL, ensureLocalDir, writePrivateJson } from './paths.mjs';

export const SHARE_PORT = 4174;
export function quickTunnelOrigin(text) {
  return String(text).match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s|]|$)/)?.[0] || null;
}
export function tunnelEnvironment(env = process.env) {
  // Inherit only the OS settings needed by cloudflared, never provider keys or
  // an existing tunnel's configuration, token, proxy or debug logging settings.
  const keep = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return Object.fromEntries(keep.filter(key => env[key]).map(key => [key, env[key]]));
}
export function tunnelArguments(configPath) {
  return ['tunnel', '--config', configPath, '--no-autoupdate', '--url', 'http://127.0.0.1:' + SHARE_PORT,
    '--metrics', '127.0.0.1:0', '--loglevel', 'info', '--transport-loglevel', 'warn'];
}
export async function checkShare() {
  const runtime = readRuntime();
  const health = await fetch(SITE_URL + '/health', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const marker = await health.json();
  if (!health.ok || marker.environment !== 'staging' || marker.project !== 'ludy-staging') throw Error('Démarrez Ludy staging avec npm --prefix staging start.');
  const response = await fetch(runtime.supabaseUrl + '/rest/v1/params?select=value&key=eq.environment', {
    headers: { apikey: runtime.serviceKey, Authorization: 'Bearer ' + runtime.serviceKey }, redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  if (!response.ok || (await response.json())?.[0]?.value !== 'staging') throw Error('La base locale ne porte pas le marqueur staging.');
  const version = spawnSync('cloudflared', ['--version'], { encoding: 'utf8', env: tunnelEnvironment(), timeout: 5000 });
  if (version.status !== 0 || !/cloudflared version \d/.test(version.stdout || '')) throw Error('cloudflared manque : https://developers.cloudflare.com/tunnel/downloads/');
  return runtime;
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('npm --prefix staging run share [-- --check]\n--check : vérifie le staging local et cloudflared, sans ouvrir de lien.\nSans option : ouvre un lien HTTPS temporaire protégé, jusqu’à Ctrl+C.\nLe lien et son code sont conservés dans staging/.local/share-access.json.\nChaque testeur doit aussi avoir son propre compte Ludy (npm --prefix staging run tester:create -- --help).');
    return;
  }
  if (args.length && !(args.length === 1 && args[0] === '--check')) throw Error('Option inconnue. Utilisez --help.');
  const runtime = await checkShare();
  if (args[0] === '--check') { console.log('Staging local et cloudflared prêts. Aucun lien Internet ouvert.'); return; }
  const { createShareGateway } = await import('../server/share-gateway.mjs');
  ensureLocalDir();
  const directory = path.join(LOCAL_DIR, 'share');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Dossier de partage invalide.');
  fs.chmodSync(directory, 0o700);
  const configPath = path.join(directory, 'cloudflared.yml');
  if (fs.existsSync(configPath) && fs.lstatSync(configPath).isSymbolicLink()) throw Error('Configuration de partage invalide.');
  fs.writeFileSync(configPath, '{}\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  const accessCode = randomBytes(24).toString('base64url');
  const gateway = createShareGateway({ accessCode, anonKey: runtime.anonKey, referenceData: fs.existsSync(path.join(LOCAL_DIR, 'reference-import.json')) ? 'snapshot' : 'synthetic' });
  let tunnel, publicOrigin, stopped = false, stopping;
  const accessFile = path.join(LOCAL_DIR, 'share-access.json');
  const shutdown = () => {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      // Close the gateway first: an orphan cloudflared process cannot serve data.
      await gateway.close();
      if (tunnel && tunnel.exitCode === null) {
        tunnel.kill('SIGTERM');
        const exited = new Promise(resolve => tunnel.once('exit', resolve));
        let timer;
        await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 4000); })]);
        clearTimeout(timer);
        if (tunnel.exitCode === null) tunnel.kill('SIGKILL');
      }
      if (publicOrigin) writePrivateJson('share-access.json', { active: false, url: publicOrigin, stoppedAt: new Date().toISOString() });
    })();
    return stopping;
  };
  const onSignal = () => { void shutdown(); };
  try {
    await new Promise((resolve, reject) => {
      gateway.server.once('error', reject);
      gateway.server.listen(SHARE_PORT, '127.0.0.1', resolve);
    }).catch(error => { throw Error(error.code === 'EADDRINUSE' ? 'Un partage utilise déjà le port 4174. Arrêtez son terminal avec Ctrl+C.' : 'Impossible de démarrer la passerelle locale.'); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, onSignal);
    console.log('Ouverture d’un lien de test temporaire. Le PC et Ludy doivent rester allumés.');
    tunnel = spawn('cloudflared', tunnelArguments(configPath), { env: tunnelEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    const created = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Le tunnel n’a pas fourni de lien sous 45 secondes. Réessayez après vérification du réseau.')), 45000);
      tunnel.once('error', () => { clearTimeout(timeout); reject(Error('cloudflared ne démarre pas.')); });
      tunnel.once('exit', () => { clearTimeout(timeout); if (!publicOrigin) reject(Error(stopped ? 'Partage arrêté.' : 'Le tunnel s’est arrêté avant son ouverture.')); });
      const read = chunk => {
        buffer = (buffer + chunk.toString()).slice(-16384);
        const origin = quickTunnelOrigin(buffer);
        if (!origin || publicOrigin || stopped) return;
        try {
          gateway.setPublicOrigin(origin);
          publicOrigin = origin;
          writePrivateJson('share-access.json', { active: true, url: origin, inviteUrl: origin + '/#access=' + encodeURIComponent(accessCode), accessCode, createdAt: new Date().toISOString() });
          clearTimeout(timeout);
          resolve(origin);
        } catch { clearTimeout(timeout); reject(Error('Impossible d’enregistrer le lien de partage privé.')); }
      };
      tunnel.stdout.on('data', read); tunnel.stderr.on('data', read);
    });
    const exited = new Promise(resolve => tunnel.once('exit', (code, signal) => resolve({ code, signal })));
    let url;
    try { url = await created; } catch (error) { if (stopped) return; throw error; }
    console.log('Lien de test : ' + url);
    console.log('Code d’accès : ouvrez ' + accessFile + '. Transmettez-le uniquement aux testeurs choisis.');
    console.log('Après le code, chaque testeur se connecte avec son compte Ludy. Ctrl+C coupe le partage.');
    const result = await exited;
    if (!stopped && result.code !== 0) throw Error('Le tunnel a été interrompu. Relancez le partage pour obtenir un nouveau lien.');
  } finally {
    await shutdown();
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message || 'Partage indisponible.'); process.exitCode = 1; });
}
