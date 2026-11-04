import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../site/disconnections.js',import.meta.url),'utf8');
function fixture(){const context=vm.createContext({});vm.runInContext(source,context);return {context,run:code=>vm.runInContext(code,context)};}
const alert={id:'incident',driver_id:'driver',driver_name:'Synthetic Driver',source:'uber',vehicle_key:null,plate:null,status:'open',disconnected_at:'2026-10-31T10:00:00Z',observed_online_at:'2026-10-31T09:59:00Z'};
const snapshot={at:'2026-10-31T10:00:01Z',enabled:false,policy:'any',duty_mode:'contract',coverage:{expected_drivers:2},warnings:[{code:'unknown',count:1,message:'Un état reste à confirmer.'}],alerts:[alert]};
test('disabled settings cannot produce urgent notifications and a vehicle is not required for an authorized incident',()=>{
 const {context,run}=fixture();context.input=structuredClone(snapshot);
 assert.equal(run('disconnectionsActive(disconnectionsNormalize(input), "").length'),0);
 context.input.enabled=true;assert.equal(run('disconnectionsActive(disconnectionsNormalize(input), "").length'),1);
 assert.equal(run('disconnectionsNormalize(input).alerts[0].vehicle_key'),null);
 assert.equal(run('disconnectionsNormalize(input).warnings[0]'),'1 · Un état reste à confirmer.');
 assert.equal(run('disconnectionsActive(disconnectionsNormalize(input), "unavailable").length'),0);
});
test('coverage warnings preserve positive integer counts and omit misleading zero, negative or fractional prefixes',()=>{
 const {context,run}=fixture();context.input={...snapshot,warnings:[{count:6,message:'Contrats écartés.'},{count:2,message:'Véhicules non reconnus.'},{count:0,message:'Sans quantité.'},{count:-1,message:'Invalide.'},{count:1.5,message:'Fraction.'},'Lecture partielle.']};
 assert.deepEqual(Array.from(run('disconnectionsNormalize(input).warnings')),['6 · Contrats écartés.','2 · Véhicules non reconnus.','Sans quantité.','Invalide.','Fraction.','Lecture partielle.']);
});
test('an authoritative snapshot replaces historical permissions and keeps completed incidents distinct from current urgency',()=>{
 const {context,run}=fixture();context.input={...snapshot,enabled:true,alerts:[alert,{...alert,id:'done',status:'resolved'},{...alert,id:'waiting',status:'suspended'}]};
 const normalized=run('disconnectionsNormalize(input)');assert.equal(normalized.alerts.length,3);assert.equal(run('disconnectionsActive(disconnectionsNormalize(input), "").length'),1);
 context.input.alerts=[];assert.equal(run('disconnectionsNormalize(input).alerts.length'),0);
});
test('duplicate incident IDs never create duplicate cards and a completed duplicate cannot be revived by an open copy',()=>{
 const {context,run}=fixture();context.input={...snapshot,enabled:true,alerts:[{...alert,status:'resolved'},alert,alert]};
 assert.equal(run('disconnectionsNormalize(input).alerts.length'),1);assert.equal(run('disconnectionsActive(disconnectionsNormalize(input), "").length'),0);
});
test('unexpected states and identifiers are ignored while malformed settings are rejected',()=>{
 const {context,run}=fixture();context.input={...snapshot,alerts:[alert,{...alert,id:'bad-source',source:'other'},{...alert,id:'bad-state',status:'suspected'},{...alert,id:'',driver_id:''}]};
 assert.equal(run('disconnectionsNormalize(input).alerts.length'),1);
 for(const change of [{enabled:undefined},{policy:'either'},{duty_mode:'always'},{alerts:null}]){context.input={...snapshot,...change};assert.throws(()=>run('disconnectionsNormalize(input)'));}
 assert.equal(run("disconnectionsPolicy('any')"),'Déconnexion d’une plateforme');
 assert.equal(run("disconnectionsPolicy('all')"),'Déconnexion confirmée du chauffeur');
});
