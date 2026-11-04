'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {SHELL_URL,WEB_PREFERENCES,readConfig,validateConfig,isShellURL,isTrustedURL,isAllowedRequest,safeExternalURL,downloadName} = require('./config.cjs');

async function probeStaging(fetchFn, config, signal) {
  const response = await fetchFn(new URL('health',config.serverUrl).href,{redirect:'error',cache:'no-store',signal});
  if (!response.ok || !/application\/json/i.test(response.headers.get('content-type') || '')) throw Object.assign(new Error('Staging non vérifié'),{code:'UNVERIFIED'});
  const reader = response.body?.getReader(); if (!reader) throw Object.assign(new Error('Staging non vérifié'),{code:'UNVERIFIED'});
  let size = 0; const chunks = [];
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > 4096) throw Error('Réponse trop longue'); chunks.push(Buffer.from(result.value)); } }
  catch { await reader.cancel().catch(()=>{}); throw Object.assign(new Error('Staging non vérifié'),{code:'UNVERIFIED'}); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Staging non vérifié'),{code:'UNVERIFIED'}); }
  if (data?.environment !== 'staging' || data?.project !== 'ludy-staging') throw Object.assign(new Error('Staging non vérifié'),{code:'UNVERIFIED'});
}

async function startDesktop(electron, {configPath = path.join(__dirname,'server.json'), platform = process.platform} = {}) {
  const {app,BrowserWindow,session,protocol,ipcMain,dialog,shell,Menu} = electron;
  app.setName('Ludy Staging');
  app.setPath('userData',path.join(app.getPath('appData'),'Ludy Staging'));
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([{scheme:'ludy-client',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  let config,initialState='connecting';
  try { config = readConfig(configPath,{platform}); if (!config.configured) initialState='missing'; }
  catch { config = validateConfig({environment:'staging',serverUrl:null,appName:'Ludy Staging'},{platform});initialState='invalid'; }
  let mainWindow=null,state=initialState,attempt=0,probeController=null,externalPending=false,notificationDecision=null,notificationPrompt=null;
  const windows=new Set(),notificationGrants=new Set();
  const publicState=()=>({state,appName:config.appName,server:config.origin,canRetry:config.configured,operatorLocal:config.mode==='operator-local'});
  const focus=()=>{if(!mainWindow||mainWindow.isDestroyed())return;if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();};
  app.on('second-instance',focus);
  app.on('window-all-closed',()=>{if(platform!=='darwin')app.quit();});
  app.on('before-quit',()=>{attempt++;probeController?.abort();});
  await app.whenReady();
  const browsing=session.fromPartition(config.partition);
  const notificationFile=path.join(app.getPath('userData'),'notifications-'+config.partition.split('-').at(-1)+'.json');
  try {const bytes=await fs.readFile(notificationFile);if(bytes.length<256){const value=JSON.parse(bytes);if(['granted','denied'].includes(value.notifications))notificationDecision=value.notifications;}}catch{}
  if(notificationDecision==='granted'&&config.configured)notificationGrants.add(config.origin);
  const assets=new Map([['/status',['client-ui.html','text/html; charset=utf-8']],['/client-ui.css',['client-ui.css','text/css; charset=utf-8']],['/client-ui.js',['client-ui.js','text/javascript; charset=utf-8']],['/logo.png',['assets/logo-ludy.png','image/png']]]);
  browsing.protocol.handle('ludy-client',async request=>{
    if(!isShellURL(request.url)||request.method!=='GET')return new Response('Introuvable',{status:404});
    const [file,type]=assets.get(new URL(request.url).pathname);
    try { const bytes=await fs.readFile(path.join(__dirname,file));return new Response(bytes,{headers:{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}}); }
    catch { return new Response('Ressource indisponible',{status:404}); }
  });
  browsing.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!isAllowedRequest(details.url,details.resourceType,config)}));
  const trustedContents=contents=>!!contents&&!contents.isDestroyed()&&[...windows].some(win=>win.webContents===contents)&&isTrustedURL(contents.getURL(),config,{blob:true});
  async function requestNotifications(contents,{force=false}={}){
    if(!trustedContents(contents))return false;
    if(notificationPrompt)return notificationPrompt;
    const alreadyGranted=notificationGrants.has(config.origin);
    if(alreadyGranted&&!force)return true;
    if(notificationDecision==='denied'&&!force)return false;
    notificationPrompt=(async()=>{
      try {
        const result=await dialog.showMessageBox(BrowserWindow.fromWebContents(contents),{type:'question',title:config.appName,message:alreadyGranted?'Les notifications de Ludy sont activées.':'Autoriser les notifications de Ludy ?',detail:'Les alertes pourront apparaître sur cet ordinateur. Vous pouvez modifier ce choix dans le menu Affichage.',buttons:alreadyGranted?['Désactiver','Garder les notifications']:['Autoriser','Plus tard'],defaultId:1,cancelId:1,noLink:true});
        if(!trustedContents(contents))return false;
        const allowed=alreadyGranted?result.response!==0:result.response===0;notificationDecision=allowed?'granted':'denied';if(allowed)notificationGrants.add(config.origin);else notificationGrants.delete(config.origin);
        const temporary=notificationFile+'.'+process.pid+'.tmp';
        try {await fs.mkdir(path.dirname(notificationFile),{recursive:true,mode:0o700});await fs.writeFile(temporary,JSON.stringify({notifications:notificationDecision})+'\n',{mode:0o600});await fs.rename(temporary,notificationFile);}catch{await fs.rm(temporary,{force:true}).catch(()=>{});}
        return allowed;
      }catch{return false;}
    })();
    try{return await notificationPrompt;}finally{notificationPrompt=null;}
  }
  browsing.setPermissionCheckHandler((contents,permission,origin)=>permission==='notifications'&&trustedContents(contents)&&isTrustedURL(origin+'/',config)&&notificationGrants.has(config.origin));
  browsing.setPermissionRequestHandler((contents,permission,callback,details)=>{
    if(!trustedContents(contents)||details?.isMainFrame===false){callback(false);return;}
    if(permission==='clipboard-sanitized-write'){callback(true);return;}
    if(permission!=='notifications'){callback(false);return;}
    void requestNotifications(contents).then(callback,()=>callback(false));
  });
  browsing.on('will-download',(event,item,contents)=>{
    const chain=typeof item.getURLChain==='function'?item.getURLChain():[item.getURL()];
    if(!trustedContents(contents)||!chain.length||chain.some(url=>!isTrustedURL(url,config,{blob:true}))){event.preventDefault();return;}
    // No setSavePath: Electron keeps the native Save dialog for every export.
    item.setSaveDialogOptions({title:'Enregistrer le document Ludy',defaultPath:downloadName(item.getFilename()),properties:['showOverwriteConfirmation','createDirectory']});
    item.once('done',(_event,result)=>{if(result==='interrupted'&&contents&&!contents.isDestroyed())void dialog.showMessageBox(BrowserWindow.fromWebContents(contents),{type:'warning',title:config.appName,message:'Le téléchargement a été interrompu.',detail:'Vous pouvez réessayer depuis Ludy.',buttons:['Fermer']});});
  });
  async function external(url,owner,{configuredServer=false}={}){
    const target=configuredServer&&config.mode==='operator-local'&&url===config.serverUrl?url:safeExternalURL(url);if(!target||externalPending||!owner||owner.isDestroyed())return;
    externalPending=true;
    try { const label=new URL(target).protocol==='https:'?new URL(target).hostname:target.split(':')[0];const choice=await dialog.showMessageBox(owner,{type:'question',title:config.appName,message:'Ouvrir ce lien à l’extérieur de Ludy ?',detail:label,buttons:['Ouvrir','Annuler'],defaultId:1,cancelId:1,noLink:true});if(choice.response===0&&!owner.isDestroyed())await shell.openExternal(target); }
    catch { /* A dismissed or unavailable OS browser leaves Ludy unchanged. */ }
    finally { externalPending=false; }
  }
  async function showStatus(next){
    state=next;const ticket=++attempt;probeController?.abort();probeController=null;
    if(!mainWindow||mainWindow.isDestroyed())return ticket;
    await mainWindow.loadURL(SHELL_URL).catch(()=>{});if(ticket===attempt)focus();return ticket;
  }
  async function connect(){
    if(!config.configured||!mainWindow||mainWindow.isDestroyed())return;
    const ticket=await showStatus('connecting');if(ticket!==attempt||!mainWindow||mainWindow.isDestroyed())return;
    const controller=new AbortController();probeController=controller;
    const timeout=setTimeout(()=>controller.abort(),20000);
    try {
      await probeStaging((url,options)=>browsing.fetch(url,options),config,controller.signal);
      if(ticket!==attempt||!mainWindow||mainWindow.isDestroyed())return;
      state='ready';await mainWindow.loadURL(config.serverUrl);
      if(ticket===attempt&&mainWindow&&!mainWindow.isDestroyed())void requestNotifications(mainWindow.webContents);
    } catch(error) { if(ticket===attempt&&mainWindow&&!mainWindow.isDestroyed())await showStatus(error.code==='UNVERIFIED'?'unverified':'offline'); }
    finally { clearTimeout(timeout);if(probeController===controller)probeController=null; }
  }
  function secureWindow(win,{primary=false}={}){
    windows.add(win);const contents=win.webContents;
    contents.on('will-attach-webview',event=>event.preventDefault());
    contents.on('page-title-updated',event=>{event.preventDefault();win.setTitle(config.appName);});
    const navigate=(event,legacyUrl)=>{const url=event.url??legacyUrl;if(isTrustedURL(url,config,{blob:!primary}))return;event.preventDefault();if(trustedContents(contents))void external(url,win);};
    contents.on('will-navigate',navigate);
    contents.on('will-frame-navigate',event=>{if(event.isMainFrame)return;if(!isTrustedURL(event.url,config,{blob:true})&&event.url!=='about:blank')event.preventDefault();});
    contents.on('will-redirect',(event,legacyUrl)=>{if(!isTrustedURL(event.url??legacyUrl,config,{blob:!primary}))event.preventDefault();});
    contents.setWindowOpenHandler(details=>{
      if(!trustedContents(contents))return {action:'deny'};
      if(isTrustedURL(details.url,config,{blob:true})&&windows.size<8)return {action:'allow',overrideBrowserWindowOptions:{width:1050,height:780,title:config.appName,autoHideMenuBar:true,parent:win,webPreferences:{...WEB_PREFERENCES,session:browsing,preload:path.join(__dirname,'shell-preload.cjs')}}};
      void external(details.url,win);return {action:'deny'};
    });
    contents.on('did-create-window',child=>secureWindow(child));
    if(primary){
      contents.on('did-fail-load',(_event,code,_description,url,isMainFrame)=>{if(isMainFrame&&code!==-3&&isTrustedURL(url,config)&&!win.isDestroyed())void showStatus('offline');});
      contents.on('render-process-gone',()=>{if(!win.isDestroyed())void showStatus('offline');});
    }
    win.on('closed',()=>{windows.delete(win);if(win===mainWindow){mainWindow=null;attempt++;probeController?.abort();probeController=null;}});
    return win;
  }
  const shellSender=event=>mainWindow&&!mainWindow.isDestroyed()&&event.sender===mainWindow.webContents&&event.senderFrame===mainWindow.webContents.mainFrame&&event.senderFrame.url===SHELL_URL;
  ipcMain.handle('ludy-client:state',event=>shellSender(event)?publicState():null);
  ipcMain.handle('ludy-client:retry',event=>{if(!shellSender(event)||state==='connecting')return false;void connect();return true;});
  ipcMain.handle('ludy-client:browser',event=>{if(!shellSender(event)||!config.configured)return false;void external(config.serverUrl,mainWindow,{configuredServer:true});return true;});
  function createWindow(){
    mainWindow=secureWindow(new BrowserWindow({width:1440,height:960,minWidth:760,minHeight:540,title:config.appName,backgroundColor:'#f5f6f8',show:false,autoHideMenuBar:true,icon:path.join(__dirname,'assets/icon.png'),webPreferences:{...WEB_PREFERENCES,session:browsing,preload:path.join(__dirname,'shell-preload.cjs')}}),{primary:true});
    mainWindow.once('ready-to-show',focus);void showStatus(initialState).then(()=>{if(config.configured)return connect();});return mainWindow;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(platform==='darwin'?[{label:config.appName,submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]}]:[]),
    {label:'Édition',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'Affichage',submenu:[{label:'Actualiser Ludy',accelerator:'CmdOrCtrl+R',click:()=>{if(state==='ready'&&mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.reload();else void connect();}},{label:'Notifications…',click:()=>{if(mainWindow)void requestNotifications(mainWindow.webContents,{force:true});}},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'}]},
    {label:'Fenêtre',submenu:[{role:'minimize'},{role:'close'}]}
  ]));
  app.on('activate',()=>{if(!mainWindow)createWindow();else focus();});
  createWindow();return {config,get window(){return mainWindow;},get state(){return state;},connect};
}

module.exports={startDesktop,probeStaging};
if(require.main===module){
  const electron=require('electron');
  const operation=process.argv.includes('--diagnostic')
    ? require('./diagnostic.cjs').runDiagnostic(electron).then(()=>electron.app.quit())
    : startDesktop(electron);
  void operation.catch(()=>{electron.dialog.showErrorBox('Ludy Staging','L’application n’a pas pu démarrer. Réessayez avec une archive complète.');electron.app.quit();});
}
