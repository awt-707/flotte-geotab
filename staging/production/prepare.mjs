import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadManifest,verifySources,parseInventory,REPOSITORY} from './migrations-plan.mjs';
import {rehearse} from './prepare-local-rehearsal.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const md5=value=>createHash('md5').update(value).digest('hex');
const OUT=path.join(REPOSITORY,'staging/.local/production/preparation');
const CATEGORY=['relations','functions','policies','triggers','indexes','publications'];
const inScope=(category,o)=>o.schema==='public'||category==='policies'&&o.schema==='storage'||category==='triggers'&&o.schema==='auth'&&o.name==='on_auth_user_created';
const REVIEW_FILE=path.join(REPOSITORY,'staging/.local/production/production-function-review-2026-11-04.json');
export function parseFunctionReview(raw,inventory){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>1048576)throw Error('Bounded function review required.');
 let review=JSON.parse(raw);if(Array.isArray(review)){if(review.length!==1)throw Error('Single function review required.');review=review[0];}
 if(review&&Object.hasOwn(review,'function_review_json')){if(Object.keys(review).length!==1)throw Error('Ambiguous function review.');review=review.function_review_json;}
 if(review?.format!=='ludy-production-function-review-v1'||review.transactionReadOnly!==true||review.environmentMarker!==null||!Array.isArray(review.functions)||review.functions.length!==2)throw Error('Reviewed production marker must be null and two definitions must be present.');
 for(const name of ['mission_guard','rls_auto_enable']){
  const functions=review.functions.filter(f=>f.name===name),expected=inventory.catalogs.functions.filter(f=>f.name===name);
  if(functions.length!==1||expected.length!==1)throw Error('Unexpected reviewed function: '+name);
  const f=functions[0],e=expected[0];
  if(f.identityArguments!==''||f.identityArguments!==e.identityArguments||f.owner!==e.owner||f.acl!==e.acl||f.definitionMd5!==e.definitionMd5||typeof f.definition!=='string'||md5(f.definition)!==e.definitionMd5||!f.definition.startsWith('CREATE OR REPLACE FUNCTION public.'+name+'()\n')||!f.definition.endsWith('$function$\n'))throw Error('Function definition does not match the reviewed inventory: '+name);
 }
 const expectedEvent={name:'ensure_rls',tags:['CREATE TABLE','CREATE TABLE AS','SELECT INTO'],event:'ddl_command_end',enabled:'O',function:'public.rls_auto_enable()'};
 if(!Array.isArray(review.eventTriggers)||review.eventTriggers.length!==1||Object.keys(expectedEvent).some(k=>JSON.stringify(review.eventTriggers[0][k])!==JSON.stringify(expectedEvent[k])))throw Error('Unreviewed production event trigger configuration.');
 return review;
}

export const INITIALIZE_PRODUCTION_MARKER=`do $initialize_production_marker$
declare marker text;existed boolean;
begin
 select value into marker from public.params where key='environment' for update;existed:=found;
 if marker is not null then raise exception 'Environment marker differs from reviewed null value; no automatic conversion is allowed';end if;
 if existed then update public.params set value='production' where key='environment';
 else insert into public.params(key,value) values('environment','production');end if;
end $initialize_production_marker$;`;

export function eventTriggerGuard(review){
 return `do $preserve_event_triggers$ declare actual jsonb;expected jsonb:=${q(JSON.stringify(review.eventTriggers))}::jsonb;begin
 select coalesce(jsonb_agg(jsonb_build_object('name',e.evtname,'tags',e.evttags,'event',e.evtevent,'enabled',e.evtenabled,'function',n.nspname||'.'||p.proname||'()') order by e.evtname),'[]'::jsonb)
 into actual from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';
 if actual is distinct from expected then raise exception 'Production event trigger configuration changed since review';end if;
end $preserve_event_triggers$;`;
}

