import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {MyclicarClient} from '../server/myclicar.mjs';import {createMyclicarService} from '../server/myclicar-service.mjs';import {normalizeMyClicarContracts} from '../server/myclicar-contracts.mjs';
const NOW=Date.parse('2026-11-02T12:00:00Z'),stamp=new Date(NOW).toISOString();
const credentials={email:'synthetic@example.invalid',password:'synthetic-password',httpUsername:'synthetic',httpPassword:'synthetic-http'};
const listing=(rows,total=rows.length,page=1)=>Response.json({data:rows,meta:{total,page,itemsPerPage:10,pageCount:Math.ceil(total/10)}});
const vehicle=(id,archived=false)=>({id:'car-'+id,reference:'REF-'+id,registration:'TEST-'+id,temporaryRegistration:'TEMP-'+id,serialNumber:'VIN-'+id,fuelType:'DIESEL',category:{brand:'Synthetic',model:'Test'},status:'AVAILABLE',isBlocked:false,updatedAt:'2026-11-01T00:00:00Z',deletedAt:archived?'2026-11-01T00:00:00Z':null,purchasePrice:999999,currentDriver:{firstname:'Do not retain',lastname:'Private'}});
const agency={id:'agency-1',code:'AGENCY',title:'Synthetic agency',updatedAt:'2026-11-01T00:00:00Z',deletedAt:null,phone:'PRIVATE',street:'PRIVATE'};
const contract=(id,returned=false)=>({id:'contract-'+id,reference:'CON-'+id,status:returned?'DONE':'IN_PROGRESS',departureDate:'2026-11-01T06:00:00Z',departureConditionDate:'01/11/2026 à 07h00',checkoutDate:returned?'01/11/2026 à 19h00':'',actualReturnDate:returned?'2026-11-01T19:00:00Z':null,vehicleRegistration:'TEST-'+id,clientReference:'driver-'+id,contactName:'Synthetic Driver '+id,updatedAt:'2026-11-02T10:00:00Z',deletedAt:null});
const detail=(row,extra={})=>({...row,isBooking:false,archivedAt:null,canceledAt:null,client:{reference:row.clientReference,phone:'PRIVATE'},vehicleId:'car-'+row.id.split('-').at(-1),departureAgencyId:'agency-1',returnAgencyId:null,departureConditionDate:'2026-11-01T07:00:34.123Z',contactEmail:'PRIVATE',...extra});
function fixture(read){const calls=[];const client=new MyclicarClient({credentials,now:()=>NOW,fetchFn:async(url,options)=>{const u=new URL(url);calls.push({url:u,method:options.method});assert.ok(['https://new.clicar.ma','https://new-api.clicar.ma'].includes(u.origin));if(u.origin==='https://new.clicar.ma')return new Response('portal');if(u.pathname==='/auth/login')return Response.json({accessToken:'SYNTHETIC'},{status:201});assert.equal(options.method,'GET');return read(u);}});return {client,calls};}

