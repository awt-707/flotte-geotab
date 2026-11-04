import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createFleetApi} from '../server/fleet.mjs';
import {createDriverPortalApi} from '../server/driver-portal.mjs';
import {createOperationsApi} from '../server/operations.mjs';
import {loadDemandCityReview} from '../server/demand-city-review.mjs';
import {createUberReportsApi} from '../server/uber-reports.mjs';
import {createUberReportFileStore} from '../server/uber-report-files.mjs';
import {createUberReportBrowserLease} from '../server/uber-report-browser-lease.mjs';
import {createParkingApi} from '../server/parking.mjs';
import {createDriverPerformanceApi} from '../server/driver-performance.mjs';
import {createProviderEarningsApi} from '../server/provider-earnings-api.mjs';
import {createLocalTelemetryContinuity} from '../server/telemetry-continuity-local.mjs';
import {createLocalTeksat} from '../server/texat-local.mjs';
import {createTeksatApi} from '../server/texat-api.mjs';

export async function createDesktopStack({config,databaseTarget,stateDir,transport,leader=false,isCollectionActive=()=>leader}){
  await mkdir(stateDir,{recursive:true,mode:0o700});
  const common={supabaseUrl:config.supabaseUrl,databaseTarget,anonKey:config.publishableKey,...transport};
  const driver=createDriverPortalApi(common);
  let fleet,parking;
  const operations=createOperationsApi({...common,notify:m=>driver.notify(m),readFuelReport:i=>fleet.geotabFuelReport(i),demandCityReview:loadDemandCityReview(path.join(stateDir,'demand-city-review.json'))});
  const telemetry=createLocalTelemetryContinuity({...common,pendingPath:path.join(stateDir,'telemetry','pending.json'),
    onTelemetry:rows=>operations.onTelemetry(rows),onPositions:(rows,source)=>parking.onPositions(rows,source)});
  fleet=createFleetApi({...common,sharedCollection:!leader,isCollectionActive,boltEnvPath:path.join(stateDir,'bolt.env'),geotabCredentialsPath:path.join(stateDir,'geotab.json'),myclicarCredentialsPath:path.join(stateDir,'myclicar.json'),
    uberPairingPath:path.join(stateDir,'uber-pairing.json'),connectorStatePath:path.join(stateDir,'connector-state.json'),validationPath:path.join(stateDir,'validation-24h.json'),
    onGeotabTelemetry:telemetry.onGeotabTelemetry,onGeotabPositions:telemetry.onGeotabPositions,getTelemetryArchiveStatus:telemetry.status,onGeotabState:s=>parking.invalidateSource(s)});
  const reports=createUberReportsApi({...common,authorizePair:req=>fleet.authorizeUberReport(req),reportFiles:createUberReportFileStore({directory:path.join(stateDir,'uber-reports')}),
    browserLease:createUberReportBrowserLease({filePath:path.join(stateDir,'uber-reports-browser','lease.json')})});
  parking=createParkingApi({...common,getGeotabZones:()=>fleet.geotabZones()});
  const performance=createDriverPerformanceApi({...common,boltClient:fleet.boltClient});
  const earnings=createProviderEarningsApi(common);
  const teksat=createLocalTeksat({...common,localDirectory:stateDir});
  const teksatApi=createTeksatApi({...common,service:teksat});
  let closed=false;
  return {
    async handle(req,res){
      if(closed)return false;
      const url=new URL(req.url,'http://127.0.0.1:4173');
      if(url.pathname.startsWith('/api/parking/'))return parking(req,res);
      if(url.pathname.startsWith('/api/driver-performance/'))return performance(req,res);
      if(url.pathname.startsWith('/api/provider-earnings/'))return earnings(req,res);
      if(url.pathname.startsWith('/api/uber-reports/'))return reports(req,res);
      if(url.pathname.startsWith('/api/driver/')||url.pathname.startsWith('/api/operations/'))return await driver(req,res)||await operations(req,res);
      if(url.pathname.startsWith('/api/fleet/texat/'))return teksatApi(req,res);
      if(url.pathname.startsWith('/api/fleet/'))return fleet(req,res);
      return false;
    },
    async start(){if(!leader||closed)return;await Promise.allSettled([telemetry.start(),teksat.start(),fleet.resume(),operations.resume(),performance.resume()]);},
    async close(){if(closed)return;closed=true;await Promise.allSettled([fleet,operations,parking,performance,telemetry,teksat].map(service=>Promise.resolve().then(()=>service.close())));}
  };
}
