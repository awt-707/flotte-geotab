const path=require('node:path');
const fs=require('node:fs/promises');
const {readEmbeddedConfig,LOCAL_ORIGIN,trustedEmbeddedURL,allowedEmbeddedRequest,stateDirectory}=require('./embedded-config.cjs');
const {createEmbeddedSupervisor}=require('./embedded-supervisor.cjs');
const {createPermanentDesktop}=require('./embedded-permanent.cjs');
const WEB_PREFERENCES=Object.freeze({sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false});

async function startEmbeddedDesktop(electron,{configPath=path.join(__dirname,'embedded.json'),runtimeRoot=path.join(process.resourcesPath||__dirname,'ludy-runtime'),platform=process.platform}={}) {
  const {app,BrowserWindow,session,dialog,shell,Menu,powerMonitor,utilityProcess,Tray,powerSaveBlocker}=electron;
  let config;try{config=readEmbeddedConfig(configPath);}catch{dialog.showErrorBox('Ludy','La configuration publique de cette application est absente ou invalide. Demandez une nouvelle version.');app.quit();return null;}
  app.setName('Ludy');const stateDir=stateDirectory(app,config);app.setPath('userData',stateDir);app.enableSandbox();
  if(!app.requestSingleInstanceLock()){app.quit();return null;}
  await fs.mkdir(stateDir,{recursive:true,mode:0o700});
  let window=null,stopping=false,stopped=false,externalPending=false,permanent=null;
  const windows=new Set();
  const focus=()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}};
  app.on('second-instance',focus);
  await app.whenReady();
  const browsing=session.fromPartition('persist:ludy-production-'+config.projectRef);
  const supervisor=createEmbeddedSupervisor({utilityProcess,config,stateDir,runtimeRoot,onStatus:status=>{
    if(status.state==='failed'&&!stopping&&window){dialog.showErrorBox('Ludy','Le service local s’est arrêté. Fermez puis relancez Ludy.');app.quit();}
  }});
  app.on('before-quit',event=>{
    if(stopped)return;event.preventDefault();if(stopping)return;stopping=true;permanent?.shutdown();
    void supervisor.stop().finally(()=>{stopped=true;app.quit();});
  });
  powerMonitor.on('suspend',()=>supervisor.pause());powerMonitor.on('resume',()=>supervisor.resume());
  browsing.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!allowedEmbeddedRequest(details.url,details.resourceType,config)}));
  const owned=contents=>!!contents&&!contents.isDestroyed()&&[...windows].some(win=>win.webContents===contents)&&trustedEmbeddedURL(contents.getURL(),{blob:true});
  let notifications=false;
  browsing.setPermissionCheckHandler((contents,permission)=>permission==='notifications'&&notifications&&owned(contents));
  browsing.setPermissionRequestHandler((contents,permission,callback,details)=>{
    if(!owned(contents)||details?.isMainFrame===false)return callback(false);
    if(permission==='clipboard-sanitized-write')return callback(true);
    if(permission!=='notifications')return callback(false);
    if(notifications)return callback(true);
    void dialog.showMessageBox(BrowserWindow.fromWebContents(contents),{type:'question',title:'Ludy',message:'Autoriser les notifications Ludy sur cet ordinateur ?',buttons:['Autoriser','Plus tard'],defaultId:1,cancelId:1}).then(result=>{notifications=result.response===0;callback(notifications&&owned(contents));},()=>callback(false));
  });
  browsing.on('will-download',(event,item,contents)=>{
    const chain=item.getURLChain();
    if(!owned(contents)||!chain.length||chain.some(url=>!trustedEmbeddedURL(url,{blob:true}))){event.preventDefault();return;}
    const filename=path.basename(String(item.getFilename()).replaceAll('\\','/')).replace(/[<>:"|?*\u0000-\u001f]/g,'_');
    item.setSaveDialogOptions({title:'Enregistrer le document Ludy',defaultPath:filename||'document',properties:['showOverwriteConfirmation','createDirectory']});
  });
  async function external(url,owner){
    let parsed;try{parsed=new URL(url);}catch{return;}
    if(!['https:','mailto:','tel:'].includes(parsed.protocol)||parsed.username||parsed.password||/[\u0000-\u001f]/.test(url)||externalPending)return;
    externalPending=true;
    try{const result=await dialog.showMessageBox(owner,{type:'question',title:'Ludy',message:'Ouvrir ce lien dans une autre application ?',detail:parsed.protocol==='https:'?parsed.hostname:parsed.protocol,buttons:['Ouvrir','Annuler'],defaultId:1,cancelId:1});if(result.response===0&&!owner.isDestroyed())await shell.openExternal(url);}finally{externalPending=false;}
  }
  function secure(win){
    windows.add(win);win.on('closed',()=>windows.delete(win));
    win.webContents.on('will-attach-webview',event=>event.preventDefault());
    win.webContents.on('will-navigate',(event,url)=>{if(!trustedEmbeddedURL(url,{blob:true})){event.preventDefault();void external(url,win);}});
    win.webContents.setWindowOpenHandler(({url})=>{
      if(trustedEmbeddedURL(url,{blob:true})&&windows.size<8)return{action:'allow',overrideBrowserWindowOptions:{width:1050,height:780,parent:win,webPreferences:{...WEB_PREFERENCES,session:browsing}}};
      void external(url,win);return{action:'deny'};
    });
    win.webContents.on('did-create-window',secure);return win;
  }
  function createWindow(){
    window=secure(new BrowserWindow({width:1440,height:960,minWidth:760,minHeight:540,title:'Ludy',backgroundColor:'#f5f6f8',show:false,icon:path.join(__dirname,'assets/icon.png'),webPreferences:{...WEB_PREFERENCES,session:browsing,backgroundThrottling:!permanent?.enabled}}));
    window.on('close',event=>{if(!stopping&&permanent?.shouldHide){event.preventDefault();window.hide();}});
    window.once('ready-to-show',focus);void window.loadURL(LOCAL_ORIGIN+'/');
  }
  function renderMenu(){Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(platform==='darwin'?[{role:'appMenu'}]:[]),{label:'Ludy',submenu:[{label:'Recharger',click:()=>window?.webContents.reload()},...(permanent?.supported?[permanent.menuItem()]:[]),{type:'separator'},{label:'Quitter Ludy',click:()=>app.quit()}]},{role:'editMenu'},{role:'viewMenu'}
  ]));}
  permanent=createPermanentDesktop({app,Tray,Menu,dialog,powerSaveBlocker,stateDir,projectRef:config.projectRef,platform,getWindow:()=>window,showWindow:()=>{if((!window||window.isDestroyed())&&supervisor.running)createWindow();else focus();},onChange:renderMenu});
  await permanent.initialize();renderMenu();
  app.on('window-all-closed',()=>{if(platform!=='darwin'&&!permanent.shouldHide)app.quit();});
  app.on('activate',()=>{if(!window||window.isDestroyed()){if(supervisor.running)createWindow();}else focus();});
  try{await supervisor.start();createWindow();}
  catch{dialog.showErrorBox('Ludy','Impossible de démarrer le service local. Fermez toute autre instance utilisant le port 4173, puis relancez Ludy.');app.quit();}
  return {supervisor,config,permanent,get window(){return window;}};
}
module.exports={startEmbeddedDesktop,WEB_PREFERENCES};
if(require.main===module)startEmbeddedDesktop(require('electron')).catch(()=>{const {app,dialog}=require('electron');dialog.showErrorBox('Ludy','Le démarrage de Ludy a échoué.');app.quit();});