export function installReviewedLocalDefinitions(review){return sql=>{
 // Only the disposable database receives these definitions. The production
 // bundle preserves the existing functions and trigger without recreating them.
 const mission=review.functions.find(f=>f.name==='mission_guard'),rls=review.functions.find(f=>f.name==='rls_auto_enable');
 sql(mission.definition+';');
 sql(rls.definition+";create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') execute function public.rls_auto_enable();alter function public.rls_auto_enable() owner to postgres;",{admin:true});
 sql('grant execute on function public.rls_auto_enable() to anon,authenticated,service_role;');
 sql(eventTriggerGuard(review));
 return {missionGuardMd5:mission.definitionMd5,rlsAutoEnableMd5:rls.definitionMd5,eventTrigger:'ensure_rls',reviewedDefinitions:true,eventTriggerOwnerScope:'Not inventoried remotely; local event trigger belongs to supabase_admin, function owner and ACL match production'};
};}
export const PRODUCTION_GUARD=`do $production_target$ begin
 if (select value from public.params where key='environment') is distinct from 'production'
 then raise exception 'Production marker required; staging, seeds and baseline replay are forbidden';end if;
end $production_target$;`;
const removeOnce=(source,old,replacement)=>{
 if(source.split(old).length!==2)throw Error('Reviewed SQL section changed; inspect sources before preparing again.');
 return source.replace(old,replacement);
};

// The source manifest pins every input byte. Only its enumerated guard lines
// and these separately reviewed operations may be changed; no global schema
// rewrite is performed. The bundle initializes the separately reviewed null
// marker only after the catalogue and event-trigger preflights succeed.
export function productionVariant(entry,source){
 if(sha(source)!==entry.sha256)throw Error('Source hash mismatch: '+entry.file);
 const lines=source.split('\n'),edits=[];
 for(const n of entry.stagingGuardLines){
  if(!/\(select value from (?:public\.)?params where key='environment'\) is distinct from 'staging'/.test(lines[n-1]||''))throw Error('Unexpected staging guard: '+entry.file+':'+n);
  lines[n-1]=lines[n-1].replace("is distinct from 'staging'","is distinct from 'production'");edits.push({line:n,change:'Require production instead of staging'});
 }
 let sql=lines.join('\n');
 // Error texts have no behavioural effect; keep them truthful for production.
 sql=sql.replaceAll("raise exception 'Staging required'","raise exception 'Production required'")
  .replaceAll("raise exception 'Base locale de staging obligatoire'","raise exception 'Production marker required'");
 if(/is distinct from 'staging'/.test(sql))throw Error('Unreviewed staging guard remains.');
 if(entry.file==='20261204000000_driver_sessions.sql'){
  sql=removeOnce(sql,"and has_function_privilege('anon',p.oid,'EXECUTE') loop","and p.prorettype<>'event_trigger'::regtype\n   and has_function_privilege('anon',p.oid,'EXECUTE') loop");
  edits.push({change:'Keep platform event-trigger function ACLs intact, including rls_auto_enable'});
 }
 if(entry.file==='20261210000000_inventory_current_bindings.sql'){
  const start=sql.indexOf('do $repair$'),end=sql.indexOf('end $repair$;',start);
  if(start<0||end<start||sql.indexOf('do $repair$',start+1)!==-1)throw Error('Immediate agency repair changed.');
  sql=sql.slice(0,start)+'-- Production: do not rewrite existing agency bindings during schema promotion.\n-- Any repair requires a separate, reviewed operation on real references.\n'+sql.slice(end+'end $repair$;'.length);
  edits.push({change:'Omit immediate agency repair and snapshot replay; retain RPC definitions'});
 }
 if(entry.file==='20261213000000_manual_events.sql'){
  const deletion="delete from public.ops_event_reviews where event_id in (select id from public.ops_events where source_id<>'manual');\ndelete from public.ops_events where source_id<>'manual';";
  sql=removeOnce(sql,deletion,`do $preserve_events$ begin
 if exists(select 1 from public.ops_events where source_id<>'manual') then
  raise exception 'Non-manual events exist; preserve and review them before promotion';
 end if;
end $preserve_events$;`);
  edits.push({change:'Abort if non-manual events exist; never delete events or reviews during promotion'});
 }
 sql='-- Production draft derived from '+entry.file+'\n-- Source SHA-256: '+entry.sha256+'\n'+PRODUCTION_GUARD+'\n'+sql;
 return {file:entry.file,sourceSha256:entry.sha256,sha256:sha(sql),edits,sql};
}

