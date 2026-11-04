/* Local spreadsheet resource bounds; independent from the parsing library. */
const SPREADSHEET_LIMITS=Object.freeze({bytes:16*1024*1024,expanded:64*1024*1024,entries:2048,sheets:32,rows:50000,columns:256,cells:1000000,text:16*1024*1024,cellText:32767});
async function spreadsheetArchiveGuard(buffer){
 const bytes=new Uint8Array(buffer),view=new DataView(buffer),limit=SPREADSHEET_LIMITS;
 if(!bytes.length||bytes.length>limit.bytes)throw Error('Fichier vide ou trop volumineux (16 Mo maximum).');
 if(bytes.length<4||view.getUint32(0,true)!==0x04034b50)return;
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
 if(end<0||end+22+view.getUint16(end+20,true)!==bytes.length)throw Error('Archive Excel incomplète. Exportez à nouveau le fichier.');
 const count=view.getUint16(end+10,true),start=view.getUint32(end+16,true),size=view.getUint32(end+12,true);
 if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||count!==view.getUint16(end+8,true)||count===65535||!count||count>limit.entries||start+size!==end)throw Error('Archive Excel non prise en charge ou trop volumineuse.');
 let cursor=start,total=0;
 for(let i=0;i<count;i++){
  if(cursor+46>end||view.getUint32(cursor,true)!==0x02014b50)throw Error('Archive Excel invalide.');
  const flags=view.getUint16(cursor+8,true),method=view.getUint16(cursor+10,true),packed=view.getUint32(cursor+20,true),unpacked=view.getUint32(cursor+24,true),name=view.getUint16(cursor+28,true),extra=view.getUint16(cursor+30,true),comment=view.getUint16(cursor+32,true),local=view.getUint32(cursor+42,true);
  total+=unpacked;
  if(flags&1||![0,8].includes(method)||total>limit.expanded||unpacked>limit.expanded||packed>bytes.length||local+30>start||view.getUint32(local,true)!==0x04034b50||view.getUint16(local+8,true)!==method)throw Error('Archive Excel chiffrée, invalide ou trop volumineuse après décompression.');
  const localName=view.getUint16(local+26,true),localExtra=view.getUint16(local+28,true),dataAt=local+30+localName+localExtra;
  if(dataAt+packed>start||cursor+46+name+extra+comment>end||localName!==name)throw Error('Archive Excel invalide.');
  for(let j=0;j<name;j++)if(bytes[local+30+j]!==bytes[cursor+46+j])throw Error('Archive Excel incohérente.');
  if(method===0){if(packed!==unpacked)throw Error('Archive Excel incohérente.');}
  else{
   if(typeof DecompressionStream!=='function')throw Error('Ce navigateur ne peut pas vérifier ce classeur. Mettez-le à jour ou exportez en CSV.');
   const reader=new Blob([bytes.subarray(dataAt,dataAt+packed)]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();let actual=0;
   try{for(;;){const next=await reader.read();if(next.done)break;actual+=next.value.byteLength;if(actual>unpacked||actual>limit.expanded){await reader.cancel();throw Error('Archive Excel trop volumineuse après décompression.');}}}finally{reader.releaseLock();}
   if(actual!==unpacked)throw Error('Archive Excel incomplète.');
  }
  cursor+=46+name+extra+comment;
 }
 if(cursor!==end)throw Error('Archive Excel invalide.');
}
