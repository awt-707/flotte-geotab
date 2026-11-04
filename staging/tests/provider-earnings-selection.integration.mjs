import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalProject} from '../scripts/guard.mjs';
import {LOCAL_GUARD,dockerArgs} from '../scripts/import-reference.mjs';

assertLocalProject();
const args=process.argv.slice(2);
if(args.length>1||args.some(arg=>arg!=='--with-migration'))throw Error('Only --with-migration is supported.');
const simulate=args.includes('--with-migration'),suffix=randomUUID(),organization=randomUUID(),emptyOrganization=randomUUID(),hiddenOrganization=randomUUID();
const agency=Date.now()*1000+randomInt(500),roles=['admin','manager','viewer','pending'];
const users=Object.fromEntries(roles.map(role=>[role,randomUUID()]));
const capOrganizations=Array.from({length:51},()=>randomUUID());
const start='2025-01-06T04:00:00Z',end='2025-01-06T07:03:00Z';
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const j=value=>q(JSON.stringify(value))+'::jsonb';
const uuidArray=ids=>'array['+ids.map(q).join(',')+']::uuid[]';
const fields=['revenue','gross','net','cash','payout','refunds_expenses','adjustments','start_balance','end_balance','fare','tips','tolls','bonus','commission','reported_net_earnings'];
const amounts=Object.fromEntries(fields.map(field=>[field+'_minor',field==='revenue'?10000:null]));
const owner="reset role;set local request.jwt.claim.sub='';set local request.jwt.claims='{}';";
const auth=role=>`reset role;set local role authenticated;set local request.jwt.claim.sub=${q(users[role])};set local request.jwt.claims=${q(JSON.stringify({sub:users[role],role:'authenticated'}))};`;
function call({from=q(start),to=q(end),orgs=uuidArray([organization]),agencyId='null',driver='null'}={}){
 return `public.provider_earnings_select_windows(${from}::timestamptz,${to}::timestamptz,${orgs},${agencyId},${driver})`;
}
const ids=options=>`(${call(options)}->'snapshot_ids')`;
const sid=n=>`md5(${q(suffix)}||'-snapshot-'||${n})::uuid`;
let checks=0;
const check=(condition,label)=>{checks++;return `do $t$ begin if (${condition}) is distinct from true then raise exception 'selection-test: ${label}';end if;end $t$;`;};
const reject=(statement,label,exception='others')=>{checks++;return `do $t$ declare refused boolean:=false;begin begin ${statement};exception when ${exception} then refused:=true;end;if not refused then raise exception 'selection-test: ${label}';end if;end $t$;`;};
const migration=readFileSync(new URL('../supabase/migrations/20261227000000_provider_earnings_selection.sql',import.meta.url),'utf8');
const columns='id,source,organization_id,period_start,period_end,time_zone,period_label,period_mode,currency,observed_at,sha256,content_fingerprint,mapping_fingerprint,coverage,mapping_complete,fleet_amounts,source_url';
const sql=[
 "begin;set local statement_timeout='25s';set local lock_timeout='2s';set local client_min_messages=warning;",LOCAL_GUARD,...(simulate?[migration]:[]),
 `insert into public.agencies(id,name,city) overriding system value values (${agency},'Synthetic selection A','Casablanca'),(${agency+1},'Synthetic selection B','Marrakech');`,
 `insert into auth.users(id,email,aud,role) values ${roles.map(role=>`(${q(users[role])},${q('selection-'+role+'-'+suffix+'@example.invalid')},'authenticated','authenticated')`).join(',')};`,
 ...roles.map(role=>`update public.profiles set role=${q(role)} where user_id=${q(users[role])};`),
 `insert into public.user_agencies(user_id,agency_id) values (${q(users.manager)},${agency}),(${q(users.viewer)},${agency});`,
 // 34,034 historical driver rows exceed the old 20,000-row browser ceiling.
 `insert into public.provider_earnings_snapshots(${columns})
 select ${sid('g')},'uber',${q(organization)},${q(start)}::timestamptz,
   ${q(start)}::timestamptz+interval '1 hour'+g*interval '1 minute','Africa/Casablanca','Synthetic moving end','custom','MAD',
   '2025-02-01'::timestamptz+g*interval '1 minute',repeat('0',64),'synthetic','synthetic',
   jsonb_build_object('complete',g<>1001,'driver_rows_observed',34),true,${j(amounts)},'https://example.invalid/synthetic'
 from generate_series(1,1001) g;`,
 `insert into public.provider_earnings_rows(snapshot_id,provider_row,source,organization_id,period_start,period_end,time_zone,currency,observed_at,snapshot_revision,coverage_complete,mapping_complete,agency_rows_total,driver_rows_total,provider_driver_id,driver_name,driver_name_complete,fleet_driver_id,driver_code,agency_id,mapping_status,amounts)
 select s.id,n,'uber',s.organization_id,s.period_start,s.period_end,s.time_zone,s.currency,s.observed_at,1,
   (s.coverage->>'complete')::boolean,true,17,1,md5(${q(suffix)}||'-provider-'||n)::uuid,'Synthetic Driver',true,
   md5(${q(suffix)}||'-driver-'||n)::uuid,${q('SELECT-'+suffix+'-')}||n,${agency}+n/17,'confirmed',${j(amounts)}
 from public.provider_earnings_snapshots s cross join generate_series(0,33) n where s.organization_id=${q(organization)};`,
 `create temporary table selection_before as select count(*) as rows,sum(snapshot_revision) as revisions from public.provider_earnings_rows where organization_id=${q(organization)};`,
 check('(select rows from selection_before)=34034','large_archive_fixture'),
 auth('admin'),
 check(`(${call()}->>'version')::integer=1 and (${call()}->>'selection_complete')::boolean`,'versioned_complete_selector'),
 check(`jsonb_array_length(${ids()})=2 and ${ids()} ? (${sid(123)})::text and ${ids()} ? (${sid(1000)})::text`,'old_exact_plus_latest_complete_only'),
 check(`not(${ids()} ? (${sid(1001)})::text)`,'recent_partial_does_not_hide_complete'),
 check(`(select count(*) from public.provider_earnings_rows where snapshot_id in (select value::uuid from jsonb_array_elements_text(${ids()})))=68`,'bounded_financial_row_read'),
 check(`jsonb_array_length(${ids({to:q('2025-02-01')})})=1`,'latest_only_when_no_exact_window'),
 check(`jsonb_array_length(${ids({orgs:uuidArray([randomUUID()])})})=0`,'unknown_organization_empty'),
 check(`jsonb_array_length(${ids({from:q('2024-01-01'),to:q('2024-02-01')})})=0`,'nonoverlap_empty'),
 auth('manager'),
 check(`jsonb_array_length(${ids({agencyId:agency})})=2`,'manager_selects_visible_agency_windows'),
 check(`(select count(*) from public.provider_earnings_rows where snapshot_id in (select value::uuid from jsonb_array_elements_text(${ids({agencyId:agency})})))=34`,'manager_reads_only_own_rows'),
 check(`(select count(*) from public.provider_earnings_snapshots where organization_id=${q(organization)})=0`,'manager_has_no_fleet_headers'),
 check(`jsonb_array_length(${ids({driver:q('SELECT-'+suffix+'-0')})})=2`,'confirmed_driver_scope'),
 check(`jsonb_array_length(${ids({driver:q('SELECT-'+suffix+'-33')})})=0`,'other_agency_driver_hidden'),
 reject(`perform ${call({agencyId:agency+1})}`,'foreign_agency_rejected','insufficient_privilege'),
 check(`jsonb_array_length(${ids()})=2`,'manager_all_visible_stays_bounded'),
 owner,
 // If no complete capture exists, return the newest partial, plus the exact one.
 `update public.provider_earnings_snapshots set coverage=jsonb_set(coverage,'{complete}','false') where organization_id=${q(organization)};`,
 `update public.provider_earnings_rows set coverage_complete=false where organization_id=${q(organization)};`,
 auth('admin'),check(`${ids()} ? (${sid(1001)})::text and not(${ids()} ? (${sid(1000)})::text)`,'partial_fallback_when_no_complete'),
 auth('manager'),check(`${ids({agencyId:agency})} ? (${sid(1001)})::text`,'manager_partial_fallback'),
 owner,
 // Header-only fleet snapshots are visible to admins without fabricating rows.
 `insert into public.provider_earnings_snapshots(${columns}) values
   (gen_random_uuid(),'uber',${q(emptyOrganization)},${q(start)},${q(end)},'Africa/Casablanca','Synthetic empty fleet','custom','MAD','2025-02-01',repeat('0',64),'synthetic','synthetic','{"complete":true,"driver_rows_observed":0}',true,${j(amounts)},'https://example.invalid/synthetic'),
   (gen_random_uuid(),'uber',${q(hiddenOrganization)},${q(start)},${q(end)},'Africa/Casablanca','Synthetic unmatched fleet','custom','USD','2025-02-01',repeat('0',64),'synthetic','synthetic','{"complete":false,"driver_rows_observed":0}',false,${j(amounts)},'https://example.invalid/synthetic');`,
 auth('admin'),check(`jsonb_array_length(${ids({orgs:uuidArray([emptyOrganization])})})=1`,'admin_empty_fleet_retained'),
 check(`jsonb_array_length(${ids({orgs:uuidArray([emptyOrganization]),agencyId:agency})})=0`,'scoped_admin_uses_rows_only'),
 auth('manager'),check(`jsonb_array_length(${ids({orgs:uuidArray([emptyOrganization,hiddenOrganization])})})=0`,'manager_cannot_enumerate_headers'),
 owner,
 // Extra currencies remain distinct; no implicit first-currency-only selection.
 `insert into public.provider_earnings_snapshots(${columns}) select gen_random_uuid(),source,organization_id,period_start,period_end,time_zone,period_label,period_mode,'EUR',observed_at,sha256,content_fingerprint,mapping_fingerprint,coverage,mapping_complete,fleet_amounts,source_url from public.provider_earnings_snapshots where id=${sid(123)};`,
 auth('admin'),check(`jsonb_array_length(${ids()})=3`,'every_currency_kept'),
 ...['viewer','pending'].flatMap(role=>[auth(role),reject(`perform ${call()}`,role+'_denied','insufficient_privilege')]),
 owner,'set local role authenticated;',reject(`perform ${call()}`,'missing_identity_denied','insufficient_privilege'),
 owner,'set local role anon;',reject(`perform ${call()}`,'anon_cannot_execute','insufficient_privilege'),
 owner,'set local role service_role;',reject(`perform ${call()}`,'service_cannot_execute_read_rpc','insufficient_privilege'),
 auth('admin'),
 reject(`perform ${call({to:q(start)})}`,'empty_period_refused','invalid_parameter_value'),
 reject(`perform ${call({from:q('infinity')})}`,'infinite_period_refused','invalid_parameter_value'),
 reject(`perform ${call({to:q('2027-01-01')})}`,'overlong_period_refused','invalid_parameter_value'),
 reject(`perform ${call({orgs:'null'})}`,'null_organizations_refused','invalid_parameter_value'),
 reject(`perform ${call({orgs:'array[null]::uuid[]'})}`,'null_organization_entry_refused','invalid_parameter_value'),
 reject(`perform ${call({orgs:uuidArray(Array(101).fill(organization))})}`,'too_many_organization_filters_refused','invalid_parameter_value'),
 reject(`perform ${call({agencyId:0})}`,'nonpositive_agency_refused','invalid_parameter_value'),
 reject(`perform ${call({driver:q(' ')})}`,'empty_driver_refused','invalid_parameter_value'),
 owner,
 `insert into public.provider_earnings_snapshots(${columns}) select gen_random_uuid(),'uber',org,${q(start)}::timestamptz,${q(end)}::timestamptz+g*interval '1 minute','Africa/Casablanca','Synthetic cap','custom','MAD','2025-02-01'::timestamptz+g*interval '1 minute',repeat('0',64),'synthetic','synthetic','{"complete":true,"driver_rows_observed":0}',true,${j(amounts)},'https://example.invalid/synthetic' from unnest(${uuidArray(capOrganizations)}) org cross join generate_series(0,1) g;`,
 auth('admin'),reject(`perform ${call({orgs:uuidArray(capOrganizations)})}`,'selection_overflow_refused_not_truncated','program_limit_exceeded'),
 owner,
 check(`(select b.rows=count(*) and b.revisions=sum(r.snapshot_revision) from public.provider_earnings_rows r cross join selection_before b where r.organization_id=${q(organization)} group by b.rows,b.revisions)`,'selection_preserves_historical_rows_and_revisions'),
 check("(select not prosecdef and provolatile='s' from pg_proc where oid='public.provider_earnings_select_windows(timestamptz,timestamptz,uuid[],bigint,text)'::regprocedure)",'stable_invoker_contract'),
 check("not exists(select 1 from pg_publication_tables where schemaname='public' and tablename in ('provider_earnings_snapshots','provider_earnings_rows'))",'no_financial_publication'),
 "rollback;select 'PROVIDER_EARNINGS_SELECTION_ROLLBACK_OK';"
].join('\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));
const result=spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--set=VERBOSITY=verbose','--file=/dev/stdin']).map(value=>value==='--username=postgres'?'--username=supabase_admin':value),{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1048576});
if(result.error||result.status!==0){const error=String(result.stderr||''),label=error.match(/selection-test: ([a-zA-Z0-9_]+)/)?.[1],state=error.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1],known=[...migration.matchAll(/raise exception '([^']+)'/g)].map(m=>m[1]).find(message=>error.includes(': '+message+'\n'));throw Error('Earnings selection rehearsal rolled back: '+(label||known||state||'local execution failure'));}
assert.equal(result.stdout.trim(),'PROVIDER_EARNINGS_SELECTION_ROLLBACK_OK');
console.log(JSON.stringify({ok:true,checks,archiveRows:34034,target:'local-staging-only',migrationSimulated:simulate,rolledBack:true}));
