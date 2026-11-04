import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {assertLocalProject} from './guard.mjs';
import {parsePickupReferenceCsv} from '../server/pickup-reference.mjs';
import {auditPickupReferenceFile} from '../server/pickup-reference-validation.mjs';
import {REFERENCE_SHA256,VENUE_REVIEWS} from '../server/pickup-reference-evidence.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const REVIEWED_TRIP_SHA='8429cace5a94c237a0e68511a0468f7b458dd5ddf003403c280128eaeb2ae7e8';
async function input(filename){
 if(!path.isAbsolute(filename))throw Error('An absolute CSV path is required.');
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>32*1024*1024)throw Error('Regular bounded CSV required.');return await handle.readFile('utf8');}finally{await handle.close();}
}
export async function main(args=process.argv.slice(2)){
 assertLocalProject();const options={};
 for(let i=0;i<args.length;i++){
  const name=args[i];if(name==='--publish-reviewed-summary'){if(options.publish)throw Error('Duplicate option.');options.publish=true;continue;}
  if(!['--trips','--references'].includes(name)||options[name]||!args[i+1])throw Error('Use --trips PATH --references PATH [--publish-reviewed-summary].');options[name]=args[++i];
 }
 if(!options['--trips']||!options['--references'])throw Error('Both source CSV files are required.');
 const [trips,references]=await Promise.all([input(options['--trips']),input(options['--references'])]);
 const catalog=parsePickupReferenceCsv(references,{filename:path.basename(options['--references'])});
 const evidence=auditPickupReferenceFile(trips,catalog,{filename:path.basename(options['--trips'])});
 const directory=path.join(ROOT,'.local','pickup-reference-validation',evidence.report.source.sha256);
 await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.chmod(directory,0o700);
 for(const [name,value]of [['report.json',evidence.report],['plus-code-evidence.private.json',evidence.privateCodeEvidence]]){
  const target=path.join(directory,name),handle=await fs.open(target,constants.O_CREAT|constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
  try{await handle.chmod(0o600);await handle.writeFile(JSON.stringify(value,null,2)+'\n');}finally{await handle.close();}
 }
 if(options.publish){
  if(catalog.source.sha256!==REFERENCE_SHA256||evidence.report.source.sha256!==REVIEWED_TRIP_SHA||evidence.report.source.duplicateRows)throw Error('Public summary requires the two explicitly reviewed source hashes and unique trips.');
  // This reviewed file was mapped to these local agencies by the authenticated
  // import preview. A different agency in the same city must not see its counts.
  const publicSummary={version:1,checkedAt:evidence.report.checkedAt,source:evidence.report.source,referenceSha256:catalog.source.sha256,agencyIds:{Casablanca:1,Marrakech:2},cities:evidence.report.cities,codeChecks:evidence.report.codeChecks};
  await fs.writeFile(path.join(ROOT,'server','pickup-reference-validation-data.mjs'),'// Aggregate evidence for the explicitly reviewed local files. No trip identifiers or addresses.\nexport default '+JSON.stringify(publicSummary,null,2)+';\n');
 }
 const result={ok:true,report:path.join(directory,'report.json'),published:!!options.publish,source:evidence.report.source,outside:evidence.report.outside,plusCodes:evidence.report.plusCodes,
  cities:Object.fromEntries(Object.entries(evidence.report.cities).map(([city,value])=>[city,{eligible:value.eligibleRows,declaredPeriodEligible:value.eligibleInDeclaredPeriod,aliasCandidates:value.unimportedAliasCandidates,simpleCityLabel:value.simpleCityLabel,recoveredPlusCodeRows:value.plusCodes.recoveredRows}])),
  officialCorrections:VENUE_REVIEWS.filter(row=>row.action==='replace').length,databaseWrites:0,externalRequests:0};
 console.log(JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('Validation interrompue : vérifier les fichiers et le périmètre local ; aucune écriture de base.');process.exitCode=1;});
