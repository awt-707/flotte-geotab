import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../site/app.js',import.meta.url),'utf8');
const helper=app.slice(app.indexOf('function agencyPickerRows('),app.indexOf('function agTxt('));
function fixture(aliases){const rows=[{id:11,name:'Casa'},{id:22,name:'Marrakech'},{id:33,name:'Imported Casa'},{id:44,name:'Imported Marrakech'}],S={P:{myclicar_agency_aliases:aliases},agencies:rows},c=vm.createContext({S,esc:String});vm.runInContext(helper,c);return {S,run:s=>vm.runInContext(s,c),ids:s=>Array.from(vm.runInContext(s,c),r=>r.id)};}
test('known import aliases reduce picker choices from four to two without mutating the accessible catalogue',()=>{
 const {S,run,ids}=fixture('{"33":"11","44":"22"}');
 assert.deepEqual(ids('agencyPickerRows()'),[11,22]);assert.equal(S.agencies.length,4);
 assert.equal((run("agOptions('', 'Toutes', agencyPickerRows())").match(/<option/g)||[]).length,3);
 assert.equal((run("agOptions('', 'Toutes')").match(/<option/g)||[]).length,5,'other agency editors keep their complete catalogue');
 assert.deepEqual(ids('agencyPickerRows(S.agencies,33)'),[11,22,33],'an existing historical selection must never be silently replaced');
 assert.deepEqual(ids('agencyPickerRows([S.agencies[2]])'),[33],'an inaccessible canonical agency never removes the only allowed option');
});
test('absent, malformed, unknown or cyclic aliases cannot hide agency choices',()=>{
 for(const value of [undefined,'invalid','null','[]','{"33":"999"}','{"33":"33"}','{"33":"44","44":"33"}','{"33":{"id":"11"}}']){
  const {ids}=fixture(value);assert.deepEqual(ids('agencyPickerRows()'),[11,22,33,44]);
 }
});
