import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const DESKTOP_ORIGIN = 'http://127.0.0.1:4173';
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon'};
const VENDORS = new Map([
  ['/vendor/supabase.js','@supabase/supabase-js/dist/umd/supabase.js'],
  ['/vendor/leaflet.js','leaflet/dist/leaflet.js'], ['/vendor/leaflet.css','leaflet/dist/leaflet.css'],
  ['/vendor/xlsx.full.min.js','xlsx/dist/xlsx.full.min.js'],
  ['/vendor/jspdf.umd.min.js','jspdf/dist/jspdf.umd.min.js'],
  ['/vendor/jspdf.plugin.autotable.min.js','jspdf-autotable/dist/jspdf.plugin.autotable.min.js'],
  ['/vendor/pdf-lib.min.js','pdf-lib/dist/pdf-lib.min.js'], ['/vendor/fontkit.umd.min.js','@pdf-lib/fontkit/dist/fontkit.umd.min.js'],
  ['/vendor/bidi.min.js','bidi-js/dist/bidi.min.js']
]);
const FONTS = new Map([['/vendor/barlow.css','barlow'],['/vendor/barlow-semi-condensed.css','barlow-semi-condensed']]);
const EXTENSIONS = new Map([['/uber-extension/ludy-uber-chromium.zip','ludy-uber-chromium.zip'],['/uber-extension/ludy-uber-firefox.zip','ludy-uber-firefox.zip'],['/uber-extension/firefox.zip','ludy-uber-firefox.zip']]);

function publicConfig(config) {
  if (!config || config.environment !== 'production' || !/^[a-z0-9]{20}$/.test(config.projectRef || '') ||
      config.supabaseUrl !== `https://${config.projectRef}.supabase.co` || typeof config.publishableKey !== 'string' ||
      config.publishableKey.length > 4096 || /[\s\x00-\x1f]/.test(config.publishableKey)) throw Error('Configuration publique de production invalide.');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) {
    let claims;
    try { const parts=config.publishableKey.split('.'); if(parts.length!==3)throw Error(); claims=JSON.parse(Buffer.from(parts[1],'base64url')); } catch { throw Error('Clé publique Supabase requise.'); }
    if (claims.role !== 'anon' || claims.ref && claims.ref !== config.projectRef) throw Error('Clé publique Supabase requise.');
  }
  return Object.freeze({SUPABASE_URL:config.supabaseUrl,SUPABASE_ANON_KEY:config.publishableKey,
    SUPABASE_PROJECT_REF:config.projectRef,ENVIRONMENT:'production',DESKTOP_PRODUCTION:true,STAGING:false,
    GEOTAB_ENABLED:false,GEOTAB_LOCAL:true,SOURCE_MODE:'mixed',AUTH_STORAGE_KEY:`ludy-production-${config.projectRef}-auth`});
}
function contained(root, filename) {
  try { const real=fs.realpathSync(filename); return real.startsWith(root+path.sep) && fs.statSync(real).isFile() ? real : null; } catch { return null; }
}
function send(request,response,status,body,type='text/plain; charset=utf-8') {
  response.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});
  response.end(request.method==='HEAD' ? undefined : body);
}

