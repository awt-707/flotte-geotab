import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../site/fleet.js',import.meta.url),'utf8');
function fixture(provider){
 const nodes=new Map(),calls=[],status={configured:true,status:'healthy',collectionRemote:true,polling:true,last_success_at:'2026-11-05T10:00:00Z'};
 const element=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},disabled:false,hidden:false,innerHTML:'',textContent:''});return nodes.get(id);};
 const context=vm.createContext({S:{session:{user:{id:'colleague'}}},ROUTING:1,$:element,document:{querySelectorAll:()=>[]},esc:value=>String(value??''),fmtHMS:()=> '10:00:00',fmtDTY:()=> '5 novembre 10:00',msg:text=>text,
  api:async(path,body)=>{calls.push({path,body});return status;}});
 vm.runInContext(code,context);vm.runInContext(`fleetApi=api;loadConnector=setup${provider==='geotab'?'Geotab':'Myclicar'}Connector(1)`,context);
 return {status,calls,element,load:()=>context.loadConnector(),start:()=>element('#'+provider+'-start').onclick(),stop:()=>element('#'+provider+'-stop').onclick(),connect:()=>element('#'+provider+'-connect').onsubmit({preventDefault(){}})};
}
for(const provider of ['geotab','myclicar']){
 test(provider+' shows central health without asking a colleague for local credentials',async()=>{
  const f=fixture(provider);await f.load();assert.match(f.element('#'+provider+'-health').textContent,/Données partagées · Connecté/);assert.match(f.element('#'+provider+'-automation').innerHTML,/poste central/);
  assert.equal(f.element('#'+provider+'-start').hidden,true);assert.equal(f.element('#'+provider+'-stop').hidden,true);assert.equal(f.element('#'+provider+'-password').disabled,true);
  await f.start();await f.stop();await f.connect();assert.equal(f.calls.length,1,'direct handlers cannot start or configure a remote source');
 });
 test(provider+' reports a central outage and restores controls only when this post owns collection',async()=>{
  const f=fixture(provider);f.status.status='stale';await f.load();assert.match(f.element('#'+provider+'-health').textContent,/Données partagées · À vérifier/);
  Object.assign(f.status,{collectionRemote:false,status:'paused',polling:false,vehicles:[]});await f.load();assert.equal(f.element('#'+provider+'-health').textContent,'En pause');assert.equal(f.element('#'+provider+'-password').disabled,false);assert.equal(f.element('#'+provider+'-start').hidden,false);
 });
}
