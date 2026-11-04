import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const files=['protocol.js','reader.js','scanner.js','content.js','reports-reader.js','reports-content.js','reports-background.js','background.js','popup.html','popup.css','popup.js'];
// Petit ZIP standard sans compression : aucune dépendance de construction externe.
function zip(entries){
  const local=[],central=[];let offset=0;
  for(const [name,data] of entries){
    const filename=Buffer.from(name);let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(crc^0xffffffff)>>>0;
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x21,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);
    local.push(header,filename,data);central.push(entry,filename);offset+=header.length+filename.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
for(const browser of ['chromium','firefox']){
  const target=path.join(root,browser);await mkdir(target,{recursive:true});
  for(const file of files)await copyFile(path.join(root,file),path.join(target,file));
  await copyFile(path.join(root,browser==='firefox'?'manifest.firefox.json':'manifest.json'),path.join(target,'manifest.json'));
  const entries=[];for(const file of ['manifest.json',...files])entries.push([file,await readFile(path.join(target,file))]);
  await writeFile(path.join(root,`ludy-uber-${browser}.zip`),zip(entries));
}
console.log('Extensions préparées : dossiers chromium/firefox et archives ludy-uber-chromium.zip / ludy-uber-firefox.zip.');
