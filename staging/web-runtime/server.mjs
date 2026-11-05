import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {publicWebConfig,validateWebConfig} from './config.mjs';

export const WEB_BIND_HOST='127.0.0.1';
export const WEB_BIND_PORT=4180;
const INTERNAL_ORIGIN='http://127.0.0.1:4173';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon'};
const VENDORS=new Map([
  ['/vendor/supabase.js','@supabase/supabase-js/dist/umd/supabase.js'],
  ['/vendor/leaflet.js','leaflet/dist/leaflet.js'],['/vendor/leaflet.css','leaflet/dist/leaflet.css'],
  ['/vendor/xlsx.full.min.js','xlsx/dist/xlsx.full.min.js'],
  ['/vendor/jspdf.umd.min.js','jspdf/dist/jspdf.umd.min.js'],
  ['/vendor/jspdf.plugin.autotable.min.js','jspdf-autotable/dist/jspdf.plugin.autotable.min.js'],
  ['/vendor/pdf-lib.min.js','pdf-lib/dist/pdf-lib.min.js'],['/vendor/fontkit.umd.min.js','@pdf-lib/fontkit/dist/fontkit.umd.min.js'],
  ['/vendor/bidi.min.js','bidi-js/dist/bidi.min.js']
]);
const FONTS=new Map([['/vendor/barlow.css','barlow'],['/vendor/barlow-semi-condensed.css','barlow-semi-condensed']]);
const LOOPBACK=new Set(['127.0.0.1','::ffff:127.0.0.1']);

function contained(root,filename){
  try{const real=fs.realpathSync(filename);return real.startsWith(root+path.sep)&&fs.statSync(real).isFile()?real:null;}catch{return null;}
}
function send(req,res,status,body,type='text/plain; charset=utf-8'){
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body);
}
function uniqueHeaders(req){
  const seen=new Set();
  for(let i=0;i<req.rawHeaders.length;i+=2){const key=req.rawHeaders[i].toLowerCase();
    if(['host','authorization','origin','content-type'].includes(key)){if(seen.has(key))return false;seen.add(key);}}
  return true;
}

