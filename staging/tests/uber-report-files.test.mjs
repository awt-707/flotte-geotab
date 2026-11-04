import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createUberReportFileStore} from '../server/uber-report-files.mjs';

const ORG='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const CSV='\ufeffDriver UUID,Trips completed,Hours online,Hours on trip,Unused field\r\n33333333-3333-4333-8333-333333333333,14,26.5,12.25,Synthetic privé\r\n';
const input={organizationId:ORG,reportType:'driver_activity',period:{start_date:'2026-10-26',end_date:'2026-11-01'},csv:CSV};
const sha=text=>createHash('sha256').update(text).digest('hex');
async function fixture(work){
 const parent=await mkdtemp(path.join(tmpdir(),'ludy-uber-report-files-')),directory=path.join(parent,'archive');let clock=Date.parse('2026-11-02T16:00:00Z');
 const create=()=>createUberReportFileStore({directory,now:()=>clock}),store=create();
 try{await work({directory,store,create,advance:ms=>clock+=ms});}finally{await rm(parent,{recursive:true,force:true});}
}
async function files(directory){
 const result=[];for(const item of await readdir(directory,{withFileTypes:true})){const name=path.join(directory,item.name);if(item.isDirectory())result.push(...await files(name));else result.push(name);}return result;
}

test('a received CSV is stored exactly with a bounded metadata-only pending receipt and private permissions',async()=>{
 await fixture(async({directory,store})=>{
  const saved=await store.persistReport({...input,filename:'unused-client-filename.csv',sourceUrl:'https://unused.invalid/private',token:'UNUSED_CREDENTIAL'});
  assert.equal(saved.created,true);assert.match(saved.token,/^[a-f0-9]{64}$/);assert.equal(saved.receipt.status,'pending');assert.equal(saved.receipt.sha256,sha(CSV));assert.equal(saved.receipt.byte_length,Buffer.byteLength(CSV));
  const csvPath=path.join(directory,saved.receipt.file),receiptPath=path.join(directory,'receipts',saved.token+'.json');
  assert.equal(await readFile(csvPath,'utf8'),CSV);assert.deepEqual(JSON.parse(await readFile(receiptPath,'utf8')),saved.receipt);
  assert.match(path.basename(csvPath),new RegExp('^driver_activity-2026-10-26_2026-11-01-'+sha(CSV)+'\\.csv$'));
  const metadata=JSON.stringify(saved.receipt);assert.doesNotMatch(metadata,/Synthetic|Driver UUID|Hours online|UNUSED|unused|sourceUrl|token|filename/);assert.ok(Buffer.byteLength(metadata)<2000);
  for(const dir of [directory,path.join(directory,'files'),path.join(directory,'files',ORG),path.join(directory,'receipts')])assert.equal((await lstat(dir)).mode&0o777,0o700);
  for(const file of [csvPath,receiptPath])assert.equal((await lstat(file)).mode&0o777,0o600);
  assert.deepEqual((await files(directory)).sort(),[csvPath,receiptPath].sort());
 });
});

test('concurrent retries across store instances produce one immutable CSV and one receipt',async()=>{
 await fixture(async({directory,store,create,advance})=>{
  const other=create(),saved=await Promise.all(Array.from({length:12},(_,i)=>(i%2?store:other).persistReport(input)));
  assert.equal(new Set(saved.map(row=>row.token)).size,1);assert.equal(saved.filter(row=>row.created).length,1);assert.equal((await files(directory)).length,2);
  const first=saved[0];advance(1000);const imported=await store.markImported(first.token);assert.equal(imported.status,'imported');assert.equal(imported.imported_at,'2026-11-02T16:00:01.000Z');
  advance(1000);const duplicate=await create().persistReport(input);assert.equal(duplicate.created,false);assert.deepEqual(duplicate.receipt,imported);assert.deepEqual(await other.markImported(first.token),imported);
  assert.equal(await readFile(path.join(directory,first.receipt.file),'utf8'),CSV);
 });
});

test('failed imports keep the CSV, can recover and can never downgrade an imported receipt',async()=>{
 await fixture(async({directory,store,create,advance})=>{
  const saved=await store.persistReport(input);advance(1000);
  const failed=await store.markFailed(saved.token,{message:'PRIVATE_ERROR_NOT_RETAINED'});assert.equal(failed.status,'failed');assert.equal(failed.imported_at,null);assert.equal(await readFile(path.join(directory,failed.file),'utf8'),CSV);
  const reopened=create();assert.deepEqual((await reopened.persistReport(input)).receipt,failed);advance(1000);
  const imported=await reopened.markImported(saved.token);assert.equal(imported.status,'imported');advance(1000);
  assert.deepEqual(await store.markFailed(saved.token),imported);
  const receipt=await readFile(path.join(directory,'receipts',saved.token+'.json'),'utf8');assert.doesNotMatch(receipt,/PRIVATE_ERROR|Synthetic privé/);assert.equal((await files(directory)).length,2);
 });
});

