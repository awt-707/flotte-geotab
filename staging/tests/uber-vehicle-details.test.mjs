import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {chromium} from 'playwright';
const reader=await readFile(new URL('../uber-extension/reader.js',import.meta.url),'utf8');
const scanner=await readFile(new URL('../uber-extension/scanner.js',import.meta.url),'utf8');
const protocolSource=await readFile(new URL('../uber-extension/protocol.js',import.meta.url),'utf8');
const uuid='11111111-1111-4111-8111-111111111111',url=`https://fixture.invalid/orgs/${uuid}/livemap`;
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});
after(async()=>{await browser?.close();});
function fixture(count=11,selected=0){return `<!doctype html><meta charset="utf-8"><style>
body{margin:20px;font:12px sans-serif}#panel{width:300px}.filters{height:70px;display:flex;gap:15px;align-items:center}#list{height:640px;overflow:auto}.header{height:64px;display:flex;align-items:center;position:relative;cursor:pointer}.avatar{position:relative;width:32px;height:32px;margin:0 12px}.avatar svg{width:32px;height:32px}.dot{position:absolute;width:10px;height:10px;border-radius:50%;background:#276ef1;bottom:-2px;right:0;pointer-events:none}.name{pointer-events:none}.identity{line-height:16px}a{font-size:10px}.menu{margin-left:auto;margin-right:10px}.details{height:76px;padding-left:55px;box-sizing:border-box;background:#f7f7f7}.details div{height:38px;display:flex;align-items:center}.selected>.header{background:#eef4ff}.card:not(.selected)>.details{display:none}
</style><div id="panel"><div class="filters"><button>Driver</button><button>Status</button><input type="search" placeholder="Name" style="width:80px"></div><div id="list"></div></div><script>
window.menuClicks=0;window.nameClicks=[];window.rows=Array.from({length:${count}},(_,i)=>({name:'Synthetic Driver '+i,plate:(86121+i)+'-T-1',model:'2026 Hyundai '+(i%2?'Sonata':'Staria')}));window.selected=${selected};
window.render=()=>{document.querySelector('#list').innerHTML=rows.map((r,i)=>'<article class="card '+(selected===i?'selected':'')+'" data-index="'+i+'"><div class="header" role="button" aria-expanded="'+(selected===i)+'"><div class="avatar"><svg aria-hidden="true"><rect width="32" height="32" fill="#ddd"/></svg><span class="dot"></span></div><div class="identity"><div class="name">'+r.name+'</div><a href="tel:+212700000000">+212700000000</a></div><button class="menu">⋯</button></div><div class="details"><div>On trip</div><div class="vehicle">'+(r.plate?r.plate+' · ':'')+r.model+'</div></div></article>').join('');
 document.querySelectorAll('.header').forEach((e,i)=>e.onclick=()=>{nameClicks.push(i);selected=selected===i?-1:i;render();});document.querySelectorAll('.menu').forEach(e=>e.onclick=event=>{event.stopPropagation();menuClicks++;});};render();
</script>`;}
async function pageWith({count=11,selected=0}={},fn){const page=await browser.newPage({viewport:{width:1100,height:1000}});await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:fixture(count,selected)}));await page.goto(url);await page.addScriptTag({content:reader});await page.addScriptTag({content:scanner});try{return await fn(page);}finally{await page.close();}}
async function decorateCards(page,{vehicleIcon=false,wrappers=0}={}){
 await page.evaluate(options=>{
  const renderCards=window.render;
  window.render=()=>{renderCards();
   for(const card of document.querySelectorAll('.card')){
    if(options.vehicleIcon)card.querySelector('.vehicle').insertAdjacentHTML('afterbegin','<svg width="24" height="24" aria-hidden="true"><path d="M2 8h20v10H2z" fill="#999"/><circle cx="6" cy="18" r="3" fill="#545454"/><circle cx="18" cy="18" r="3" fill="#545454"/></svg>');
    const header=card.querySelector('.header');let anchor=header;
    for(let depth=0;depth<options.wrappers;depth++){const wrapper=document.createElement('div');anchor.before(wrapper);wrapper.append(anchor);anchor=wrapper;}
   }
  };window.render();
 },{vehicleIcon,wrappers});
}

