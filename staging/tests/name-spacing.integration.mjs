import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();const include=process.argv.includes('--with-migration'),suffix=randomUUID(),id=randomUUID(),other=randomUUID();
const q=s=>"'"+String(s).replaceAll("'","''")+"'",code='spacing-'+suffix,copy='spacing-copy-'+suffix;
const name='Synthetic Elperson '+suffix.replaceAll('-','').replace(/[0-9]/g,'z');const ref=name.replace('Elperson','El Person');
const call=`fleet_auto_link_driver_spacing(${q(id)},${q(code)},${q(name)},${q(ref)})`;
let checks=0;const check=c=>{checks++;return `do $$ begin if (${c}) is distinct from true then raise exception 'spacing assertion ${checks}'; end if;end $$;`;};
const sql=["begin;load 'safeupdate';set local lock_timeout='2s';set local statement_timeout='15s';",LOCAL_GUARD,
include?readFileSync(new URL('../supabase/migrations/20261125000000_name_spacing.sql',import.meta.url),'utf8'):'',
`insert into drivers(code,name) values(${q(code)},${q(ref)}),(${q(copy)},${q(ref.replace('El Person','Elper Son'))});insert into fleet_drivers(id,name) values(${q(id)},${q(name)});set local role service_role;`,
check(`${call} is null`),
`delete from drivers where code=${q(copy)};update fleet_drivers set auto_link_disabled=true where id=${q(id)};`,check(`${call} is null`),
`update fleet_drivers set auto_link_disabled=false where id=${q(id)};insert into fleet_drivers(id,name) values(${q(other)},${q(ref)});insert into fleet_identities(driver_id,source,source_key,organization_id) values(${q(id)},'uber',${q('one-'+suffix)},'synthetic'),(${q(other)},'uber',${q('two-'+suffix)},'synthetic');`,check(`${call} is null`),
`delete from fleet_identities where driver_id=${q(other)};delete from fleet_drivers where id=${q(other)};`,
check(`fleet_auto_link_driver_spacing(${q(id)},${q(code)},'Different Person',${q(ref)}) is null`),check(`${call}=${q(id)}::uuid`),
check(`(select link_method='name_spacing' and not auto_link_disabled and vehicle_key is null from fleet_drivers where id=${q(id)})`),check(`exists(select 1 from fleet_link_audit where driver_id=${q(id)} and method='name_spacing')`),
`reset role;set local role authenticated;do $$ declare denied boolean:=false;begin begin perform ${call};exception when insufficient_privilege then denied:=true;end;if not denied then raise exception 'browser RPC forbidden';end if;end $$;reset role;rollback;`].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
const args=dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(a=>a==='--username=postgres'?'--username=supabase_admin':a);
const r=spawnSync('docker',args,{env,input:sql,encoding:'utf8',timeout:25000});assert.equal(r.status,0,'Local matching validation failed: '+r.stderr);console.log(JSON.stringify({ok:true,checks:checks+1,rolled_back:true}));
