const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {LOCAL_ORIGIN,validateEmbeddedConfig}=require('./embedded-config.cjs');

function createEmbeddedSupervisor({utilityProcess,config,stateDir,runtimeRoot,onStatus=()=>{},timeoutMs=30000,stopTimeoutMs=5000,setTimer=setTimeout,clearTimer=clearTimeout}) {
  config=validateEmbeddedConfig(config);
  if(!path.isAbsolute(stateDir)||!path.isAbsolute(runtimeRoot))throw Error('Chemins du service local invalides.');
  let child=null,ready=null,starting=null,stopping=null,nonce=null,timer=null,browserInstaller=null,browserTimer=null,browserAttempted=false;
  const status=value=>{try{onStatus(value);}catch{}};
  const environment=()=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR)$/i.test(key))),PLAYWRIGHT_BROWSERS_PATH:path.join(stateDir,'browsers')});
  function installBrowser(){
    if(browserAttempted||browserInstaller||!ready||stopping)return;
    browserAttempted=true;
    try {
      browserInstaller=utilityProcess.fork(path.join(runtimeRoot,'node_modules','playwright','cli.js'),['install','chromium'],{cwd:stateDir,env:environment(),stdio:'ignore',serviceName:'Ludy browser setup',allowLoadingUnsignedLibraries:false});
      const installer=browserInstaller;status({state:'browser-installing'});
      browserTimer=setTimer(()=>installer.kill(),20*60*1000);
      installer.once('exit',code=>{clearTimer(browserTimer);browserInstaller=null;if(stopping)return;if(code===0&&child&&ready){status({state:'browser-installed'});child.postMessage({type:'browser-installed',nonce});}else status({state:'browser-install-failed'});});
    }catch{browserInstaller=null;status({state:'browser-install-failed'});}
  }
  function start() {
    if(stopping)return Promise.reject(Error('Arrêt du service local en cours.'));
    if(ready)return Promise.resolve(ready);if(starting)return starting;
    nonce=randomUUID();
    const pending=new Promise((resolve,reject)=>{
      let settled=false;
      const fail=()=>{if(!settled){settled=true;clearTimer(timer);reject(Error('Le service local Ludy n’a pas pu démarrer. Fermez toute autre instance utilisant le port 4173.'));}};
      // Only a small operating-system environment is inherited. No provider or
      // Supabase secret from the developer shell is passed into the application.
      try{child=utilityProcess.fork(path.join(runtimeRoot,'desktop-runtime','embedded-bootstrap.cjs'),[],{cwd:stateDir,env:environment(),stdio:'ignore',serviceName:'Ludy local',allowLoadingUnsignedLibraries:false});}
      catch{fail();return;}
      const current=child;
      timer=setTimer(()=>{fail();current.kill();},timeoutMs);
      current.on('message',message=>{
        if(current!==child||message?.nonce!==nonce)return;
        if(message.type==='ready') {
          if(message.origin!==LOCAL_ORIGIN||message.projectRef!==config.projectRef||typeof message.instanceId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(message.instanceId)){fail();current.kill();return;}
          if(settled)return;settled=true;clearTimer(timer);ready={origin:message.origin,instanceId:message.instanceId,projectRef:message.projectRef};status({state:'ready'});resolve(ready);
        } else if(message.type==='failed'){fail();current.kill();}
        else if(message.type==='status'&&message.state==='browser-install-required')installBrowser();
        else if(message.type==='status'&&['starting','paused','running','stopping','degraded'].includes(message.state))status({state:message.state});
      });
      current.once('exit',()=>{if(current!==child)return;clearTimer(timer);child=null;ready=null;fail();status({state:stopping?'stopped':'failed'});});
      current.once('spawn',()=>{if(current===child)current.postMessage({type:'init',nonce,config,stateDir,runtimeRoot});});
    });
    starting=pending;
    pending.then(()=>{if(starting===pending)starting=null;},()=>{if(starting===pending)starting=null;});
    return pending;
  }
  function control(type){if(child&&ready)child.postMessage({type,nonce});}
  function stop(){
    if(stopping)return stopping;
    if(browserInstaller){clearTimer(browserTimer);browserInstaller.kill();browserInstaller=null;}
    if(!child)return Promise.resolve();
    const current=child;
    stopping=new Promise(resolve=>{
      const killTimer=setTimer(()=>current.kill(),stopTimeoutMs);
      current.once('exit',()=>{clearTimer(killTimer);stopping=null;resolve();});
      current.postMessage({type:'stop',nonce});
    });return stopping;
  }
  return {start,stop,pause:()=>control('pause'),resume:()=>control('resume'),get running(){return !!ready;}};
}
module.exports={createEmbeddedSupervisor};
