// Executes the real connector page handlers with synthetic DOM/API responses.
// No browser session, provider request, database, or local credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const code=await fs.readFile(new URL('../site/fleet.js',import.meta.url),'utf8');
async function fixture({source={},activation={ok:true,polling:true},activationStatus=200,configResult={configured:true},configStatus=200,localConfigured=source.configured!==false,configReadStatus=200}={}){
  const nodes=new Map(),calls=[],timers=[];
  const element=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',dataset:{},value:'',checked:false,hidden:false,disabled:false});return nodes.get(selector);};
  const bolt={id:'bolt',configured:true,status:'paused',auto_resume:false,polling:false,...source};
  const state={bolt,activation,activationStatus,configResult,configStatus,localConfigured,configReadStatus,configHold:null};
  const context=vm.createContext({Date,AbortController,AbortSignal,CFG:{WEB_PRODUCTION:false},ROUTING:1,LIVE:{motionCoverage:null},S:{session:{access_token:'synthetic-only'},timers:[]},
    isAdmin:()=>true,$:element,esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
    msg:(text,tone)=>`<div class="${tone}">${text}</div>`,fmtHMS:()=> '12:01:00',fmtDTY:()=> 'Synthetic date',workspaceIcon:()=>'',
    document:{hidden:false},setInterval:fn=>{timers.push(fn);return timers.length;},
    fetch:async(url,options)=>{
      calls.push({url,method:options.method,...(options.body?{body:JSON.parse(options.body)}:{})});assert.equal(options.headers.Authorization,'Bearer synthetic-only');
      if(url==='/api/fleet/overview')return {ok:true,json:async()=>({sources:[bolt],settings:{offline_threshold_s:300}})};
      if(url==='/api/fleet/bolt/config'&&options.method==='GET')return {ok:state.configReadStatus===200,status:state.configReadStatus,json:async()=>state.configReadStatus===200?{configured:state.localConfigured}:{error:'État des accès Bolt indisponible.'}};
      if(url==='/api/fleet/bolt/start')return {ok:state.activationStatus===200,status:state.activationStatus,json:async()=>state.activation};
      if(url==='/api/fleet/bolt/stop')return {ok:true,json:async()=>({ok:true,polling:false})};
      if(url==='/api/fleet/bolt/config'){
        if(state.configHold)await state.configHold;
        if(state.configStatus===200&&state.configResult.configured===true){state.localConfigured=true;if(!bolt.collectionRemote)Object.assign(bolt,{configured:true,status:'paused'});}
        return {ok:state.configStatus===200,status:state.configStatus,json:async()=>state.configResult};
      }
      throw Error('Unexpected synthetic request');
    }});
  vm.runInContext(code,context);
  for(const name of ['setupGeotabConnector','setupTeksatConnector','setupMyclicarConnector','setupFleetValidation'])context[name]=()=>async()=>{};
  await vm.runInContext('pageConnecteurs()',context);
  return {state,context,element,calls,refresh:async()=>{timers[0]();await new Promise(resolve=>setImmediate(resolve));},start:()=>element('#bolt-refresh').onclick(),stop:()=>element('#bolt-stop').onclick(),configure:()=>element('#bolt-config').onsubmit({preventDefault(){}})};
}
const mutations=f=>f.calls.filter(call=>call.method==='POST');

