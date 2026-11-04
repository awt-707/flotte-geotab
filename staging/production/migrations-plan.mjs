import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY = path.resolve(HERE, '../..');
const FILE = /^\d{14}_[a-z0-9_]+\.sql$/;
const VERSION = /^\d{14}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LIMIT = 4 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

async function regularFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LIMIT) fail('Fichier ordinaire de taille bornée requis.');
  return fs.readFile(filename);
}

export async function loadManifest(root = REPOSITORY) {
  const text = await regularFile(path.join(root, 'staging/production/migrations-manifest.json'));
  let manifest;
  try { manifest = JSON.parse(text); } catch { fail('Manifeste JSON invalide.'); }
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  if (manifest?.format !== 'ludy-migration-source-manifest-v1' || manifest.executionAllowed !== false ||
      !Array.isArray(manifest.baseline) || !manifest.baseline.length || !Array.isArray(manifest.candidates) || !manifest.candidates.length) fail('Manifeste de sources invalide.');
  const versions = new Set();
  for (const group of ['baseline', 'candidates']) {
    let last = '';
    for (const entry of manifest[group]) {
      if (!FILE.test(entry.file) || !VERSION.test(entry.version) || entry.version !== entry.file.slice(0, 14) ||
          !SHA256.test(entry.sha256) || versions.has(entry.version) || entry.version <= last) fail('Migration dupliquée, non ordonnée ou mal formée.');
      if (group === 'candidates' && (typeof entry.review !== 'string' || !Array.isArray(entry.stagingGuardLines) ||
          entry.stagingGuardLines.some(line => !Number.isSafeInteger(line) || line < 1))) fail('Revue de migration absente.');
      versions.add(entry.version); last = entry.version;
    }
  }
  if (manifest.baseline.at(-1).version >= manifest.candidates[0].version) fail('Le lot doit prolonger le socle, sans réordonner son historique.');
  return manifest;
}

export async function verifySources(root = REPOSITORY, manifest) {
  manifest ??= await loadManifest(root);
  validateManifest(manifest);
  const rootPath = await fs.realpath(root);
  const baselineDir = path.join(rootPath, 'supabase/migrations');
  const stagingDir = path.join(rootPath, 'staging/supabase/migrations');
  for (const directory of [baselineDir, stagingDir]) {
    if (await fs.realpath(directory) !== directory) fail('Répertoire de migrations redirigé.');
  }
  const checkSet = async (directory, entries) => {
    const actual = (await fs.readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    const expected = entries.map(entry => entry.file).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('Inventaire SQL différent du manifeste : nouvelle revue requise.');
    for (const entry of entries) {
      const bytes = await regularFile(path.join(directory, entry.file));
      if (digest(bytes) !== entry.sha256) fail('Empreinte SQL différente du manifeste : ' + entry.file);
    }
  };
  await checkSet(baselineDir, manifest.baseline);
  await checkSet(stagingDir, [...manifest.baseline, ...manifest.candidates]);
  return {ok: true, baseline: manifest.baseline.length, candidates: manifest.candidates.length, manifestSha256: digest(JSON.stringify(manifest))};
}

export function parseInventory(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) fail('Inventaire de métadonnées trop volumineux.');
  // Accept the psql NOTICE, a JSON cell, or the SQL Editor's one-row JSON export.
  // These are data envelopes only; no SQL or shell output is evaluated.
  const tagged = text.split(/\r?\n/).filter(line => /(?:^|\s)LUDY_MIGRATION_INVENTORY /.test(line));
  if (tagged.length > 1) fail('Plusieurs inventaires trouvés : conserver un seul relevé.');
  const json = tagged.length ? tagged[0].slice(tagged[0].indexOf('LUDY_MIGRATION_INVENTORY ') + 25) : text.trim();
  let inventory;
  try { inventory = JSON.parse(json); } catch { fail('Inventaire JSON invalide.'); }
  if (Array.isArray(inventory)) {
    if (inventory.length !== 1) fail('Un seul inventaire est requis dans l’export SQL Editor.');
    inventory = inventory[0];
  }
  if (inventory && typeof inventory === 'object' && Object.hasOwn(inventory, 'inventory_json')) {
    if (Object.keys(inventory).length !== 1) fail('Export SQL Editor ambigu.');
    inventory = inventory.inventory_json;
    if (typeof inventory === 'string') {
      try { inventory = JSON.parse(inventory); } catch { fail('Cellule inventory_json invalide.'); }
    }
  }
  if (inventory?.format !== 'ludy-production-metadata-v1' || inventory.transactionReadOnly !== true ||
      typeof inventory.history?.available !== 'boolean' || !Array.isArray(inventory.history.versions) ||
      inventory.history.versions.length > 10000 || inventory.history.versions.some(version => typeof version !== 'string' || !VERSION.test(version)) ||
      new Set(inventory.history.versions).size !== inventory.history.versions.length ||
      (!inventory.history.available && inventory.history.versions.length) ||
      !inventory.catalogs || typeof inventory.catalogs !== 'object' || Array.isArray(inventory.catalogs)) fail('Inventaire de lecture seule incomplet ou incohérent.');
  for (const key of ['relations', 'functions', 'policies', 'triggers', 'indexes', 'publications', 'extensions']) {
    if (!Array.isArray(inventory.catalogs[key])) fail('Catalogue manquant : ' + key);
  }
  return inventory;
}

