import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const reader=await readFile(new URL('../uber-extension/reader.js',import.meta.url),'utf8');
const scanner=await readFile(new URL('../uber-extension/scanner.js',import.meta.url),'utf8');
const organization='11111111-1111-4111-8111-111111111111';
const fixtureUrl=`https://fixture.invalid/orgs/${organization}/livemap`;
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.LUDY_TEST_CHROMIUM||'/usr/bin/chromium'});});
after(async()=>{await browser?.close();});
function fixture({count=27,virtual=false,height=520,filtered=false,names={}}={}){
  const rows=Array.from({length:count},(_,i)=>({name:names[i]||`Synthetic Driver ${String(i+1).padStart(3,'0')}`,color:['#545454','#276ef1','#05944f'][i%3]}));
  return `<!doctype html><style>
  body{margin:24px;font:14px sans-serif}#panel{width:380px}.controls{display:flex;gap:12px;height:42px;align-items:center}
  #list{height:${height}px;overflow:auto;position:relative;border:1px solid #ddd}#inner{position:relative}
  .card{box-sizing:border-box;position:relative;height:52px;width:100%;display:flex;align-items:center;padding-left:8px;gap:14px}
  .avatar{width:32px;height:32px;position:relative}.avatar svg{height:32px;width:32px}.dot{position:absolute;right:0;bottom:0;height:10px;width:10px;border-radius:50%}.name{white-space:nowrap}
  #map{position:absolute;left:450px;top:80px;width:450px;height:400px;overflow:auto}#map div{height:1200px}
  </style><section id="panel"><div class="controls"><button>Driver <svg width="10" height="10"><path d="M0 0L5 5L10 0"/></svg></button><button>Status <svg width="10" height="10"><path d="M0 0L5 5L10 0"/></svg></button><input type="search" value="${filtered?'Synthetic':''}" placeholder="Name"></div><div id="list"><div id="inner"></div></div></section><div id="map"><div>Unrelated map list</div></div>
  <script>
  const rows=${JSON.stringify(rows)},list=document.querySelector('#list'),inner=document.querySelector('#inner');
  inner.style.height=rows.length*52+'px';
  function render(){let from=${virtual?'Math.max(0,Math.floor(list.scrollTop/52)-1)':'0'},to=${virtual?'Math.min(rows.length,Math.ceil((list.scrollTop+list.clientHeight)/52)+1)':'rows.length'};
    inner.innerHTML=rows.slice(from,to).map((row,index)=>'<div class="card" style="position:absolute;top:'+((from+index)*52)+'px"><div class="avatar"><svg aria-hidden="true" viewBox="0 0 32 32"><rect width="32" height="32" fill="#ddd"/></svg><span class="dot" style="background:'+row.color+'"></span></div><span class="name">'+row.name+'</span></div>').join('');}
  list.addEventListener('scroll',render);render();
  </script>`;
}
async function pageWith(options,work){
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:fixture(options)}));
  await page.goto(fixtureUrl);await page.addScriptTag({content:reader});await page.addScriptTag({content:scanner});
  try{return await work(page);}finally{await page.close();}
}
const scan=page=>page.evaluate(()=>LudyUberScanner.scan());

test('sweeps beyond the first ten rendered drivers and preserves real per-row observation times',async()=>{
  await pageWith({},async page=>{
    const initial=await page.evaluate(()=>LudyUberReader.read());assert.equal(initial.rows.length,10);
    const result=await scan(page);assert.equal(result.status,'observing');assert.equal(result.rows.length,27);
    assert.deepEqual(result.coverage,{mode:'list_sweep',complete:true,observed:27,reason:'end_of_list',vehicleObserved:0,vehicleComplete:false});
    assert.equal(result.rows[26].name,'Synthetic Driver 027');assert.equal(result.rows.some(row=>row.state==='offline'),false);
    assert.equal(new Set(result.rows.map(row=>row.name)).size,27);
    assert.ok(new Set(result.rows.map(row=>row.readAt)).size>1);
    assert.ok(result.rows.every(row=>Date.parse(row.readAt)<=Date.parse(result.observedAt)));
    assert.equal(await page.locator('#list').evaluate(e=>e.scrollTop),0);
    assert.equal(await page.locator('#map').evaluate(e=>e.scrollTop),0);
  });
});

