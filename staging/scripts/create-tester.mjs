import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readRuntime } from './guard.mjs';
import { LOCAL_DIR, ensureLocalDir } from './paths.mjs';

export function testerOptions(args) {
  const options = { agencies: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--all-agencies' && !options.all) options.all = true;
    else if (key === '--email' && !options.email && args[i + 1]) options.email = args[++i].trim().toLowerCase();
    else if (key === '--agency' && /^\d+$/.test(args[i + 1] || '')) options.agencies.push(Number(args[++i]));
    else if (key === '--disable' && !options.disable && args[i + 1]) options.disable = args[++i];
    else throw Error('Option invalide. Utilisez --help.');
  }
  if (options.disable) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(options.disable) || options.email || options.all || options.agencies.length) throw Error('Utilisez uniquement --disable suivi de l’identifiant du testeur.');
    return options;
  }
  if (!options.email || options.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email)) throw Error('Une adresse e-mail valide est requise.');
  if (options.all === Boolean(options.agencies.length) || (!options.all && !options.agencies.length) || options.agencies.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error('Choisissez --all-agencies ou un ou plusieurs --agency ID.');
  options.agencies = [...new Set(options.agencies)];
  return options;
}

export async function createTester({ options, runtime, fetchFn = fetch, save }) {
  if (runtime.supabaseUrl !== 'http://127.0.0.1:57421' || runtime.projectId !== 'ludy-staging') throw Error('Seul le staging local est autorisé.');
  const call = async (route, method = 'GET', data) => {
    const response = await fetchFn(runtime.supabaseUrl + route, { method, headers: { apikey: runtime.serviceKey, Authorization: 'Bearer ' + runtime.serviceKey, 'Content-Type': 'application/json', Prefer: 'return=representation' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Gestion du compte de test interrompue (HTTP ' + response.status + ').');
    return response.status === 204 ? null : response.json();
  };
  const marker = await call('/rest/v1/params?select=value&key=eq.environment');
  if (marker?.[0]?.value !== 'staging') throw Error('Marqueur staging absent : aucune modification.');
  if (options.disable) {
    const profile = await call('/rest/v1/profiles?select=user_id,role&user_id=eq.' + options.disable);
    const user = await call('/auth/v1/admin/users/' + options.disable);
    if (!['viewer', 'pending'].includes(profile?.[0]?.role) || user.app_metadata?.ludy_test_access !== true) throw Error('Ce compte n’est pas un testeur créé par cette commande. Aucune modification.');
    await call('/rest/v1/profiles?user_id=eq.' + options.disable, 'PATCH', { role: 'pending' });
    await call('/auth/v1/admin/users/' + options.disable, 'PUT', { ban_duration: '876000h' });
    return { disabled: true, userId: options.disable };
  }
  const agencies = await call('/rest/v1/agencies?select=id&order=id');
  if (!Array.isArray(agencies) || !agencies.length || agencies.length >= 1000) throw Error('Liste des agences indisponible ou incomplète.');
  const ids = options.all ? agencies.map(row => row.id) : options.agencies;
  if (!ids.length || ids.some(id => !agencies.some(row => row.id === id))) throw Error('Une agence demandée n’existe pas dans le staging.');
  // Never reset an existing account or change its role to make a test login.
  for (let page = 1; page <= 100; page++) {
    const listing = await call('/auth/v1/admin/users?page=' + page + '&per_page=1000');
    if (!Array.isArray(listing.users)) throw Error('Liste des comptes locale invalide.');
    if (listing.users.some(user => user.email?.toLowerCase() === options.email)) throw Error('Ce compte existe déjà. Ses accès et son mot de passe restent inchangés.');
    if (listing.users.length < 1000) break;
    if (page === 100) throw Error('Liste des comptes trop grande pour créer un testeur.');
  }
  const password = randomBytes(24).toString('base64url');
  let user;
  try {
    user = await call('/auth/v1/admin/users', 'POST', { email: options.email, password, email_confirm: true, app_metadata: { ludy_test_access: true }, user_metadata: { name: 'Testeur Ludy', environment: 'staging' } });
    if (!/^[a-f0-9-]{36}$/i.test(user?.id || '')) throw Error('Création non confirmée.');
    // Bind the permitted agencies before allowing any fleet access.
    await call('/rest/v1/user_agencies', 'POST', ids.map(agency_id => ({ user_id: user.id, agency_id })));
    const profile = await call('/rest/v1/profiles?user_id=eq.' + user.id, 'PATCH', { role: 'viewer' });
    if (profile?.[0]?.role !== 'viewer') throw Error('Droits de consultation non confirmés.');
    const filename = await save({ environment: 'staging-local-only', userId: user.id, email: options.email, password, role: 'viewer', agencyIds: ids, createdAt: new Date().toISOString() });
    return { userId: user.id, filename, role: 'viewer', agencies: ids.length };
  } catch (error) {
    if (user?.id) {
      try { await call('/auth/v1/admin/users/' + user.id, 'DELETE'); }
      catch { throw Error('Création incomplète : vérifiez le compte de test dans le Studio local avant de réessayer.'); }
    }
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Créer un compte testeur de consultation, sans envoyer d’e-mail :\n  npm --prefix staging run tester:create -- --email testeur@example.com --all-agencies\n  npm --prefix staging run tester:create -- --email testeur@example.com --agency 1 --agency 2\nDésactiver un testeur créé par cette commande :\n  npm --prefix staging run tester:create -- --disable UUID\nLe mot de passe aléatoire est enregistré dans un fichier privé .local/testers/. Aucun compte existant n’est réinitialisé.');
    return;
  }
  const options = testerOptions(args), runtime = readRuntime();
  ensureLocalDir();
  const directory = path.join(LOCAL_DIR, 'testers');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Dossier de testeurs invalide.');
  fs.chmodSync(directory, 0o700);
  const result = await createTester({ options, runtime, save: async value => {
    const filename = path.join(directory, value.userId + '.json');
    const fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
    catch (error) { fs.rmSync(filename, { force: true }); throw error; }
    finally { fs.closeSync(fd); }
    return filename;
  } });
  if (result.disabled) console.log('Accès du testeur désactivé.');
  else console.log('Compte testeur créé en consultation (' + result.agencies + ' agence(s)). Identifiants privés : ' + result.filename);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message || 'Création du testeur interrompue.'); process.exitCode = 1; });
}
