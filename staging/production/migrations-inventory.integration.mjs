import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD, dockerArgs} from '../scripts/import-reference.mjs';
import {parseInventory} from './migrations-plan.mjs';

// Explicit guarded local validation only. The inventory itself cannot write
// database data or schema; its temporary session value is cleared in the query.
assertLocalProject();
if (process.argv.length !== 2) throw Error('Ce contrôle local ne prend aucun argument.');
const editor = readFileSync(new URL('./migrations-inventory-editor.sql', import.meta.url), 'utf8');
const args = dockerArgs('psql', ['-X', '-qAt', '--set=ON_ERROR_STOP=1', '--file=/dev/stdin'])
  .map(value => value === '--username=postgres' ? '--username=supabase_admin' : value);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result = spawnSync('docker', args, {
  env, input: LOCAL_GUARD + '\n' + editor +
    "\nselect case when current_setting('ludy_inventory_editor.result',true)='' then 'EDITOR_SESSION_CLEARED' else 'EDITOR_SESSION_NOT_CLEARED' end;",
  encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024
});
if (result.error || result.status !== 0) throw Error('Validation locale de l’inventaire SQL Editor interrompue.');
const lines = result.stdout.trim().split('\n');
assert.equal(lines.length, 2);
assert.equal(lines[1], 'EDITOR_SESSION_CLEARED');
const inventory = parseInventory(lines[0]);
assert.equal(inventory.transactionReadOnly, true);
assert.equal(Object.keys(inventory.catalogs).length, 7);
assert.deepEqual(parseInventory(JSON.stringify([{inventory_json: inventory}])), inventory);
console.log(JSON.stringify({ok: true, target: 'local-staging-only', rows: 1,
  transactionReadOnly: true, sessionValueCleared: true, historyAvailable: inventory.history.available}));
