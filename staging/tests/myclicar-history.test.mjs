import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {MyclicarClient} from '../server/myclicar.mjs';import {createMyclicarService} from '../server/myclicar-service.mjs';
const NOW=Date.parse('2026-11-02T12:00:00Z'),window={from:'2026-10-26T12:00:00Z',to:'2026-11-02T12:00:00Z'};
const creds={email:'synthetic@example.invalid',password:'synthetic',httpUsername:'synthetic',httpPassword:'synthetic'};
const contract=n=>({id:'id'+n,reference:'ref'+n,status:'VEHICLE_RETURNED',departureDate:'2026-11-01T06:00:00Z',departureConditionDate:'01/11/2026 à 07h00',actualReturnDate:'2026-11-01T18:00:00Z',checkoutDate:'01/11/2026 à 19h00',vehicleRegistration:'TEST-'+n,clientReference:'driver'+n,deletedAt:null});
function fixture(hook){const calls=[];const client=new MyclicarClient({credentials:creds,now:()=>NOW,fetchFn:async(url,options)=>{calls.push({url,options});const u=new URL(url);if(u.origin==='https://new.clicar.ma')return new Response('portal');if(u.pathname==='/auth/login')return Response.json({accessToken:'SYNTHETIC'},{status:201});assert.equal(options.method,'GET');assert.equal(u.origin,'https://new-api.clicar.ma');return hook(u);}});return {client,calls};}
const listing=(data,total=data.length,page=1)=>Response.json({data,meta:{total,page,itemsPerPage:10,pageCount:Math.ceil(total/10)}});
test('returned-contract reads use observed statuses, ISO window and complete pagination without arbitrary routes',async()=>{
 const f=fixture(u=>{assert.equal(u.pathname,'/contract');assert.deepEqual(u.searchParams.getAll('status[]'),['DONE','VEHICLE_RETURNED']);assert.equal(u.searchParams.get('from'),window.from.replace('Z','.000Z'));assert.equal(u.searchParams.get('to'),window.to.replace('Z','.000Z'));assert.equal(u.searchParams.get('isArchived'),'false');const page=Number(u.searchParams.get('page'));return listing(page===1?Array.from({length:10},(_,i)=>contract(i)):[contract(10)],11,page);});
 const snapshot=await f.client.historySnapshot(window);assert.equal(snapshot.complete,true);assert.equal(snapshot.contracts.length,11);assert.equal(snapshot.contracts[0].actualReturnDate,'2026-11-01T18:00:00.000Z');assert.equal(f.calls.length,4);assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC'));
});
test('returned-history invalid windows are rejected before any network access',async()=>{
 const f=fixture(()=>assert.fail('No provider request'));for(const w of [{},{from:'invalid',to:window.to},{from:'2026-01-01T00:00:00Z',to:window.to},{from:window.to,to:window.from},{...window,to:'2026-12-01T00:00:00Z'}])await assert.rejects(f.client.historySnapshot(w),e=>e.status===400);assert.equal(f.calls.length,0);
});
test('returned-history refuses ignored filters, incomplete pagination and duplicate identities',async()=>{
 for(const make of [()=>listing([{...contract(1),status:'IN_PROGRESS'}]),()=>listing([contract(1)],12),()=>listing([contract(1),contract(1)])]){const f=fixture(make);await assert.rejects(f.client.historySnapshot(window),e=>e.status===502);}
 const changed=fixture(u=>Number(u.searchParams.get('page'))===1?listing(Array.from({length:10},(_,i)=>contract(i)),11):listing([contract(10),contract(11)],12,2));await assert.rejects(changed.client.historySnapshot(window),/incomplet/);
});
test('history resets discard late replies and quota responses prevent immediate extra reads',async()=>{
 let release,entered;const started=new Promise(r=>entered=r),f=fixture(async()=>{entered();return new Promise(r=>release=()=>r(listing([contract(1)])));});
 const pending=f.client.historySnapshot(window);await started;f.client.reset();release();await assert.rejects(pending,/remplacée/);
 const quota=fixture(()=>Response.json({}, {status:429,headers:{'retry-after':'180'}}));await assert.rejects(quota.client.historySnapshot(window),e=>e.status===429);const count=quota.calls.length;await assert.rejects(quota.client.historySnapshot(window),e=>e.status===429);assert.equal(quota.calls.length,count);
});
test('return history is independent, runs every five minutes, and failure preserves active source health',async t=>{
 const root=new URL('../.local/',import.meta.url);await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(new URL('rotation-service-',root).pathname),credentialsPath=dir+'/myclicar.json';await fs.writeFile(credentialsPath,JSON.stringify(creds),{mode:0o600});
 let now=NOW,historyCalls=0,historyFail=false;const mutations=[],source={status:'healthy',coverage:{}};
 class Client{reset(){}async snapshot(){return {at:new Date(now).toISOString(),complete:true,contracts:[]};}async historySnapshot(range){historyCalls++;assert.equal(Date.parse(range.to)-Date.parse(range.from),7*86400000);if(historyFail)throw Error('private upstream failure');return {at:new Date(now).toISOString(),complete:true,contracts:[contract(1)]};}}
 const service=createMyclicarService({credentialsPath,Client,now:()=>now,db:async(table,options)=>{if(table==='fleet_sources')return [source];mutations.push({table,body:options.body});return table==='rpc/fleet_sync_myclicar'?{contracts:0,active_contracts:0,matched_assignments:0,unmatched_contracts:0}:{contracts:1};},patch:async(table,where,value)=>{mutations.push({table,value});},health:async(id,status)=>{source.status=status;},setTimer:()=>({unref(){}}),clearTimer(){}});
 t.after(async()=>{service.close();await fs.rm(dir,{recursive:true,force:true});});
 await service.start();await service.refreshHistory();assert.equal(historyCalls,1);assert.ok(mutations.some(m=>m.table==='rpc/fleet_sync_rotation_contracts'));
 now+=60000;await service.refresh();await service.refreshHistory();assert.equal(historyCalls,1);
 historyFail=true;now+=300000;await service.refresh();await service.refreshHistory();assert.equal(historyCalls,2);assert.equal(source.status,'healthy');assert.ok(mutations.some(m=>m.table==='fleet_rotation_sync'&&m.value.status==='error'));assert.ok(!JSON.stringify(mutations).includes('private upstream failure'));
});
