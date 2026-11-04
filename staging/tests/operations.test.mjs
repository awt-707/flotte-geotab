import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const code=await fs.readFile(new URL('../site/operations.js',import.meta.url),'utf8');
function context(){const c=vm.createContext({normTxt:v=>String(v).toLowerCase(),LIVE:{motion:{}},S:{session:{user:{id:'test'}}},Number,Date,Map,Set,URLSearchParams});vm.runInContext(code,c);vm.runInContext("OPS.owner='test';OPS.overviewAt=Date.now();",c);return {c,run:s=>vm.runInContext(s,c)};}
test('CSV preserves missing measurements and neutralizes formula injection from plate/model names',()=>{
 const {run,c}=context();c.data={from:'2026-10-30T00:00:00Z',to:'2026-10-30T12:00:00Z',rows:[{plate:'=HYPERLINK("bad")',model:'+SUM(A1)',km:null,fuel_l:0,status:'partial'}]};
 const csv=run('opsReportCsv(data)');assert.ok(csv.startsWith('\ufeff'));assert.match(csv,/'=HYPERLINK\(""bad""\)/);assert.match(csv,/'\+SUM\(A1\)/);assert.match(csv,/;"";"0";/);assert.doesNotMatch(csv,/undefined|null/);
});
test('cockpit scope keeps unassigned and offline profiles unless an explicit global filter excludes them',()=>{
 const {run,c}=context();
 c.rows=[{id:'uber',agency_id:1,vehicle_key:'car',sources:{uber:{status:'on_trip'}}},{id:'bolt',agency_id:2,vehicle_key:null,sources:{bolt:{status:'offline'}}},{id:'unknown',agency_id:null,vehicle_key:null,sources:{bolt:{status:'unknown'}}}];
 c.S.mine=new Set(['car']);
 assert.equal(run("opsCockpitScope(rows,'',false).length"),3);
 assert.deepEqual(Array.from(run("opsCockpitScope(rows,'1',false).map(d=>d.id)")),['uber']);
 assert.deepEqual(Array.from(run("opsCockpitScope(rows,'',true).map(d=>d.id)")),['uber']);
 assert.equal(run("opsCockpitScope(rows,'2',true).length"),0);
 assert.equal(c.rows.length,3,'filtering never removes the retained source profiles');
});
test('showing the whole cockpit fleet clears only presentation filters and keeps the authorized dataset',()=>{
 const {run,c}=context(),storage=new Map([['agence','1'],['mesveh','1'],['theme','light']]);let routes=0;
 c.S.session={user:{id:'same-user'}};c.S.mine=new Set(['car']);
 Object.assign(c,{localStorage:{removeItem:key=>storage.delete(key),setItem:(key,value)=>storage.set(key,value)},route:()=>routes++});
 run('opsClearCockpitScope()');
 assert.equal(storage.has('agence'),false);assert.equal(storage.get('mesveh'),'0');assert.equal(storage.get('theme'),'light');assert.equal(routes,1);
 assert.equal(c.S.session.user.id,'same-user');assert.equal(c.S.mine.has('car'),true);
});
test('blocked browser storage reports an unchanged cockpit scope instead of pretending it was reset',()=>{
 const {run,c}=context();let routes=0,notice;
 Object.assign(c,{localStorage:{removeItem(){throw new Error('blocked');}},route:()=>routes++,msg:text=>text,capture:(id,html)=>{notice={id,html};}});
 run('opsHTML=capture;opsClearCockpitScope()');
 assert.equal(routes,0);assert.equal(notice.id,'fleet-error');assert.match(notice.html,/Impossible de modifier les filtres/);
});
test('map filters combine explicit platform assignment, freshness, query and critical observations',()=>{
 const {run,c}=context();c.rows=[{vehicle_key:'a',plate:'TEST A',driver_name:'Alice',state:'En route',live:true},{vehicle_key:'b',plate:'TEST B',driver_name:'Bob',state:'Garé',live:false}];
 run("OPS.overview={drivers:[{vehicle_key:'a',name:'Alice',sources:{uber:{status:'offline'}}}]}; OPS.mapProvider='uber'; OPS.mapFilter='moving'; OPS.mapQuery='alice';");
 assert.equal(run('opsFilterVehicles(rows).length'),1);run("OPS.mapFilter='critical'");assert.equal(run('opsFilterVehicles(rows).length'),0);run("LIVE.motion.a='alert';");assert.equal(run('opsFilterVehicles(rows).length'),1);run("OPS.mapProvider='';OPS.mapQuery='';OPS.mapFilter='stale'");assert.equal(run('opsFilterVehicles(rows)[0].vehicle_key'),'b');
});
test('ambiguous assignments never attribute a platform driver to a vehicle in the UI',()=>{
 const {run}=context();run("OPS.overview={drivers:[{vehicle_key:'a',name:'One'},{vehicle_key:'a',name:'Two'}]}");assert.equal(run("opsDriverForVehicle('a')"),null);
});
test('manual assignment names and conflicts stop when the snapshot expires or belongs to another session',()=>{
 const {run,c}=context();run("OPS.overview={drivers:[{id:'one',vehicle_key:'car',name:'Old driver',vehicle_link_method:'manual'}]}");assert.equal(run("opsDriverForVehicle('car').name"),'Old driver');
 run('OPS.overviewAt=Date.now()-31000');assert.equal(run("opsDriverForVehicle('car')"),null);assert.equal(run("opsVehicleAssignmentLabel('car')"),'Affectations à actualiser');
 run("OPS.overviewAt=Date.now();OPS.overview.drivers[0].vehicle_conflict=true");c.S.session.user.id='second';assert.equal(run("opsDriverForVehicle('car')"),null);assert.equal(run("opsVehicleAssignmentLabel('car')"),'Lecture des affectations…');
});
test('conflicting live evidence suspends even manual attribution and remains visible for review',()=>{
 const {run}=context();
 run("OPS.overview={drivers:[{id:'one',vehicle_key:'car',vehicle_link_method:'manual',vehicle_conflict:true,ludy_driver_code:'code',name:'One'}]}");
 assert.equal(run("opsDriverForVehicle('car')"),null);
 assert.equal(run('opsDriverNeedsReview(OPS.overview.drivers[0])'),true);
 assert.match(run("opsVehicleAssignmentLabel('car')"),/Conflit d’affectation/);
 for(const status of ['manual','linked'])assert.equal(run(`opsMatchNeedsReview({status:'${status}',vehicle_key:'car',vehicle_conflict:true})`),true);
 run('OPS.overview.drivers[0].vehicle_conflict=false');
 assert.equal(run("opsDriverForVehicle('car').name"),'One');
 assert.equal(run('opsDriverNeedsReview(OPS.overview.drivers[0])'),false);
 assert.equal(run("opsMatchNeedsReview({status:'manual',vehicle_key:'car'})"),false);
});
test('surveillance coverage exposes conflicting vehicles even when every profile has an assignment',()=>{
 const {run,c}=context();
 Object.assign(c,{workspaceIcon:()=>'',inAgency:()=>()=>true,isAdmin:()=>true});
 c.LIVE.motionCoverage={linked_drivers:3,unassigned_drivers:0,conflicting_vehicles:1};
 const html=run('opsMotionCoverage()');assert.match(html,/ops-coverage warn/);assert.match(html,/1<\/b> véhicule avec un conflit d’affectation/);assert.match(html,/#\/rapprochements/);
});
test('roster failure and recovery are visible without replacing Geotab state or painting a departed route',async()=>{
 const {run,c}=context(),writes=[];let paints=0;
 Object.assign(c,{ROUTING:1,fail:true,msg:(text,tone)=>({text,tone}),fleetApi:async()=>{if(c.fail)throw new Error('Synthetic outage');return {drivers:[],sources:[]};}});
 c.S.session={user:{id:'test'}};c.LIVE.localSource={status:'healthy'};c.LIVE.pos={car:{speed:9}};
 c.capture=(id,html)=>writes.push({id,html});c.paint=()=>paints++;
 run('opsHTML=capture;paintOperationsDirect=paint;');
 await run('opsRefreshMapRoster(1)');
 assert.match(writes.at(-1).html.text,/Actualisation des affectations interrompue/);assert.equal(paints,1);
 assert.equal(c.LIVE.localSource.status,'healthy');assert.equal(c.LIVE.pos.car.speed,9);
 c.fail=false;await run('opsRefreshMapRoster(1)');assert.equal(writes.at(-1).html,'');assert.equal(paints,2);
 c.ROUTING=2;await run('opsRefreshMapRoster(1)');assert.equal(paints,2);assert.equal(writes.length,2);
});
test('automatic driver labels require a live unexpired vehicle proof and never use a stored Bolt selection',()=>{
 const {run,c}=context();const now=Date.now();c.expiry=new Date(now+60000).toISOString();c.stamp=new Date(now).toISOString();
 run("OPS.overview={drivers:[{vehicle_key:'car',name:'Current Driver',vehicle_link_method:'platform_plate',vehicle_link_evidence:{source:'bolt',vehicle_origin:'selected',observed_at:stamp,expires_at:expiry}}],sources:[{id:'bolt',status:'healthy',last_success_at:stamp,stale_after_s:90}]}");
 assert.equal(run("opsDriverForVehicle('car')"),null);run("OPS.overview.drivers[0].vehicle_link_evidence.vehicle_origin='bolt_live'");assert.equal(run("opsDriverForVehicle('car').name"),'Current Driver');
 run("OPS.overview.drivers[0].vehicle_link_evidence.expires_at='2000-01-01T00:00:00Z'");assert.equal(run("opsDriverForVehicle('car')"),null);
 run("OPS.overview.drivers[0].vehicle_link_evidence.expires_at=expiry;OPS.overview.sources[0].status='error'");assert.equal(run("opsDriverForVehicle('car')"),null);
});
test('MyClicar driver labels match a current contract proof to the exact vehicle and client',()=>{
 const {run,c}=context();const now=Date.now();c.stamp=new Date(now).toISOString();c.expiry=new Date(now+60000).toISOString();c.future=new Date(now+60000).toISOString();c.excess=new Date(now+3600000).toISOString();
 const setup="OPS.overview={drivers:[{vehicle_key:'car',ludy_driver_code:'client',name:'Current Driver',vehicle_link_method:'myclicar_contract',vehicle_link_evidence:{source:'myclicar',method:'myclicar_contract',vehicle_key:'car',client_code:'client',contract_id:'contract',observed_at:stamp,expires_at:expiry}}],sources:[{id:'myclicar',status:'healthy',last_success_at:stamp,stale_after_s:90}]};";
 run(setup);assert.equal(run("opsDriverForVehicle('car').name"),'Current Driver');
 for(const change of ["vehicle_key='other'","client_code='other'","contract_id=''","method='platform_plate'","source='uber'","observed_at='invalid'","observed_at=future","expires_at='invalid'","expires_at=excess"]){
   run(setup+"OPS.overview.drivers[0].vehicle_link_evidence."+change);assert.equal(run("opsDriverForVehicle('car')"),null,change);
 }
 run(setup+"OPS.overview.sources[0].last_success_at='2000-01-01T00:00:00Z'");assert.equal(run("opsDriverForVehicle('car')"),null);
});
test('resolved or suspended alerts remove their toast and digest while retaining active notifications',()=>{
 const {run,c}=context();let removed=0,cleared=0,digestRemoved=0;
 const box={isConnected:true};c.clearTimeout=()=>cleared++;c.document={getElementById:id=>id==='toasts'?box:id==='ops-alert-digest'?{remove:()=>digestRemoved++}:null};
 c.notice=()=>({node:{remove:()=>removed++},timer:1,collapsed:false});
 run("OPS.notices.set('old',notice());OPS.notices.set('active',notice());opsReconcileNotifications([{id:'active'}])");assert.equal(run('OPS.notices.size'),1);assert.equal(removed,1);assert.equal(cleared,1);assert.equal(digestRemoved,1);
});
test('missing and non-finite report measurements remain unavailable',()=>{
 const {run}=context();for(const x of ['null','undefined','NaN','Infinity'])assert.equal(run('opsNumber('+x+')'),'—');assert.equal(run('opsNumber(0)'),'0');assert.equal(run('opsDuration(null)'),'—');
 assert.equal(run('opsDuration(119.9)'), '2 h 00');
});

test('resolved and suspended movement remains inspectable without triggering active alerts', async()=>{
 const direct=await fs.readFile(new URL('../site/direct.js',import.meta.url),'utf8'),notifications=[];
 const c=vm.createContext({window:{FLOTTE_CONFIG:{GEOTAB_LOCAL:true}},document:{addEventListener(){}},CFG:{GEOTAB_LOCAL:true},S:{session:{user:{id:'test'}},veh:{visible:{}},rules:{},P:{}},MIN:60000,STATE_CLS:{},onNewAlert:a=>notifications.push(a),fmtHMS:v=>v});vm.runInContext(direct,c);
 c.snapshot={motion_alerts:[{id:'resolved',key:'visible',source:'uber',distance_m:241,status:'resolved',at:new Date().toISOString()},{id:'suspended',key:'visible',source:'bolt',distance_m:250,status:'suspended',at:new Date().toISOString()},{id:'outside',key:'hidden',status:'resolved'}]};
 vm.runInContext('processLocalLive(snapshot)',c);assert.equal(vm.runInContext('LIVE.motionHistory.length',c),2);assert.equal(vm.runInContext('LIVE.alerts.length',c),0);assert.equal(notifications.length,0);
 vm.runInContext('processLocalLive(snapshot)',c);assert.equal(notifications.length,0);
});

test('basemap status handles slow tiles, partial failures and cleanup without rapid loading flicker',()=>{
 const {c,run}=context(),timers=new Map();let next=0,writes=0;
 const status={dataset:{},isConnected:true,set textContent(value){this.text=value;writes++;}},layer={handlers:{},on(h){Object.assign(this.handlers,h);},off(h){for(const k of Object.keys(h))delete this.handlers[k];}};
 Object.assign(c,{status,layer,setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
 run('opsObserveMapTiles(layer,status)');assert.equal(status.dataset.state,'loading');
 layer.handlers.load();assert.equal(status.dataset.state,'ready');const readyWrites=writes;
 layer.handlers.loading();assert.equal(status.dataset.state,'ready','brief pan does not flicker');layer.handlers.load();assert.equal(writes,readyWrites);assert.equal(timers.size,0);
 const tile={};layer.handlers.tileerror({tile});assert.equal(status.dataset.state,'error');layer.handlers.load();assert.equal(status.dataset.state,'error','completion must not hide missing tiles');
 layer.handlers.tileload({tile});assert.equal(status.dataset.state,'ready');
 layer.handlers.loading();for(const fn of timers.values())fn();assert.equal(status.dataset.state,'loading');
 layer.handlers.remove();assert.equal(timers.size,0);assert.deepEqual(layer.handlers,{});
});
