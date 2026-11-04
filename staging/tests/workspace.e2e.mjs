// Smoke test against the isolated local stack. Credentials and screenshots stay in .local/.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const root = new URL('../.local/', import.meta.url);
const creds = JSON.parse(await fs.readFile(new URL('credentials.json', root), 'utf8'));
assert.equal(creds.environment, 'staging-local-only');
const shots = new URL('screenshots/', root); await fs.mkdir(shots, {recursive:true});
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const errors=[],failed=[],geotab=[],routes=[];
// On an actively used staging, rotating this admin's pairing code stops its Uber collector.
const mutateConnectors=process.env.LUDY_E2E_MUTATIONS==='1';
const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'fr-FR',colorScheme:'light'});
const page = await context.newPage();
const tile=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=','base64');
await context.route('**/*',route=>{
 const url=new URL(route.request().url());
 if(url.hostname==='tile.openstreetmap.org')return route.fulfill({contentType:'image/png',body:tile});
 if(!['127.0.0.1','localhost'].includes(url.hostname))return route.abort();
 if(url.pathname==='/rest/v1/rpc/session_ping')return route.fulfill({json:null});
 return route.continue();
});
page.on('pageerror', e=>errors.push(e.message));
page.on('response', r=>{ if(r.status()>=400 && /127\.0\.0\.1/.test(r.url())) failed.push(r.status()+' '+new URL(r.url()).pathname); });
page.on('request', r=>{if(r.url().includes('/functions/v1/geotab'))geotab.push(new URL(r.url()).pathname);});
async function shot(name){await page.screenshot({path:new URL(name+'.png',shots).pathname,fullPage:true});}
async function overflow(label){const size=await page.evaluate(()=>({body:document.documentElement.scrollWidth,view:innerWidth}));assert.ok(size.body<=size.view+1,label+' horizontal overflow: '+JSON.stringify(size));}
async function visit(route){
  await page.goto('http://127.0.0.1:4173/#/'+route);
  await page.locator('#page').waitFor();
  await page.waitForFunction(()=>document.querySelector('#page')?.innerText.trim() && !document.querySelector('#page')?.innerText.startsWith('Chargement'));
  await page.waitForTimeout(350);
  const problem=await page.locator('#page').innerText();
  assert.ok(!/^Erreur\s*:|^Base inaccessible/.test(problem),route+': '+problem.slice(0,220));
  routes.push(route); return problem;
}
try{
 await page.goto('http://127.0.0.1:4173/');
 await page.locator('#le').fill(creds.email); await page.locator('#lp').fill(creds.password);
 await shot('login-desktop');
 await page.locator('button[type="submit"]').click();
 await page.locator('#fleet-search').waitFor({timeout:30000});
 await page.waitForFunction(()=>document.querySelector('#fleet-read-time')?.textContent.startsWith('Actualisé'));
 await overflow('desktop cockpit'); await shot('cockpit-desktop');
 assert.match(await page.locator('#workspace-title').innerText(),/Vue d’ensemble/);
 await page.keyboard.press('Control+k'); assert.equal(await page.locator('#navq').evaluate(e=>e===document.activeElement),true);
 await page.locator('#navq').fill('contrats'); await page.locator('#navres a').first().waitFor(); await page.locator('#navq').fill('');
 await visit('connecteurs'); await page.locator('#uber-pair').waitFor();
 await page.locator('#geotab-connect').waitFor();
 assert.equal(await page.locator('#geotab-password').getAttribute('type'),'password');
 const geotabState=await page.evaluate(()=>fleetApi('geotab/status'));
 assert.equal('password' in geotabState,false);
 if(mutateConnectors){
   await page.locator('#uber-pair').click();
   await page.waitForFunction(()=>document.querySelector('#uber-pair-code')?.value.startsWith('ludy_uber_'));
   assert.equal(await page.locator('#uber-pair-code').getAttribute('type'),'password');
   await page.locator('#fleet-alert-settings button').click();
   await page.waitForFunction(()=>document.querySelector('#fleet-settings-result')?.textContent.includes('enregistrée'));
 }
 await shot('connecteurs-desktop');
 for(const route of ['direct','tableau','jour','chauffeurs','fiches','alertes','rapports','conduite','comportement','finshift','carburant','conso','ralenti','arrets','contrats','manifeste','courses','caisse','rh','travail','plan','menu','plaques','vehicules','agences','planning','connexions','reglages']) await visit(route);
 await visit('direct'); if(!geotabState.configured)assert.match(await page.locator('#livest').innerText(),/non connecté/); assert.equal(await page.locator('#syncnow').count(),0); assert.deepEqual(geotab,[]);
 await page.setViewportSize({width:390,height:844});
 for(const route of ['cockpit','connecteurs','direct','contrats','plan','caisse','reglages']){
   await visit(route); await overflow('mobile '+route);
   if(['cockpit','connecteurs'].includes(route))await shot(route+'-mobile');
 }
 await page.locator('#workspace-toggle').click();
 assert.equal(await page.locator('#workspace-toggle').getAttribute('aria-expanded'),'true');
 await page.locator('#navq').fill('connecteurs'); await page.locator('#navres a').first().click();
 await page.locator('#uber-pair').waitFor();
 assert.equal(await page.locator('#workspace-toggle').getAttribute('aria-expanded'),'false');
 await page.keyboard.press('Control+k'); await page.keyboard.press('Escape');
 assert.equal(await page.locator('#workspace-toggle').getAttribute('aria-expanded'),'false');
 await visit('cockpit');
 const rows=await page.locator('.driver-history').count();
 if(rows){await page.locator('.driver-history').first().click();await page.locator('#history-content .history-timeline').waitFor();await overflow('mobile history');await shot('history-mobile');await page.evaluate(()=>location.hash='#/connecteurs');await page.locator('#uber-pair').waitFor();assert.equal(await page.locator('#fleet-history-dialog').count(),0);}
 assert.deepEqual(errors,[],'browser errors'); assert.deepEqual(failed,[],'local HTTP errors');
 console.log(JSON.stringify({ok:true,routes:routes.length,desktop:'1440x1000',mobile:'390x844',historyTested:rows>0,screenshots:shots.pathname}));
}catch(e){await shot('failure');console.error(JSON.stringify({errors,failed,route:page.url()}));throw e;}
finally{await browser.close();}
