import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';

const app=await readFile(new URL('../site/app.js',import.meta.url),'utf8');
const project='abcdefghijklmnopqrst',origin='https://ludy.example.invalid';
const config={WEB_PRODUCTION:true,WEB_ORIGIN:origin,DESKTOP_PRODUCTION:false,STAGING:false,ENVIRONMENT:'production',GEOTAB_LOCAL:true,SUPABASE_PROJECT_REF:project,SUPABASE_URL:`https://${project}.supabase.co`,SUPABASE_ANON_KEY:'synthetic-public-key',AUTH_STORAGE_KEY:`ludy-web-production-${project}-auth`};

test('web production requires its exact HTTPS origin, project and distinct storage key',()=>{
 const guard=app.slice(0,app.indexOf('const S ='));
 const run=(cfg=config,webOrigin=origin)=>{const calls=[],context=vm.createContext({window:{FLOTTE_CONFIG:cfg,supabase:{createClient:(url,key,options)=>{calls.push({url,key,options});return {};}}},location:{origin:webOrigin,protocol:new URL(webOrigin).protocol},document:{getElementById:()=>({textContent:''})},cacheFetch:()=>()=>{}});vm.runInContext(guard,context);return calls;};
 const [client]=run();assert.equal(client.url,config.SUPABASE_URL);assert.equal(client.options.auth.storageKey,config.AUTH_STORAGE_KEY);assert.equal(client.options.auth.autoRefreshToken,true);
 for(const cfg of [{...config,WEB_ORIGIN:origin+'/'},{...config,WEB_ORIGIN:origin+'/path'},{...config,DESKTOP_PRODUCTION:true},{...config,STAGING:true},{...config,ENVIRONMENT:'staging'},{...config,SUPABASE_URL:'https://other.supabase.co'},{...config,AUTH_STORAGE_KEY:`ludy-production-${project}-auth`},{...config,AUTH_STORAGE_KEY:'ludy-staging-auth'},{...config,SUPABASE_PROJECT_REF:'bad'}])assert.throws(()=>run(cfg),/refuse toute connexion/);
 assert.throws(()=>run(config,'https://other.example.invalid'),/refuse toute connexion/);
 assert.throws(()=>run({...config,WEB_ORIGIN:'http://ludy.example.invalid'},'http://ludy.example.invalid'),/refuse toute connexion/);
 assert.throws(()=>run({...config,STAGING:true,DESKTOP_PRODUCTION:false,SUPABASE_URL:'http://127.0.0.1:57421'}),/refuse toute connexion/);
});

test('web refuses the desktop worker even if conflicting flags are injected',async()=>{
 const source=await readFile(new URL('../site/desktop-worker.js',import.meta.url),'utf8');
 for(const desktop of [false,true]){
  const window={FLOTTE_CONFIG:{...config,DESKTOP_PRODUCTION:desktop}},calls=[];
  const ctx=vm.createContext({window,location:{origin:'http://127.0.0.1:4173'},setTimeout:()=>{throw Error('desktop timer started');},clearTimeout(){},fetch:()=>{calls.push('fetch');},document:{querySelectorAll:()=>[]}});
  vm.runInContext(source,ctx);await window.desktopWorkerSessionChanged({user:{id:'synthetic'},access_token:'synthetic'});window.desktopWorkerMount({admin:true});assert.equal(window.desktopWorkerHtml(),'');assert.deepEqual(calls,[]);
 }
});

const tokens=new Map();
function authSession(id,version=1){
 const user={id,email:id+'@example.invalid',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'};
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const access_token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:id,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),role:'authenticated',aud:'authenticated',version})+'.synthetic-signature';
 const session={access_token,refresh_token:`synthetic-refresh-${id}-${version}`,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user};tokens.set(access_token,session);return session;
}
const mime=name=>name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':'application/octet-stream';
const assetCache=new Map();
async function asset(path){if(!assetCache.has(path))assetCache.set(path,await readFile(new URL(path,import.meta.url)));return assetCache.get(path);}