test('expanded Uber card binds its plate and model to that driver, excluding telephone and adjacent cards',async()=>{
 await pageWith({count:3},async page=>{const out=await page.evaluate(()=>LudyUberReader.read());assert.equal(out.rows.length,3);const first=out.rows[0];assert.equal(first.vehicleLabel,'86121-T-1');assert.equal(first.vehicleModel,'2026 Hyundai Staria');assert.equal(first.vehicleReadAt,first.readAt);assert.equal(first.vehicleState,'on_trip');assert.equal(out.rows[1].vehicleLabel,undefined);assert.equal(out.rows[2].vehicleLabel,undefined);assert.doesNotMatch(JSON.stringify(out),/212700000000/);});
});

test('a 24px vehicle icon is not a second driver avatar and automatic detail reads keep each plate on its own driver',async()=>{
 await pageWith({count:3},async page=>{
  await decorateCards(page,{vehicleIcon:true});
  const initial=await page.evaluate(()=>LudyUberReader.read());assert.equal(initial.rows[0].vehicleLabel,'86121-T-1');assert.equal(initial.rows[1].vehicleLabel,undefined);
  const out=await page.evaluate(()=>LudyUberScanner.scan());assert.equal(out.rows.length,3);assert.equal(out.coverage.vehicleObserved,3);
  for(const row of out.rows){const index=Number(row.name.split(' ').at(-1));assert.equal(row.vehicleLabel,(86121+index)+'-T-1');}
  assert.equal(await page.evaluate(()=>menuClicks),0);
 });
});

test('four wrappers between header and details still allow bounded automatic collection without crossing another card',async()=>{
 await pageWith({count:3},async page=>{
  await decorateCards(page,{vehicleIcon:true,wrappers:4});
  const initial=await page.evaluate(()=>LudyUberReader.read());assert.equal(initial.rows[0].vehicleLabel,'86121-T-1');assert.equal(initial.rows[1].vehicleLabel,undefined);
  const out=await page.evaluate(()=>LudyUberScanner.scan());assert.equal(out.coverage.vehicleObserved,3);
  assert.deepEqual(out.rows.map(row=>[row.name,row.vehicleLabel]),[['Synthetic Driver 0','86121-T-1'],['Synthetic Driver 1','86122-T-1'],['Synthetic Driver 2','86123-T-1']]);
  assert.equal(await page.evaluate(()=>menuClicks),0);
 });
});

test('an unreadable neighboring header remains a card boundary and its displayed plate cannot attach to the previous driver',async()=>{
 await pageWith({count:3},async page=>{
  await decorateCards(page,{vehicleIcon:true,wrappers:4});
  await page.evaluate(()=>{
   rows[0].plate='';render();document.querySelector('#list').style.overflow='visible';
   const second=document.querySelectorAll('.card')[1];second.querySelector('.header').style.opacity='0';second.querySelector('.details').style.display='block';
  });
  const out=await page.evaluate(()=>LudyUberReader.read());assert.equal(out.rows.length,2);
  assert.equal(out.rows.find(row=>row.name==='Synthetic Driver 0').vehicleLabel,undefined);
  assert.ok(out.rows.every(row=>row.vehicleLabel!=='86122-T-1'));
 });
});

test('vehicle icons and deep wrappers never resolve duplicate driver names using another card plate',async()=>{
 await pageWith({count:3,selected:2},async page=>{
  await decorateCards(page,{vehicleIcon:true,wrappers:4});
  await page.evaluate(()=>{rows[0].name=rows[1].name='Duplicate Driver';render();});
  const out=await page.evaluate(()=>LudyUberScanner.scan());assert.equal(out.rows.length,1);assert.equal(out.rows[0].name,'Synthetic Driver 2');assert.equal(out.rows[0].vehicleLabel,'86123-T-1');
  assert.match(out.warnings.join(' '),/Identités répétées/);assert.equal(await page.evaluate(()=>menuClicks),0);
 });
});

