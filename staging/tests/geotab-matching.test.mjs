import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {normalizeGeotabPlate,matchGeotabVehicles} from '../server/geotab-matching.mjs';

test('plate normalization has parity with the production function',()=>{
  const source=fs.readFileSync(new URL('../../collector/src/15_engine.gs',import.meta.url),'utf8');
  const functionSource=source.match(/function normPlate_\(s\) \{[\s\S]*?\n\}/)?.[0];assert.ok(functionSource);
  const context={};vm.createContext(context);vm.runInContext(functionSource,context);
  for(const input of [null,undefined,'','123-A-45','12345A','W18 1234','12 wW','12/أ/345',' Ab-12-CD-34 ',0])assert.equal(normalizeGeotabPlate(input),context.normPlate_(input));
  assert.equal(normalizeGeotabPlate('123-A-45'),'12345A');
});

test('matches canonical keys, current plates, aliases and exact VIN through provider name or plate',()=>{
  const vehicles=[
    {key:'12345A',plate:'123-A-45'},
    {key:'22345B',plate:'223-B-45',other_plates:'W18-900; WW-123'},
    {key:'32345C',plate:'323-C-45'},
    {key:'42345D',plate:'423-D-45',vin:'testVin00001'},
    {key:'52345E',plate:'523-E-45',vin:'testVin00002'}
  ];
  const devices=[{id:'b1',name:'12345-A'},{id:'b2',name:'Autre nom',plate:'WW123'},{id:'b3',licensePlate:'32345C'},
    {id:'b4',vehicleIdentificationNumber:'TESTVIN00001'},{id:'b5',vin:'TESTVIN00002'}];
  const before=JSON.stringify({vehicles,devices});const output=matchGeotabVehicles(vehicles,devices);
  assert.deepEqual(output.matches.map(m=>[m.vehicle_key,m.device_id]),vehicles.map((v,i)=>[v.key,'b'+(i+1)]));
  assert.equal(output.matches[0].reason,'Nom Geotab');assert.equal(output.matches[1].reason,'Plaque Geotab');assert.equal(output.matches[3].reason,'VIN');
  assert.equal(JSON.stringify({vehicles,devices}),before,'inputs remain unchanged');
});

test('never matches empty values, partial names, unrelated digits or inactive vehicles',()=>{
  const output=matchGeotabVehicles([{key:'12345A',plate:'123-A-45'},{key:'unassigned',plate:'',vin:' '},{key:'inactive',plate:'999-X-88',active:'NON'}],
    [{id:'b1',name:'Vehicle 123-A-45'},{id:'b2',name:'',vin:' '},{id:'b3',name:'12345-B'},{id:'b4',plate:'999-X-88'}]);
  assert.deepEqual(output.matches,[]);assert.deepEqual(output.unmatched,['12345A','unassigned']);assert.deepEqual(output.existing,[]);
});

test('ambiguous candidates are refused even when VIN and plate disagree',()=>{
  const output=matchGeotabVehicles([{key:'12345A',plate:'123-A-45',vin:'TESTVIN00001'}],[{id:'b1',plate:'123-A-45'},{id:'b2',vin:'TESTVIN00001'}]);
  assert.deepEqual(output.ambiguous,['12345A']);assert.deepEqual(output.matches,[]);
});

test('no provider ID can be claimed by two vehicles or over an existing association',()=>{
  const output=matchGeotabVehicles([
    {key:'one',plate:'123-A-45'},
    {key:'two',plate:'223-B-45',other_plates:'123-A-45'},
    {key:'three',plate:'323-C-45'},
    {key:'four',plate:'423-D-45',geotab_id:'b2'},
    {key:'five',plate:'523-E-45'},
    {key:'inactive',plate:'623-F-45',geotab_id:'b3',active:'NON'}
  ],[{id:'b1',name:'123-A-45'},{id:'b2',name:'323-C-45'},{id:'b3',name:'523-E-45'}]);
  assert.deepEqual(output.matches,[]);assert.deepEqual(output.conflicts,['one','two','three','five']);assert.deepEqual(output.existing,['four']);
});

test('existing links remain authoritative even when no longer in the provider catalogue',()=>{
  const output=matchGeotabVehicles([{key:'one',plate:'123-A-45',geotab_id:'missing'}],[{id:'b1',plate:'123-A-45'}]);
  assert.deepEqual(output,{matches:[],unmatched:[],ambiguous:[],conflicts:[],existing:['one']});
});

test('duplicate catalogue rows are one candidate; shared ambiguous candidates remain unresolved',()=>{
  const duplicate=matchGeotabVehicles([{key:'one',plate:'123-A-45'}],[{id:'b1',name:'123-A-45'},{id:'b1',plate:'123-A-45'}]);
  assert.equal(duplicate.matches.length,1);assert.equal(duplicate.matches[0].reason,'Nom Geotab + Plaque Geotab');
  const shared=matchGeotabVehicles([{key:'one',plate:'123-A-45',other_plates:'223-B-45'},{key:'two',plate:'123-A-45'}],[{id:'b1',plate:'123-A-45'},{id:'b2',plate:'223-B-45'}]);
  assert.deepEqual(shared.ambiguous,['one']);assert.deepEqual(shared.conflicts,['two']);assert.deepEqual(shared.matches,[]);
});

test('an eleven-vehicle fixture matches by provider name when licensePlate is unavailable',()=>{
  const vehicles=Array.from({length:11},(_,i)=>({key:normalizeGeotabPlate((10000+i)+'-A-45'),plate:(10000+i)+'-A-45',other_plates:i<8?'W18-'+(20000+i):''}));
  const devices=vehicles.map((v,i)=>({id:'test-device-'+i,name:i<8?v.other_plates:v.plate,plate:i<8?v.plate:''}));
  const output=matchGeotabVehicles(vehicles,devices);assert.equal(output.matches.length,11);
  assert.deepEqual(output.unmatched,[]);assert.deepEqual(output.ambiguous,[]);assert.deepEqual(output.conflicts,[]);
});
test('an exact plate cannot override contradictory VINs on the same candidate',()=>{
 const output=matchGeotabVehicles([{key:'local',plate:'TEST-1',vin:'VIN-A'}],[{id:'device',plate:'TEST-1',vin:'VIN-B'}]);
 assert.equal(output.matches.length,0);assert.deepEqual(output.conflicts,['local']);
 const matching=matchGeotabVehicles([{key:'local',plate:'TEST-1',vin:' vin-a '}],[{id:'device',plate:'TEST-1',vin:'VIN-A'}]);assert.equal(matching.matches.length,1);
});
test('manual dissociation disables automatic matching while existing associations remain authoritative',()=>{
 const output=matchGeotabVehicles([{key:'unlinked',plate:'TEST-1',geotab_auto_link_disabled:true},{key:'linked',plate:'TEST-2',geotab_id:'existing',geotab_auto_link_disabled:true}],[{id:'new',plate:'TEST-1'}]);
 assert.equal(output.matches.length,0);assert.deepEqual(output.existing,['linked']);
});
