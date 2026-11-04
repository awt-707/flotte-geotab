// Validate local report configuration without retaining any test changes.
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
assertLocalProject();
const args=process.argv.slice(2);if(args.length>1||args.some(arg=>arg!=='--with-migration'))throw Error('Only --with-migration supported');
const simulate=args.includes('--with-migration'),suffix=randomUUID(),org=randomUUID(),admin=randomUUID(),viewer=randomUUID(),agency=Date.now()*1000+randomInt(900),q=value=>"'"+String(value).replaceAll("'","''")+"'",json=value=>q(JSON.stringify(value))+'::jsonb';
let checks=0;const check=(condition,label)=>{checks++;return `do $test$ begin if (${condition}) is distinct from true then raise exception 'uber-org-test: ${label}';end if;end $test$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $test$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'uber-org-test: ${label}';end if;end $test$;`;};
const perform=statement=>`do $work$ begin perform ${statement};end $work$;`;
const configure=(label,who=admin,mapping={Casablanca:agency})=>`public.uber_report_configure(true,${q(org)}::uuid,${json(mapping)},'dmy',${q(who)}::uuid${label===undefined?'':','+(label===null?'null':q(label))})`;
const revision='(select revision from public.uber_report_settings where id=1)';
const sql=["begin;set local lock_timeout='2s';set local statement_timeout='20s';set local client_min_messages=warning;",LOCAL_GUARD,"load 'safeupdate';",
 ...(simulate?[readFileSync(new URL('../supabase/migrations/20261217000000_uber_report_organization_label.sql',import.meta.url),'utf8')]:[]),
 // Migration 20 extends the single callable signature with an optional CSV
 // timezone. Both versions must keep five/six-argument compatibility below.
 check("to_regprocedure('public.uber_report_configure(boolean,uuid,jsonb,text,uuid)') is null and (select count(*)=1 from pg_proc where pronamespace='public'::regnamespace and proname='uber_report_configure') and (to_regprocedure('public.uber_report_configure(boolean,uuid,jsonb,text,uuid,text)') is not null or to_regprocedure('public.uber_report_configure(boolean,uuid,jsonb,text,uuid,text,text)') is not null)",'one_unambiguous_signature'),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic report organization','CASABLANCA');
 insert into auth.users(id,email,aud,role) values(${q(admin)},${q('uber-org-admin-'+suffix+'@example.invalid')},'authenticated','authenticated'),(${q(viewer)},${q('uber-org-viewer-'+suffix+'@example.invalid')},'authenticated','authenticated');
 update public.profiles set role='admin' where user_id=${q(admin)};update public.profiles set role='viewer' where user_id=${q(viewer)};`,
 ...['anon','authenticated'].flatMap(role=>[`reset role;set local role ${role};`,reject(`perform ${configure('Synthetic Fleet')}`,role+'_cannot_configure','insufficient_privilege'),reject(`perform ${configure()}`,role+'_cannot_configure_legacy','insufficient_privilege')]),
 'reset role;set local role service_role;',reject(`perform ${configure('Synthetic Fleet',viewer)}`,'nonadmin_refused'),reject(`perform ${configure('Synthetic Fleet',admin,{Marrakech:agency})}`,'wrong_city_refused'),
 perform(configure()),check('(select organization_label is null and enabled from public.uber_report_settings where id=1)','five_arguments_compatible'),
 check(`(${configure('  Synthetic Fleet & Partners  ')}->>'organization_label')='Synthetic Fleet & Partners'`,'label_returned_trimmed'),
 check(`(select organization_id=${q(org)}::uuid and organization_label='Synthetic Fleet & Partners' and city_agencies=${json({Casablanca:agency})} from public.uber_report_settings where id=1)`,'settings_saved_together'),
 `do $test$ declare previous_revision bigint:=${revision};previous_label text:=(select organization_label from public.uber_report_settings where id=1);begin
  begin perform ${configure('')};exception when others then null;end;
  if ${revision}<>previous_revision or (select organization_label from public.uber_report_settings where id=1) is distinct from previous_label then raise exception 'uber-org-test: rejected_label_is_atomic';end if;
 end $test$;`,
 ...['','   ','x'.repeat(161),'Fleet\nName','\tFleet','Fleet\u007f','Fleet\u0085'].map((label,index)=>reject(`perform ${configure(label)}`,'invalid_label_'+index)),
 perform(configure('x'.repeat(160))),check('(select length(organization_label)=160 from public.uber_report_settings where id=1)','maximum_length_accepted'),
 perform(configure(null)),check('(select organization_label is null from public.uber_report_settings where id=1)','explicit_null_accepted'),
 perform(configure('Synthetic Fleet')),perform(configure()),check('(select organization_label is null from public.uber_report_settings where id=1)','default_null_compatible'),
 "update public.params set value='not-staging' where key='environment';",reject(`perform ${configure('Synthetic Fleet')}`,'staging_guard_preserved'),
 "reset role;rollback;select 'UBER_REPORT_ORGANIZATION_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const docker=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(arg=>arg==='--username=postgres'?'--username=supabase_admin':arg);
const result=spawnSync('docker',docker,{env,input:sql,encoding:'utf8',timeout:40000,maxBuffer:1024*1024});
if(result.error||result.status!==0){const label=String(result.stderr||'').match(/uber-org-test: ([a-zA-Z_0-9]+)/)?.[1],state=String(result.stderr||'').match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];throw Error('Local Uber organization validation failed; rollback retained.'+(label?' Check: '+label:state?' SQLSTATE: '+state:''));}
assert.equal(result.stdout.trim(),'UBER_REPORT_ORGANIZATION_ROLLBACK_OK');console.log(JSON.stringify({ok:true,checks:checks+1,migration_simulated:simulate,rolled_back:true}));
