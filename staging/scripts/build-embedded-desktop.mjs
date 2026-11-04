import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {STAGING_ROOT,LOCAL_DIR,ensureLocalDir} from './paths.mjs';
import {TARGETS,electronZip,assertBuildHost,macLocalSignOptions} from './build-desktop.mjs';
const require=createRequire(import.meta.url);
const {validateEmbeddedConfig,readEmbeddedConfig}=require('../desktop/embedded-config.cjs');
const requireDesktop=createRequire(path.join(STAGING_ROOT,'desktop/package.json'));
export const EMBEDDED_CLIENT_FILES=Object.freeze(['embedded-main.cjs','embedded-config.cjs','embedded-supervisor.cjs','assets/icon.png','assets/icon.ico','assets/icon.icns']);
export const EMBEDDED_EXTENSION_FILES=Object.freeze(['uber-extension/ludy-uber-chromium.zip','uber-extension/ludy-uber-firefox.zip','uber-extension/reports-reader.js','uber-extension/earnings-reader.js']);
export const EMBEDDED_SITE_FILES=Object.freeze([
  '_headers','adresses.js','app.js','cache.js','caisse.js','caisse_calc.js','chauffeur.css','chauffeur.html','chauffeur.js','community.css','community.js','config.js','connexions.js','contrat.js','contrat_modele.js','contrat_pdf.js','courses.js','demand.css','demand.js','desktop-worker.js','dialog.js','direct.js','disconnections.css','disconnections.js','driver-performance.css','driver-performance.js','favicon.png','fleet.js',
  'fonts/NotoSansArabic-Bold.ttf','fonts/NotoSansArabic-Regular.ttf','fonts/OFL.txt','index.html','lib.js','logo-ludy-sombre.png','logo-ludy.png','manifeste.js','manifeste/non-resident.jpg','manifeste/resident-1.jpg','manifeste/resident-2.jpg','map-vehicle-appearance.js','map-zones.css','map-zones.js','menu.js','operations.css','operations.js','opportunities.css','opportunities.js','pager.js','pages2.js','parking.css','parking.js','pickup-reference.js','plan.js','plan_calc.js','planning.js','provider-earnings-calculation.js','provider-earnings-data.js','provider-earnings-ui.css','provider-earnings-ui.js','provider-reconciliation-page.js','provider-reconciliation-ui.js','report.js','revenue-data.js','revenue-metrics.js','revenue.css','revenue.js','rh.js','rh_calc.js','rotations.css','rotations.js','spreadsheet-guard.js','spreadsheet-worker.js','spreadsheet.js','style.css','timezone.js','uber-reports.css','uber-reports.js','workspace.css','workspace.js','zone-notifications.js'
]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifySiteScripts(root=STAGING_ROOT) {
  const allowed=new Set(EMBEDDED_SITE_FILES);
  for(const page of ['index.html','chauffeur.html']) {
    const html=await fs.readFile(path.join(root,'site',page),'utf8');
    for(const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      const source=match[1].split(/[?#]/)[0].replace(/^\.\//,'').replace(/^\//,'');
      if(source.startsWith('vendor/'))continue;
      if(!allowed.has(source))throw Error('Script frontend absent de l’allowlist : '+source);
    }
  }
}
async function regularBytes(filename) {
  const stat=await fs.lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>30*1024*1024||await fs.realpath(filename)!==filename)throw Error('Source non régulière refusée : '+path.basename(filename));
  return fs.readFile(filename);
}
async function copyOne(root,relative,out,destination=relative) {
  const bytes=await regularBytes(path.join(root,relative));
  await fs.mkdir(path.dirname(path.join(out,destination)),{recursive:true,mode:0o700});
  await fs.writeFile(path.join(out,destination),bytes,{flag:'wx',mode:0o644});
  return {path:destination,sha256:hash(bytes),bytes:bytes.length};
}
export async function runtimeSourceFiles(root=STAGING_ROOT) {
  root=path.resolve(root);const files=[...EMBEDDED_SITE_FILES.map(name=>'site/'+name),...EMBEDDED_EXTENSION_FILES,'package.json','package-lock.json','vendor/xlsx-0.20.3.tgz'];
  await verifySiteScripts(root);
  async function modules(relative) {
    const directory=path.join(root,relative);
    if(await fs.realpath(directory)!==directory)throw Error('Répertoire source symbolique refusé.');
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.name)||['node_modules','data','profiles','exports'].includes(entry.name))continue;
      const file=relative+'/'+entry.name;
      if(entry.isSymbolicLink())throw Error('Lien symbolique refusé : '+file);
      if(entry.isDirectory())await modules(file);
      else if(entry.isFile()&&entry.name.endsWith('.mjs')&&!/\.(test|integration|e2e)\.mjs$/.test(entry.name))files.push(file);
    }
  }
  await modules('server');await modules('desktop-runtime');
  if(!files.includes('desktop-runtime/server.mjs'))throw Error('Runtime embarqué incomplet : desktop-runtime/server.mjs absent.');
  return files.sort();
}
export async function prepareEmbeddedSources(destination,config,sourceRoot=STAGING_ROOT) {
  config=validateEmbeddedConfig(config);const root=path.resolve(sourceRoot),out=path.resolve(destination);
  const files=await runtimeSourceFiles(root);
  await fs.mkdir(out,{mode:0o700});
  try {
    const runtime=path.join(out,'ludy-runtime'),client=path.join(out,'client');await fs.mkdir(runtime);await fs.mkdir(client);
    const inventory=[];
    for(const file of files)inventory.push(await copyOne(root,file,runtime));
    for(const name of ['embedded-bootstrap.cjs','embedded-config.cjs'])inventory.push(await copyOne(root,'desktop/'+name,runtime,'desktop-runtime/'+name));
    for(const file of EMBEDDED_CLIENT_FILES)await copyOne(path.join(root,'desktop'),file,client);
    const desktopPackage=JSON.parse(await regularBytes(path.join(root,'desktop/package.json')));
    if(!/^\d+\.\d+\.\d+$/.test(desktopPackage.version||''))throw Error('Version desktop invalide.');
    await fs.writeFile(path.join(client,'package.json'),JSON.stringify({name:'ludy-desktop',productName:'Ludy',version:desktopPackage.version,private:true,main:'embedded-main.cjs',license:'UNLICENSED'})+'\n',{flag:'wx'});
    await fs.writeFile(path.join(client,'embedded.json'),JSON.stringify(config)+'\n',{flag:'wx'});
    return {runtime,client,version:desktopPackage.version,inventory};
  }catch(error){await fs.rm(out,{recursive:true,force:true});throw error;}
}
export async function dependencyInventory(directory) {
  const entries=[];
  async function walk(folder,relative='') {
    for(const item of await fs.readdir(folder,{withFileTypes:true})) {
      const rel=relative?relative+'/'+item.name:item.name,filename=path.join(folder,item.name);
      if(item.isSymbolicLink())throw Error('Dépendance avec lien symbolique refusée : '+rel);
      if(item.isDirectory())await walk(filename,rel);
      else if(item.isFile()) {
        if(item.name.endsWith('.node'))throw Error('Dépendance native non validée pour Electron : '+rel);
        const bytes=await regularBytes(filename);entries.push({path:rel,sha256:hash(bytes),bytes:bytes.length});
      }else throw Error('Dépendance non régulière refusée.');
    }
  }
  await walk(directory);return entries;
}
export function parseEmbeddedBuildArgs(args) {
  const options={target:'windows-x64',configPath:null,check:false};
  for(let index=0;index<args.length;index++) {
    const flag=args[index];if(['--help','-h'].includes(flag))return{help:true};
    if(flag==='--config'&&args[index+1]&&!options.configPath)options.configPath=path.resolve(args[++index]);
    else if(flag==='--target'&&args[index+1])options.target=args[++index];
    else if(flag==='--check'&&!options.check)options.check=true;
    else if(flag==='--mac-local-test'&&!options.macLocalTest)options.macLocalTest=true;
    else throw Error('Option invalide. Utilisez --help.');
  }
  if(!options.configPath)throw Error('--config est obligatoire : fournissez seulement la configuration publique Supabase du projet.');
  if(!TARGETS[options.target])throw Error('Cible desktop inconnue.');
  return options;
}
async function run(command,args,options={}) {
  await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','ignore','pipe'],...(process.platform==='win32'&&command==='npm.cmd'?{shell:true}:{}),...options});let last='';child.stderr.on('data',chunk=>{last=(last+chunk).slice(-3000);});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Échec de '+command+' ('+code+'). '+last.trim())));});
}
async function fileHash(file){const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);return digest.digest('hex');}
export async function main(args=process.argv.slice(2)) {
  const options=parseEmbeddedBuildArgs(args);
  if(options.help){console.log('node staging/scripts/build-embedded-desktop.mjs --config CONFIG_PUBLIC.json [--target windows-x64|linux-x64|macos-arm64|macos-x64] [--check]\n--check vérifie les sources et la configuration, sans connexion au projet Supabase.\nMac : construction native avec --mac-local-test uniquement, sans ZIP de distribution.');return;}
  const config=readEmbeddedConfig(options.configPath);
  if(!options.check)assertBuildHost(options);
  const sourceFiles=await runtimeSourceFiles();
  for(const file of sourceFiles)await regularBytes(path.join(STAGING_ROOT,file));
  if(options.check){const result={configurationValid:true,projectRef:config.projectRef,sourceFiles:sourceFiles.length,productionAccess:false,readyForDeployment:false};console.log(JSON.stringify(result,null,2));return result;}
  ensureLocalDir();const releaseRoot=path.join(LOCAL_DIR,'releases','embedded-desktop');await fs.mkdir(releaseRoot,{recursive:true,mode:0o700});
  const temporary=await fs.mkdtemp(path.join(releaseRoot,'.build-'));
  try {
    const prepared=await prepareEmbeddedSources(path.join(temporary,'sources'),config),target=TARGETS[options.target];
    // Install from the lock in an isolated directory; no developer node_modules,
    // credentials, install scripts, Supabase CLI or browser profiles are copied.
    await run(process.platform==='win32'?'npm.cmd':'npm',['ci','--omit=dev','--ignore-scripts','--no-bin-links','--no-audit','--no-fund'],{cwd:prepared.runtime,env:{...process.env,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'}});
    const dependencies=await dependencyInventory(path.join(prepared.runtime,'node_modules'));
    await fs.writeFile(path.join(prepared.runtime,'build-manifest.json'),JSON.stringify({format:'ludy-embedded-runtime-v1',sources:prepared.inventory,dependencies},null,2)+'\n');
    const versions=JSON.parse(await fs.readFile(path.join(STAGING_ROOT,'desktop/package.json'),'utf8')).devDependencies;
    const zipDirectory=await electronZip(target,versions.electron);
    const {packager}=await import(pathToFileURL(requireDesktop.resolve('@electron/packager')).href);
    const {listPackage,extractFile}=await import(pathToFileURL(requireDesktop.resolve('@electron/asar')).href);
    const folders=await packager({dir:prepared.client,out:path.join(temporary,'packages'),tmpdir:path.join(temporary,'packager'),name:'Ludy',executableName:'Ludy',appBundleId:'com.ludy.desktop',appCategoryType:'public.app-category.business',appVersion:prepared.version,buildVersion:prepared.version,platform:target.platform,arch:target.arch,electronVersion:versions.electron,electronZipDir:zipDirectory,icon:path.join(prepared.client,'assets/icon'),asar:true,prune:false,overwrite:false,extraResource:[prepared.runtime],...(target.platform==='darwin'?{osxSign:macLocalSignOptions()}:{}),win32metadata:{CompanyName:'Ludy',FileDescription:'Ludy',ProductName:'Ludy',InternalName:'Ludy'}});
    if(folders.length!==1)throw Error('Sortie de construction ambiguë.');
    const folder=folders[0],resources=target.platform==='darwin'?path.join(folder,'Ludy.app/Contents/Resources'):path.join(folder,'resources');
    const allowed=new Set([...EMBEDDED_CLIENT_FILES,'assets','package.json','embedded.json']);
    if(listPackage(path.join(resources,'app.asar')).some(file=>!allowed.has(file.replace(/^\//,''))))throw Error('Fichier inattendu dans le client embarqué.');
    if(JSON.stringify(validateEmbeddedConfig(JSON.parse(extractFile(path.join(resources,'app.asar'),'embedded.json').toString())))!==JSON.stringify(config))throw Error('Configuration embarquée différente du projet demandé.');
    // Verify the resource copy before publishing any archive.
    for(const entry of [...prepared.inventory,...dependencies.map(file=>({...file,path:'node_modules/'+file.path}))])if(await fileHash(path.join(resources,'ludy-runtime',entry.path))!==entry.sha256)throw Error('Ressource embarquée différente des sources validées.');
    if(target.platform==='darwin')await run('codesign',['--verify','--deep','--strict','--verbose=2',path.join(folder,'Ludy.app')]);
    const name='Ludy-'+prepared.version+'-'+target.label+'-'+target.arch+(target.platform==='darwin'?'-TEST-LOCAL':'')+'-'+Date.now()+'-'+randomUUID().slice(0,8);
    const finalFolder=path.join(releaseRoot,name);await fs.rename(folder,finalFolder);
    const result={target:options.target,folder:finalFolder,projectRef:config.projectRef,version:prepared.version,embeddedServer:true,configured:true,productionAccess:false,runtimeVerified:false,signed:target.platform==='darwin',notarized:false};
    if(target.platform==='darwin'){result.appPath=path.join(finalFolder,'Ludy.app');result.signing='adhoc-local-test';result.distributable=false;}
    else {
      result.file=finalFolder+'.zip';await run('zip',['-q','-r','-y',result.file,path.basename(finalFolder)],{cwd:releaseRoot,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='ZIPOPT'))});
      result.sha256=await fileHash(result.file);result.bytes=(await fs.stat(result.file)).size;
      await fs.writeFile(result.file+'.sha256',result.sha256+'  '+path.basename(result.file)+'\n',{flag:'wx',mode:0o600});
    }
    await fs.writeFile(path.join(releaseRoot,name+'.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify(result,null,2));return result;
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