test('real browser clients keep personal sessions, refresh JWTs and show central data without desktop activity',{timeout:60000},async t=>{
 const executablePath=process.env.LUDY_TEST_CHROMIUM||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:!(process.platform==='linux'&&process.getuid?.()===0)});t.after(()=>browser.close());
 const errors=[],requests=[],reportWrites=[],pages=[],roles=['manager','viewer'],users=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
 let healthFailure=false;
 for(let i=0;i<2;i++){
  const context=await browser.newContext();await context.routeWebSocket('**/*',ws=>ws.close());
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),bearer=request.headers().authorization?.replace(/^Bearer /,'');
   if(url.origin===config.SUPABASE_URL){
    requests.push({i,path:url.pathname,method:request.method(),query:url.search,owner:tokens.get(bearer)?.user.id,version:tokens.get(bearer)?.refresh_token});
    if(url.pathname==='/auth/v1/token'){
     const body=request.postDataJSON();
     if(url.searchParams.get('grant_type')==='refresh_token'){
      assert.match(body.refresh_token,new RegExp(users[i]));return route.fulfill({json:authSession(users[i],2)});
     }
     assert.equal(body.email,users[i]+'@example.invalid');return route.fulfill({json:authSession(users[i])});
    }
    if(url.pathname==='/auth/v1/logout'){assert.equal(url.searchParams.get('scope'),'local');return route.fulfill({status:204});}
    if(url.pathname==='/auth/v1/user')return route.fulfill({json:tokens.get(bearer).user});
    assert.equal(tokens.get(bearer)?.user.id,users[i],'every data request belongs to this browser');
    if(url.pathname==='/rest/v1/profiles')return route.fulfill({json:[{user_id:users[i],email:users[i]+'@example.invalid',role:roles[i],pages:null}]});
    if(url.pathname==='/rest/v1/rpc/hr_me')return route.fulfill({json:null});
    if(url.pathname==='/rest/v1/rpc/usage_stats')return route.fulfill({json:{}});
    if(url.pathname==='/rest/v1/agencies')return route.fulfill({json:[{id:i+1,name:'Agence '+(i+1)}]});
    return route.fulfill({json:[],headers:{'content-range':'0-0/0'}});
   }
   if(url.origin==='https://tile.openstreetmap.org')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')});
   assert.equal(url.origin,origin,'fixtures must never reach a real service');
   if(url.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:'window.FLOTTE_CONFIG='+JSON.stringify(config)});
   if(url.pathname.startsWith('/api/')){
    requests.push({i,path:url.pathname,method:request.method(),owner:tokens.get(bearer)?.user.id,version:tokens.get(bearer)?.refresh_token});
    if(url.pathname==='/api/uber-reports/settings'){
     if(request.method()==='POST')reportWrites.push(request.postDataJSON());
     return route.fulfill({json:{settings:{enabled:true,csv_timezone:'UTC',date_format:'ymd',city_agencies:{}},organizations:[],agencies:[],local_browser:{available:false},bridge:{start_date:'2026-10-27',end_date:'2026-11-02'},journal:[]}});
    }
    assert.equal(request.method(),'GET','consultation never starts or configures a provider');assert.equal(tokens.get(bearer)?.user.id,users[i]);
    assert.ok(!url.pathname.startsWith('/api/desktop'));
    if(url.pathname==='/api/fleet/health')return route.fulfill(healthFailure?{status:503,json:{error:'synthetic-unavailable'}}:{json:{sources:['uber','bolt','geotab','myclicar'].map(id=>({id,status:'healthy',collectionRemote:true,last_success_at:new Date().toISOString(),stale_after_s:120}))}});
    if(url.pathname==='/api/fleet/disconnections')return route.fulfill({json:{alerts:[],enabled:true,policy:'any',duty_mode:'contract'}});
    if(url.pathname==='/api/operations/pauses')return route.fulfill({json:{pauses:[],rush:[],suggestions:[]}});
    if(url.pathname==='/api/parking/alerts')return route.fulfill({json:{alerts:[],parked_vehicles:[]}});
    if(url.pathname==='/api/parking/zones')return route.fulfill({json:{zones:[],agencies:[]}});
    if(url.pathname==='/api/parking/overview')return route.fulfill({json:{vehicles:[],zones:[],events:[],detector:{},source:{}}});
    if(url.pathname==='/api/fleet/overview')return route.fulfill({json:{sources:[],drivers:[],vehicles:[],alerts:[],settings:{}}});
    if(url.pathname==='/api/fleet/alerts')return route.fulfill({json:{events:[],motion_alerts:[],source:{}}});
    if(url.pathname==='/api/fleet/geotab/live')return route.fulfill({json:{vehicles:[],positions:[],source:{status:'healthy'},telemetry:{},events:[],motion_alerts:[]}});
    assert.fail('Unexpected API: '+url.pathname);
   }
   if(url.pathname==='/'){
    let html=(await asset('../site/index.html')).toString().replace(/<script src="\/vendor\/(?:xlsx|jspdf)[^\"]*" defer><\/script>/g,'');
    if(i===1)html=html.replace(/<script src="desktop-(?:auth|worker)\.js"><\/script>/g,'');
    return route.fulfill({contentType:'text/html',body:html});
   }
   const vendor={'/vendor/supabase.js':'../node_modules/@supabase/supabase-js/dist/umd/supabase.js','/vendor/leaflet.js':'../node_modules/leaflet/dist/leaflet.js','/vendor/leaflet.css':'../node_modules/leaflet/dist/leaflet.css'};
   if(url.pathname==='/build.txt')return route.fulfill({body:'synthetic-build'});
   try{return route.fulfill({contentType:mime(url.pathname),body:await asset(vendor[url.pathname]||'../site'+url.pathname)});}catch{return route.fulfill({status:404,body:''});}
  });
  const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await page.goto(origin+'/#/connecteurs');await page.locator('#le').fill(users[i]+'@example.invalid');await page.locator('#lp').fill('synthetic-password');await page.locator('#lf button').click();
  await page.locator('#web-connectors-sources .connector-card').first().waitFor();
  assert.equal(await page.locator('#web-connectors-sources .connector-card').count(),5);assert.match(await page.locator('#page').innerText(),/PC fixe/);
  assert.equal(await page.locator('#page input[type=password],#uber-pair,#geotab-start,#bolt-config-save,.desktop-worker').count(),0);
  assert.equal(await page.evaluate(()=>desktopAuthRefresh),null);assert.equal(await page.evaluate(()=>typeof desktopWorkerHtml==='function'?desktopWorkerHtml():''),'');
  if(i===1)assert.equal(await page.evaluate(()=>typeof window.createDesktopAuthRefresh),'undefined');
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.endsWith('-auth'))),[config.AUTH_STORAGE_KEY]);
  assert.equal(await page.evaluate(()=>S.session.user.id),users[i]);
  assert.equal(await page.locator('a.dlapp').innerText(),'Accès web Ludy');
 }
 assert.deepEqual(errors,[]);
 // An unavailable central status keeps the previous snapshot and never exposes provider errors.
 healthFailure=true;await pages[0].locator('#web-connectors-refresh').click();await pages[0].waitForFunction(()=>document.querySelector('#connect-status').textContent.includes('indisponible'));
 assert.equal(await pages[0].locator('#web-connectors-sources .connector-card').count(),5);assert.doesNotMatch(await pages[0].locator('#page').innerText(),/synthetic-unavailable/);healthFailure=false;
 // The SDK's TOKEN_REFRESHED event updates this app's reads without binding a desktop session.
 await pages[1].evaluate(async()=>{const {error}=await sb.auth.refreshSession();if(error)throw error;});
 await Promise.all([pages[1].waitForResponse(response=>response.url().endsWith('/api/fleet/health')),pages[1].locator('#web-connectors-refresh').click()]);
 assert.equal(requests.filter(r=>r.i===1&&r.path==='/api/fleet/health').at(-1).version,`synthetic-refresh-${users[1]}-2`);
 assert.equal(await pages[0].evaluate(()=>S.session.refresh_token),`synthetic-refresh-${users[0]}-1`);
 await pages[0].locator('#logout').click();await pages[0].locator('#lf').waitFor();
 assert.equal(await pages[0].evaluate(()=>localStorage.getItem(CFG.AUTH_STORAGE_KEY)),null);
 assert.equal(await pages[1].evaluate(()=>S.session.user.id),users[1]);
 await pages[1].reload();await pages[1].locator('#web-connectors-sources .connector-card').first().waitFor();
 assert.equal(await pages[1].evaluate(()=>S.session.user.id),users[1]);
 // Business pages and role rules remain the existing application's navigation.
 const business=await pages[1].evaluate(()=>Object.keys(PAGES));for(const name of ['direct','trajets','bilans','vehicules','performance-chauffeur','demande','caisse','chiffre-affaires','rh','rapports'])assert.ok(business.includes(name));
 assert.equal(await pages[1].evaluate(()=>pageNeedsAdmin('connecteurs')),false);assert.equal(await pages[1].evaluate(()=>pageNeedsAdmin('reglages')),true);
 await pages[1].evaluate(()=>{location.hash='#/application';});await pages[1].getByRole('heading',{name:'Ludy dans votre navigateur'}).waitFor();
 assert.equal(await pages[1].locator('.desktop-worker').count(),0);
 await pages[1].evaluate(()=>{location.hash='#/direct';});await pages[1].locator('.ops-direct').waitFor();assert.equal(await pages[1].evaluate(()=>LIVE_SEC),5);
 await pages[1].waitForFunction(()=>LIVE.at>0&&!LIVE.err);assert.ok(requests.some(r=>r.i===1&&r.path==='/api/fleet/geotab/live'));
 // Central business settings remain editable for an administrator; browser/provider controls are absent.
 await pages[1].evaluate(()=>{S.profile.role='admin';location.hash='#/uber-rapports';});await pages[1].locator('#uber-reports-form').waitFor();
 assert.match(await pages[1].locator('.uber-reports-local').innerText(),/PC fixe/);
 assert.doesNotMatch(await pages[1].locator('#page').innerText(),/npm|Ctrl\+C|Installez|Activer les rapports|Connecter Uber|sur cet ordinateur/);
 await pages[1].getByRole('button',{name:'Enregistrer',exact:true}).click();await pages[1].waitForFunction(()=>document.querySelector('#uber-reports-result').textContent.startsWith('Réglages centraux enregistrés'));
 assert.equal(reportWrites.length,1);assert.equal(reportWrites[0].csv_timezone,'UTC');assert.equal(reportWrites[0].enabled,true);
 await pages[1].evaluate(()=>{location.hash='#/connecteurs';});await pages[1].locator('#web-connectors-sources .connector-card').first().waitFor();
 assert.equal(await pages[1].locator('a[href="#/uber-rapports"]').count()>0,true);assert.equal(await pages[1].locator('#page input').count(),0);
 const beforeRH=requests.length;
 await pages[1].evaluate(()=>{S.profile.role='rh';location.hash='#/application';});await pages[1].getByRole('heading',{name:'Ludy dans votre navigateur'}).waitFor();
 assert.deepEqual(await pages[1].evaluate(()=>({direct:canSee('direct'),connecteurs:canSee('connecteurs'),application:canSee('application')})),{direct:false,connecteurs:false,application:true});
 await pages[1].evaluate(()=>health());assert.equal(requests.slice(beforeRH).some(r=>r.path.startsWith('/api/fleet')||r.path.startsWith('/api/parking')||r.path.startsWith('/api/operations')),false,'RH navigation does not poll fleet APIs');
 assert.equal(requests.some(r=>r.path.startsWith('/api/desktop')),false);assert.deepEqual(errors,[]);
});
