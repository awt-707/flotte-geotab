import test from 'node:test';
import assert from 'node:assert/strict';
import {dockerArgs,importSQL,validateImport} from './import-reference.mjs';
import {SOURCE,REFERENCE} from './export-reference.mjs';
function sample(){return {format:'ludy-reference-v1',read_only:'on',contract_days:30,exported_at:new Date().toISOString(),source_project:SOURCE.user.slice(9),tables:Object.fromEntries(Object.keys(REFERENCE).map(k=>[k,[]]))};}
test('la destination utilise uniquement le Docker local et son socket PostgreSQL',()=>{
  const args=dockerArgs('psql',['-X']);
  assert.deepEqual(args.slice(0,5),['--host=unix:///var/run/docker.sock','exec','-i','supabase_db_ludy-staging','psql']);
  assert.ok(args.includes('--host=/var/run/postgresql'));
  assert.equal(args.some(x=>x.includes('supabase.com')||x.includes('postgresql://')),false);
});
test('source et cles dupliquees invalides sont refusees avant import',()=>{
  const value=sample();value.source_project='other';assert.throws(()=>validateImport(value),/source inattendu/);
  value.source_project=SOURCE.user.slice(9);value.tables.agencies=[{id:1,name:'Test',city:null},{id:1,name:'Other',city:null}];
  assert.throws(()=>validateImport(value),/dupliquee/);
});
test('les agences absentes sont refusees mais les anciens contrats restent representables',()=>{
  const value=sample();value.tables.drivers=[{code:'D',name:'Test',status:'ACTIF',source:'manuel',agency_id:99}];
  assert.throws(()=>validateImport(value),/Agence absente/);
  value.tables.drivers[0].agency_id=null;
  value.tables.contracts=[Object.fromEntries(REFERENCE.contracts.columns.map(k=>[k,k==='num'?'C':k==='vehicle_key'?'HISTORICAL':null]))];
  assert.equal(validateImport(value).unmatchedContractVehicles,1);
});
test('les identifiants reserves aux demos ne sont jamais repris comme production',()=>{
  const value=sample();value.tables.agencies=[{id:9001,name:'Real',city:null}];
  assert.throws(()=>validateImport(value),/jeu fictif/);
});
test('la simulation annule les donnees et ne touche pas aux sequences',()=>{
  const value=sample();value.tables.agencies=[{id:1,name:"L'agence \\ test",city:null}];
  const sql=importSQL(value,{dryRun:true});
  assert.ok(sql.endsWith('rollback;'));assert.ok(!sql.includes('select setval('));
  assert.ok(sql.includes("L''agence"));assert.ok(sql.startsWith('set standard_conforming_strings=on;'));
  assert.ok(sql.includes('Base locale de staging obligatoire'));
});
