import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUberDriverReport} from '../server/uber-driver-reports.mjs';
import {readUberCsv} from '../server/uber-reports.mjs';
const now=Date.parse('2026-11-02T10:00:00Z'),period={start_date:'2026-10-26',end_date:'2026-11-01'},config={date_format:'ymd'},driver='11111111-1111-4111-8111-111111111111',trip='22222222-2222-4222-8222-222222222222';
const parse=(header,row,type='trip_activity')=>normalizeUberDriverReport([header,row],type,config,{period,now});
test('trip reports retain provider identity and exact vehicle data without inventing money, pickup time or duration',()=>{
 const value=parse(['Trip UUID','Driver UUID','Driver first name','Driver last name','Trip request time','Trip drop off time','Trip status','Trip distance (km)','License plate'],[trip,driver,'Synthetic','Driver','2026-11-01 10:00','2026-11-01 11:00','completed','12.5','ABC-123']);
 const row=value.rows[0];assert.equal(row.provider_driver_id,driver);assert.equal(row.driver_name,'Synthetic Driver');assert.equal(row.requested_at,'2026-11-01T10:00:00.000Z');assert.equal(row.started_at,null);assert.equal(row.finished_at,'2026-11-01T11:00:00.000Z');assert.equal(row.distance_km,12.5);assert.equal(row.vehicle_label,'ABC-123');assert.equal(row.amount,undefined);assert.equal(row.duration_s,undefined);assert.equal(value.period.to_at,'2026-11-02T00:00:00.000Z');
});
test('unknown distance units remain missing and ambiguous driver IDs are not replaced by names',()=>{
 const header=['Trip UUID','Driver UUID','Driver first name','Driver last name','Trip request time','Trip status','Trip distance'],row=[trip,'','Synthetic','Driver','2026-11-01 10:00','driver_cancelled','12.5'];let value=parse(header,row);assert.equal(value.rows[0].distance_km,null);assert.equal(value.counts.distance_without_unit,1);assert.equal(value.rows[0].provider_driver_id,null);assert.equal(value.rows[0].status,'driver_cancelled');
 row[1]='invalid';assert.throws(()=>parse(header,row),/Identifiant chauffeur/);row[1]=driver;assert.equal(parse([...header,'Distance unit'],[...row,'miles']).rows[0].distance_km,12.5*1.609344);
 assert.throws(()=>parse([...header.slice(0,-1),'Trip distance (km)','Distance unit'],[...row,'miles']),/contradictoires/);
});
test('trip chronology, period, duplicate identities and unsupported measures fail closed',()=>{
 const h=['Trip UUID','Trip request time','Trip status','Trip drop off time','Trip distance (km)'],r=[trip,'2026-11-01 10:00','completed','2026-11-01 11:00','12.5'];
 for(const changed of [[trip,'2026-10-25 10:00',...r.slice(2)],[...r.slice(0,3),'2026-11-01 09:00','12.5'],[...r.slice(0,4),'1,234']])assert.throws(()=>parse(h,changed));
 const duplicates=normalizeUberDriverReport([h,r,r],'trip_activity',config,{period,now});assert.equal(duplicates.rows.length,1);assert.equal(duplicates.counts.driver_duplicates,1);
 assert.throws(()=>normalizeUberDriverReport([h,r,[...r.slice(0,4),'20']],'trip_activity',config,{period,now}),/contradictoires/);
});
test('driver activity uses explicit D:H:M or decimal-hour units and never infers a pause',()=>{
 const h=['Driver UUID','Trips completed','Time online (days : hours: minutes)','Time on trip (days: hours : minutes)'],r=[driver,'14','1:02:30','0:12:15'];const row=parse(h,r,'driver_activity').rows[0];assert.equal(row.online_seconds,95400);assert.equal(row.trip_seconds,44100);assert.equal(row.pause_seconds,undefined);assert.equal(row.waiting_seconds,undefined);
 assert.equal(parse(['Driver UUID','Trips completed','Hours online','Hours on trip'],[driver,'14','26.5','12.25'],'driver_activity').rows[0].online_seconds,95400);
 for(const changed of [[driver,'14','26.5','0:12:15'],[driver,'14','0:01:00','0:02:00'],[driver,'14','7:23:00','0:02:00']])assert.throws(()=>parse(h,changed,'driver_activity'));
});
test('driver quality retains official fractions or explicit percentages, leaving missing metrics null',()=>{
 const h=['Driver UUID','Trips completed','Acceptance rate','Cancellation rate','Trips Accepted(Excluding trip radar or similar)'];let row=parse(h,[driver,'14','0.85','5%','17'],'driver_quality').rows[0];assert.equal(row.acceptance_rate,.85);assert.equal(row.cancellation_rate,.05);assert.equal(row.accepted_count,17);assert.equal(row.rejected_count,null);assert.equal(row.completion_rate,null);
 assert.throws(()=>parse(h,[driver,'14','85','5','17'],'driver_quality'));
 row=parse(['Driver first name','Driver last name','Trips completed','Acceptance rate (%)','Cancellation rate (%)'],['Synthetic','Driver','14','85','5'],'driver_quality').rows[0];assert.equal(row.provider_driver_id,null);assert.equal(row.acceptance_rate,.85);
 assert.equal(readUberCsv('Driver UUID,Trips completed,Hours online,Hours on trip\n'+driver+',14,26.5,12.25').length,2);
});

test('the French Fleet activity export retains its explicit days hours minutes units',()=>{
 const row=parse(['UUID du chauffeur','Prénom du chauffeur','Nom du chauffeur','Courses effectuées','Temps passé en ligne (jours\u00a0: heures\u00a0: minutes)','Temps passé à effectuer des courses (jours\u00a0: heures\u00a0: minutes)'],[driver,'Synthetic','Driver','83','02:16:28','00:23:45'],'driver_activity').rows[0];
 assert.equal(row.trips_completed,83);assert.equal(row.online_seconds,232080);assert.equal(row.trip_seconds,85500);
});

test('French Fleet quality ratios remain fractions and do not mix with app lifetime rates',()=>{
 const row=parse(['UUID du chauffeur','Prénom du chauffeur','Nom du chauffeur','Courses effectuées',"Taux d'acceptation","Taux d'annulation",'Pourcentage de courses effectuées',"Taux d'acceptation du chauffeur (application pour les chauffeurs et les coursiers)",'Courses acceptées (hors Trip\u00a0Radar ou similaire)','Courses refusées','Courses annulées'],[driver,'Synthetic','Driver','63','1.00','0.00','0.81','98.0%','64','2','0'],'driver_quality').rows[0];
 assert.equal(row.acceptance_rate,1);assert.equal(row.cancellation_rate,0);assert.equal(row.completion_rate,.81);assert.equal(row.accepted_count,64);assert.equal(row.rejected_count,2);assert.equal(row.cancelled_count,0);
});
