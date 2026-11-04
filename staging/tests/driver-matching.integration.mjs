// Local SQL fixtures are invisible to other sessions and always rolled back.
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();
const q=v=>"'"+String(v).replaceAll("'","''")+"'",suffix=randomUUID(),a=randomUUID(),b=randomUUID(),c=randomUUID(),ia=randomUUID(),ib=randomUUID(),ic=randomUUID();
const agency=Date.now()*1000+randomInt(999),car='AUTO_CAR_'+suffix,code='AUTO_DRIVER_'+suffix,code2='AUTO_DRIVER_B_'+suffix;
let checks=0;
const check=condition=>{checks++;return `do $$ begin if not (${condition}) then raise exception 'automatic matching assertion ${checks}'; end if; end $$;`;};
const proof=`jsonb_build_object('method','platform_plate','source','bolt','vehicle_origin','bolt_live','observed_at',now(),'expires_at',now()+interval '150 seconds')`;
const sql=["begin; set local statement_timeout='20s'; set local lock_timeout='2s'; set local client_min_messages=warning;",LOCAL_GUARD,
`insert into agencies(id,name) overriding system value values(${agency},'Synthetic association test');
insert into vehicles(key,plate,agency_id) values(${q(car)},'TEST-AUTO',${agency});
insert into drivers(code,name,agency_id,source) values(${q(code)},'Synthetic Ada Operator',${agency},'manuel'),(${q(code2)},'Synthetic Bob Operator',${agency},'manuel');
insert into fleet_drivers(id,name) values(${q(a)},'Synthetic Ada Operator'),(${q(b)},'Synthetic Ada Operator'),(${q(c)},'Synthetic Bob Operator');
update fleet_sources set status='healthy',last_success_at=now(),stale_after_s=150 where id='bolt';
insert into fleet_identities(id,driver_id,source,source_key) values(${q(ia)},${q(a)},'uber',${q('auto-a-'+suffix)}),(${q(ib)},${q(b)},'bolt',${q('auto-b-'+suffix)}),(${q(ic)},${q(c)},'bolt',${q('auto-c-'+suffix)});
set local role service_role;`,
check(`fleet_auto_link_driver(${q(a)},${q(code)},'wrong name','Synthetic Ada Operator') is null`),
check(`fleet_auto_link_driver(${q(a)},${q(code)},'Synthetic Ada Operator','Synthetic Ada Operator')=${q(a)}::uuid`),
check(`fleet_auto_link_driver(${q(b)},${q(code)},'Synthetic Ada Operator','Synthetic Ada Operator')=${q(a)}::uuid`),
check(`(select count(*) from fleet_identities where driver_id=${q(a)})=2 and not exists(select 1 from fleet_drivers where id=${q(b)})`),
check(`(select link_method='exact_name' and not auto_link_disabled from fleet_drivers where id=${q(a)})`),
`insert into fleet_latest(identity_id,driver_id,source,status,observed_at,received_at,vehicle_label,evidence) values(${q(ib)},${q(a)},'bolt','on_trip',now(),now(),'TEST-AUTO','{"method":"official_api","vehicle_origin":"bolt_live"}');`,
check(`fleet_auto_link_vehicle(${q(a)},${q(car)},${proof})`),
check(`fleet_auto_link_driver(${q(c)},${q(code2)},'Synthetic Bob Operator','Synthetic Bob Operator')=${q(c)}::uuid`),
`insert into fleet_latest(identity_id,driver_id,source,status,observed_at,received_at,vehicle_label,evidence) values(${q(ic)},${q(c)},'bolt','on_trip',now(),now(),'TEST-AUTO','{"method":"official_api","vehicle_origin":"bolt_live"}');`,
check(`not fleet_auto_link_vehicle(${q(c)},${q(car)},${proof})`),
`update fleet_latest set status='offline' where identity_id=${q(ib)};
update fleet_drivers set vehicle_link_evidence=jsonb_build_object('expires_at',now()-interval '1 second') where id=${q(a)};`,
check(`fleet_auto_link_vehicle(${q(c)},${q(car)},${proof})`),
check(`(select vehicle_key is null from fleet_drivers where id=${q(a)})`),
check(`fleet_link_driver(${q(c)},${q(code2)},null,null)=${q(c)}::uuid`),
check(`not fleet_auto_link_vehicle(${q(c)},${q(car)},${proof})`),
check(`(select auto_link_disabled and vehicle_key is null from fleet_drivers where id=${q(c)})`),
check(`(select count(*) from fleet_link_audit where driver_id in (${q(a)},${q(c)}))>=5`),
'reset role; set local role authenticated;',
`do $$ declare rejected boolean:=false; begin begin perform fleet_auto_link_vehicle(${q(a)},${q(car)},${proof}); exception when insufficient_privilege then rejected:=true; end; if not rejected then raise exception 'client automatic RPC forbidden'; end if; end $$;`,
'rollback;'].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const r=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']),{env,input:sql,encoding:'utf8',timeout:30000});
assert.equal(r.status,0,'Local automatic association checks failed: '+String(r.stderr||'').replaceAll(suffix,'<fixture>'));
console.log(JSON.stringify({ok:true,checks:checks+1,rolled_back:true}));
