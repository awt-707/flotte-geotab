/* A disposable local worker. No session, token or application state is sent in. */
importScripts('/spreadsheet-guard.js','/vendor/xlsx.full.min.js');
self.onmessage=async({data})=>{
 try{
  const {file,name,mode='formatted',maxRows=SPREADSHEET_LIMITS.rows}=data;
  if(!/\.(csv|txt|xls|xlsx)$/i.test(name||''))throw Error('Choisissez un fichier CSV, XLS ou XLSX.');
  if(!Number.isInteger(maxRows)||maxRows<1||maxRows>SPREADSHEET_LIMITS.rows)throw Error('Limite de lignes invalide.');
  const buffer=file instanceof Blob?await file.arrayBuffer():file;
  if(!(buffer instanceof ArrayBuffer))throw Error('Fichier invalide.');
  await spreadsheetArchiveGuard(buffer);
  const csv=/\.(csv|txt)$/i.test(name),opts={type:csv?'string':'array',raw:csv||mode==='raw',cellNF:true,cellDates:false,sheetRows:maxRows+1,bookVBA:false,cellHTML:false,cellFormula:false};
  let payload=buffer;if(csv){payload=new TextDecoder('utf-8').decode(buffer);if(payload.includes('\ufffd'))payload=new TextDecoder('windows-1252').decode(buffer);payload=payload.replace(/^\ufeff/,'');}
  const book=XLSX.read(payload,opts);
  if(!book.SheetNames?.length||book.SheetNames.length>SPREADSHEET_LIMITS.sheets)throw Error('Le classeur doit contenir entre 1 et 32 feuilles.');
  const sheets=[];let cells=0,text=0;
  for(const name of book.SheetNames){
   const sheet=book.Sheets[name];if(!sheet)throw Error('Feuille Excel illisible.');
   const range=sheet['!fullref']||sheet['!ref'];if(range){const bounds=XLSX.utils.decode_range(range);if(bounds.e.r>=maxRows||bounds.e.c>=SPREADSHEET_LIMITS.columns||(bounds.e.r+1)*(bounds.e.c+1)>SPREADSHEET_LIMITS.cells)throw Error('Feuille trop grande. Réduisez les lignes ou colonnes du fichier.');}
   if(!csv)for(const key of Object.keys(sheet)){const cell=sheet[key];if(key[0]!=='!'&&cell?.t==='n'&&cell.z&&XLSX.SSF.is_date(cell.z)){
    // SheetJS 0.20 converts formatted numeric dates into Date objects during
    // sheet_to_json. Raw imports must retain the original serial and calendar.
    if(mode==='raw')delete cell.z;
    else cell.w=XLSX.SSF.format('dd/mm/yyyy hh:mm',cell.v,{date1904:!!book.Workbook?.WBProps?.date1904});
   }}
   const raw=XLSX.utils.sheet_to_json(sheet,{header:1,raw:mode==='raw',defval:'',dateNF:'dd/mm/yyyy hh:mm'}),rows=[];
   for(const row of raw){const clean=[];if(row.length>SPREADSHEET_LIMITS.columns)throw Error('Trop de colonnes.');for(let i=0;i<row.length;i++){
    const value=row[i]??'';if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw Error('Cellule non prise en charge.');
    if(typeof value==='string'){text+=value.length;if(value.length>SPREADSHEET_LIMITS.cellText||text>SPREADSHEET_LIMITS.text)throw Error('Le fichier contient trop de texte.');}
    clean.push(value);cells++;if(cells>SPREADSHEET_LIMITS.cells)throw Error('Le classeur contient trop de cellules.');
   }rows.push(clean);}
   sheets.push({name:String(name),rows});
  }
  postMessage({ok:true,book:{SheetNames:sheets.map(s=>s.name),sheets,date1904:!!book.Workbook?.WBProps?.date1904}});
 }catch(error){postMessage({ok:false,error:String(error?.message||'Fichier illisible.').slice(0,240)});}
};
