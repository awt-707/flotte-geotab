import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {createWebHttpServer} from '../web-runtime/server.mjs';

// The browser sees the real server's bytes and security headers at a synthetic
// HTTPS origin. Only the transport and external Supabase replies are fixtures.
test('web server assets and CSP allow the existing login, recovery and personal session UI',{timeout:60000},async t=>{
 const config={environment:'production',projectRef:'abcdefghijklmnopqrst',supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_synthetic_fixture',webOrigin:'https://ludy.example.invalid'};
 const server=createWebHttpServer({config,runtimeRoot:fileURLToPath(new URL('..',import.meta.url)),services:{async handle(){throw Error('Pending accounts must not request fleet APIs');}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const port=server.address().port,assets=[],auth=[],errors=[];
 function requestBackend(request){return new Promise((resolve,reject)=>{
  const url=new URL(request.url()),headers={...request.headers(),host:new URL(config.webOrigin).host};delete headers['accept-encoding'];
  const req=http.request({hostname:'127.0.0.1',port,path:url.pathname+url.search,method:request.method(),headers,agent:false},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);req.end(request.postDataBuffer());
 });}
 const executablePath=process.env.LUDY_TEST_CHROMIUM||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:!(process.platform==='linux'&&process.getuid?.()===0)});t.after(()=>browser.close());
 const context=await browser.newContext();await context.routeWebSocket('**/*',ws=>ws.close());
 await context.addInitScript(()=>{window.cspViolations=[];document.addEventListener('securitypolicyviolation',event=>window.cspViolations.push({directive:event.violatedDirective,blocked:event.blockedURI}));});
 const user={id:'33333333-3333-4333-8333-333333333333',email:'synthetic@example.invalid',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const accessToken=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'})+'.synthetic-signature';
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===config.supabaseUrl){
   auth.push({path:url.pathname,query:url.search,method:request.method()});
   if(url.pathname==='/auth/v1/recover')return route.fulfill({json:{}});
   if(url.pathname==='/auth/v1/token')return route.fulfill({json:{access_token:accessToken,refresh_token:'synthetic-refresh',expires_in:3600,token_type:'bearer',user}});
   if(url.pathname==='/auth/v1/logout'){assert.equal(url.searchParams.get('scope'),'local');return route.fulfill({status:204});}
   if(url.pathname==='/rest/v1/profiles')return route.fulfill({json:[]});
   assert.fail('Unexpected external request: '+url.pathname);
  }
  assert.equal(url.origin,config.webOrigin,'no unmocked external service is used');
  const response=await requestBackend(request),headers={...response.headers};delete headers.connection;delete headers['keep-alive'];delete headers['transfer-encoding'];delete headers['content-length'];
  assets.push({path:url.pathname,status:response.status,csp:headers['content-security-policy']});
  await route.fulfill({...response,headers});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(config.webOrigin+'/',{waitUntil:'domcontentloaded'});await page.locator('#lf').waitFor();await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.title(),'Ludy · Fleet workspace');assert.equal(await page.locator('.login-note').innerText(),'Production · Données partagées');
 assert.equal(await page.evaluate(()=>typeof desktopWorkerSessionChanged),'undefined');assert.equal(await page.evaluate(()=>typeof window.createDesktopAuthRefresh),'undefined');
 assert.ok(assets.some(item=>item.path==='/vendor/supabase.js'&&item.status===200));assert.ok(assets.some(item=>item.path.endsWith('.woff2')&&item.status===200));
 assert.ok(assets.every(item=>item.status<400||item.path==='/build.txt'||item.path==='/favicon.ico'),JSON.stringify(assets.filter(item=>item.status>=400)));
 assert.ok(assets.every(item=>item.csp?.includes("script-src 'self'")));assert.ok(!assets.some(item=>/desktop-(worker|auth)\.js/.test(item.path)));
 // Real CSP permits Auth's direct project connection and keeps recovery on the web origin.
 await page.locator('#le').fill(user.email);await page.locator('#lforgot').click();await page.waitForFunction(()=>document.querySelector('#lmsg').textContent.includes('réinitialisation sera envoyé'));
 assert.ok(auth.some(item=>item.path==='/auth/v1/recover'&&new URLSearchParams(item.query).get('redirect_to')===config.webOrigin+'/'));
 await page.locator('#lp').fill('synthetic-password');await page.locator('#lf button').click();await page.locator('#lout').waitFor();
 assert.match(await page.locator('#app').innerText(),/validé par l.administrateur/);
 await page.locator('#lout').click();await page.locator('#lf').waitFor();
 assert.equal(auth.filter(item=>item.path==='/auth/v1/logout').length,1);
 assert.deepEqual(await page.evaluate(()=>window.cspViolations),[]);assert.deepEqual(errors,[]);
});
