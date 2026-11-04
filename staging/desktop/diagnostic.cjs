'use strict';
// Offline checks of the real desktop container. No saved config or user session
// is read. The test origin is served in-process, never by a network server.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {validateConfig} = require('./config.cjs');
const ORIGIN = 'https://diagnostic.example.test';
const configInput = {environment:'staging',serverUrl:ORIGIN,appName:'Ludy — test de lancement'};

function pdfFixture() {
  const stream='BT /F1 16 Tf 40 80 Td (Ludy - document de test) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 140] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=pdf.length;pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  return pdf+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
function buildReport({platform,arch,versions,checks,unexpectedRequests,at=new Date().toISOString()}) {
  return {format:'ludy-desktop-validation-v1',testedAt:at,platform,architecture:arch,
    applicationVersion:require('./package.json').version,electron:versions.electron,chromium:versions.chrome,
    scope:'offline_desktop_container',ok:checks.length>=7&&checks.every(c=>c.passed)&&unexpectedRequests===0,
    checks:checks.map(c=>({name:c.name,passed:c.passed===true})),networkRequests:0,unexpectedRequests,
    applicationWorkflowsTested:false,manualChecks:['Ouvrir la version reliée au serveur et se connecter.','Vérifier CA, Caisse et carte avec son compte.','Enregistrer et ouvrir un export CSV et un PDF.','Vérifier une notification système et la reprise après fermeture.'],
    note:'Ce rapport valide le conteneur sur cette machine. Il ne valide pas la connexion au serveur ni les données métier.'};
}
async function until(predicate,timeout=15000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await predicate();if(value)return value;await new Promise(r=>setTimeout(r,80));}
  throw Error('Diagnostic timeout');
}
async function runDiagnostic(electron,{saveReport}={}) {
  const {app,session,BrowserWindow,dialog}=electron;
  if(app.isReady())throw Error('Diagnostic must start before Electron is ready');
  const temporary=syncFs.mkdtempSync(path.join(os.tmpdir(),'ludy-desktop-check-'));
  app.setPath('appData',temporary);
  const configPath=path.join(temporary,'server.json');
  syncFs.writeFileSync(configPath,JSON.stringify(configInput),{mode:0o600});
  const config=validateConfig(configInput),checks=[],requests=[],downloads=[];
  let unexpectedRequests=0,runtime,cleaning=false;
  const keepCleanupAlive=event=>{if(cleaning)event.preventDefault();};
  app.on('before-quit',keepCleanupAlive);
  const check=(name,passed)=>{checks.push({name,passed:!!passed});if(!passed)throw Error('Diagnostic failed');};
  const html='<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Test Ludy</title><style>body{font:18px system-ui;margin:40px;max-width:700px}h1{font-size:28px}p{line-height:1.6}</style><h1>Vérification de Ludy</h1><p>Le test vérifie le lancement, l’affichage, les fenêtres PDF et les exports sur cet ordinateur.</p><p>Aucune connexion ni donnée de flotte n’est utilisée. Un rapport sera proposé à la fin.</p><a id="export" href="/test.csv" download="ludy-test.csv">Export de test</a></html>';
  app.once('ready',()=>{
    const browsing=session.fromPartition(config.partition);
    for(const scheme of ['https','http'])browsing.protocol.handle(scheme,request=>{
      const url=new URL(request.url);requests.push(url.pathname);
      if(url.origin!==ORIGIN||request.method!=='GET'){unexpectedRequests++;return new Response('Refusé',{status:403});}
      if(url.pathname==='/health')return Response.json({environment:'staging',project:'ludy-staging'});
      if(url.pathname==='/')return new Response(html,{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'"}});
      if(url.pathname==='/test.csv')return new Response('test,resultat\nludy,ok\n',{headers:{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="ludy-test.csv"'}});
      if(url.pathname==='/favicon.ico')return new Response(null,{status:204});
      unexpectedRequests++;return new Response('Refusé',{status:404});
    });
  });
  try {
    // Do not request or change OS notification permission during offline checks.
    const testElectron={...electron,dialog:{...dialog,showMessageBox:async()=>({response:1})}};
    runtime=await require('./main.cjs').startDesktop(testElectron,{configPath});
    if(!runtime)throw Error('Diagnostic window missing');
    await until(()=>runtime.state==='ready'&&runtime.window?.webContents.getURL()===ORIGIN+'/');
    await until(()=>runtime.window.webContents.executeJavaScript('document.readyState === "complete"').catch(()=>false));
    check('Lancement et affichage',await runtime.window.webContents.executeJavaScript('document.querySelector("h1")?.textContent === "Vérification de Ludy"'));
    check('Environnement de test reconnu',requests.includes('/health'));
    const isolation=await runtime.window.webContents.executeJavaScript('({node:typeof window.require,process:typeof window.process,bridge:typeof window.ludyClient})');
    check('Isolation de la page',Object.values(isolation).every(value=>value==='undefined'));
    const preferences=runtime.window.webContents.getLastWebPreferences();
    check('Protection du conteneur',preferences.sandbox&&preferences.contextIsolation&&!preferences.nodeIntegration);
    runtime.window.setSize(760,540);
    check('Affichage sans débordement',await runtime.window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'));
    const before=new Set(BrowserWindow.getAllWindows());
    await runtime.window.webContents.executeJavaScript(`window.open(URL.createObjectURL(new Blob([${JSON.stringify(pdfFixture())}],{type:'application/pdf'})),'_blank','noopener'); void 0`);
    const popup=await until(()=>BrowserWindow.getAllWindows().find(window=>!before.has(window)));
    await until(()=>popup.webContents.getURL().startsWith('blob:'+ORIGIN+'/'));
    check('Fenêtre PDF',popup.webContents.getLastWebPreferences().sandbox===true);
    popup.close();
    session.fromPartition(config.partition).once('will-download',(event,item)=>{downloads.push(item.getSaveDialogOptions());event.preventDefault();});
    await runtime.window.webContents.executeJavaScript('document.querySelector("#export").click(); void 0');
    await until(()=>downloads.length===1);
    check('Export proposé à l’utilisateur',downloads[0].defaultPath==='ludy-test.csv');
    check('Aucune requête externe',unexpectedRequests===0);
  } catch {checks.push({name:'Fin des vérifications automatiques',passed:false});}
  const report=buildReport({platform:process.platform,arch:process.arch,versions:process.versions,checks,unexpectedRequests});
  try {
    if(saveReport)await saveReport(report);
    else {
      await dialog.showMessageBox(runtime?.window||undefined,{type:report.ok?'info':'warning',title:'Test Ludy terminé',message:report.ok?'Les contrôles automatiques ont réussi.':'Un contrôle n’a pas pu être terminé.',detail:'Enregistre le rapport pour le transmettre. Les essais de connexion, de données et de notifications restent à faire sur la version reliée au serveur.',buttons:['Enregistrer le rapport'],noLink:true});
      const choice=await dialog.showSaveDialog(runtime?.window||undefined,{title:'Enregistrer le rapport de test Ludy',defaultPath:path.join(app.getPath('downloads'),`Ludy-test-${process.platform}-${process.arch}.json`),filters:[{name:'Rapport JSON',extensions:['json']}],properties:['showOverwriteConfirmation','createDirectory']});
      if(!choice.canceled&&choice.filePath)await fs.writeFile(choice.filePath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    }
  } finally {
    cleaning=true;
    for(const window of BrowserWindow.getAllWindows())window.destroy();
    await session.fromPartition(config.partition).clearStorageData().catch(()=>{});
    await fs.rm(temporary,{recursive:true,force:true}).catch(()=>{});
    cleaning=false;app.removeListener('before-quit',keepCleanupAlive);
  }
  return report;
}
module.exports={runDiagnostic,buildReport,pdfFixture};
