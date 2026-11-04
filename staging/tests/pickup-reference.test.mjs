import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parsePickupReferenceCsv,pickupReferenceForScope,loadPickupReference} from '../server/pickup-reference.mjs';
import {renderPickupReference,renderPickupReferenceMap} from '../site/pickup-reference.js';
import originalCatalog from '../server/pickup-reference-data.mjs';

const header='ville;zone;point;type;part_zone_pct_ou_part_du_point;latitude;longitude;rayon_km;creneau_dominant;source_coordonnees;lien_google_maps';
const line=(changes={})=>Object.values({city:'Casablanca',zone:'Synthetic zone',point:'',kind:'zone',share:'22.7',lat:'33.596',lon:'-7.616',radius:'1.0',peak:'8h-12h (23 %)',source:'plus code export (exact)',link:'https://www.google.com/maps?q=33.596,-7.616',...changes}).join(';');
const csv=(rows=[line()])=>header+'\n'+rows.join('\n');
const agencies=[{id:1,city:'Casablanca'},{id:2,city:'Marrakech'}];
const ride=(n,extra={})=>({agency_id:1,city:'Casablanca',ride_key:'r'+n,external_id:'trip'+n,status:n<4125?'completed':'cancelled',started_at:n===0?'2026-10-02T23:31:16Z':'2026-11-02T12:00:00Z',pickup_zone:'Original pickup text',...extra});

