import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {readRuntime} from './guard.mjs';
import {LOCAL_DIR,PROJECT_ID,ensureLocalDir} from './paths.mjs';
import {REFERENCE,SOURCE,validateReference} from './export-reference.mjs';

const CONTAINER='supabase_db_ludy-staging';
const CONNECTION=['--host=/var/run/postgresql','--port=5432','--username=postgres','--dbname=postgres'];
const PK={agencies:'id',parc:'plate',vehicles:'key',drivers:'code',contracts:'num',rules:'id'};
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";

export function validateImport(value) {
  const counts=validateReference(value);
  if(value.source_project!==SOURCE.user.slice('postgres.'.length))throw new Error('Projet source inattendu.');
  for(const [table,rows] of Object.entries(value.tables)) {
    const seen=new Set();
    for(const row of rows) {
      const key=row[PK[table]];
      if(table==='agencies' ? !Number.isSafeInteger(key)||key<=0 : typeof key!=='string'||!key.trim())throw new Error('Cle invalide dans '+table);
      if(seen.has(String(key)))throw new Error('Cle dupliquee dans '+table);seen.add(String(key));
    }
  }
  const agencies=new Set(value.tables.agencies.map(x=>x.id));
  for(const table of ['parc','vehicles','drivers'])if(value.tables[table].some(x=>x.agency_id!==null&&(!Number.isSafeInteger(x.agency_id)||!agencies.has(x.agency_id))))throw new Error('Agence absente de la copie dans '+table);
  if(value.tables.agencies.some(x=>[9001,9002].includes(x.id)) || value.tables.parc.some(x=>['STG001','STG002'].includes(x.plate)) || value.tables.vehicles.some(x=>['001STG','002STG'].includes(x.key)) || value.tables.drivers.some(x=>['STG-DRIVER-A','STG-DRIVER-B'].includes(x.code)))throw new Error('Identifiant source en conflit avec le jeu fictif du staging.');
  const drivers=new Set(value.tables.drivers.map(x=>x.code)),vehicles=new Set(value.tables.vehicles.map(x=>x.key));
  return {counts,unmatchedContractVehicles:value.tables.contracts.filter(x=>x.vehicle_key&&!vehicles.has(x.vehicle_key)).length,unmatchedContractDrivers:value.tables.contracts.filter(x=>x.client_code&&!drivers.has(x.client_code)).length};
}

function localEnv() {return Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(key)));}
export function dockerArgs(command,args) {
  return ['--host=unix:///var/run/docker.sock','exec','-i',CONTAINER,command,...CONNECTION,...args];
}
function docker(args,options={}) {return spawnSync('docker',['--host=unix:///var/run/docker.sock',...args],{env:localEnv(),encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000,...options});}
function sqlRun(sql) {
  return spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']),{env:localEnv(),input:sql,encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000});
}
function checked(result,label) {if(result.error||result.status!==0)throw new Error(label+' : operation locale interrompue.');return result.stdout;}

export const LOCAL_GUARD=`do $guard$ begin
  if current_database() <> 'postgres' or inet_server_addr() is not null or
     (select value from public.params where key='environment') is distinct from 'staging' then
    raise exception 'Base locale de staging obligatoire';
  end if;
end $guard$;`;

