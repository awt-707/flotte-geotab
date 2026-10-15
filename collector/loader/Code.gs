/**
 * FLOTTE GEOTAB — CHARGEUR DU COLLECTEUR (à coller UNE SEULE FOIS dans le projet Apps Script, fichier Code.gs)
 * -----------------------------------------------------------------------------------------------------------
 * Ce petit fichier ne change jamais. À chaque exécution, il charge depuis Supabase (table « releases ») la dernière
 * version du collecteur qui a passé tous les tests, et l'exécute. Aucune API Google à activer, aucune copie de code
 * à refaire : chaque modification validée sur GitHub est prise en compte au passage suivant (5 min).
 *
 * Propriétés du script (Paramètres du projet > Propriétés du script) : GEO_USER, GEO_PWD, SUPABASE_KEY (service_role).
 * Fonctions à lancer depuis l'éditeur : installer (une fois), testConnexions, collecterMaintenant, arreter.
 */
var FLOTTE_LOADER = true;
var FLOTTE_URL_DEFAUT = 'https://cgiiwumbblimvmrypxlc.supabase.co';   // projet Supabase « flotte_luxury »

function collect() { return chargerCollecteur_().collect(); }
function installer() { return chargerCollecteur_().installer(); }
function testConnexions() { return chargerCollecteur_().testConnexions(); }
function collecterMaintenant() { return chargerCollecteur_().collecterMaintenant(); }
function arreter() { return chargerCollecteur_().arreter(); }

/** Dernière version publiée (mémorisée 6 h par version) puis exécutée ; retourne ses fonctions principales */
function chargerCollecteur_() {
  var props = PropertiesService.getScriptProperties();
  var url = String(props.getProperty('SUPABASE_URL') || FLOTTE_URL_DEFAUT).replace(/\/+$/, ''), key = String(props.getProperty('SUPABASE_KEY') || '').trim();
  var rest = props.getProperty('SUPABASE_REST_PATH') || '/rest/v1/';
  if (!key) throw new Error('Propriété du script SUPABASE_KEY manquante (Paramètres du projet > Propriétés du script).');
  var headers = { apikey: key };
  if (!/^sb_/.test(key)) headers.Authorization = 'Bearer ' + key;
  var get = function (q) {
    var r = UrlFetchApp.fetch(url + rest + q, { headers: headers, muteHttpExceptions: true });
    if (r.getResponseCode() >= 300) throw new Error('Chargement du collecteur : HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
    return JSON.parse(r.getContentText());
  };
  var last = get('releases?select=id,version,sha&order=id.desc&limit=1')[0];
  if (!last) throw new Error('Aucune version du collecteur publiée dans Supabase (table releases).');
  var cache = CacheService.getScriptCache(), ck = 'flotte|' + last.sha, src = null;
  try {
    var n = +cache.get(ck + '|n');
    if (n > 0) { var parts = []; for (var i = 0; i < n; i++) parts.push(cache.get(ck + '|' + i)); if (parts.every(function (p) { return p !== null; })) src = parts.join(''); }
  } catch (e) { src = null; }
  if (!src) {
    var rel = get('releases?select=files&id=eq.' + last.id)[0];
    var files = (rel.files || []).filter(function (f) { return f && f.type === 'SERVER_JS' && typeof f.source === 'string'; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    if (!files.some(function (f) { return /function collect\(\)/.test(f.source); })) throw new Error('Version ' + last.version + ' incomplète.');
    src = files.map(function (f) { return f.source; }).join('\n');
    try {
      var size = 90000, m = Math.ceil(src.length / size), put = {};
      for (var j = 0; j < m; j++) put[ck + '|' + j] = src.slice(j * size, (j + 1) * size);
      put[ck + '|n'] = String(m);
      cache.putAll(put, 21600);
    } catch (e) { }
  }
  var nouvelle = props.getProperty('CODE_SHA') !== last.sha;
  if (nouvelle) { props.setProperty('CODE_SHA', last.sha); props.setProperty('CODE_VERSION', last.version); }
  var api = new Function(src + '\n;return { collect: collect, installer: installer, testConnexions: testConnexions, ' +
    'collecterMaintenant: collecterMaintenant, arreter: arreter, log: log_ };')();
  if (nouvelle) api.log('Collecte', 'collecteur mis à jour : version ' + last.version);
  return api;
}
