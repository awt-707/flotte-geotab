import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {createProviderReconciliationClient,renderReconciliationQueue} from '../site/provider-reconciliation-ui.js';
const ID='11111111-1111-4111-8111-111111111111',USER='22222222-2222-4222-8222-222222222222',PROVIDER='33333333-3333-4333-8333-333333333333';
const snapshot={id:ID,revision:3,period_start:'2026-11-02T04:00:00Z',period_end:'2026-11-09T04:00:00Z',observed_at:'2026-11-03T12:00:00Z',total_rows:3};
const value={version:1,snapshot,rows:[{provider_row:0,provider_driver_id:PROVIDER,driver_name:'Synthetic <Driver>',mapping_status:'unmatched'},{provider_row:1,provider_driver_id:null,driver_name:'Synthetic unknown UUID',mapping_status:'unmatched'}],drivers:[{code:'A',name:'Reference A',agency_id:1},{code:'B',name:'Reference B without agency',agency_id:null}],agencies:[{id:1,name:'Agency A'},{id:2,name:'Agency B'}]};
const receipt={version:1,audit_id:ID,decision:'confirmed_identity',financial_history_unchanged:true,awaiting_next_collection:true};
const selection={snapshot,row:value.rows[0],driver:value.drivers[0],agencyId:'1',evidenceKind:'provider_profile',evidenceReference:'Synthetic profile checked 2026-11-03',confirmed:true};
function clientFixture(){const state={role:'admin',token:'token-A',user:USER,calls:[],signals:[],hold:null,error:null,after:null};
 const supabase={auth:{getSession:async()=>({data:{session:{user:{id:state.user},access_token:state.token}}})},from:()=>({select(){return this;},eq(){return this;},async maybeSingle(){return {data:{user_id:state.user,role:state.role},error:null};}}),rpc(name,args){state.calls.push({name,args});const result=(async()=>{if(state.hold)await state.hold;state.after?.();return {data:name==='provider_earnings_reconciliation_queue'?value:receipt,error:state.error};})();result.abortSignal=signal=>{state.signals.push(signal);return result;};return result;}};
 return {state,client:createProviderReconciliationClient({supabase})};
}
test('admin client reads a bounded queue and confirms only exact explicit selection, never amounts or invented UUIDs',async()=>{
 const {client,state}=clientFixture();assert.deepEqual(await client.load({snapshotId:ID}),value);assert.deepEqual(state.calls[0],{name:'provider_earnings_reconciliation_queue',args:{p_snapshot:ID}});
 assert.deepEqual(await client.confirm(selection),receipt);assert.deepEqual(state.calls[1].args,{p_snapshot:ID,p_revision:3,p_row:0,p_driver_code:'A',p_agency_id:1,p_evidence_kind:'provider_profile',p_evidence_reference:selection.evidenceReference,p_confirm:true,p_assign_missing_agency:false});client.dispose();
});
test('unknown UUID, missing confirmation, inconsistent agency and missing-agency assignment are rejected before the RPC',async()=>{
 for(const patch of [{row:value.rows[1]},{confirmed:false},{agencyId:'2'},{evidenceReference:'short'},{driver:value.drivers[1]}]){const {client,state}=clientFixture();await assert.rejects(client.confirm({...selection,...patch}));assert.equal(state.calls.length,0);client.dispose();}
 const {client,state}=clientFixture();await client.confirm({...selection,driver:value.drivers[1],assignMissingAgency:true});assert.equal(state.calls[0].args.p_assign_missing_agency,true);client.dispose();
});
test('role is checked again after reads and writes; switched sessions never publish old identity data',async()=>{
 for(const role of ['manager','viewer']){const {client,state}=clientFixture();state.role=role;await assert.rejects(client.load(),error=>error.code==='reconciliation_denied');assert.equal(state.calls.length,0);client.dispose();}
 const lost=clientFixture();lost.state.after=()=>lost.state.role='viewer';await assert.rejects(lost.client.load(),error=>error.code==='reconciliation_denied');lost.client.dispose();
 const switched=clientFixture();switched.state.after=()=>switched.state.token='other-token';await assert.rejects(switched.client.confirm(selection),error=>error.name==='AbortError');switched.client.dispose();
});
test('stale/conflicting decisions expose safe errors and disposal aborts late reads',async()=>{
 for(const code of ['40001','23505','42501']){const {client,state}=clientFixture();state.error={code,message:'SECRET private internals'};await assert.rejects(client.confirm(selection),error=>!error.message.includes('SECRET'));client.dispose();}
 const {client,state}=clientFixture();let release;state.hold=new Promise(resolve=>release=resolve);const read=client.load();await new Promise(resolve=>setTimeout(resolve,0));client.dispose();assert.equal(state.signals[0].aborted,true);release();await assert.rejects(read,error=>error.name==='AbortError');
});
test('queue escapes identities and distinguishes proof missing from a confirmed association',()=>{const html=renderReconciliationQueue(value);assert.match(html,/Synthetic &lt;Driver&gt;/);assert.doesNotMatch(html,/<Driver>/);assert.match(html,/Voir la preuve manquante/);assert.match(html,/UUID fournisseur prouvé/);});