export function catalogPreflight(inventory,inventorySql){
 const start=inventorySql.indexOf('  select jsonb_build_object('),end=inventorySql.indexOf('  ) into catalogs;',start);
 if(start<0||end<start)throw Error('Inventory SQL capture changed; review required.');
 const capture=inventorySql.slice(start,end+'  ) into catalogs;'.length);
 const expected=Object.fromEntries(CATEGORY.map(k=>[k,inventory.catalogs[k].filter(o=>inScope(k,o))]));
 const normalize=name=>`(select jsonb_object_agg(c.key,(select coalesce(jsonb_agg(o order by o::text),'[]'::jsonb)
   from jsonb_array_elements(c.value) o where o->>'schema'='public'
    or c.key='policies' and o->>'schema'='storage'
    or c.key='triggers' and o->>'schema'='auth' and o->>'name'='on_auth_user_created'))
   from jsonb_each(${name}) c where c.key in('relations','functions','policies','triggers','indexes','publications'))`;
 return `do $production_catalog_preflight$
declare catalogs jsonb;expected jsonb:=${q(JSON.stringify(expected))}::jsonb;previous_path text:=current_setting('search_path');
begin
 perform set_config('search_path','pg_catalog',true);
${capture}
 if ${normalize('catalogs')} is distinct from ${normalize('expected')} then
  raise exception 'Production catalogue changed since reviewed inventory; stop and collect a new inventory';
 end if;
 perform set_config('search_path',previous_path,true);
end $production_catalog_preflight$;`;
}

function preservedRemoteFunctions(inventory){
 const expected=inventory.catalogs.functions.filter(f=>['mission_guard','rls_auto_enable'].includes(f.name));
 if(expected.length!==2||expected.some(f=>f.identityArguments!==''))throw Error('Unexpected preserved production functions.');
 return `do $preserve_remote_functions$
declare previous_path text:=current_setting('search_path');begin
 perform set_config('search_path','pg_catalog',true);
 ${expected.map(f=>`if not exists(select 1 from pg_proc p where p.oid=${q('public.'+f.name+'()')}::regprocedure
  and md5(pg_get_functiondef(p.oid))=${q(f.definitionMd5)} and pg_get_userbyid(p.proowner)=${q(f.owner)}
  and p.proacl::text is not distinct from ${f.acl===null?'null':q(f.acl)}) then
  raise exception 'Preserved production function changed: ${f.name}';end if;`).join('\n')}
 perform set_config('search_path',previous_path,true);
end $preserve_remote_functions$;`;
}

export function promotionBundle(inventory,inventorySql,variants,inventorySha256,review){
 return `-- REVIEW DRAFT. Do not run before the production review and restore rehearsal.
-- No baseline or demo seed. Source inventory SHA-256: ${inventorySha256}
-- Existing writers must be stopped before this transaction. No remote executor is provided.
begin;
set local standard_conforming_strings=on;
set local statement_timeout='180s';set local lock_timeout='5s';set local idle_in_transaction_session_timeout='60s';
select pg_advisory_xact_lock(hashtextextended('ludy-production-promotion',0));
lock table public.params in exclusive mode;
${catalogPreflight(inventory,inventorySql)}
${eventTriggerGuard(review)}
${INITIALIZE_PRODUCTION_MARKER}
${PRODUCTION_GUARD}
${variants.map(v=>v.sql).join('\n\n')}
${preservedRemoteFunctions(inventory)}
${eventTriggerGuard(review)}
${PRODUCTION_GUARD}
commit;
select 'Ludy production schema promotion committed' as status;
`;
}

