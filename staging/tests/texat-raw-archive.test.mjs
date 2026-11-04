import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, writeFile, chmod, appendFile, stat, rm, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTeksatRawArchive, rawTeksatObservation} from '../server/texat-raw-archive.mjs';
const NOW = Date.parse('2026-11-03T12:00:00Z');
const position = extra => ({providerVehicleId: '11111111-1111-4111-8111-111111111111', deviceId: '123456789012345',
  collectedAt: new Date(NOW).toISOString(), dateGpsRaw: '2026-11-03T13:00:00', datePositionRaw: '2026-11-03T12:59:00',
  latitude: 33.5, longitude: -7.5, privateMode: false, moving: true, providerStatusCode: 1, ...extra});
const raw = extra => rawTeksatObservation(position(extra), {vehicleKey: 'synthetic-vehicle', evidenceId: 'a'.repeat(64)});
async function fixture(t) {const directory = await mkdtemp(join(tmpdir(), 'teksat-raw-')); await chmod(directory, 0o700); t.after(() => rm(directory, {recursive: true, force: true})); return directory;}

test('raw dates remain unchanged, private coordinates are suppressed and receipt-time mapping is explicit', () => {
  const value = raw(); assert.equal(value.dateGpsRaw, '2026-11-03T13:00:00'); assert.equal(value.timeZone, null);
  assert.equal(value.normalized, false); assert.equal(value.mappingBasis, 'current_at_receipt'); assert.equal(value.receivedAt, new Date(NOW).toISOString());
  const privateValue = raw({privateMode: true}); assert.equal(privateValue.latitude, null); assert.equal(privateValue.longitude, null);
  assert.ok(!Object.hasOwn(value, 'plate')); assert.ok(!Object.hasOwn(value, 'observedAt'));
});

test('durable append deduplicates after restart and retains corrections as separate versions', async t => {
  const directory = await fixture(t); let archive = await createTeksatRawArchive({directory, now: () => NOW});
  assert.equal((await archive.append([raw()])).inserted, 1); await archive.close();
  const names = await readdir(directory); assert.equal(names.filter(n => n.endsWith('.jsonl')).length, 1); assert.ok(!names.includes('pending.json'));
  assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600);
  archive = await createTeksatRawArchive({directory, now: () => NOW});
  assert.equal((await archive.append([raw()])).inserted, 0);
  assert.equal((await archive.append([raw({latitude: 33.6})])).inserted, 1);
  assert.equal(archive.getStatus().entries, 2); await archive.close();
  const records = (await Promise.all((await readdir(directory)).filter(n => n.endsWith('.jsonl')).map(n => readFile(join(directory, n), 'utf8')))).join('').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(r => r.version).sort(), [1, 2]); assert.equal(new Set(records.map(r => r.sourceEventId)).size, 1);
  assert.equal(new Set(records.map(r => r.fingerprint)).size, 2);
});

test('a crash tail is preserved privately and a durable pending batch is resumed exactly once', async t => {
  const directory = await fixture(t); let archive = await createTeksatRawArchive({directory, now: () => NOW});
  await archive.append([raw()]); await archive.close();
  const segment = (await readdir(directory)).find(n => n.endsWith('.jsonl'));
  await appendFile(join(directory, segment), '{"interrupted":');
  await writeFile(join(directory, 'pending.json'), JSON.stringify([raw({latitude: 33.7})]), {mode: 0o600});
  archive = await createTeksatRawArchive({directory, now: () => NOW});
  assert.equal(archive.getStatus().interruptedFiles, 1); assert.equal(archive.getStatus().pending, 1);
  await archive.flushPending(); assert.equal(archive.getStatus().entries, 2); assert.equal(archive.getStatus().pending, 0); await archive.close();
  const backup = (await readdir(directory)).find(n => n.includes('.interrupted-'));
  assert.ok((await readFile(join(directory, backup), 'utf8')).endsWith('{"interrupted":'));
  archive = await createTeksatRawArchive({directory, now: () => NOW}); assert.equal(archive.getStatus().entries, 2); await archive.close();
});

test('rotation never purges old history and the storage cap stops writes explicitly', async t => {
  const directory = await fixture(t); let at = NOW;
  const archive = await createTeksatRawArchive({directory, now: () => at, segmentBytes: 2048, maxBytes: 8192});
  await archive.append([raw()]); const original = (await readdir(directory)).find(n => n.endsWith('.jsonl'));
  at += 365 * 86400000;
  for (let index = 1; index < 30; index++) {
    try {await archive.append([raw({latitude: 33.5 + index / 1000})]);} catch (error) {assert.equal(error.code, 'texat_archive_full'); break;}
  }
  assert.equal(archive.getStatus().full, true); assert.ok(archive.getStatus().segments > 1);
  assert.equal(archive.getStatus().retention, 'no_automatic_deletion'); assert.ok((await readdir(directory)).includes(original));
  await archive.close();
});

test('recovery interrupted immediately after rename still replays the intact historical prefix', async t => {
  const directory = await fixture(t); let archive = await createTeksatRawArchive({directory, now: () => NOW});
  await archive.append([raw()]); await archive.close();
  const segment = (await readdir(directory)).find(n => n.endsWith('.jsonl'));
  await appendFile(join(directory, segment), '{"interrupted":');
  await rename(join(directory, segment), join(directory, segment + '.interrupted-11111111-1111-4111-8111-111111111111'));
  archive = await createTeksatRawArchive({directory, now: () => NOW});
  assert.equal(archive.getStatus().entries, 1); assert.equal(archive.getStatus().interruptedFiles, 1);
  assert.equal((await archive.append([raw()])).inserted, 0); await archive.close();
});

test('public directories and malformed archived records are rejected before reuse', async t => {
  const directory = await fixture(t); await chmod(directory, 0o755);
  await assert.rejects(createTeksatRawArchive({directory}), {code: 'texat_archive_permissions'});
  await chmod(directory, 0o700);
  const archive = await createTeksatRawArchive({directory, now: () => NOW});
  await assert.rejects(archive.append([{...raw(), secret: 'must-not-persist'}]), {code: 'texat_archive_schema'});
  assert.deepEqual(await readdir(directory), []); await archive.close();
});