test('a model alone, hidden plate or two plate fragments do not create a vehicle association',async()=>{
 await pageWith({count:2},async page=>{
  for(const line of ['2026 Hyundai Staria','86121-T-1 · WW968201','+212700000000 · Hyundai Staria']){
   await page.locator('.vehicle').first().evaluate((e,t)=>e.textContent=t,line);const out=await page.evaluate(()=>LudyUberReader.read());assert.equal(out.rows[0].vehicleLabel,undefined,line);
  }
  await page.locator('.vehicle').first().evaluate(e=>{e.innerHTML='<span hidden>86121-T-1</span>Hyundai Staria';});assert.equal((await page.evaluate(()=>LudyUberReader.read())).rows[0].vehicleLabel,undefined);
 });
});

test('sweep opens driver details beyond the first ten, restores the selected card and never clicks menus',async()=>{
 await pageWith({},async page=>{
  const out=await page.evaluate(()=>LudyUberScanner.scan());
  assert.equal(out.status,'observing');assert.equal(out.rows.length,11);assert.equal(out.coverage.complete,true);assert.equal(out.coverage.vehicleObserved,11);assert.equal(out.coverage.vehicleComplete,true);
  for(const row of out.rows){const i=Number(row.name.split(' ').at(-1));assert.equal(row.vehicleLabel,(86121+i)+'-T-1');assert.equal(row.vehicleModel,'2026 Hyundai '+(i%2?'Sonata':'Staria'));assert.ok(Date.parse(row.vehicleReadAt)<=Date.parse(row.readAt));}
  assert.deepEqual(await page.evaluate(()=>({selected,menus:menuClicks,scroll:document.querySelector('#list').scrollTop})),{selected:0,menus:0,scroll:0});
 });
});

test('explicit detail changes replace the previous plate and an expanded empty vehicle revokes cached evidence',async()=>{
 await pageWith({count:3,selected:-1},async page=>{
  const first=await page.evaluate(()=>LudyUberScanner.scan());assert.equal(first.coverage.vehicleObserved,3);
  await page.evaluate(()=>{rows[0].plate='WW968201';rows[1].plate='';render();});
  const next=await page.evaluate(()=>LudyUberScanner.scan());assert.equal(next.rows.find(r=>r.name==='Synthetic Driver 0').vehicleLabel,'WW968201');assert.equal(next.rows.find(r=>r.name==='Synthetic Driver 1').vehicleLabel,undefined);
 });
});

test('vehicle cache keeps its own observation age while current states continue and expires without a replacement',async()=>{
 await pageWith({count:2,selected:-1},async page=>{
  const first=await page.evaluate(()=>LudyUberScanner.scan());const before=first.rows[0].vehicleReadAt;assert.ok(before);
  await page.evaluate(()=>{document.querySelectorAll('.header').forEach(e=>{e.onclick=null;e.removeAttribute('role');e.removeAttribute('aria-expanded');e.style.cursor='default';});});
  const second=await page.evaluate(()=>LudyUberScanner.scan());assert.equal(second.rows[0].vehicleReadAt,before);assert.ok(Date.parse(second.rows[0].readAt)>=Date.parse(before));
  const expired=await page.evaluate(async()=>{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[OriginalDate.now()+181000]));}static now(){return OriginalDate.now()+181000;}};try{return await LudyUberScanner.scan();}finally{globalThis.Date=OriginalDate;}});assert.equal(expired.rows[0].vehicleLabel,undefined);
 });
});

test('user interaction during a detail read aborts without restoring or sending partial vehicle data',async()=>{
 await pageWith({count:3,selected:-1},async page=>{
  const out=await page.evaluate(async()=>{document.querySelector('#list').addEventListener('click',()=>document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})),{once:true});return LudyUberScanner.scan();});
  assert.equal(out.status,'error');assert.equal(out.coverage.reason,'user_interaction');assert.deepEqual(out.rows,[]);assert.equal(await page.evaluate(()=>menuClicks),0);
 });
});

