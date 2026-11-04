import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID,webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const source=async name=>readFile(new URL(`../uber-extension/${name}`,import.meta.url),'utf8');
const reader=await source('reader.js'),protocolSource=await source('protocol.js');
const uuid='11111111-1111-4111-8111-111111111111';
const fixtureUrl=`https://fixture.invalid/orgs/${uuid}/livemap`;
const uberUrl=`https://fleethub.uber.com/orgs/${uuid}/livemap`;
const style='<style>body{font:16px sans-serif;margin:20px}#panel{width:500px;padding:12px}.controls{display:flex;gap:15px}.card{display:flex;align-items:center;position:relative;height:78px;border-bottom:1px solid #ddd}.avatar{height:48px;width:48px;position:relative;margin-right:18px}.avatar svg{width:48px;height:48px}.dot{position:absolute;bottom:0;right:0;width:12px;height:12px;border-radius:50%}.name{display:inline-block}td,th{padding:12px;text-align:left}</style>';
const card=(name,color,extra='')=>`<div class="card" ${extra}><div class="avatar"><svg aria-hidden="true" viewBox="0 0 48 48"><rect width="48" height="48" fill="#ddd"/></svg><span class="dot" style="background:${color}"></span></div><span class="name">${name}</span></div>`;
const cards=()=>`<!doctype html>${style}<div id="panel"><div class="controls"><button>Chauffeur</button><button>Statut</button></div>${card('Alex Fictif','#545454')}${card('Béa Fictive','#276ef1')}${card('Cam Fictif','#05944f')}${card('Dan Fictif','#abcdef')}</div>`;
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM || '/usr/bin/chromium'});});
after(async()=>{await browser?.close();});
async function withPage(html,work){
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
  await page.goto(fixtureUrl);await page.addScriptTag({content:reader});
  try{return await work(page);}finally{await page.close();}
}
const read=page=>page.evaluate(()=>LudyUberReader.read());

test('palette contractuelle : gris disponible, bleu en course, vert en approche, inconnu conservé',async()=>{
  await withPage(cards(),async page=>{
    const result=await read(page);
    assert.equal(result.status,'observing');assert.equal(result.organizationId,uuid);
    assert.deepEqual(result.rows.map(row=>row.state),['available','on_trip','to_pickup','unknown']);
    assert.equal(result.sourceAt,null);
    for(const row of result.rows){assert.equal(row.readAt,result.observedAt);assert.equal(row.sourceAt,null);assert.equal(row.sourceId,null);}
  });
});
test('tableau : hors ligne explicite, UUID de fiche visible, absence sans inférence',async()=>{
  const id='22222222-2222-4222-8222-222222222222';
  const html=`${style}<table><tr><th>Chauffeur</th><th>Statut</th></tr><tr id="available"><td><a href="/orgs/${uuid}/drivers/${id}">Alex Fictif</a></td><td>Disponible</td></tr><tr><td>Béa Fictive</td><td>Hors ligne</td></tr><tr><td>Cam Fictif</td><td>Approuvé</td></tr></table>`;
  await withPage(html,async page=>{
    const initial=await read(page);assert.deepEqual(initial.rows.map(row=>row.state),['available','offline','unknown']);assert.equal(initial.rows[0].sourceId,id);
    await page.locator('#available').evaluate(element=>element.remove());
    const next=await read(page);assert.equal(next.rows.length,2);assert(!next.rows.some(row=>row.name==='Alex Fictif'));
  });
});
test('cartes retirées, masquées, hors écran, homonymes et numéro de téléphone exclus',async()=>{
  await withPage(cards(),async page=>{
    await page.locator('.card').nth(1).evaluate(element=>element.style.display='none');
    await page.locator('.card').nth(2).evaluate(element=>element.style.transform='translateY(1500px)');
    let result=await read(page);assert.deepEqual(result.rows.map(row=>row.name),['Alex Fictif','Dan Fictif']);
    await page.locator('.card').last().locator('.name').evaluate(element=>element.textContent='Alex Fictif');
    result=await read(page);assert.equal(result.status,'error');assert.equal(result.rows.length,0);
    await page.locator('.card').last().locator('.name').evaluate(element=>element.textContent='+33 6 00 00 00 00');
    result=await read(page);assert.equal(result.rows.length,1);assert.equal(result.rows[0].name,'Alex Fictif');
  });
});
test('connexion, page vide et page masquée ne produisent aucun hors ligne',async()=>{
  await withPage(`${style}<input type="password" value="fixture-only">`,async page=>{const result=await read(page);assert.equal(result.status,'error');assert.deepEqual(result.rows,[]);assert(!JSON.stringify(result).includes('fixture-only'));});
  await withPage(cards(),async page=>{await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true}));const result=await read(page);assert.equal(result.status,'error');assert.deepEqual(result.rows,[]);});
  await withPage('<p>Aucune carte</p>',async page=>{assert.equal((await read(page)).status,'error');});
});