test('virtualized rows are read after rendering at each scroll position and original position is restored',async()=>{
  await pageWith({virtual:true,count:31},async page=>{
    await page.locator('#list').evaluate(e=>e.scrollTop=350);await page.waitForTimeout(50);
    const original=await page.locator('#list').evaluate(e=>e.scrollTop),result=await scan(page);
    assert.equal(result.rows.length,31);assert.equal(result.coverage.complete,true);
    assert.equal(await page.locator('#list').evaluate(e=>e.scrollTop),original);
    assert.ok(await page.locator('#list .card').count()<31,'the source never renders the whole roster at once');
  });
});

test('a recognized table inside a scrolling wrapper is covered while its headers remain visible',async()=>{
  await pageWith({count:2},async page=>{
    await page.setContent(`<style>body{margin:20px;font:14px sans-serif}#table-list{height:300px;width:450px;overflow:auto}table{border-collapse:collapse;width:100%}thead{position:sticky;top:0;z-index:2;background:white}th,td{height:38px;text-align:left;padding:0 12px}</style><div id="table-list"><table><thead><tr><th>Driver</th><th>Status</th></tr></thead><tbody>${Array.from({length:24},(_,i)=>`<tr><td>Synthetic Table Person ${String(i+1).padStart(3,'0')}</td><td>Available</td></tr>`).join('')}</tbody></table></div>`);
    const result=await scan(page);assert.equal(result.rows.length,24);assert.equal(result.coverage.complete,true);
    assert.equal(await page.locator('#table-list').evaluate(e=>e.scrollTop),0);
  });
});

test('waits for delayed infinite-list rows before reporting the rendered end',async()=>{
  await pageWith({virtual:true,count:18},async page=>{
    await page.evaluate(()=>{
      let appended=false;
      list.addEventListener('scroll',()=>{
        if(appended||list.scrollTop<list.scrollHeight-list.clientHeight-2)return;
        appended=true;setTimeout(()=>{
          for(let i=19;i<=27;i++)rows.push({name:`Synthetic Driver ${String(i).padStart(3,'0')}`,color:'#276ef1'});
          inner.style.height=rows.length*52+'px';render();
        },400);
      });
    });
    const result=await scan(page);assert.equal(result.rows.length,27);assert.equal(result.coverage.complete,true);
  });
});

test('homonyms in separate viewports are excluded from the entire sweep',async()=>{
  await pageWith({count:27,names:{0:'Repeated Synthetic Person',24:'Repeated Synthetic Person'}},async page=>{
    const result=await scan(page);assert.equal(result.rows.length,25);assert.equal(result.coverage.complete,false);
    assert.equal(result.coverage.reason,'ambiguous_identity');assert.equal(result.rows.some(row=>row.name==='Repeated Synthetic Person'),false);
  });
});

test('a homonym detected together later removes an earlier single observation',async()=>{
  await pageWith({count:27,names:{8:'Repeated Synthetic Person',10:'Repeated Synthetic Person'}},async page=>{
    const result=await scan(page);assert.equal(result.rows.length,25);assert.equal(result.rows.some(row=>row.name==='Repeated Synthetic Person'),false);
    assert.equal(result.coverage.reason,'ambiguous_identity');
  });
});

test('active search remains applied and a full rendered traversal remains partial coverage',async()=>{
  await pageWith({filtered:true,count:18},async page=>{
    const result=await scan(page);assert.equal(result.rows.length,18);assert.equal(result.coverage.complete,false);
    assert.equal(result.coverage.reason,'filtered_view');assert.equal(await page.locator('input').inputValue(),'Synthetic');
  });
});

test('manual interaction aborts the sweep without fighting the user or transmitting a partial result',async()=>{
  await pageWith({virtual:true,count:40},async page=>{
    const result=await page.evaluate(async()=>{
      const list=document.querySelector('#list');let interruptedAt;
      list.addEventListener('scroll',()=>{if(list.scrollTop>0&&interruptedAt===undefined){interruptedAt=list.scrollTop;document.dispatchEvent(new WheelEvent('wheel',{deltaY:10,bubbles:true}));}},{passive:true});
      const result=await LudyUberScanner.scan();return {result,interruptedAt,finalTop:list.scrollTop};
    });
    assert.equal(result.result.status,'error');assert.deepEqual(result.result.rows,[]);
    assert.equal(result.result.coverage.reason,'user_interaction');assert.equal(result.finalTop,result.interruptedAt);assert.ok(result.finalTop>0);
  });
});

