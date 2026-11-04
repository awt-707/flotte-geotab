import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createDemandCityReview,loadDemandCityReview,validateDemandCityReview,demandReviewIdentity,demandReviewSignature} from '../server/demand-city-review.mjs';
import {normalizeDemandImport,analyzeDemand} from '../server/demand-analytics.mjs';
import {pickupReferenceForScope} from '../server/pickup-reference.mjs';
import {prepareDemandCityReview} from '../scripts/prepare-demand-city-review.mjs';

const now=Date.parse('2026-11-03T15:00:00Z');
const makeRow=(id,status='completed')=>{const n=normalizeDemandImport({agency_id:1,city:'Casablanca',file_name:'synthetic.csv',rows:[{external_id:id,started_at:'2026-11-02 10:00:00',pickup_zone:'Synthetic ambiguous place',status}]},{now});return {...n.rows[0],agency_id:1,city:'Casablanca'};};
const plan=(rows,decision='quarantined')=>({version:1,reviewed_at:new Date(now).toISOString(),source_sha256:'a'.repeat(64),entries:rows.map(row=>({agency_id:row.agency_id,ride_key:demandReviewIdentity(row),signature:demandReviewSignature(row),decision,basis:decision==='quarantined'?'unresolved_locality':'explicit_country_city',evidence:[]}))});