// Remove the original demo only if it is still the entire, unused reference set.
// Also inspect informal references: the old app has many links without FK constraints.
const CLEAN_DEMO=`do $clean$
declare c record; used boolean; expected text[];
begin
  if (select count(*) from public.agencies)<>2 or (select count(*) from public.parc)<>2
     or (select count(*) from public.vehicles)<>2 or (select count(*) from public.drivers)<>2 then return; end if;
  if (select count(*) from public.agencies where (id,name,city) in
    ((9001,'Agence de test A','Ville de test'),(9002,'Agence de test B','Ville de test')) and cash_sheet_id is null and rh_drive='{}'::jsonb)<>2 then return; end if;
  if (select count(*) from public.parc p where (plate,agency_id) in (('STG001',9001),('STG002',9002)) and brand='TEST' and model='Vehicule de demonstration' and fuel='Essence' and note='Fictif : staging uniquement'
    and jsonb_strip_nulls(to_jsonb(p)-array['plate','brand','model','fuel','agency_id','note','updated_at'])='{}'::jsonb)<>2 then return; end if;
  if (select count(*) from public.vehicles v where (key,plate,agency_id) in (('001STG','STG001',9001),('002STG','STG002',9002)) and brand='TEST' and model='Vehicule de demonstration' and active='OUI'
    and jsonb_strip_nulls(to_jsonb(v)-array['key','plate','brand','model','agency_id','active'])='{}'::jsonb)<>2 then return; end if;
  if (select count(*) from public.drivers d where (code,name,email) in
    (('STG-DRIVER-A','Chauffeur fictif A','driver-a@example.invalid'),('STG-DRIVER-B','Chauffeur fictif B','driver-b@example.invalid'))
    and (code,agency_id) in (('STG-DRIVER-A',9001),('STG-DRIVER-B',9002))
    and source='manuel' and status='ACTIF' and note='Fictif : staging uniquement'
    and jsonb_strip_nulls(to_jsonb(d)-array['code','name','email','agency_id','source','status','note'])='{}'::jsonb)<>2 then return; end if;
  for c in select table_name,column_name from information_schema.columns where table_schema='public'
    and table_name not in ('agencies','parc','vehicles','drivers')
    and column_name in ('agency_id','vehicle_key','driver_code','client_code','ludy_driver_code','plate','old_plate','new_plate','replaced_by') loop
    expected:=case when c.column_name='agency_id' then array['9001','9002']
      when c.column_name='vehicle_key' then array['001STG','002STG']
      when c.column_name in ('plate','old_plate','new_plate') then array['STG001','STG002']
      else array['STG-DRIVER-A','STG-DRIVER-B'] end;
    execute format('select exists(select 1 from public.%I where %I::text=any($1))',c.table_name,c.column_name) into used using expected;
    if used then return; end if;
  end loop;
  delete from public.drivers where code in ('STG-DRIVER-A','STG-DRIVER-B');
  delete from public.parc where plate in ('STG001','STG002');
  delete from public.vehicles where key in ('001STG','002STG');
  delete from public.agencies where id in (9001,9002);
end $clean$;`;

export function importSQL(value,{dryRun=false}={}) {
  validateImport(value);
  const rows=table=>`json_populate_recordset(null::public.${table},${quote(JSON.stringify(value.tables[table]))}::json)`;
  const sql=["set standard_conforming_strings=on; begin; set local statement_timeout='30s'; set local lock_timeout='2s';",LOCAL_GUARD,
    "select pg_advisory_xact_lock(hashtextextended('ludy-staging-reference-import',0));",CLEAN_DEMO];
  for(const [table,spec] of Object.entries(REFERENCE)) {
    const cols=spec.columns.map(x=>'"'+x+'"').join(',');
    sql.push(`insert into public.${table} (${cols}) ${table==='agencies'?'overriding system value':''}
      select ${cols} from ${rows(table)} on conflict (${PK[table]}) do update set
      ${spec.columns.filter(c=>c!==PK[table]).map(c=>`"${c}"=excluded."${c}"`).join(',')};`);
    if(table==='vehicles')sql.push(`update public.vehicles v set agency_id=r.agency_id from ${rows(table)} r where v.key=r.key and v.agency_id is distinct from r.agency_id;`);
  }
  // Rebuild only derived counters from local contracts. refresh_drivers() would also
  // delete unmatched drivers and match external identities, outside this import's scope.
  sql.push(`with stats as (
    select d.code,count(c.num)::integer n,min(c.start_at) first_at,max(c.start_at) last_at
    from ${rows('drivers')} d left join public.contracts c on c.client_code=d.code and c.start_at is not null
    group by d.code
  ) update public.drivers d set n_contracts=s.n,first_contract=s.first_at,last_contract=s.last_at
    from stats s where s.code=d.code;`);
  // For new rows, defaults leave external settings empty. Do not alter local extras on updates.
  sql.push(`insert into public.params(key,label,value,note,sort) values
    ('reference_snapshot_at','Copie de reference',${quote(value.exported_at)},'Import local ; aucun flux de production',-11)
    on conflict(key) do update set value=excluded.value;`);
  if(!dryRun)sql.push(`select setval(pg_get_serial_sequence('public.agencies','id'),greatest(
    (select coalesce(max(id),1) from public.agencies),(select last_value from public.agencies_id_seq)),true);`);
  sql.push(`select json_build_object('reference_counts',json_build_object(${Object.keys(REFERENCE).map(t=>`'${t}',(select count(*) from public.${t})`).join(',')}),
    'environment',(select value from public.params where key='environment'),
    'auth_users',(select count(*) from auth.users),'fleet_drivers',(select count(*) from public.fleet_drivers),
    'external_reports_enabled',(select count(*) from public.report_schedules where active),
    'external_recipients_enabled',(select count(*) from public.alert_recipients where active));`);
  sql.push(dryRun?'rollback;':'commit;');return sql.join('\n');
}