async function uiFixture(){const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),page=await browser.newPage({viewport:{width:1380,height:960}}),state={calls:[],disposed:0,hold:false,pending:null,denied:0};
 await page.exposeFunction('__load',()=>state.hold?new Promise(resolve=>state.pending=resolve):value);await page.exposeFunction('__confirm',args=>{state.calls.push(args);return receipt;});await page.exposeFunction('__dispose',()=>state.disposed++);
 const file=readFileSync(new URL('../site/provider-reconciliation-ui.js',import.meta.url),'utf8'),css=readFileSync(new URL('../site/provider-earnings-ui.css',import.meta.url),'utf8');
 await page.route('http://fixture.invalid/**',route=>{const u=new URL(route.request().url());if(u.pathname==='/ui.js')return route.fulfill({contentType:'text/javascript',body:file});if(u.pathname==='/style.css')return route.fulfill({contentType:'text/css',body:css});return route.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/style.css"></head><body><main id="app"></main><script type="module">import {mountProviderReconciliation} from "/ui.js";window.__current=true;window.__denied=0;window.__view=mountProviderReconciliation({element:document.querySelector("#app"),client:{load:window.__load,confirm:window.__confirm,dispose:window.__dispose},isCurrent:()=>window.__current,onAccessLost:()=>window.__denied++});</script></body></html>'});});
 await page.goto('http://fixture.invalid/');await page.locator('[data-reconcile-row]').first().waitFor();return {page,browser,state};
}
test('review form has no guessed selection; proof and explicit agency assignment produce one decision',async()=>{
 const f=await uiFixture();try{await f.page.locator('[data-reconcile-row="0"]').click();assert.equal(await f.page.locator('select[name=driver]').inputValue(),'');assert.equal(await f.page.locator('select[name=agency]').inputValue(),'');
  await f.page.locator('select[name=driver]').selectOption('B');await f.page.locator('select[name=agency]').selectOption('1');assert.equal(await f.page.locator('[data-missing-agency]').isVisible(),true);
  await f.page.locator('select[name=proof]').selectOption('provider_profile');await f.page.locator('input[name=reference]').fill('Synthetic original document, reviewed 2026-11-03');await f.page.locator('input[name=confirm]').check();await f.page.locator('input[name=assignAgency]').check();await f.page.locator('button[type=submit]').click();await f.page.locator('dialog').waitFor({state:'detached'});
  assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].row.provider_driver_id,PROVIDER);assert.equal(f.state.calls[0].driver.code,'B');assert.equal(f.state.calls[0].assignMissingAgency,true);assert.match(await f.page.locator('[data-reconcile-status]').innerText(),/aucun montant historique/);
 }finally{await f.browser.close();}
});
test('missing UUID opens only proof guidance and mobile layout remains bounded',async()=>{
 const f=await uiFixture();try{await f.page.setViewportSize({width:390,height:844});await f.page.locator('[data-reconcile-row="1"]').click();assert.equal(await f.page.locator('dialog form').count(),0);assert.equal(await f.page.locator('dialog button[type=submit]').count(),0);assert.match(await f.page.locator('dialog').innerText(),/Aucun rapprochement n’est enregistré/);assert.equal(f.state.calls.length,0);assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 }finally{await f.browser.close();}
});
test('role loss clears identities/dialogs and navigation disposal ignores stale reads',async()=>{
 const f=await uiFixture();try{await f.page.locator('[data-reconcile-row="0"]').click();await f.page.evaluate(()=>window.__current=false);await f.page.waitForFunction(()=>window.__denied===1);assert.equal(await f.page.locator('[data-reconcile-row]').count(),0);assert.equal(await f.page.locator('dialog').count(),0);assert.equal(f.state.disposed,1);}
 finally{await f.browser.close();}
 const g=await uiFixture();try{g.state.hold=true;await g.page.locator('[data-reconcile-refresh]').click();await g.page.waitForTimeout(40);await g.page.evaluate(()=>{window.__view.dispose();document.querySelector('#app').textContent='Next route';});g.state.pending(value);await g.page.waitForTimeout(30);assert.equal(await g.page.locator('#app').innerText(),'Next route');assert.equal(g.state.disposed,1);}finally{await g.browser.close();}
});

test('a delayed refresh closes old reviews and cannot combine an old row with a new snapshot revision',async()=>{
 const f=await uiFixture();try{
  await f.page.locator('[data-reconcile-row="0"]').click();f.state.hold=true;
  await f.page.evaluate(()=>void window.__view.refresh());await f.page.locator('dialog').waitFor({state:'detached'});
  await f.page.locator('[data-reconcile-row="0"]').click();assert.equal(await f.page.locator('dialog').count(),0,'old rows cannot be opened while their replacement loads');
  const changed=structuredClone(value);changed.snapshot.revision=4;changed.rows[0].provider_driver_id=USER;changed.rows[0].driver_name='Synthetic reordered row';
  await new Promise(resolve=>setTimeout(resolve,20));f.state.pending(changed);await f.page.locator('[data-reconcile-refresh]:enabled').waitFor();
  await f.page.locator('[data-reconcile-row="0"]').click();await f.page.locator('select[name=driver]').selectOption('A');await f.page.locator('select[name=agency]').selectOption('1');await f.page.locator('select[name=proof]').selectOption('provider_profile');await f.page.locator('input[name=reference]').fill('Synthetic reordered profile reviewed');await f.page.locator('input[name=confirm]').check();await f.page.locator('button[type=submit]').click();await f.page.locator('dialog').waitFor({state:'detached'});
  assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].snapshot.revision,4);assert.equal(f.state.calls[0].row.provider_driver_id,USER);
 }finally{await f.browser.close();}
});
