import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

test('the mobile driver interface exposes only own reports and notifications, with escaped content and no fleet requests',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'}),page=await browser.newPage({viewport:{width:390,height:844}}),calls=[],errors=[];
 const content=Object.fromEntries(await Promise.all(['chauffeur.html','chauffeur.js','chauffeur.css','timezone.js'].map(async file=>[file,await readFile(new URL('../site/'+file,import.meta.url),'utf8')])));
 const state={name:'Synthetic Driver',reports:[],notifications:[]};
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());assert.equal(url.origin,'http://fixture.invalid');
  const file=url.pathname.slice(1);if(content[file])return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:content[file]});
  if(file==='favicon.png')return route.fulfill({status:204});
  assert.ok(url.pathname.startsWith('/api/driver/'),'driver page must not load fleet/admin/Supabase data');calls.push({path:url.pathname,method:request.method(),body:request.postDataJSON()});
  if(url.pathname==='/api/driver/login')return route.fulfill({json:{name:state.name,token:'dps_'+'a'.repeat(43),expires_at:new Date(Date.now()+3600000).toISOString()}});
  if(url.pathname==='/api/driver/me')return route.fulfill({json:state});
  if(url.pathname==='/api/driver/reports'){state.reports.push({id:'report-1',...request.postDataJSON(),status:'pending',admin_note:'',reported_at:new Date().toISOString()});return route.fulfill({status:201,json:{report:state.reports[0]}});}
  if(url.pathname.endsWith('/ack')){state.notifications[0].acknowledged_at=new Date().toISOString();return route.fulfill({json:{ok:true}});}
  if(url.pathname==='/api/driver/logout')return route.fulfill({json:{ok:true}});
  throw Error('Unexpected driver route '+url.pathname);
 });
 try{
  await page.goto('http://fixture.invalid/chauffeur.html');await page.locator('#driver-code').fill('LUDY-'+'a'.repeat(32));await page.locator('#driver-login button').click();await page.locator('#driver-report').waitFor();
  assert.equal(await page.evaluate(()=>typeof window.sb),'undefined');assert.equal(await page.evaluate(()=>typeof window.S),'undefined');
  await page.locator('#driver-place').fill('Synthetic street');await page.locator('#driver-description').fill('<img src=x onerror=bad()> Synthetic traffic');await page.locator('#driver-category').selectOption('traffic');await page.locator('#driver-report button').click();await page.locator('#driver-report-result').filter({hasText:'Signalement envoyé'}).waitFor();
  await page.locator('[data-tab="history"]').click();assert.match(await page.locator('#driver-view').innerText(),/À vérifier par l’équipe/);assert.equal(await page.locator('#driver-view img').count(),0);assert.match(await page.locator('#driver-view').innerText(),/<img src=x/);
  state.notifications.push({id:'notification-1',kind:'overconsumption',title:'Consommation élevée',message:'Réduisez les accélérations.',observed_at:new Date().toISOString(),acknowledged_at:null});await page.evaluate(()=>driverRefresh());
  await page.locator('[data-tab="notifications"]').click();assert.match(await page.locator('#driver-view').innerText(),/Consommation élevée/);await page.locator('[data-ack]').click();await page.locator('.driver-status').filter({hasText:'Lu'}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  await page.locator('#driver-logout').click();await page.locator('#driver-login').waitFor();assert.equal(await page.evaluate(()=>sessionStorage.getItem('ludy.driver.session.v1')),null);assert.equal(await page.locator('.driver-tabs').count(),0);assert.doesNotMatch(await page.locator('#driver-content').innerText(),/Synthetic Driver|Consommation élevée/);
  assert.ok(calls.every(call=>call.path.startsWith('/api/driver/')));
 }finally{await browser.close();}
});
