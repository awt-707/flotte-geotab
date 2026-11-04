import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadManifest, validateManifest, verifySources, parseInventory, promotionPlan, main, REPOSITORY} from './migrations-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = await loadManifest();
const emptyCatalogs = () => Object.fromEntries(['relations','functions','policies','triggers','indexes','publications','extensions'].map(key => [key, []]));
const inventory = (versions = manifest.baseline.map(entry => entry.version)) => ({
  format: 'ludy-production-metadata-v1', transactionReadOnly: true,
  history: {available: true, versions}, catalogs: emptyCatalogs(),
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(HERE, 'migrations-test-fixture-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const directory of ['supabase/migrations', 'staging/supabase/migrations', 'staging/production']) await fs.mkdir(path.join(root, directory), {recursive: true});
  await fs.copyFile(path.join(HERE, 'migrations-manifest.json'), path.join(root, 'staging/production/migrations-manifest.json'));
  for (const entry of manifest.baseline) await fs.copyFile(path.join(REPOSITORY, 'supabase/migrations', entry.file), path.join(root, 'supabase/migrations', entry.file));
  for (const entry of [...manifest.baseline, ...manifest.candidates]) await fs.copyFile(path.join(REPOSITORY, 'staging/supabase/migrations', entry.file), path.join(root, 'staging/supabase/migrations', entry.file));
  return root;
}

test('the reviewed source set is exact and every candidate has its review', async () => {
  const result = await verifySources();
  assert.equal(result.ok, true);
  assert.equal(result.baseline, 37);
  assert.equal(result.candidates, 42);
  assert.equal(result.baseline + result.candidates, 79);
  assert.equal(manifest.candidates.filter(entry => entry.stagingGuardLines.length).length, 32);
  assert.match(manifest.candidates.find(entry => entry.file.endsWith('_manual_events.sql')).review, /DESTRUCTIF/);
  assert.match(manifest.candidates.find(entry => entry.file.endsWith('_driver_sessions.sql')).review, /révocation/);
});

test('financial Realtime publishes only minimal RLS markers through statement triggers', async () => {
  const entry = manifest.candidates.find(item => item.version === '20261223000000');
  assert.deepEqual(entry.publishedRelations, ['revenue_refresh']);
  assert.deepEqual(entry.alteredPublications, ['supabase_realtime']);
  const sql = (await fs.readFile(path.join(REPOSITORY, 'staging/supabase/migrations', entry.file), 'utf8')).replace(/--[^\n]*/g, '');
  assert.match(sql, /key='environment'\) is distinct from 'staging'/);
  assert.match(sql, /if not exists \(select 1 from pg_publication where pubname='supabase_realtime'\)/);
  assert.match(sql, /rls_enabled is distinct from true/);
  assert.match(sql, /alter publication supabase_realtime add table public\.revenue_refresh/);
  assert.match(sql, /tablename in \('uber_payments', 'bolt_sessions', 'cash_moves'\)/);
  assert.match(sql, /Financial rows must not be published/);
  assert.match(sql, /agency_id bigint primary key/);
  assert.match(sql, /agency_id > 0 and public\.my_role\(\)='manager'/);
  assert.match(sql, /security definer set search_path = ''/);
  assert.match(sql, /array_agg\(s\.agency_id order by s\.agency_id\)/);
  assert.match(sql, /referencing old table as old_revenue_rows new table as new_revenue_rows for each statement/);
  assert.match(sql, /revoke all on public\.revenue_refresh from public, anon, authenticated, service_role/);
  assert.match(sql, /revoke all on function public\.revenue_refresh_after_statement\(\) from public, anon, authenticated, service_role/);
  assert.match(sql, /grant select on public\.revenue_refresh to authenticated/);
  assert.doesNotMatch(sql, /\b(?:delete\s+from\s+public\.revenue_refresh|references\s+public\.agencies|replica\s+identity|create\s+publication)\b/i);
  assert.doesNotMatch(sql, /alter publication\s+\w+\s+add table\s+public\.(?:uber_payments|bolt_sessions|cash_moves)/i);
  const runner = await fs.readFile(path.join(REPOSITORY, 'staging/scripts/migrate-local.mjs'), 'utf8');
  assert.match(runner, /\['20261223000000','revenue_realtime'\]/);
});

test('provider earnings use one service-only RPC, independent period snapshots and confirmed agency mappings', async () => {
  const entry = manifest.candidates.find(item => item.version === '20261224000000');
  assert.deepEqual(entry.createdRelations, ['provider_earnings_snapshots', 'provider_earnings_rows']);
  const sql = (await fs.readFile(path.join(REPOSITORY, 'staging/supabase/migrations', entry.file), 'utf8')).replace(/--[^\n]*/g, '');
  assert.match(sql, /unique\(source,organization_id,period_start,period_end,currency\)/);
  assert.match(sql, /revoke all on public\.provider_earnings_snapshots,public\.provider_earnings_rows from public,anon,authenticated,service_role/);
  assert.match(sql, /grant execute on function public\.provider_earnings_commit\(jsonb\) to service_role/);
  assert.match(sql, /revoke all on function public\.provider_earnings_commit\(jsonb\) from public,anon,authenticated/);
  assert.match(sql, /language plpgsql security definer set search_path = ''/);
  assert.match(sql, /lower\(i\.organization_id\)=org::text and not i\.provisional/);
  assert.match(sql, /reference_agency=target_agency/);
  assert.match(sql, /complete_snapshot_preserved/);
  assert.match(sql, /stale_observation/);
  assert.match(sql, /delete from public\.provider_earnings_rows where snapshot_id=snapshot_uuid/);
  assert.match(sql, /count\(\*\) over\(partition by r\.agency_id\)/);
  assert.match(sql, /insert into public\.revenue_refresh/);
  assert.doesNotMatch(sql, /(?:insert into|update|delete from) public\.(?:uber_payments|bolt_sessions|cash_moves)\b/i);
  assert.doesNotMatch(sql, /alter publication[^;]*provider_earnings/i);
  const runner = await fs.readFile(path.join(REPOSITORY, 'staging/scripts/migrate-local.mjs'), 'utf8');
  assert.match(runner, /\['20261224000000','provider_earnings'\]/);
});

test('telemetry archival is immutable, service RPC only, scoped, and never published', async()=>{
  const entry=manifest.candidates.find(item=>item.version==='20261225000000');
  assert.deepEqual(entry.createdRelations,['telemetry_observations']);assert.deepEqual(entry.publishedRelations,[]);
  const sql=await fs.readFile(path.join(REPOSITORY,'staging/supabase/migrations',entry.file),'utf8');
  assert.match(sql,/unique\(source,device_id,source_event_id,fingerprint\)/);
  assert.match(sql,/before update or delete on public\.telemetry_observations/);
  assert.match(sql,/grant execute on function public\.telemetry_archive_ingest\(jsonb\) to service_role/);
  assert.match(sql,/revoke all on public\.telemetry_observations from public,anon,authenticated,service_role/);
  assert.match(sql,/v\.agency_id=any\(\(select public\.my_agency_ids\(\)\)/);
  assert.match(sql,/Texat device binding is not configured/);
  assert.match(sql,/Historical telemetry event cannot be rebound/);
  assert.match(sql,/o-'receivedAt'/);
  assert.doesNotMatch(sql,/alter publication[^;]*telemetry_observations/i);
});

test('earnings semantic correction preserves the reported aggregate separately and blocks unaudited old net values',async()=>{
  const entry=manifest.candidates.find(item=>item.version==='20261226000000');
  const sql=await fs.readFile(path.join(REPOSITORY,'staging/supabase/migrations',entry.file),'utf8');
  assert.match(sql,/Historical net amounts require a semantic audit; no automatic rewrite/);
  assert.match(sql,/create or replace function public\.provider_earnings_amounts_valid/);
  assert.match(sql,/not\(p_snapshot->'fleet' \? 'reported_net_earnings_minor'\)/);
  assert.match(sql,/not\(entry \? 'reported_net_earnings_minor'\)/);
  assert.match(sql,/'commission_minor','reported_net_earnings_minor'\]/);
  assert.doesNotMatch(sql,/set\s+(?:fleet_amounts|amounts)\s*=/i);
  const runner=await fs.readFile(path.join(REPOSITORY,'staging/scripts/migrate-local.mjs'),'utf8');
  assert.match(runner,/\['20261225000000','telemetry_continuity'\]/);
  assert.match(runner,/\['20261226000000','provider_earnings_semantics'\]/);
});

test('earnings window selection is bounded, invoker-only and leaves historical amounts untouched',async()=>{
  const entry=manifest.candidates.find(item=>item.version==='20261227000000');
  const sql=(await fs.readFile(path.join(REPOSITORY,'staging/supabase/migrations',entry.file),'utf8')).replace(/--[^\n]*/g,'');
  assert.deepEqual(entry.createdRelations,[]);assert.deepEqual(entry.publishedRelations,[]);
  assert.deepEqual(entry.definedFunctions,['provider_earnings_select_windows']);
  assert.match(sql,/language plpgsql stable security invoker set search_path = ''/);
  assert.match(sql,/caller_role not in \('admin','manager'\)/);
  assert.match(sql,/fleet_scope:=caller_role='admin' and p_agency_id is null and p_driver_code is null/);
  assert.match(sql,/where not fleet_scope/);assert.match(sql,/where fleet_scope/);
  assert.match(sql,/partition by organization_id,currency/);
  assert.match(sql,/order by complete desc,observed_at desc,revision desc,snapshot_id/);
  assert.match(sql,/\(period_start=p_start and period_end=p_end\) or preferred=1/);
  assert.match(sql,/limit 101/);assert.match(sql,/cardinality\(selected_ids\)>100/);
  assert.match(sql,/from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.provider_earnings_select_windows[\s\S]+to authenticated/);
  assert.doesNotMatch(sql,/\b(?:security definer|insert into|update public|delete from|alter policy|alter publication|fleet_amounts)\b/i);
  const runner=await fs.readFile(path.join(REPOSITORY,'staging/scripts/migrate-local.mjs'),'utf8');
  assert.match(runner,/\['20261227000000','provider_earnings_selection'\]/);
});

test('a changed historical file is refused, even when only one copy changed', async t => {
  const root = await fixture(t);
  await fs.appendFile(path.join(root, 'supabase/migrations', manifest.baseline[0].file), '\n-- changed\n');
  await assert.rejects(verifySources(root), /Empreinte SQL différente/);
});

test('new, removed or symlinked migrations cannot silently change the lot', async t => {
  for (const kind of ['extra','missing','symlink']) await t.test(kind, async sub => {
    const root = await fixture(sub), directory = path.join(root, 'staging/supabase/migrations');
    const filename = path.join(directory, manifest.candidates[0].file);
    if (kind === 'extra') await fs.writeFile(path.join(directory, '20990101000000_unreviewed.sql'), 'select 1;');
    else {
      await fs.unlink(filename);
      if (kind === 'symlink') await fs.symlink(path.join(REPOSITORY, 'staging/supabase/migrations', manifest.candidates[0].file), filename);
    }
    await assert.rejects(verifySources(root), /Inventaire SQL différent|Fichier ordinaire/);
  });
});

test('malformed manifests cannot select traversal paths, duplicates or unordered versions', () => {
  for (const mutate of [
    value => { value.candidates[0].file = '../seed.sql'; },
    value => { value.candidates[1] = {...value.candidates[0]}; },
    value => { value.candidates.reverse(); },
    value => { value.executionAllowed = true; },
  ]) {
    const value = structuredClone(manifest); mutate(value);
    assert.throws(() => validateManifest(value));
  }
});

test('a plan without real inventory cannot infer pending production migrations', () => {
  const plan = promotionPlan(manifest);
  assert.equal(plan.executionAvailable, false);
  assert.equal(plan.readyForProduction, false);
  assert.ok(plan.blockers.includes('PRODUCTION_METADATA_NOT_COLLECTED'));
  assert.ok(plan.candidates.every(entry => entry.history === 'unknown'));
});

test('metadata versions distinguish absence, unknown changes and gaps without authorizing a migration', () => {
  const baseline = manifest.baseline.map(entry => entry.version);
  const complete = promotionPlan(manifest, inventory([...baseline, ...manifest.candidates.map(entry => entry.version)]));
  assert.equal(complete.readyForProduction, false);
  assert.equal(complete.candidates[0].history, 'recorded-review-schema');
  assert.ok(complete.blockers.includes('CATALOG_AND_DATA_EFFECT_REVIEW_REQUIRED'));
  const incomplete = promotionPlan(manifest, inventory(baseline.slice(1)));
  assert.deepEqual(incomplete.missingBaseline, [baseline[0]]);
  assert.ok(incomplete.blockers.includes('BASELINE_HISTORY_INCOMPLETE_DO_NOT_REPLAY_BASELINE'));
  const extra = promotionPlan(manifest, inventory([...baseline, '20990101000000']));
  assert.deepEqual(extra.unknownApplied, ['20990101000000']);
  const gap = promotionPlan(manifest, inventory([...baseline, manifest.candidates[1].version]));
  assert.ok(gap.blockers.includes('NONCONTIGUOUS_CANDIDATE_HISTORY'));
  const absent = inventory([]); absent.history.available = false;
  assert.ok(promotionPlan(manifest, absent).blockers.includes('MIGRATION_HISTORY_UNAVAILABLE_RECONCILE_SCHEMA_MANUALLY'));
});

test('inventory accepts one tagged NOTICE and rejects unsafe or incomplete inputs', () => {
  const value = inventory();
  assert.deepEqual(parseInventory('BEGIN\npsql:inventory.sql:1: NOTICE:  LUDY_MIGRATION_INVENTORY ' + JSON.stringify(value) + '\nROLLBACK\n'), value);
  assert.deepEqual(parseInventory(JSON.stringify([{inventory_json: value}])), value);
  assert.deepEqual(parseInventory(JSON.stringify({inventory_json: JSON.stringify(value)})), value);
  assert.throws(() => parseInventory(JSON.stringify([{inventory_json: value}, {inventory_json: value}])));
  assert.throws(() => parseInventory(JSON.stringify({inventory_json: value, extra: 'ambiguous'})));
  for (const mutate of [
    v => { v.transactionReadOnly = false; },
    v => { v.history.versions.push(v.history.versions[0]); },
    v => { v.history.versions.push('select 1;'); },
    v => { v.history.versions[0] = Number(v.history.versions[0]); },
    v => { delete v.catalogs.functions; },
    v => { v.history.available = false; },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.throws(() => parseInventory(JSON.stringify(changed)));
  }
  const notice = 'LUDY_MIGRATION_INVENTORY ' + JSON.stringify(value);
  assert.throws(() => parseInventory(notice + '\n' + notice), /Plusieurs inventaires/);
  assert.throws(() => parseInventory('x'.repeat(4 * 1024 * 1024 + 1)), /volumineux/);
});

test('the CLI refuses mutation and connection flags', async () => {
  for (const args of [['--apply'],['--reset'],['--bootstrap'],['--database-url','postgres://invalid'],['--inventory','--apply']]) {
    await assert.rejects(main(args), /Seule option permise/);
  }
});

test('the inventory template is bounded, read-only and does not return business data or routine bodies', async () => {
  const sql = await fs.readFile(path.join(HERE, 'migrations-inventory.sql'), 'utf8');
  const uncommented = sql.replace(/--[^\n]*/g, '');
  assert.match(uncommented, /^\s*begin transaction isolation level repeatable read read only;/);
  assert.match(uncommented, /set local statement_timeout = '15s'/);
  assert.match(uncommented, /rollback;\s*$/);
  assert.doesNotMatch(uncommented, /\b(?:create|alter|insert|update|delete|truncate|grant|revoke|copy|call)\b/i);
  assert.doesNotMatch(uncommented, /\bfrom\s+(?:public\.|auth\.users|storage\.objects|cron\.job)/i);
  assert.match(uncommented, /md5\(pg_get_functiondef\(p\.oid\)\)/);
  assert.match(uncommented, /LUDY_MIGRATION_INVENTORY %/);
});

test('the SQL Editor variant preserves the full read-only snapshot and returns a final JSON cell with session cleanup', async () => {
  const source = await fs.readFile(path.join(HERE, 'migrations-inventory.sql'), 'utf8');
  const editor = await fs.readFile(path.join(HERE, 'migrations-inventory-editor.sql'), 'utf8');
  const beforeOutput = sql => sql.slice(sql.indexOf('do $inventory$'), sql.indexOf('  result :=')).trim();
  assert.equal(beforeOutput(editor), beforeOutput(source));
  const resultObject = sql => sql.slice(sql.indexOf('  result :='), sql.indexOf("  );", sql.indexOf('  result :=')) + 4);
  assert.equal(resultObject(editor), resultObject(source));
  const uncommented = editor.replace(/--[^\n]*/g, '');
  assert.match(uncommented, /^\s*begin transaction isolation level repeatable read read only;/);
  assert.match(uncommented, /current_setting\('transaction_read_only'\) <> 'on'/);
  assert.match(uncommented, /end \$inventory\$;\s*commit;\s*with captured as materialized/);
  assert.match(uncommented, /cleared as materialized \(\s*select set_config\('ludy_inventory_editor.result', '', false\) as state from captured/);
  assert.match(uncommented, /select captured.inventory_json\s+from captured cross join cleared/);
  assert.doesNotMatch(uncommented, /\b(?:create|alter|insert|update|delete|truncate|grant|revoke|copy|call)\b/i);
});
