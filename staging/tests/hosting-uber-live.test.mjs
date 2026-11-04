import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {liveMapUrl,uberLivePlan,runUberLive,uberLiveCommand} from '../hosting/uber-live.mjs';
import {renderHosting} from '../hosting/config.mjs';

const org='12345678-ABCD-4123-8123-1234567890AB';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ludy-live-launch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.local'),{mode:0o700});await fs.mkdir(path.join(root,'.local/hosting'),{mode:0o700});
 const config=path.join(root,'.local/hosting/uber-live.json');await fs.writeFile(config,JSON.stringify({organizationId:org}),{mode:0o600});
 const executable=path.join(root,'chromium-fixture');await fs.writeFile(executable,'fixture, never executed',{mode:0o700});
 return {root,config,env:{LUDY_LIVE_CHROMIUM:executable,DISPLAY:':99'},executable,profile:path.join(root,'.local/uber-live-browser')};
}
test('only one confirmed organization UUID can form the fixed Uber Live Map URL',()=>{
 assert.equal(liveMapUrl({organizationId:org}),'https://fleethub.uber.com/orgs/'+org.toLowerCase()+'/livemap');
 for(const value of [null,[],{organizationId:'name'},{organizationId:'00000000-0000-0000-0000-000000000000'},{organizationId:org+'?x=y'},{organizationId:org,url:'https://other.example'},{organizationId:org,profile:'/home/operator'}])assert.throws(()=>liveMapUrl(value),error=>error.exitCode===78);
});
test('read-only check uses the dedicated profile and does not create it or open Chromium',async t=>{
 const f=await fixture(t),plan=await uberLivePlan(f);assert.equal(plan.executable,f.executable);assert.deepEqual(plan.args,['--user-data-dir='+f.profile,'--no-first-run','--disable-session-crashed-bubble','https://fleethub.uber.com/orgs/'+org.toLowerCase()+'/livemap']);
 assert.deepEqual(await uberLiveCommand(['--check'],f),{ok:true,configured:true,started:false});await assert.rejects(fs.stat(f.profile),{code:'ENOENT'});
 assert.ok(!plan.args.some(arg=>/headless|no-sandbox|debugging|load-extension/.test(arg)));
});
test('missing, malformed, broad-permission or symlink config refuses before spawning',async t=>{
 const f=await fixture(t),options={...f,spawnFn:()=>assert.fail('browser must not spawn')};
 await fs.unlink(f.config);await assert.rejects(runUberLive(options),error=>error.exitCode===78);
 await fs.writeFile(f.config,'invalid json',{mode:0o600});await assert.rejects(runUberLive(options));
 await fs.writeFile(f.config,JSON.stringify({organizationId:org}));await fs.chmod(f.config,0o644);await assert.rejects(runUberLive(options));
 await fs.chmod(f.config,0o600);await fs.rename(f.config,f.config+'.real');await fs.symlink(f.config+'.real',f.config);await assert.rejects(runUberLive(options));
 await assert.rejects(fs.stat(f.profile),{code:'ENOENT'});
});
test('browser must be an existing executable absolute path without injected flags',async t=>{
 const f=await fixture(t);
 for(const value of ['chromium','/usr/bin/chromium --no-sandbox','/usr/bin/../bin/chromium','/usr/bin/chromium\n--headless',f.root+'/missing'])await assert.rejects(uberLivePlan({...f,env:{LUDY_LIVE_CHROMIUM:value}}));
 await fs.chmod(f.executable,0o600);await assert.rejects(uberLivePlan(f));await fs.chmod(f.executable,0o777);await assert.rejects(uberLivePlan(f));
});
test('launcher preserves existing profile contents and locks, using no shell or login automation',async t=>{
 const f=await fixture(t);await fs.mkdir(f.profile,{mode:0o700});await fs.writeFile(path.join(f.profile,'session-fixture'),'keep me',{mode:0o600});await fs.symlink('chromium-owned-lock',path.join(f.profile,'SingletonLock'));
 let captured;const signals=new EventEmitter();
 const code=await runUberLive({...f,signals,spawnFn:(executable,args,options)=>{captured={executable,args,options};const child=new EventEmitter();child.kill=()=>assert.fail('no unsolicited stop');queueMicrotask(()=>child.emit('close',0,null));return child;}});
 assert.equal(code,0);assert.equal(captured.options.shell,false);assert.equal(captured.options.detached,false);assert.equal(captured.args.at(-1),'https://fleethub.uber.com/orgs/'+org.toLowerCase()+'/livemap');assert.equal(await fs.readFile(path.join(f.profile,'session-fixture'),'utf8'),'keep me');assert.equal(await fs.readlink(path.join(f.profile,'SingletonLock')),'chromium-owned-lock');assert.equal(signals.listenerCount('SIGTERM'),0);
});
test('a symlink or non-private browser profile is refused without repairing it',async t=>{
 const f=await fixture(t);await fs.mkdir(f.profile,{mode:0o700});await fs.chmod(f.profile,0o755);await assert.rejects(uberLivePlan(f));assert.equal((await fs.stat(f.profile)).mode&0o777,0o755);await fs.rmdir(f.profile);await fs.symlink(path.join(f.root,'.local/hosting'),f.profile);await assert.rejects(uberLivePlan(f));assert.equal(await fs.readlink(f.profile),path.join(f.root,'.local/hosting'));
});
test('service stop only forwards its signal to the launched child and unregisters handlers',async t=>{
 const f=await fixture(t),signals=new EventEmitter(),received=[];
 const code=await runUberLive({...f,signals,spawnFn:()=>{const child=new EventEmitter();child.kill=signal=>{received.push(signal);queueMicrotask(()=>child.emit('close',null,signal));};queueMicrotask(()=>signals.emit('SIGTERM'));return child;}});
 assert.equal(code,0);assert.deepEqual(received,['SIGTERM']);assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal((await fs.stat(f.profile)).mode&0o777,0o700);
});
test('Chromium failure is reported and never changes the private configuration',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.config,'utf8');await assert.rejects(runUberLive({...f,signals:new EventEmitter(),spawnFn:()=>{const child=new EventEmitter();child.kill=()=>{};queueMicrotask(()=>child.emit('error',Error('private browser diagnostic')));return child;}}),error=>error.exitCode===70&&!error.message.includes('private browser diagnostic'));assert.equal(await fs.readFile(f.config,'utf8'),before);
});
test('systemd launches the validated helper and stops retrying absent configuration',async()=>{
 const rendered=await renderHosting({publicOrigin:'https://staging.example.org'}),unit=rendered.files['ludy-uber-live.service'];assert.match(unit,/Environment=LUDY_LIVE_CHROMIUM=\/usr\/bin\/chromium/);assert.match(unit,/ExecStart=\/usr\/bin\/node .*\/hosting\/uber-live.mjs/);assert.match(unit,/RestartPreventExitStatus=78/);assert.match(unit,/KillMode=control-group/);assert.doesNotMatch(unit,/ExecStart=.*https:\/\/fleethub.uber.com\//);
});
