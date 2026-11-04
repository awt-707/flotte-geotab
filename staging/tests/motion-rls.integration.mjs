// Explicit integration check against the pinned local Docker socket and database.
// All fixtures, users and assertions live in one transaction, which always rolls back.
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LOCAL_GUARD, dockerArgs } from '../scripts/import-reference.mjs';
import { assertLocalProject } from '../scripts/guard.mjs';

assertLocalProject();
const suffix = randomUUID(), q = value => "'" + String(value).replaceAll("'", "''") + "'";
const ids = Object.fromEntries(['manager', 'viewer', 'admin', 'driverA', 'driverB', 'crossA', 'crossB', 'pending', 'conflict',
  'identityA', 'identityB', 'identityCrossA', 'identityCrossB', 'identityPending',
  'alertA', 'alertB', 'alertCrossA', 'alertCrossB', 'alertPending', 'oldAlert', 'invalidAlert'].map(key => [key, randomUUID()]));
const agencyA = Date.now() * 1000 + randomInt(999), agencyB = agencyA + 1;
const carA = 'MOTION_TEST_A_' + suffix, carB = 'MOTION_TEST_B_' + suffix;
const ludyA = 'MOTION_DRIVER_A_' + suffix, ludyB = 'MOTION_DRIVER_B_' + suffix;
const alertIDs = ['alertA', 'alertB', 'alertCrossA', 'alertCrossB', 'alertPending'].map(key => q(ids[key])).join(',');
let checks = 0;
const check = (condition, label) => {
  checks++;
  return `do $test$ begin if not (${condition}) then raise exception 'motion-test: ${label}'; end if; end $test$;`;
};
const denied = (statement, label, error = 'insufficient_privilege') => {
  checks++;
  return `do $test$ declare refused boolean:=false; begin
    begin ${statement}; exception when ${error} then refused:=true; end;
    if not refused then raise exception 'motion-test: ${label}'; end if;
  end $test$;`;
};
const auth = key => `reset role; set local role authenticated;
set local request.jwt.claim.sub=${q(ids[key])};
set local request.jwt.claims=${q(JSON.stringify({ sub: ids[key], role: 'authenticated' }))};`;
const insertAlert = (id, driver, identity, vehicle, source) =>
  `insert into public.fleet_motion_alerts(id,driver_id,identity_id,vehicle_key,source,observed_since,distance_m,evidence)
   values(${q(ids[id])},${q(ids[driver])},${q(ids[identity])},${q(vehicle)},${q(source)},now()-interval '2 minutes',245,'{"test":true}');`;

