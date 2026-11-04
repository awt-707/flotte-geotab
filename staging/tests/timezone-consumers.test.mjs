import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const [timezone,library,caisse,app,direct]=await Promise.all(['timezone.js','lib.js','caisse_calc.js','app.js','direct.js'].map(name=>readFile(new URL('../site/'+name,import.meta.url),'utf8')));
function fixture(){
 const dialog={open:false,innerHTML:'',showModal(){this.open=true;}},context=vm.createContext({Intl,module:{exports:{}},alertShift:()=>'',dialog,$:()=>dialog,relay:()=>assert.fail('An uncertain historical time must not trigger a provider read')});
 vm.runInContext(timezone+'\n'+library+'\n'+caisse+'\n'+app.slice(app.indexOf('function alertAt(a)'),app.indexOf('/** N° de contrat',app.indexOf('function alertAt(a)')))+'\n'+direct.slice(direct.indexOf('function alertFromDb(a)'),direct.indexOf('function renderDetail(')),context);
 return {context,dialog,run:code=>vm.runInContext(code,context)};
}
test('historical alert folds/gaps yield unknown instants instead of throwing or requesting January 1970',async()=>{
 const f=fixture();
 for(const [day,time] of [['2026-09-20','01:30'],['2026-02-15','02:30'],['2026-03-22','02:30'],['2026-02-30','12:00']]){
  f.context.row={id:'synthetic',day,time,type:'Freinage',detail:'Vérifier cette observation'};
  assert.equal(f.run('alertAt(row)'),null);assert.equal(f.run('alertFromDb(row).at'),null);
  await f.run('openAlertDetail(alertFromDb(row))');assert.equal(f.dialog.open,true);assert.match(f.dialog.innerHTML,/Heure locale ambiguë/);
 }
 f.context.row={day:'2026-11-03',time:'08:15'};assert.equal(f.run('alertAt(row).toISOString()'),'2026-11-03T08:15:00.000Z');assert.equal(f.run('alertFromDb(row).at'),'2026-11-03T08:15:00.000Z');
});
test('Uber payment rows retain explicit offsets and seconds but reject ambiguous wall times without crashing the import',()=>{
 const f=fixture();
 for(const [value,expected] of [['2026-08-19 20:01:00.232 +0100 +01','2026-08-19T19:01:00.232Z'],['2026-08-19T20:01:00.232Z','2026-08-19T20:01:00.232Z'],['2026-11-03 20:01:22.123','2026-11-03T20:01:22.123Z'],['2026-09-20 01:30',null],['2026-02-30 08:00',null],['2026-11-03 24:00',null]]){f.context.value=value;assert.equal(f.run('cshUberTime(value,localToDate)'),expected,value);}
 f.context.rows=[['UUID de la transaction','Horodatage'],['a','2026-09-20 01:30'],['b','2026-11-03 20:01']];
 const result=f.run('cshParseUberPayments(rows,localToDate)');assert.equal(result.rows.length,1);assert.equal(result.rows[0].tx,'b');assert.deepEqual([...result.bad],[2]);
});
test('Bolt payment import reports ambiguous or invalid dates as rejected rows while keeping valid local timestamps',()=>{
 const f=fixture();f.context.rows=[['Date','Chauffeur','Espèce|DH','Total des paiements|DH'],['2026-09-20 01:30','Synthetic A','10','10'],['2026-11-03 08:15','Synthetic B','20','20'],['2026-02-30 08:00','Synthetic C','30','30']];
 const result=f.run('cshParseBolt(rows,localToDate)');assert.equal(result.rows.length,1);assert.equal(result.rows[0].at,'2026-11-03T08:15:00.000Z');assert.deepEqual([...result.bad],[2,4]);
});
