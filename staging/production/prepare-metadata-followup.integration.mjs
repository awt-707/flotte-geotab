import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD} from '../scripts/import-reference.mjs';
import {localRunner} from './prepare-local-rehearsal.mjs';

assertLocalProject();
if(process.argv.length!==2)throw Error('No connection options accepted.');
const database='promotion_test_'+randomUUID().replaceAll('-',''),sql=localRunner(database);
let created=false;
try{
 sql('begin read only;'+LOCAL_GUARD+'rollback;',{admin:true,control:true});
 sql(`create database "${database}" owner postgres template template0;`,{admin:true,control:true});created=true;
 sql(`create function public.mission_guard() returns trigger language plpgsql as $$begin return new;end$$;
  create function public.rls_auto_enable() returns event_trigger language plpgsql security definer as $$begin return;end$$;`);
 sql("create table public.params(key text primary key,value text);insert into public.params values('environment','production');");
 sql('alter function public.rls_auto_enable() owner to supabase_admin;create event trigger synthetic_rls_event on ddl_command_end execute function public.rls_auto_enable();',{admin:true});
 const source=await fs.readFile(new URL('./prepare-metadata-followup.sql',import.meta.url),'utf8');
 const result=sql(source+"\nselect coalesce(current_setting('ludy_function_review.result',true),'MISSING');");
 const lines=result.stdout.split('\n');
 const report=JSON.parse(lines.find(line=>line.startsWith('{')));
 assert.equal(report.format,'ludy-production-function-review-v1');assert.equal(report.transactionReadOnly,true);
 assert.equal(report.environmentMarker,'production');
 assert.equal(report.functions.length,2);assert.equal(report.eventTriggers.length,1);
 assert.ok(report.functions.every(f=>typeof f.definition==='string'&&/^[a-f0-9]{32}$/.test(f.definitionMd5)));
 assert.equal(lines.at(-2),'');
 console.log(JSON.stringify({ok:true,checks:7,readOnly:true,finalResultRow:true,sessionCleared:true,remoteConnections:0}));
}finally{if(created)sql(`drop database "${database}" with(force);`,{admin:true,control:true});}
