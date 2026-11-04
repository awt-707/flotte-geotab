import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {sourceKey} from '../server/fleet-domain.mjs';

assertLocalProject();
const args=process.argv.slice(2);if(args.length&&args.join(' ')!=='--with-migration')throw Error('Use --with-migration only.');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const docker=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(v=>v==='--username=postgres'?'--username=supabase_admin':v);
const run=sql=>spawnSync('docker',docker,{env,input:sql,encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
const q=v=>"'"+String(v).replaceAll("'","''")+"'",j=v=>q(JSON.stringify(v))+'::jsonb';
const agency=Date.now()*1000+randomInt(900),org=randomUUID(),otherOrg=randomUUID(),admin=randomUUID(),prefix=randomUUID().slice(0,8);
const rev='(select revision from public.uber_report_settings where id=1)',from='2026-10-26T00:00:00Z',to='2026-11-02T00:00:00Z';
let checks=0;const check=(expression,label)=>{checks++;return `do $test$ begin if (${expression}) is distinct from true then raise exception 'uber-identity-test: ${label}';end if;end $test$;`;};
const reject=(sql,label)=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${sql};exception when others then refused:=true;end;if not refused then raise exception 'uber-identity-test: ${label}';end if;end $test$;`;};
function person(label,{scope=agency,linked=true,method='exact_name',provisional=true,external=null,organization=org,refAgency=scope}={}){
 const id=randomUUID(),identity=randomUUID(),provider=randomUUID(),name=prefix+' '+label,code='STG-REPORT-'+randomUUID(),key=sourceKey(organization,null,name);
 return {id,identity,provider,name,code,key,sql:[linked?`insert into public.drivers(code,name,agency_id,source) values(${q(code)},${q(name)},${refAgency===null?'null':refAgency},'manuel');`:'',
 `insert into public.fleet_drivers(id,name,ludy_driver_code,agency_id,link_method,auto_link_disabled) values(${q(id)},${q(name)},${linked?q(code):'null'},${scope===null?'null':scope},${method?q(method):'null'},${method==='manual'});`,
 `insert into public.fleet_identities(id,driver_id,source,source_key,external_id,organization_id,provisional) values(${q(identity)},${q(id)},'uber',${q(key)},${external?q(external):'null'},${q(organization)},${provisional});`].join('\n')};
}
const row=(p,extra={})=>({provider_driver_id:p.provider,driver_name:p.name,trips_completed:1,online_seconds:3600,trip_seconds:900,...extra});
const commit=(rows,{type='driver_activity',hash='a'.repeat(64),revision=rev}={})=>`public.uber_driver_report_commit(${q(org)}::uuid,${revision},${q(hash)},${q(type)},'[]'::jsonb,${j(rows)},'{}'::jsonb,${q(from)}::timestamptz,${q(to)}::timestamptz)`;
const main=person('Évidence Exacte',{method:'manual'}),unlinked=person('Sans Reference',{linked:false}),scope=person('Autre Agence',{scope:agency+1}),mismatch=person('Agence Contradictoire',{refAgency:agency+1}),unknownMethod=person('Methode Inconnue',{method:null}),namesake=person('Nom Partage'),namesakeOther=person('Nom Partage',{scope:agency+1}),conflicting=person('UUID Different',{external:randomUUID()}),confirmed=person('Deja Confirme',{external:randomUUID(),provisional:false}),sameNameTwo=person('Deux UUID'),differentNames=person('Deux Noms'),otherOnly=person('Autre Organisation',{organization:otherOrg}),atomic=person('Annulation Atomique'),parallelOrg=person('UUID Autre Flotte');
// Distinct source keys represent two real platform accounts sharing one name.
namesakeOther.sql=namesakeOther.sql.replace(q(namesakeOther.key),q(namesakeOther.key+':second-account'));
const people=[main,unlinked,scope,mismatch,unknownMethod,namesake,namesakeOther,conflicting,confirmed,sameNameTwo,differentNames,otherOnly,atomic,parallelOrg];
const sql=["begin;set local lock_timeout='2s';set local statement_timeout='20s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(args.includes('--with-migration')?[readFileSync(new URL('../supabase/migrations/20261222000000_uber_report_identity_promotion.sql',import.meta.url),'utf8')]:[]),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic UUID Casa','Casablanca'),(${agency+1},'Synthetic UUID Marrakech','Marrakech');`,
 `insert into auth.users(id,email,aud,role) values(${q(admin)},${q(admin+'@example.invalid')},'authenticated','authenticated');update public.profiles set role='admin' where user_id=${q(admin)};`,
 ...people.map(p=>p.sql),
 `select public.uber_report_configure(true,${q(org)}::uuid,${j({Casablanca:agency})},'ymd',${q(admin)}::uuid) is not null;`,
 ...['anon','authenticated'].flatMap(role=>[`reset role;set local role ${role};`,reject(`perform ${commit([row(main)])}`,role+'_no_commit')]),
 'reset role;set local role service_role;',
 reject(`perform public.uber_report_promote_identities(${q(org)}::uuid,${j([row(main)])},${j({Casablanca:agency})},${q('a'.repeat(64))},'driver_activity')`,'no_direct_helper'),
 reject(`perform ${commit([row(main)],{revision:rev+'-1'})}`,'stale_config_refused'),
 check(`(select provisional and external_id is null from public.fleet_identities where id=${q(main.identity)})`,'no_promotion_before_valid_commit'),
 check(`(${commit([row(main,{driver_name:'EXACTE '+prefix+' Evidence'})])}->'counts'->>'driver_imported')::integer=1`,'normalized_exact_name_promoted'),
 check(`(select not provisional and external_id=${q(main.provider)} and source_key=${q(main.key)} and driver_id=${q(main.id)}::uuid from public.fleet_identities where id=${q(main.identity)})`,'identity_source_key_preserved'),
 check(`(select ludy_driver_code=${q(main.code)} and agency_id=${agency} and vehicle_key is null and link_method='manual' and auto_link_disabled from public.fleet_drivers where id=${q(main.id)})`,'person_agency_vehicle_and_manual_mode_preserved'),
 check(`(select count(*) from public.fleet_link_audit where driver_id=${q(main.id)} and method='uber_report_uuid_exact_name' and evidence->>'provider_driver_id'=${q(main.provider)} and evidence->>'source_key_preserved'='true')=1`,'promotion_evidence_logged'),
 // The following lookup and observation write are the normal Live Map path:
 // source_key stays name-based even after the provider UUID is certified.
 `insert into public.fleet_observations(driver_id,identity_id,source,status,observed_at,evidence)
 select driver_id,id,'uber','on_trip',now(),'{"method":"visible_dom"}'::jsonb from public.fleet_identities where source='uber' and source_key=${q(sourceKey(org,null,'EXACTE '+prefix+' Evidence'))};`,
 check(`(select count(*) from public.fleet_observations where identity_id=${q(main.identity)} and status='on_trip')=1`,'next_live_batch_uses_same_identity'),
 check(`(${commit([row(main)])}->>'duplicate')::boolean`,'same_csv_replay_idempotent'),
 check(`(select count(*) from public.fleet_driver_report_summaries where driver_id=${q(main.id)})=1`,'one_summary_after_replay'),
 check(`(select count(*) from public.fleet_link_audit where driver_id=${q(main.id)} and method='uber_report_uuid_exact_name')=1`,'one_promotion_after_replay'),
 ...[[unlinked,'unconfirmed_person'],[scope,'outside_report_agency'],[mismatch,'reference_agency_conflict'],[unknownMethod,'unknown_link_method'],[namesake,'same_org_namesake_other_agency'],[conflicting,'provisional_conflicting_uuid'],[confirmed,'confirmed_uuid_never_replaced'],[otherOnly,'other_org_not_used']].flatMap(([p,label])=>[
  check(`(${commit([row(p)],{hash:'b'.repeat(64)})}->'counts'->>'driver_unmatched')::integer=1`,label),
  check(`not exists(select 1 from public.fleet_link_audit where driver_id=${q(p.id)} and method='uber_report_uuid_exact_name')`,label+'_not_promoted')]),
 check(`(${commit([row(sameNameTwo),row(sameNameTwo,{provider_driver_id:randomUUID()})],{hash:'c'.repeat(64)})}->'counts'->>'driver_unmatched')::integer=2`,'two_uuids_for_one_name_not_promoted'),
 check(`(${commit([row(differentNames),row(differentNames,{driver_name:'Another Completely Different Name'})],{hash:'d'.repeat(64)})}->'counts'->>'driver_unmatched')::integer=2`,'one_uuid_for_two_names_not_promoted'),
 reject(`perform ${commit([row(atomic,{acceptance_rate:2})],{type:'driver_quality',hash:'e'.repeat(64)})}`,'invalid_metrics_roll_back_promotion'),
 check(`(select provisional and external_id is null from public.fleet_identities where id=${q(atomic.identity)})`,'identity_rolls_back_with_bad_report'),
 check(`not exists(select 1 from public.fleet_link_audit where driver_id=${q(atomic.id)} and method='uber_report_uuid_exact_name')`,'audit_rolls_back_with_bad_report'),
 `reset role;insert into public.fleet_identities(driver_id,source,source_key,external_id,organization_id,provisional) values(${q(parallelOrg.id)},'uber',${q(randomUUID())},${q(parallelOrg.provider)},${q(otherOrg)},false);set local role service_role;`,
 check(`(${commit([row(parallelOrg)],{hash:'f'.repeat(64)})}->'counts'->>'driver_imported')::integer=1`,'uuid_namespace_is_scoped_to_organization'),
 check(`(select count(*) from public.fleet_identities where source='uber' and lower(organization_id)=${q(org)} and lower(external_id)=${q(main.provider)})=1`,'one_identity_after_live_and_report_replay'),
 "reset role;rollback;select 'UBER_IDENTITY_ROLLBACK_OK';"
].join('\n');
const result=run(sql);
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/uber-identity-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Uber identity rollback validation failed.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'t\nUBER_IDENTITY_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks,migrationSimulated:args.includes('--with-migration'),rolledBack:true}));
