import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {STAGING_ROOT,LOCAL_DIR} from './paths.mjs';
import {EMBEDDED_SITE_FILES,runtimeSourceFiles,dependencyInventory} from './build-embedded-desktop.mjs';

export const WEB_VERSION='0.1.0';
export const WEB_RUNTIME_FILES=Object.freeze(['config.mjs','main.mjs','server.mjs','services.mjs','transport.mjs','verify-install.mjs']);
export const WEB_WINDOWS_FILES=Object.freeze(['install.ps1','start-web.ps1']);
const omittedSite=new Set(['config.js','desktop-auth.js','desktop-worker.js','uber-extension.html']);
export const WEB_SITE_FILES=Object.freeze(EMBEDDED_SITE_FILES.filter(file=>!omittedSite.has(file)));
const metadataFiles=['package.json','package-lock.json','vendor/xlsx-0.20.3.tgz'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const imports=/\b(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.{1,2}\/[^'"\r\n]+)['"]/g;

async function regularBytes(filename){
  const stat=await fs.lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>30*1024*1024||await fs.realpath(filename)!==filename)
    throw Error('Source non régulière refusée : '+path.basename(filename));
  return fs.readFile(filename);
}
function localImports(code,relative){
  return [...code.matchAll(imports)].map(match=>{
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[1]));
    if(resolved.startsWith('../')||resolved.includes('?')||resolved.includes('#'))throw Error('Import hors runtime : '+relative);
    return resolved;
  });
}

/** Reuse the audited desktop candidate list, but ship only the web module graph.
 * Provider files imported by shared handlers are code, never credentials/state. */
export async function webSourceFiles(sourceRoot=STAGING_ROOT){
  const root=await fs.realpath(path.resolve(sourceRoot));
  const candidates=new Set((await runtimeSourceFiles(root)).filter(file=>file.startsWith('server/')||file.startsWith('desktop-runtime/')||file.startsWith('uber-extension/')&&file.endsWith('.js')));
  for(const file of WEB_SITE_FILES)candidates.add('site/'+file);
  for(const file of WEB_RUNTIME_FILES)candidates.add('web-runtime/'+file);
  candidates.add('desktop/embedded-config.cjs');
  const selected=new Set([...metadataFiles,...WEB_SITE_FILES.map(file=>'site/'+file),...WEB_WINDOWS_FILES.map(file=>'web-runtime/windows/'+file)]);
  const pending=WEB_RUNTIME_FILES.map(file=>'web-runtime/'+file);
  // Frontend module imports also must remain inside the public site allowlist.
  pending.push(...WEB_SITE_FILES.filter(file=>/\.(?:m?js|cjs)$/.test(file)).map(file=>'site/'+file));
  const visited=new Set();
  while(pending.length){
    const file=pending.pop();if(visited.has(file))continue;visited.add(file);
    if(!candidates.has(file))throw Error('Import absent de l’allowlist web : '+file);
    const code=(await regularBytes(path.join(root,file))).toString('utf8');selected.add(file);
    for(const dependency of localImports(code,file)){
      if(file.startsWith('site/')&&!dependency.startsWith('site/'))throw Error('Import serveur interdit dans le site public : '+file);
      if(!candidates.has(dependency))throw Error('Import absent de l’allowlist web : '+dependency);
      pending.push(dependency);
    }
  }
  return [...selected].sort();
}

function webHtml(html){
  return html.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])(?:\.\/|\/)?desktop-(?:auth|worker)\.js(?:[?#][^"']*)?\1[^>]*>\s*<\/script\s*>\s*/gi,'');
}
async function verifyPreparedImports(root,files){
  const available=new Set(files);
  for(const file of files){
    if(!/\.(?:m?js|cjs)$/.test(file))continue;
    for(const dependency of localImports((await regularBytes(path.join(root,file))).toString('utf8'),file))
      if(!available.has(dependency))throw Error('Import absent du paquet web : '+dependency);
  }
  for(const file of files.filter(file=>file.startsWith('site/')&&file.endsWith('.html'))){
    const html=await fs.readFile(path.join(root,file),'utf8');
    for(const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)){
      const name=match[1].split(/[?#]/)[0].replace(/^\.\//,'').replace(/^\//,'');
      if(name==='config.js'||name.startsWith('vendor/'))continue;
      if(!available.has('site/'+name))throw Error('Script absent du site web : '+name);
    }
  }
}

export async function prepareWebSources(destination,sourceRoot=STAGING_ROOT){
  const root=await fs.realpath(path.resolve(sourceRoot)),out=path.resolve(destination),files=await webSourceFiles(root);
  await fs.mkdir(out,{mode:0o700});
  try{
    const inventory=[];
    for(const file of files){
      let bytes=await regularBytes(path.join(root,file));
      if(file.startsWith('site/')&&file.endsWith('.html'))bytes=Buffer.from(webHtml(bytes.toString('utf8')));
      const target=path.join(out,file);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
      await fs.writeFile(target,bytes,{flag:'wx',mode:0o644});inventory.push({path:file,sha256:hash(bytes),bytes:bytes.length});
    }
    await verifyPreparedImports(out,files);
    return {root:out,version:WEB_VERSION,inventory};
  }catch(error){await fs.rm(out,{recursive:true,force:true});throw error;}
}

async function run(command,args,options={}){
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','ignore','pipe'],...(process.platform==='win32'&&command==='npm.cmd'?{shell:true}:{}),...options});
    let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2500);});child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(Error('Échec de '+path.basename(command)+' ('+code+'). '+stderr.trim())));
  });
}

