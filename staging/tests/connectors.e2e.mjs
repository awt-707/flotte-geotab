// Local login only. Every fleet response is fictional; no connector or pairing mutation reaches a server.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {assertLocalProject} from '../scripts/guard.mjs';
assertLocalProject();
const credentials=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
assert.equal(credentials.environment,'staging-local-only');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const errors=[],mutations=[],myclicarBodies=[],unexpectedRoutes=[],externalRequests=[],blockedWrites=[];let checks=0,teksatReads=0,teksatRefreshes=0;
const at=()=>new Date().toISOString();
const bolt={id:'bolt',configured:true,status:'paused',auto_resume:false,polling:false,interval_s:60,last_success_at:at()};
const geotab={id:'geotab',configured:true,status:'paused',auto_resume:false,polling:false,interval_s:2,database:'test',userName:'test@example.invalid',vehicles:[{key:'fixture',plate:'TEST-A',model:'Test',geotab_id:'test-device'}],devices:[{id:'test-device',name:'Test',plate:'TEST-A'}],last_success_at:at()};
const uber={id:'uber',configured:true,status:'healthy',last_success_at:at(),coverage:{drivers:1}};
const myclicar={id:'myclicar',configured:true,httpConfigured:true,email:'test@example.invalid',httpUsername:'synthetic-http-user',status:'paused',auto_resume:false,polling:false,interval_s:60,last_success_at:at(),coverage:{contracts:12,active_contracts:4,matched_assignments:3,unmatched_contracts:9}};
const teksat={provider:'Teksat',source:'texat',configured:true,connection:'verified',lifecycle:'ready',lastSuccessAt:at(),activeFailover:false,
 collectionEnabled:true,archiveEnabled:true,coverage:{positionsReturned:8},rawArchive:{collectionRunning:true,entries:16,mappedVehicles:8,
 bytes:16384,maxBytes:536870912,pending:0,lastSave:at(),full:false,warning:null,stoppedReason:null}};
