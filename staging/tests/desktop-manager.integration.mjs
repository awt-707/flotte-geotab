import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {normalizeDemandImport} from '../server/demand-analytics.mjs';
assertLocalProject();if(process.argv.length!==2)throw Error('No target options accepted.');
const admin=randomUUID(),manager=randomUUID(),viewer=randomUUID(),foreignManager=randomUUID(),agency=Date.now()*1000+randomInt(500),ruleA=randomUUID(),ruleB=randomUUID();
const owner="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const q=v=>"'"+String(v).replaceAll("'","''")+"'",j=v=>q(JSON.stringify(v))+'::jsonb';
const auth=id=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(id)};set local request.jwt.claims=${q(JSON.stringify({sub:id,role:'authenticated'}))};`;
const call=(resource,method,{params={},body={},prefer=null}={})=>`public.desktop_manager_request(${q(resource)},${q(method)},${j(params)},${j(body)},${prefer===null?'null':q(prefer)})`;
const rule={agency_id:agency,city:'Casablanca',days:[1,3],start:'08:00',end:'09:00',enabled:true,label:'Synthetic rule'};
const record=normalizeDemandImport({agency_id:agency,city:'Casablanca',file_name:'synthetic.csv',rows:[{external_id:'synthetic-'+randomUUID(),started_at:'2026-10-31T12:00:00Z',pickup_zone:'Synthetic pickup',status:'completed'}]});
const imported={p_import:record,p_rows:record.rows};
const foreignRecord={...record,agency_id:agency+1,city:'Marrakech'},foreignImport={p_import:foreignRecord,p_rows:record.rows};
let checks=0;const check=(condition,label)=>{checks++;return `do $$begin if (${condition}) is distinct from true then raise exception 'desktop-manager-test: ${label}';end if;end$$;`;};
const reject=(sql,label,state='42501')=>{checks++;return `do $$declare denied boolean:=false;begin begin ${sql};exception when sqlstate '${state}' then denied:=true;end;if not denied then raise exception 'desktop-manager-test: ${label}';end if;end$$;`;};
const sql=['begin;',"set local statement_timeout='20s';set local lock_timeout='2s';",LOCAL_GUARD,
 readFileSync(new URL('../production/desktop-manager.sql',import.meta.url),'utf8'),
 ...[admin,manager,viewer,foreignManager].map((id,i)=>`insert into auth.users(id,email,aud,role) values(${q(id)},${q(id+'@example.invalid')},'authenticated','authenticated');update public.profiles set role=${q(['admin','manager','viewer','manager'][i])} where user_id=${q(id)};`),
 `insert into public.agencies(id,name,city) overriding system value values(${agency},'Synthetic scope A','Casablanca'),(${agency+1},'Synthetic scope B','Marrakech');`,
 `insert into public.user_agencies(user_id,agency_id) values(${q(manager)},${agency}),(${q(viewer)},${agency}),(${q(foreignManager)},${agency+1});`,
 `insert into public.ops_rush_rules(id,agency_id,city,days,start,"end",enabled,label) values(${q(ruleA)},${agency},'Casablanca','[1]','08:00','09:00',true,'Synthetic A'),(${q(ruleB)},${agency+1},'Marrakech','[1]','08:00','09:00',true,'Synthetic B');`,
 auth(viewer),reject('perform '+call('ops_rush_rules','POST',{body:rule}),'viewer_even_in_agency_cannot_write'),
 auth(randomUUID()),reject('perform '+call('ops_rush_rules','POST',{body:rule}),'profile_missing_denied'),
 owner,'set local role anon;',reject('perform '+call('ops_rush_rules','POST',{body:rule}),'anonymous_denied'),
 owner,'set local role service_role;',reject('perform '+call('ops_rush_rules','POST',{body:rule}),'service_role_without_user_denied'),
 auth(manager),
 check(`(${call('ops_rush_rules','POST',{body:rule,prefer:'return=representation'})}->'body'->0->>'agency_id')=${q(agency)}`,'manager_creates_own_agency_rule'),
 check(`(${call('ops_rush_rules','PATCH',{params:{id:'eq.'+ruleA},body:{...rule,label:'Synthetic changed'},prefer:'return=representation'})}->'body'->0->>'label')='Synthetic changed'`,'manager_updates_same_agency_rule'),
 reject('perform '+call('ops_rush_rules','POST',{body:{...rule,agency_id:agency+1,city:'Marrakech'}}),'new_rule_foreign_agency_refused'),
 reject('perform '+call('ops_rush_rules','PATCH',{params:{id:'eq.'+ruleB},body:rule}),'cannot_steal_foreign_rule_into_own_agency'),
 reject('perform '+call('ops_rush_rules','PATCH',{params:{id:'eq.'+ruleA},body:{...rule,agency_id:agency+1,city:'Marrakech'}}),'cannot_move_own_rule_to_foreign_agency'),
 reject('perform '+call('ops_rush_rules','PATCH',{params:{id:'eq.'+ruleA,agency_id:'eq.'+agency},body:rule}),'selector_allowlist','22023'),
 reject('perform '+call('ops_rush_rules','PATCH',{body:rule}),'bounded_rule_selector_required','22023'),
 reject('perform '+call('ops_rush_rules','POST',{body:{...rule,id:randomUUID()}}),'rule_id_not_client_supplied','22023'),
 reject('perform '+call('ops_rush_rules','POST',{body:{...rule,city:'Marrakech'}}),'agency_city_consistency','22023'),
 reject('perform '+call('ops_rush_rules','POST',{body:{...rule,city:null}}),'null_city_denied','22023'),
 reject('perform '+call('ops_rush_rules','POST',{body:{...rule,days:[1,1]}}),'duplicate_weekdays_denied','22023'),
 reject('perform '+call('ops_rush_rules','POST',{body:{...rule,days:[0]}}),'invalid_weekday_denied','22023'),
 reject('perform '+call('fleet_settings','PATCH',{params:{id:'eq.1'},body:{enabled:false}}),'no_admin_capability_escalation','22023'),
 reject('perform '+call('ops_rush_rules','DELETE',{params:{id:'eq.'+ruleA}}),'no_generic_delete','22023'),
 reject('perform '+call('rpc/ops_import_demand','POST',{body:foreignImport}),'foreign_import_denied'),
 check(`(${call('rpc/ops_import_demand','POST',{body:imported})}->'body'->>'inserted')='1'`,'normalized_import_in_own_agency'),
 check(`(${call('rpc/ops_import_demand','POST',{body:imported})}->'body'->>'duplicate')::boolean`,'same_agency_reimport_idempotent'),
 reject('perform '+call('rpc/ops_import_demand','POST',{body:{...imported,p_other:true}}),'import_extra_rpc_argument_denied','22023'),
 reject('perform '+call('rpc/ops_import_demand','POST',{body:{p_import:{...record,city:'Marrakech'},p_rows:record.rows}}),'import_city_scope_consistency','22023'),
 reject('perform '+call('rpc/ops_import_demand','POST',{body:{p_import:{...record,rows:[{...record.rows[0],agency_id:agency+1}]},p_rows:[{...record.rows[0],agency_id:agency+1}]}}),'per_row_agency_override_denied','22023'),
 reject('perform '+call('rpc/ops_import_demand','POST',{body:{p_import:record,p_rows:[{...record.rows[0],pickup_zone:'Conflicting duplicate envelope'}]}}),'duplicate_rows_envelopes_must_match','22023'),
 reject('perform '+call('rpc/ops_import_demand','POST',{body:{p_import:{...record,rows:[{...record.rows[0],started_at:'2026-10-31 12:00:00'}]},p_rows:[{...record.rows[0],started_at:'2026-10-31 12:00:00'}]}}),'naive_import_time_not_accepted','22023'),
 auth(foreignManager),
 check(`(${call('rpc/ops_import_demand','POST',{body:foreignImport})}->'body'->>'inserted')='1'`,'same_ride_key_is_scoped_to_foreign_manager_agency'),
 owner,
 check(`(select count(*) from public.ops_demand_rides where agency_id in(${agency},${agency+1}) and ride_key=${q(record.rows[0].ride_key)})=2`,'same_ride_key_never_overwrites_other_agency'),
 check(`(select city='Casablanca' and pickup_zone='Synthetic pickup' from public.ops_demand_rides where agency_id=${agency} and ride_key=${q(record.rows[0].ride_key)})`,'original_agency_data_preserved'),
 check(`(select agency_id=${agency+1} and label='Synthetic B' from public.ops_rush_rules where id=${q(ruleB)})`,'foreign_rule_preserved'),
 `delete from public.user_agencies where user_id=${q(manager)} and agency_id=${agency};`,auth(manager),
 reject('perform '+call('ops_rush_rules','PATCH',{params:{id:'eq.'+ruleA},body:rule}),'membership_revoked_blocks_rule'),
 reject('perform '+call('rpc/ops_import_demand','POST',{body:imported}),'membership_revoked_blocks_import'),
 owner,`insert into public.user_agencies(user_id,agency_id) values(${q(manager)},${agency});update public.profiles set role='viewer' where user_id=${q(manager)};`,auth(manager),
 reject('perform '+call('ops_rush_rules','PATCH',{params:{id:'eq.'+ruleA},body:rule}),'role_revoked_blocks_rule'),
 auth(admin),check(`(${call('ops_rush_rules','PATCH',{params:{id:'eq.'+ruleB},body:{...rule,agency_id:agency+1,city:'Marrakech'},prefer:'return=representation'})}->'body'->0->>'agency_id')=${q(agency+1)}`,'admin_without_membership_allowed'),
 owner,check(`not has_function_privilege('anon','public.desktop_manager_request(text,text,jsonb,jsonb,text)','EXECUTE')`,'anonymous_execute_absent'),
 check(`(select value='staging' from public.params where key='environment')`,'environment_preserved'),
 'rollback;'].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(v=>v==='--username=postgres'?'--username=supabase_admin':v),{input:sql,encoding:'utf8',timeout:45000,maxBuffer:1048576,env});
if(result.error||result.status!==0){const dir=new URL('../.local/checks/',import.meta.url);mkdirSync(dir,{recursive:true,mode:0o700});const file=new URL('desktop-manager-private-error.log',dir);writeFileSync(file,String(result.stderr),{mode:0o600});chmodSync(file,0o600);throw Error('Local desktop manager rollback failed: '+(String(result.stderr).match(/desktop-manager-test: ([a-z_0-9]+)/)?.[1]||'SQL validation; private diagnostic'));}
assert.equal(result.stdout.trim(),'');console.log(JSON.stringify({ok:true,checks,rolledBack:true,target:'local-staging-only',managerAgencyScoped:true,noDeviceRequired:true}));