export function parseWebBuildArgs(args){
  const options={out:path.join(LOCAL_DIR,'releases','web','Ludy-Web-'+WEB_VERSION),check:false};let customOut=false;
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(flag==='--help'||flag==='-h')return {help:true};
    if(flag==='--out'&&args[i+1]&&!args[i+1].startsWith('--')&&!customOut){options.out=path.resolve(args[++i]);customOut=true;}
    else if(flag==='--check'&&!options.check)options.check=true;
    else throw Error('Option invalide. Utilisez --help.');
  }
  return options;
}

export async function buildWeb({out,sourceRoot=STAGING_ROOT,runCommand=run}={}){
  const destination=path.resolve(out||path.join(LOCAL_DIR,'releases','web','Ludy-Web-'+WEB_VERSION));
  // Never replace a prior release or its operator-supplied Node/configuration.
  for(const filename of [destination,destination+'.json'])
    if(await fs.lstat(filename).catch(error=>{if(error.code!=='ENOENT')throw error;return null;}))throw Error('La sortie existe déjà. Choisissez un nouveau --out.');
  await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
  const temporary=await fs.mkdtemp(path.join(path.dirname(destination),'.web-build-'));
  try{
    const prepared=await prepareWebSources(path.join(temporary,'runtime'),sourceRoot);
    await runCommand(process.platform==='win32'?'npm.cmd':'npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--bin-links=false'],
      {cwd:prepared.root,env:{...process.env,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'}});
    const dependencies=await dependencyInventory(path.join(prepared.root,'node_modules'));
    // Import the actual shipped assembly in a fresh Node process; this checks
    // ESM/CJS resolution without starting HTTP, providers or Supabase access.
    await runCommand(process.execPath,['--input-type=module','--eval',"await import('./web-runtime/services.mjs'); await import('./web-runtime/server.mjs');"],{cwd:prepared.root});
    const manifest={format:'ludy-web-runtime-v1',version:WEB_VERSION,entrypoint:'web-runtime/main.mjs',nodeRequired:'>=20',configurationEmbedded:false,collector:false,
      sources:prepared.inventory,dependencies};
    const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
    await fs.writeFile(path.join(prepared.root,'build-manifest.json'),manifestBytes,{flag:'wx',mode:0o644});
    // Check copied files once more after dependency installation.
    for(const file of [...manifest.sources,...dependencies.map(file=>({...file,path:'node_modules/'+file.path}))])
      if(hash(await regularBytes(path.join(prepared.root,file.path)))!==file.sha256)throw Error('Fichier du paquet modifié : '+file.path);
    await fs.rename(prepared.root,destination);
    const result={version:WEB_VERSION,folder:destination,entrypoint:'web-runtime/main.mjs',manifestSha256:hash(manifestBytes),sourceFiles:manifest.sources.length,dependencyFiles:dependencies.length,configurationEmbedded:false,nodeIncluded:false,productionAccess:false};
    await fs.writeFile(destination+'.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    return result;
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}

export async function main(args=process.argv.slice(2)){
  const options=parseWebBuildArgs(args);
  if(options.help){console.log('node staging/scripts/build-web.mjs [--out DOSSIER_NEUF] [--check]\nVersion web '+WEB_VERSION+' ; configuration et binaire Node fournis séparément.');return;}
  if(options.check){const files=await webSourceFiles();for(const file of files)await regularBytes(path.join(STAGING_ROOT,file));const result={version:WEB_VERSION,sourceFiles:files.length,configurationEmbedded:false,productionAccess:false};console.log(JSON.stringify(result,null,2));return result;}
  const result=await buildWeb(options);console.log(JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