const shots=new URL('../.local/validation/texat-ui/',import.meta.url);await fs.mkdir(shots,{recursive:true,mode:0o700});await fs.chmod(shots,0o700);
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'fr-FR'});page.on('pageerror',e=>errors.push(e.message));
  const shot=async name=>{if(page.viewportSize().width<800)await page.waitForFunction(()=>document.querySelector('.side')?.getBoundingClientRect().right<=1);
    const target=new URL(name+'.png',shots);await page.locator('.texat-connector').screenshot({path:target.pathname});await fs.chmod(target,0o600);};
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),method=route.request().method();
    if(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&['4173','57421'].includes(url.port)){
      if(url.pathname==='/rest/v1/rpc/session_ping')return route.fulfill({json:null});
      if(['/rest/v1/rpc/shift_plan','/rest/v1/rpc/usage_stats'].includes(url.pathname))return route.fulfill({json:[]});
      if(!['GET','HEAD','OPTIONS'].includes(method)&&url.pathname!=='/auth/v1/token'){
        blockedWrites.push(method+' '+url.pathname);return route.abort('blockedbyclient');
      }
      return route.continue();
    }
    externalRequests.push(url.origin+url.pathname);return route.abort('blockedbyclient');
  });
  await page.route('**/api/fleet/**',async route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/fleet/',''),method=route.request().method();
    if(method==='POST')mutations.push(path);
    if(path==='disconnections'&&method==='GET')return route.fulfill({json:{at:at(),enabled:false,policy:'any',duty_mode:'contract',coverage:{expected_drivers:0},warnings:[],alerts:[]}});
    if(path==='overview')return route.fulfill({json:{sources:[bolt,geotab,uber,myclicar],drivers:[],alerts:[],settings:{offline_threshold_s:300,enabled:true}}});
    if(path==='bolt/config'&&method==='GET')return route.fulfill({json:{configured:true}});
    if(path==='geotab/live')return route.fulfill({json:{source:{status:geotab.status},vehicles:[],events:[],telemetry:{},motion_alerts:[],motion_coverage:{linked_drivers:2,unassigned_drivers:1}}});
    if(path==='validation/status')return route.fulfill({json:{status:'not_started',interval_s:60,duration_h:24}});
    if(path==='geotab/status')return route.fulfill({json:geotab});
    if(path==='myclicar/status'&&method==='GET')return route.fulfill({json:myclicar});
    if(path==='texat/status'&&method==='GET'){teksatReads++;return route.fulfill({json:teksat});}
    if(path==='texat/refresh'&&method==='POST'){assert.deepEqual(route.request().postDataJSON(),{});teksatRefreshes++;
      teksat.lastSuccessAt=at();teksat.rawArchive.entries+=8;teksat.rawArchive.lastSave=at();return route.fulfill({json:teksat});}
    if(path==='myclicar/connect'&&method==='POST'){const body=route.request().postDataJSON();myclicarBodies.push(body);Object.assign(myclicar,{email:body.email,httpUsername:body.httpUsername});return route.fulfill({json:myclicar});}
    if(path==='myclicar/start'&&method==='POST'){Object.assign(myclicar,{status:'healthy',auto_resume:true,polling:true,next_attempt_at:new Date(Date.now()+60000).toISOString()});return route.fulfill({json:myclicar});}
    if(path==='myclicar/stop'&&method==='POST'){Object.assign(myclicar,{status:'paused',auto_resume:false,polling:false,next_attempt_at:null});return route.fulfill({json:myclicar});}
    if(path==='bolt/start'){Object.assign(bolt,{status:'error',auto_resume:true,polling:true,retrying:true,next_attempt_at:new Date(Date.now()+60000).toISOString(),last_error:'Quota temporaire de test'});return route.fulfill({json:{ok:true}});}
    if(path==='bolt/stop'){Object.assign(bolt,{status:'paused',auto_resume:false,polling:false,retrying:false,next_attempt_at:null});return route.fulfill({json:{ok:true}});}
    if(path==='geotab/start'){Object.assign(geotab,{status:'healthy',auto_resume:true,polling:true,next_attempt_at:at()});return route.fulfill({json:geotab});}
    if(path==='geotab/stop'){Object.assign(geotab,{status:'paused',auto_resume:false,polling:false,next_attempt_at:null});return route.fulfill({json:geotab});}
    unexpectedRoutes.push(method+' '+path);return route.fulfill({status:409,json:{error:'Unexpected fixture route'}});
  });
  await page.goto('http://127.0.0.1:4173');await page.locator('#le').fill(credentials.email);await page.locator('#lp').fill(credentials.password);await page.locator('button[type="submit"]').click();await page.locator('#fleet-search').waitFor();
  await page.goto('http://127.0.0.1:4173/#/connecteurs');await page.locator('#geotab-automation .connector-automation').waitFor();
  await page.locator('#texat-health').filter({hasText:'Accès vérifié'}).waitFor();
  assert.ok(teksatReads>0);assert.equal(teksatRefreshes,0);assert.match(await page.locator('#texat-summary').innerText(),/8 positions reçues · 8 véhicules associés/);
  assert.match(await page.locator('#texat-archive').innerText(),/Conservation automatique active · 16 observations conservées/);
  assert.equal(await page.locator('#texat-warning').innerText(),'');assert.equal(await page.locator('#texat-refresh').isEnabled(),true);checks+=6;
  assert.match(await page.locator('.texat-connector').innerText(),/basculement automatique attend la confirmation du fuseau/);checks++;
  await shot('synthetic-desktop');
  await page.locator('#texat-refresh').click();await page.locator('#texat-result').filter({hasText:'Lecture Teksat vérifiée.'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#texat-refresh')?.disabled===false);
  assert.equal(teksatRefreshes,1);assert.match(await page.locator('#texat-archive').innerText(),/24 observations conservées/);checks+=2;
  assert.match(await page.locator('#bolt-automation').innerText(),/Pause conservée au redémarrage/);assert.equal(await page.locator('#bolt-stop').isVisible(),false);checks+=2;
  await page.locator('#bolt-refresh').click();await page.locator('#bolt-automation [data-state="retrying"]').waitFor();
  assert.match(await page.locator('#bolt-automation').innerText(),/Nouvel essai/);assert.match(await page.locator('#bolt-automation').innerText(),/Quota temporaire de test/);assert.equal(await page.locator('#bolt-refresh').isVisible(),false);assert.equal(await page.locator('#bolt-stop').isVisible(),true);checks+=4;
  await page.locator('#bolt-stop').click();await page.locator('#bolt-automation [data-state="paused"]').waitFor();assert.doesNotMatch(await page.locator('#bolt-automation').innerText(),/Quota temporaire de test|Nouvel essai/);checks++;
  await page.locator('#geotab-start').click();await page.locator('#geotab-automation [data-state="active"]').waitFor();assert.match(await page.locator('#geotab-automation').innerText(),/Reprise automatique après/);assert.equal(await page.locator('#geotab-start').isVisible(),false);checks+=2;
  await page.goto('http://127.0.0.1:4173/#/cockpit');await page.locator('#fleet-search').waitFor();await page.goto('http://127.0.0.1:4173/#/connecteurs');await page.locator('#geotab-automation [data-state="active"]').waitFor();assert.equal(await page.locator('#geotab-stop').isVisible(),true);assert.match(await page.locator('#bolt-automation').innerText(),/Pause conservée au redémarrage/);checks+=2;
  await page.locator('#geotab-stop').click();await page.locator('#geotab-automation [data-state="paused"]').waitFor();assert.equal(await page.locator('#geotab-start').isVisible(),true);checks++;
  await page.locator('#myclicar-automation [data-state="paused"]').waitFor();
  for(const id of ['myclicar-password','myclicar-http-password']){
    const input=page.locator('#'+id);assert.equal(await input.getAttribute('type'),'password');assert.equal(await input.getAttribute('autocomplete'),'off');assert.equal(await input.inputValue(),'');assert.equal(await input.evaluate(el=>el.required),false);checks+=4;
  }
  assert.equal(await page.locator('#myclicar-email').inputValue(),'test@example.invalid');assert.equal(await page.locator('#myclicar-http-user').inputValue(),'synthetic-http-user');assert.match(await page.locator('#myclicar-summary').innerText(),/12 contrats lus · 4 actifs · 3 affectations rapprochées · 9 contrats à rapprocher/);assert.match(await page.locator('#myclicar-summary').innerText(),/Dernière lecture/);checks+=4;
  await page.locator('#myclicar-connect button').click();await page.locator('#myclicar-result').filter({hasText:'Accès vérifiés et enregistrés'}).waitFor();
  assert.deepEqual(myclicarBodies[0],{email:'test@example.invalid',httpUsername:'synthetic-http-user'});assert.match(await page.locator('#myclicar-automation').innerText(),/Pause conservée au redémarrage/);checks+=2;
  await page.locator('#myclicar-password').fill('synthetic-app-password');await page.locator('#myclicar-http-password').fill('synthetic-http-password');
  const saved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/fleet/myclicar/connect');await page.locator('#myclicar-connect button').click();await saved;await page.locator('#myclicar-result').filter({hasText:'Accès vérifiés et enregistrés'}).waitFor();
  assert.deepEqual(myclicarBodies[1],{email:'test@example.invalid',httpUsername:'synthetic-http-user',password:'synthetic-app-password',httpPassword:'synthetic-http-password'});assert.equal(await page.locator('#myclicar-password').inputValue(),'');assert.equal(await page.locator('#myclicar-http-password').inputValue(),'');checks+=3;
  await page.locator('#myclicar-start').click();await page.locator('#myclicar-automation [data-state="active"]').waitFor();assert.match(await page.locator('#myclicar-automation').innerText(),/Reprise automatique après/);assert.match(await page.locator('#myclicar-automation').innerText(),/Cadence cible : 60 s/);assert.equal(await page.locator('#myclicar-start').isVisible(),false);assert.equal(await page.locator('#myclicar-stop').isVisible(),true);checks+=4;
  await page.goto('http://127.0.0.1:4173/#/cockpit');await page.locator('#fleet-search').waitFor();await page.goto('http://127.0.0.1:4173/#/connecteurs');await page.locator('#myclicar-automation [data-state="active"]').waitFor();assert.equal(await page.locator('#myclicar-password').inputValue(),'');assert.equal(await page.locator('#myclicar-http-password').inputValue(),'');checks+=2;
  await page.locator('#myclicar-stop').click();await page.locator('#myclicar-automation [data-state="paused"]').waitFor();assert.equal(await page.locator('#myclicar-start').isVisible(),true);assert.equal(await page.locator('#myclicar-stop').isVisible(),false);assert.match(await page.locator('#myclicar-automation').innerText(),/Pause conservée au redémarrage/);checks+=3;
  const surveillance=await page.locator('.connector-surveillance').innerText();assert.match(surveillance,/Uber et Bolt/);assert.match(surveillance,/Une activité récente sur Uber ou Bolt exclut l’alerte/);assert.match(surveillance,/donnée de plateforme manquante ou ancienne suspend la surveillance/);assert.match(await page.locator('.connector-rules').innerText(),/200 m est indépendante/);assert.match(await page.locator('#uber-summary').innerText(),/Lecture active/);checks+=5;
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks++;
  await shot('synthetic-mobile');
  Object.assign(teksat,{connection:'error',collectionEnabled:false,archiveEnabled:false});
  Object.assign(teksat.rawArchive,{collectionRunning:false,full:true,bytes:teksat.rawArchive.maxBytes,stoppedReason:'teksat_archive_full'});
  Object.assign(geotab,{automation_error:'Reprise automatique indisponible',status:'error'});
  await page.goto('http://127.0.0.1:4173/#/cockpit');await page.locator('#fleet-search').waitFor();await page.goto('http://127.0.0.1:4173/#/connecteurs');await page.locator('#geotab-health').filter({hasText:'Automatisation à vérifier'}).waitFor();assert.match(await page.locator('#geotab-automation').innerText(),/Reprise automatique indisponible/);checks++;
  await page.locator('#texat-warning').filter({hasText:'Le stockage de l’historique est plein.'}).waitFor();
  assert.match(await page.locator('#texat-warning').innerText(),/collecte est arrêtée et les données existantes sont conservées/);
  assert.match(await page.locator('#texat-archive').innerText(),/Conservation automatique arrêtée · 24 observations conservées/);
  assert.equal(teksatRefreshes,1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks+=4;
  await shot('synthetic-full-mobile');
  assert.deepEqual(mutations,['texat/refresh','bolt/start','bolt/stop','geotab/start','geotab/stop','myclicar/connect','myclicar/connect','myclicar/start','myclicar/stop']);assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRoutes,[]);assert.deepEqual(externalRequests,[]);assert.deepEqual(blockedWrites,[]);checks+=5;
  console.log(JSON.stringify({ok:true,checks,providerRequests:externalRequests.length,realMutations:0,teksatStatusReads:teksatReads,teksatRefreshesSimulated:teksatRefreshes,screenshots:shots.pathname}));
}finally {await browser.close();}
