// ============================================================================
// CAISSE : JUSTIFICATIFS ET REÇUS DE DÉPÔT DANS GOOGLE DRIVE (demande d'Ahmed, 04/11/2026)
// Pour chaque agence, dans le Drive du compte du collecteur (dossier du classeur de la caisse de l'agence, sinon « Mon Drive ») :
// - « Justificatifs agence <nom> » : un sous-dossier par catégorie de dépense (Carburant, Péage…), justificatifs des dépenses
//   déposés dans Ludy (cash_files kind 'justif', rangés dans le sous-dossier de leur catégorie) ;
// - « Dépôts banque agence <nom> » : reçus de la banque des dépôts (cash_files kind 'depot').
// Dossiers créés une fois (identifiants dans les propriétés CSHDRV|<agence>|…, recréés s'ils ont été supprimés), liens publiés
// dans le param cashDrive pour la Caisse. Chaque fichier est copié une fois (cash_files.drive_id) ; illisible 3 fois = signalé
// (drive_error), plus réessayé.
// ============================================================================
// mêmes catégories que la Caisse (CASH_DEP_CATS, site/caisse_calc.js ; vérifié par tests/justificatifs.test.js)
const CSH_DRIVE_CATS_ = ['Carburant', 'Péage', 'Parking', 'Lavage', 'Contravention', 'Amende', 'Amende sans justificatif', 'NDF', 'Adblue', 'Vidange', 'Recharge téléphone', 'Autre'];
function cshDrvName_(s) { return rhFileName_(s) || 'Autre'; }
/** Dossier parent des dossiers d'une agence : celui de son classeur de caisse, sinon la racine du Drive */
function cshDrvParent_(ag) {
  try { if (ag && String(ag.cash_sheet_id || '').trim()) { const p = DriveApp.getFileById(String(ag.cash_sheet_id).trim()).getParents(); if (p.hasNext()) return p.next(); } } catch (e) { }
  return DriveApp.getRootFolder();
}
/** Dossier gardé dans les propriétés ; absent ou à la corbeille = repris par son nom dans le parent, sinon créé */
function cshDrvFolder_(key, name, parentFn) {
  const props = PropertiesService.getScriptProperties(), id = props.getProperty(key);
  if (id) { try { const f = DriveApp.getFolderById(id); if (!(f.isTrashed && f.isTrashed())) return f; } catch (e) { } }
  const parent = parentFn(), it = parent.getFoldersByName(name), f = it.hasNext() ? it.next() : parent.createFolder(name);
  props.setProperty(key, f.getId());
  return f;
}
function cshDriveFolders_(ag) {
  const k = 'CSHDRV|' + (ag ? ag.id : 0) + '|', nm = ag ? ag.name : 'Ludy', par = () => cshDrvParent_(ag);
  const F = { justif: () => cshDrvFolder_(k + 'justif', 'Justificatifs agence ' + nm, par), depot: () => cshDrvFolder_(k + 'depot', 'Dépôts banque agence ' + nm, par) };
  F.cat = c => { const n = cshDrvName_(c); return cshDrvFolder_(k + 'cat|' + n, n, F.justif); };
  return F;
}
/** À chaque passage : dossiers des agences (une fois), puis quelques fichiers copiés */
function cashDriveStep_(t0) {
  let ags, files;
  try { ags = dbSelect_('agencies', 'select=id,name,cash_sheet_id', 'id'); } catch (e) { return ''; }
  try { files = dbSelect_('cash_files', 'select=id,agency_id,kind,move_id,dep_ref,day,category,title,path,file_name&drive_id=is.null&drive_error=is.null', 'id'); }
  catch (e) { return ''; }   // migration 20261122000000_justificatifs.sql pas encore exécutée
  const props = PropertiesService.getScriptProperties(), pub = {}, byId = {}, out = [];
  ags.forEach(a => { byId[a.id] = a; });
  (ags.length ? ags : [null]).forEach(a => {
    const k = a ? a.id : 0;
    if (!props.getProperty('CSHDRV|' + k + '|ready')) {   // première fois : les deux dossiers et un sous-dossier par catégorie
      const F = cshDriveFolders_(a); F.depot(); CSH_DRIVE_CATS_.forEach(c => F.cat(c));
      props.setProperty('CSHDRV|' + k + '|ready', '1'); out.push('dossiers Drive de la caisse créés (' + (a ? a.name : 'Ludy') + ')');
    }
    pub[k] = { justif: props.getProperty('CSHDRV|' + k + '|justif'), depot: props.getProperty('CSHDRV|' + k + '|depot') };
  });
  const js = JSON.stringify(pub);
  if (props.getProperty('CSHDRV_PUB') !== js) {
    sbReq_('post', 'params?on_conflict=key', [{ key: 'cashDrive', label: 'Dossiers Google Drive de la caisse (créés par le collecteur)', value: js, note: 'Ne pas modifier', sort: 996 }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    props.setProperty('CSHDRV_PUB', js);
  }
  let n = 0; const err = [];
  for (const f of files) {
    if (Date.now() - t0 > MAX_RUN_MS - 100000) break;   // le reste au passage suivant
    const ag = f.agency_id != null ? byId[f.agency_id] || null : null, F = cshDriveFolders_(ag);
    const ext = (String(f.path).match(/\.[a-z0-9]{2,5}$/i) || [''])[0].toLowerCase();
    try {
      const folder = f.kind === 'justif' ? F.cat(f.category || 'Autre') : F.depot();
      const name = rhFileName_(f.title || f.file_name || ('Fichier ' + f.id)).replace(/\.[a-z0-9]{2,5}$/i, '') + ext;
      const x = folder.createFile(storageBlob_('caisse', f.path).setName(name));
      sbReq_('patch', 'cash_files?id=eq.' + f.id, { drive_id: x.getId(), drive_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
      props.deleteProperty('CSHDRV_TRY|' + f.id); n++;
    } catch (e) {
      const t = +(props.getProperty('CSHDRV_TRY|' + f.id) || 0) + 1;
      if (t >= 3) { sbReq_('patch', 'cash_files?id=eq.' + f.id, { drive_error: String(e.message).slice(0, 300) }, { Prefer: 'return=minimal' }); props.deleteProperty('CSHDRV_TRY|' + f.id); }
      else props.setProperty('CSHDRV_TRY|' + f.id, String(t));
      err.push((f.file_name || f.path) + ' : ' + e.message);
    }
  }
  if (n) out.push(n + ' justificatif' + (n > 1 ? 's' : '') + ' / reçu' + (n > 1 ? 's' : '') + ' copié' + (n > 1 ? 's' : '') + ' dans le Drive');
  if (err.length) out.push('Drive de la caisse : ' + err.slice(0, 3).join(' ; '));
  return out.join(' | ');
}
