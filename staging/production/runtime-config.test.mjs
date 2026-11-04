import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ProductionConfigError, validateProductionConfig, readProductionConfig, preparationSummary} from './runtime-config.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = fileURLToPath(new URL('./runtime-config.mjs', import.meta.url));
const valid = () => ({
  schemaVersion: 1,
  environment: 'production',
  projectRef: 'abcdefghijklmnopqrst',
  supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
  publicOrigin: 'https://ludy.example.com',
  privateStateDir: '/var/lib/ludy-production',
  secrets: {publishableKeyEnv: 'LUDY_PRODUCTION_SUPABASE_PUBLIC_KEY', serverKeyEnv: 'LUDY_PRODUCTION_SUPABASE_SERVER_KEY'}
});
function rejects(input, code) {
  assert.throws(() => validateProductionConfig(input), error => error instanceof ProductionConfigError && error.code === code);
}

test('normalizes only canonical origins and freezes a fully paused preparation', () => {
  const result = validateProductionConfig({...valid(), supabaseUrl: valid().supabaseUrl + '/', publicOrigin: valid().publicOrigin + '/'});
  assert.equal(result.supabaseUrl, valid().supabaseUrl);
  assert.equal(result.publicOrigin, valid().publicOrigin);
  assert.deepEqual(result.collectors, {bolt: false, geotab: false, myclicar: false, uberLive: false, uberReports: false});
  for (const value of [result, result.secrets, result.collectors]) assert.ok(Object.isFrozen(value));
  assert.equal(preparationSummary(result).readyForDeployment, false);
});

test('rejects staging, unknown versions, missing values and unknown configuration fields', () => {
  for (const value of [null, [], 'production']) rejects(value, 'configuration');
  for (const environment of ['staging', 'Production', '', undefined]) rejects({...valid(), environment}, 'environment');
  for (const schemaVersion of [0, 2, '1', undefined]) rejects({...valid(), schemaVersion}, 'environment');
  rejects({...valid(), serviceKey: 'never-print-this'}, 'configuration');
  rejects({...valid(), bootstrap: true}, 'configuration');
});

test('pins the canonical Supabase HTTPS target to the exact expected project', () => {
  for (const projectRef of ['', 'short', 'ABCDEFGHIJKLMNOPQRST', 'abcdefghijklmnopqrs-', 'abcdefghijklmnopqrstuv']) rejects({...valid(), projectRef}, 'project_reference');
  for (const supabaseUrl of [
    'https://uvwxyzabcdefghijklmn.supabase.co', 'http://abcdefghijklmnopqrst.supabase.co',
    'https://db.example.com', 'https://abcdefghijklmnopqrst.supabase.co:443',
    'https://abcdefghijklmnopqrst.supabase.co/rest/v1', 'https://abcdefghijklmnopqrst.supabase.co?secret=never-print-this',
    'https://user:never-print-this@abcdefghijklmnopqrst.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co#secret',
    'https://abcdefghijklmnopqrst.supabase.co.evil.example', 'https://%61bcdefghijklmnopqrst.supabase.co',
    ' https://abcdefghijklmnopqrst.supabase.co', null
  ]) rejects({...valid(), supabaseUrl}, 'database_target');
});

test('requires an application origin separate from Supabase and local networks', () => {
  for (const publicOrigin of [
    'http://ludy.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost',
    'https://ludy.local', 'https://ludy.internal', 'https://ludy.test', 'https://ludy.invalid',
    'https://ludy.home.arpa', 'https://ludy.example.com:443', 'https://ludy.example.com:444',
    'https://ludy.example.com/path', 'https://ludy.example.com?token=never-print-this',
    'https://user:never-print-this@ludy.example.com', 'https://ludy.example.com#secret',
    valid().supabaseUrl, 'https://ludy.supabase.com', 'https://ludy.example.com.', ' https://ludy.example.com', undefined
  ]) rejects({...valid(), publicOrigin}, 'public_origin');
  assert.equal(validateProductionConfig({...valid(), publicOrigin: 'https://ludy-flotte.pages.dev'}).publicOrigin, 'https://ludy-flotte.pages.dev');
});

test('keeps production state outside the checkout and separate from staging state', () => {
  for (const privateStateDir of [
    '.', 'state', '/', path.resolve(ROOT), path.join(ROOT, 'staging/.local'), path.join(ROOT, 'production-state'),
    path.dirname(path.resolve(ROOT)), '/var/lib/ludy-production/../ludy-staging', '/var/lib/ludy-production/',
    '/var/lib//ludy-production', '/var/lib/ludy\u0000production', 'C:\\ludy-production', undefined
  ]) rejects({...valid(), privateStateDir}, 'private_state_directory');
  assert.equal(validateProductionConfig({...valid(), privateStateDir: '/srv/ludy-production/state'}).privateStateDir, '/srv/ludy-production/state');
});