test('plaques visibles et non ambiguës seulement : colonne dédiée ou ligne de carte',async()=>{
  const html=`${style}<table><tr><th>Chauffeur</th><th>Statut</th><th>Immatriculation</th></tr><tr><td>Alex Fictif</td><td>Disponible</td><td>86119-T-1</td></tr><tr><td>Béa Fictive</td><td>Hors ligne</td><td><span style="display:none">WW968201</span><span>+33 6 00 00 00 00</span></td></tr></table>`;
  await withPage(html,async page=>{
    const result=await read(page);assert.equal(result.rows[0].vehicleLabel,'86119-T-1');assert.equal(result.rows[1].vehicleLabel,undefined);
  });
  await withPage(cards(),async page=>{
    await page.locator('.card').first().evaluate(element=>{const line=document.createElement('div');line.textContent='Immatriculation : WW968201';line.style.cssText='position:absolute;left:66px;top:58px;font-size:10px';element.append(line);});
    let result=await read(page);assert.equal(result.rows.find(row=>row.name==='Alex Fictif').vehicleLabel,'WW968201');
    await page.locator('.card').first().evaluate(element=>{const line=document.createElement('div');line.textContent='AB-123-CD';line.style.cssText='position:absolute;left:280px;top:58px;font-size:10px';element.append(line);});
    result=await read(page);assert.equal(result.rows.find(row=>row.name==='Alex Fictif').vehicleLabel,undefined,'multiple plaques or combined text are not selected arbitrarily');
  });
});

function protocol(){const sandbox={URL,TextEncoder,Date};vm.createContext(sandbox);vm.runInContext(protocolSource,sandbox);return sandbox.LudyUberProtocol;}
const batch=(now=Date.now())=>({observedAt:new Date(now).toISOString(),sourceAt:null,organizationId:uuid,status:'observing',rows:[{sourceId:null,name:'Alex Fictif',rawState:'Pastille #276ef1',state:'on_trip',readAt:new Date(now).toISOString(),sourceAt:null}],warnings:[]});
test('contrat : seulement loopback 4173, timestamps explicites, champs bornés, aucun contenu de session',()=>{
  const bridge=protocol(),now=Date.now(),input=batch(now);
  assert.equal(bridge.payload(input,uuid,now).rows[0].state,'on_trip');
  assert.equal(bridge.destination(bridge.ENDPOINT),'http://127.0.0.1:4173/api/fleet/uber/ingest');
  assert.equal(bridge.destination(bridge.COLLECTION_STATUS),'http://127.0.0.1:4173/api/fleet/uber/collection-status');
  for(const url of ['https://example.com/ingest','http://127.0.0.1:4174/api/fleet/uber/ingest','http://127.0.0.1:4173/other'])assert.throws(()=>bridge.destination(url));
  assert(bridge.permittedUrl(uberUrl));
  for(const url of ['https://auth.uber.com/',uberUrl.replace('/livemap','/reports'),'https://fleethub.uber.com.evil.invalid/orgs/'+uuid+'/livemap'])assert.equal(bridge.permittedUrl(url),false);
  assert.throws(()=>bridge.payload({...input,cookie:'fixture'},uuid,now));
  assert.throws(()=>bridge.payload({...input,sourceAt:input.observedAt},uuid,now));
  assert.throws(()=>bridge.payload(batch(now-31000),uuid,now));
  assert.throws(()=>bridge.payload({...input,rows:[...input.rows,...input.rows]},uuid,now));
  assert.throws(()=>bridge.payload({...input,rows:Array(201).fill(input.rows[0])},uuid,now));
  assert.throws(()=>bridge.payload({...input,status:'error'},uuid,now));
});

