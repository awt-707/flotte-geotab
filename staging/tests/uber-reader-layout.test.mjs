import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const reader=await readFile(new URL('../uber-extension/reader.js',import.meta.url),'utf8');
const url='https://fixture.invalid/orgs/11111111-1111-4111-8111-111111111111/livemap';
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});
after(async()=>{await browser?.close();});
const icon='<svg width="24" height="24" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" stroke="black" fill="none"/></svg>';
const card=(index,name)=>`<article class="card"><div class="avatar"><svg aria-hidden="true" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg><span class="dot" style="background:${['#276ef1','#545454','#05944f'][index%3]}"></span></div><div class="identity"><div class="name">${name||'Synthetic Driver '+index}</div><a href="tel:+00000000000">+00 000 000 000</a></div><button class="menu">⋯</button></article>`;
function fixture(count=25){return `<!doctype html><style>
body{margin:0;font:12px sans-serif}#panel{position:absolute;top:80px;left:20px;width:288px;background:white;border:1px solid #aaa}.filters{padding:12px}.first{display:flex;gap:10px}button{display:flex;align-items:center;border:0;height:35px}.status{margin-top:8px}.list{height:640px;overflow-y:auto}.card{height:64px;display:flex;align-items:center;position:relative}.avatar{position:relative;width:32px;height:32px;margin:0 12px}.dot{position:absolute;right:-1px;bottom:-2px;width:10px;height:10px;border-radius:50%;pointer-events:none}.name{pointer-events:none}.identity{line-height:16px}a{font-size:10px}.menu{margin-left:auto;margin-right:10px}input{width:125px}
</style><div id="panel"><div class="filters"><div class="first"><button>Driver ${icon}</button><input type="search" placeholder="Name"></div><button class="status">Status ${icon}</button></div><div class="list">${Array.from({length:count},(_,i)=>card(i)).join('')}</div></div>`;}
async function pageWith(html,fn){const page=await browser.newPage({viewport:{width:1100,height:1000}});await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:html}));await page.goto(url);await page.addScriptTag({content:reader});try{return await fn(page);}finally{await page.close();}}

test('filter chevrons do not hide the sibling driver list; pointer-transparent dots and labels remain readable',async()=>{
 await pageWith(fixture(),async page=>{
  const out=await page.evaluate(()=>{const x=LudyUberReader.inspect();return {result:x.result,panel:x.panel?.id,scrollRoot:x.scrollRoot?.className,entries:x.entries.length,sameObjects:x.entries.every((e,i)=>e.row===x.result.rows[i]),filtered:x.filtered};});
  assert.equal(out.result.status,'observing');assert.equal(out.panel,'panel');assert.equal(out.scrollRoot,'list');assert.equal(out.entries,10);assert.equal(out.sameObjects,true);assert.equal(out.filtered,false);
  assert.deepEqual(out.result.rows.slice(0,3).map(x=>x.state),['on_trip','available','to_pickup']);
  assert.equal(JSON.stringify(out.result).includes('+00'),false);
  await page.locator('.list').evaluate(x=>x.scrollTop=640);
  const next=await page.evaluate(()=>LudyUberReader.read());assert.equal(next.rows.length,10);assert.equal(next.rows[0].name,'Synthetic Driver 10');
  await page.locator('.list').evaluate(x=>x.scrollTop=x.scrollHeight);
  const last=await page.evaluate(()=>LudyUberReader.read());assert.equal(last.rows.at(-1).name,'Synthetic Driver 24');assert.equal(last.rows.some(x=>x.state==='offline'),false);
 });
});

test('occluding another visible row does not make its text or color trustworthy',async()=>{
 await pageWith(fixture(2),async page=>{
  await page.locator('.card').first().evaluate(x=>{const overlay=document.createElement('div');overlay.style.cssText='position:absolute;inset:0;background:white;z-index:5';x.append(overlay);});
  const result=await page.evaluate(()=>LudyUberReader.read());assert.equal(result.rows.length,1);assert.equal(result.rows[0].name,'Synthetic Driver 1');
 });
});

test('inspect exposes ambiguous visible identities for a sweep without placing DOM or filters in the payload',async()=>{
 await pageWith(fixture(3),async page=>{
  await page.locator('.name').nth(1).evaluate(x=>x.textContent='Synthetic Driver 0');
  await page.locator('input[type="search"]').fill('Synthetic');
  const out=await page.evaluate(()=>{const x=LudyUberReader.inspect();return {result:x.result,keys:x.ambiguousKeys,filtered:x.filtered,entryNames:x.entries.map(e=>e.row.name)};});
  assert.deepEqual(out.keys,['synthetic driver 0']);assert.equal(out.filtered,true);assert.deepEqual(out.entryNames,['Synthetic Driver 2']);
  assert.equal('panel' in out.result,false);assert.equal('filtered' in out.result,false);assert.equal('ambiguousKeys' in out.result,false);
 });
});

test('a selected status filter is scoped while a page-level scrollbar is never offered for automated scrolling',async()=>{
 await pageWith(fixture(2),async page=>{
  await page.locator('.status').evaluate(x=>x.textContent='Status (1)');
  const out=await page.evaluate(()=>{const x=LudyUberReader.inspect();return {rows:x.result.rows.length,filtered:x.filtered,scrollRoot:!!x.scrollRoot};});
  assert.equal(out.rows,2);assert.equal(out.filtered,true);assert.equal(out.scrollRoot,false);
 });
});