export function runImport(args=process.argv.slice(2)) {
  const runtime=readRuntime();
  if(runtime.projectId!==PROJECT_ID)throw new Error('Staging local obligatoire.');
  if(args.length<1||args.length>2||args[0].startsWith('--')||(args[1]&&!['--apply','--check'].includes(args[1])))throw new Error('Usage : npm --prefix staging run import:reference -- CHEMIN_JSON [--check | --apply]');
  const exportsDir=fs.realpathSync(path.join(LOCAL_DIR,'exports'));
  const filename=fs.realpathSync(path.resolve(args[0]));
  if(!filename.startsWith(exportsDir+path.sep)||!filename.endsWith('.json'))throw new Error('Choisir un export JSON du dossier prive staging/.local/exports/.');
  if(fs.statSync(filename).size>32*1024*1024)throw new Error('Extrait trop volumineux.');
  const raw=fs.readFileSync(filename,'utf8'),value=JSON.parse(raw),review=validateImport(value);
  console.log('Copie valide : '+JSON.stringify(review));
  if(!args[1]){console.log('Lecture du fichier uniquement. --check simule en transaction locale annulee ; --apply sauvegarde puis importe dans ludy-staging.');return;}
  const label=checked(docker(['inspect','--format','{{index .Config.Labels "com.supabase.cli.project"}}',CONTAINER]),'Verification Docker').trim();
  if(label!==PROJECT_ID)throw new Error('Le conteneur ne correspond pas au staging.');
  checked(sqlRun(LOCAL_GUARD),'Verification du marqueur local');
  ensureLocalDir();
  const directory=path.join(LOCAL_DIR,'backups');fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
  const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID(),prefix=path.join(directory,'reference-'+id);
  let backup=null;
  if(args[1]==='--apply'){
    backup=prefix+'.dump';const fd=fs.openSync(backup,'wx',0o600);
    let result;try{result=spawnSync('docker',dockerArgs('pg_dump',['--format=custom','--no-owner','--no-acl']),{env:localEnv(),stdio:['ignore',fd,'pipe'],timeout:60000,encoding:'utf8'});}finally{fs.closeSync(fd);}
    if(result.error||result.status!==0){fs.rmSync(backup,{force:true});throw new Error('Sauvegarde locale impossible : import annule.');}
    checked(docker(['exec','-i',CONTAINER,'pg_restore','--list'],{input:fs.readFileSync(backup)}),'Verification de la sauvegarde locale');
    console.log('Sauvegarde du staging : '+backup);
  }
  const result=sqlRun(importSQL(value,{dryRun:args[1]==='--check'}));
  if(result.error||result.status!==0){const log=prefix+'.error.log';fs.writeFileSync(log,String(result.stderr||result.error||'Erreur locale'),{mode:0o600});throw new Error((result.error||result.signal?'Execution interrompue : verifier l’etat local avant de relancer.':'Transaction locale refusee, modifications annulees.')+' Diagnostic prive : '+log+(backup?' ; sauvegarde : '+backup:''));}
  const summary=JSON.parse(result.stdout.trim().split('\n').filter(line=>line.startsWith('{')).at(-1));
  if(args[1]==='--apply'){
    const report={imported_at:new Date().toISOString(),source_file:filename,source_sha256:createHash('sha256').update(raw).digest('hex'),exported_at:value.exported_at,...review,...summary,backup};
    fs.writeFileSync(path.join(LOCAL_DIR,'reference-import.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  }
  console.log((args[1]==='--check'?'Simulation locale annulee : ':'Import local termine : ')+JSON.stringify(summary));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{runImport();}catch(error){console.error(error.message);process.exitCode=1;}}
