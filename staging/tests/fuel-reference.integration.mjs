import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
assertLocalProject();const withMigration=process.argv.includes('--with-migration');
const suffix=randomUUID(),key='FUEL-'+suffix,q=s=>"'"+String(s).replaceAll("'","''")+"'";
const now=Date.now(),reference={method:'geotab_history',value:6,distance_km:700,fuel_l:42,from:new Date(now-8*86400000).toISOString(),to:new Date(now-86400000).toISOString(),calculated_at:new Date(now).toISOString()};reference.counter_at={km:{from:reference.from,to:reference.to},fuel_l:{from:reference.from,to:reference.to}};
const rpc=(device='BOX',data=reference)=>`public.ops_set_measured_fuel_reference(${q(key)},${q(device)},${q(JSON.stringify(data))}::jsonb)`;
let checks=0;const check=(condition,label)=>{checks++;return `do $$ begin if (${condition}) is distinct from true then raise exception 'fuel-reference:${label}';end if;end $$;`;};
const sql=['begin;set local statement_timeout=\'15s\';set local lock_timeout=\'2s\';',LOCAL_GUARD,...(withMigration?[readFileSync(new URL('../supabase/migrations/20261215000000_fuel_reference.sql',import.meta.url),'utf8')]:[]),
 `insert into public.vehicles(key,plate,geotab_id) values(${q(key)},'SYNTHETIC','BOX');set local role service_role;`,
 check(`${rpc('WRONG')}=false`,'changed_device_rejected'),check(`${rpc()}=true`,'measured_reference_written'),
 check(`(select ref_l100=6 and fuel_reference_evidence->>'method'='geotab_history' and fuel_reference_evidence->>'geotab_id'='BOX' from public.vehicles where key=${q(key)})`,'reference_evidence_stored'),
 check(`${rpc()}=false`,'reference_not_overwritten'),
 `update public.vehicles set ref_l100=8 where key=${q(key)};`,check(`${rpc()}=false`,'manual_reference_preserved'),
 `update public.vehicles set ref_l100=null,active='NON' where key=${q(key)};`,check(`${rpc()}=false`,'inactive_not_calibrated'),
 ...[{distance_km:'NaN'},{fuel_l:'Infinity'},{counter_at:{}},{counter_at:{km:{from:reference.from,to:new Date(Date.parse(reference.to)+60000).toISOString()},fuel_l:{from:reference.from,to:reference.to}}}].map(change=>`do $$ declare denied boolean:=false;begin begin perform ${rpc('BOX',{...reference,...change})};exception when others then denied:=true;end;if not denied then raise exception 'fuel-reference:invalid_evidence';end if;end $$;`),
 'reset role;set local role authenticated;',
 `do $$ declare denied boolean:=false;begin begin perform ${rpc()};exception when insufficient_privilege then denied:=true;end;if not denied then raise exception 'fuel-reference:role';end if;end $$;`,
 'reset role;rollback;',"select 'FUEL_REFERENCE_OK';"].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']),{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
if(result.status!==0)throw Error('Fuel reference rollback check failed: '+result.stderr.replaceAll(suffix,'fixture').slice(0,1400));assert.equal(result.stdout.trim(),'FUEL_REFERENCE_OK');console.log(JSON.stringify({ok:true,checks:checks+5,rolled_back:true}));
