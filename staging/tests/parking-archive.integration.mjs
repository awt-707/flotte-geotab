import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomInt,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
assertLocalProject();const args=process.argv.slice(2);if(args.length>1||args.some(x=>x!=='--with-migration'))throw Error('Only --with-migration supported');
const simulate=args.includes('--with-migration'),suffix=randomUUID(),agency=Date.now()*1000+randomInt(500),zone=randomUUID(),otherZone=randomUUID(),car='ARCHIVE_CAR_'+suffix,otherCar='ARCHIVE_OTHER_'+suffix;
const users=Object.fromEntries(['admin','manager','viewer','pending'].map(role=>[role,randomUUID()])),q=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb';
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'parking-archive-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'parking-archive-test: ${label}';end if;end $test$;`;};
const perform=s=>`do $work$ begin perform ${s};end $work$;`,service="reset role;set local role service_role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';",auth=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub:users[role],role:'authenticated'}))};`;
const archive=(revision=1,user=users.admin,id=zone)=>`public.fleet_archive_parking_zone(${id===null?'null':q(id)+'::uuid'},${revision===null?'null':revision},${q(user)}::uuid)`;
const historicalKey=randomBytes(32).toString('hex'),otherKey=randomBytes(32).toString('hex'),shape={type:'circle',center:{lat:33.6,lon:-7.6},radius_m:100};
const sql=["begin;set local statement_timeout='20s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261218000000_parking_archive.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name) overriding system value values(${agency},'Synthetic archive A'),(${agency+1},'Synthetic archive B');
 insert into auth.users(id,email,aud,role) values ${Object.entries(users).map(([role,id])=>`(${q(id)},${q('archive-'+role+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...Object.entries(users).map(([role,id])=>`update public.profiles set role=${q(role)} where user_id=${q(id)};`),
 `insert into public.user_agencies(user_id,agency_id) values(${q(users.manager)},${agency}),(${q(users.viewer)},${agency});
 insert into public.vehicles(key,plate,geotab_id,agency_id) values(${q(car)},'Synthetic archive A','SYNTHETIC_ARCHIVE_A',${agency}),(${q(otherCar)},'Synthetic archive B','SYNTHETIC_ARCHIVE_B',${agency+1});
 insert into public.fleet_parking_zones(id,name,kind,agency_id,shape,fingerprint,source,source_id) values(${q(zone)},'Synthetic archived parking','parking',${agency},${json(shape)},${q('a'.repeat(64))},'geotab',${q(suffix)}),(${q(otherZone)},'Synthetic other exclusion','exclusion',${agency+1},${json(shape)},${q('b'.repeat(64))},'manual',null);
 insert into public.fleet_parking_state(vehicle_key,zone_id,state) values(${q(car)},${q(zone)},'{}'),(${q(otherCar)},${q(otherZone)},'{}');
 insert into public.fleet_parking_events(event_key,vehicle_key,zone_id,kind,observed_at,first_observed_at) values(${q(historicalKey)},${q(car)},${q(zone)},'entered',now(),now()-interval '6 seconds'),(${q(otherKey)},${q(otherCar)},${q(otherZone)},'entered',now(),now()-interval '6 seconds');`,
 ...['admin','manager','viewer','pending'].flatMap(role=>[auth(role),reject(`perform ${archive()}`,role+'_cannot_archive_directly','insufficient_privilege'),reject(`update public.fleet_parking_zones set archived_at=now(),enabled=false where id=${q(zone)}`,role+'_cannot_patch_archive_directly','insufficient_privilege')]),
 'reset role;set local role anon;',reject(`perform ${archive()}`,'anon_cannot_archive','insufficient_privilege'),service,
 reject(`perform ${archive(1,users.manager)}`,'server_requires_admin_identity'),reject(`perform ${archive(0)}`,'positive_revision_required'),reject(`perform ${archive(null)}`,'revision_required'),reject(`perform ${archive(1,users.admin,null)}`,'zone_required'),
 check(`(${archive(2)}->>'outcome')='conflict'`,'stale_revision_conflicts'),check(`(select revision=1 and enabled and archived_at is null from public.fleet_parking_zones where id=${q(zone)})`,'conflict_changes_nothing'),check(`(${archive(1,users.admin,randomUUID())}->>'outcome')='missing'`,'missing_zone_explicit'),
 check(`(${archive()}->>'revision')::bigint=2`,'archive_advances_revision'),check(`(select not enabled and archived_at is not null and archived_by=${q(users.admin)}::uuid from public.fleet_parking_zones where id=${q(zone)})`,'archive_is_disabled_and_audited'),
 check(`not exists(select 1 from public.fleet_parking_state where zone_id=${q(zone)})`,'archive_resets_live_state'),check(`exists(select 1 from public.fleet_parking_state where zone_id=${q(otherZone)})`,'other_zone_state_preserved'),check(`exists(select 1 from public.fleet_parking_events where event_key=${q(historicalKey)} and zone_id=${q(zone)})`,'history_keeps_foreign_key'),
 check(`(${archive()}->>'outcome')='conflict' and (${archive(2)}->>'outcome')='conflict'`,'archived_zone_is_not_rearchived'),
 reject(`update public.fleet_parking_zones set enabled=true where id=${q(zone)}`,'archive_cannot_be_enabled_without_restoration','check_violation'),
 reject(`perform public.fleet_commit_parking(${json([{vehicle_key:car,zone_id:zone,zone_revision:2,previous_at:null,state:null}])},'[]')`,'delayed_detector_commit_refused_even_at_archive_revision'),
 ...['admin','manager','viewer','pending'].flatMap(role=>[auth(role),check(`(select count(*) from public.fleet_parking_zones where id in(${q(zone)},${q(otherZone)}))=${role==='pending'?0:2}`,role+'_geographic_catalog_scope_unchanged'),check(`(select count(*) from public.fleet_parking_events where event_key in(${q(historicalKey)},${q(otherKey)}))=${role==='admin'?2:role==='pending'?0:1}`,role+'_history_scope_unchanged')]),
 service,`update public.fleet_parking_zones set enabled=true,archived_at=null,archived_by=null where id=${q(zone)};`,check(`(select revision=3 and enabled and archived_at is null from public.fleet_parking_zones where id=${q(zone)})`,'explicit_restoration_starts_new_revision'),check(`not exists(select 1 from public.fleet_parking_state where zone_id=${q(zone)})`,'restoration_does_not_reuse_previous_presence'),
 check(`exists(select 1 from public.fleet_parking_events where event_key=${q(historicalKey)})`,'restoration_preserves_history'),
 `update public.params set value='not-staging' where key='environment';`,reject(`perform ${archive(3)}`,'archive_requires_staging'),
 "reset role;rollback;select 'PARKING_ARCHIVE_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(x=>x==='--username=postgres'?'--username=supabase_admin':x),{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1048576});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/parking-archive-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local archive validation failed; rollback retained.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'PARKING_ARCHIVE_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migration_simulated:simulate,rolled_back:true}));
