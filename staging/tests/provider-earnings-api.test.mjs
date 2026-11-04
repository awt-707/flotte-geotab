import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createProviderEarningsApi} from '../server/provider-earnings-api.mjs';
import {parseUberEarningsPeriod} from '../server/uber-earnings.mjs';

const USER='11111111-1111-4111-8111-111111111111',ORG='22222222-2222-4222-8222-222222222222';
const DRIVER='33333333-3333-4333-8333-333333333333',SNAPSHOT='44444444-4444-4444-8444-444444444444';
const NOW=Date.parse('2026-11-03T12:00:00Z');
const receipt={snapshot_id:SNAPSHOT,revision:1,duplicate:false,ignored:false,rows:1,matched:1,unmatched:0,coverage_complete:true,mapping_complete:true};
const payload=()=>({version:1,source:'uber_fleet_earnings',organizationId:ORG,
 sourceUrl:`https://fleethub.uber.com/orgs/${ORG}/earnings?private-query=must-not-persist`,observedAt:new Date(NOW).toISOString(),
 providerPeriod:{...parseUberEarningsPeriod('02/11/2026 04:00 - 09/11/2026 04:00'),mode:'custom'},currency:'MAD',
 fleet:{revenue:'300 MAD',gross:'400 MAD',net:'250 MAD',payout:'100 MAD',end_balance:'999 MAD'},
 drivers:[{providerDriverId:DRIVER,driverName:'Synthetic Driver',driverNameComplete:true,metrics:{revenue:'300 MAD'}}],
 coverage:{complete:true,filtered:false,driverRowsObserved:1,driverRowsTotal:1,pages:1}});