export async function prepare(){
 const manifest=await loadManifest();await verifySources(REPOSITORY,manifest);
 const inventoryBytes=await fs.readFile(path.join(REPOSITORY,'staging/.local/production/production-inventory-2026-11-04.json'),'utf8');
 const inventory=parseInventory(inventoryBytes);
 const reviewBytes=await fs.readFile(REVIEW_FILE,'utf8'),review=parseFunctionReview(reviewBytes,inventory);
 const variants=[];
 for(const entry of manifest.candidates)variants.push(productionVariant(entry,await fs.readFile(path.join(REPOSITORY,'staging/supabase/migrations',entry.file),'utf8')));
 // These reviewed runtime additions are versioned in this separate manifest,
 // after the business variants, and never mixed into the historical baseline.
 for(const file of ['desktop-live.sql','desktop-workers.sql','desktop-admin.sql','desktop-manager.sql']){
  const source=await fs.readFile(path.join(REPOSITORY,'staging/production',file),'utf8');
  const sql='-- Production desktop addition: '+file+'\n'+PRODUCTION_GUARD+'\n'+source;
  variants.push({file,sourceSha256:sha(source),sha256:sha(sql),edits:[{change:'Require production environment marker'}],sql});
 }
 await fs.mkdir(path.join(OUT,'variants'),{recursive:true,mode:0o700});await fs.chmod(OUT,0o700);await fs.chmod(path.join(OUT,'variants'),0o700);
 for(const v of variants)await fs.writeFile(path.join(OUT,'variants',v.file),v.sql,{mode:0o600});
 const inventorySql=await fs.readFile(path.join(REPOSITORY,'staging/production/migrations-inventory.sql'),'utf8');
 const bundle=promotionBundle(inventory,inventorySql,variants,sha(inventoryBytes),review);
 await fs.writeFile(path.join(OUT,'promote-draft.sql'),bundle,{mode:0o600});
 const preparation={format:'ludy-production-variants-v1',readyForProduction:false,executionAvailable:false,inventorySha256:sha(inventoryBytes),inventoryCapturedAt:inventory.capturedAt,baselineFilesExcluded:manifest.baseline.length,candidateCount:manifest.candidates.length,desktopAdditions:variants.length-manifest.candidates.length,
  blockers:['PRIVATE_BACKUP_RESTORE_AND_REAL_DATA_REHEARSAL_REQUIRED','EXISTING_WRITERS_CUTOVER_NOT_VALIDATED'],
  functionReview:{fileSha256:sha(reviewBytes),definitionsMatchInventory:true,eventTrigger:'ensure_rls',environmentMarker:null,
   findings:['mission_guard keeps manager validation restrictions and uses explicit public schema references; preserved byte-for-byte',
    'ensure_rls calls rls_auto_enable for CREATE TABLE/CREATE TABLE AS/SELECT INTO in public only; configuration, function definition, owner and ACL preserved']},
  bundle:{file:'promote-draft.sql',sha256:sha(bundle),transaction:'single',catalogPreflight:true,markerInitialization:'null-or-absent-only-after-catalogue-preflight',preservedFunctions:['mission_guard','rls_auto_enable'],preservedEventTrigger:'ensure_rls'},
  variants:variants.map(({sql,...metadata})=>metadata)};
 await fs.writeFile(path.join(OUT,'variants-manifest.json'),JSON.stringify(preparation,null,2)+'\n',{mode:0o600});
 return {preparation,variants,inventory,review};
}

