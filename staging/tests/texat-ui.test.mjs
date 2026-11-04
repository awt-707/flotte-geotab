import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const code = await readFile(new URL('../site/fleet.js', import.meta.url), 'utf8');
const initial = () => ({configured:true, connection:'verified', lastSuccessAt:'2026-11-03T15:00:00Z', coverage:{positionsReturned:8}, rawArchive:{collectionRunning:true, mappedVehicles:8, entries:16, bytes:1024, maxBytes:536870912}});
function ui(api = async () => initial()) {
  const elements = new Map(), calls = [];
  const element = selector => {if (!elements.has(selector)) elements.set(selector,{textContent:'', className:'', disabled:false}); return elements.get(selector);};
  const context = vm.createContext({S:{session:{user:{id:'test-user'}}}, ROUTING:1, isAdmin:()=>true, $:element, fmtDTY:x=>x, api:async (...args)=>{calls.push(args);return api(...args);}});
  vm.runInContext(code, context);
  vm.runInContext('fleetApi = (...args) => api(...args); loadTeksat = setupTeksatConnector(1)', context);
  return {context, element, calls, load:()=>vm.runInContext('loadTeksat()', context), refresh:()=>element('#texat-refresh').onclick()};
}
test('Teksat distinguishes raw history from active failover and uses cached status', async () => {
  const app=ui(); await app.load();
  assert.equal(app.calls[0][0],'texat/status');
  assert.match(app.element('#texat-summary').textContent,/8 positions reçues · 8 véhicules/);
  assert.match(app.element('#texat-archive').textContent,/Conservation automatique active · 16 observations/);
  assert.match(code,/basculement automatique attend la confirmation du fuseau/);
  assert.match(code,/carburant de secours ne sont pas encore calculables/);
});
test('capacity stop preserves an explicit history warning', async () => {
  const status=initial(); status.rawArchive.collectionRunning=false;status.rawArchive.stoppedReason='teksat_archive_full';
  const app=ui(async()=>status); await app.load();
  assert.match(app.element('#texat-archive').textContent,/arrêtée/);
  assert.match(app.element('#texat-warning').textContent,/plein.*données existantes sont conservées/);
});
test('in-flight cached result cannot render after account change or navigation', async () => {
  for (const change of [app=>{app.context.ROUTING=2;},app=>{app.context.S.session.user.id='other-user';},app=>{app.context.isAdmin=()=>false;}]) {
    let resolve;const app=ui(()=>new Promise(r=>{resolve=r;}));const pending=app.load();change(app);resolve(initial());await pending;
    assert.equal(app.element('#texat-summary').textContent,'');
    await app.load();assert.equal(app.calls.length,1);
  }
});
test('explicit connection refresh sends an empty body and prevents duplicate clicks', async () => {
  let finish; const app=ui(async path=>path.endsWith('/refresh')?new Promise(r=>{finish=r;}):initial());
  await app.load(); const pending=app.refresh(); await app.refresh();
  assert.equal(app.calls.filter(x=>x[0]==='texat/refresh').length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[1][1])),{});
  finish(initial());await pending;
  assert.equal(app.element('#texat-result').textContent,'Lecture Teksat vérifiée.');
  assert.equal(app.element('#texat-refresh').disabled,false);
});
