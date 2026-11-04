import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {moroccoParts,moroccoDay,moroccoOffsetMinutes,moroccoWallTime,tzdbVersion} from '../server/morocco-time.mjs';
import {parseMyClicarLocalTime} from '../server/myclicar-contracts.mjs';
import {parseDemandTime} from '../server/demand-analytics.mjs';
import {telemetryDayStart} from '../server/geotab-service.mjs';
import {performanceDay,performancePeriod} from '../server/driver-performance.mjs';
import {rotationLocalDay} from '../server/vehicle-rotations.mjs';
import {inSchedule} from '../server/fleet-domain.mjs';

const source=await readFile(new URL('../site/timezone.js',import.meta.url),'utf8');
const library=await readFile(new URL('../site/lib.js',import.meta.url),'utf8');
const now=Date.parse('2026-11-10T12:00:00Z');
test('2026f clock keeps the Ramadan history and applies permanent GMT at the official September instant',()=>{
 assert.equal(tzdbVersion,'2026f');
 const cases=[
  ['2026-02-15T01:59:59Z',60,2,59],['2026-02-15T02:00:00Z',0,2,0],
  ['2026-03-22T01:59:59Z',0,1,59],['2026-03-22T02:00:00Z',60,3,0],
  ['2026-09-20T00:59:59Z',60,1,59],['2026-09-20T01:00:00Z',0,1,0],
  ['2026-11-02T23:30:00Z',0,23,30],['2027-01-31T08:00:00Z',0,8,0],
  ['2027-03-01T08:00:00Z',0,8,0],['2037-11-01T08:00:00Z',0,8,0]
 ];
 for(const [at,offset,hour,minute] of cases){assert.equal(moroccoOffsetMinutes(at),offset,at);assert.equal(moroccoParts(at).hour,hour,at);assert.equal(moroccoParts(at).minute,minute,at);}
 assert.equal(moroccoDay('2026-09-19T23:30:00Z'),'2026-09-20');
 assert.equal(moroccoDay('2026-09-20T23:30:00Z'),'2026-09-20');
});
test('ambiguous or missing wall clocks are rejected while explicit source offsets remain unchanged',()=>{
 for(const p of [{year:2026,month:2,day:15,hour:2,minute:30},{year:2026,month:3,day:22,hour:2,minute:30},{year:2026,month:9,day:20,hour:1,minute:30}])assert.equal(moroccoWallTime(p),null);
 assert.equal(new Date(moroccoWallTime({year:2026,month:9,day:20,hour:2,minute:30})).toISOString(),'2026-09-20T02:30:00.000Z');
 for(const value of ['20/09/2026 01:30','15/02/2026 02:30','22/03/2026 02:30'])assert.throws(()=>parseMyClicarLocalTime(value));
 assert.equal(parseMyClicarLocalTime('03/11/2026 00:10'),'2026-11-03T00:10:00.000Z');
 assert.equal(parseMyClicarLocalTime('03/06/2026 00:10'),'2026-06-02T23:10:00.000Z');
 assert.equal(parseDemandTime('2026-09-20T01:30:00+01:00',{now}),'2026-09-20T00:30:00.000Z');
 assert.equal(parseDemandTime('2026-09-20T01:30:00Z',{now}),'2026-09-20T01:30:00.000Z');
 assert.equal(parseDemandTime('2026-11-02T10:30:00+01:00',{now}),'2026-11-02T09:30:00.000Z');
 for(const p of [{year:2026,month:2,day:30},{year:2026,month:1,day:1,hour:24},{year:2026,month:1,day:1,minute:-1},{}])assert.equal(moroccoWallTime(p),null);
});
test('browser and Node share the clock even when Intl is unavailable or carries old tzdata',()=>{
 const context=vm.createContext({Intl:{DateTimeFormat:class {constructor(){throw Error('Host timezone must not be used for current dates');}}}});
 vm.runInContext(source,context);
 for(let at=Date.parse('2026-01-01');at<Date.parse('2027-04-01');at+=6*3600000){
  assert.equal(vm.runInContext(`JSON.stringify(LudyMoroccoTime.moroccoParts(${at}))`,context),JSON.stringify(moroccoParts(at)));
 }
 const ui=vm.createContext({Intl,module:{exports:{}}});vm.runInContext(source+'\n'+library,ui);
 const lib=ui.module.exports;
 // An old database parameter cannot override the bundled staging clock.
 lib.setTzRules([[Date.UTC(2018,0,1),60]]);
 assert.equal(lib.localHM('2026-11-02T23:30:00Z'),'23:30');
 for(const value of ['2026-09-20 01:30','2026-02-30 08:00','2026-02-30T08:00:00Z'])assert.equal(lib.parseLocalDT(value),null,value);
 assert.equal(lib.parseLocalDT('2026-09-20T01:30:00+01:00').toISOString(),'2026-09-20T00:30:00.000Z');
 assert.equal((lib.dayBounds('2026-09-20').end-lib.dayBounds('2026-09-20').start)/3600000,25);
});
test('telemetry, rotations, activity periods and schedule boundaries agree around local midnight',()=>{
 for(const [at,day,start] of [['2026-06-02T23:30:00Z','2026-06-03','2026-06-02T23:00:00.000Z'],['2026-11-02T23:30:00Z','2026-11-02','2026-11-02T00:00:00.000Z']]){
  assert.equal(moroccoDay(at),day);assert.equal(rotationLocalDay(at),day);assert.equal(performanceDay(at),day);assert.equal(telemetryDayStart(at),start);
 }
 const range=performancePeriod('2026-09-20','2026-09-20',now);
 assert.equal(range.from_at,'2026-09-19T23:00:00.000Z');assert.equal(range.to_at,'2026-09-21T00:00:00.000Z');
 for(const timezone of [undefined,'Africa/Casablanca','Africa/El_Aaiun']){
  const schedule={timezone,days:[1],start:'07:00',end:'19:00'};
  assert.equal(inSchedule(schedule,Date.parse('2026-11-02T06:59:59Z')),false);
  assert.equal(inSchedule(schedule,Date.parse('2026-11-02T07:00:00Z')),true);
  assert.equal(inSchedule(schedule,Date.parse('2026-11-02T19:00:00Z')),false);
 }
});
