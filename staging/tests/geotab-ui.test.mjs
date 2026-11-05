import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const code = await fs.readFile(new URL('../site/direct.js', import.meta.url), 'utf8');
function ui() {
  const notifications = [], now = Date.now();
  const context = vm.createContext({
    window: { FLOTTE_CONFIG: { GEOTAB_LOCAL: true } }, document: { addEventListener() {} },
    CFG: { GEOTAB_LOCAL: true }, S: { session: { user: { id: 'local-user' } },
      veh: { car: { ref_l100: 6 } }, P: {}, rules: { brake: { name: 'Freinage brusque', category: 'Freinage', weight: 0 } } },
    MIN: 60000, HOUR: 3600000, STATE_CLS: {}, NM: 'non mesuré',
    num: (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback,
    f1: n => Number(n).toFixed(1), esc: text => String(text ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    parts: value => { const d = new Date(value); return { day: '30', month: '10', hour: String(d.getHours()).padStart(2, '0'), minute: '00', second: '00' }; },
    ctrEffEnds: rows => rows, onNewAlert: alert => notifications.push(alert),
    Date, Number, Object, Set, Map, Math
  });
  vm.runInContext(code, context);
  const run = source => vm.runInContext(source, context);
  run(`LIVE.localSource = { polling: true, telemetry_status: 'healthy' }; LIVE.drv = { car: { from: new Date(${now - 3600000}).toISOString(), at: new Date(${now}).toISOString(), fresh: true, km: 100, fuel_l: 5.8 } };`);
  return { run, notifications, context, now };
}

test('local consumption uses real counters without a current contract, and names the configured comparison', () => {
  const { run } = ui();
  const gauge = run(`consoGauge({ vehicle_key: 'car', model: 'test' })`);
  assert.match(gauge, /5\.8<small> L\/100/);
  assert.match(gauge, /Référence configurée du véhicule : 6\.0/);
  assert.match(gauge, /heure du Maroc/);
  run('S.veh.car.ref_l100 = null');
  const noComparison = run(`consoGauge({ vehicle_key: 'car', model: 'test' })`);
  assert.match(noComparison, /5\.8<small> L\/100/);
  assert.match(noComparison, /Aucune référence de comparaison/);
  assert.match(noComparison, /z-mute/);
});

test('missing and stale counters cannot be presented as current measured consumption', () => {
  const { run } = ui();
  run('LIVE.drv.car.fuel_l = null');
  assert.match(run(`consoGauge({ vehicle_key: 'car' })`), /non mesuré/);
  run('LIVE.drv.car.fuel_l = 5.8; LIVE.drv.car.fresh = false');
  assert.match(run(`consoGauge({ vehicle_key: 'car' })`), /Ancienne/);
  assert.doesNotMatch(run(`consoGauge({ vehicle_key: 'car' })`), /5\.8<small> L\/100/);
});
test('local vehicle details preserve measured ignition and never turn imported contracts into current driver evidence', () => {
  const {run,context,now}=ui();
  Object.assign(context,{inAgency:()=>()=>true,shiftAt:()=>({s:'Jour',day:'test'}),shiftStart:()=>new Date(now-3600000),shiftAdv:()=>2,
    shiftOfCtr:()=>({s:'Jour',day:'test'}),shiftOf:()=> 'Jour',SHIFTS:['Jour'],HORS:'HORS',opsDriverForVehicle:()=>({name:'Current Driver',ludy_driver_code:'current'}),
    plate:v=>String(v),f0:v=>String(v),fH:v=>String(v)});
  run(`contractAt=()=>({name:'Imported Driver',num:'old-contract',client_code:'old',start_at:new Date(${now-3600000}).toISOString(),end_at:new Date(${now+3600000}).toISOString()});
    LIVE.localSource={polling:true,status:'healthy',last_success_at:new Date(${now}).toISOString(),stale_after_s:20};
    LIVE.pos={car:{key:'car',plate:'TEST',at:new Date(${now}).toISOString(),state:'En route',speed:9,lat:33,lon:-7,ign_on:true,fresh:true}};`);
  const row=run('liveRows()[0]');assert.equal(row.ign_on,true);assert.equal(row.driver_name,'Current Driver');assert.equal(row.contract_num,'');assert.equal(row.reference_contract.name,'Imported Driver');
  const popup=run('popupHtml(liveRows()[0])');assert.match(popup,/Current Driver/);assert.doesNotMatch(popup,/Imported Driver|old-contract/);assert.match(popup,/Geotab :.*En mouvement/);
  run('LIVE.pos.car.ign_on=false');assert.equal(run('liveRows()[0].ign_on'),false);
  run('LIVE.pos.car.fresh=false');assert.equal(run('liveRows()[0].ign_on'),null);
  run(`LIVE.pos.car.fresh=true;LIVE.pos.car.at=new Date(${now}+60000).toISOString()`);assert.equal(run('liveRows()[0].live'),0,'future GPS does not become current movement');
  run(`LIVE.pos.car.at=new Date(${now}).toISOString();LIVE.localSource.last_success_at=new Date(${now}+60000).toISOString()`);assert.equal(run('liveRows()[0].live'),0,'future source timestamps cannot keep a live badge');
  context.opsDriverForVehicle=()=>null;assert.equal(run('liveRows()[0].driver_name'),'Affectation plateforme à confirmer');
});

test('local driving alerts use Geotab events, not cached speed, with deduplicated notifications', () => {
  const { run, context, notifications, now } = ui();
  context.snapshot = { at: new Date(now).toISOString(), events: [], vehicles: [{ key: 'car', state: 'En route', speed: 180 }] };
  run('processLocalLive(snapshot)');
  assert.equal(run('LIVE.alerts.length'), 0);
  context.snapshot.events = [{ id: 'event-a', key: 'car', rule: 'brake', at: new Date(now).toISOString(), dur_min: 1 / 60 }];
  run('processLocalLive(snapshot)');
  assert.equal(run('LIVE.alerts[0].type'), 'Freinage brusque');
  assert.equal(notifications.length, 1);
  run('processLocalLive(snapshot)');
  assert.equal(notifications.length, 1);
  assert.equal(run('Object.keys(LIVE.fast).length'), 0);
});

test('critical offline movement remains visible beyond the driving-events window and resolves with the server', () => {
  const { run, context, notifications, now } = ui();
  run('processLocalLive({})');
  context.snapshot = { motion_alerts: [{ id: 'offline-episode', key: 'car', source: 'uber', evidence: {platforms_offline:['uber','bolt']}, distance_m: 245, status: 'open', at: new Date(now - 3600000).toISOString(), ign_on: true }] };
  run('processLocalLive(snapshot)');
  assert.equal(run('LIVE.alerts[0].severity'), 'Critique');
  assert.match(run('LIVE.alerts[0].detail'), /245 m/);
  assert.match(run('LIVE.alerts[0].detail'), /Uber Fleet et Bolt hors ligne/);
  assert.doesNotMatch(run('LIVE.alerts[0].detail'), /course/);
  assert.equal(run('LIVE.motion.car'), 'MOTION|offline-episode');
  assert.equal(notifications.length, 1);
  context.snapshot.motion_alerts[0].status = 'resolved';
  run('processLocalLive(snapshot)');
  assert.equal(run('LIVE.alerts.length'), 0);
  assert.equal(run('Object.keys(LIVE.motion).length'), 0);
});
test('corrected legacy vehicle associations remain in history as discarded signals, never as validated offline movement', async () => {
  const {run,context,now,notifications}=ui();
  const dialog={innerHTML:'',open:false,querySelector:()=>({}),showModal(){this.open=true;}};
  Object.assign(context,{$:selector=>selector==='#adlg'?dialog:null,plate:v=>String(v),badge:(text,tone)=>'<span class="'+tone+'">'+text+'</span>',workspaceIcon:v=>v,GRAV_CLS:{Critique:'crit'}});
  vm.runInContext(await fs.readFile(new URL('../site/operations.js',import.meta.url),'utf8'),context);
  context.document.getElementById=()=>null;
  context.snapshot={motion_alerts:[{id:'discarded',key:'car',source:'bolt',distance_m:1136,status:'resolved',at:new Date(now).toISOString(),evidence:{correction_reason:'unverified_bolt_selected_vehicle',corrected_at:new Date(now).toISOString()}}]};
  run('processLocalLive(snapshot)');assert.equal(run('LIVE.alerts.length'),0);assert.equal(notifications.length,0);assert.equal(run('LIVE.motionHistory.length'),1);
  const card=run('opsAlertCards(LIVE.motionHistory)');assert.match(card,/Écarté : affectation non vérifiée/);assert.match(card,/Signalement écarté/);assert.doesNotMatch(card,/Épisode terminé|Critique/);
  await run('openAlertDetail(LIVE.motionHistory[0])');assert.match(dialog.innerHTML,/Écarté : affectation non vérifiée/);assert.match(dialog.innerHTML,/aucun déplacement hors ligne n’est établi/);assert.doesNotMatch(dialog.innerHTML,/Épisode terminé|Critique/);
  assert.equal(context.snapshot.motion_alerts[0].distance_m,1136,'original audit evidence is untouched');
});

test('live interval supports two seconds and ignores events outside the visible vehicle cache', () => {
  const { run, context, now } = ui();
  assert.equal(run('localGeotabInterval({ interval_s: 2 })'), 2);
  context.snapshot = { events: [{ id: 'other', key: 'hidden', rule: 'brake', at: new Date(now).toISOString() }] };
  run('processLocalLive(snapshot)');
  assert.equal(run('LIVE.alerts.length'), 0);
});

test('ongoing driving events survive their start time and engine reminders only expose visible vehicles', () => {
  const { run, context, now } = ui();
  context.snapshot = { events: [{ id: 'ongoing', key: 'car', rule: 'brake', at: new Date(now - 3600000).toISOString(), end: new Date(now).toISOString() }],
    motion_watches: [{ key: 'car', ign_on: true, distance_m: 80 }, { key: 'hidden', ign_on: true }] };
  run('processLocalLive(snapshot)');
  assert.equal(run('LIVE.alerts.length'), 1);
  assert.equal(run('LIVE.motionWatches.length'), 1);
  run('processLocalLive({ motion_watches: [] })');
  assert.equal(run('LIVE.motionWatches.length'), 0);
});
