import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {createDesktopTransport} from '../desktop-runtime/transport.mjs';
import {withDesktopAdminRequest} from '../desktop-runtime/admin-context.mjs';
assertLocalProject();if(process.argv.length!==2)throw Error('No database target options permitted.');
const sqlFiles=['desktop-live.sql','desktop-workers.sql','desktop-admin.sql'].map(f=>readFileSync(new URL('../production/'+f,import.meta.url),'utf8')).join('\n');
const userId=randomUUID(),deviceId=randomUUID(),q=v=>"'"+String(v).replaceAll("'","''")+"'",j=v=>q(JSON.stringify(v))+'::jsonb';
const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic_only'};
const auth=id=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(id)};set local request.jwt.claims=${j({sub:id,role:'authenticated'})};`;
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
function run(sql){
  const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(v=>v==='--username=postgres'?'--username=supabase_admin':v),{input:sql,encoding:'utf8',timeout:45000,maxBuffer:1048576,env});
  if(result.status!==0){writeFileSync(new URL('../.local/checks/desktop-transport-private-error.log',import.meta.url),result.stderr,{mode:0o600});throw Error('Local SQL transport validation failed; private diagnostic saved.');}
  return result.stdout.trim();
}
const fixture=`begin;set local lock_timeout='5s';set local statement_timeout='20s';${LOCAL_GUARD}\n${sqlFiles}\ninsert into auth.users(id,email,aud,role)values(${q(userId)},${q(userId+'@example.invalid')},'authenticated','authenticated');update public.profiles set role='admin' where user_id=${q(userId)};${auth(userId).replace('::jsonb;',';')}do $$begin perform public.desktop_worker_register(${q(deviceId)},'Synthetic PC',true);perform public.desktop_worker_claim(${q(deviceId)});end$$;`;
let operations=0;
const rpc=async(name,args)=>{
  assert.ok(['desktop_worker_request','desktop_admin_request'].includes(name));operations++;
  // Actual transport arguments are bound by name to the actual Postgres RPC.
  const params=Object.entries(args).map(([key,value])=>`${key}=>${value===null?'null':typeof value==='object'?j(value):typeof value==='number'?String(value):q(value)}`).join(',');
  const result=run(fixture+`select public.${name}(${params});rollback;`);return JSON.parse(result);
};
const user={userId,role:'admin',token:'synthetic-user-token'};
const transport=createDesktopTransport({config,deviceId,getSession:()=>user,rpc,fence:1,fetchFn:()=>assert.fail('No external request permitted')});
const request=(resource,options={})=>transport.fetchFn(config.supabaseUrl+'/rest/v1/'+resource,{...options,headers:{authorization:'Bearer '+transport.serviceKey,...options.headers}});
assert.equal((await request('fleet_sources?select=id&limit=4')).status,200);
assert.equal((await request('fleet_sources?select=id&id=neq.geotab&id=neq.myclicar&limit=4')).status,200);
const req={method:'POST',url:'/api/fleet/settings'};
const updated=await withDesktopAdminRequest(req,user,()=>request('fleet_settings?id=eq.1',{method:'PATCH',body:JSON.stringify({offline_threshold_s:601}),headers:{Prefer:'return=representation'}}));
assert.equal((await updated.json())[0].offline_threshold_s,601);
// Per-vehicle RLS, server receipt time, and delayed snapshot handling.
const viewer=randomUUID(),one='SNAPSHOT-A-'+randomUUID(),two='SNAPSHOT-B-'+randomUUID();
const rls=`begin;${LOCAL_GUARD}\n${readFileSync(new URL('../production/desktop-live.sql',import.meta.url),'utf8')}
insert into auth.users(id,email,aud,role)values(${q(viewer)},${q(viewer+'@example.invalid')},'authenticated','authenticated');
update public.profiles set role='viewer' where user_id=${q(viewer)};
insert into public.agencies(name)values(${q(one)}),(${q(two)});
insert into public.vehicles(key,plate,agency_id)select name,name,id from public.agencies where name in(${q(one)},${q(two)});
insert into public.user_agencies(user_id,agency_id)select ${q(viewer)},id from public.agencies where name=${q(one)};
insert into public.desktop_vehicle_live(vehicle_key,data,observed_at)values(${q(one)},${j({device_id:'g1',captured_at:'2026-11-04T09:00:00Z'})},'2000-01-01'),(${q(two)},${j({device_id:'g2',captured_at:'2026-11-04T09:00:00Z'})},'2000-01-01');
update public.desktop_vehicle_live set data=${j({device_id:'g1',captured_at:'2026-11-04T08:00:00Z'})} where vehicle_key=${q(one)};
${auth(viewer).replace('::jsonb;',';')}
select jsonb_build_object('visible',(select count(*) from public.desktop_vehicle_live),'current',(select data->>'captured_at' from public.desktop_vehicle_live),'serverTime',(select observed_at>now()-interval '1 minute' from public.desktop_vehicle_live),'writeAllowed',has_table_privilege('authenticated','public.desktop_vehicle_live','INSERT'));
rollback;`;
const result=JSON.parse(run(rls));assert.deepEqual(result,{visible:1,current:'2026-11-04T09:00:00Z',serverTime:true,writeAllowed:false});
console.log(JSON.stringify({ok:true,operations,checks:8,rolledBack:true,externalRequests:0}));