test('exact reviewed rows are excluded from every analytic output without changing the originals',()=>{
 const removed=makeRow('synthetic-uncertain'),cancelled=makeRow('synthetic-cancelled','cancelled'),kept={...makeRow('synthetic-clear'),pickup_zone:'Synthetic confirmed street'},rows=[removed,cancelled,kept],before=structuredClone(rows);
 const report=analyzeDemand([...rows,{...removed}],{now,cityReview:createDemandCityReview(plan([removed,cancelled]))});
 assert.equal(report.total,1);assert.equal(report.completed,1);assert.equal(report.cancelled,0);assert.equal(report.coverage.report_rows,3);assert.equal(report.coverage.duplicates,1);
 assert.deepEqual(report.coverage.city_review,{status:'loaded',matched:2,confirmed:0,quarantined:2,changed:0,completed:1,cancelled:1});
 assert.equal(report.by_hour.reduce((n,r)=>n+r.count,0),1);assert.equal(report.by_weekday.reduce((n,r)=>n+r.count,0),1);assert.deepEqual(report.zones.map(r=>r.zone),['Synthetic confirmed street']);assert.deepEqual(rows,before);
 assert.doesNotMatch(JSON.stringify(report),/synthetic-uncertain|synthetic-cancelled|source_sha256|ride_key|signature/);
});
test('a name, another UUID or another agency cannot inherit a quarantine; known changed rows require review',()=>{
 const row=makeRow('synthetic-one'),review=createDemandCityReview(plan([row]));
 const otherId=makeRow('synthetic-two'),otherAgency={...row,agency_id:2};otherAgency.ride_key=demandReviewIdentity(otherAgency);
 assert.equal(review.partition([otherId,otherAgency]).excluded.length,0);
 const changed=review.partition([{...row,pickup_zone:'Changed value'}]);assert.equal(changed.excluded.length,1);assert.equal(changed.coverage.changed,1);
 const priorConfirmation=createDemandCityReview(plan([row],'confirmed'));assert.equal(priorConfirmation.partition([row]).included.length,1);assert.equal(priorConfirmation.partition([{...row,status:'cancelled'}]).excluded.length,1);
});
test('equivalent Postgres timestamps retain their exact signature and corrupt ride keys do not bypass a review',()=>{
 const row=makeRow('synthetic-time'),review=createDemandCityReview(plan([row]));
 assert.equal(demandReviewSignature({...row,started_at:'2026-11-02 10:00:00+00'}),demandReviewSignature(row));
 assert.equal(review.partition([{...row,ride_key:'b'.repeat(64)}]).coverage.changed,1);
});
test('city and agency scopes expose only their matching review counts; catalogue denominator matches analysis',()=>{
 const row=makeRow('synthetic-one'),review=createDemandCityReview(plan([row]));
 const other={...makeRow('synthetic-other'),agency_id:2,city:'Marrakech'};other.ride_key=demandReviewIdentity(other);
 assert.equal(analyzeDemand([row,other],{now,agency_id:2,cityReview:review}).coverage.city_review.quarantined,0);
 const c=pickupReferenceForScope({rides:[row,other],agencies:[{id:1,city:'Casablanca'},{id:2,city:'Marrakech'}],cityReview:review});
 assert.equal(c.cities[0].imported.requests,0);assert.equal(c.cities[0].imported.storedRequests,1);assert.equal(c.cities[0].imported.cityReview.quarantined,1);assert.equal(c.cities[1].imported.requests,1);
});
test('a missing or invalid private plan is disclosed rather than a successful empty review',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ludy-review-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const filename=path.join(dir,'plan.json'),row=makeRow('synthetic-one');
 assert.equal(loadDemandCityReview(filename).partition([row]).coverage.status,'not_loaded');
 fs.writeFileSync(filename,JSON.stringify(plan([row])),{mode:0o600});assert.equal(loadDemandCityReview(filename).partition([row]).excluded.length,1);
 fs.chmodSync(filename,0o644);assert.equal(loadDemandCityReview(filename).partition([row]).coverage.status,'invalid');fs.chmodSync(filename,0o600);
 fs.symlinkSync(filename,path.join(dir,'link.json'));assert.equal(loadDemandCityReview(path.join(dir,'link.json')).partition([row]).coverage.status,'invalid');
 fs.writeFileSync(filename,'{"broken":true}');assert.equal(loadDemandCityReview(filename).partition([row]).coverage.status,'invalid');
 const result=analyzeDemand([row],{now});assert.match(result.warnings.join(' '),/Contrôle local des villes non chargé/);assert.equal(result.total,1,'no speculative global quarantine');
});
test('validation rejects contradictory, duplicate or unproven decisions',()=>{
 const p=plan([makeRow('synthetic-one')]);assert.throws(()=>validateDemandCityReview({...p,entries:[p.entries[0],p.entries[0]]}));
 assert.throws(()=>validateDemandCityReview({...p,entries:[{...p.entries[0],decision:'confirmed'}]}));
 assert.throws(()=>validateDemandCityReview({...p,entries:[{...p.entries[0],decision:'confirmed',basis:'official_venue_address'}]}));
 assert.throws(()=>validateDemandCityReview({...p,extra:'private'}));
});
test('reproducible preparation requires original hash, user timezone evidence and exact current values',()=>{
 const csv='UUID de la course,Heure de la demande de course,Adresse de prise en charge,Statut de la course\nsynthetic-a,2026-11-02 10:00:00,Synthetic ambiguous place,completed\n';
 const decisions={version:1,source_sha256:createHash('sha256').update(csv).digest('hex'),agency_id:1,city:'Casablanca',timezone:'Africa/Casablanca',timezone_evidence:'Synthetic explicit confirmation',entries:[{external_id:'synthetic-a',decision:'quarantined',basis:'unresolved_locality',evidence:[]}]};
 const row=makeRow('synthetic-a'),result=prepareDemandCityReview(csv,decisions,[row],{now});assert.equal(result.report.quarantined,1);assert.equal(result.report.databaseWrites,0);assert.equal(result.report.summaries.Casablanca.analyzed,0);
 assert.doesNotMatch(JSON.stringify(result.plan),/synthetic-a|Synthetic ambiguous place/);
 for(const data of [{...decisions,source_sha256:'b'.repeat(64)},{...decisions,timezone_evidence:null},{...decisions,timezone:'UTC'}])assert.throws(()=>prepareDemandCityReview(csv,data,[row],{now}));
 assert.throws(()=>prepareDemandCityReview(csv,decisions,[{...row,city:'Marrakech'}],{now}));assert.throws(()=>prepareDemandCityReview(csv,decisions,[],{now}));
});
