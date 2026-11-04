import {privateModeValid} from './private-files.mjs';
import {constants} from 'node:fs';
import {open,mkdir,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

const ids=['bolt','geotab','myclicar'];
const fail=()=>Object.assign(new Error('Préférences de reprise des connecteurs indisponibles. La pause reste possible.'),{status:503});

// Only the operator's intent is durable here. Provider health is never restored from this file.
export function createConnectorState({path}={}) {
  if(path!==undefined&&!isAbsolute(path))throw new TypeError('Chemin local absolu requis.');
  let loaded=false,state={bolt:false,geotab:false,myclicar:false},queue=Promise.resolve(),error=null;
  const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
  async function load() {
    if(loaded)return;
    if(!path){loaded=true;return;}
    let file;
    try {
      file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=await file.stat();if(!stat.isFile()||!privateModeValid(stat,0o600,path)||stat.size>4096)throw fail();
      const data=JSON.parse(await file.readFile('utf8'));
      if(data.version!==1||['bolt','geotab'].some(id=>typeof data.enabled?.[id]!=='boolean')||data.enabled.myclicar!==undefined&&typeof data.enabled.myclicar!=='boolean')throw fail();
      state={bolt:data.enabled.bolt,geotab:data.enabled.geotab,myclicar:data.enabled.myclicar===true};loaded=true;error=null;
    }catch(e){if(e.code==='ENOENT'){loaded=true;error=null;return;}error=fail().message;throw fail();}
    finally{await file?.close();}
  }
  async function save(next) {
    if(!path){state=next;return;}
    const temporary=path+'.'+randomUUID()+'.tmp';let file;
    try {
      await mkdir(dirname(path),{recursive:true,mode:0o700});
      file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await file.writeFile(JSON.stringify({version:1,enabled:next})+'\n');await file.sync();await file.close();file=null;
      await rename(temporary,path);state=next;error=null;
    }catch{error=fail().message;throw fail();}
    finally{await file?.close();await rm(temporary,{force:true}).catch(()=>{});}
  }
  return {
    read:()=>serial(async()=>{await load();return {...state};}),
    set:(id,enabled)=>serial(async()=>{if(!ids.includes(id)||typeof enabled!=='boolean')throw new TypeError('Connecteur ou état invalide.');await load();await save({...state,[id]:enabled});return {...state};}),
    enabled:id=>state[id]===true,
    get error(){return error;}
  };
}
