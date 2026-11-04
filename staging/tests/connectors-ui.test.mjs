import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const code = await fs.readFile(new URL('../site/fleet.js', import.meta.url), 'utf8');
function ui() {
  const context = vm.createContext({Date, LIVE:{motionCoverage:null}, esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'), fmtHMS:()=> '12:00:20'});
  vm.runInContext(code,context); return {context,run:source=>vm.runInContext(source,context)};
}
test('connector UI distinguishes durable pause, active automation and retry without reporting a healthy old sample as active',()=>{
  const {run,context}=ui();context.source={configured:true,status:'healthy',auto_resume:false,polling:false};
  assert.equal(run('fleetConnectorState(source).label'),'En pause');
  assert.equal(run('fleetConnectorState(source).active'),false);
  assert.match(run('fleetConnectorAutomation(source)'),/Pause conservée au redémarrage/);
  context.source={...context.source,auto_resume:true,polling:true};
  assert.equal(run('fleetConnectorState(source).label'),'Suivi actif');
  assert.match(run('fleetConnectorAutomation(source)'),/Reprise automatique après une coupure/);
  context.source={...context.source,status:'error',retrying:true,next_attempt_at:new Date(Date.now()+20000).toISOString(),last_error:'Quota temporaire'};
  assert.equal(run('fleetConnectorState(source).label'),'Reconnexion automatique');
  assert.match(run('fleetConnectorAutomation(source)'),/Nouvel essai : 12:00:20/);
  assert.match(run('fleetConnectorAutomation(source)'),/Quota temporaire/);
});
test('automation persistence failure is visible and cannot claim durable restart recovery',()=>{
  const {run,context}=ui();context.source={configured:true,status:'healthy',polling:true,auto_resume:false,automation_error:'Configuration locale indisponible'};
  assert.equal(run('fleetConnectorState(source).label'),'Automatisation à vérifier');
  assert.match(run('fleetConnectorAutomation(source)'),/Configuration locale indisponible/);
  assert.doesNotMatch(run('fleetConnectorAutomation(source)'),/Reprise automatique après/);
});
test('paused connectors never show a scheduled provider retry from old metadata',()=>{
  const {run,context}=ui();context.source={configured:true,status:'error',auto_resume:false,polling:false,retrying:true,next_attempt_at:new Date().toISOString(),last_error:'Ancienne erreur'};
  assert.match(run('fleetConnectorAutomation(source)'),/Aucune lecture programmée/);
  assert.doesNotMatch(run('fleetConnectorAutomation(source)'),/Ancienne erreur|Nouvel essai/);
});
test('unconfigured connectors and temporarily starting automation have distinct states',()=>{
  const {run,context}=ui();context.source={configured:false,status:'unconnected'};
  assert.equal(run('fleetConnectorState(source).configured'),false);
  assert.equal(run('fleetConnectorState(source).label'),'À connecter');
  context.source={configured:true,status:'paused',auto_resume:true,polling:false};
  assert.equal(run('fleetConnectorState(source).label'),'Démarrage automatique');
});
test('connector errors and automation state are rendered as text rather than executable markup',()=>{
  const {run,context}=ui();context.source={configured:true,status:'error',polling:true,last_error:'<img src=x onerror=bad()>',automation_error:'<script>bad()</script>'};
  const html=run('fleetConnectorAutomation(source)');assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img/);
});
test('surveillance coverage explicitly includes both platforms and keeps unknown assignment coverage distinct from zero',()=>{
  const {run,context}=ui();context.sources=[{id:'uber',status:'stale'},{id:'bolt',status:'healthy'},{id:'geotab',status:'healthy'}];
  const pending=run('fleetConnectorSurveillance(sources)');assert.match(pending,/Uber Fleet · À vérifier/);assert.match(pending,/Bolt · Connecté/);assert.match(pending,/prochaine lecture locale/);
  context.LIVE.motionCoverage={linked_drivers:2,unassigned_drivers:11};
  assert.match(run('fleetConnectorSurveillance(sources)'),/2 affectations véhicule actuellement confirmées\. 11 à confirmer/);
});