test('a hidden page or explicit cancellation cannot leave a pending scan or restore its scroll',async()=>{
  for(const kind of ['hidden','aborted'])await pageWith({count:40},async page=>{
    const result=await page.evaluate(async kind=>{
      const control=new AbortController(),list=document.querySelector('#list');
      list.addEventListener('scroll',()=>{if(list.scrollTop>0){if(kind==='hidden'){Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'));}else control.abort();}},{once:true});
      const result=await LudyUberScanner.scan({signal:control.signal});return {result,top:list.scrollTop};
    },kind);
    assert.equal(result.result.status,'error');assert.equal(result.result.coverage.reason,kind);assert.deepEqual(result.result.rows,[]);assert.ok(result.top>0);
  });
});

test('an initially hidden, cancelled or disconnected page retains its organization and a useful error',async()=>{
  for(const kind of ['hidden','aborted','network'])await pageWith({count:20},async page=>{
    const result=await page.evaluate(async kind=>{
      const control=new AbortController();
      if(kind==='hidden')Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
      if(kind==='aborted')control.abort();
      if(kind==='network')Object.defineProperty(navigator,'onLine',{value:false,configurable:true});
      return LudyUberScanner.scan({signal:control.signal});
    },kind);
    assert.equal(result.status,'error');assert.equal(result.organizationId,organization);assert.deepEqual(result.rows,[]);
    assert.equal(result.coverage.reason,kind==='network'?'reader_error':kind);
    if(kind==='network')assert.match(result.warnings[0],/Réseau/);
  });
});

test('a short list or a clock regression never manufactures full roster coverage or future row times',async()=>{
  await pageWith({count:3},async page=>{
    const result=await scan(page);assert.equal(result.rows.length,3);assert.equal(result.coverage.reason,'visible_only');assert.equal(result.coverage.complete,false);
  });
  await pageWith({count:20},async page=>{
    const result=await page.evaluate(async()=>{
      const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
      document.querySelector('#list').addEventListener('scroll',()=>{offset=-10000;},{once:true});
      try{return await LudyUberScanner.scan();}finally{Date.now=realNow;}
    });
    assert.equal(result.status,'error');assert.equal(result.coverage.complete,false);assert.deepEqual(result.rows,[]);
  });
});

test('a dynamic list replacement or filter mutation invalidates the whole sweep',async()=>{
  for(const kind of ['replace','filter'])await pageWith({count:40},async page=>{
    const result=await page.evaluate(async kind=>{
      const list=document.querySelector('#list');
      list.addEventListener('scroll',()=>{if(list.scrollTop>0){if(kind==='replace')list.replaceWith(list.cloneNode(true));else document.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));}},{once:true});
      return LudyUberScanner.scan();
    },kind);
    assert.equal(result.status,'error');assert.equal(result.coverage.reason,'list_changed');assert.deepEqual(result.rows,[]);
  });
});

test('bounded work returns partial coverage at the row cap without inventing offline states',async()=>{
  await pageWith({virtual:true,count:225},async page=>{
    const started=Date.now(),result=await scan(page);
    assert.equal(result.status,'observing');assert.equal(result.rows.length,200);
    assert.equal(result.coverage.reason,'row_limit');assert.equal(result.coverage.complete,false);
    assert.ok(Date.now()-started<20000);assert.equal(result.rows.some(row=>row.state==='offline'),false);
  });
});

test('bounded work stops after at most forty viewports and restores position',async()=>{
  await pageWith({virtual:true,count:150,height:156},async page=>{
    const started=Date.now(),result=await scan(page);
    assert.equal(result.status,'observing');assert.equal(result.coverage.reason,'step_limit');assert.equal(result.coverage.complete,false);
    assert.ok(result.rows.length<150);assert.ok(Date.now()-started<20000);assert.equal(await page.locator('#list').evaluate(e=>e.scrollTop),0);
  });
});

test('deadline and loading instability stop the sweep without relabeling old observations as fresh',async()=>{
  await pageWith({count:40},async page=>{
    const result=await page.evaluate(async()=>{
      const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
      document.querySelector('#list').addEventListener('scroll',()=>{offset=25000;},{once:true});
      try{return await LudyUberScanner.scan();}finally{Date.now=realNow;}
    });
    assert.equal(result.coverage.reason,'timeout');assert.equal(result.coverage.complete,false);assert.deepEqual(result.rows,[]);
  });
  await pageWith({count:40},async page=>{
    const result=await page.evaluate(async()=>{
      document.querySelector('#list').addEventListener('scroll',()=>document.querySelector('#panel').setAttribute('aria-busy','true'),{once:true});
      return LudyUberScanner.scan();
    });
    assert.equal(result.status,'error');assert.deepEqual(result.rows,[]);assert.ok(['list_changed','unstable'].includes(result.coverage.reason));
  });
});
