import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

test('report settings require an explicit CSV timezone, show the actual Moroccan dates, and stay read-only when shared',async t=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors=[],submitted=[];page.on('pageerror',error=>errors.push(error.message));
 const fixture={settings:{enabled:true,csv_timezone:null,date_format:'ymd',city_agencies:{}},organizations:[],agencies:[],local_browser:{available:true,active:false},bridge:{start_date:'2026-10-27',end_date:'2026-11-02'},journal:[{report_type:'driver_activity',period_from:'2026-10-26T00:00:00Z',period_to:'2026-11-02T00:00:00Z',counts:{period_lag_days:1,driver_outside_request_period:3},created_at:'2026-11-03T00:00:00Z'}]};
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!=='http://reports.test')return route.abort();
  if(url.pathname==='/api/uber-reports/settings'){if(route.request().method()==='POST')submitted.push(route.request().postDataJSON());return route.fulfill({json:fixture});}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><main id="page"></main>'});
  return route.abort();
 });
 await page.goto('http://reports.test/');
 await page.evaluate(()=>{window.CFG={SHARED_STAGING:false};window.ROUTING=1;window.S={session:{user:{id:'synthetic-user'},access_token:'synthetic-token'}};window.isAdmin=()=>true;window.fmtDT=value=>String(value);window.esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');});
 await page.addScriptTag({content:await readFile(new URL('../site/timezone.js',import.meta.url),'utf8')});
 await page.addScriptTag({content:await readFile(new URL('../site/uber-reports.js',import.meta.url),'utf8')});await page.evaluate(()=>pageUberReports());
 assert.equal(await page.locator('#uber-reports-timezone').inputValue(),'');
 assert.match(await page.locator('tbody').innerText(),/26\/10\/2026 → 01\/11\/2026/);
 assert.match(await page.locator('tbody').innerText(),/Décalage de disponibilité Uber : 1 jour/);
 await page.locator('#uber-reports-timezone').selectOption('UTC');await page.getByRole('button',{name:'Enregistrer',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#uber-reports-result').textContent.startsWith('Réglages enregistrés'));
 assert.equal(submitted.length,1);assert.equal(submitted[0].csv_timezone,'UTC');
 await page.evaluate(()=>{CFG.SHARED_STAGING=true;return pageUberReports();});
 assert.equal(await page.locator('#uber-reports-timezone').isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Enregistrer',exact:true}).isDisabled(),true);
 assert.match(await page.locator('.uber-reports-local').innerText(),/serveur de staging/);assert.deepEqual(errors,[]);
 await page.evaluate(()=>{CFG.SHARED_STAGING=false;CFG.DESKTOP_PRODUCTION=true;return pageUberReports();});
 assert.match(await page.locator('.uber-reports-local').innerText(),/Connecter Uber/);
 assert.doesNotMatch(await page.locator('.uber-reports-local').innerText(),/npm|terminal|staging\/\.local/);
 assert.equal(await page.locator('.uber-reports-local a').getAttribute('href'),'#/application');
});
