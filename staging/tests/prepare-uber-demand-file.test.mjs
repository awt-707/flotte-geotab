import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePreviewArgs,confirmedCityMapping,inspectDemandCsv,prepareDemandPreview,compareExistingDemand,newDemandBatches} from '../scripts/prepare-uber-demand-file.mjs';

const now=Date.parse('2026-11-03T12:00:00Z');
const config={date_format:'ymd',csv_timezone:null,city_agencies:{Casablanca:1,Marrakech:2},revision:3};
const agencies=[{id:1,city:'CASABLANCA'},{id:2,city:'Marrakech'}];
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const header='UUID de la course;Heure de la demande de course;Adresse de prise en charge;Statut de la course;Prénom du chauffeur';
const line=(n,city='Casablanca',status='completed',time='2026-11-02 10:00:00')=>`${id(n)};${time};12 Rue Exemple, ${city}, Appartement 2;${status};PRIVATE DRIVER`;
const csv=(rows=[line(1)])=>header+'\n'+rows.join('\n');
const confirmed={timezone:'UTC',timezoneEvidence:'User confirmed UTC for this export',now};

test('CLI requires a source and explicit timezone evidence; no apply mode exists',()=>{
 assert.deepEqual(parsePreviewArgs(['--file','/tmp/report.csv']),{file:'/tmp/report.csv'});
 assert.equal(parsePreviewArgs(['--file','/tmp/report.csv','--only-new']).onlyNew,true);
 assert.equal(parsePreviewArgs(['--file','/tmp/report.csv','--timezone','UTC','--timezone-evidence','User confirmed UTC']).timezone,'UTC');
 for(const args of [[],['--file','relative.csv'],['--file','/tmp/r','--timezone','UTC'],['--file','/tmp/r','--timezone','Europe/Paris','--timezone-evidence','Confirmed export'],['--file','/tmp/r','--apply'],['--file','/tmp/r','--file','/tmp/other']])assert.throws(()=>parsePreviewArgs(args));
});
test('only configured agencies whose city matches local data are accepted',()=>{
 assert.deepEqual(confirmedCityMapping(config,agencies),config.city_agencies);
 for(const list of [[{id:1,city:'Marrakech'},{id:2,city:'Marrakech'}],[],[...agencies,agencies[0]]])assert.throws(()=>confirmedCityMapping(config,list));
 assert.throws(()=>confirmedCityMapping({...config,city_agencies:{Rabat:1}},agencies));
});
test('unknown timezone blocks normalization and leaves global settings unchanged',()=>{
 const result=prepareDemandPreview(csv(),config,agencies,{now});
 assert.deepEqual(result.report.blockers,['timezone_required']);assert.deepEqual(result.batches,[]);assert.equal(config.csv_timezone,null);
 assert.equal(result.report.raw_bounds.start,'2026-11-02 10:00:00');assert.equal(result.report.timezone,null);
});
test('source preview reports supported cities, other locations, cancellations and duplicates without PII',()=>{
 const source=csv([line(1),line(1),line(2,'Marrakech','rider_cancelled'),line(3,'Unspecified','completed'),line(4,'Casablanca','delivery_failed')]);
 const {report}=prepareDemandPreview(source,config,agencies,{now});
 assert.equal(report.source.duplicate_trip_ids,1);assert.equal(report.cities.outside_or_unlocated.completed,1);assert.equal(report.cities.Marrakech.cancelled,1);
 for(const privateText of ['PRIVATE DRIVER','Rue Exemple','Appartement',id(1)])assert.equal(JSON.stringify(report).includes(privateText),false);
});
test('confirmed per-file timezone uses actual 32-day bounds and sanitized labels',()=>{
 const source=csv([line(1,'Casablanca','completed','2026-10-02 23:31:16'),line(2,'Marrakech','rider_cancelled','2026-11-02 23:45:55'),line(3,'Unspecified')]);
 const {report,batches}=prepareDemandPreview(source,config,agencies,confirmed);
 assert.deepEqual(report.period,{start_date:'2026-10-02',end_date:'2026-11-02'});assert.equal(report.normalized_counts.imported,2);assert.equal(report.normalized_counts.unlocated_city,1);
 assert.equal(batches[0].rows[0].pickup_zone,'Rue Exemple, Casablanca');assert.equal(config.csv_timezone,null);
 assert.equal(report.timezone_basis,'file_specific_confirmation');assert.equal(report.ready,false,'database duplicate review must still run before ready');
});
test('source schema, impossible dates, unexpected statuses and excessive range are rejected',()=>{
 for(const source of [csv([line(1,'Casablanca','completed','2026-11-31 10:00:00')]),csv([line(1,'Casablanca','unknown')]),csv().replace(id(1),'not-an-id')])assert.deepEqual(prepareDemandPreview(source,config,agencies,confirmed).report.blockers,['invalid_source_rows']);
 assert.throws(()=>inspectDemandCsv(csv().replace('UUID de la course','UUID du chauffeur')));
 assert.throws(()=>prepareDemandPreview(csv([line(1,'Casablanca','completed','2026-09-01 10:00:00'),line(2)]),config,agencies,confirmed),/32/);
});
test('comparison distinguishes new, identical, changed and cross-agency trip identities',()=>{
 const {batches}=prepareDemandPreview(csv([line(1),line(2),line(3),line(4)]),config,agencies,confirmed),batch=batches[0];
 const make=(index,changes={})=>({...batch.rows[index],agency_id:1,city:'Casablanca',...changes});
 const existing=[make(0,{started_at:'2026-11-02T10:00:00+00:00'}),make(1,{status:'cancelled'}),make(2,{agency_id:2,city:'Marrakech'})];
 const result=compareExistingDemand(batches,existing);
 assert.equal(result.new_rows,1);assert.equal(result.identical_rows,1);assert.equal(result.conflicting_rows,2);
 assert.throws(()=>compareExistingDemand(batches,[existing[0],existing[0]]),/ambigu/);
});
test('a complement contains only missing identities, preserves timestamps and is empty after a successful replay',()=>{
 const {batches}=prepareDemandPreview(csv([line(1),line(2,'Casablanca','rider_cancelled'),line(3)]),config,agencies,confirmed),batch=batches[0];
 const existing=[{...batch.rows[0],agency_id:1,city:'Casablanca'}],before=JSON.stringify(existing);
 const delta=newDemandBatches(batches,existing,{now});assert.equal(delta.length,1);assert.equal(delta[0].rows.length,2);assert.equal(delta[0].counts.completed,1);assert.equal(delta[0].counts.cancelled,1);
 assert.deepEqual(delta[0].rows,batch.rows.slice(1));assert.equal(JSON.stringify(existing),before);
 const after=[...existing,...delta[0].rows.map(row=>({...row,agency_id:1,city:'Casablanca'}))];assert.deepEqual(newDemandBatches(batches,after,{now}),[]);
 assert.throws(()=>newDemandBatches(batches,[{...existing[0],status:'cancelled'}],{now}),/Conflit/);
 assert.throws(()=>newDemandBatches(batches,[{...existing[0],agency_id:2,city:'Marrakech'}],{now}),/Conflit/);
 assert.equal(newDemandBatches(batches,existing,{now})[0].fingerprint,delta[0].fingerprint);
});
test('UTC and Morocco equivalence is not used to silently confirm unknown CSV timezone',()=>{
 const source=csv([line(1,'Casablanca','completed','2026-10-02 23:31:16'),line(2)]);
 const a=prepareDemandPreview(source,config,agencies,confirmed),b=prepareDemandPreview(source,config,agencies,{...confirmed,timezone:'Africa/Casablanca'});
 assert.deepEqual(a.batches,b.batches);
 assert.equal(prepareDemandPreview(source,config,agencies,{now}).report.ready,false);
 assert.deepEqual(prepareDemandPreview(source,config,agencies,{now}).report.blockers,['timezone_required']);
});