export function promotionPlan(manifest, inventory = null) {
  validateManifest(manifest);
  if (inventory) inventory = parseInventory(JSON.stringify(inventory));
  const applied = new Set(inventory?.history.versions || []);
  const known = new Set([...manifest.baseline, ...manifest.candidates].map(entry => entry.version));
  const blockers = [];
  if (!inventory) blockers.push('PRODUCTION_METADATA_NOT_COLLECTED');
  else if (!inventory.history.available) blockers.push('MIGRATION_HISTORY_UNAVAILABLE_RECONCILE_SCHEMA_MANUALLY');
  const missingBaseline = inventory?.history.available ? manifest.baseline.filter(entry => !applied.has(entry.version)).map(entry => entry.version) : [];
  const unknownApplied = [...applied].filter(version => !known.has(version)).sort();
  if (missingBaseline.length) blockers.push('BASELINE_HISTORY_INCOMPLETE_DO_NOT_REPLAY_BASELINE');
  if (unknownApplied.length) blockers.push('UNREVIEWED_PRODUCTION_MIGRATIONS');
  let foundGap = false;
  for (const entry of manifest.candidates) {
    if (!applied.has(entry.version)) foundGap = true;
    else if (foundGap) { blockers.push('NONCONTIGUOUS_CANDIDATE_HISTORY'); break; }
  }
  blockers.push('CATALOG_AND_DATA_EFFECT_REVIEW_REQUIRED', 'PRODUCTION_VARIANTS_NOT_PREPARED',
    'PRIVATE_BACKUP_AND_RESTORE_REHEARSAL_REQUIRED', 'COLLECTOR_CUTOVER_NOT_VALIDATED');
  return {
    format: 'ludy-production-migration-plan-v1', readOnly: true, executionAvailable: false, readyForProduction: false,
    baselineCount: manifest.baseline.length, candidateCount: manifest.candidates.length,
    inventoryProvided: !!inventory, missingBaseline, unknownApplied, blockers,
    warning: 'Les versions enregistrées ne prouvent pas le contenu SQL appliqué. Aucun seed, bootstrap, reset, restauration ni SQL de migration ne sera exécuté.',
    candidates: manifest.candidates.map(entry => ({version: entry.version, file: entry.file, sha256: entry.sha256,
      history: !inventory?.history.available ? 'unknown' : applied.has(entry.version) ? 'recorded-review-schema' : 'not-recorded-review-schema',
      requiresProductionVariant: entry.stagingGuardLines.length > 0, review: entry.review})),
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node staging/production/migrations-plan.mjs [--inventory FICHIER_JSON_OU_NOTICE]\nLecture des sources et, facultativement, d’un relevé de métadonnées existant. Aucune connexion, aucun SQL exécuté, aucun fichier écrit.');
    return;
  }
  if (args.length && !(args.length === 2 && args[0] === '--inventory' && args[1] && !args[1].startsWith('-'))) fail('Seule option permise : --inventory FICHIER. Aucune option apply/reset/bootstrap.');
  const manifest = await loadManifest();
  const sourceCheck = await verifySources(REPOSITORY, manifest);
  const inventory = args.length ? parseInventory((await regularFile(path.resolve(args[1]))).toString('utf8')) : null;
  const result = {...promotionPlan(manifest, inventory), sourceCheck};
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
