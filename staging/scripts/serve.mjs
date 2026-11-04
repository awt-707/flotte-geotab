import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { readRuntime } from './guard.mjs';
import { listenLocalStaging } from './listen.mjs';
import { API_URL, LOCAL_DIR, SITE_URL, STAGING_ROOT } from './paths.mjs';

const runtime = readRuntime();
const markerResponse = await fetch(API_URL + '/rest/v1/params?select=value&key=eq.environment', {
  headers: { apikey: runtime.serviceKey, Authorization: 'Bearer ' + runtime.serviceKey },
  redirect: 'error', signal: AbortSignal.timeout(10000)
});
if (!markerResponse.ok || (await markerResponse.json())?.[0]?.value !== 'staging') throw new Error('Serveur refuse : la base locale ne porte pas le marqueur staging.');
const siteRoot = fs.realpathSync(path.join(STAGING_ROOT, 'site'));
const modules = path.join(STAGING_ROOT, 'node_modules');
const vendors = new Map([
  ['/vendor/supabase.js', '@supabase/supabase-js/dist/umd/supabase.js'],
  ['/vendor/leaflet.js', 'leaflet/dist/leaflet.js'],
  ['/vendor/leaflet.css', 'leaflet/dist/leaflet.css'],
  ['/vendor/xlsx.full.min.js', 'xlsx/dist/xlsx.full.min.js'],
  ['/vendor/jspdf.umd.min.js', 'jspdf/dist/jspdf.umd.min.js'],
  ['/vendor/jspdf.plugin.autotable.min.js', 'jspdf-autotable/dist/jspdf.plugin.autotable.min.js'],
  ['/vendor/pdf-lib.min.js', 'pdf-lib/dist/pdf-lib.min.js'],
  ['/vendor/fontkit.umd.min.js', '@pdf-lib/fontkit/dist/fontkit.umd.min.js'],
  ['/vendor/bidi.min.js', 'bidi-js/dist/bidi.min.js'],
  ['/vendor/barlow.css', '@fontsource/barlow/index.css'],
  ['/vendor/barlow-semi-condensed.css', '@fontsource/barlow-semi-condensed/index.css']
]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
// Handlers are assigned from local JavaScript, not inline HTML attributes.
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self' " + API_URL + " ws://127.0.0.1:57421 https://photon.komoot.io; frame-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
const fontStyles = new Map([['/vendor/barlow.css', 'barlow'], ['/vendor/barlow-semi-condensed.css', 'barlow-semi-condensed']]);
const extensionDownloads = new Map([
  ['/uber-extension/ludy-uber-chromium.zip', 'ludy-uber-chromium.zip'],
  ['/uber-extension/ludy-uber-firefox.zip', 'ludy-uber-firefox.zip'],
  ['/uber-extension/firefox.zip', 'ludy-uber-firefox.zip']
]);
const extensionGuide = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Installer le connecteur Uber — Ludy staging</title>
<style>body{font:17px/1.6 system-ui,sans-serif;background:#f4f6f9;color:#182235;margin:0}main{max-width:800px;margin:40px auto;padding:32px;background:white;border-radius:16px}a{color:#235dc5}h1{line-height:1.2}li{margin:10px 0}code{background:#edf1f7;padding:3px 6px;border-radius:4px}.tag{font-size:13px;font-weight:700;color:#8b5200}section{margin:28px 0}small{color:#536079}</style>
<main><a href="/#/connecteurs">← Retour aux connecteurs</a><p class="tag">STAGING LOCAL</p><h1>Lire la Live Map Uber</h1><p>L’extension parcourt la liste de votre Live Map par défilement pour transmettre à Ludy les chauffeurs au-delà des premières lignes. Elle ouvre aussi les détails des chauffeurs pour lire la plaque et le modèle du véhicule, puis restaure la liste. Retirez les recherches et filtres restrictifs pour élargir la couverture. Laissez la carte Uber ouverte sur votre second écran.</p>
<section><h2>Chrome ou Edge</h2><ol><li><a href="/uber-extension/ludy-uber-chromium.zip" download>Télécharger l’extension Chromium</a>, puis extraire le ZIP.</li><li>Ouvrir <code>chrome://extensions</code> ou <code>edge://extensions</code> et activer le mode développeur.</li><li>Choisir « Charger l’extension non empaquetée », puis sélectionner le dossier extrait contenant <code>manifest.json</code>.</li></ol></section>
<section><h2>Firefox</h2><ol><li><a href="/uber-extension/ludy-uber-firefox.zip" download>Télécharger l’extension Firefox</a>, puis extraire le ZIP.</li><li>Ouvrir <code>about:debugging#/runtime/this-firefox</code>, choisir « Charger un module complémentaire temporaire », puis sélectionner <code>manifest.json</code>.</li></ol><small>Firefox 128 ou plus. Cette installation temporaire doit être renouvelée après le redémarrage de Firefox.</small></section>
<section><h2>Mettre à jour vers 0.6.6</h2><p>Remplacez les fichiers par la nouvelle archive ou utilisez le dossier staging/uber-extension/chromium. Cliquez sur Recharger dans chrome://extensions, puis rechargez aussi la page Uber avant de démarrer. Une association persistante est conservée.</p></section><section><h2>Associer puis démarrer</h2><ol><li>Se connecter à Ludy staging et ouvrir « Connecteurs ». Générer et copier le code d’association Uber.</li><li>Ouvrir la Live Map Uber Fleet dans le même navigateur, puis ouvrir la fenêtre de l’extension.</li><li>Coller le code, cliquer « Associer », puis « Démarrer ». Les observations arrivent dans Ludy à mesure que les lignes visibles sont lues.</li></ol><p>La destination est uniquement <code>http://127.0.0.1:4173</code>. Le code est conservé après un redémarrage du serveur. La liaison expire après 30 jours sans activité, avec renouvellement du code au plus tard après 90 jours. La version 0.6.6 propose une reprise automatique après réouverture du navigateur ou de la Live Map de la même flotte. Activez cette option dans l’extension et accordez l’autorisation navigateur demandée. Sans cette option, cliquez de nouveau sur Démarrer après réouverture du navigateur. Le bouton d’arrêt de la Live Map suspend sa collecte et ses rechargements.</p><p>Pendant la lecture, la Live Map est rechargée toutes les vingt minutes, après la fin du parcours et de sa transmission à Ludy. Une page cachée ou une interaction récente reporte cette actualisation. La lecture reprend sur la même flotte ; ce rechargement ne garantit pas que les données Uber ont changé.</p></section><section><h2>Rapports Uber automatiques</h2><p>Pour télécharger les fichiers depuis les boutons Download, lancez <code>npm --prefix staging run uber:reports-browser</code> depuis le dossier du projet. Connectez-vous à Uber dans le navigateur dédié qui s’ouvre. Gardez ce navigateur et le terminal ouverts ; Ctrl+C arrête ce collecteur. Arrêtez les rapports dans l’extension tout en gardant sa Live Map active. Aucun nouveau code d’association n’est nécessaire.</p><p>Dans Ludy, ouvrir <a href="/#/uber-rapports">Collecte des rapports Uber</a> pour vérifier la flotte, les villes, le format des dates et le fuseau des heures du CSV Courses. Le collecteur demande trois types : <strong>Trip activity</strong>, <strong>Driver activity</strong> et <strong>Driver quality</strong>, sur les sept journées complètes précédentes à l’heure du Maroc. Garder cet onglet ouvert et la session Uber connectée. Les CSV validés sont conservés dans le dossier privé staging/.local/uber-reports/files/, ignoré par Git, puis importés dans la base locale. La Live Map conserve son propre suivi.</p><p>Chaque type est vérifié séparément, avec relecture toutes les six heures. Un type indisponible ne bloque pas les autres. Si le formulaire, les dates ou le téléchargement ne sont pas reconnus, l’extension demande une intervention. Le journal Ludy distingue les fichiers reçus et les données importées. Les heures du CSV Courses doivent avoir un fuseau confirmé dans les réglages avant leur analyse.</p><p>Les courses servent à l’analyse des zones et aux fiches chauffeur lorsqu’une identité certaine est reconnue. Les heures et taux officiels restent limités à la période exacte du rapport ; les interruptions d’observation ne deviennent pas des pauses. Ces trois rapports ne constituent pas un bilan de gains nets. Ouvrir <a href="/#/performance-chauffeur?source=uber">Performance chauffeur</a> pour vérifier les données reçues et leur couverture.</p></section></main></html>`;
const { createFleetApi } = await import('../server/fleet.mjs');
const { createDriverPortalApi } = await import('../server/driver-portal.mjs');
const { createOperationsApi } = await import('../server/operations.mjs');
const { loadDemandCityReview } = await import('../server/demand-city-review.mjs');
const { createUberReportsApi } = await import('../server/uber-reports.mjs');
const { createUberReportFileStore } = await import('../server/uber-report-files.mjs');
const { createUberReportBrowserLease } = await import('../server/uber-report-browser-lease.mjs');
const { createParkingApi } = await import('../server/parking.mjs');
const { createDriverPerformanceApi } = await import('../server/driver-performance.mjs');
const { createProviderEarningsApi } = await import('../server/provider-earnings-api.mjs');
const { createLocalTelemetryContinuity } = await import('../server/telemetry-continuity-local.mjs');
const { createLocalTeksat } = await import('../server/texat-local.mjs');
const { createTeksatApi } = await import('../server/texat-api.mjs');
const driverApi=createDriverPortalApi({supabaseUrl:API_URL,serviceKey:runtime.serviceKey,anonKey:runtime.anonKey});
const operationsApi=createOperationsApi({supabaseUrl:API_URL,serviceKey:runtime.serviceKey,anonKey:runtime.anonKey,notify:message=>driverApi.notify(message),readFuelReport:input=>fleetApi.geotabFuelReport(input),demandCityReview:loadDemandCityReview(path.join(LOCAL_DIR,'demand-city-review.json'))});
let parkingApi;
const telemetryArchive=createLocalTelemetryContinuity({supabaseUrl:API_URL,serviceKey:runtime.serviceKey,pendingPath:path.join(LOCAL_DIR,'telemetry','pending.json'),onTelemetry:rows=>operationsApi.onTelemetry(rows),onPositions:(rows,source)=>parkingApi.onPositions(rows,source)});
const fleetApi = createFleetApi({ supabaseUrl: API_URL, serviceKey: runtime.serviceKey, anonKey: runtime.anonKey, boltEnvPath: path.join(LOCAL_DIR, 'bolt.env'), geotabCredentialsPath: path.join(LOCAL_DIR, 'geotab.json'), myclicarCredentialsPath: path.join(LOCAL_DIR, 'myclicar.json'), uberPairingPath: path.join(LOCAL_DIR, 'uber-pairing.json'), connectorStatePath: path.join(LOCAL_DIR, 'connector-state.json'), validationPath: path.join(LOCAL_DIR, 'validation-24h.json'),onGeotabTelemetry:telemetryArchive.onGeotabTelemetry,onGeotabPositions:telemetryArchive.onGeotabPositions,getTelemetryArchiveStatus:telemetryArchive.status,onGeotabState:status=>parkingApi.invalidateSource(status) });
const uberReportsApi=createUberReportsApi({supabaseUrl:API_URL,serviceKey:runtime.serviceKey,anonKey:runtime.anonKey,authorizePair:request=>fleetApi.authorizeUberReport(request),reportFiles:createUberReportFileStore(),browserLease:createUberReportBrowserLease()});
parkingApi=createParkingApi({supabaseUrl:API_URL,serviceKey:runtime.serviceKey,anonKey:runtime.anonKey,getGeotabZones:()=>fleetApi.geotabZones()});
const performanceApi=createDriverPerformanceApi({supabaseUrl:API_URL,serviceKey:runtime.serviceKey,anonKey:runtime.anonKey,boltClient:fleetApi.boltClient});
const providerEarningsApi=createProviderEarningsApi({supabaseUrl:API_URL,serviceKey:runtime.serviceKey,anonKey:runtime.anonKey});
// This wrapper performs no file read, provider call or journal construction.
// Its start below is reserved for the process which owns the listening socket.
const teksatLocal=createLocalTeksat({supabaseUrl:API_URL,serviceKey:runtime.serviceKey,localDirectory:LOCAL_DIR});
const teksatApi=createTeksatApi({supabaseUrl:API_URL,anonKey:runtime.anonKey,service:teksatLocal});

function send(response, status, content, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(content);
}
function staticFile(urlPath) {
  if (urlPath === '/vendor/supabase.js') return path.join(STAGING_ROOT, 'node_modules', '@supabase/supabase-js/dist/umd/supabase.js');
  if (vendors.has(urlPath)) return path.join(modules, vendors.get(urlPath));
  if (/^\/vendor\/images\/[a-zA-Z0-9@._-]+\.png$/.test(urlPath)) return path.join(modules, 'leaflet/dist/images', path.basename(urlPath));
  if (/^\/vendor\/files\/barlow(?:-semi-condensed)?-[a-z0-9-]+\.woff2?$/.test(urlPath)) {
    const family = path.basename(urlPath).startsWith('barlow-semi-condensed-') ? 'barlow-semi-condensed' : 'barlow';
    return path.join(modules, '@fontsource', family, 'files', path.basename(urlPath));
  }
  if (urlPath.startsWith('/vendor/')) return null;
  const parts = urlPath.split('/');
  if (parts.some(part => part.startsWith('.') || part.includes('\\'))) return null;
  const file = path.resolve(siteRoot, '.' + (urlPath === '/' ? '/index.html' : urlPath));
  if (!file.startsWith(siteRoot + path.sep)) return null;
  try { return fs.realpathSync(file).startsWith(siteRoot + path.sep) ? file : null; } catch { return null; }
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', csp);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Loopback bind + strict Host avoids exposing the service through another origin.
  if (!['127.0.0.1:4173', 'localhost:4173'].includes(request.headers.host)) return send(response, 403, 'Hote refuse.');
  try {
    const url = new URL(request.url, SITE_URL);
    if(url.pathname.startsWith('/api/parking/')){await parkingApi(request,response);return;}
    if(url.pathname.startsWith('/api/driver-performance/')){await performanceApi(request,response);return;}
    if(url.pathname.startsWith('/api/provider-earnings/')){await providerEarningsApi(request,response);return;}
    if(url.pathname.startsWith('/api/uber-reports/')){
      if(await uberReportsApi(request,response))return;
      return send(response,404,'Route inconnue.');
    }
    if(url.pathname.startsWith('/api/driver/')||url.pathname.startsWith('/api/operations/')){
      if(await driverApi(request,response)||await operationsApi(request,response))return;
      return send(response,404,'Route inconnue.');
    }
    if (url.pathname.startsWith('/api/fleet/texat/')) {await teksatApi(request,response);return;}
    if (url.pathname.startsWith('/api/fleet/')) {
      if (await fleetApi(request, response)) return;
      return send(response, 404, 'Route inconnue.');
    }
    if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, 'Methode non permise.');
    if (url.pathname === '/health') return send(response, 200, JSON.stringify({ environment: 'staging', project: 'ludy-staging' }), types['.json']);
    if (url.pathname === '/uber-extension' || url.pathname === '/uber-extension/') return send(response, 200, extensionGuide, types['.html']);
    if (extensionDownloads.has(url.pathname)) {
      const name = extensionDownloads.get(url.pathname);
      const file = path.join(STAGING_ROOT, 'uber-extension', name);
      if (!fs.existsSync(file) || fs.realpathSync(file) !== file) return send(response, 404, 'Archive absente : lancer node staging/uber-extension/build.mjs.');
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="' + name + '"', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store' });
      if (request.method === 'HEAD') response.end(); else fs.createReadStream(file).pipe(response);
      return;
    }
    if (fontStyles.has(url.pathname)) {
      const family = fontStyles.get(url.pathname);
      const css = [400, 500, 600, 700].map(weight => fs.readFileSync(path.join(modules, '@fontsource', family, weight + '.css'), 'utf8')).join('\n');
      return send(response, 200, css, types['.css']);
    }
    if (url.pathname === '/config.js') {
      const config = { SUPABASE_URL: API_URL, SUPABASE_ANON_KEY: runtime.anonKey, ENVIRONMENT: 'staging', SOURCE_MODE: 'mixed', REFERENCE_DATA: fs.existsSync(path.join(LOCAL_DIR, 'reference-import.json')) ? 'snapshot' : 'synthetic', GEOTAB_ENABLED: false, GEOTAB_LOCAL: true, STAGING: true };
      return send(response, 200, 'window.FLOTTE_CONFIG = Object.freeze(' + JSON.stringify(config) + ');\n', types['.js']);
    }
    if (url.pathname === '/spreadsheet-worker.js') response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'");
    const file = staticFile(decodeURIComponent(url.pathname));
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(response, 404, 'Fichier introuvable.');
    const size = fs.statSync(file).size;
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(file).pipe(response);
  } catch (error) {
    if (!response.headersSent) send(response, 500, 'Erreur locale. Verifier la configuration du staging.');
    else response.end();
    console.error('Staging : requete en echec (' + (error?.name || 'Error') + ').');
  }
});
async function closeLocalServices() {
  await Promise.allSettled([fleetApi,operationsApi,parkingApi,performanceApi,telemetryArchive,teksatLocal]
    .map(service=>Promise.resolve().then(()=>service.close())));
}
try {
  const state = await listenLocalStaging(server);
  console.log(state === 'existing'
    ? 'Ludy staging est deja demarre : ' + SITE_URL + '. Ouvrez cette adresse dans votre navigateur. Instance existante conservee.'
    : 'Ludy staging : ' + SITE_URL + ' (Ctrl+C pour arreter le serveur web).');
  if(state==='existing'){await closeLocalServices();}
  else {
    // The journal has one owner: a second server never starts archive replay.
    telemetryArchive.start().catch(()=>console.error('Archive Geotab locale indisponible : consulter le statut du connecteur.'));
    teksatLocal.start().catch(()=>console.error('Archive Teksat locale indisponible : consulter le statut du connecteur.'));
    fleetApi.resume().catch(()=>console.error('Reprise automatique indisponible : consulter les connecteurs dans Ludy.'));
    operationsApi.resume().catch(()=>console.error('Agenda local indisponible : consulter Événements.'));
    performanceApi.resume().catch(()=>console.error('Historique des plateformes indisponible : consulter Performance chauffeur.'));
    let stopping=false;
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(stopping)return;stopping=true;const servicesClosed=closeLocalServices();server.close(()=>{void servicesClosed.then(()=>process.exit(0));});server.closeIdleConnections?.();});
  }
} catch (error) {
  await closeLocalServices();
  console.error('Demarrage du serveur web impossible : ' + error.message);
  process.exitCode = 1;
}
