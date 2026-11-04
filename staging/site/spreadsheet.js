// Imported files are parsed in a disposable worker; only primitive grids return.
const SPREADSHEET_JOBS=new Set();
function spreadsheetCancelAll(){for(const job of [...SPREADSHEET_JOBS])job.cancel();}
addEventListener('hashchange',spreadsheetCancelAll);addEventListener('pagehide',spreadsheetCancelAll);
function spreadsheetRows(book,name=book.SheetNames[0]){const sheet=book.sheets.find(s=>s.name===name);if(!sheet)throw Error('Feuille introuvable.');return sheet.rows;}
async function readSpreadsheet(input,name=input?.name,options={}){
 const bytes=input instanceof Blob?input.size:input?.byteLength;
 if(!bytes||bytes>(options.maxBytes||16*1024*1024))throw Error('Fichier vide ou trop volumineux. Maximum '+((options.maxBytes||16*1024*1024)/1024/1024)+' Mo.');
 if(!/\.(csv|txt|xls|xlsx)$/i.test(name||''))throw Error('Choisissez un fichier CSV, XLS ou XLSX.');
 if(typeof Worker!=='function')throw Error('La lecture isolée des fichiers nécessite un navigateur récent.');
 if(SPREADSHEET_JOBS.size>=2)throw Error('Deux fichiers sont déjà en lecture. Patientez avant de réessayer.');
 if(options.signal?.aborted)throw new DOMException('Lecture annulée.','AbortError');
 const owner=typeof S!=='undefined'?S.session?.user?.id:null;
 return new Promise((resolve,reject)=>{
  const worker=new Worker('/spreadsheet-worker.js'),job={cancel:()=>finish(new DOMException('Lecture annulée.','AbortError'))};let done=false;
  const timer=setTimeout(()=>finish(Error('Le fichier prend trop de temps à lire. Réduisez-le ou exportez-le en CSV.')),15000);
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',job.cancel);worker.terminate();SPREADSHEET_JOBS.delete(job);error?reject(error):resolve(value);}
  SPREADSHEET_JOBS.add(job);options.signal?.addEventListener('abort',job.cancel,{once:true});
  worker.onerror=event=>{event.preventDefault();finish(Error('Lecture du fichier interrompue. Vérifiez le format puis réessayez.'));};worker.onmessageerror=()=>finish(Error('Réponse de lecture invalide.'));
  worker.onmessage=({data})=>{
   if(typeof S!=='undefined'&&S.session?.user?.id!==owner){finish(Error('La session a changé. Rechargez le fichier.'));return;}
   if(!data?.ok){finish(Error(data?.error||'Fichier illisible.'));return;}
   const book=data.book;
   if(!book||!Array.isArray(book.sheets)||!Array.isArray(book.SheetNames)||book.sheets.length>32||book.SheetNames.length!==book.sheets.length){finish(Error('Réponse de lecture invalide.'));return;}
   finish(null,book);
  };
  try{const file=input instanceof Blob?input:input instanceof ArrayBuffer?input:input.buffer.slice(input.byteOffset,input.byteOffset+input.byteLength);worker.postMessage({file,name,mode:options.mode||'formatted',maxRows:options.maxRows||50000},file instanceof ArrayBuffer?[file]:[]);}catch{finish(Error('Impossible de lire ce fichier.'));}
 });
}
