// Référence : le Google Sheet v6 (moteur d'origine) exécuté dans un faux Google Sheets, avec les mêmes données Geotab réelles
const path = require('path'), env = require('./env');
const fresh = p => { delete require.cache[require.resolve(p)]; return require(p); };
function sheetV6(now) {
  process.env.CODE = path.join(env.REF, 'Code_v6.gs');
  const A = fresh(path.join(env.REF, 'harness_v6.js'));
  A.setNow(now);
  A.run('setup()'); A.run("saveGeotabCreds('a','secret')");
  A.run('injectContractsFromDialog(' + JSON.stringify(env.contrats()) + ')');
  A.tab = n => { const s = A.main.getSheetByName(n); if (!s) return []; const h = s.data[0] || [];
    return s.data.slice(1).filter(r => r.some(v => v !== '')).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };
  A.day = t => A.run('localDay_(new Date(' + new Date(t).getTime() + '))');
  return A;
}
// Collecteur (Collecteur.gs assemblé) branché sur la base de test vide
function collector(now, props) {
  env.resetDb();
  process.env.CODE = env.COLLECTOR;
  const B = fresh(path.join(__dirname, 'harness_collector.js'));
  B.setNow(now);
  Object.assign(B.props, { SUPABASE_URL: env.POSTGREST, SUPABASE_REST_PATH: '/', SUPABASE_KEY: env.svcKey(), GEO_USER: 'a', GEO_PWD: 'secret', IMPORT_DONE: '1', TZ_FIX: 'MA_TZ' }, props || {});   // pas d'ancien Sheet à reprendre, sauf test de reprise
  return B;
}
// Contrats de l'onglet CONTRATS du Sheet, copiés dans la base comme le ferait l'import du site
function copyContracts(A, B) {
  B.ctx.__ctr = A.main.getSheetByName('CONTRATS').data.slice(1).filter(r => r[0] !== '').map(r => r.map(v => v instanceof Date ? new B.ctx.Date(v.getTime()) : v));
  B.run("dbUpsert_('contracts', __ctr.map(r => toDb_('CTR', r)), 'num')");
}
module.exports = { sheetV6, collector, copyContracts };
