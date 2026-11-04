import test from 'node:test';
import assert from 'node:assert/strict';
import {GeotabClient,GeotabError} from '../server/geotab.mjs';
const NOW=Date.parse('2026-11-02T10:00:00Z');
const zone=(id='z1',extra={})=>({id,name:'Synthetic Casablanca parking',points:[{x:-7.6,y:33.5},{x:-7.599,y:33.5},{x:-7.599,y:33.501},{x:-7.6,y:33.5}],zoneTypes:['ZoneTypeOfficeId',{id:'b1'}],activeFrom:'2020-01-01T00:00:00.000Z',activeTo:'9999-12-31T23:59:59.000Z',privateField:'not-to-return',...extra});
const reply=(result,status=200,headers={})=>new Response(JSON.stringify({result}),{status,headers});
function fixture(){
 const state={now:NOW,zones:[zone()],types:[{id:'ZoneTypeOfficeId',name:'Office',privateField:'not-to-return'},{id:'b1',name:'Customer'}],calls:[],failure:null,auth:0};
 const client=new GeotabClient({credentials:async()=>({database:'synthetic',userName:'test@example.invalid',password:'synthetic-private'}),now:()=>state.now,fetchFn:async(url,options)=>{
  assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(new URL(url).pathname,'/apiv1');const body=JSON.parse(options.body);state.calls.push(body);
  assert.ok(['Authenticate','Get'].includes(body.method),'zones must never mutate the provider or execute arbitrary methods');
  if(body.method==='Authenticate'){state.auth++;assert.equal(url,'https://my.geotab.com/apiv1');return reply({path:'my42.geotab.com',credentials:{sessionId:'synthetic-session'}});}
  assert.equal(url,'https://my42.geotab.com/apiv1');assert.ok(['Zone','ZoneType'].includes(body.params.typeName));assert.equal(body.params.resultsLimit,1000);assert.equal(body.params.credentials.password,undefined);assert.equal(body.params.credentials.sessionId,'synthetic-session');
  if(state.failure){const value=state.failure;state.failure=null;return value;}
  return reply(body.params.typeName==='Zone'?state.zones:state.types);
 }});
 return {client,state,reads:type=>state.calls.filter(c=>c.method==='Get'&&c.params.typeName===type)};
}
test('zone catalogue maps y to latitude and x to longitude, retaining valid closures and both type representations',async()=>{
 const f=fixture();const before=JSON.stringify(f.state.zones);f.state.zones.push(zone('z2',{name:'Synthetic France area',points:[{x:2.3,y:48.8},{x:2.4,y:48.8},{x:2.4,y:48.9}],zoneTypes:undefined,activeFrom:null,activeTo:null}));
 const rows=await f.client.zones(),types=await f.client.zoneTypes();assert.equal(rows.length,2,'catalogue does not auto-select a country, agency or parking');assert.deepEqual(rows[0].points[0],{lat:33.5,lon:-7.6});assert.deepEqual(rows[0].points.at(-1),rows[0].points[0]);assert.deepEqual(rows[0].zone_types,['ZoneTypeOfficeId','b1']);assert.equal(rows[0].active_to,'9999-12-31T23:59:59.000Z');assert.deepEqual(rows[1].zone_types,[]);
 assert.deepEqual(types,[{id:'ZoneTypeOfficeId',name:'Office'},{id:'b1',name:'Customer'}]);assert.doesNotMatch(JSON.stringify({rows,types}),/private|synthetic-session/);assert.equal(JSON.stringify(f.state.zones.slice(0,1)),before,'normalization does not alter provider objects');assert.equal(f.state.auth,1);assert.deepEqual(f.reads('Zone')[0].params.search,{fromDate:new Date(NOW).toISOString()});assert.deepEqual(f.reads('ZoneType')[0].params.search,{});
});
test('a full zone or type page is refused instead of being presented as a complete catalogue',async()=>{
 for(const [method,key,maker]of [['zones','zones',i=>zone('z'+i)],['zoneTypes','types',i=>({id:'t'+i,name:'Type '+i})]]){
  for(const count of [1000,1001]){const f=fixture();f.state[key]=Array.from({length:count},(_,i)=>maker(i));await assert.rejects(f.client[method](),e=>e instanceof GeotabError&&e.status===502&&/incomplet refusé/.test(e.message));assert.equal(f.state.calls.length,2,'no unbounded pagination or provider mutation is attempted');}
  const f=fixture();f.state[key]=Array.from({length:999},(_,i)=>maker(i));assert.equal((await f.client[method]()).length,999);
 }
});
test('invalid zone rows, polygons, types or identities reject the whole catalogue without raw provider details',async()=>{
 const invalid=[null,7,[],zone('bad id'),zone('z1',{name:''}),zone('z1',{name:'x'.repeat(161)}),zone('z1',{points:null}),zone('z1',{points:[]}),zone('z1',{points:[null,{x:0,y:1},{x:1,y:0}]}),zone('z1',{points:[{x:'-7.6',y:33},{x:0,y:1},{x:1,y:0}]}),zone('z1',{points:[{x:-7,y:91},{x:0,y:1},{x:1,y:0}]}),zone('z1',{points:[{x:181,y:33},{x:0,y:1},{x:1,y:0}]}),zone('z1',{points:[{x:1,y:1},{x:2,y:2},{x:1,y:1}]}),zone('z1',{points:Array(20001).fill({x:0,y:0})}),zone('z1',{zoneTypes:null}),zone('z1',{zoneTypes:[null]}),zone('z1',{zoneTypes:[{id:'bad id'}]}),zone('z1',{zoneTypes:Array(1001).fill('b1')}),zone('z1',{activeFrom:'synthetic-provider-private'})];
 for(const row of invalid){const f=fixture();f.state.zones=[zone('valid'),row];await assert.rejects(f.client.zones(),e=>e instanceof GeotabError&&e.status===502&&!e.message.includes('synthetic-provider-private')&&/aucune liste partielle/.test(e.message));}
 const duplicate=fixture();duplicate.state.zones=[zone(),zone()];await assert.rejects(duplicate.client.zones(),GeotabError);
});
test('zone type rows are strict and duplicate or malformed values cannot silently disappear',async()=>{
 for(const bad of [null,2,[],{id:'bad id',name:'Type'},{id:'ok',name:null},{id:'ok',name:''},{id:'ok',name:'a\nb'},{id:'ok',name:'x'.repeat(161)}]){const f=fixture();f.state.types=[{id:'valid',name:'Valid'},bad];await assert.rejects(f.client.zoneTypes(),e=>e instanceof GeotabError&&/aucune liste partielle/.test(e.message));}
 const duplicate=fixture();duplicate.state.types=[{id:'same',name:'One'},{id:'same',name:'Two'}];await assert.rejects(duplicate.client.zoneTypes(),GeotabError);
 for(const method of ['zones','zoneTypes']){const f=fixture();f.state[method==='zones'?'zones':'types']={unexpected:'object'};await assert.rejects(f.client[method](),/Liste Geotab invalide/);}
});
test('the real API may serialize built-in zone types as ID strings mixed with named custom types',async()=>{
 const f=fixture();const ids=['ZoneTypeHomeId','ZoneTypeOfficeId','ZoneTypeCustomerId','ZoneTypeInHouseServiceCenterId','ZoneTypeVendorServiceCenterId'];
 f.state.types=[...ids,{id:'b1',name:'Custom type'}];assert.deepEqual(await f.client.zoneTypes(),[...ids.map(id=>({id,name:id})),{id:'b1',name:'Custom type'}]);
 f.state.types=['ZoneTypeHomeId',{id:'ZoneTypeHomeId',name:'Duplicate'}];await assert.rejects(f.client.zoneTypes(),GeotabError);
 f.state.types=['unknown'];await assert.rejects(f.client.zoneTypes(),GeotabError);
});
test('Zone and ZoneType have independent rolling budgets and stop before making an excess read',async()=>{
 const f=fixture();f.state.zones=[];f.state.types=[];for(let i=0;i<500;i++)await f.client.zones();assert.equal(f.reads('Zone').length,500);
 await assert.rejects(f.client.zones(),e=>e.kind==='quota'&&e.status===429&&e.retryAfter===60);assert.equal(f.reads('Zone').length,500);
 for(let i=0;i<100;i++)await f.client.zoneTypes();assert.equal(f.reads('ZoneType').length,100);await assert.rejects(f.client.zoneTypes(),e=>e.kind==='quota'&&e.retryAfter===60);assert.equal(f.reads('ZoneType').length,100);
 f.state.now+=59999;await assert.rejects(f.client.zoneTypes(),e=>e.retryAfter===1);f.state.now++;await f.client.zoneTypes();await f.client.zones();assert.equal(f.reads('ZoneType').length,101);assert.equal(f.reads('Zone').length,501);
});
test('reset and backwards clocks cannot replenish a zone allowance, including authentication retries',async()=>{
 const f=fixture();f.state.types=[];for(let i=0;i<99;i++)await f.client.zoneTypes();f.state.failure=new Response(JSON.stringify({error:{data:{type:'InvalidUserException'}}}));
 await assert.rejects(f.client.zoneTypes(),e=>e.kind==='quota');assert.equal(f.reads('ZoneType').length,100);assert.equal(f.state.auth,2,'the failed authenticated read consumes its allowance');
 f.client.reset();f.state.now=NOW-60000;await assert.rejects(f.client.zoneTypes(),e=>e.kind==='quota'&&e.retryAfter===60);assert.equal(f.reads('ZoneType').length,100);
});
test('provider quota and permission errors are propagated safely without automatic retries or mutation',async()=>{
 for(const method of ['zones','zoneTypes']){
  const f=fixture();f.state.failure=reply(null,429,{'retry-after':'9000'});await assert.rejects(f.client[method](),e=>e.kind==='quota'&&e.retryAfter===9000);assert.equal(f.state.calls.length,2);
  f.state.now+=3600000;await assert.rejects(f.client[method](),e=>e.kind==='quota'&&e.retryAfter===5400);assert.equal(f.state.calls.length,2,'no catalogue read before the complete provider deadline');
  f.state.now+=5399999;await assert.rejects(f.client[method](),e=>e.kind==='quota'&&e.retryAfter===1);assert.equal(f.state.calls.length,2);f.state.now++;
  f.state.failure=new Response(JSON.stringify({error:{data:{type:'AccessDeniedException'},message:'synthetic-provider-private'}}),{status:403});await assert.rejects(f.client[method](),e=>e.kind==='permission'&&!JSON.stringify(e).includes('synthetic-provider-private'));assert.equal(f.state.calls.length,3);
 }
});
