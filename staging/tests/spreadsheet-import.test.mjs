import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import XLSX from 'xlsx';
import {chromium} from 'playwright';
const assets=Object.fromEntries(await Promise.all(['spreadsheet.js','spreadsheet-worker.js','spreadsheet-guard.js'].map(async f=>['/'+f,await readFile(new URL('../site/'+f,import.meta.url),'utf8')])));assets['/vendor/xlsx.full.min.js']=await readFile(new URL('../node_modules/xlsx/dist/xlsx.full.min.js',import.meta.url),'utf8');
let browser,server,base,workerMode='normal';const requests=[];
before(async()=>{
 server=createServer((req,res)=>{requests.push(req.url);if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><main>Fixture locale</main>');return;}
  const asset=assets[req.url];if(!asset){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/javascript; charset=utf-8');if(req.url==='/spreadsheet-worker.js'){res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'");
   if(workerMode==='idle'){res.end('self.onmessage=()=>{};');return;}if(workerMode==='delayed'){res.end('self.onmessage=()=>setTimeout(()=>postMessage({ok:true,book:{SheetNames:["Test"],sheets:[{name:"Test",rows:[["One"]]}],date1904:false}}),200);');return;}}
  res.end(asset);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});
});after(async()=>{await browser?.close();await new Promise(r=>server?.close(r));});
async function fixture(work){workerMode='normal';const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.evaluate(()=>{window.S={session:{user:{id:'synthetic'}}};});await page.addScriptTag({url:base+'/spreadsheet.js'});try{await work(page);assert.deepEqual(errors,[]);}finally{await page.close();}}
const workbook=(rows,{type='xlsx',date1904=false,compression=false,multi=false}={})=>{const book=XLSX.utils.book_new();book.Workbook={WBProps:{date1904}};XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Courses');if(multi)XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Nom','Total'],['Test',12.5]]),'Caisse');return XLSX.write(book,{bookType:type,type:'buffer',compression});};
async function parse(page,bytes,name,options={}){return page.evaluate(async({base64,name,options})=>{const buffer=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));try{return {book:await readSpreadsheet(buffer,name,options)};}catch(e){return {error:e.message};}}, {base64:Buffer.from(bytes).toString('base64'),name,options});}
test('CSV keeps dates and UTF-8/Windows-1252 names as text without loading the parser into the app realm',async()=>{
 await fixture(async page=>{const utf=await parse(page,Buffer.from('Nom;Début\nChauffeur;05/10/2026 13:30\n'),'contracts.csv');assert.deepEqual(utf.book.sheets[0].rows,[['Nom','Début'],['Chauffeur','05/10/2026 13:30']]);const latin=await parse(page,Buffer.from('Nom;Ville\nAndré;Marrakech','latin1'),'cash.csv');assert.equal(latin.book.sheets[0].rows[1][0],'André');assert.equal(await page.evaluate(()=>typeof XLSX),'undefined');assert.equal(await page.evaluate(()=>SPREADSHEET_JOBS.size),0);});
});
test('normal XLSX compressed/uncompressed and XLS return primitive grids with all selected sheets',async()=>{
 await fixture(async page=>{for(const type of ['xlsx','xls'])for(const compression of [false,true]){const result=await parse(page,workbook([['Trip','Total'],['Test',12.5]],{type,compression,multi:true}),'normal.'+type,{mode:'raw'});assert.equal(result.error,undefined);assert.equal(result.book.sheets.length,2);assert.deepEqual(result.book.sheets[0].rows,[['Trip','Total'],['Test',12.5]]);assert.equal(result.book.sheets[1].name,'Caisse');}});
});
test('XLS/XLSX formatted imports preserve local dates while raw reports retain serials in both Excel calendars',async()=>{
 await fixture(async page=>{for(const type of ['xlsx','xls'])for(const date1904 of [false,true]){
  const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([['Début','Total'],[46200.5,12.5]]);sheet.A2.z='dd/mm/yyyy hh:mm';sheet.B2.z='0.00';XLSX.utils.book_append_sheet(book,sheet,'Test');book.Workbook={WBProps:{date1904}};const bytes=XLSX.write(book,{type:'buffer',bookType:type});
  const raw=await parse(page,bytes,'dates.'+type,{mode:'raw'});assert.equal(raw.error,undefined);assert.equal(raw.book.date1904,date1904);assert.deepEqual(raw.book.sheets[0].rows[1],[46200.5,12.5]);
  const formatted=await parse(page,bytes,'dates.'+type);assert.equal(formatted.error,undefined);assert.deepEqual(formatted.book.sheets[0].rows[1],[date1904?'28/06/2030 12:00':'27/06/2026 12:00','12.50']);
 }});
});
test('invalid truncated workbooks and over-limit normal files are rejected with no partial import',async()=>{
 await fixture(async page=>{const bytes=workbook([['A'],['B'],['C']],{compression:true});const truncated=await parse(page,bytes.subarray(0,bytes.length-10),'truncated.xlsx');assert.match(truncated.error,/Archive Excel/);assert.equal(truncated.book,undefined);const rows=await parse(page,bytes,'normal.xlsx',{maxRows:2});assert.match(rows.error,/trop grande/);const huge=await page.evaluate(async()=>{try{await readSpreadsheet(new Blob([new Uint8Array(16*1024*1024+1)]),'large.xlsx');return '';}catch(e){return e.message;}});assert.match(huge,/volumineux/);assert.equal(await page.evaluate(()=>SPREADSHEET_JOBS.size),0);});
});
test('a worker that does not reply is terminated after the deadline while the page remains responsive',async()=>{
 await fixture(async page=>{workerMode='idle';await page.clock.install();await page.evaluate(()=>{window.parseResult=null;void readSpreadsheet(new Blob(['a;b\n1;2']),'test.csv').catch(e=>window.parseResult=e.message);});await page.waitForFunction(()=>SPREADSHEET_JOBS.size===1);await page.evaluate(()=>document.querySelector('main').textContent='Toujours utilisable');await page.clock.fastForward(15001);await page.waitForFunction(()=>parseResult!==null);assert.match(await page.evaluate(()=>parseResult),/trop de temps/);assert.equal(await page.evaluate(()=>SPREADSHEET_JOBS.size),0);assert.equal(await page.locator('main').textContent(),'Toujours utilisable');});
});
test('navigation, caller cancellation and a changed user discard old parsing results',async()=>{
 await fixture(async page=>{workerMode='idle';await page.evaluate(()=>{window.parseResult=null;window.importCancel=new AbortController();void readSpreadsheet(new Blob(['a;b\n1;2']),'test.csv',{signal:importCancel.signal}).catch(e=>window.parseResult=e.name);});await page.waitForFunction(()=>SPREADSHEET_JOBS.size===1);await page.evaluate(()=>importCancel.abort());await page.waitForFunction(()=>parseResult!==null);assert.equal(await page.evaluate(()=>parseResult),'AbortError');assert.equal(await page.evaluate(()=>SPREADSHEET_JOBS.size),0);
  await page.evaluate(()=>{window.parseResult=null;void readSpreadsheet(new Blob(['a;b\n1;2']),'test.csv').catch(e=>window.parseResult=e.name);location.hash='#/next';});await page.waitForFunction(()=>parseResult!==null);assert.equal(await page.evaluate(()=>parseResult),'AbortError');
  workerMode='delayed';await page.evaluate(()=>{window.parseResult=null;void readSpreadsheet(new Blob(['a;b\n1;2']),'test.csv').catch(e=>window.parseResult=e.message);S.session={user:{id:'different'}};});await page.waitForFunction(()=>parseResult!==null);assert.match(await page.evaluate(()=>parseResult),/session a changé/);assert.equal(await page.evaluate(()=>SPREADSHEET_JOBS.size),0);
 });
});
