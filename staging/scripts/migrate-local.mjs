import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assertLocalProject} from './guard.mjs';
import {LOCAL_DIR,STAGING_ROOT,ensureLocalDir} from './paths.mjs';
import {LOCAL_GUARD,dockerArgs} from './import-reference.mjs';

// Only these reviewed local feature migrations; never follows a linked cloud project.
const MIGRATIONS=[['20261121000000','offline_motion'],['20261122000000','automatic_links'],['20261123000000','motion_checkpoints'],['20261124000000','myclicar'],['20261125000000','name_spacing'],['20261126000000','platform_vehicle_details'],['20261127000000','automatic_vehicle_assignments'],['20261128000000','disconnection_alerts'],['20261129000000','operations_growth'],['20261130000000','driver_portal'],['20261201000000','rotation_history'],['20261202000000','uber_report_sync'],['20261203000000','event_sources'],['20261204000000','driver_sessions'],['20261205000000','report_date_default'],['20261206000000','driver_performance'],['20261207000000','full_inventory'],['20261208000000','parking'],['20261209000000','uber_driver_reports'],['20261210000000','inventory_current_bindings'],['20261211000000','authorized_zones'],['20261212000000','uber_report_collector'],['20261213000000','manual_events'],['20261214000000','historical_driver_references'],['20261215000000','fuel_reference'],['20261216000000','confirmed_contract_identity'],['20261217000000','uber_report_organization_label'],['20261218000000','parking_archive'],['20261219000000','confirmed_contract_return'],['20261220000000','uber_csv_timezone'],['20261221000000','usage_morocco_calendar'],['20261222000000','uber_report_identity_promotion'],['20261223000000','revenue_realtime'],['20261224000000','provider_earnings'],['20261225000000','telemetry_continuity'],['20261226000000','provider_earnings_semantics'],['20261227000000','provider_earnings_selection'],['20261228000000','provider_earnings_calculations'],['20261229000000','provider_earnings_proof_validation'],['20261231000000','provider_earnings_reconciliation']];
export function migrateLocal() {
  assertLocalProject();ensureLocalDir();
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG|^SUPABASE_DB|^DOCKER_(HOST|CONTEXT|TLS|CERT)/.test(k)));
  const run=sql=>spawnSync('docker',dockerArgs('psql',['-X','-qAt','--set=ON_ERROR_STOP=1','--file=/dev/stdin']),{env,input:sql,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  const pending=[];
  for(const [version,name] of MIGRATIONS){
    const check=run(LOCAL_GUARD+`select exists(select 1 from supabase_migrations.schema_migrations where version='${version}');`);
    if(check.status!==0)throw new Error('Migration refusée : base locale de staging indisponible.');
    if(check.stdout.trim()!=='t')pending.push([version,name]);
  }
  if(!pending.length)return false;
  const backups=path.join(LOCAL_DIR,'backups');fs.mkdirSync(backups,{recursive:true,mode:0o700});
  const backup=path.join(backups,'before-features-'+new Date().toISOString().replaceAll(':','-')+'.dump');
  const fd=fs.openSync(backup,'wx',0o600);
  const dump=spawnSync('docker',dockerArgs('pg_dump',['--format=custom','--schema=public']),{env,stdio:['ignore',fd,'pipe'],timeout:60000});fs.closeSync(fd);
  if(dump.status!==0){fs.rmSync(backup,{force:true});throw new Error('Sauvegarde locale interrompue ; migration non appliquée.');}
  const sql=pending.map(([version,name])=>fs.readFileSync(path.join(STAGING_ROOT,'supabase','migrations',version+'_'+name+'.sql'),'utf8')+`\ninsert into supabase_migrations.schema_migrations(version,name) values('${version}','${name}');`).join('\n');
  const result=run(`begin; set local lock_timeout='2s'; set local statement_timeout='30s';\n${LOCAL_GUARD}\n${sql}\nnotify pgrst,'reload schema';commit;`);
  if(result.status!==0)throw new Error('Migration locale annulée ; sauvegarde privée conservée.');
  console.log('Fonctionnalités staging : '+pending.length+' migration(s) locale(s) appliquée(s), sauvegarde privée conservée.');
  return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)migrateLocal();
