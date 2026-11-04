import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { telemetryDayStart } from '../server/geotab-service.mjs';

const [timezoneCode, libraryCode, index] = await Promise.all([
  fs.readFile(new URL('../site/timezone.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../site/lib.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8')
]);

function dates({ wrongBrowserZone = false } = {}) {
  const context = vm.createContext({ module: { exports: {} }, Intl: wrongBrowserZone ? {
    NumberFormat: Intl.NumberFormat,
    DateTimeFormat: class {
      formatToParts(value) {
        const date = new Date(new Date(value).getTime()+3600000), pad = value => String(value).padStart(2, '0');
        return Object.entries({ year: String(date.getUTCFullYear()), month: pad(date.getUTCMonth() + 1), day: pad(date.getUTCDate()),
          hour: pad(date.getUTCHours()), minute: pad(date.getUTCMinutes()), second: pad(date.getUTCSeconds()) }).map(([type, value]) => ({ type, value }));
      }
    }
  } : Intl });
  vm.runInContext(timezoneCode + '\n' + libraryCode, context);
  vm.runInContext('setTzRules(STAGING_TZ_RULES)', context);
  return { context, lib: context.module.exports };
}

test('staging timezone table follows IANA 2026f permanent GMT and loads before date helpers', () => {
  const { context } = dates();
  const staging = JSON.parse(vm.runInContext('JSON.stringify(STAGING_TZ_RULES)', context));
  assert.deepEqual(staging.at(-1),[Date.parse('2026-09-20T01:00:00Z'),0]);
  assert.equal(vm.runInContext('LudyMoroccoTime.tzdbVersion',context),'2026f');
  assert.ok(index.indexOf('src="timezone.js"') < index.indexOf('src="lib.js"'));
  assert.ok(index.indexOf('src="timezone.js"') < index.indexOf('src="app.js"'));
});

test('Casablanca day boundaries and parsing remain correct even when browser Intl still returns UTC+1', () => {
  const { lib } = dates({ wrongBrowserZone: true });
  const from = '2026-10-30T00:00:00.000Z';
  assert.equal(lib.localDay(from), '2026-10-30'); assert.equal(lib.localHM(from), '00:00');
  assert.equal(lib.tzOffsetMin(from), 0);
  assert.equal(lib.dayBounds('2026-10-30').start.toISOString(), from);
  assert.equal(lib.dayBounds('2026-10-30').end.toISOString(), '2026-10-31T00:00:00.000Z');
  assert.equal(lib.parseLocalDT('30/10/2026 00:00').toISOString(), from);
  assert.equal(lib.parseLocalDT('2026-10-30 00:00').toISOString(), from);
});

test('Ramadan transitions preserve the actual 25-hour and 23-hour Casablanca days', () => {
  const { lib } = dates({ wrongBrowserZone: true });
  const cases = [
    ['2026-02-15T01:59:59.000Z', 60, '02:59'],
    ['2026-02-15T02:00:00.000Z', 0, '02:00'],
    ['2026-03-22T01:59:59.000Z', 0, '01:59'],
    ['2026-03-22T02:00:00.000Z', 60, '03:00']
  ];
  for (const [time, offset, hour] of cases) { assert.equal(lib.tzOffsetMin(time), offset, time); assert.equal(lib.localHM(time), hour, time); }
  const february = lib.dayBounds('2026-02-15'), march = lib.dayBounds('2026-03-22');
  assert.equal((february.end - february.start) / 3600000, 25);
  assert.equal((march.end - march.start) / 3600000, 23);
  assert.equal(lib.parseLocalDT('16/02/2026 00:00').toISOString(), '2026-02-16T00:00:00.000Z');
  assert.equal(lib.parseLocalDT('23/03/2026 00:00').toISOString(), '2026-03-22T23:00:00.000Z');
});

test('server telemetry day start and UI rules agree throughout 2026 including both transitions', () => {
  const { lib } = dates({ wrongBrowserZone: true });
  const from = Date.parse('2026-01-01T00:00:00Z'), to = Date.parse('2027-01-01T00:00:00Z');
  for (let time = from; time < to; time += 6 * 3600000) {
    assert.equal(lib.dayBounds(lib.localDay(time)).start.toISOString(), telemetryDayStart(time), new Date(time).toISOString());
  }
});

test('events, rotations, driver performance and driver portal share Moroccan time even with obsolete browser Intl',async()=>{
 const {context}=dates({wrongBrowserZone:true});
 const specs=[['opportunities.js',['const growthDate=','function growthEventLocal(']],['rotations.js',['function rotationDate(','function rotationDayNow(']],['driver-performance.js',['const performanceDate=','function performanceLocalDay(']],['chauffeur.js',['const driverDate=']]];
 for(const [file,prefixes]of specs){const code=await fs.readFile(new URL('../site/'+file,import.meta.url),'utf8');for(const prefix of prefixes){const line=code.split('\n').find(line=>line.startsWith(prefix));assert.ok(line,'Missing date helper '+prefix);vm.runInContext(line,context);}}
 const cases=[['2026-11-02T18:00:00Z','02/11 18:00'],['2026-02-15T01:59:00Z','15/02 02:59'],['2026-02-15T02:00:00Z','15/02 02:00'],['2026-03-22T01:59:00Z','22/03 01:59'],['2026-03-22T02:00:00Z','22/03 03:00']];
 for(const [value,expected]of cases){
  for(const helper of ['performanceDate','rotationDate'])assert.equal(vm.runInContext(helper+'('+JSON.stringify(value)+')',context),expected,helper+' '+value);
  const full=expected.slice(0,5)+'/2026'+expected.slice(5);
  for(const helper of ['driverDate','growthDate'])assert.equal(vm.runInContext(helper+'('+JSON.stringify(value)+')',context),full,helper+' '+value);
 }
 assert.equal(vm.runInContext("growthEventLocal('2026-11-02T23:30:00Z')",context),'2026-11-02T23:30');
 assert.equal(vm.runInContext("performanceLocalDay(Date.parse('2026-11-02T23:30:00Z'))",context),'2026-11-02');
 vm.runInContext("Date.now=()=>Date.parse('2026-11-02T23:30:00Z')",context);assert.equal(vm.runInContext('rotationDayNow()',context),'2026-11-02');
 const portal=await fs.readFile(new URL('../site/chauffeur.html',import.meta.url),'utf8');assert.ok(portal.indexOf('src="timezone.js"')<portal.indexOf('src="chauffeur.js"'));
});

test('standalone portal date parts match fleet date rules throughout 2026',()=>{
 const {context}=dates({wrongBrowserZone:true});
 for(let at=Date.parse('2026-01-01');at<Date.parse('2027-01-01');at+=6*3600000){
  assert.equal(vm.runInContext('JSON.stringify(stagingLocalDateParts('+at+'))',context),vm.runInContext('JSON.stringify(parts('+at+'))',context));
 }
 assert.equal(vm.runInContext("stagingLocalDateParts('invalid')",context),null);
});