// The external Host/Origin boundary is checked before this adapter is used.
// This is an in-process request to the existing handlers, never a connection
// to the desktop's port or its session. Keep the original readable stream.
function internalRequest(req){
  const headers={...req.headers,host:'127.0.0.1:4173'};
  for(const key of Object.keys(headers))if(key==='forwarded'||key.startsWith('x-forwarded-')||key.startsWith('tailscale-'))delete headers[key];
  if(headers.origin)headers.origin=INTERNAL_ORIGIN;
  return new Proxy(req,{get(target,key){
    if(key==='headers')return headers;
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
}

/** This server has no shared login, collector, browser, or database side effect. */
export function createWebHttpServer({config,runtimeRoot,services,instanceId=randomUUID()}){
  config=validateWebConfig(config);const cfg=publicWebConfig(config),allowedHost=new URL(config.webOrigin).host;
  if(!path.isAbsolute(runtimeRoot||''))throw Error('Répertoire du site Ludy requis.');
  const siteRoot=fs.realpathSync(path.join(runtimeRoot,'site')),modules=fs.realpathSync(path.join(runtimeRoot,'node_modules'));
  const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self' "+cfg.SUPABASE_URL+' '+cfg.SUPABASE_URL.replace('https:','wss:')+" https://photon.komoot.io; frame-src 'self' blob:; frame-ancestors 'none'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
  function staticFile(urlPath){
    if(VENDORS.has(urlPath))return contained(modules,path.join(modules,VENDORS.get(urlPath)));
    if(/^\/vendor\/images\/[a-zA-Z0-9@._-]+\.png$/.test(urlPath))return contained(modules,path.join(modules,'leaflet/dist/images',path.basename(urlPath)));
    if(/^\/vendor\/files\/barlow(?:-semi-condensed)?-[a-z0-9-]+\.woff2?$/.test(urlPath)){
      const family=path.basename(urlPath).startsWith('barlow-semi-condensed-')?'barlow-semi-condensed':'barlow';
      return contained(modules,path.join(modules,'@fontsource',family,'files',path.basename(urlPath)));
    }
    if(urlPath.startsWith('/vendor/')||urlPath.split('/').some(part=>part.startsWith('.')||part.includes('\\')))return null;
    return contained(siteRoot,path.resolve(siteRoot,'.'+(urlPath==='/'?'/index.html':urlPath)));
  }
  const server=http.createServer({maxHeaderSize:16384,requestTimeout:60000,headersTimeout:15000},async(req,res)=>{
    res.setHeader('Content-Security-Policy',csp);res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    if(!LOOPBACK.has(req.socket.remoteAddress)||!uniqueHeaders(req))return send(req,res,403,'Requête refusée.');
    if(!req.url?.startsWith('/')||req.url.startsWith('//'))return send(req,res,400,'Adresse invalide.');
    try{
      const url=new URL(req.url,config.webOrigin),host=req.headers.host;
      const localHealth=url.pathname==='/health'&&['GET','HEAD'].includes(req.method)&&
        /^127\.0\.0\.1:[0-9]+$/.test(host||'')&&!req.headers.origin;
      if(host!==allowedHost&&!localHealth)return send(req,res,403,'Hôte refusé.');
      if(req.headers.origin!==undefined&&req.headers.origin!==config.webOrigin||req.headers['sec-fetch-site']==='cross-site')return send(req,res,403,'Origine refusée.');
      if(url.pathname.startsWith('/api/')){
        if(url.pathname.startsWith('/api/desktop/')||url.pathname==='/api/desktop')return send(req,res,404,'Route inconnue.');
        if(!/^Bearer [A-Za-z0-9._~-]+$/.test(req.headers.authorization||''))return send(req,res,401,JSON.stringify({error:'Connexion Ludy requise.'}),TYPES['.json']);
        if(!['GET','HEAD'].includes(req.method)&&(req.headers.origin!==config.webOrigin||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')))return send(req,res,403,'Origine ou format refusé.');
        if(Number(req.headers['content-length']||0)>16*1024*1024)return send(req,res,413,'Requête trop grande.');
        const active=typeof services==='function'?services():services;
        if(!active)return send(req,res,503,JSON.stringify({error:'Site Ludy en cours de démarrage.'}),TYPES['.json']);
        if(await active.handle(internalRequest(req),res))return;
        return send(req,res,404,JSON.stringify({error:'Route inconnue.'}),TYPES['.json']);
      }
      if(!['GET','HEAD'].includes(req.method))return send(req,res,405,'Méthode non permise.');
      if(url.pathname==='/health')return send(req,res,200,JSON.stringify({environment:'production',mode:'web',projectRef:config.projectRef,instanceId}),TYPES['.json']);
      if(url.pathname==='/config.js')return send(req,res,200,'window.FLOTTE_CONFIG = Object.freeze('+JSON.stringify(cfg)+');\n',TYPES['.js']);
      if(FONTS.has(url.pathname)){
        const family=FONTS.get(url.pathname),files=[400,500,600,700].map(weight=>contained(modules,path.join(modules,'@fontsource',family,weight+'.css')));
        if(files.some(file=>!file))return send(req,res,404,'Police indisponible.');
        return send(req,res,200,files.map(file=>fs.readFileSync(file,'utf8')).join('\n'),TYPES['.css']);
      }
      let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{return send(req,res,400,'Adresse invalide.');}
      if(decoded.includes('\0'))return send(req,res,400,'Adresse invalide.');
      if(decoded==='/spreadsheet-worker.js')res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'");
      const file=staticFile(decoded);if(!file)return send(req,res,404,'Fichier introuvable.');
      if(decoded==='/'||decoded==='/index.html'){
        const html=fs.readFileSync(file,'utf8').replace(/<script\s+src="(?:desktop-auth|desktop-worker)\.js"><\/script>\s*/g,'');
        return send(req,res,200,html,TYPES['.html']);
      }
      res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':'no-store'});
      if(req.method==='HEAD')res.end();else fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    }catch{if(res.headersSent)res.end();else send(req,res,500,JSON.stringify({error:'Site Ludy momentanément indisponible.'}),TYPES['.json']);}
  });
  server.maxRequestsPerSocket=100;return server;
}

export async function startWebServer({config,stateDir,runtimeRoot,port=WEB_BIND_PORT,servicesFactory,serverFactory=createWebHttpServer}={}){
  config=validateWebConfig(config);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Port web invalide.');
  let services,closing;const instanceId=randomUUID();
  const server=serverFactory({config,runtimeRoot,instanceId,services:()=>services});
  const close=()=>closing||=(async()=>{
    const stopped=new Promise(resolve=>server.close(()=>resolve()));server.closeIdleConnections?.();
    try{await services?.close();}finally{server.closeAllConnections?.();await stopped;}
  })();
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,WEB_BIND_HOST,resolve);});
    const factory=servicesFactory||(await import('./services.mjs')).createWebServices;
    services=await factory({config,stateDir,runtimeRoot});
    if(typeof services?.handle!=='function'||typeof services.close!=='function')throw Error('Services web indisponibles.');
    return {origin:config.webOrigin,instanceId,port,close};
  }catch(error){await close().catch(()=>{});throw error;}
}
