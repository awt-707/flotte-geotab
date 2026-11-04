import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUberReportTime} from '../server/uber-report-time.mjs';
import {normalizeUberDriverReport} from '../server/uber-driver-reports.mjs';
const now=Date.parse('2026-01-12T12:00:00Z');
test('an explicit CSV timezone distinguishes naive UTC and Moroccan wall time without changing offset-bearing values',()=>{
 assert.equal(parseUberReportTime('2026-01-11 10:34:10',{csv_timezone:'UTC',now}),'2026-01-11T10:34:10.000Z');
 assert.equal(parseUberReportTime('2026-01-11 10:34:10',{csv_timezone:'Africa/Casablanca',now}),'2026-01-11T09:34:10.000Z');
 for(const csv_timezone of ['UTC','Africa/Casablanca'])assert.equal(parseUberReportTime('2026-01-11T10:34:10+01:00',{csv_timezone,now}),'2026-01-11T09:34:10.000Z');
 assert.equal(parseUberReportTime('11/01/2026 10:34:10',{csv_timezone:'UTC',date_format:'dmy',now}),'2026-01-11T10:34:10.000Z');
 assert.equal(parseUberReportTime('01/11/2026 10:34:10',{csv_timezone:'UTC',date_format:'mdy',now}),'2026-01-11T10:34:10.000Z');
 for(const csv_timezone of [null,'Europe/Paris'])assert.throws(()=>parseUberReportTime('2026-01-11 10:34:10',{csv_timezone,now}),e=>e.code==='timezone_required');
 for(const value of ['2026-02-30 10:00','2026-01-11 25:00','2026-01-15 10:00','bad'])assert.throws(()=>parseUberReportTime(value,{csv_timezone:'UTC',now}));
});
test('confirmed UTC trips crossing the report boundary are counted separately and never assigned to a wrong request day',()=>{
 const first='11111111-1111-4111-8111-111111111111',last='22222222-2222-4222-8222-222222222222',header=['UUID de la course','Heure de la demande de course','Heure de dépose','Statut de la course'];
 const rows=[header,[first,'2026-01-04 22:50:00','2026-01-04 23:10:00','completed'],[last,'2026-01-11 23:00:00','2026-01-11 23:10:00','completed']],options={period:{start_date:'2026-01-05',end_date:'2026-01-11'},now,allowBoundaryExclusions:true};
 const value=normalizeUberDriverReport(rows,'trip_activity',{csv_timezone:'UTC',date_format:'ymd'},options);assert.equal(value.rows.length,0);assert.equal(value.counts.driver_outside_request_period,2);
 assert.throws(()=>normalizeUberDriverReport([header,[first,'2026-01-04 21:50:00','2026-01-04 22:10:00','completed']],'trip_activity',{csv_timezone:'UTC'},options),/hors période/,'a completely wrong report is still refused');
 assert.throws(()=>normalizeUberDriverReport(rows,'trip_activity',{csv_timezone:'UTC'},{...options,allowBoundaryExclusions:false}),/hors période/);
});
