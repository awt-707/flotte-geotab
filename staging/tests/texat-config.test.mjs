import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, chmod, stat, writeFile, readdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateTexatConfig, texatConfigFromScriptProperties, texatConfigurationStatus, readTexatConfig, saveTexatConfig} from '../server/texat-config.mjs';

const configuration = {TEXAT_SOCIETE: 'synthetic-company', TEXAT_EMAIL: 'synthetic@example.test', TEXAT_PASSWORD: ' synthetic-secret '};
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'ludy-texat-config-'));
  t.after(() => rm(path, {recursive: true, force: true})); return path;
}

test('extracts only confirmed Texat ScriptProperties, preserving a password without importing Geotab secrets', () => {
  const input = {...configuration, TEXAT_SOCIETE: ' synthetic-company ', GEOTAB_PASSWORD: 'other-secret', URL: 'https://unconfirmed.example.test'};
  assert.deepEqual(texatConfigFromScriptProperties(input), configuration);
  assert.throws(() => validateTexatConfig(input), {code: 'texat_config_invalid'});
  assert.deepEqual(texatConfigFromScriptProperties({TEXAT_SOCIETE: 'clicar'}), {TEXAT_SOCIETE: 'clicar', TEXAT_EMAIL: '', TEXAT_PASSWORD: ''});
});

test('even complete credentials stay inactive and diagnostic output never reveals their values', () => {
  const pending = texatConfigurationStatus(configuration);
  assert.equal(pending.enabled, false); assert.equal(pending.activeFailover, false);
  assert.equal(pending.status, 'pending_provider_contract'); assert.deepEqual(pending.missingFields, []);
  assert.ok(pending.blockingReasons.includes('provider_api_contract_missing'));
  for (const value of Object.values(configuration)) assert.ok(!JSON.stringify(pending).includes(value));
  const incomplete = texatConfigurationStatus({TEXAT_SOCIETE: 'clicar'});
  assert.equal(incomplete.status, 'not_configured'); assert.deepEqual(incomplete.missingFields, ['TEXAT_EMAIL', 'TEXAT_PASSWORD']);
  assert.deepEqual(texatConfigurationStatus().missingFields, ['TEXAT_SOCIETE', 'TEXAT_EMAIL', 'TEXAT_PASSWORD']);
});

test('private configuration survives atomic writes and retains strict file/directory permissions', async t => {
  const root = await directory(t), path = join(root, 'private', 'texat.json');
  assert.equal(await readTexatConfig(path), null);
  assert.equal((await saveTexatConfig(path, configuration)).enabled, false);
  assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readTexatConfig(path), configuration);
  await saveTexatConfig(path, {TEXAT_SOCIETE: 'clicar'});
  assert.deepEqual(await readTexatConfig(path), {TEXAT_SOCIETE: 'clicar', TEXAT_EMAIL: '', TEXAT_PASSWORD: ''});
  assert.deepEqual(await readdir(join(root, 'private')), ['texat.json']);
});

test('unsafe files, symlinks and malformed or oversized values are rejected without leaking contents', async t => {
  const root = await directory(t), path = join(root, 'texat.json');
  await saveTexatConfig(path, configuration);
  await chmod(path, 0o644);
  await assert.rejects(readTexatConfig(path), {code: 'texat_config_permissions'});
  await chmod(path, 0o600);
  const linked = join(root, 'linked.json'); await symlink(path, linked);
  await assert.rejects(readTexatConfig(linked), error => error.code === 'texat_config_read' && !error.message.includes('synthetic'));
  await writeFile(path, 'synthetic-private-invalid-json');
  await assert.rejects(readTexatConfig(path), error => error.code === 'texat_config_read' && !error.message.includes('synthetic'));
  await writeFile(path, 'x'.repeat(16385));
  await assert.rejects(readTexatConfig(path), {code: 'texat_config_permissions'});
  for (const input of [{TEXAT_PASSWORD: 'x'.repeat(4097)}, {TEXAT_EMAIL: '\nprivate'}, {TEXAT_SOCIETE: 1}, {enabled: true}]) {
    assert.throws(() => validateTexatConfig(input), {code: 'texat_config_invalid'});
  }
  await assert.rejects(saveTexatConfig('relative.json', configuration), {code: 'texat_config_path'});
});

test('a public or linked parent directory is not silently accepted or chmodded', async t => {
  const root = await directory(t), parent = join(root, 'public'); await mkdir(parent, {mode: 0o755});
  await assert.rejects(saveTexatConfig(join(parent, 'texat.json'), configuration), {code: 'texat_config_permissions'});
  assert.equal((await stat(parent)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(parent), []);
  const privatePath = join(root, 'private'); await mkdir(privatePath, {mode: 0o700});
  const link = join(root, 'link'); await symlink(privatePath, link);
  await assert.rejects(saveTexatConfig(join(link, 'texat.json'), configuration), {code: 'texat_config_permissions'});
  assert.deepEqual(await readdir(privatePath), []);
});
