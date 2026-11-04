// Native archive inspection only: never executes Electron or its embedded runtime.
// GUI startup remains a separate pilot check; ad hoc signing is not notarization.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const command=promisify(execFile);
const require=createRequire(import.meta.url);
const requireDesktop=createRequire(new URL('../desktop/package.json',import.meta.url));
const {validateEmbeddedConfig}=require('../desktop/embedded-config.cjs');
const TARGETS=Object.freeze({'macos-arm64':{node:'arm64',mach:'arm64'},'macos-x64':{node:'x64',mach:'x86_64'}});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>file.startsWith(root+path.sep);
async function fileHash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
function safeRelative(value) {
  return typeof value==='string'&&value.length>0&&!/[\\\u0000-\u001f\u007f]/.test(value)&&!path.posix.isAbsolute(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
}
async function jsonFile(file,max=4*1024*1024){const stat=await fs.lstat(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=max,'Invalid JSON artifact');return JSON.parse(await fs.readFile(file,'utf8'));}
function validateManifest(value,platform=process.platform,arch=process.arch) {
  assert.equal(platform,'darwin','Native macOS host required; GUI is not emulated');
  const target=TARGETS[value?.target];assert.ok(target,'Unsupported macOS target');assert.equal(arch,target.node,'Native target architecture required');
  for(const name of ['file','sha256File','bundleManifestFile'])assert.ok(path.isAbsolute(value[name]||''),'Absolute artifact path required: '+name);
  assert.equal(path.extname(value.file),'.zip');assert.equal(value.signing,'adhoc');assert.equal(value.notarized,false);assert.equal(value.gatekeeperApproved,false);assert.equal(value.archiveVerified,true);
  if(value.sha256!==undefined)assert.match(value.sha256,/^[a-f0-9]{64}$/);
  return target;
}
function zipEntries(text) {
  const entries=text.split(/\r?\n/).filter(Boolean),seen=new Set();assert.ok(entries.length>10&&entries.length<100000,'Unexpected archive size');
  for(const entry of entries){const rel=entry.replace(/\/$/,'');assert.ok(safeRelative(rel),'Unsafe archive path');assert.ok(rel==='Ludy.app'||rel.startsWith('Ludy.app/'),'Archive must contain only Ludy.app');assert.ok(!seen.has(entry),'Duplicate archive member');seen.add(entry);}
  for(const file of ['Ludy.app/Contents/Info.plist','Ludy.app/Contents/MacOS/Ludy','Ludy.app/Contents/Resources/app.asar','Ludy.app/Contents/Resources/ludy-runtime/build-manifest.json'])assert.ok(seen.has(file),'Missing archive member: '+file);
  return entries;
}
function signatureIsAdHoc(text) {
  assert.match(text,/(?:^|\n)Signature=adhoc(?:\r?\n|$)/,'Expected an ad hoc signature');
  assert.ok(!/(?:^|\n)Authority=/.test(text),'Unexpected certificate signature');
  assert.match(text,/(?:^|\n)TeamIdentifier=not set(?:\r?\n|$)/,'Unexpected signing team');
}
function architectureMatches(text,wanted) {assert.deepEqual(text.trim().split(/\s+/),[wanted],'Wrong or mixed Mach-O architecture');}
async function run(program,args){return command(program,args,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C'}});}
async function bundleFiles(app) {
  const files=[],links=[];
  async function walk(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink()){assert.ok(inside(app,await fs.realpath(file)),'Bundle symlink escapes application');links.push(file);}
    else if(entry.isDirectory())await walk(file);
    else {assert.ok(entry.isFile(),'Unsupported bundle entry');files.push(file);}
  }}
  await walk(app);return {files,links};
}
export async function verifyRuntime(runtime) {
  const manifest=await jsonFile(path.join(runtime,'build-manifest.json'));
  assert.equal(manifest.format,'ludy-embedded-runtime-v1');assert.ok(Array.isArray(manifest.sources)&&Array.isArray(manifest.dependencies));
  assert.ok(manifest.sources.length>0&&manifest.dependencies.length>0,'Empty runtime inventory');
  const expected=new Map();
  for(const [group,prefix] of [[manifest.sources,''],[manifest.dependencies,'node_modules/']])for(const entry of group){
    assert.ok(safeRelative(entry.path),'Unsafe runtime inventory path');assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(entry.bytes)&&entry.bytes>=0);
    const rel=prefix+entry.path;assert.ok(!expected.has(rel),'Duplicate runtime inventory entry');expected.set(rel,entry);
  }
  for(const file of ['desktop-runtime/server.mjs','desktop-runtime/embedded-bootstrap.cjs','desktop-runtime/embedded-config.cjs','site/index.html','package.json','package-lock.json','uber-extension/ludy-uber-chromium.zip','uber-extension/ludy-uber-firefox.zip'])assert.ok(expected.has(file),'Required embedded resource absent: '+file);
  let actual=0;
  async function walk(directory,relative=''){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const rel=relative?relative+'/'+entry.name:entry.name,file=path.join(directory,entry.name);
    assert.ok(!entry.isSymbolicLink(),'Runtime symlink refused');
    if(entry.isDirectory())await walk(file,rel);
    else {
      assert.ok(entry.isFile(),'Unsupported runtime entry');if(rel==='build-manifest.json')continue;
      const reference=expected.get(rel);assert.ok(reference,'Unmanifested runtime resource: '+rel);
      assert.ok(!rel.endsWith('.node'),'Unverified native Node dependency');assert.equal((await fs.stat(file)).size,reference.bytes,'Runtime size differs: '+rel);assert.equal(await fileHash(file),reference.sha256,'Runtime digest differs: '+rel);actual++;
    }
  }}
  await walk(runtime);assert.equal(actual,expected.size,'Missing runtime resources');return actual;
}
export async function verifyClient(resources,release) {
  // Reads ASAR data with the build tool; no packaged JavaScript is executed.
  const {listPackage,extractFile}=await import(pathToFileURL(requireDesktop.resolve('@electron/asar')).href);
  const archive=path.join(resources,'app.asar'),allowed=new Set(['assets','assets/icon.png','assets/icon.ico','assets/icon.icns','package.json','embedded.json','embedded-main.cjs','embedded-config.cjs','embedded-supervisor.cjs']);
  const listed=listPackage(archive).map(file=>file.replace(/^\//,''));assert.equal(new Set(listed).size,listed.length);
  for(const file of listed)assert.ok(allowed.has(file),'Unexpected packaged client entry');
  for(const file of allowed)assert.ok(listed.includes(file),'Missing packaged client entry: '+file);
  const config=validateEmbeddedConfig(JSON.parse(extractFile(archive,'embedded.json').toString('utf8')));
  const pkg=JSON.parse(extractFile(archive,'package.json').toString('utf8'));assert.equal(pkg.main,'embedded-main.cjs');assert.equal(pkg.name,'ludy-desktop');assert.match(pkg.version,/^\d+\.\d+\.\d+$/);
  if(release.projectRef!==undefined)assert.equal(config.projectRef,release.projectRef);
  if(release.version!==undefined)assert.equal(pkg.version,release.version);
  return {projectRef:config.projectRef,version:pkg.version,clientFiles:listed.length};
}
export async function verifyMacArtifact(manifestPath) {
  const release=await jsonFile(path.resolve(manifestPath),65536),target=validateManifest(release);
  const archiveStat=await fs.lstat(release.file);assert.ok(archiveStat.isFile()&&!archiveStat.isSymbolicLink());
  const digest=await fileHash(release.file),checksum=(await fs.readFile(release.sha256File,'utf8')).trim();
  assert.equal(checksum,digest+'  '+path.basename(release.file),'ZIP checksum mismatch');if(release.sha256!==undefined)assert.equal(release.sha256,digest);
  const entries=zipEntries((await run('/usr/bin/unzip',['-Z','-1',release.file])).stdout);
  await run('/usr/bin/unzip',['-tq',release.file]);
  const temporary=await fs.mkdtemp(path.join(tmpdir(),'ludy-mac-package-check-'));
  try {
    await run('/usr/bin/ditto',['-x','-k',release.file,temporary]);
    assert.deepEqual((await fs.readdir(temporary)).sort(),['Ludy.app']);
    const app=await fs.realpath(path.join(temporary,'Ludy.app')),resources=path.join(app,'Contents/Resources'),{files,links}=await bundleFiles(app);
    assert.ok((await fs.stat(path.join(app,'Contents/MacOS/Ludy'))).mode&0o111,'Executable mode lost');
    const plist=JSON.parse((await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')])).stdout);
    assert.equal(plist.CFBundleExecutable,'Ludy');assert.equal(plist.CFBundleIdentifier,'com.ludy.desktop');assert.equal(plist.CFBundlePackageType,'APPL');
    const client=await verifyClient(resources,release);assert.equal(plist.CFBundleShortVersionString,client.version);
    const runtimeFiles=await verifyRuntime(path.join(resources,'ludy-runtime'));
    let machoFiles=0;
    for(const file of files){const handle=await fs.open(file,'r');let magic;try{const buffer=Buffer.alloc(4);const {bytesRead}=await handle.read(buffer,0,4,0);magic=bytesRead===4?buffer.toString('hex'):'';}finally{await handle.close();}
      if(['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic)){
        architectureMatches((await run('/usr/bin/lipo',['-archs',file])).stdout,target.mach);machoFiles++;
      }
    }
    assert.ok(machoFiles>=5,'Missing native Electron executables');
    await run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
    const signature=await run('/usr/bin/codesign',['--display','--verbose=4',app]);signatureIsAdHoc(signature.stdout+'\n'+signature.stderr);
    return {ok:true,target:release.target,version:client.version,projectRef:client.projectRef,sha256:digest,archiveEntries:entries.length,bundleFiles:files.length,bundleSymlinks:links.length,runtimeFiles,machoFiles,architectureVerified:true,archiveVerified:true,signing:'adhoc',signatureVerified:true,notarized:false,gatekeeperApproved:false,guiExecuted:false,runtimeExecuted:false,appDataCreated:false,productionRequests:0,providerRequests:0,pilotGuiCheckRequired:true};
  } finally {await fs.rm(temporary,{recursive:true,force:true});}
}

async function selfTest() {
  // Portable checks exercise validation failures; they are not native Mac evidence.
  const manifest={target:'macos-arm64',file:'/synthetic/Ludy.zip',sha256File:'/synthetic/Ludy.zip.sha256',bundleManifestFile:'/synthetic/bundle.json',signing:'adhoc',notarized:false,gatekeeperApproved:false,archiveVerified:true};
  validateManifest(manifest,'darwin','arm64');assert.throws(()=>validateManifest(manifest,'linux','arm64'));assert.throws(()=>validateManifest(manifest,'darwin','x64'));
  for(const change of [{notarized:true},{gatekeeperApproved:true},{archiveVerified:false},{signing:'developer-id'},{file:'relative.zip'},{sha256:'bad'}])assert.throws(()=>validateManifest({...manifest,...change},'darwin','arm64'));
  for(const value of ['../escape','/absolute','a/../../b','a\\b','a//b','a\nb'])assert.equal(safeRelative(value),false);
  assert.ok(safeRelative('Ludy.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'));
  const members=['Ludy.app/','Ludy.app/Contents/Info.plist','Ludy.app/Contents/MacOS/Ludy','Ludy.app/Contents/Resources/app.asar','Ludy.app/Contents/Resources/ludy-runtime/build-manifest.json',...Array.from({length:8},(_,i)=>'Ludy.app/file'+i)];
  assert.equal(zipEntries(members.join('\n')).length,members.length);
  for(const extra of ['../escape','Other.app/Contents/x','Ludy.app/../outside','Ludy.app/file0'])assert.throws(()=>zipEntries([...members,extra].join('\n')));
  signatureIsAdHoc('Signature=adhoc\nTeamIdentifier=not set\n');assert.throws(()=>signatureIsAdHoc('Signature=adhoc\nTeamIdentifier=not set\nAuthority=Example\n'));assert.throws(()=>signatureIsAdHoc('Signature=adhoc\nTeamIdentifier=TEAM\n'));
  architectureMatches('arm64\n','arm64');assert.throws(()=>architectureMatches('x86_64','arm64'));assert.throws(()=>architectureMatches('arm64 x86_64','arm64'));
  const temporary=await fs.mkdtemp(path.join(tmpdir(),'ludy-mac-inspection-test-'));
  try {
    const sources=['desktop-runtime/server.mjs','desktop-runtime/embedded-bootstrap.cjs','desktop-runtime/embedded-config.cjs','site/index.html','package.json','package-lock.json','uber-extension/ludy-uber-chromium.zip','uber-extension/ludy-uber-firefox.zip'].map(file=>({path:file,bytes:9,sha256:sha('synthetic')}));
    const dependencies=[{path:'example/index.js',bytes:9,sha256:sha('synthetic')}];
    for(const entry of [...sources,...dependencies.map(file=>({...file,path:'node_modules/'+file.path}))]){const file=path.join(temporary,entry.path);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'synthetic');}
    await fs.writeFile(path.join(temporary,'build-manifest.json'),JSON.stringify({format:'ludy-embedded-runtime-v1',sources,dependencies}));
    assert.equal(await verifyRuntime(temporary),9);
    await fs.writeFile(path.join(temporary,'package.json'),'different');await assert.rejects(verifyRuntime(temporary),/digest differs/);await fs.writeFile(path.join(temporary,'package.json'),'synthetic');
    await fs.writeFile(path.join(temporary,'unexpected.json'),'synthetic');await assert.rejects(verifyRuntime(temporary),/Unmanifested/);await fs.rm(path.join(temporary,'unexpected.json'));
    await fs.rm(path.join(temporary,'package.json'));await fs.symlink(path.join(temporary,'package-lock.json'),path.join(temporary,'package.json'));await assert.rejects(verifyRuntime(temporary),/symlink/);
    await fs.symlink(path.dirname(temporary),path.join(temporary,'escape'));await assert.rejects(bundleFiles(temporary),/escapes application/);
  } finally {await fs.rm(temporary,{recursive:true,force:true});}
  return {ok:true,portableValidation:true,nativeMacExecuted:false,guiExecuted:false,productionRequests:0};
}
async function main(args=process.argv.slice(2)) {
  if(args.length===1&&args[0]==='--self-test')return selfTest();
  if(args.length!==2||args[0]!=='--manifest')throw Error('Usage: node staging/tests/embedded-macos-package.e2e.mjs --manifest <release/manifest.json> | --self-test');
  return verifyMacArtifact(args[1]);
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main().then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.message);process.exitCode=1;});
