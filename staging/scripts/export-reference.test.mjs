import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REFERENCE, SOURCE_CA, checkSourceCA, psqlExportArgs, psqlExportEnv, validateReference } from './export-reference.mjs';

const sample=()=>({format:'ludy-reference-v1',read_only:'on',contract_days:30,exported_at:new Date().toISOString(),tables:Object.fromEntries(Object.keys(REFERENCE).map(k=>[k,[]]))});
test('le client demande le mot de passe localement et ignore les configurations PG ambiantes',()=>{
  const args=psqlExportArgs(),env=psqlExportEnv({PATH:'/bin',PGPASSWORD:'secret',PGSERVICE:'production',PGOPTIONS:'-c default_transaction_read_only=off',PGHOST:'elsewhere',PGPASSFILE:'/unexpected',PGSSLMODE:'require',PGSSLROOTCERT:'/untrusted.crt'});
  assert.ok(args.includes('--password'));assert.ok(args.includes('--no-psqlrc'));assert.ok(args.includes('--set=ON_ERROR_STOP=1'));
  assert.equal(env.PATH,'/bin');for(const key of ['PGPASSWORD','PGSERVICE','PGOPTIONS','PGHOST','PGPASSFILE'])assert.equal(env[key],undefined);
  assert.equal(env.PGSSLMODE,'verify-full');assert.equal(env.PGSSLROOTCERT,SOURCE_CA);
  assert.equal(args.some(x=>x.includes('secret')),false);
});
test('la CA Supabase officielle est disponible localement sans changer la confiance systeme',()=>{
  assert.equal(path.isAbsolute(SOURCE_CA),true);
  const cert=checkSourceCA();
  assert.equal(cert.ca,true);assert.equal(cert.verify(cert.publicKey),true);
  assert.match(cert.subject,/CN=Supabase Root 2021 CA/);
  assert.equal(cert.fingerprint256.replaceAll(':','').toLowerCase(),'807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa');
});
test('un extrait valide donne seulement les comptes par table',()=>{
  const value=sample();value.tables.drivers=[{code:'TEST',name:'A "quoted" name',status:'ACTIF',source:'manuel',agency_id:null}];
  assert.equal(validateReference(value).drivers,1);
});
test('un depassement ne produit pas de copie silencieusement tronquee',()=>{
  const value=sample();value.tables.agencies=Array.from({length:101},()=>({id:1,name:'test',city:null}));
  assert.throws(()=>validateReference(value),/Export incomplet refuse/);
});
test('les comptes, contacts et parametres inattendus sont refuses',()=>{
  const value=sample();value.tables.auth=[];assert.throws(()=>validateReference(value),/Tables inattendues/);
  delete value.tables.auth;value.tables.drivers=[{code:'TEST',name:'test',status:'ACTIF',source:'manuel',agency_id:null,email:'test@example.invalid'}];
  assert.throws(()=>validateReference(value),/Colonnes inattendues/);
  value.tables.drivers=[];value.read_only='off';assert.throws(()=>validateReference(value),/lecture seule/);
});
