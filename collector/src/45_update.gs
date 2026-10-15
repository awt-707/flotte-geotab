// ============================================================================
// MISE À JOUR AUTOMATIQUE DU COLLECTEUR
// GitHub Actions publie dans la table « releases » chaque version qui a passé tous les tests.
// À chaque passage, le collecteur compare avec la version installée et, si elle a changé, remplace son propre code
// par l'API Apps Script (à activer une fois : script.google.com/home/usersettings > « API Google Apps Script » = Activé).
// Le passage en cours finit avec l'ancien code ; le suivant (5 min plus tard) tourne avec le nouveau.
// ============================================================================
function selfUpdate_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('AUTO_UPDATE') === 'NON') return '';
  const last = (sbReq_('get', 'releases?select=id,version,sha&order=id.desc&limit=1') || [])[0];
  if (!last || last.sha === props.getProperty('CODE_SHA')) return '';
  const rel = (sbReq_('get', 'releases?select=version,sha,files&id=eq.' + last.id) || [])[0];
  const files = (rel.files || []).filter(f => f && f.name && typeof f.source === 'string' && (f.type === 'SERVER_JS' || f.type === 'JSON'));
  if (!files.some(f => f.name === 'appsscript' && f.type === 'JSON') || !files.some(f => /function collect\(\)/.test(f.source)))
    throw new Error('version ' + rel.version + ' incomplète, ignorée');
  const url = 'https://script.googleapis.com/v1/projects/' + ScriptApp.getScriptId() + '/content';
  const r = UrlFetchApp.fetch(url, { method: 'put', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify({ files: files.map(f => ({ name: f.name, type: f.type, source: f.source })) }) });
  if (r.getResponseCode() !== 200) {
    const t = r.getContentText();
    throw new Error(/has not been used|is disabled|SERVICE_DISABLED|User has not enabled the Apps Script API/i.test(t)
      ? 'activez « API Google Apps Script » sur script.google.com/home/usersettings (une seule fois). Réponse Google : ' + t.replace(/\s+/g, ' ').slice(0, 220)
      : 'HTTP ' + r.getResponseCode() + ' ' + t.slice(0, 200));
  }
  props.setProperty('CODE_SHA', rel.sha); props.setProperty('CODE_VERSION', rel.version);
  props.deleteProperty('UPDATE_ERR_DAY');
  return 'collecteur mis à jour : version ' + rel.version;
}
/** Appelé par collect : une erreur de mise à jour n'est signalée qu'une fois par jour et n'arrête jamais la collecte */
function tryUpdate_() {
  if (typeof FLOTTE_LOADER !== 'undefined') return '';   // chargeur : la dernière version est chargée à chaque exécution, rien à installer
  try { return selfUpdate_(); }
  catch (e) {
    const props = PropertiesService.getScriptProperties(), d = localDay_(new Date());
    if (props.getProperty('UPDATE_ERR_DAY') === d) return '';
    props.setProperty('UPDATE_ERR_DAY', d);
    return 'Mise à jour du collecteur impossible : ' + e.message;
  }
}
