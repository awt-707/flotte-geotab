// Local UI only; association writes and provider-dependent reads are mocked.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const credentials=JSON.parse(await fs.readFile(new URL('../.local/credentials.json',import.meta.url),'utf8'));
assert.equal(credentials.environment,'staging-local-only');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const driver={id:'12345678-1234-1234-1234-123456789abc',name:'Synthetic Automatic Driver',ludy_driver_code:'SYNTHETIC',auto_link_disabled:false,vehicle_key:null,vehicle_link_method:null,sources:{}};
const submissions=[],errors=[];let blockedMutations=0,checks=0;
try{
 const page=await browser.newPage({viewport:{width:1200,height:1000},locale:'fr-FR'});page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!['127.0.0.1','localhost'].includes(url.hostname))return route.abort();
  if(url.pathname==='/api/fleet/drivers/link'&&request.method()==='POST'){
   const input=request.postDataJSON();submissions.push(input);
   Object.assign(driver,{auto_link_disabled:input.vehicle_mode==='manual',vehicle_link_method:input.vehicle_mode==='manual'?'manual':null,vehicle_key:input.vehicle_key||null});
   return route.fulfill({json:{ok:true,driver_id:driver.id,drivers:[driver],automatic:input.vehicle_mode==='automatic',association_pending:false}});
  }
  if(url.pathname.startsWith('/api/fleet/')&&request.method()!=='GET'){blockedMutations++;return route.abort();}
  if(url.pathname==='/api/fleet/history')return route.fulfill({json:{observations:[],intervals:[]}});
  if(url.pathname==='/rest/v1/drivers')return route.fulfill({json:[{code:'SYNTHETIC',name:driver.name}]});
  if(url.pathname==='/api/fleet/overview')return route.fulfill({json:{sources:[],drivers:[driver],alerts:[],settings:{}}});
  if(/\/api\/fleet\/geotab\/(history|report|detail)/.test(url.pathname))return route.abort();
  return route.continue();
 });
 await page.goto('http://127.0.0.1:4173');await page.locator('#le').fill(credentials.email);await page.locator('#lp').fill(credentials.password);await page.locator('button[type="submit"]').click();await page.locator('#fleet-search').waitFor();
 await page.evaluate(async value=>{await fleetHistory(value,ROUTING);},driver);
 const mode=page.locator('#history-vehicle-mode');await mode.waitFor();
 assert.equal(await mode.inputValue(),'automatic');assert.equal(await page.locator('#history-vehicle').isDisabled(),true);assert.equal(await page.locator('#history-vehicle-label').isVisible(),false);checks+=3;
 await page.locator('#history-link-form button[type="submit"]').click();await page.locator('#history-link-result').getByText(/Association automatique activée/).waitFor();
 assert.equal(submissions.length,1);assert.equal(submissions[0].vehicle_mode,'automatic');assert.equal(Object.hasOwn(submissions[0],'vehicle_key'),false);checks+=3;
 await mode.selectOption('manual');assert.equal(await page.locator('#history-vehicle').isEnabled(),true);assert.equal(await page.locator('#history-vehicle-label').isVisible(),true);checks+=2;
 const car=await page.locator('#history-vehicle option').nth(1).getAttribute('value');assert.ok(car);await page.locator('#history-vehicle').selectOption(car);
 await page.locator('#history-link-form button[type="submit"]').click();await page.locator('#history-link-result').getByText(/associés manuellement/).waitFor();assert.equal(submissions[1].vehicle_mode,'manual');assert.equal(submissions[1].vehicle_key,car);checks+=2;
 await page.locator('#history-close').click();await page.evaluate(async value=>{await fleetHistory(value,ROUTING);},driver);await mode.waitFor();assert.equal(await mode.inputValue(),'manual');checks++;
 await mode.selectOption('automatic');await page.locator('#history-link-form button[type="submit"]').click();await page.locator('#history-link-result').getByText(/Association automatique activée/).waitFor();assert.equal(Object.hasOwn(submissions[2],'vehicle_key'),false);checks++;
 await page.setViewportSize({width:390,height:780});assert.equal(await page.locator('#fleet-history-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);checks++;
 assert.equal(blockedMutations,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks,mockedSaves:submissions.length,realAssociationWrites:0}));
}finally{await browser.close();}