const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const identifier=value=>'"'+String(value).replaceAll('"','""')+'"';
export function preservationChecks({review=null,productionInventory=null,initializeMarker=false}={}){
 let baselineRows,relations,preservedFunctions,eventPreservationRefusal=false,productionTargetRefusal=false,catalogPreflightRefusal=false;
 const capture=sql=>Object.fromEntries(relations.map(r=>[r.name,JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from(select ${r.columns.map(c=>identifier(c.name)).join(',')} from public.${identifier(r.name)})t;`).stdout)]));
 return {
  async beforeMigrations(sql,baseline){
   const inventorySql=await fs.readFile(path.join(REPOSITORY,'staging/production/migrations-inventory.sql'),'utf8');
   const preflight=catalogPreflight(productionInventory||baseline,inventorySql);
   sql(preflight);
   assert.throws(()=>sql('begin;alter table public.vehicles add column unexpected_test text;'+preflight+'rollback;'),e=>e.diagnostic?.includes('Production catalogue changed'));
   catalogPreflightRefusal=true;
   if(initializeMarker){
    assert.equal(sql("select count(*) from public.params where key='environment';").stdout.trim(),'0');
    const absent=sql('begin;lock table public.params in exclusive mode;'+preflight+eventTriggerGuard(review)+INITIALIZE_PRODUCTION_MARKER+"select value from public.params where key='environment';rollback;").stdout.trim();assert.equal(absent,'production');
    assert.equal(sql("select count(*) from public.params where key='environment';").stdout.trim(),'0');
    for(const value of ['staging','production','unexpected'])assert.throws(()=>sql("begin;insert into public.params(key,value) values('environment',"+q(value)+');lock table public.params in exclusive mode;'+preflight+eventTriggerGuard(review)+INITIALIZE_PRODUCTION_MARKER+'rollback;'),e=>e.diagnostic?.includes('Environment marker differs'));
    sql("insert into public.params(key,label,value,note,sort) values('environment','Preserved existing label',null,'Preserved existing note',-777);");
    assert.throws(()=>sql('begin;alter table public.vehicles add column marker_preflight_test text;'+preflight+INITIALIZE_PRODUCTION_MARKER+'rollback;'),e=>e.diagnostic?.includes('Production catalogue changed'));
    assert.equal(sql("select value is null from public.params where key='environment';").stdout.trim(),'t');
    assert.throws(()=>sql('begin;alter event trigger ensure_rls disable;'+eventTriggerGuard(review)+INITIALIZE_PRODUCTION_MARKER+'rollback;',{admin:true}),e=>e.diagnostic?.includes('event trigger configuration changed'));
    productionTargetRefusal=true;
   }
   sql(`insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000001','synthetic@example.invalid');
    insert into public.agencies(id,name,city) overriding system value values(700001,'Synthetic retained agency','Casablanca');
    insert into public.vehicles(key,plate,agency_id,geotab_id) values('PROMOTION-RETAIN','SYNTHETIC-001',700001,'bSynthetic');
    insert into public.drivers(code,name,agency_id,source) values('PROMOTION-DRIVER','Synthetic retained driver',700001,'manuel');
    insert into public.contracts(num,client_code,vehicle_key) values('PROMOTION-CONTRACT','PROMOTION-DRIVER','PROMOTION-RETAIN');
    insert into public.uber_payments(tx,at,revenue,cash,payout,agency_id) values('PROMOTION-PAYMENT','2026-10-30T12:00:00Z',125.45,20,100,700001);
    insert into public.usage_daily(day,kind,n) values('2026-10-01','live',423);
    insert into public.events(id,vehicle_key,vday,day) values('PROMOTION-EVENT','PROMOTION-RETAIN','2026-10-01','2026-10-01');
    insert into public.params(key,value) values('promotion_preserve_test','original');`);
   relations=baseline.catalogs.relations.filter(r=>r.schema==='public'&&r.kind==='r');baselineRows=capture(sql);
   preservedFunctions=sql("set search_path=pg_catalog;select md5(pg_get_functiondef('public.mission_guard()'::regprocedure));").stdout.trim();
   if(!review)sql("create function public.rls_auto_enable() returns event_trigger language plpgsql security definer as $$begin return;end$$;");
  },
  beforeVariant(sql,entry){
   if(!productionTargetRefusal){
    assert.throws(()=>sql("begin;update public.params set value='staging' where key='environment';"+entry.sql+'rollback;'),e=>e.diagnostic?.includes('Production marker required'));
    assert.equal(sql("select value from public.params where key='environment';").stdout.trim(),'production');productionTargetRefusal=true;
   }
   if(entry.file==='20261213000000_manual_events.sql'){
    sql("insert into public.ops_events(id,source_id,external_key,source_url,city,title,fingerprint,observed_at) values('00000000-0000-4000-8000-000000000003','if-maroc','synthetic','https://example.invalid','Casablanca','Synthetic event to preserve','synthetic',now());insert into public.ops_event_reviews(event_id,decision,fingerprint,reviewed_by) values('00000000-0000-4000-8000-000000000003','approved','synthetic','00000000-0000-4000-8000-000000000001');");
    assert.throws(()=>sql('begin;'+entry.sql+'commit;'),e=>e.diagnostic?.includes('Non-manual events exist'));
    assert.equal(sql("select (select count(*) from public.ops_events)::text||':'||(select count(*) from public.ops_event_reviews)::text;").stdout.trim(),'1:1');
    // Keep both synthetic rows as a manual entry for the remainder of the
    // isolated rehearsal. No deletion is used to make the variant pass.
    sql("update public.ops_events set source_id='manual' where id='00000000-0000-4000-8000-000000000003';");eventPreservationRefusal=true;
   }
  },
  afterMigrations(sql){
   const after=capture(sql);
   for(const r of relations){const set=new Set(after[r.name].map(row=>JSON.stringify(row)));for(const row of baselineRows[r.name]){
    const expected=initializeMarker&&r.name==='params'&&row.key==='environment'?{...row,value:'production'}:row;
    assert.ok(set.has(JSON.stringify(expected)),'Existing row changed in '+r.name);
   }}
   if(review)sql(eventTriggerGuard(review));
   assert.equal(sql("set search_path=pg_catalog;select md5(pg_get_functiondef('public.mission_guard()'::regprocedure));").stdout.trim(),preservedFunctions);
   assert.equal(sql("select has_function_privilege('anon','public.rls_auto_enable()','execute');").stdout.trim(),'t');
   if(eventPreservationRefusal)assert.equal(sql("select (select count(*) from public.ops_events)::text||':'||(select count(*) from public.ops_event_reviews)::text;").stdout.trim(),'1:1');
   assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;").stdout.trim(),'0');
   const actor='00000000-0000-4000-8000-000000000001',device='00000000-0000-4000-8000-000000000002';
   const auth=`set role authenticated;set request.jwt.claim.sub=${q(actor)};set request.jwt.claims=${q(JSON.stringify({sub:actor,role:'authenticated'}))};`;
   const state=JSON.parse(sql(auth+`select public.desktop_worker_register(${q(device)},'Synthetic production rehearsal',true);select public.desktop_worker_claim(${q(device)});`).stdout.trim().split('\n').at(-1));
   assert.equal(state.lease.owned,true);
   const fence=state.lease.fence;
   const target=JSON.parse(sql(auth+`select public.desktop_worker_request(${q(device)},${fence},'params','GET','{"select":"key,value","key":"eq.environment"}','null',null);`).stdout.trim());
   assert.equal(target.status,200);assert.equal(target.body[0].value,'production');
   const forbidden=()=>sql("set role anon;select public.desktop_worker_claim('00000000-0000-4000-8000-000000000002');");assert.throws(forbidden);
   return {originalPublicTablesPreserved:relations.length,syntheticHistoricalRowsPreserved:Object.values(baselineRows).reduce((n,r)=>n+r.length,0),missionGuardUnchanged:true,platformEventTriggerAclPreserved:true,realEventTriggerPreserved:!!review,markerNullRowPreserved:initializeMarker,eventPreservationRefusal,productionTargetRefusal,catalogPreflightRefusal,allPublicTablesRls:true,authenticatedAdminClaim:true,fencedEnvironmentRead:true,anonymousClaimDenied:true};
  },
 };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv.length>3||process.argv[2]&&!['--rehearse','--rehearse-atomic'].includes(process.argv[2]))throw Error('Usage: node staging/production/prepare.mjs [--rehearse | --rehearse-atomic]. No remote target or apply option exists.');
 const {preparation,variants,inventory,review}=await prepare();
 const atomic=process.argv[2]==='--rehearse-atomic';
 const report=process.argv[2]?await rehearse({variants,...preservationChecks({review,productionInventory:inventory,initializeMarker:atomic}),baselineAdjustments:installReviewedLocalDefinitions(review),initializeLocalMarker:!atomic,...(atomic?{atomicBundle:(_localInventory,inventorySql,entries)=>promotionBundle(inventory,inventorySql,entries,preparation.inventorySha256,review)}: {})}):null;
 console.log(JSON.stringify({readyForProduction:false,baselineExcluded:preparation.baselineFilesExcluded,candidates:preparation.candidateCount,desktopAdditions:preparation.desktopAdditions,output:OUT,localRehearsal:report&&{baseline:report.baselineApplied.length,variants:report.variantsApplied.length,checks:report.checks,blockers:report.blockers,failure:report.failure}},null,2));
 if(report?.failure)process.exitCode=1;
}
