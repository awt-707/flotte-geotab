import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadManifest,verifySources,REPOSITORY} from './migrations-plan.mjs';
import {productionVariant,PRODUCTION_GUARD,parseFunctionReview,INITIALIZE_PRODUCTION_MARKER,promotionBundle} from './prepare.mjs';
import {compareCatalogs} from './prepare-local-rehearsal.mjs';

const manifest=await loadManifest();
const variant=async file=>{const entry=manifest.candidates.find(v=>v.file===file);return productionVariant(entry,await fs.readFile(path.join(REPOSITORY,'staging/supabase/migrations',file),'utf8'));};
test('all 42 pinned candidates receive production guards without rewriting historical sources',async()=>{
 await verifySources(REPOSITORY,manifest);
 for(const entry of manifest.candidates){const sql=(await variant(entry.file)).sql;assert.ok(sql.includes(PRODUCTION_GUARD));assert.doesNotMatch(sql,/is distinct from 'staging'/);assert.doesNotMatch(sql,/update\s+(?:public\.)?params\s+set\s+value\s*=\s*'production'/i);}
});
test('changed source or incomplete guard enumeration refuses preparation',async()=>{
 const entry=manifest.candidates.find(v=>v.stagingGuardLines.length),source=await fs.readFile(path.join(REPOSITORY,'staging/supabase/migrations',entry.file),'utf8');
 assert.throws(()=>productionVariant(entry,source+'\n'),/hash mismatch/);
 assert.throws(()=>productionVariant({...entry,stagingGuardLines:[]},source),/Unreviewed staging guard/);
 assert.throws(()=>productionVariant({...entry,stagingGuardLines:[1]},source),/Unexpected staging guard/);
});
test('production never deletes historical collected events or silently repairs agencies',async()=>{
 const events=(await variant('20261213000000_manual_events.sql')).sql;
 assert.match(events,/Non-manual events exist; preserve and review/);
 const immediate=events.slice(0,events.indexOf('create function public.ops_mutate_manual_event'));
 assert.doesNotMatch(immediate,/delete from public\.ops_event_reviews/);
 assert.equal(immediate.indexOf('delete from public.ops_events'),-1);
 const inventory=(await variant('20261210000000_inventory_current_bindings.sql')).sql;
 assert.doesNotMatch(inventory,/do \$repair\$/);assert.match(inventory,/create or replace function public\.fleet_sync_inventory/);
});
test('legacy access cleanup keeps platform event triggers intact',async()=>{
 const sql=(await variant('20261204000000_driver_sessions.sql')).sql;
 assert.match(sql,/p\.prorettype<>'event_trigger'::regtype/);assert.match(sql,/revoke execute on function %s from public,anon/);
});
test('catalogue comparison reports actual definitions and ACL differences, ignores object key ordering',()=>{
 const empty=()=>({catalogs:Object.fromEntries(['relations','functions','policies','triggers','indexes','publications'].map(k=>[k,[]]))});
 const a=empty(),b=empty();a.catalogs.functions=[{schema:'public',name:'keep',identityArguments:'',definitionMd5:'a',acl:'x'}];
 b.catalogs.functions=[{name:'keep',acl:'x',definitionMd5:'a',identityArguments:'',schema:'public'}];
 assert.deepEqual(compareCatalogs(a,b).functions.changed,[]);
 b.catalogs.functions[0].acl='y';assert.deepEqual(compareCatalogs(a,b).functions.changed[0].fields,['acl']);
 b.catalogs.functions=[];assert.deepEqual(compareCatalogs(a,b).functions.missing,['public||keep|']);
});

function reviewedFixture(){
 const functions=['mission_guard','rls_auto_enable'].map(name=>{const definition=`CREATE OR REPLACE FUNCTION public.${name}()\n RETURNS ${name==='mission_guard'?'trigger':'event_trigger'}\n LANGUAGE plpgsql\nAS $function$begin return;end $function$\n`;return{name,identityArguments:'',owner:'postgres',acl:'{=X/postgres,postgres=X/postgres}',definition,definitionMd5:createHash('md5').update(definition).digest('hex')};});
 return {inventory:{catalogs:{functions:structuredClone(functions)}},review:{format:'ludy-production-function-review-v1',transactionReadOnly:true,environmentMarker:null,functions,eventTriggers:[{name:'ensure_rls',tags:['CREATE TABLE','CREATE TABLE AS','SELECT INTO'],event:'ddl_command_end',enabled:'O',function:'public.rls_auto_enable()'}]}};
}
test('the two supplied definitions must match their inventory fingerprints, ACLs, identities and known event trigger',()=>{
 const {inventory,review}=reviewedFixture();assert.deepEqual(parseFunctionReview(JSON.stringify([{function_review_json:review}]),inventory),review);
 for(const change of [r=>r.functions[0].definition+=' ',r=>r.functions[0].acl=null,r=>r.functions[1].owner='unexpected',r=>r.functions[1].name='mission_guard',r=>r.eventTriggers[0].enabled='D',r=>r.environmentMarker='staging']){
  const changed=structuredClone(review);change(changed);assert.throws(()=>parseFunctionReview(JSON.stringify(changed),inventory));
 }
});
test('the bundle checks the catalogue and event trigger before initializing a null marker under transaction lock',()=>{
 const {inventory,review}=reviewedFixture();for(const key of ['relations','policies','triggers','indexes','publications'])inventory.catalogs[key]=[];
 const bundle=promotionBundle(inventory,"  select jsonb_build_object('functions','[]'::jsonb)\n  ) into catalogs;",[],'synthetic',review);
 assert.ok(bundle.indexOf('lock table public.params')<bundle.indexOf('do $production_catalog_preflight$'));
 assert.ok(bundle.indexOf('do $production_catalog_preflight$')<bundle.indexOf('do $initialize_production_marker$'));
 assert.ok(bundle.indexOf('do $preserve_event_triggers$')<bundle.indexOf('do $initialize_production_marker$'));
 assert.match(INITIALIZE_PRODUCTION_MARKER,/if marker is not null then raise exception/);
 assert.match(INITIALIZE_PRODUCTION_MARKER,/update public\.params set value='production' where key='environment'/);
 assert.doesNotMatch(INITIALIZE_PRODUCTION_MARKER,/delete|on conflict|set label|set note|set sort/i);
 assert.equal(bundle.match(/^commit;$/gm).length,1);
});