test('organisation, report type and period isolate identical contents while changed contents get another immutable file',async()=>{
 await fixture(async({directory,store})=>{
  const variants=[input,{...input,organizationId:OTHER},{...input,reportType:'driver_quality'},{...input,period:{start_date:'2026-10-25',end_date:'2026-10-31'}},{...input,csv:CSV.replace(',14,',',15,')}];
  const saved=await Promise.all(variants.map(value=>store.persistReport(value)));assert.equal(new Set(saved.map(row=>row.token)).size,5);assert.equal(new Set(saved.map(row=>row.receipt.file)).size,5);
  for(let i=0;i<saved.length;i++)assert.equal(await readFile(path.join(directory,saved[i].receipt.file),'utf8'),variants[i].csv);
  assert.equal((await files(directory)).length,10);
 });
});

test('invalid metadata, empty files, invalid tokens and the six MiB UTF-8 bound fail before creating an archive',async()=>{
 await fixture(async({directory,store})=>{
  const invalid=[undefined,null,[],{}, {...input,organizationId:'unknown'}, {...input,reportType:'other'}, {...input,period:{start_date:'2026-02-30',end_date:'2026-03-01'}}, {...input,period:{start_date:'2026-11-01',end_date:'2026-10-26'}}, {...input,period:{start_date:'2026-01-01',end_date:'2026-03-01'}}, {...input,csv:''}, {...input,csv:'   '}, {...input,csv:'a\0b'}, {...input,csv:12}];
  for(const value of invalid)await assert.rejects(store.persistReport(value),error=>error.status===400);
  await assert.rejects(store.persistReport({...input,csv:'é'.repeat(3*1024*1024+1)}),error=>error.status===413);
  for(const token of ['',null,'not-a-receipt','x'.repeat(64)]){await assert.rejects(store.markImported(token),error=>error.status===400);await assert.rejects(store.markFailed(token),error=>error.status===400);}
  await assert.rejects(lstat(directory),error=>error.code==='ENOENT');
 });
});

test('a normal file exactly at the six MiB limit is retained without truncation',async()=>{
 await fixture(async({directory,store})=>{
  const csv='Header\n'+'x'.repeat(6*1024*1024-7),saved=await store.persistReport({...input,csv});
  assert.equal(saved.receipt.byte_length,6*1024*1024);assert.equal((await readFile(path.join(directory,saved.receipt.file))).length,6*1024*1024);assert.equal(saved.receipt.sha256,sha(csv));
 });
});

test('missing or altered local records are not marked as imported and existing CSV contents are never silently replaced',async()=>{
 await fixture(async({directory,store})=>{
  await assert.rejects(store.markImported('a'.repeat(64)),error=>error.status===404);
  const saved=await store.persistReport(input),filename=path.join(directory,saved.receipt.file);await writeFile(filename,'incomplete local file');
  await assert.rejects(store.markImported(saved.token),error=>error.status===503);await assert.rejects(store.persistReport(input),error=>error.status===503);
  assert.equal(await readFile(filename,'utf8'),'incomplete local file');assert.equal(JSON.parse(await readFile(path.join(directory,'receipts',saved.token+'.json'),'utf8')).status,'pending');
  assert.ok((await files(directory)).every(file=>!file.endsWith('.tmp')));
 });
});

test('a receipt write failure leaves a complete recoverable CSV and no temporary file',async()=>{
 await fixture(async({directory,store})=>{
  const token=sha(JSON.stringify([ORG,input.reportType,input.period.start_date,input.period.end_date,sha(CSV)])),receiptPath=path.join(directory,'receipts',token+'.json');
  await mkdir(receiptPath,{recursive:true});await assert.rejects(store.persistReport(input),error=>error.status===503);
  const local=await files(directory);assert.equal(local.length,1);assert.ok(local[0].endsWith('.csv'));assert.equal(await readFile(local[0],'utf8'),CSV);
  await rm(receiptPath,{recursive:true});const saved=await store.persistReport(input);assert.equal(saved.token,token);assert.equal(saved.created,false);assert.equal(saved.receipt.status,'pending');assert.equal((await files(directory)).length,2);
 });
});

test('existing archive permissions are tightened on later access without modifying report contents',async()=>{
 await fixture(async({directory,store})=>{
  const saved=await store.persistReport(input),csv=path.join(directory,saved.receipt.file),receipt=path.join(directory,'receipts',saved.token+'.json');
  for(const name of [directory,path.join(directory,'files'),path.join(directory,'files',ORG),path.join(directory,'receipts')])await chmod(name,0o755);
  await chmod(csv,0o644);await chmod(receipt,0o644);await store.persistReport(input);
  for(const name of [directory,path.join(directory,'files'),path.join(directory,'files',ORG),path.join(directory,'receipts')])assert.equal((await lstat(name)).mode&0o777,0o700);
  assert.equal((await lstat(csv)).mode&0o777,0o600);assert.equal((await lstat(receipt)).mode&0o777,0o600);assert.equal(await readFile(csv,'utf8'),CSV);
 });
});