/** No socket, provider, database or session side effects during construction. */
export function createDesktopHttpServer({config,runtimeRoot,instanceId=randomUUID(),services}) {
  const cfg=publicConfig(config);
  if (!path.isAbsolute(runtimeRoot || '')) throw Error('Répertoire de l’application requis.');
  const siteRoot=fs.realpathSync(path.join(runtimeRoot,'site'));
  const modules=fs.realpathSync(path.join(runtimeRoot,'node_modules'));
  const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self' "+cfg.SUPABASE_URL+' '+cfg.SUPABASE_URL.replace('https:','wss:')+" https://photon.komoot.io; frame-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
  function staticFile(urlPath) {
    if (urlPath === '/uber-extension' || urlPath === '/uber-extension/') return contained(siteRoot,path.join(siteRoot,'uber-extension.html'));
    if (VENDORS.has(urlPath)) return contained(modules,path.join(modules,VENDORS.get(urlPath)));
    if (/^\/vendor\/images\/[a-zA-Z0-9@._-]+\.png$/.test(urlPath)) return contained(modules,path.join(modules,'leaflet/dist/images',path.basename(urlPath)));
    if (/^\/vendor\/files\/barlow(?:-semi-condensed)?-[a-z0-9-]+\.woff2?$/.test(urlPath)) {
      const family=path.basename(urlPath).startsWith('barlow-semi-condensed-')?'barlow-semi-condensed':'barlow';
      return contained(modules,path.join(modules,'@fontsource',family,'files',path.basename(urlPath)));
    }
    if (urlPath.startsWith('/vendor/') || urlPath.split('/').some(part=>part.startsWith('.')||part.includes('\\'))) return null;
    return contained(siteRoot,path.resolve(siteRoot,'.'+(urlPath==='/'?'/index.html':urlPath)));
  }
  return http.createServer(async(request,response)=>{
    response.setHeader('Content-Security-Policy',csp);
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Frame-Options','SAMEORIGIN');
    const address=request.socket.remoteAddress;
    if(request.headers.host!=='127.0.0.1:4173' || !['127.0.0.1','::ffff:127.0.0.1'].includes(address)) return send(request,response,403,'Hôte refusé.');
    if(!request.url?.startsWith('/') || request.url.startsWith('//')) return send(request,response,400,'Adresse invalide.');
    try {
      const url=new URL(request.url,DESKTOP_ORIGIN);
      if(url.pathname.startsWith('/api/')) {
        if(url.pathname.startsWith('/api/desktop/')) {
          if(request.headers.origin && request.headers.origin!==DESKTOP_ORIGIN || request.headers['sec-fetch-site']==='cross-site') return send(request,response,403,'Origine refusée.');
          if(!['GET','HEAD'].includes(request.method) && (request.headers.origin!==DESKTOP_ORIGIN || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']||''))) return send(request,response,403,'Origine ou format refusé.');
        }
        const active=typeof services==='function'?services():services;
        if(!active) return send(request,response,503,'Application en cours de démarrage.');
        if(await active.handle(request,response)) return;
        return send(request,response,404,'Route inconnue.');
      }
      if(!['GET','HEAD'].includes(request.method)) return send(request,response,405,'Méthode non permise.');
      if(url.pathname==='/health') return send(request,response,200,JSON.stringify({environment:'production',projectRef:config.projectRef,instanceId}),TYPES['.json']);
      if(url.pathname==='/config.js') return send(request,response,200,'window.FLOTTE_CONFIG = Object.freeze('+JSON.stringify(cfg)+');\n',TYPES['.js']);
      if(EXTENSIONS.has(url.pathname)) {
        const root=path.join(runtimeRoot,'uber-extension'),name=EXTENSIONS.get(url.pathname),file=contained(root,path.join(root,name));
        if(!file)return send(request,response,404,'Archive indisponible.');
        response.setHeader('Content-Disposition','attachment; filename="'+name+'"');
        response.writeHead(200,{'Content-Type':'application/zip','Content-Length':fs.statSync(file).size,'Cache-Control':'no-store'});
        if(request.method==='HEAD')response.end();else fs.createReadStream(file).on('error',()=>response.destroy()).pipe(response);
        return;
      }
      if(FONTS.has(url.pathname)) {
        const family=FONTS.get(url.pathname),files=[400,500,600,700].map(weight=>contained(modules,path.join(modules,'@fontsource',family,weight+'.css')));
        if(files.some(file=>!file))return send(request,response,404,'Police indisponible.');
        return send(request,response,200,files.map(file=>fs.readFileSync(file,'utf8')).join('\n'),TYPES['.css']);
      }
      let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{return send(request,response,400,'Adresse invalide.');}
      if(decoded.includes('\0'))return send(request,response,400,'Adresse invalide.');
      if(decoded==='/spreadsheet-worker.js')response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'");
      const file=staticFile(decoded);
      if(!file)return send(request,response,404,'Fichier introuvable.');
      response.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Content-Length':fs.statSync(file).size,'Cache-Control':'no-store'});
      if(request.method==='HEAD')response.end();else fs.createReadStream(file).on('error',()=>response.destroy()).pipe(response);
    } catch {
      if(response.headersSent)response.end();else send(request,response,500,'Application momentanément indisponible.');
    }
  });
}

export async function startDesktopServer({config,stateDir,runtimeRoot,sendStatus=()=>{},servicesFactory,serverFactory=createDesktopHttpServer}={}) {
  const instanceId=randomUUID();let services,closing;
  const server=serverFactory({config,runtimeRoot,instanceId,services:()=>services});
  const close=()=>closing ||= (async()=>{
    const stopped=new Promise(resolve=>server.close(()=>resolve()));server.closeIdleConnections?.();
    try {await services?.close();} finally {server.closeAllConnections?.();await stopped;}
  })();
  try {
    await new Promise((resolve,reject)=>{
      const failed=error=>{server.off('listening',ready);reject(error);};
      const ready=()=>{server.off('error',failed);resolve();};
      server.once('error',failed);server.once('listening',ready);server.listen(4173,'127.0.0.1');
    });
    const factory=servicesFactory || (await import('./services.mjs')).createDesktopServices;
    services=await factory({config,stateDir,runtimeRoot,onStatus:sendStatus});
    if(typeof services?.handle!=='function'||typeof services.close!=='function')throw Error('Services de bureau indisponibles.');
    return {origin:DESKTOP_ORIGIN,instanceId,close,pause:()=>services.pause(),resume:()=>services.resume()};
  } catch(error) {
    await close().catch(()=>{});
    if(error.code==='EADDRINUSE')throw Object.assign(Error('Le port local 4173 est déjà utilisé. Fermez l’autre instance Ludy avant de relancer.'),{code:'DESKTOP_PORT_BUSY'});
    throw error;
  }
}