test('accepts only distinct environment references, never inline keys or secret files', () => {
  for (const secrets of [
    null, [], {}, {publishableKeyEnv: 'SUPABASE_ANON_KEY', serverKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY'},
    {publishableKeyEnv: 'sb_publishable_never-print-this', serverKeyEnv: 'sb_secret_never-print-this'},
    {publishableKeyEnv: 'LUDY_PRODUCTION_SAME', serverKeyEnv: 'LUDY_PRODUCTION_SAME'},
    {...valid().secrets, serverKey: 'never-print-this'}, {...valid().secrets, file: '/private/secret'},
    {...valid().secrets, serverKeyEnv: '$LUDY_PRODUCTION_SUPABASE_SERVER_KEY'}
  ]) rejects({...valid(), secrets}, 'secret_references');
});

test('cannot enable any collector through the preparation config', () => {
  for (const name of ['bolt', 'geotab', 'myclicar', 'uberLive', 'uberReports']) {
    for (const value of [true, 1, 'false', null]) rejects({...valid(), collectors: {[name]: value}}, 'collectors');
  }
  rejects({...valid(), collectors: {unknown: false}}, 'collectors');
  const checked = validateProductionConfig({...valid(), collectors: {uberReports: false}});
  assert.ok(Object.values(checked.collectors).every(value => value === false));
});

test('summary contains no private paths, secret references, or configuration payload', () => {
  const result = preparationSummary(validateProductionConfig(valid()));
  assert.equal(result.networkAccess, false);
  assert.equal(result.secretValuesRead, false);
  assert.equal(result.changed, false);
  const text = JSON.stringify(result);
  for (const omitted of [valid().privateStateDir, valid().secrets.publishableKeyEnv, valid().secrets.serverKeyEnv]) assert.ok(!text.includes(omitted));
  assert.ok(result.remaining.includes('state_directory_permissions'));
});

test('file reader rejects symlinks, malformed JSON, directories and oversized files without echoing contents', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ludy-prod-config-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'valid.json');
  await fs.writeFile(file, JSON.stringify(valid()));
  assert.equal((await readProductionConfig(file)).environment, 'production');
  const link = path.join(dir, 'link.json');
  await fs.symlink(file, link);
  const malformed = path.join(dir, 'malformed.json');
  await fs.writeFile(malformed, '{ "serverKey": "never-print-this"');
  const oversized = path.join(dir, 'oversized.json');
  await fs.writeFile(oversized, 'never-print-this'.repeat(2000));
  for (const filename of [link, malformed, oversized, dir, path.join(dir, 'absent')]) {
    await assert.rejects(readProductionConfig(filename), error => error instanceof ProductionConfigError && !error.message.includes('never-print-this') && !error.message.includes(dir));
  }
});

const DENY_IO_PRELOAD = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
const deny=()=>{throw Error('Forbidden side effect during offline check');};
globalThis.fetch=deny;
for(const module of [http,https]){module.request=deny;module.get=deny;module.createServer=deny;}
net.connect=deny;net.createConnection=deny;net.createServer=deny;net.Socket.prototype.connect=deny;tls.connect=deny;dns.lookup=deny;
for(const name of ['appendFile','chmod','chown','copyFile','cp','link','mkdir','mkdtemp','rename','rm','rmdir','symlink','truncate','unlink','utimes','writeFile']){
 if(typeof fs[name]==='function')fs[name]=deny;
 if(typeof fs[name+'Sync']==='function')fs[name+'Sync']=deny;
 if(typeof fsp[name]==='function')fsp[name]=deny;
}
fs.createWriteStream=deny;fs.write=deny;fs.writeSync=deny;
const open=fsp.open.bind(fsp);
fsp.open=async(file,flags,...args)=>{
 if(typeof flags==='string'?flags!=='r':(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)))deny();
 return open(file,flags,...args);
};
const environment=process.env;
process.env=new Proxy(environment,{get(target,key){if(typeof key==='string'&&key.startsWith('LUDY_PRODUCTION_'))deny();return Reflect.get(target,key);}});
`;

test('real CLI checks offline without reading secrets, making requests, starting listeners or writing files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ludy-prod-cli-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'config.json'), preload = path.join(dir, 'deny-io.mjs');
  await fs.writeFile(file, JSON.stringify(valid()));
  await fs.writeFile(preload, DENY_IO_PRELOAD);
  const before = await fs.readdir(dir);
  const output = spawnSync(process.execPath, ['--import', preload, CLI, '--check', file], {
    encoding: 'utf8', timeout: 10000,
    env: {...process.env, LUDY_PRODUCTION_SUPABASE_PUBLIC_KEY: 'private-test-public-sentinel', LUDY_PRODUCTION_SUPABASE_SERVER_KEY: 'private-test-server-sentinel'}
  });
  assert.equal(output.status, 0, output.stderr);
  const summary = JSON.parse(output.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.readyForDeployment, false);
  assert.equal(summary.changed, false);
  assert.ok(!output.stdout.includes('sentinel'));
  assert.deepEqual(await fs.readdir(dir), before);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), valid());
});

test('CLI errors and unsupported options disclose no supplied secret values', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ludy-prod-errors-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({...valid(), secrets: {...valid().secrets, serverKey: 'never-print-this'}}));
  for (const args of [['--check', file], ['--apply', file], ['--check'], ['--check', file, '--activate-collectors']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8', timeout: 10000});
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('never-print-this') && !result.stderr.includes('never-print-this'));
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.equal(error.changed, false);
  }
});

test('checked-in example contains only references and remains intentionally incomplete', async () => {
  const example = JSON.parse(await fs.readFile(new URL('./runtime-config.example.json', import.meta.url), 'utf8'));
  rejects(example, 'project_reference');
  assert.deepEqual(example.secrets, valid().secrets);
  assert.ok(Object.values(example.collectors).every(value => value === false));
});