test('Bolt first-read failure returned as HTTP 200 never paints a success',async()=>{
  const f=await fixture({activation:{ok:false,retrying:true,polling:true,auto_resume:true}});
  await f.start();assert.equal(mutations(f).length,1);
  assert.match(f.element('#bolt-result').innerHTML,/class="warn"/);
  assert.match(f.element('#bolt-result').innerHTML,/Lecture Bolt impossible.*nouvelle tentative automatique/);
  assert.doesNotMatch(f.element('#bolt-result').innerHTML,/class="ok"|Suivi automatique activé/);
});
test('only a successful Bolt activation receives the success message',async()=>{
  const f=await fixture();await f.start();assert.match(f.element('#bolt-result').innerHTML,/class="ok".*Suivi automatique activé/);
  for(const activation of [{ok:false},{ok:true,retrying:true},{ok:true,ignored:true,polling:false},{}]){
    const g=await fixture({activation});await g.start();assert.match(g.element('#bolt-result').innerHTML,/class="warn"/);
    assert.doesNotMatch(g.element('#bolt-result').innerHTML,/class="ok"|Suivi automatique activé/);
  }
});
test('provider and lease HTTP failures stay visible, escaped, and never become activation success',async()=>{
  const f=await fixture({activationStatus:409,activation:{error:'Cette action demande la collecte active <sur ce poste>.'}});
  await f.start();assert.match(f.element('#bolt-result').innerHTML,/class="err".*collecte active &lt;sur ce poste&gt;/);
  assert.doesNotMatch(f.element('#bolt-result').innerHTML,/<sur ce poste>|Suivi automatique activé/);
});
test('a remote healthy source never proves local Bolt configuration or permits local start/stop',async()=>{
  const f=await fixture({source:{collectionRemote:true,configured:true,status:'healthy',polling:true}});
  assert.equal(f.element('#bolt-refresh').disabled,true);assert.equal(f.element('#bolt-refresh').hidden,false);
  assert.equal(f.element('#bolt-stop').disabled,true);assert.equal(f.element('#bolt-stop').hidden,true);
  assert.match(f.element('#bolt-health').innerHTML,/Données partagées/);
  assert.match(f.element('#bolt-automation').innerHTML,/ne confirment pas les accès Bolt de cet ordinateur/);
  assert.match(f.element('#bolt-automation').innerHTML,/href="#\/application"/);
  await f.start();await f.stop();assert.equal(mutations(f).length,0,'even a direct handler invocation cannot pilot a follower');
});
test('a paused or unconfigured remote source retains explicit participation guidance without enabling collection',async()=>{
  for(const status of ['paused','unconnected','error']){
    const f=await fixture({source:{collectionRemote:true,status,configured:status!=='unconnected'}});
    assert.equal(f.element('#bolt-refresh').disabled,true);assert.match(f.element('#bolt-automation').innerHTML,/Collecte inactive sur ce poste/);
    assert.doesNotMatch(f.element('#bolt-automation').innerHTML,/Reprise automatique après/);await f.start();assert.equal(mutations(f).length,0);
  }
});
test('a refreshed ownership change updates controls while preserving explicit manual activation',async()=>{
  const f=await fixture({source:{collectionRemote:true,status:'healthy',polling:true}});
  Object.assign(f.state.bolt,{collectionRemote:false,status:'paused',configured:true,polling:false});await f.refresh();
  assert.equal(f.element('#bolt-refresh').disabled,false);assert.equal(mutations(f).length,0);
  await f.start();assert.equal(mutations(f).length,1);
  Object.assign(f.state.bolt,{collectionRemote:true,status:'healthy',polling:true});await f.refresh();
  await f.stop();assert.equal(mutations(f).length,1,'ownership loss disables further local mutations');
});
test('local unconfigured Bolt cannot start; staging configured Bolt retains its existing controls',async()=>{
  const absent=await fixture({source:{configured:false,status:'unconnected'}});await absent.start();assert.equal(mutations(absent).length,0);assert.equal(absent.element('#bolt-refresh').disabled,true);
  const staging=await fixture({source:{configured:true,status:'paused'}});assert.equal(staging.element('#bolt-refresh').disabled,false);await staging.start();await staging.stop();assert.equal(mutations(staging).length,2);
});
test('an admin can prepare Bolt credentials on a standby PC without starting collection',async()=>{
  const f=await fixture({source:{collectionRemote:true,configured:false,status:'unconnected'}});
  assert.equal(f.element('#bolt-config-save').disabled,false);
  assert.match(f.element('#bolt-config-state').textContent,/Aucun accès Bolt enregistré sur ce poste/);
  assert.match(f.element('#page').innerHTML,/id="bolt-client-secret"[^>]*type="password"[^>]*autocomplete="off"/);
  f.element('#bolt-client-id').value='synthetic-client';f.element('#bolt-client-secret').value='synthetic-secret';
  await f.configure();assert.deepEqual(mutations(f),[{url:'/api/fleet/bolt/config',method:'POST',body:{clientId:'synthetic-client',clientSecret:'synthetic-secret'}}]);
  assert.equal(f.element('#bolt-client-id').value,'');assert.equal(f.element('#bolt-client-secret').value,'');
  assert.match(f.element('#bolt-config-state').textContent,/Accès Bolt enregistrés sur ce poste/);
  assert.match(f.element('#bolt-config-result').innerHTML,/Accès enregistrés sur ce poste.*validité sera vérifiée au démarrage/);
  assert.equal(f.element('#bolt-refresh').disabled,true);assert.doesNotMatch(f.element('#bolt-config-result').innerHTML,/synthetic-secret|Accès vérifiés|Suivi automatique activé/);
});
test('saving Bolt credentials on the collector enables a separate manual start only',async()=>{
  const f=await fixture({source:{configured:false,status:'unconnected',collectionRemote:false}});
  f.element('#bolt-client-id').value='synthetic-client';f.element('#bolt-client-secret').value='synthetic-secret';
  await f.configure();assert.equal(mutations(f).length,1);assert.equal(f.element('#bolt-refresh').disabled,false);
  await f.start();assert.deepEqual(mutations(f).map(call=>call.url),['/api/fleet/bolt/config','/api/fleet/bolt/start']);
});
test('missing credentials, refused save, or an unconfirmed response cannot report configuration success',async()=>{
  const missing=await fixture();await missing.configure();assert.equal(mutations(missing).length,0);assert.match(missing.element('#bolt-config-result').innerHTML,/Renseignez/);
  for(const options of [{configStatus:403,configResult:{error:'Administrateur requis.'}},{configResult:{configured:false}}]){
    const f=await fixture({...options,source:{configured:false,status:'unconnected'}});
    f.element('#bolt-client-id').value='synthetic-client';f.element('#bolt-client-secret').value='synthetic-secret';
    await f.configure();assert.match(f.element('#bolt-config-result').innerHTML,/class="err"/);assert.doesNotMatch(f.element('#bolt-config-result').innerHTML,/Accès enregistrés|synthetic-secret/);
    assert.equal(f.element('#bolt-client-secret').value,'');assert.equal(f.element('#bolt-refresh').disabled,true);assert.equal(mutations(f).length,1);
  }
});
test('a pending credentials save blocks repeated submissions and concurrent starts',async()=>{
  const f=await fixture();let release;f.state.configHold=new Promise(resolve=>release=resolve);
  f.element('#bolt-client-id').value='synthetic-client';f.element('#bolt-client-secret').value='synthetic-secret';
  const saving=f.configure();assert.equal(f.element('#bolt-config-save').disabled,true);assert.equal(f.element('#bolt-refresh').disabled,true);
  await f.configure();await f.start();assert.equal(mutations(f).length,1);release();await saving;
  assert.equal(f.element('#bolt-config-save').disabled,false);assert.equal(f.element('#bolt-client-secret').value,'');
});
test('remote configuration never replaces the local boolean; unknown local status blocks start',async()=>{
  const remote=await fixture({source:{collectionRemote:true,configured:true,status:'healthy',polling:true},localConfigured:false});
  assert.match(remote.element('#bolt-config-state').textContent,/Aucun accès Bolt enregistré sur ce poste/);assert.equal(remote.element('#bolt-config-save').disabled,false);
  const missing=await fixture({source:{configured:true,status:'paused'},localConfigured:false});await missing.start();assert.equal(mutations(missing).length,0);
  const failed=await fixture({configReadStatus:503});await failed.start();assert.equal(mutations(failed).length,0);assert.match(failed.element('#bolt-config-state').textContent,/indisponible/);
});
test('credentials cannot be replaced while this PC is actively polling, but remote polling does not block preparation',async()=>{
  const f=await fixture({source:{configured:true,status:'healthy',polling:true,auto_resume:true,collectionRemote:false}});
  assert.equal(f.element('#bolt-config-save').disabled,true);assert.match(f.element('#bolt-config-state').textContent,/Mettez le suivi Bolt en pause/);
  f.element('#bolt-client-id').value='synthetic-client';f.element('#bolt-client-secret').value='synthetic-secret';await f.configure();assert.equal(mutations(f).length,0);
  Object.assign(f.state.bolt,{collectionRemote:true});await f.refresh();assert.equal(f.element('#bolt-config-save').disabled,false);await f.configure();assert.equal(mutations(f).length,1);
});
