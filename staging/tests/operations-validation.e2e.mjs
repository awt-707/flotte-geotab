// Local authentication only. Every fleet response, including the start action, is fictional.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const credentials=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
assert.equal(credentials.environment,'staging-local-only');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const errors=[],unexpected=[],external=[];
let checks=0,startRequests=0,startFailure=true,statusFailure=false,releaseStart;
let validation={status:'not_started',interval_s:60,duration_h:24};
const running=()=>({status:'running',progress_pct:54.2,observed_hours:13.01,gaps:3,target_at:new Date(Date.now()+11*3600000).toISOString(),confirmed_contradictions:2,real_motion_incident_seen:false,
 sources:Object.fromEntries(['uber','bolt','geotab','myclicar'].map(id=>[id,{availability_pct:98.5,partial_samples:14}])),
 last_error:'Lecture partielle conservée dans le rapport. Vérifiez les interruptions observées avant de conclure sur la stabilité des sources.'});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'fr-FR'});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&['4173','57421'].includes(url.port))return route.continue();
  external.push(url.origin+url.pathname);return route.abort();
 });
 await page.route('**/api/fleet/**',async route=>{
  if(new URL(route.request().url()).pathname==='/api/fleet/disconnections'&&route.request().method()==='GET')return route.fulfill({json:{at:new Date().toISOString(),enabled:false,policy:'any',duty_mode:'contract',coverage:{expected_drivers:0},warnings:[],alerts:[]}});
  const path=new URL(route.request().url()).pathname.replace('/api/fleet/',''),method=route.request().method();
  if(path==='overview'&&method==='GET')return route.fulfill({json:{sources:[],drivers:[],alerts:[],settings:{}}});
  if(path==='geotab/live'&&method==='GET')return route.fulfill({json:{source:{status:'not_configured'},vehicles:[],events:[],telemetry:{},motion_alerts:[]}});
  if(['geotab/status','myclicar/status'].includes(path)&&method==='GET')return route.fulfill({json:{configured:false,status:'not_configured',devices:[],vehicles:[]}});
  if(path==='validation/status'&&method==='GET')return statusFailure?route.fulfill({status:503,json:{error:'Synthetic unavailable status'}}):route.fulfill({json:validation});
  if(path==='validation/start'&&method==='POST'){
   startRequests++;
   if(startFailure)return route.fulfill({status:503,json:{error:'Démarrage de test momentanément indisponible.'}});
   await new Promise(resolve=>{releaseStart=resolve;});validation=running();return route.fulfill({json:validation});
  }
  unexpected.push(method+' '+path);return route.fulfill({status:409,json:{error:'Unexpected fixture route'}});
 });
 await page.goto('http://127.0.0.1:4173');await page.locator('#le').fill(credentials.email);await page.locator('#lp').fill(credentials.password);await page.locator('button[type="submit"]').click();await page.locator('#fleet-search').waitFor();
 const visit=async()=>{await page.goto('http://127.0.0.1:4173/#/cockpit');await page.locator('#fleet-search').waitFor();await page.goto('http://127.0.0.1:4173/#/connecteurs');};
 await visit();await page.locator('#validation-summary').filter({hasText:'Observation pas encore démarrée.'}).waitFor();
 const start=page.getByRole('button',{name:'Démarrer les 24 heures',exact:true});
 assert.equal(await start.isVisible(),true);assert.equal(await page.locator('#validation-summary').getAttribute('role'),'status');checks+=2;
 await start.click();await page.locator('#validation-summary').filter({hasText:'Démarrage de test momentanément indisponible.'}).waitFor();assert.equal(await start.isEnabled(),true);checks++;
 startFailure=false;await start.click();assert.equal(await start.isEnabled(),false);checks++;
 while(!releaseStart)await new Promise(resolve=>setTimeout(resolve,10));releaseStart();
 await page.locator('#validation-summary').filter({hasText:'Observation en cours'}).waitFor();
 assert.equal(await start.isVisible(),false);assert.match(await page.locator('#validation-summary').innerText(),/54\.2%.*13\.01 h observées.*3 interruption/);assert.match(await page.locator('#validation-summary').innerText(),/Incohérences persistantes à examiner : 2/);checks+=3;
 assert.equal(await page.locator('#validation-sources b').count(),4);assert.match(await page.locator('#validation-sources').innerText(),/14 lecture\(s\) partielle\(s\)/);assert.match(await page.locator('#validation-incidents').innerText(),/Aucun nouvel incident réel.*scénarios automatisés ne remplacent pas/);checks+=3;
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'connectors overflow at '+width);checks++;}
 validation={...running(),status:'completed',progress_pct:100,observed_hours:24,real_motion_incident_seen:true,last_error:null};
 await visit();await page.locator('#validation-summary').filter({hasText:'Collecte terminée, rapport à examiner'}).waitFor();assert.equal(await start.isVisible(),false);assert.match(await page.locator('#validation-incidents').innerText(),/Un incident réel de déplacement a été observé/);checks+=2;
 statusFailure=true;await visit();await page.locator('#validation-summary').filter({hasText:'Rapport de stabilité momentanément indisponible.'}).waitFor();assert.equal(await start.isVisible(),false);checks++;
 assert.equal(startRequests,2);assert.deepEqual(unexpected,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);checks+=4;
 console.log(JSON.stringify({ok:true,checks,viewports:[1440,390,320],providerRequests:0,realMutations:0,syntheticStarts:startRequests}));
}finally{await browser.close();}