test('bridge extension : association popup seule, lecture liée à l’onglet, Bearer local et arrêt',async()=>{
  let listener,stored={},requests=[];
  const event=()=>({addListener(){}});
  const extensionId='fixture-extension',popup=`chrome-extension://${extensionId}/popup.html`;
  const api={
    runtime:{id:extensionId,getURL:file=>`chrome-extension://${extensionId}/${file}`,onMessage:{addListener:fn=>listener=fn}},
    storage:{session:{get:async()=>stored,set:async value=>{stored=value;}}},
    tabs:{query:async()=>[{id:7,url:uberUrl}],sendMessage:async()=>({ok:true}),onRemoved:event(),onUpdated:event()},
    scripting:{executeScript:async()=>{}},
  };
  const sandbox={chrome:api,URL,TextEncoder,Date,crypto:webcrypto,setTimeout,clearTimeout,AbortController,fetch:async(url,options)=>{requests.push({url,options});return {ok:true,status:200};}};
  vm.createContext(sandbox);vm.runInContext(protocolSource,sandbox);vm.runInContext(await source('background.js'),sandbox);
  const call=(message,sender={id:extensionId,url:popup})=>new Promise(resolve=>listener(message,sender,resolve));
  const token='fixture-pairing-'+randomUUID();
  assert.equal((await call({type:'LUDY_UBER_PAIR',token})).ok,true);
  assert.equal((await call({type:'LUDY_UBER_START'})).ok,true);
  const runId=stored.connector.runId;
  const sender={id:extensionId,url:uberUrl,tab:{id:7},frameId:0};
  assert.equal((await call({type:'LUDY_UBER_READ',runId,result:batch()},sender)).ok,true);
  assert.equal(requests.length,1);assert.equal(requests[0].url,'http://127.0.0.1:4173/api/fleet/uber/ingest');
  assert.equal(requests[0].options.headers.Authorization,`Bearer ${token}`);assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.redirect,'error');
  const sent=JSON.parse(requests[0].options.body);assert.equal(sent.rows[0].state,'on_trip');assert(!requests[0].options.body.includes(token));
  assert.equal((await call({type:'LUDY_UBER_READ',runId,result:batch()},{...sender,tab:{id:8}})).ok,false);
  assert.equal((await call({type:'LUDY_UBER_PAIR',token},sender)).ok,false);
  const state=(await call({type:'LUDY_UBER_STATUS'})).data;assert(!JSON.stringify(state).includes(token));
  assert.equal((await call({type:'LUDY_UBER_STOP'})).ok,true);
  assert.equal(JSON.parse(requests.at(-1).options.body).status,'stopped');assert.equal(stored.connector.active,false);
});

test('extension Chromium installable : service worker, popup et association privée réels',async()=>{
  const extensionPath=fileURLToPath(new URL('../uber-extension/',import.meta.url));
  const context=await chromium.launchPersistentContext('',{headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM || '/usr/bin/chromium',args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`],ignoreDefaultArgs:['--disable-extensions']});
  try{
    await context.route('http://**/*',route=>route.abort());await context.route('https://**/*',route=>route.abort());
    const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).hostname,page=await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.getByLabel('Code d’association Ludy').fill('fixture-pairing-'+randomUUID());
    await page.getByRole('button',{name:'Associer ce navigateur'}).click();
    await page.getByRole('status').filter({hasText:'Code enregistré'}).waitFor();
    assert.equal(await page.getByLabel('Code d’association Ludy').inputValue(),'');
    assert.equal(await page.getByRole('button',{name:'Démarrer la lecture'}).isEnabled(),true);
    await page.getByRole('button',{name:'Effacer l’association'}).click();
    await page.getByRole('status').filter({hasText:'Association locale effacée'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Démarrer la lecture'}).isEnabled(),false);
  }finally{await context.close();}
});

test('network loss, visible reconnection and a loading region do not reconfirm stale states',async()=>{
 await withPage(cards(),async page=>{
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{value:false,configurable:true}));let result=await read(page);assert.equal(result.status,'error');assert.deepEqual(result.rows,[]);
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{value:true,configurable:true}));
  await page.locator('#panel').evaluate(p=>p.setAttribute('aria-busy','true'));result=await read(page);assert.equal(result.status,'error');assert.deepEqual(result.rows,[]);
  await page.locator('#panel').evaluate(p=>p.removeAttribute('aria-busy'));
  await page.evaluate(()=>{const alert=document.createElement('p');alert.setAttribute('role','alert');alert.textContent='Connexion perdue. Reconnexion en cours.';document.body.prepend(alert);});
  result=await read(page);assert.equal(result.status,'error');assert.deepEqual(result.rows,[]);
  await page.locator('[role="alert"]').evaluate(p=>p.style.display='none');result=await read(page);assert.equal(result.status,'observing');assert.equal(result.rows.length,4,'hidden notices cannot block the visible valid list');
 });
});

test('contradictory dot semantics are unknown and cannot create a false offline observation',async()=>{
 await withPage(cards(),async page=>{
  await page.locator('.dot').first().evaluate(e=>e.setAttribute('aria-label','Offline'));
  let result=await read(page);assert.equal(result.rows[0].state,'unknown');assert.ok(result.warnings.some(w=>w.includes('contradictoires')));
  await page.locator('.dot').last().evaluate(e=>{e.setAttribute('aria-label','Offline');e.setAttribute('title','Disponible');});
  result=await read(page);assert.equal(result.rows.at(-1).state,'unknown');assert.equal(result.rows.some(r=>r.state==='offline'),false);
 });
});
