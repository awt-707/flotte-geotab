// Executes the exact bundled offline diagnostic, using no provider or database.
import {_electron as electron} from 'playwright';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const dir=await mkdtemp(path.join(os.tmpdir(),'ludy-diagnostic-e2e-'));
const diagnostic=fileURLToPath(new URL('../desktop/diagnostic.cjs',import.meta.url));
const entry=path.join(dir,'entry.cjs'),reportPath=path.join(dir,'result.json');
let application;
try{
  await writeFile(entry,`const electron=require('electron');require(${JSON.stringify(diagnostic)}).runDiagnostic(electron,{saveReport:async report=>{require('node:fs').writeFileSync(${JSON.stringify(reportPath)},JSON.stringify(report));}}).then(()=>electron.app.quit(),()=>electron.app.exit(1));`);
  application=await electron.launch({executablePath:process.env.ELECTRON_TEST_EXECUTABLE,args:[entry],timeout:30000});
  await new Promise(resolve=>application.process().once('exit',resolve));
  const report=JSON.parse(await readFile(reportPath,'utf8'));
  assert.equal(report.ok,true,JSON.stringify(report.checks));assert.equal(report.unexpectedRequests,0);
  assert.equal(report.applicationWorkflowsTested,false);assert.equal(report.platform,process.platform);
  console.log(JSON.stringify({ok:true,platform:report.platform,checks:report.checks.length,providerRequests:0,applicationWorkflowsTested:false}));
}finally{await application?.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
