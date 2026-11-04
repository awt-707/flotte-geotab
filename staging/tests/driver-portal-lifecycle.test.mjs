import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
let browser;const files=Object.fromEntries(await Promise.all(['chauffeur.html','chauffeur.js','chauffeur.css','timezone.js'].map(async file=>[file,await readFile(new URL('../site/'+file,import.meta.url),'utf8')])));
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});after(async()=>browser?.close());
async function fixture(work){
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],calls=[],state={user:'a',holdMe:false,held:null,logoutFails:false,holdReport:false,reportHeld:null};
 page.on('pageerror',e=>errors.push(e.message));
 const data=user=>({name:'Synthetic '+user,reports:[],notifications:user==='a'?[{id:'private-alert-a',title:'Personal A',message:'Message for A only',observed_at:'2026-11-02T18:00:00Z',acknowledged_at:null}]:[]});
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());assert.equal(u.origin,'http://driver.invalid');const file=u.pathname.slice(1);
  if(files[file])return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:files[file]});
  if(file==='favicon.png')return route.fulfill({status:204});
  const token=req.headers().authorization?.slice(7),user=token?.endsWith('b')?'b':'a';calls.push({path:u.pathname,method:req.method(),body:req.postDataJSON(),user});
  if(u.pathname==='/api/driver/login')return route.fulfill({json:{name:'Synthetic '+state.user,token:'dps_'+state.user.repeat(43),expires_at:new Date(Date.now()+3600000).toISOString()}});
  if(u.pathname==='/api/driver/me'){if(state.holdMe){state.holdMe=false;state.held=route;return;}return route.fulfill({json:data(user)});}
  if(u.pathname==='/api/driver/logout')return route.fulfill({status:state.logoutFails?503:200,json:state.logoutFails?{error:'Unavailable'}:{ok:true}});
  if(u.pathname==='/api/driver/reports'){if(state.holdReport){state.reportHeld=route;return;}return route.fulfill({status:201,json:{ok:true}});}
  throw Error('Unexpected route '+u.pathname);
 });
 await page.goto('http://driver.invalid/chauffeur.html');await page.clock.install();
 async function login(){await page.locator('#driver-code').fill('synthetic');await page.locator('#driver-login button').click();await page.locator('#driver-report').waitFor();}
 try{await login();await work({page,state,calls,login,data});assert.deepEqual(errors,[]);}finally{await page.close();}
}
test('driver logout clears personal notices immediately and handles revocation failure without an unhandled error',async()=>{
 await fixture(async({page,state})=>{assert.match(await page.locator('#driver-live').textContent(),/Message for A/);state.logoutFails=true;await page.locator('#driver-logout').click();await page.locator('#driver-login').waitFor();assert.equal(await page.locator('#driver-live').textContent(),'');assert.equal(await page.evaluate(()=>DRIVER_PORTAL.timer),null);await page.locator('#driver-login-error').filter({hasText:'révocation distante'}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/Message for A|Personal A/);});
});
test('a pending old session read cannot delay the next login or populate another driver screen',async()=>{
 await fixture(async({page,state,login,data,calls})=>{state.holdMe=true;await page.evaluate(()=>{void driverRefresh();});await page.waitForFunction(()=>DRIVER_PORTAL.busy);while(!state.held)await new Promise(r=>setTimeout(r,5));await page.locator('#driver-logout').click();state.user='b';await login();assert.match(await page.locator('.driver-topline').innerText(),/Synthetic b/);assert.ok(calls.some(c=>c.path==='/api/driver/me'&&c.user==='b'));await state.held.fulfill({json:data('a')}).catch(()=>{});assert.doesNotMatch(await page.locator('body').innerText(),/Synthetic a|Message for A|Personal A/);assert.equal(await page.evaluate(()=>DRIVER_PORTAL.busy),false);});
});
test('driver report drafts survive tab changes and polling but are erased when the session closes',async()=>{
 await fixture(async({page,login,state})=>{await page.locator('#driver-place').fill('Draft address');await page.locator('#driver-description').fill('Draft detail to keep');await page.locator('#driver-category').selectOption('traffic');await page.locator('[data-tab="notifications"]').click();await page.locator('[data-tab="report"]').click();assert.equal(await page.locator('#driver-place').inputValue(),'Draft address');assert.equal(await page.locator('#driver-description').inputValue(),'Draft detail to keep');assert.equal(await page.locator('#driver-category').inputValue(),'traffic');await page.clock.fastForward(10001);assert.equal(await page.locator('#driver-place').inputValue(),'Draft address');await page.locator('#driver-logout').click();state.user='b';await login();assert.equal(await page.locator('#driver-place').inputValue(),'');assert.equal(await page.locator('#driver-description').inputValue(),'');});
});
test('a report in flight cannot be submitted twice after navigating away and back',async()=>{
 await fixture(async({page,state,calls})=>{await page.locator('#driver-place').fill('Test address');await page.locator('#driver-description').fill('Test description');state.holdReport=true;await page.locator('#driver-report button').click();await page.locator('[data-tab="history"]').click();await page.locator('[data-tab="report"]').click();assert.equal(await page.locator('#driver-report button').isDisabled(),true);assert.equal(calls.filter(c=>c.path==='/api/driver/reports').length,1);await state.reportHeld.fulfill({status:201,json:{ok:true}});await page.locator('#driver-report-result').filter({hasText:'Signalement envoyé'}).waitFor();assert.equal(await page.locator('#driver-place').inputValue(),'');assert.equal(await page.locator('#driver-report button').isDisabled(),false);});
});
