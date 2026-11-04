import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';
import {normalizeUberEarnings,parseUberEarningsPeriod} from '../server/uber-earnings.mjs';
assertLocalProject();
if(process.argv.slice(2).some(arg=>!['--with-migration','--with-validation-fix'].includes(arg)))throw Error('Unsupported option');
const now=Date.now(),org=randomUUID(),p=globalThis.LudyMoroccoTime.moroccoParts(now),day=[p.day,p.month].map(n=>String(n).padStart(2,'0')).join('/')+'/'+p.year;
const breakdown={complete:true,entries:[{field:'fare',label:'Fare',amount:'847 MAD'},{field:'commission',label:'Service Fee',amount:'-148 MAD'},{field:'taxes',label:'Taxes',amount:'-29 MAD'}]};
const metrics={revenue:'670 MAD',reported_net_earnings:'315 MAD',payout:'-382 MAD',adjustments:'27 MAD'};
const input={version:1,source:'uber_fleet_earnings',organizationId:org,sourceUrl:'https://fleethub.uber.com/orgs/'+org+'/earnings',observedAt:new Date(now).toISOString(),providerPeriod:parseUberEarningsPeriod(day+' 00:00 - '+day+' 23:59'),currency:'MAD',fleet:metrics,fleetBreakdown:breakdown,drivers:[{providerDriverId:null,driverName:'Synthetic calculation',driverNameComplete:true,metrics,breakdown}],coverage:{complete:true,filtered:false,driverRowsObserved:1,driverRowsTotal:1,pages:1}};
const normalized=normalizeUberEarnings(input,{organizationId:org,now}),q=value=>"'"+String(value).replaceAll("'","''")+"'",j=value=>q(JSON.stringify(value))+'::jsonb';
const check=(condition,name)=>`do $$ begin if not coalesce((${condition}),false) then raise exception 'calculation-test: ${name}';end if;end $$;`;
const bad=[];
for(const mutate of [s=>s.fleet.gross_minor++,s=>s.fleet.net_minor++,s=>s.fleet.taxes_minor++,s=>s.fleet_provenance.entries[0].minor++,s=>s.fleet_provenance.entries.push(s.fleet_provenance.entries[0]),s=>delete s.fleet_provenance.version,s=>s.fleet_provenance.version='1',s=>s.fleet_provenance={version:1,status:'unavailable'},s=>s.drivers[0].financial_provenance.total_minor++,s=>s.drivers[0].financial_provenance.entries[0].label='Unproved label']){const value=structuredClone(normalized);mutate(value);bad.push(value);}
const sql=['begin;',LOCAL_GUARD,...(process.argv.includes('--with-migration')?[readFileSync(new URL('../supabase/migrations/20261228000000_provider_earnings_calculations.sql',import.meta.url),'utf8')]:[]),...(process.argv.includes('--with-migration')||process.argv.includes('--with-validation-fix')?[readFileSync(new URL('../supabase/migrations/20261229000000_provider_earnings_proof_validation.sql',import.meta.url),'utf8')]:[]),
 `select public.provider_earnings_commit(${j(normalized)}) is not null;`,
 check(`(select fleet_amounts->>'gross_minor'='84700' and fleet_amounts->>'net_minor'='69900' and fleet_amounts->>'taxes_minor'='-2900' and fleet_amounts->>'reported_net_earnings_minor'='31500' and financial_provenance->>'status'='verified' from public.provider_earnings_snapshots where organization_id=${q(org)})`,'named_definition_and_settlement_distinct'),
 check(`(select amounts->>'gross_minor'='84700' and amounts->>'net_minor'='69900' and financial_provenance->>'status'='verified' and agency_id is null from public.provider_earnings_rows where organization_id=${q(org)})`,'driver_proof_stored_without_fuzzy_mapping'),
 ...bad.map((value,i)=>`do $$ begin begin perform public.provider_earnings_commit(${j(value)});exception when raise_exception then return;end;raise exception 'calculation-test: forged_${i}';end $$;`),
 check(`(select fleet_amounts->>'gross_minor'='84700' from public.provider_earnings_snapshots where organization_id=${q(org)})`,'rejected_writes_preserve_prior'),
 check("not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename in ('provider_earnings_rows','provider_earnings_snapshots'))",'no_financial_publication'),
 'rollback;'].join('\n');
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']).map(v=>v==='--username=postgres'?'--username=supabase_admin':v),{input:sql,encoding:'utf8',timeout:30000,maxBuffer:1048576,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)))});
if(result.error||result.status!==0)throw Error('Financial proof transaction failed: '+(String(result.stderr).match(/calculation-test: ([a-z_0-9]+)/)?.[1]||'SQL validation'));
assert.equal(result.stdout.trim(),'t');console.log(JSON.stringify({ok:true,checks:14,rolledBack:true,target:'local-staging-only'}));
