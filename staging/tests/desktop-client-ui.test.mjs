import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

test('desktop shell explains missing configuration, offers safe reconnect, and stays readable in a narrow window',async t=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:750}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const files=new Map([['/','client-ui.html'],['/client-ui.js','client-ui.js'],['/client-ui.css','client-ui.css'],['/logo.png','assets/logo-ludy.png']]);
 let current={state:'missing',appName:'Ludy Staging',server:null,canRetry:false,operatorLocal:false};
 await page.route('**/*',async route=>{const filename=files.get(new URL(route.request().url()).pathname);if(!filename)return route.abort();await route.fulfill({contentType:filename.endsWith('.html')?'text/html':filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'image/png',body:await readFile(new URL('../desktop/'+filename,import.meta.url))});});
 async function render(state){current=state;await page.addInitScript(data=>{window.fixtureCalls=[];window.ludyClient={state:async()=>data,retry:async()=>{fixtureCalls.push('retry');return true;},browser:async()=>{fixtureCalls.push('browser');return true;}};},current);await page.goto('http://desktop.test/');await page.locator('#title').waitFor();}
 await render(current);await page.getByRole('heading',{name:'Le staging n’est pas encore relié'}).waitFor();assert.equal(await page.locator('#retry').isVisible(),false);assert.equal(await page.locator('#browser').isVisible(),false);assert.match(await page.locator('#message').innerText(),/version configurée/);
 await render({state:'offline',server:'https://staging.example.test',canRetry:true,operatorLocal:false});await page.getByRole('heading',{name:'Ludy est momentanément inaccessible'}).waitFor();await page.getByRole('button',{name:'Ouvrir dans le navigateur'}).click();await page.getByRole('button',{name:'Réessayer'}).click();assert.deepEqual(await page.evaluate(()=>fixtureCalls),['browser','retry']);assert.equal(await page.getByRole('button',{name:'Réessayer'}).isDisabled(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.brand img').evaluate(img=>img.complete&&img.naturalWidth>0),true);
 await render({state:'unverified',server:'https://staging.example.test',canRetry:true,operatorLocal:false});await page.getByRole('heading',{name:'Serveur de test non reconnu'}).waitFor();assert.equal(await page.locator('#browser').isVisible(),false);assert.equal(await page.locator('#retry').isVisible(),true);
 await render({state:'offline',server:'http://127.0.0.1:4173',canRetry:true,operatorLocal:true});await page.locator('#operator').waitFor({state:'visible'});assert.match(await page.locator('#operator').innerText(),/cet ordinateur/);assert.deepEqual(errors,[]);
});