test('the supplied catalog retains 17 zones, 62 points and all uncertainty classes',()=>{
 const data=originalCatalog;assert.equal(data.entries.length,79);assert.equal(data.entries.filter(r=>r.kind==='zone').length,17);assert.equal(data.entries.filter(r=>r.kind==='point').length,62);
 assert.equal(data.entries.filter(r=>r.city==='Casablanca').length,45);assert.equal(data.entries.filter(r=>r.city==='Marrakech').length,34);
 assert.equal(data.entries.filter(r=>r.coordinates.basis==='provided_plus_code').length,54);assert.equal(data.entries.filter(r=>r.coordinates.basis==='provided_wikipedia').length,2);
 assert.equal(data.entries.filter(r=>r.coordinates.uncertaintyMeters===200).length,23);assert.ok(data.entries.every(r=>r.coordinates.verified===false&&r.coordinates.rawPlusCode===null));
 assert.equal(data.entries.filter(r=>r.latitude===null&&r.longitude===null).length,1);
 assert.equal(data.entries.filter(r=>r.kind==='point'&&r.parentZoneId===null).length,1,'a standalone airport point has no invented zone');
 assert.equal(data.source.sha256,'27479317e095b9a253c14d8af49b20549f6e5e332486e813e5e968e235807c54');
});
test('source rates, peaks and subzone text are preserved without converting denominators',()=>{
 const data=loadPickupReference(),zone=data.entries.find(r=>r.city==='Casablanca'&&r.kind==='zone'),point=data.entries.find(r=>r.kind==='point'&&r.reportedShare?.startsWith('57'));
 assert.equal(zone.reportedShare,'22.7');assert.match(point.reportedShare,/57 % de la zone/);
 assert.equal(zone.reportedShareBasis,'localisable_pickups_in_declared_city');assert.equal(point.reportedShareBasis,'subzone_as_described');
 assert.equal(data.declarations.Casablanca.requests,5945);assert.equal(data.declarations.Marrakech.requests,null);
 assert.equal(data.declarations.Casablanca.unlocatedAddressPercent,22);assert.equal(data.declarations.Marrakech.unlocatedAddressPercent,21);
});
test('the Casablanca scope comparison is explicit and never rewrites or geolocates imported trips',()=>{
 const rides=Array.from({length:5219},(_,n)=>ride(n)),before=JSON.stringify(rides),result=pickupReferenceForScope({rides,agencies,agencyId:'1'}),city=result.cities[0];
 assert.equal(city.imported.requests,5219);assert.equal(city.imported.completed,4125);assert.equal(city.imported.cancelled,1094);
 assert.equal(city.comparison.requestCountDifference,726);assert.equal(city.comparison.sameScopeConfirmed,false);
 assert.equal(city.imported.period.fromDay,'2026-10-02');assert.equal(city.declared.period.from,'2026-10-03');
 assert.equal(city.declared.verified,false);assert.equal(city.declared.statusScope,'not_confirmed');assert.equal(JSON.stringify(rides),before);
 assert.ok(rides.every(row=>!Object.hasOwn(row,'latitude')&&!Object.hasOwn(row,'longitude')));
 assert.equal(city.entries[0].reportedShare,'22.7','a supplied share is not scaled by the imported ride count');
});
test('reference visibility follows authorized agency cities and requested scope',()=>{
 const rides=[ride(1),ride(2,{agency_id:2,city:'Marrakech'})];
 assert.deepEqual(pickupReferenceForScope({rides,agencies:[agencies[0]]}).cities.map(c=>c.name),['Casablanca']);
 assert.deepEqual(pickupReferenceForScope({rides,agencies,agencyId:'2'}).cities.map(c=>c.name),['Marrakech']);
 assert.deepEqual(pickupReferenceForScope({rides,agencies,agencyId:'1',city:'Marrakech'}).cities,[]);
 assert.deepEqual(pickupReferenceForScope({rides,agencies:[]}).cities,[]);
 const result=pickupReferenceForScope({rides:[ride(1),ride(1),ride(2,{status:'delivery_failed'})],agencies,city:'Casablanca'});
 assert.equal(result.cities[0].imported.requests,1);
});
test('the parser rejects inconsistent coordinates, arbitrary links and unknown provenance',()=>{
 for(const changes of [{lat:'91'},{lat:'',lon:'-7.616'},{radius:'80'},{source:'verified geocoder'},{link:'https://outside.invalid/maps?q=33.596,-7.616'},{link:'https://www.google.com/maps?q=0,0'},{kind:'ride'}])assert.throws(()=>parsePickupReferenceCsv(csv([line(changes)])));
 assert.throws(()=>parsePickupReferenceCsv(csv([line(),line()])),/dupliqué/);
 const orphan=parsePickupReferenceCsv(csv([line({point:'Standalone airport',kind:'point',radius:'',share:''})]));assert.equal(orphan.entries[0].parentZoneId,null);
 assert.equal(orphan.declarations.Casablanca.requests,null,'a different CSV never inherits the user summary for this exact source hash');assert.equal(orphan.declarations.Casablanca.period,null);
});
test('the offline presentation labels estimates, unverified rates and missing coordinates; links are click-only',async()=>{
 const reference=pickupReferenceForScope({agencies,rides:[ride(0)]}),html=renderPickupReference(reference);
 assert.match(html,/Vue schématique hors ligne/);assert.match(html,/aucun point ne représente une course/i);assert.match(html,/Coordonnées non fournies/);
 assert.match(html,/±200 m annoncés, non vérifiés/);assert.match(html,/Plus code déclaré · code brut absent/);assert.match(html,/Wikipedia déclarée/);
 assert.match(html,/base localisable non fournie/);assert.match(html,/Aucun pourcentage fourni n’est présenté comme un calcul Ludy/);
 assert.match(html,/target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/);
 assert.match(html,/Source : zones_pickup_gps \(1\)\.csv\./);assert.doesNotMatch(html,/empreinte|27479317e095/);
 assert.doesNotMatch(html,/<(?:iframe|img|script)\b/);
 const source=await readFile(new URL('../site/pickup-reference.js',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/);
});
test('an unspecified address rate is shown as missing while an explicit zero stays a known rate',()=>{
 const catalog=parsePickupReferenceCsv(csv()),reference=pickupReferenceForScope({agencies,catalog});
 assert.match(renderPickupReference(reference),/Adresses sans précision annoncées : Non fourni\./);
 assert.doesNotMatch(renderPickupReference(reference),/null\s*%|annoncées :\s*%/);
 reference.cities[0].declared.unlocatedAddressPercent=0;
 assert.match(renderPickupReference(reference),/Adresses sans précision annoncées : 0 %/);
});
test('labels are escaped and an altered external URL never becomes a live link',()=>{
 const catalog=parsePickupReferenceCsv(csv([line({zone:'<img src=x onerror=alert(1)>'})]));
 catalog.entries[0].mapsUrl='javascript:alert(1)';
 const html=renderPickupReference(pickupReferenceForScope({agencies,catalog}));
 assert.doesNotMatch(html,/<img|href="javascript:/);assert.match(html,/&lt;img/);
 assert.equal(renderPickupReferenceMap([{latitude:null,longitude:null}],'Casablanca'),'');
});
