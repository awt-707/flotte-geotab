// Pinned local Supabase only. Synthetic fixtures and every check roll back together.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';

assertLocalProject();
const id1=randomUUID(),id2=randomUUID(),driver=randomUUID(),car='CHECKPOINT_TEST_'+randomUUID();
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const row=id=>({identity_id:id,vehicle_key:car,source:'bolt',updated_at:new Date().toISOString(),
  state:{version:1,identity_id:id,vehicle_key:car,source:'bolt',distance_m:100}});
const payload=rows=>q(JSON.stringify(rows))+'::jsonb';
let checks=0;
const check=(condition,label)=>{checks++;return `do $test$ begin if not (${condition}) then raise exception 'checkpoint-test: ${label}'; end if; end $test$;`;};
const denied=(statement,label,error='insufficient_privilege')=>{checks++;return `do $test$ declare refused boolean:=false; begin
  begin ${statement}; exception when ${error} then refused:=true; end;
  if not refused then raise exception 'checkpoint-test: ${label}'; end if; end $test$;`;};
const save=rows=>`perform public.fleet_save_motion_checkpoints(${payload(rows)})`;
const sql=[
  "begin; set local statement_timeout='20s'; set local lock_timeout='2s'; set local client_min_messages=warning;",LOCAL_GUARD,
  check("to_regclass('public.fleet_motion_checkpoints') is not null",'migration_missing'),
  `insert into public.vehicles(key,plate) values(${q(car)},'CHECKPOINT-SYNTHETIC');`,
  `insert into public.fleet_drivers(id,name) values(${q(driver)},'Synthetic checkpoint driver');`,
  `insert into public.fleet_identities(id,driver_id,source,source_key) values
    (${q(id1)},${q(driver)},'bolt',${q('checkpoint-'+id1)}),(${q(id2)},${q(driver)},'bolt',${q('checkpoint-'+id2)});`,
  'set local role authenticated;',
  denied('perform 1 from public.fleet_motion_checkpoints limit 1','authenticated_read_allowed'),
  denied(save([row(id1)]),'authenticated_checkpoint_rpc_allowed'),
  'reset role; set local role anon;',
  denied('perform 1 from public.fleet_motion_checkpoints limit 1','anonymous_read_allowed'),
  denied(save([]),'anonymous_checkpoint_rpc_allowed'),
  'reset role; set local role service_role;',
  `select public.fleet_save_motion_checkpoints(${payload([row(id1),row(id2)])});`,
  check(`(select count(*) from public.fleet_motion_checkpoints)=2`,'service_snapshot_not_saved'),
  `select public.fleet_save_motion_checkpoints(${payload([row(id1)])});`,
  check(`(select count(*) from public.fleet_motion_checkpoints)=1 and exists(select 1 from public.fleet_motion_checkpoints where identity_id=${q(id1)})`,'stale_checkpoint_not_removed'),
  denied(save([row(id1),row(id1)]),'duplicate_snapshot_accepted','cardinality_violation'),
  check(`exists(select 1 from public.fleet_motion_checkpoints where identity_id=${q(id1)})`,'invalid_snapshot_was_not_atomic'),
  denied(save([row(randomUUID())]),'missing_identity_accepted','foreign_key_violation'),
  check(`exists(select 1 from public.fleet_motion_checkpoints where identity_id=${q(id1)})`,'foreign_key_failure_deleted_old_snapshot'),
  `delete from public.fleet_identities where id=${q(id1)};`,
  check('(select count(*) from public.fleet_motion_checkpoints)=0','identity_delete_not_cascaded'),
  'reset role; rollback;',"select 'CHECKPOINT_RLS_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']),{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
if(result.error||result.status!==0){
  const label=String(result.stderr||'').match(/checkpoint-test: ([a-z_]+)/)?.[1];
  throw new Error('Local checkpoint validation failed; transaction rolled back.'+(label?' Check: '+label:' No database output disclosed.'));
}
assert.equal(result.stdout.trim(),'CHECKPOINT_RLS_ROLLBACK_OK');
console.log(JSON.stringify({ok:true,checks,rolled_back:true}));
