import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import olc from '../server/pickup-reference-olc.mjs';
import {auditPickupReferenceFile,decodeAddressPlusCode,extractAddressPlusCodes,explicitPlusCodeCity} from '../server/pickup-reference-validation.mjs';
import {applyPickupReferenceEvidence,ALGORITHM_SOURCE,LOCALITY_CONTEXTS} from '../server/pickup-reference-evidence.mjs';
import original from '../server/pickup-reference-data.mjs';
import evidence from '../server/pickup-reference-validation-data.mjs';
import {loadPickupReference,pickupReferenceForScope} from '../server/pickup-reference.mjs';
import {renderPickupReference} from '../site/pickup-reference.js';

test('the pinned official Open Location Code implementation passes all 420 decoding and 19 recovery vectors',async()=>{
 let decoding=0,recovery=0;
 for(const line of (await readFile(new URL('./fixtures/pickup-reference-olc-decoding.csv',import.meta.url),'utf8')).split('\n')){
  if(!line.trim()||line.startsWith('#'))continue;const [code,length,...bounds]=line.split(','),area=olc.decode(code);assert.equal(area.codeLength,Number(length));
  for(const [i,key]of ['latitudeLo','longitudeLo','latitudeHi','longitudeHi'].entries())assert.ok(Math.abs(area[key]-Number(bounds[i]))<1e-10);decoding++;
 }
 for(const line of (await readFile(new URL('./fixtures/pickup-reference-olc-recovery.csv',import.meta.url),'utf8')).split('\n')){
  if(!line.trim()||line.startsWith('#'))continue;const [full,lat,lon,short,type]=line.split(',');if(type==='S')continue;assert.equal(olc.recoverNearest(short,Number(lat),Number(lon)),full);recovery++;
 }
 assert.equal(decoding,420);assert.equal(recovery,19);assert.match(ALGORITHM_SOURCE.url,/google\/open-location-code\/blob\/83986da/);
});
test('a short code is never decoded without an explicit locality and keeps its contextual provenance',()=>{
 const {latitude,longitude}=LOCALITY_CONTEXTS.Casablanca,full=olc.encode(latitude,longitude,11),short=full.slice(4);
 assert.equal(decodeAddressPlusCode(short).area,null);assert.equal(decodeAddressPlusCode(short).method,'short_code_unresolved');
 assert.equal(decodeAddressPlusCode(short,{city:'Casablanca'}).fullCode,full);assert.equal(decodeAddressPlusCode(short,{city:'Casablanca'}).context.url,LOCALITY_CONTEXTS.Casablanca.url);
 assert.equal(decodeAddressPlusCode(full).method,'full_code');assert.equal(decodeAddressPlusCode(full).represents,'address_code_area_not_trip_gps');
 assert.equal(explicitPlusCodeCity(short+', Casablanca 20250, Morocco'),'Casablanca');
 assert.equal(explicitPlusCodeCity(short+', Route de Casablanca, Rabat, Morocco'),null);
 assert.equal(explicitPlusCodeCity(short+', Casablanca, Marrakech'),null);
 assert.deepEqual(extractAddressPlusCodes('invalid AAAA+AAA; '+short),[short]);
});
const headers=['UUID de la course','Heure de la demande de course','Adresse de prise en charge','Statut de la course'];
const fixture=(extra=[])=>[headers,
 ['synthetic-private-id-1','2026-10-02 23:50:00','Casablanca 20250','completed'],
 ['synthetic-private-id-2','2026-10-03 12:00:00','Casablanca 20250, Morocco','rider_cancelled'],
 ['synthetic-private-id-3','2026-10-04 12:00:00','PRIVATE ADDRESS, Casablanca','delivery_failed'],
 ['synthetic-private-id-4','2026-10-04 12:00:00','PRIVATE ADDRESS, Dar-el-Beïda, Maroc','completed'],
 ['synthetic-private-id-5','2026-10-05 12:00:00','Marrakech, Maroc','completed'],
 ['synthetic-private-id-6','2026-10-06 12:00:00','PRIVATE ADDRESS, Rabat, Maroc','completed'],...extra].map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\n');
