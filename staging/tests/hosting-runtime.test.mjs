import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {STAGING_SOURCE,sourceManifest,writeSourceBundle} from '../hosting/bundle.mjs';
import {renderHosting} from '../hosting/config.mjs';

test('actual source manifest includes timezone, browser reader, hosting units and every HTML dependency',async()=>{
 const manifest=await sourceManifest(),files=new Set(manifest.files.map(f=>f.path));
 for(const name of ['server/morocco-time.mjs','site/timezone.js','server/uber-report-browser-collector.mjs','scripts/uber-reports-browser.mjs','uber-extension/reports-reader.js','uber-extension/build.mjs','hosting/uber-live.mjs','hosting/templates/ludy-uber-reports.service.in','site/spreadsheet-worker.js','site/fonts/NotoSansArabic-Regular.ttf','site/fonts/NotoSansArabic-Bold.ttf','vendor/xlsx-0.20.3.tgz','vendor/README.md'])assert.ok(files.has(name),name);
 assert.ok([...files].every(name=>!name.startsWith('.local/')&&!name.includes('node_modules/')));
 for(const name of [...files].filter(name=>name.startsWith('site/')&&name.endsWith('.html'))){
  const html=await fs.readFile(path.join(STAGING_SOURCE,name),'utf8');
  for(const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)){
   const target=match[1];if(target.startsWith('/vendor/')||target==='config.js')continue;
   assert.ok(!/^https?:/.test(target),'runtime asset must not depend on another application: '+target);
   const resolved=target.startsWith('/')?'site'+target:path.posix.normalize(path.posix.join(path.posix.dirname(name),target));assert.ok(files.has(resolved),name+' → '+resolved);
  }
 }
});

test('the server bundle carries the patched spreadsheet dependency with its locked integrity',async()=>{
 const pkg=JSON.parse(await fs.readFile(path.join(STAGING_SOURCE,'package.json'),'utf8'));
 const lock=JSON.parse(await fs.readFile(path.join(STAGING_SOURCE,'package-lock.json'),'utf8'));
 const installed=JSON.parse(await fs.readFile(path.join(STAGING_SOURCE,'node_modules/xlsx/package.json'),'utf8'));
 const archive=await fs.readFile(path.join(STAGING_SOURCE,'vendor/xlsx-0.20.3.tgz'));
 assert.equal(pkg.dependencies.xlsx,'file:vendor/xlsx-0.20.3.tgz');
 assert.equal(lock.packages['node_modules/xlsx'].version,'0.20.3');
 assert.equal(installed.version,'0.20.3');
 assert.equal(lock.packages['node_modules/xlsx'].integrity,'sha512-'+createHash('sha512').update(archive).digest('base64'));
 assert.equal(createHash('sha256').update(archive).digest('hex'),'8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8');
});

test('extracted source runs its timezone and report-reader modules without any parent repository',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-server-source-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const archive=path.join(directory,'source.tar.gz'),app=path.join(directory,'isolated');await fs.mkdir(app);
 await writeSourceBundle(archive);
 const extracted=spawnSync('tar',['-xzf',archive,'-C',app],{encoding:'utf8',timeout:15000});assert.equal(extracted.status,0);
 const code="const time=await import('./server/morocco-time.mjs');if(typeof time.moroccoDay!=='function'||typeof time.tzdbVersion!=='string')process.exit(2);const reports=await import('./scripts/uber-reports-browser.mjs');if(typeof reports.main!=='function')process.exit(3);const host=await import('./scripts/host.mjs');if(typeof host.checkHosting!=='function')process.exit(4);console.log('isolated imports ok');";
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:app,encoding:'utf8',timeout:15000,env:{...process.env,NODE_PATH:''}});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/isolated imports ok/);
 const help=spawnSync(process.execPath,['scripts/uber-reports-browser.mjs','--help'],{cwd:app,encoding:'utf8',timeout:15000,env:{...process.env,NODE_PATH:''}});assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/--earnings/);await assert.rejects(fs.stat(path.join(app,'node_modules')),{code:'ENOENT'});
 const built=spawnSync(process.execPath,['uber-extension/build.mjs'],{cwd:app,encoding:'utf8',timeout:15000});assert.equal(built.status,0,built.stderr);
 for(const browser of ['chromium','firefox']){const bytes=await fs.readFile(path.join(app,'uber-extension','ludy-uber-'+browser+'.zip'));assert.equal(bytes.readUInt32LE(0),0x04034b50);}
 await assert.rejects(fs.stat(path.join(app,'.local')),{code:'ENOENT'});
});

test('all vendor files resolve inside the standalone staging installation',async()=>{
 const source=await fs.readFile(path.join(STAGING_SOURCE,'scripts/serve.mjs'),'utf8');
 assert.match(source,/const modules = path\.join\(STAGING_ROOT, 'node_modules'\)/);assert.doesNotMatch(source,/path\.join\(STAGING_ROOT, '\.\.', 'node_modules'/);
 const pkg=JSON.parse(await fs.readFile(path.join(STAGING_SOURCE,'package.json'),'utf8'));
 const vendorMap=source.match(/const vendors = new Map\(\[([\s\S]*?)\]\);/)?.[1]||'';
 const rows=[...vendorMap.matchAll(/\['\/vendor\/[^']+', '([^']+)'\]/g)];assert.ok(rows.length>=10);
 for(const match of rows){const relative=match[1],dependency=relative.startsWith('@')?relative.split('/').slice(0,2).join('/'):relative.split('/')[0];assert.ok(pkg.dependencies[dependency],dependency);const actual=await fs.realpath(path.join(STAGING_SOURCE,'node_modules',relative));assert.ok(actual.startsWith(path.join(STAGING_SOURCE,'node_modules')+path.sep),relative);}
});

test('reports systemd uses pinned Playwright Chromium and never the configured Live Map override',async()=>{
 const rendered=await renderHosting({publicOrigin:'https://staging.example.org',chromium:'/custom/live-only-chromium'}),unit=rendered.files['ludy-uber-reports.service'];
 assert.match(unit,/^UnsetEnvironment=LUDY_REPORTS_CHROMIUM$/m);assert.doesNotMatch(unit,/^Environment=LUDY_REPORTS_CHROMIUM=/m);assert.doesNotMatch(unit,/live-only-chromium|--headless|--no-sandbox/);assert.match(rendered.files['ludy-uber-live.service'],/Environment=LUDY_LIVE_CHROMIUM=\/custom\/live-only-chromium/);
 const browserScript=await fs.readFile(path.join(STAGING_SOURCE,'scripts/uber-reports-browser.mjs'),'utf8');assert.match(browserScript,/process\.env\.LUDY_REPORTS_CHROMIUM\s*\|\|\s*chromium\.executablePath\(\)/);
 const pkg=JSON.parse(await fs.readFile(path.join(STAGING_SOURCE,'package.json'),'utf8')),installed=JSON.parse(await fs.readFile(path.join(STAGING_SOURCE,'node_modules/playwright/package.json'),'utf8')),browsers=JSON.parse(await fs.readFile(path.join(STAGING_SOURCE,'node_modules/playwright-core/browsers.json'),'utf8'));
 assert.equal(pkg.dependencies.playwright,'1.64.1');assert.equal(installed.version,pkg.dependencies.playwright);assert.match(browsers.browsers.find(b=>b.name==='chromium').browserVersion,/^156\./);
});