test('complete inventory includes unused cars, keeps archives separate and retains no financial or contact fields',async()=>{
 const f=fixture(u=>{if(u.pathname==='/agency')return listing([agency]);assert.equal(u.pathname,'/vehicle');assert.deepEqual([...u.searchParams.keys()],['page','itemsPerPage','isArchived']);const page=Number(u.searchParams.get('page'));return u.searchParams.get('isArchived')==='true'?listing([vehicle('old',true)]):listing(page===1?Array.from({length:10},(_,i)=>vehicle(i)):[vehicle(10)],11,page);});
 const [a,b]=await Promise.all([f.client.inventorySnapshot(),f.client.inventorySnapshot()]);assert.deepEqual(a,b);assert.equal(a.complete,true);assert.deepEqual(a.coverage,{vehicles:12,current_vehicles:11,archived_vehicles:1,agencies:1});assert.equal(f.calls.length,6);assert.equal(a.vehicles[0].status,'AVAILABLE');assert.doesNotMatch(JSON.stringify(a),/PRIVATE|Do not retain|purchasePrice|999999|password|SYNTHETIC/);
});
test('catalog totals, duplicate records and ignored archive filters reject the whole snapshot',async()=>{
 for(const invalid of [()=>listing([vehicle(1)],2),()=>listing([vehicle(1),vehicle(1)]),()=>listing([vehicle(1,true)]),()=>listing([{...vehicle(1),status:'UNKNOWN'}])]){
  const f=fixture(u=>u.pathname==='/agency'?listing([agency]):invalid());await assert.rejects(f.client.inventorySnapshot(),e=>e.status===502);
 }
});
test('inventory reset discards late replies and preserves provider quota backoff',async()=>{
 let release,entered;const started=new Promise(r=>entered=r),f=fixture(async()=>{entered();return new Promise(r=>release=()=>r(listing([agency])));});
 const pending=f.client.inventorySnapshot();await started;f.client.reset();release();await assert.rejects(pending,/remplacée/);
 const quota=fixture(()=>Response.json({}, {status:429,headers:{'retry-after':'120'}}));await assert.rejects(quota.client.inventorySnapshot(),e=>e.status===429);const count=quota.calls.length;quota.client.reset();await assert.rejects(quota.client.inventorySnapshot(),e=>e.status===429);assert.equal(quota.calls.length,count);
});
test('verified detail identifiers and ISO departures override ambiguous list display, with bounded cache reuse',async()=>{
 const row=contract(1);let details=0;const f=fixture(u=>{if(u.pathname==='/contract')return listing([row]);assert.equal(u.pathname,'/contract/contract-1');details++;return Response.json(detail(row));});
 const first=await f.client.snapshot({details:true}),projection=normalizeMyClicarContracts(first.contracts,{observedAt:first.at,now:NOW});
 assert.equal(projection.contracts[0].effective_start_at,'2026-11-01T07:00:34.123Z');assert.equal(projection.contracts[0].vehicle_external_id,'car-1');assert.equal(projection.contracts[0].departure_agency_external_id,'agency-1');assert.equal(projection.contracts[0].details_verified,true);assert.doesNotMatch(JSON.stringify(first),/PRIVATE/);
 await f.client.snapshot({details:true});assert.equal(details,1);row.updatedAt='2026-11-02T11:00:00Z';await f.client.snapshot({details:true});assert.equal(details,2);
});
test('wrong detail identity, driver, status, vehicle or archived state never enriches a contract',async()=>{
 for(const change of [{id:'wrong'},{client:{reference:'other'}},{vehicleRegistration:'OTHER'},{status:'DONE'},{archivedAt:stamp},{isBooking:true}]){
  const row=contract(1),f=fixture(u=>u.pathname==='/contract'?listing([row]):Response.json(detail(row,change)));await assert.rejects(f.client.snapshot({details:true}),/contradictoires/);
 }
});
test('returned history can retain precise detail timestamps and keeps the authoritative return ISO',async()=>{
 const row=contract(1,true),f=fixture(u=>u.pathname==='/contract'?listing([row]):Response.json(detail(row)));
 const snapshot=await f.client.historySnapshot({from:'2026-10-26T12:00:00Z',to:stamp,details:true}),p=normalizeMyClicarContracts(snapshot.contracts,{observedAt:snapshot.at,now:NOW});
 assert.equal(p.contracts[0].effective_start_at,'2026-11-01T07:00:34.123Z');assert.equal(p.contracts[0].end_at,'2026-11-01T19:00:00.000Z');
});
test('inventory refresh precedes contracts, is limited to five minutes and fails independently',async t=>{
 const directory=await fs.mkdtemp(new URL('../.local/inventory-service-',import.meta.url).pathname),credentialsPath=directory+'/myclicar.json';await fs.writeFile(credentialsPath,JSON.stringify(credentials),{mode:0o600});let now=NOW,inventoryCalls=0,fail=false;const writes=[],source={status:'paused'};
 class Client{reset(){}async inventorySnapshot(){inventoryCalls++;if(fail)throw Error('PRIVATE');return {at:new Date(now).toISOString(),complete:true,vehicles:[],agencies:[]};}async snapshot(options){assert.equal(options.details,true);return {at:new Date(now).toISOString(),complete:true,contracts:[]};}}
 const service=createMyclicarService({credentialsPath,Client,now:()=>now,db:async(table,o)=>{if(table==='fleet_sources')return[source];writes.push(table);return table==='rpc/fleet_sync_myclicar'?{contracts:0,active_contracts:0,matched_assignments:0,unmatched_contracts:0}:{};},patch:async(table,where,data)=>{writes.push(table);assert.doesNotMatch(JSON.stringify(data),/PRIVATE/);},health:async(id,status)=>source.status=status,setTimer:()=>({unref(){}}),clearTimer(){}});
 t.after(async()=>{service.close();await fs.rm(directory,{recursive:true,force:true});});await service.start();assert.equal(inventoryCalls,1);assert.ok(writes.indexOf('rpc/fleet_sync_inventory')<writes.indexOf('rpc/fleet_sync_myclicar'));
 now+=60000;await service.refresh();assert.equal(inventoryCalls,1);now+=300000;fail=true;await service.refresh();assert.equal(inventoryCalls,2);assert.equal(source.status,'healthy');assert.ok(writes.includes('fleet_inventory_sync'));
});
test('a local association failure preserves the committed inventory and does not become a provider error',async t=>{
 const directory=await fs.mkdtemp(new URL('../.local/inventory-service-',import.meta.url).pathname),credentialsPath=directory+'/myclicar.json';await fs.writeFile(credentialsPath,JSON.stringify(credentials),{mode:0o600});const writes=[];
 class Client{reset(){}async inventorySnapshot(){return {at:stamp,complete:true,vehicles:[],agencies:[]};}}
 const service=createMyclicarService({credentialsPath,Client,now:()=>NOW,db:async(table)=>{writes.push(table);return {vehicles:19};},patch:async(table)=>writes.push(table),health:async()=>{},afterInventorySync:async()=>{throw Error('PRIVATE');}});
 t.after(async()=>{service.close();await fs.rm(directory,{recursive:true,force:true});});
 const result=await service.refreshInventory();assert.deepEqual(result,{ok:true,coverage:{vehicles:19},associations:{ok:false,reason:'association_unavailable'}});assert.deepEqual(writes,['rpc/fleet_sync_inventory']);
});