test('audit separates source dates, excluded statuses, aliases and explicit rate denominators without changing imports',()=>{
 const result=auditPickupReferenceFile(fixture(),original),casa=result.report.cities.Casablanca;
 assert.equal(casa.sourceRows,3);assert.equal(casa.eligibleRows,2);assert.equal(casa.excludedStatuses,1);assert.equal(casa.eligibleInDeclaredPeriod,1);assert.equal(casa.outsideDeclaredPeriod,1);
 assert.equal(casa.unimportedAliasCandidates,1);assert.equal(casa.declaredCountReproduced,false);assert.equal(casa.simpleCityLabel.numerator,2);assert.equal(casa.simpleCityLabel.denominator,2);assert.equal(casa.simpleCityLabel.sameDefinitionAsDeclared,false);
 assert.equal(result.report.outside.rows,2);assert.equal(result.report.outside.otherMunicipalityCandidates.Rabat,1);assert.equal(result.report.source.uniqueTripIds,6);
 assert.doesNotMatch(JSON.stringify(result.report),/PRIVATE ADDRESS|synthetic-private-id/);
 const duplicate=auditPickupReferenceFile(fixture([['synthetic-private-id-1','2026-10-03 10:00:00','Casablanca','completed']]),original);
 assert.equal(duplicate.report.source.duplicateRows,1);assert.equal(duplicate.report.source.uniqueTripIds,6);
});
test('reviewed source totals explain the mismatch but never certify 5945 or declared percentages',()=>{
 const casa=evidence.cities.Casablanca,marrakech=evidence.cities.Marrakech;
 assert.equal(evidence.source.rows,6544);assert.equal(evidence.source.uniqueTripIds,6544);assert.equal(evidence.source.duplicateRows,0);
 assert.equal(casa.sourceRows,5220);assert.equal(casa.eligibleRows,5219);assert.equal(casa.eligibleInDeclaredPeriod,5214);assert.equal(casa.differenceWithinDeclaredPeriod,731);
 assert.equal(casa.unimportedAliasCandidates,555);assert.equal(casa.declaredCountReproduced,false);assert.equal(casa.simpleCityLabel.numerator,281);assert.equal(casa.simpleCityLabel.percent,5.38);
 assert.equal(casa.confirmedLocalitySuffixRows,537);assert.equal(casa.eligibleAfterLocalityReview,5756);
 assert.equal(marrakech.eligibleRows,501);assert.equal(marrakech.eligibleInDeclaredPeriod,495);assert.equal(marrakech.simpleCityLabel.numerator,55);
 assert.equal(marrakech.confirmedLocalitySuffixRows,20);assert.equal(marrakech.eligibleAfterLocalityReview,521);
 assert.equal(casa.plusCodes.recoveredRows,260);assert.equal(casa.plusCodes.unresolvedRows,11);assert.equal(marrakech.plusCodes.recoveredRows,14);
 assert.equal(evidence.codeChecks.filter(row=>row.status==='coordinate_consistent_with_contextual_code').length,8);
 assert.ok(evidence.codeChecks.every(row=>row.venueIdentityVerified!==true&&row.pickupVerified!==true));
 assert.equal(loadPickupReference().declarations.Casablanca.unlocatedAddressPercent,22);assert.equal(loadPickupReference().declarations.Marrakech.unlocatedAddressPercent,21);
});
test('only three unambiguous public venue coordinates change and all original coordinates remain available',()=>{
 const before=JSON.stringify(original),reviewed=applyPickupReferenceEvidence(original),changed=reviewed.entries.filter(row=>row.coordinates.basis==='official_venue_location');
 assert.equal(changed.length,3);assert.equal(reviewed.entries.length,79);assert.equal(JSON.stringify(original),before);
 assert.deepEqual(changed.map(row=>row.review.sources[0].distanceFromProvidedMeters).sort((a,b)=>a-b),[427,1166,1509]);
 for(const row of changed){const old=original.entries.find(entry=>entry.id===row.id);assert.equal(row.coordinates.original.latitude,old.latitude);assert.equal(row.coordinates.original.longitude,old.longitude);assert.equal(row.coordinates.verified,false);assert.equal(row.review.pickupVerified,false);}
 const grouped=reviewed.entries.find(row=>row.id==='a3376a11d2c56bfbb4f86a6e');assert.equal(grouped.review.action,'compare');assert.equal(grouped.latitude,33.5983);assert.equal(grouped.review.sources.length,2);
 assert.equal(reviewed.entries.filter(row=>row.coordinates.basis==='provided_estimate').length,20);
 for(const id of ['a2715cef2ff05b365cd3f971','c9a02e752d34a1ec1b1750be','0f57f08b2808af87a5add7da']){const row=reviewed.entries.find(r=>r.id===id),old=original.entries.find(r=>r.id===id);assert.equal(row.review.action,'unresolved');assert.equal(row.latitude,old.latitude);assert.equal(row.longitude,old.longitude);assert.equal(row.coordinates.verified,false);assert.match(row.review.sources[0].sourceSha256,/^[a-f0-9]{64}$/);assert.equal(row.review.sources[0].checkedAt,'2026-11-03');}
 const unknown=structuredClone(original);unknown.source.sha256='0'.repeat(64);assert.deepEqual(applyPickupReferenceEvidence(unknown),unknown);
});
test('the scoped UI distinguishes source-file evidence, context decoding and official publication without requesting maps',()=>{
 const reference=pickupReferenceForScope({agencies:[{id:1,city:'Casablanca'}]}),html=renderPickupReference(reference);
 assert.equal(reference.cities.length,1);assert.equal(reference.cities[0].validation.eligibleRows,5219);
 assert.equal(pickupReferenceForScope({agencies:[{id:99,city:'Casablanca'}]}).cities[0].validation,null,'another agency in the same city never inherits this file’s operational counts');
 assert.doesNotMatch(JSON.stringify(reference),/"outside"|"Marrakech"|privateCodeEvidence|csvRow|fullCode/);
 assert.match(html,/Contrôle du fichier source/);assert.match(html,/5.?214/);assert.match(html,/555 autres lignes/);assert.match(html,/5,38 %/);
 assert.match(html,/Localisation publiée par l’établissement/);assert.match(html,/Point initial conservé/);assert.match(html,/1.?166 m du point initial/);assert.match(html,/entrée de prise en charge non vérifiée/);
 assert.match(html,/href="https:\/\/all\.accor\.com\/hotel\/B4P8/);assert.doesNotMatch(html,/<iframe|<script|empreinte/);
 reference.cities[0].entries.find(row=>row.review).review.sources[0].url='javascript:alert(1)';assert.doesNotMatch(renderPickupReference(reference),/href="javascript:/);
});
