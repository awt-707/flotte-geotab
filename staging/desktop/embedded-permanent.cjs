const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

async function readPreference(filename) {
  try {
    const stat=await fs.lstat(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw Error('Invalid permanent preference');
    const value=JSON.parse(await fs.readFile(filename,'utf8'));
    if(!value||value.version!==1||typeof value.enabled!=='boolean'||Object.keys(value).some(key=>!['version','enabled'].includes(key)))throw Error('Invalid permanent preference');
    return value.enabled;
  }catch(error){if(error.code==='ENOENT')return false;throw error;}
}
async function writePreference(filename,enabled) {
  const temporary=filename+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temporary,JSON.stringify({version:1,enabled})+'\n',{flag:'wx',mode:0o600});
    await fs.rename(temporary,filename);
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}

function createPermanentDesktop({app,Tray,Menu,dialog,powerSaveBlocker,stateDir,projectRef,
  getWindow,showWindow,onChange=()=>{},platform=process.platform,execPath=process.execPath,
  iconPath=path.join(__dirname,'assets/icon.ico')}) {
  const supported=platform==='win32',filename=path.join(stateDir,'desktop-permanent.json');
  const loginName='Ludy-'+projectRef;
  let enabled=false,busy=false,quitting=false,tray=null,blocker=null;
  const report=message=>dialog.showErrorBox('Ludy — poste permanent',message);
  function setLogin(value){
    if(app.isPackaged===false)throw Error('Packaged application required');
    app.setLoginItemSettings({name:loginName,openAtLogin:value,path:execPath,args:[]});
  }
  function menuItem(){return {label:'Mode poste permanent',type:'checkbox',checked:enabled,enabled:!busy&&!quitting,click:()=>toggle()};}
  function refresh(){
    if(tray)tray.setContextMenu(Menu.buildFromTemplate([
      {label:'Ouvrir Ludy',click:showWindow},menuItem(),{type:'separator'},
      {label:'Quitter Ludy',click:()=>app.quit()}
    ]));
    onChange();
  }
  function applyWindow(){const win=getWindow();if(win&&!win.isDestroyed())win.webContents.setBackgroundThrottling(!enabled);}
  function stopResources(){
    if(blocker!==null){powerSaveBlocker.stop(blocker);blocker=null;}
    if(tray){tray.destroy();tray=null;}
  }
  function startResources(){
    if(!tray){tray=new Tray(iconPath);tray.setToolTip('Ludy — poste permanent');tray.on('click',showWindow);tray.on('double-click',showWindow);}
    if(blocker===null)blocker=powerSaveBlocker.start('prevent-app-suspension');
  }
  async function initialize(){
    if(!supported)return;
    try {
      if(!await readPreference(filename)||quitting)return;
      // Reopening a newer portable build updates the startup path for this
      // project. It never creates a Windows session or supplies login details.
      startResources();setLogin(true);enabled=true;applyWindow();refresh();
    }catch{
      enabled=false;stopResources();applyWindow();
      report('Le mode poste permanent n’a pas pu être rétabli. Ludy reste ouvert normalement. Réactivez ce mode dans le menu Ludy.');
    }
  }
  async function toggle(){
    if(!supported||busy||quitting)return;
    const previous=enabled;busy=true;refresh();
    try {
      if(!previous){
        const options={type:'question',title:'Ludy — poste permanent',message:'Utiliser cet ordinateur comme poste permanent ?',
          detail:'Ludy démarrera à l’ouverture de votre session Windows. Fermer sa fenêtre le laissera actif près de l’horloge. Tant que Ludy reste ouvert, la veille automatique sera empêchée ; l’écran pourra s’éteindre.\n\nGardez ce dossier Ludy à son emplacement. Connectez-vous à Ludy et activez la participation à la collecte séparément. Aucune session Windows ne sera ouverte automatiquement.',
          buttons:['Activer le mode permanent','Annuler'],defaultId:1,cancelId:1,noLink:true};
        const win=getWindow();const result=await (win&&!win.isDestroyed()?dialog.showMessageBox(win,options):dialog.showMessageBox(options));
        if(result.response!==0||quitting)return;
        startResources();setLogin(true);await writePreference(filename,true);enabled=true;
      }else{
        setLogin(false);await writePreference(filename,false);enabled=false;stopResources();showWindow();
      }
      applyWindow();
    }catch{
      // A failed preference write must not silently change the agreed mode.
      try{setLogin(previous);}catch{}
      enabled=previous;
      if(!previous)stopResources();
      applyWindow();
      report('Le réglage du poste permanent n’a pas pu être enregistré. Le mode précédent est conservé. Réessayez depuis le menu Ludy.');
    }finally{busy=false;if(!quitting)refresh();}
  }
  function shutdown(){
    quitting=true;stopResources();
    // Keep the saved choice and login registration for the next Windows login.
  }
  return {initialize,toggle,menuItem,applyWindow,shutdown,
    get enabled(){return enabled;},get shouldHide(){return enabled&&!!tray&&!quitting;},get supported(){return supported;}};
}
module.exports={createPermanentDesktop,readPreference,writePreference};
