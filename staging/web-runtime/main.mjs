import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readWebConfig} from './config.mjs';
import {startWebServer} from './server.mjs';

const options={};
for(let i=2;i<process.argv.length;i++){
  const flag=process.argv[i];
  if(!['--config','--state-dir'].includes(flag)||options[flag]||!process.argv[i+1])throw Error('Usage : node web-runtime/main.mjs --config /chemin/web-public.json --state-dir /chemin/etat-web');
  options[flag]=path.resolve(process.argv[++i]);
}
if(!options['--config']||!options['--state-dir'])throw Error('La configuration et un dossier privé propres au site sont requis.');
const config=readWebConfig(options['--config']);
const runtimeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const server=await startWebServer({config,stateDir:options['--state-dir'],runtimeRoot});
process.stdout.write(JSON.stringify({ready:true,mode:'web',origin:server.origin,port:server.port})+'\n');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void server.close().finally(()=>process.exit(0)));
