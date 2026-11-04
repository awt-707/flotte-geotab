import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {isIP} from 'node:net';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// This module only validates a proposed deployment. It never loads a runtime,
// reads a secret environment variable, connects to Supabase, or starts a job.
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CONFIG_KEYS = new Set(['schemaVersion', 'environment', 'projectRef', 'supabaseUrl', 'publicOrigin', 'privateStateDir', 'secrets', 'collectors']);
const SECRET_KEYS = new Set(['publishableKeyEnv', 'serverKeyEnv']);
const COLLECTOR_NAMES = Object.freeze(['bolt', 'geotab', 'myclicar', 'uberLive', 'uberReports']);
const MAX_CONFIG_BYTES = 16384;

export class ProductionConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionConfigError';
    this.code = code;
  }
}
function fail(code, message) { throw new ProductionConfigError(code, message); }
function object(value, allowed, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !allowed.has(key))) fail(code, message);
  return value;
}
function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function applicationOrigin(value) {
  const message = 'publicOrigin doit être une origine HTTPS avec un nom DNS public, sans port, chemin, paramètres ou identifiants.';
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) fail('public_origin', message);
  let url;
  try { url = new URL(value); } catch { fail('public_origin', message); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
      ![url.origin, url.origin + '/'].includes(value) || isIP(host.replace(/^\[|\]$/g, '')) || host.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) ||
      ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'lan', 'home', 'home.arpa', 'supabase.co', 'supabase.com', 'supabase.in']
        .some(base => host === base || host.endsWith('.' + base))) fail('public_origin', message);
  return url.origin;
}
function privateStateDirectory(value) {
  const message = 'privateStateDir doit être un chemin absolu normalisé et distinct du dépôt et de ses répertoires parents.';
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(value) ||
      !path.isAbsolute(value) || value === path.parse(value).root || value !== path.normalize(value) || value.endsWith(path.sep) ||
      within(value, REPOSITORY_ROOT) || within(REPOSITORY_ROOT, value)) fail('private_state_directory', message);
  return value;
}
function secretReferences(value) {
  object(value, SECRET_KEYS, 'secret_references', 'secrets doit contenir uniquement publishableKeyEnv et serverKeyEnv, sous forme de noms de variables.');
  for (const key of SECRET_KEYS) {
    if (typeof value[key] !== 'string' || !/^LUDY_PRODUCTION_[A-Z][A-Z0-9_]{2,79}$/.test(value[key])) {
      fail('secret_references', 'Les clés Supabase doivent être référencées par deux variables LUDY_PRODUCTION_ distinctes, jamais fournies dans ce fichier.');
    }
  }
  if (value.publishableKeyEnv === value.serverKeyEnv) fail('secret_references', 'La clé publique et la clé serveur doivent avoir des références distinctes.');
  return Object.freeze({publishableKeyEnv: value.publishableKeyEnv, serverKeyEnv: value.serverKeyEnv});
}
function pausedCollectors(value) {
  if (value === undefined) value = {};
  object(value, new Set(COLLECTOR_NAMES), 'collectors', 'collectors ne doit contenir que les cinq collecteurs connus.');
  if (Object.values(value).some(enabled => enabled !== false)) {
    fail('collectors', 'Cette préparation exige des collecteurs désactivés. Leur activation relève de la bascule validée.');
  }
  return Object.freeze(Object.fromEntries(COLLECTOR_NAMES.map(name => [name, false])));
}

export function validateProductionConfig(input) {
  object(input, CONFIG_KEYS, 'configuration', 'Configuration de production invalide ou champs inconnus.');
  if (input.schemaVersion !== 1 || input.environment !== 'production') {
    fail('environment', 'schemaVersion doit valoir 1 et environment doit valoir production.');
  }
  if (typeof input.projectRef !== 'string' || !/^[a-z0-9]{20}$/.test(input.projectRef)) {
    fail('project_reference', 'projectRef doit être la référence Supabase attendue, composée de 20 caractères minuscules alphanumériques.');
  }
  const supabaseUrl = 'https://' + input.projectRef + '.supabase.co';
  if (input.supabaseUrl !== supabaseUrl && input.supabaseUrl !== supabaseUrl + '/') {
    fail('database_target', 'supabaseUrl doit correspondre exactement à la référence attendue sur le domaine HTTPS canonique Supabase.');
  }
  return Object.freeze({
    schemaVersion: 1,
    environment: 'production',
    projectRef: input.projectRef,
    supabaseUrl,
    publicOrigin: applicationOrigin(input.publicOrigin),
    privateStateDir: privateStateDirectory(input.privateStateDir),
    secrets: secretReferences(input.secrets),
    collectors: pausedCollectors(input.collectors)
  });
}

export async function readProductionConfig(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')) fail('configuration_file', 'Un fichier JSON de configuration est requis.');
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) fail('configuration_file', 'Le fichier de configuration doit être régulier et limité à 16 Kio.');
    const raw = await handle.readFile({encoding: 'utf8'});
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) fail('configuration_file', 'Le fichier de configuration dépasse 16 Kio.');
    let input;
    try { input = JSON.parse(raw); } catch { fail('configuration_json', 'Le fichier de configuration ne contient pas un objet JSON valide.'); }
    return validateProductionConfig(input);
  } catch (error) {
    if (error instanceof ProductionConfigError) throw error;
    // Do not echo paths, JSON content, environment values, or platform errors.
    fail('configuration_file', 'Impossible de lire un fichier de configuration JSON régulier ; les liens symboliques sont refusés.');
  } finally { await handle?.close(); }
}

export function preparationSummary(config) {
  const checked = validateProductionConfig(config);
  return {
    ok: true,
    environment: checked.environment,
    projectRef: checked.projectRef,
    supabaseUrl: checked.supabaseUrl,
    publicOrigin: checked.publicOrigin,
    collectors: checked.collectors,
    secretValuesRead: false,
    networkAccess: false,
    changed: false,
    readyForDeployment: false,
    remaining: ['live_schema_review', 'runtime_integration', 'state_directory_permissions', 'hosted_validation', 'collector_cutover']
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('node staging/production/runtime-config.mjs --check CHEMIN_JSON\nVérification hors ligne uniquement : aucun réseau, secret lu, service démarré ou fichier modifié.\nLa configuration validée reste une préparation, pas un déploiement.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--check' || args[1].startsWith('--')) {
    fail('usage', 'Usage : node staging/production/runtime-config.mjs --check CHEMIN_JSON');
  }
  const config = await readProductionConfig(args[1]);
  console.log(JSON.stringify(preparationSummary(config), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const safe = error instanceof ProductionConfigError ? error : new ProductionConfigError('configuration_file', 'Vérification de configuration impossible.');
    console.error(JSON.stringify({ok: false, code: safe.code, error: safe.message, changed: false, networkAccess: false}));
    process.exitCode = 1;
  });
}