const sql = [
  "begin; set local statement_timeout='20s'; set local lock_timeout='2s'; set local client_min_messages=warning;",
  LOCAL_GUARD,
  check("to_regclass('public.fleet_motion_alerts') is not null", 'migration_missing'),
  `insert into public.agencies(id,name) overriding system value values
   (${agencyA},${q('Motion RLS test A ' + suffix)}),(${agencyB},${q('Motion RLS test B ' + suffix)});`,
  `insert into public.vehicles(key,plate,agency_id) values (${q(carA)},'TEST-MOTION-A',${agencyA}),(${q(carB)},'TEST-MOTION-B',${agencyB});`,
  `insert into public.drivers(code,name,agency_id,source) values
   (${q(ludyA)},'Synthetic motion driver A',${agencyA},'manuel'),(${q(ludyB)},'Synthetic motion driver B',${agencyB},'manuel');`,
  `insert into auth.users(id,email,aud,role) values
   (${q(ids.manager)},${q('motion-manager-' + suffix + '@example.invalid')},'authenticated','authenticated'),
   (${q(ids.viewer)},${q('motion-viewer-' + suffix + '@example.invalid')},'authenticated','authenticated'),
   (${q(ids.admin)},${q('motion-admin-' + suffix + '@example.invalid')},'authenticated','authenticated');`,
  `update public.profiles set role='manager' where user_id=${q(ids.manager)};
   update public.profiles set role='viewer' where user_id=${q(ids.viewer)};
   update public.profiles set role='admin' where user_id=${q(ids.admin)};
   insert into public.user_agencies(user_id,agency_id) values (${q(ids.manager)},${agencyA}),(${q(ids.viewer)},${agencyB});`,
  `insert into public.fleet_drivers(id,name,ludy_driver_code,vehicle_key,agency_id) values
   (${q(ids.driverA)},'Synthetic A',${q(ludyA)},${q(carA)},${agencyA}),
   (${q(ids.driverB)},'Synthetic B',${q(ludyB)},${q(carB)},${agencyB}),
   (${q(ids.crossA)},'Synthetic cross A',null,${q(carB)},${agencyA}),
   (${q(ids.crossB)},'Synthetic cross B',null,${q(carA)},${agencyB}),
   (${q(ids.pending)},'Synthetic pending merge',null,null,${agencyA}),
   (${q(ids.conflict)},'Synthetic conflicting assignment',null,null,${agencyA});`,
  `insert into public.fleet_identities(id,driver_id,source,source_key) values
   (${q(ids.identityA)},${q(ids.driverA)},'uber',${q('motion-a-' + suffix)}),
   (${q(ids.identityB)},${q(ids.driverB)},'bolt',${q('motion-b-' + suffix)}),
   (${q(ids.identityCrossA)},${q(ids.crossA)},'uber',${q('motion-cross-a-' + suffix)}),
   (${q(ids.identityCrossB)},${q(ids.crossB)},'bolt',${q('motion-cross-b-' + suffix)}),
   (${q(ids.identityPending)},${q(ids.pending)},'bolt',${q('motion-pending-' + suffix)});`,
  insertAlert('alertA', 'driverA', 'identityA', carA, 'uber'),
  insertAlert('alertB', 'driverB', 'identityB', carB, 'bolt'),
  insertAlert('alertCrossA', 'crossA', 'identityCrossA', carB, 'uber'),
  insertAlert('alertCrossB', 'crossB', 'identityCrossB', carA, 'bolt'),
  insertAlert('alertPending', 'pending', 'identityPending', carA, 'bolt'),
  `insert into public.fleet_alerts(id,driver_id,identity_id,source,observed_since,threshold_s,rule)
   values(${q(ids.oldAlert)},${q(ids.pending)},${q(ids.identityPending)},'bolt',now()-interval '2 minutes',60,'Synthetic test threshold');`,
  auth('manager'),
  check(`(select count(*) from public.fleet_motion_alerts where id in (${alertIDs}))=2`, 'manager_own_agency_only'),
  check(`not exists(select 1 from public.fleet_motion_alerts where id=${q(ids.alertCrossA)})`, 'vehicle_scope_required'),
  check(`not exists(select 1 from public.fleet_motion_alerts where id=${q(ids.alertCrossB)})`, 'driver_scope_required'),
  denied(`update public.fleet_motion_alerts set status='resolved' where id=${q(ids.alertA)}`, 'authenticated_update_allowed'),
  denied(`delete from public.fleet_motion_alerts where id=${q(ids.alertA)}`, 'authenticated_delete_allowed'),
  denied(`insert into public.fleet_motion_alerts(id,driver_id,identity_id,vehicle_key,source,observed_since,distance_m)
    values(${q(ids.invalidAlert)},${q(ids.driverA)},${q(ids.identityA)},${q(carA)},'uber',now(),250)`, 'authenticated_insert_allowed'),
  denied(`perform public.fleet_link_driver(${q(ids.pending)},${q(ludyA)},null,null)`, 'authenticated_link_rpc_allowed'),
  auth('viewer'),
  check(`(select count(*) from public.fleet_motion_alerts where id in (${alertIDs}))=1`, 'viewer_own_agency_only'),
  check(`exists(select 1 from public.fleet_motion_alerts where id=${q(ids.alertB)})`, 'viewer_own_alert_missing'),
  auth('admin'),
  check(`(select count(*) from public.fleet_motion_alerts where id in (${alertIDs}))=5`, 'admin_all_scopes'),
  denied(`perform public.fleet_link_driver(${q(ids.pending)},${q(ludyA)},null,null)`, 'admin_authenticated_rpc_allowed'),
  'reset role; set local role anon;',
  denied('perform 1 from public.fleet_motion_alerts limit 1', 'anonymous_read_allowed'),
  'reset role; set local role service_role;',
  // Cross-scope fixtures exercise RLS, then release their deliberately inconsistent assignments.
  `update public.fleet_drivers set vehicle_key=null where id in (${q(ids.crossA)},${q(ids.crossB)});`,
  check(`public.fleet_link_driver(${q(ids.pending)},${q(ludyA)},${q(carA)},null)=${q(ids.driverA)}::uuid`, 'service_merge_target'),
  check(`exists(select 1 from public.fleet_motion_alerts where id=${q(ids.alertPending)} and driver_id=${q(ids.driverA)} and identity_id=${q(ids.identityPending)})`, 'merge_preserves_movement_alert'),
  check(`exists(select 1 from public.fleet_alerts where id=${q(ids.oldAlert)} and driver_id=${q(ids.driverA)})`, 'merge_preserves_threshold_alert'),
  check(`exists(select 1 from public.fleet_identities where id=${q(ids.identityPending)} and driver_id=${q(ids.driverA)}) and not exists(select 1 from public.fleet_drivers where id=${q(ids.pending)})`, 'merge_preserves_identity'),
  check(`public.fleet_link_driver(${q(ids.driverA)},${q(ludyA)},null,null)=${q(ids.driverA)}::uuid`, 'explicit_unassign_rpc'),
  check(`exists(select 1 from public.fleet_drivers where id=${q(ids.driverA)} and vehicle_key is null) and exists(select 1 from public.fleet_motion_alerts where id=${q(ids.alertPending)})`, 'unassign_preserves_incident'),
  `update public.fleet_drivers set vehicle_key=${q(carA)} where id=${q(ids.conflict)};`,
  denied(`perform public.fleet_link_driver(${q(ids.driverA)},${q(ludyA)},${q(carA)},null)`, 'duplicate_vehicle_assignment_allowed', 'raise_exception'),
  check(`exists(select 1 from public.fleet_drivers where id=${q(ids.driverA)} and vehicle_key is null)`, 'failed_assignment_changed_driver'),
  denied(`perform public.fleet_link_driver(${q(ids.driverB)},${q(ludyB)},${q(carA)},null)`, 'cross_agency_assignment_allowed', 'raise_exception'),
  denied(`insert into public.fleet_motion_alerts(id,driver_id,identity_id,vehicle_key,source,observed_since,distance_m)
    values(${q(ids.invalidAlert)},${q(ids.driverA)},${q(ids.identityA)},${q(carA)},'uber',now(),200)`, 'threshold_constraint_missing', 'check_violation'),
  'reset role; rollback;',
  "select 'MOTION_RLS_ROLLBACK_OK';"
].join('\n');

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result = spawnSync('docker', dockerArgs('psql', ['-X', '-qAt', '--set=ON_ERROR_STOP=1', '--file=/dev/stdin']), {
  env, input: sql, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024
});
if (result.error || result.status !== 0) {
  const label = String(result.stderr || '').match(/motion-test: ([a-z_]+)/)?.[1];
  throw new Error('Local movement RLS check failed; transaction disconnected and rolled back.' + (label ? ' Check: ' + label : ' No database output disclosed.'));
}
assert.equal(result.stdout.trim(), 'MOTION_RLS_ROLLBACK_OK');
console.log(JSON.stringify({ ok: true, checks, rolled_back: true }));
