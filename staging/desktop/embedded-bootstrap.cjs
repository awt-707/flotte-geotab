const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {validateEmbeddedConfig,LOCAL_ORIGIN}=require('./embedded-config.cjs');

function attachEmbeddedBootstrap(parentPort,{load=filename=>import(pathToFileURL(filename).href),exit=code=>process.exit(code)}={}) {
  let nonce=null,server=null,chain=Promise.resolve(),stopped=false;
  const send=message=>parentPort.postMessage({...message,nonce});
  async function message(input){
    if(input?.type==='init') {
      if(nonce!==null||typeof input.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(input.nonce))return;
      nonce=input.nonce;
      const config=validateEmbeddedConfig(input.config);
      if(!path.isAbsolute(input.runtimeRoot)||!path.isAbsolute(input.stateDir))throw Error('Invalid runtime paths');
      const module=await load(path.join(input.runtimeRoot,'desktop-runtime','server.mjs'));
      server=await module.startDesktopServer({config,stateDir:input.stateDir,runtimeRoot:input.runtimeRoot,sendStatus:value=>send({type:'status',state:typeof value==='string'?value:value?.state})});
      if(server?.origin!==LOCAL_ORIGIN||typeof server?.close!=='function'||typeof server.instanceId!=='string')throw Error('Invalid local service');
      send({type:'ready',origin:server.origin,instanceId:server.instanceId,projectRef:config.projectRef});
    } else if(nonce&&input?.nonce===nonce&&server) {
      if(input.type==='stop'){stopped=true;await server.close();exit(0);}
      else if(input.type==='pause')await server.pause?.();
      else if(input.type==='resume'||input.type==='browser-installed')await server.resume?.();
    }
  }
  parentPort.on('message',event=>{
    if(stopped)return;
    chain=chain.then(()=>message(event.data)).catch(async()=>{stopped=true;send({type:'failed'});try{await server?.close();}catch{}exit(1);});
  });
  return {settled:()=>chain};
}
module.exports={attachEmbeddedBootstrap};
if(process.parentPort)attachEmbeddedBootstrap(process.parentPort);
