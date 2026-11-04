import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const code = await fs.readFile(new URL('../site/fleet.js', import.meta.url), 'utf8');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function context() {
  const c = vm.createContext({ Date, esc: escape, fmtDT: value => value });
  vm.runInContext(code, c);
  return { c, run: script => vm.runInContext(script, c) };
}
test('platform vehicle details retain their own plate/model and never certify a stored Bolt selection', () => {
  const { c, run } = context();
  c.ob = { vehicle_label: 'TEST-123', observed_at: new Date().toISOString(), evidence: { vehicle_model: 'Hyundai Staria', vehicle_origin: 'bolt_selected' } };
  assert.match(run("fleetVehicleInfoHtml(ob, 'bolt')"), /TEST-123 · Hyundai Staria/);
  assert.match(run("fleetVehicleInfoHtml(ob, 'bolt')"), /Sélection Bolt · affectation à confirmer/);
  run("ob.evidence.vehicle_origin='bolt_live'");
  assert.match(run("fleetVehicleInfoHtml(ob, 'bolt')"), /Indication Bolt/);
  assert.doesNotMatch(run("fleetVehicleInfoHtml(ob, 'bolt')"), /Affectation actuelle confirmée/);
});
test('fresh platform status cannot refresh an older independently observed vehicle', () => {
  const { c, run } = context();
  c.ob = { vehicle_label: 'TEST-123', observed_at: new Date().toISOString(), stale_after_s: 90, evidence: { vehicle_model: '2026 Hyundai Staria', vehicle_observed_at: new Date(Date.now() - 120000).toISOString() } };
  assert.match(run("fleetVehicleInfoHtml(ob, 'uber')"), /Dernière indication · à actualiser/);
  run('ob.evidence.vehicle_observed_at=ob.observed_at');
  assert.match(run("fleetVehicleInfoHtml(ob, 'uber')"), /Indication Uber Fleet/);
});
test('platform descriptions are escaped and a model alone remains an unidentified plate', () => {
  const { c, run } = context();
  c.ob = { observed_at: new Date().toISOString(), evidence: { vehicle_model: '<img src=x onerror=bad()>' } };
  const html = run("fleetVehicleInfoHtml(ob, 'uber')");
  assert.match(html, /Plaque non lue/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
  assert.equal(run("fleetVehicleInfoHtml(null, 'bolt')"), '');
  c.driver = { vehicle_model: 'Ignore mixed global model', sources: { uber: { vehicle_label: 'ONE', evidence: { vehicle_model: 'Staria' } }, bolt: { vehicle_label: 'TWO', evidence: { vehicle_model: 'Sonata' } } } };
  assert.equal(run('fleetVehicleSearch(driver)'), 'ONE Staria TWO Sonata');
});
test('Uber coverage distinguishes older extensions without plate metrics from a measured zero', () => {
  const { run } = context();
  assert.match(run('fleetUberVehicleCoverage({drivers:13})'), /non mesurée.*0.5.1/);
  assert.doesNotMatch(run('fleetUberVehicleCoverage({drivers:13})'), /0 plaque/);
  assert.match(run('fleetUberVehicleCoverage({drivers:13,vehicleObserved:0,vehicleComplete:false})'), /0 plaque\(s\) lue\(s\) \/ 13 chauffeur\(s\).*restantes/);
  assert.match(run('fleetUberVehicleCoverage({drivers:13,vehicleObserved:13,vehicleComplete:true})'), /13 plaque\(s\) lue\(s\) \/ 13 chauffeur\(s\).*liste lues/);
});
