import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDemandTime,normalizeDemandImport,analyzeDemand,normalizeRushRule,rushActive,pauseSnapshot} from '../server/demand-analytics.mjs';
const now=Date.parse('2026-11-10T12:00:00Z'),input=()=>({agency_id:1,city:'Casablanca',file_name:'synthetic.csv',date_format:'dmy',rows:[{external_id:'ride-1',started_at:'02/11/2026 10:30',pickup_zone:'Centre',status:'Completed'}]});
test('explicit offsets, selected local conventions and Excel epochs all retain Moroccan wall time',()=>{
 assert.equal(parseDemandTime('02/11/2026 10:30',{date_format:'dmy',now}),'2026-11-02T10:30:00.000Z');
 assert.equal(parseDemandTime('11/02/2026 10:30',{date_format:'mdy',now}),'2026-11-02T10:30:00.000Z');
 assert.equal(parseDemandTime('2026-11-02T10:30:00+01:00',{now}),'2026-11-02T09:30:00.000Z');
 for(const date_format of ['ymd','dmy','mdy'])assert.equal(parseDemandTime('2026-11-02 10:30',{date_format,now}),'2026-11-02T10:30:00.000Z','an unambiguous leading year overrides only the local column convention');
 assert.throws(()=>parseDemandTime('02/11/2026 10:30',{now}),'unknown local convention remains strict ymd');
 const wall=Date.UTC(2026,10,2,10,30);
 for(const [date_system,base] of [['1900',Date.UTC(1899,11,30)],['1904',Date.UTC(1904,0,1)]])assert.equal(parseDemandTime((wall-base)/86400000,{date_system,now}),'2026-11-02T10:30:00.000Z');
 assert.equal(parseDemandTime('2026-02-20 10:30',{now}),'2026-02-20T10:30:00.000Z','Ramadan and permanent GMT retain UTC; summer still uses UTC+1');
});
test('date-only strings, invalid calendar dates, future dates and ambiguous Moroccan hours are rejected',()=>{
 for(const value of ['2026-11-02','2026-02-30 10:30','2026-02-30T10:30:00Z','2026-11-11 10:00','2026-11-02 24:10','2026-02-15 02:30','2026-03-22 02:30',60,NaN,null])assert.throws(()=>parseDemandTime(value,{now}),String(value));
 assert.equal(parseDemandTime('2026-02-15T02:30:00+00:00',{now}),'2026-02-15T02:30:00.000Z','an explicit UTC offset disambiguates the repeated hour');
});
test('the selected operational columns normalize, duplicate IDs dedupe and contradictory IDs reject the entire import',()=>{
 const data=input();data.rows.push({...data.rows[0]}, {...data.rows[0],external_id:'ride-2',status:'Annulée'});
 const normalized=normalizeDemandImport(data,{now});assert.equal(normalized.rows.length,2);assert.equal(normalized.counts.duplicates,1);assert.equal(normalized.counts.completed,1);assert.equal(normalized.counts.cancelled,1);assert.match(normalized.fingerprint,/^[a-f0-9]{64}$/);
 assert.equal(normalizeDemandImport({...data,rows:[...data.rows].reverse()},{now}).fingerprint,normalized.fingerprint,'order and repeated rows do not alter report identity');
 data.rows.push({...data.rows[0],pickup_zone:'Airport'});assert.throws(()=>normalizeDemandImport(data,{now}),/contradictoires/);
});
test('status must come from a recognized column or an explicit all-completed confirmation',()=>{
 const data=input();delete data.rows[0].status;assert.throws(()=>normalizeDemandImport(data,{now}),/État/);
 assert.equal(normalizeDemandImport({...data,default_status:'completed'},{now}).rows[0].status,'completed');
 for(const invalid of ['on_trip','available','pending','unknown']){data.rows[0].status=invalid;assert.throws(()=>normalizeDemandImport(data,{now}),/État/);}
});
test('missing identifiers are disclosed and dedupe stable fields without silently inventing a zone',()=>{
 const data=input();delete data.rows[0].external_id;data.rows.push({...data.rows[0]});
 const result=normalizeDemandImport(data,{now});assert.equal(result.counts.derived_identifiers,1);assert.equal(result.counts.duplicates,1);assert.match(result.rows[0].external_id,/^derived:/);
 data.rows[0].pickup_zone='';assert.throws(()=>normalizeDemandImport(data,{now}),/Champ/);
  const unsafe=input();unsafe.rows[0].external_id=Number.MAX_SAFE_INTEGER+1;assert.throws(()=>normalizeDemandImport(unsafe,{now}),/arrondi Excel/);
 for(const invalid of [{...input(),agency_id:null},{...input(),city:'Paris'},{...input(),rows:[]},{...input(),rows:Array(20001).fill(input().rows[0])}])assert.throws(()=>normalizeDemandImport(invalid,{now}));
});
function history(){const rows=[];for(let day=1;day<=3;day++)for(const [hour,count] of [[8,8],[10,2],[12,4]])for(let n=0;n<count;n++)rows.push({agency_id:1,city:'Casablanca',external_id:`${day}-${hour}-${n}`,started_at:`2026-11-0${day}T${String(hour).padStart(2,'0')}:10:00Z`,pickup_zone:hour===8?'Centre':'Gare',status:'completed'});return rows;}
test('analysis separates completed and cancelled rides, reports coverage and keeps midnight in Morocco',()=>{
 const rows=history();rows.push({...rows[0],external_id:'cancelled',status:'cancelled'}, {...rows[0]}, {...rows[0],external_id:'midnight',started_at:'2026-11-03T23:30:00Z'});
 const report=analyzeDemand(rows,{now});assert.equal(report.completed,43);assert.equal(report.cancelled,1);assert.equal(report.coverage.duplicates,1);assert.equal(report.coverage.observed_days,3);assert.equal(report.by_hour[23].count,1);assert.equal(report.coverage.sample_complete,false);
 assert.ok(report.recommendations.some(row=>row.zone==='Centre'&&row.hour===8&&row.observed_days===3&&row.count===24));
 assert.ok(report.pause_windows.some(row=>row.hour===10));assert.ok(report.pause_windows.every(row=>row.count>0),'zero hours never manufacture quiet demand');
});
test('sparse data cannot generate recommendations and city/agency filters never mix fleets',()=>{
 const one=analyzeDemand([history()[0]],{now});assert.equal(one.recommendations.length,0);assert.equal(one.pause_windows.length,0);assert.ok(one.warnings.some(w=>w.includes('Échantillon limité')));
 const data=[...history(),...history().map(row=>({...row,agency_id:2,city:'Marrakech'}))];const report=analyzeDemand(data,{now,city:'Marrakech',agency_id:2});assert.equal(report.completed,42);assert.ok(report.recommendations.every(row=>row.city==='Marrakech'));
});
test('overnight rush follows its start weekday across midnight and ends at its exclusive boundary',()=>{
 const rule=normalizeRushRule({agency_id:1,city:'Casa',start:'22:00',end:'02:00',days:[7],enabled:true});assert.equal(rule.city,'Casablanca');
 assert.equal(rushActive(rule,Date.parse('2026-11-01T22:00:00Z')),true);
 assert.equal(rushActive(rule,Date.parse('2026-11-02T01:59:59Z')),true);
 assert.equal(rushActive(rule,Date.parse('2026-11-02T02:00:00Z')),false);
 assert.equal(rushActive({...rule,enabled:false},Date.parse('2026-11-01T21:30:00Z')),false);
 for(const change of [{days:[]},{days:[1,1]},{start:'25:00'},{end:'22:00'},{enabled:'yes'}])assert.throws(()=>normalizeRushRule({...rule,...change}));
});
test('pauses require a fresh explicit state, never speed zero or missing rows, and cross-platform work stays visible',()=>{
 const at='2026-11-02T09:30:00Z',clock=Date.parse(at),sources=['bolt','uber'].map(id=>({id,status:'healthy',last_success_at:at,stale_after_s:150}));
 const options={now:clock,sources,drivers:[{id:'d',name:'Synthetic',agency_id:1}],agencies:[{id:1,name:'Agence 1',city:'Casablanca'}],rules:[{id:'rush',agency_id:1,city:'Casablanca',start:'09:00',end:'12:00',days:[1],enabled:true}],latest:[{identity_id:'b',driver_id:'d',source:'bolt',status:'on_break',observed_at:at}]};
 let snapshot=pauseSnapshot(options);assert.equal(snapshot.pauses.length,1);assert.equal(snapshot.pauses[0].rush,true);assert.equal(Object.hasOwn(snapshot.pauses[0],'since'),false);
 snapshot=pauseSnapshot({...options,latest:[{...options.latest[0],status:'available',speed:0}]});assert.equal(snapshot.pauses.length,0);
 snapshot=pauseSnapshot({...options,latest:[]});assert.equal(snapshot.pauses.length,0);
 snapshot=pauseSnapshot({...options,now:clock+151000});assert.equal(snapshot.pauses.length,0);
 snapshot=pauseSnapshot({...options,sources:sources.map(s=>({...s,status:'error'}))});assert.equal(snapshot.pauses.length,0);
 snapshot=pauseSnapshot({...options,latest:[...options.latest,{driver_id:'d',source:'uber',status:'on_trip',observed_at:at}]});assert.equal(snapshot.pauses[0].cross_platform_activity,true);
 snapshot=pauseSnapshot({...options,agencies:[{id:1,name:'Agence 1'}]});assert.equal(snapshot.pauses[0].rush,false,'unknown city never applies another city’s rush rule');
});
