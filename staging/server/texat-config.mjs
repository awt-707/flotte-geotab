import {privateModeValid,syncPrivateDirectory} from './private-files.mjs';
import {constants} from 'node:fs';
import {lstat, mkdir, open, rename, rm} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {randomUUID} from 'node:crypto';

const KEYS = ['TEXAT_SOCIETE', 'TEXAT_EMAIL', 'TEXAT_PASSWORD'];
const MAX_BYTES = 16384;
const failure = code => Object.assign(new Error('Configuration Texat privée indisponible.'), {code});

/** Only the three user-supplied ScriptProperties are known. This is not an
 * authentication contract, and no endpoint or enabled flag is inferred. */
export function texatConfigFromScriptProperties(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('texat_config_invalid');
  return validateTexatConfig(Object.fromEntries(KEYS.map(key => [key, input[key] ?? ''])));
}

export function validateTexatConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !KEYS.includes(key))) throw failure('texat_config_invalid');
  const result = {};
  for (const key of KEYS) {
    const raw = input[key] ?? '';
    if (typeof raw !== 'string') throw failure('texat_config_invalid');
    const value = key === 'TEXAT_PASSWORD' ? raw : raw.trim();
    const limit = key === 'TEXAT_PASSWORD' ? 4096 : key === 'TEXAT_EMAIL' ? 254 : 128;
    if (value.length > limit || (key === 'TEXAT_PASSWORD' ? raw.includes('\0') : /[\u0000-\u001f\u007f]/.test(raw))) throw failure('texat_config_invalid');
    result[key] = value;
  }
  return Object.freeze(result);
}

/** Safe for an admin health view: no company name, email, password, URL or
 * arbitrary error text is included. Even complete credentials remain inactive. */
export function texatConfigurationStatus(input = null) {
  const config = validateTexatConfig(input ?? {});
  const configured = Object.fromEntries(KEYS.map(key => [key, config[key].length > 0]));
  const missingFields = KEYS.filter(key => !configured[key]);
  return {enabled: false, activeFailover: false, status: missingFields.length ? 'not_configured' : 'pending_provider_contract',
    configured, missingFields, blockingReasons: [...(missingFields.length ? ['credentials_incomplete'] : []),
      'provider_identity_unconfirmed', 'provider_api_contract_missing']};
}

function filenameOf(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename) || filename.includes('\0')) throw failure('texat_config_path');
  return filename;
}
async function privateDirectory(filename) {
  const directory = await lstat(dirname(filename));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !privateModeValid(directory, 0o700, dirname(filename))) throw failure('texat_config_permissions');
}

export async function readTexatConfig(filename) {
  filenameOf(filename); let file;
  try {
    await privateDirectory(filename);
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || !privateModeValid(stat, 0o600, filename) || stat.size > MAX_BYTES) throw failure('texat_config_permissions');
    const buffer = Buffer.alloc(MAX_BYTES + 1), {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw failure('texat_config_size');
    return validateTexatConfig(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure(error.code?.startsWith('texat_config_') ? error.code : 'texat_config_read');
  } finally {await file?.close();}
}

/** Caller supplies an explicitly authorized local private path. This module
 * performs no network calls and is not wired into the running collector. */
export async function saveTexatConfig(filename, input) {
  filenameOf(filename); const config = validateTexatConfig(input);
  const directory = dirname(filename), temporary = join(directory, '.texat-' + randomUUID() + '.tmp');
  let file;
  try {
    await mkdir(directory, {recursive: true, mode: 0o700});
    await privateDirectory(filename);
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(JSON.stringify(config) + '\n'); await file.sync(); await file.close(); file = null;
    await rename(temporary, filename);
    await syncPrivateDirectory(directory);
    return texatConfigurationStatus(config);
  } catch (error) {
    throw failure(error.code?.startsWith('texat_config_') ? error.code : 'texat_config_write');
  } finally {await file?.close(); await rm(temporary, {force: true}).catch(() => {});}
}