function fixture({role='admin',config={enabled:true,organization_id:ORG,organization_label:'Synthetic fleet'},rpcReply=receipt,failTable=null,failAuth=false,throwRequest=false}={}){
 const calls=[];
 const fetchFn=async(url,options={})=>{
  const u=new URL(url),table=u.pathname.split('/').at(-1),token=options.headers.Authorization.slice(7);
  assert.equal(u.origin,'http://127.0.0.1:57421','the API never calls Uber, Bolt or a supplied URL');
  calls.push({path:u.pathname,table,token,apikey:options.headers.apikey,method:options.method||'GET',params:Object.fromEntries(u.searchParams),body:options.body?JSON.parse(options.body):null});
  if(throwRequest)throw Error('SENSITIVE network credential and internal connection detail');
  if(u.pathname==='/auth/v1/user')return failAuth?Response.json({error:'SENSITIVE expired token'},{status:401}):Response.json({id:USER});
  if(table===failTable)return Response.json({message:'SENSITIVE database detail',service_key:'SENSITIVE'},{status:500});
  if(table==='profiles')return Response.json(role===null?[]:[{user_id:USER,role}]);
  if(table==='uber_report_settings')return Response.json(config===null?[]:[config]);
  if(table==='provider_earnings_commit')return Response.json(rpcReply);
  throw Error('Unexpected local request');
 };
 const handler=createProviderEarningsApi({supabaseUrl:'http://127.0.0.1:57421',anonKey:'test-anon-key',serviceKey:'test-service-key',fetchFn,now:()=>NOW});
 async function request({method='GET',url='/api/provider-earnings/config',token='test-admin-token',headers={},address='127.0.0.1',body,rawBody}={}){
  const req=Readable.from(rawBody!==undefined?[Buffer.from(rawBody)]:body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  Object.assign(req,{method,url,headers:{host:'127.0.0.1:4173',origin:'http://127.0.0.1:4173',...(token?{authorization:'Bearer '+token}:{}),...headers},socket:{remoteAddress:address}});
  let response;const res={writeHead(status,h){response={status,headers:h};},end(text){response.body=JSON.parse(text);}};
  assert.equal(await handler(req,res),true);return response;
 }
 return {calls,request};
}

test('configuration is available to an authenticated admin or manager with no service credential in the reply',async()=>{
 for(const role of ['admin','manager']){
  const f=fixture({role}),result=await f.request();assert.equal(result.status,200);
  assert.equal(result.body.uber.organization_id,ORG);assert.equal(result.body.uber.time_zone,'Africa/Casablanca');assert.equal(result.body.uber.interval_seconds,300);assert.equal(result.body.uber.interval_basis,'after_completion');
  assert.equal(result.body.bolt.canReplaceLegacyStatements,false);assert.equal(result.headers['Cache-Control'],'no-store');
  assert.equal(f.calls.find(c=>c.table==='profiles').token,'test-admin-token');
  assert.equal(f.calls.find(c=>c.table==='profiles').params.user_id,'eq.'+USER);
  assert.equal(f.calls.find(c=>c.table==='uber_report_settings').token,'test-service-key');
  assert.doesNotMatch(JSON.stringify(result),/test-service-key|test-admin-token|SENSITIVE/);
 }
});
test('missing or expired sessions and non-management roles never read financial settings',async()=>{
 for(const setup of [{token:null,status:401},{failAuth:true,status:401},{role:'viewer',status:403},{role:'pending',status:403},{role:null,status:403}]){
  const f=fixture(setup),response=await f.request(Object.hasOwn(setup,'token')?{token:setup.token}:{});assert.equal(response.status,setup.status);
  assert.ok(!f.calls.some(c=>c.table==='uber_report_settings'||c.table==='provider_earnings_commit'));
  assert.doesNotMatch(JSON.stringify(response),/SENSITIVE/);
 }
});
test('foreign origins, hosts and remote addresses are rejected before authentication',async()=>{
 for(const options of [{headers:{origin:'https://outside.invalid'}},{headers:{host:'outside.invalid:4173'}},{address:'192.0.2.50'}]){
  const f=fixture(),response=await f.request(options);assert.equal(response.status,403);assert.equal(f.calls.length,0);
 }
});
test('manager may read configuration but only admin may ingest snapshots',async()=>{
 const f=fixture({role:'manager'}),response=await f.request({method:'POST',url:'/api/provider-earnings/uber',body:{snapshot:payload()}});
 assert.equal(response.status,403);assert.ok(!f.calls.some(c=>c.table==='provider_earnings_commit'||c.table==='uber_report_settings'));
});
test('admin ingestion normalizes money and makes exactly one atomic local service RPC',async()=>{
 const f=fixture({rpcReply:{...receipt,private_token:'SENSITIVE'}}),input=payload();input.drivers[0].agency_id=999;
 const response=await f.request({method:'POST',url:'/api/provider-earnings/uber',body:{snapshot:input}});assert.equal(response.status,200);assert.deepEqual(response.body,receipt);
 const calls=f.calls.filter(c=>c.method==='POST');assert.equal(calls.length,1);assert.equal(calls[0].table,'provider_earnings_commit');
 assert.equal(calls[0].token,'test-service-key');assert.equal(calls[0].apikey,'test-service-key');
 const value=calls[0].body.p_snapshot;assert.equal(value.organization_id,ORG);assert.equal(value.fleet.gross_minor,40000);assert.equal(value.fleet.net_minor,25000);assert.equal(value.fleet.end_balance_minor,99900);
 assert.equal(value.drivers[0].agency_id,undefined);assert.equal(value.coverage.filtered,false);assert.equal(value.source_url,`https://fleethub.uber.com/orgs/${ORG}/earnings`);
});
test('a conflicting organization, disabled fleet or absent configuration never reaches the RPC',async()=>{
 const value=payload();value.organizationId=DRIVER;
 for(const [setup,input,status] of [[{},value,400],[{config:{enabled:false,organization_id:ORG}},payload(),409],[{config:null},payload(),409]]){
  const f=fixture(setup),response=await f.request({method:'POST',url:'/api/provider-earnings/uber',body:{snapshot:input}});
  assert.equal(response.status,status);assert.ok(!f.calls.some(c=>c.table==='provider_earnings_commit'));
 }
});
test('invalid envelopes, malformed JSON and oversized bodies are refused',async()=>{
 for(const options of [{body:{}},{body:{snapshot:payload(),agency_id:999}},{rawBody:'{not-json'},{rawBody:' '.repeat(4*1024*1024+1)}]){
  const f=fixture(),response=await f.request({method:'POST',url:'/api/provider-earnings/uber',...options});
  assert.equal(response.status,options.rawBody?.length>4*1024*1024?413:400);assert.ok(!f.calls.some(c=>c.table==='provider_earnings_commit'));
 }
});
test('RPC, settings and transport failures expose no internal response or credential',async()=>{
 for(const options of [{failTable:'provider_earnings_commit'},{failTable:'uber_report_settings'},{throwRequest:true},{rpcReply:{private_error:'SENSITIVE'}}]){
  const f=fixture(options),response=await f.request({method:'POST',url:'/api/provider-earnings/uber',body:{snapshot:payload()}});
  assert.ok(response.status>=500);assert.doesNotMatch(JSON.stringify(response),/SENSITIVE|test-service-key|private-query|Synthetic Driver/);
 }
});
test('unsupported routes and methods perform no mutation and cloud configuration is refused',async()=>{
 for(const options of [{url:'/api/provider-earnings/unknown'},{url:'/api/provider-earnings/config',method:'POST'},{url:'/api/provider-earnings/uber',method:'DELETE'}]){
  const f=fixture(),response=await f.request(options);assert.equal(response.status,404);assert.ok(f.calls.every(c=>c.method==='GET'));
 }
 assert.throws(()=>createProviderEarningsApi({supabaseUrl:'https://example.supabase.co',anonKey:'anon',serviceKey:'service'}));
});