test('detail work rotates beyond twelve drivers and cached plates retain their real timestamps',async()=>{
 await pageWith({count:20,selected:-1},async page=>{
  const first=await page.evaluate(()=>LudyUberScanner.scan());assert.equal(first.rows.length,20);assert.equal(first.coverage.complete,true);assert.equal(first.coverage.vehicleObserved,12);assert.equal(first.coverage.vehicleComplete,false);
  const original=first.rows.find(row=>row.name==='Synthetic Driver 6').vehicleReadAt;
  const next=await page.evaluate(()=>LudyUberScanner.scan());assert.equal(next.rows.length,20);assert.equal(next.coverage.vehicleObserved,20);assert.equal(next.coverage.vehicleComplete,true);
  assert.equal(next.rows.find(row=>row.name==='Synthetic Driver 6').vehicleReadAt,original,'a cached plate is not dated at the end of the second sweep');
  assert.equal(next.rows.find(row=>row.name==='Synthetic Driver 19').vehicleLabel,'86140-T-1');assert.equal(await page.evaluate(()=>menuClicks),0);
 });
});

test('hiding the page during an opened detail stops collection without a late restoration click',async()=>{
 await pageWith({count:3,selected:-1},async page=>{
  const out=await page.evaluate(async()=>{
   document.querySelector('#list').addEventListener('click',()=>{Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'));},{once:true});
   const result=await LudyUberScanner.scan();return {result,clicks:nameClicks};
  });
  assert.equal(out.result.status,'error');assert.equal(out.result.coverage.reason,'hidden');assert.deepEqual(out.result.rows,[]);assert.equal(out.clicks.length,1);
 });
});

test('a filtered or visible-only list never claims complete vehicle coverage even when every observed plate was read',async()=>{
 for(const filtered of [false,true])await pageWith({count:filtered?11:3,selected:0},async page=>{
  if(filtered)await page.locator('input[type="search"]').fill('Synthetic');
  const out=await page.evaluate(()=>LudyUberScanner.scan());
  assert.equal(out.status,'observing');assert.equal(out.coverage.vehicleObserved,out.rows.length);assert.equal(out.coverage.complete,false);assert.equal(out.coverage.vehicleComplete,false);
  assert.equal(out.coverage.reason,filtered?'filtered_view':'visible_only');
  const sandbox={URL,TextEncoder,Date};vm.createContext(sandbox);vm.runInContext(protocolSource,sandbox);
  assert.doesNotThrow(()=>sandbox.LudyUberProtocol.payload(out,uuid));
  assert.ok(out.rows.every(row=>Date.parse(row.vehicleReadAt)<=Date.parse(row.readAt)));
 });
});

test('protocol bounds vehicle timestamps and state separately from the current driver observation',()=>{
 const sandbox={URL,TextEncoder,Date};vm.createContext(sandbox);vm.runInContext(protocolSource,sandbox);const protocol=sandbox.LudyUberProtocol,now=Date.now(),at=new Date(now).toISOString();
 const row={sourceId:null,name:'Synthetic Driver',rawState:'On trip',state:'on_trip',readAt:at,sourceAt:null,vehicleLabel:'86121-T-1',vehicleModel:'2026 Hyundai Staria',vehicleReadAt:new Date(now-60000).toISOString(),vehicleState:'available'};
 const input={observedAt:at,sourceAt:null,organizationId:uuid,status:'observing',rows:[row],warnings:[],coverage:{mode:'list_sweep',complete:true,observed:1,reason:'end_of_list',vehicleObserved:1,vehicleComplete:true}};
 assert.equal(protocol.payload(input,uuid,now).rows[0].vehicleState,'available');
 for(const change of [{vehicleReadAt:new Date(now+1).toISOString()},{vehicleReadAt:new Date(now-180001).toISOString()},{vehicleModel:'x'.repeat(101)},{vehicleState:'bogus'},{vehicleLabel:undefined}])assert.throws(()=>protocol.payload({...input,rows:[{...row,...change}]},uuid,now));
 assert.throws(()=>protocol.payload({...input,coverage:{...input.coverage,vehicleObserved:2}},uuid,now));
 assert.throws(()=>protocol.payload({...input,coverage:{...input.coverage,complete:false,reason:'filtered_view'}},uuid,now));
});
