import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {normalizeTelemetryObservation} from '../server/telemetry-continuity.mjs';

assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(arg=>arg!=='--with-migration'))throw Error('Only --with-migration is supported.');
const simulate=args.includes('--with-migration'),now=Date.now(),suffix=randomUUID(),agency=now*1000+randomInt(500);
const vehicleA='STG-TELEMETRY-A-'+suffix,vehicleB='STG-TELEMETRY-B-'+suffix,deviceA='device-a-'+suffix,deviceB='device-b-'+suffix;
const roles=['admin','manager','viewer','pending'],users=Object.fromEntries(roles.map(role=>[role,randomUUID()]));
const iso=at=>new Date(at).toISOString(),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function counter({vehicle=vehicleA,device=deviceA,at=now-3600000,value=100,received=now-60000,source='geotab'}={}){
 const id=hash([source,device,'counter','DiagnosticOdometerId',iso(at)]);
 const observation=normalizeTelemetryObservation({id,vehicleKey:vehicle,source,sourceId:device,kind:'counter',quality:'good',observedAt:iso(at),receivedAt:iso(received),metric:'distance_km',value,counterId:'DiagnosticOdometerId',counterEpoch:null,counterMeaning:'odometer'});
 return {source,source_event_id:id,device_id:device,vehicle_key:vehicle,observed_at:iso(at),collected_at:iso(received),observation,origin:{field:'odometer_m',unit:'m',raw_value:value*1000,sample_at:iso(at)}};
}
const first=counter(),second=counter({vehicle:vehicleB,device:deviceB}),changed=counter({value:101}),replay=counter({received:now}),late=counter({at:now-86400000,value:95});
const gpsId=hash(['geotab',deviceA,'gps',iso(now-300000)]);
const gps={source:'geotab',source_event_id:gpsId,device_id:deviceA,vehicle_key:vehicleA,observed_at:iso(now-300000),collected_at:iso(now-60000),observation:normalizeTelemetryObservation({id:gpsId,vehicleKey:vehicleA,source:'geotab',sourceId:deviceA,kind:'gps',quality:'good',observedAt:iso(now-300000),receivedAt:iso(now-60000),latitude:33.5,longitude:-7.5,accuracyM:null}),origin:{field:'position',unit:'deg',raw_value:null,sample_at:iso(now-300000)}};
const invalid=counter({at:now-600000});invalid.origin.unit='L';
const extra=counter({at:now-1200000});extra.observation.secret='must-not-enter-archive';
const texat=counter({source:'texat'}),rebound=counter({vehicle:vehicleB,device:deviceA});
const q=value=>"'"+String(value).replaceAll("'","''")+"'",j=value=>q(JSON.stringify(value))+'::jsonb';
const call=events=>`public.telemetry_archive_ingest(${j(events)})`;
const owner="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const service=owner+'set local role service_role;';
const auth=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub:users[role],role:'authenticated'}))};`;
const scope=`vehicle_key in (${q(vehicleA)},${q(vehicleB)})`,count=`(select count(*) from public.telemetry_observations where ${scope})`;
let checks=0;
const check=(condition,label)=>{checks++;return `do $t$ begin if (${condition}) is distinct from true then raise exception 'telemetry-test: ${label}';end if;end $t$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $t$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'telemetry-test: ${label}';end if;end $t$;`;};
const migration=readFileSync(new URL('../supabase/migrations/20261225000000_telemetry_continuity.sql',import.meta.url),'utf8');
const sql=["begin;set local statement_timeout='25s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,...(simulate?[migration]:[]),
 `insert into public.agencies(id,name,city) overriding system value values (${agency},'Synthetic telemetry A','Casablanca'),(${agency+1},'Synthetic telemetry B','Marrakech');`,
 `insert into public.vehicles(key,plate,agency_id,geotab_id) values (${q(vehicleA)},'STG-TELEMETRY-A',${agency},${q(deviceA)}),(${q(vehicleB)},'STG-TELEMETRY-B',${agency+1},${q(deviceB)});`,
 `insert into auth.users(id,email,aud,role) values ${roles.map(role=>`(${q(users[role])},${q('telemetry-'+role+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...roles.map(role=>`update public.profiles set role=${q(role)} where user_id=${q(users[role])};`),
 `insert into public.user_agencies(user_id,agency_id) values (${q(users.manager)},${agency}),(${q(users.viewer)},${agency});`,
 service,check(`(${call([first,second,gps])}->>'inserted')::integer=3`,'initial_batch'),check(`${count}=3`,'initial_rows'),
 check(`(select received_at>collected_at and agency_id_at_receipt=${agency} and mapping_basis='current_at_receipt' from public.telemetry_observations where source_event_id=${q(first.source_event_id)})`,'timestamps_and_mapping_provenance'),
 check(`(${call([replay])}->>'duplicates')::integer=1`,'repeat_poll_idempotent'),
 check(`(select version=1 and collected_at=${q(first.collected_at)}::timestamptz from public.telemetry_observations where source_event_id=${q(first.source_event_id)})`,'duplicate_does_not_rewrite_first_reception'),
 check(`(${call([changed])}->>'conflicts')::integer=1`,'changed_measurement_is_conflicting_version'),
 check(`(select count(*)=2 and min(version)=1 and max(version)=2 and min((observation->>'value')::numeric)=100 and max((observation->>'value')::numeric)=101 from public.telemetry_observations where source_event_id=${q(first.source_event_id)})`,'both_versions_preserved'),
 check(`(${call([late])}->>'inserted')::integer=1`,'late_arrival_is_preserved'),
 check(`(select observed_at=${q(late.observed_at)}::timestamptz and received_at>observed_at+interval '23 hours' from public.telemetry_observations where source_event_id=${q(late.source_event_id)})`,'late_measurement_keeps_actual_time'),
 check(`${count}=5`,'rows_before_rejections'),
 reject(`perform ${call([counter({at:now-900000}),invalid])}`,'bad_batch_rolls_back_all_events'),check(`${count}=5`,'atomic_batch_rollback'),
 reject(`perform ${call([extra])}`,'unknown_observation_fields_refused'),reject(`perform ${call([texat])}`,'texat_requires_confirmed_connector'),
 reject(`perform ${call(Array(501).fill(first))}`,'oversized_batch_refused'),
 ...roles.flatMap(role=>[auth(role),check(`${count}=${role==='admin'?5:role==='manager'?4:0}`,role+'_rls'),reject(`perform ${call([first])}`,role+'_cannot_ingest','insufficient_privilege'),reject(`update public.telemetry_observations set version=99 where ${scope}`,role+'_cannot_rewrite','insufficient_privilege')]),
 service,reject(`delete from public.telemetry_observations where ${scope}`,'service_cannot_delete','insufficient_privilege'),reject(`insert into public.telemetry_observations default values`,'service_cannot_bypass_rpc','insufficient_privilege'),
 owner,reject(`delete from public.telemetry_observations where ${scope}`,'owner_accidental_delete_guard'),
 `update public.vehicles set geotab_id=${q(deviceA)} where key=${q(vehicleB)};`,service,reject(`perform ${call([first])}`,'ambiguous_device_binding_refused'),
 owner,`update public.vehicles set geotab_id=null where key=${q(vehicleA)};`,service,reject(`perform ${call([rebound])}`,'historical_event_not_rebound'),
 owner,`update public.vehicles set geotab_id=${q(deviceB)} where key=${q(vehicleB)};update public.vehicles set geotab_id=${q(deviceA)},agency_id=${agency+1} where key=${q(vehicleA)};`,
 auth('manager'),check(`${count}=0`,'current_agency_revocation_applies_to_archive'),
 auth('admin'),check(`(select bool_and(agency_id_at_receipt=${agency}) from public.telemetry_observations where vehicle_key=${q(vehicleA)})`,'recorded_receipt_agency_is_not_rewritten'),
 owner,check("not exists(select 1 from pg_publication_tables where schemaname='public' and tablename='telemetry_observations')",'no_position_publication'),
 'set local role anon;',reject('perform 1 from public.telemetry_observations limit 1','anonymous_cannot_read','insufficient_privilege'),
 owner,"rollback;select 'TELEMETRY_CONTINUITY_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(value=>value==='--username=postgres'?'--username=supabase_admin':value),{env,input:sql,encoding:'utf8',timeout:45000,maxBuffer:1048576});
if(result.error||result.status!==0){const error=String(result.stderr||''),label=error.match(/telemetry-test: ([a-zA-Z0-9_]+)/)?.[1],state=error.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1],known=[...migration.matchAll(/raise exception '([^']+)'/g)].map(m=>m[1]).find(message=>error.includes(': '+message+'\n'));throw Error('Telemetry rehearsal rolled back: '+(label||known||state||'local execution failure'));}
assert.equal(result.stdout.trim(),'TELEMETRY_CONTINUITY_ROLLBACK_OK');
console.log(JSON.stringify({ok:true,checks,target:'local-staging-only',migrationSimulated:simulate,rolledBack:true}));
