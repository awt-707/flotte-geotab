// ============================================================================
// Boîtiers GPS (16/11/2026, demande d'Ahmed) : chaque plaque avec le numéro de son boîtier, date d'installation = premier bornage GPS,
// exportable en Excel, relié au Google Sheet « Géoloc - Maroc Luxury » (onglet « Boîtiers Geotab (Ludy) », tenu à jour par le collecteur).
// Page #/boitiers (dossier Flotte). Source : param geotabFleet publié par le collecteur toutes les heures (21_geolink.gs) :
// boîtiers associés à un véhicule de Ludy, et boîtiers dont la dernière position Geotab est au Maroc ou dont le nom porte une plaque marocaine.
// Administrateur : tous ; gestionnaire / lecture seule : boîtiers des véhicules de ses agences. Teksat : pas encore relié (aucun accès à son API).
// ============================================================================

function bxFleet() { const P = S.P || {}; try { const o = JSON.parse(String(P.geotabFleet || '')); return o && Array.isArray(o.list) ? o : { list: [] }; } catch (e) { return { list: [] }; } }
const bxYN = v => v == null ? '<span class="small">non mesuré</span>' : v ? 'Oui' : 'Non';
const bxYNt = v => v == null ? 'non mesuré' : v ? 'Oui' : 'Non';

/** Lignes du tableau : boîtier + véhicule de Ludy associé (plaque, provisoire, marque, modèle, agence) */
function bxRows(list, vehs, ok, admin) {
  const byGeo = {}; vehs.forEach(v => { if (v.geotab_id) byGeo[v.geotab_id] = v; });
  return list.map(d => {
    const v = byGeo[d.id] || null;
    return { d, v, plate: v ? v.plate : (d.p || d.n), other: v ? String(v.other_plates || '') : '', brand: v ? v.brand || '' : '', model: v ? v.model || '' : '',
      vin: (v && v.vin) || d.v || '', agency: v ? v.agency_id : null };
  }).filter(r => admin || (r.v && ok(r.v.key)));
}

const BX_COLS = [
  ['Immatriculation', r => r.v ? plate(r.plate) : esc(r.plate), r => r.plate, '', r => r.plate],
  ['Immatriculation provisoire', r => esc(r.other), r => r.other, '', r => r.other],
  ['Marque', r => esc(r.brand), r => r.brand, '', r => r.brand],
  ['Modèle', r => esc(r.model), r => r.model, '', r => r.model],
  ['N° de boîtier Geotab', r => `<b>${esc(r.d.s || '')}</b>`, r => r.d.s || '', '', r => r.d.s || ''],
  ['Nom dans Geotab', r => esc(r.d.n || ''), r => r.d.n || '', '', r => r.d.n || ''],
  ['Date d\'installation (1er bornage GPS)', r => r.d.b ? fmtDTY(r.d.b) : '<span class="small">non mesuré</span>', r => r.d.b || '', '', r => r.d.b ? fmtDTY(r.d.b) : 'non mesuré'],
  ['Activation Geotab', r => r.d.a ? fmtDTY(r.d.a) : '', r => r.d.a || '', '', r => r.d.a ? fmtDTY(r.d.a) : ''],
  ['Dernier signal', r => r.d.t ? fmtDTY(r.d.t) : '<span class="small">jamais vu</span>', r => r.d.t || '', '', r => r.d.t ? fmtDTY(r.d.t) : 'jamais vu'],
  ['Communique', r => bxYN(r.d.on), r => r.d.on ? 1 : 0, '', r => bxYNt(r.d.on)],
  ['Au Maroc', r => bxYN(r.d.maroc), r => r.d.maroc ? 1 : 0, '', r => bxYNt(r.d.maroc)],
  ['Relié à Ludy', r => r.v ? '<span class="badge ok">Oui</span>' : '<span class="badge warn">Non</span>', r => r.v ? 1 : 0, '', r => r.v ? 'Oui' : 'Non'],
  ['Agence', r => r.v ? agTxt(r.agency) : '', r => S.agName[r.agency] || '', '', r => S.agName[r.agency] || ''],
  ['VIN', r => esc(r.vin), r => r.vin, '', r => r.vin]];

function bxXls(rows) {
  const st = (window.__sort || {}).tbx || {}, l = rows.slice();
  if (st.c !== undefined && BX_COLS[st.c]) { const f = BX_COLS[st.c][2]; l.sort((a, b) => { const x = f(a), y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * (st.d ? -1 : 1); }); }
  const aoa = [BX_COLS.map(c => c[0])].concat(l.map(r => BX_COLS.map(c => c[4](r))));
  const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = BX_COLS.map((c, i) => ({ wch: Math.min(40, Math.max(10, ...aoa.map(r => String(r[i] || '').length))) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Boîtiers Geotab');
  XLSX.writeFile(wb, 'boitiers_gps_' + today() + '.xlsx');
}

async function pageBoitiers() {
  const rid = ROUTING;
  await loadRef(true);
  if (rid !== ROUTING) return;
  const g = bxFleet(), admin = isAdmin(), ok = inAgency(), rows = bxRows(g.list, S.vehList, ok, admin);
  const sid = String((S.P || {}).geotabSheetId || '').trim();
  const nOn = rows.filter(r => r.d.on).length, nMa = rows.filter(r => r.d.maroc).length, nLie = rows.filter(r => r.v).length;
  const draw = () => {
    $('#page').innerHTML = `<div class="head"><h1>Boîtiers GPS</h1><div class="sub">Chaque plaque avec le numéro de son boîtier Geotab. Date d'installation = premier bornage GPS du boîtier (première position reçue par Geotab).
      Liste relue dans Geotab par le collecteur toutes les heures${g.at ? ' · dernière lecture le ' + fmtDTY(g.at) : ''} ; un nouveau boîtier activé au Maroc y apparaît dans l'heure.</div></div>
      <div class="panel row"><button id="bxx">Exporter en Excel</button>
        ${sid ? `<a class="btn ghost" href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(sid)}/edit" target="_blank" rel="noopener">Google Sheet « Géoloc - Maroc Luxury » ↗</a><span class="small">onglet « Boîtiers Geotab (Ludy) », mis à jour toutes les heures</span>` : ''}</div>
      ${cards([['Boîtiers', f0(rows.length)], ['Reliés à un véhicule de Ludy', f0(nLie), nLie < rows.length ? 'warn' : ''], ['Communiquent', f0(nOn)], ['Dernière position au Maroc', f0(nMa)]])}
      <h2>Geotab</h2>
      ${g.list.length ? table('tbx', BX_COLS, rows, { page: true, empty: 'Aucun boîtier' }) : msg('La liste des boîtiers apparaît ici après le prochain passage du collecteur (au plus 1 heure).', 'warn')}
      <h2>Teksat</h2>
      ${msg('Teksat n\'est pas encore relié à Ludy : il faut un accès à l\'API Teksat (identifiants ou clé, documentation) pour lire ses boîtiers, leurs numéros et leurs dates d\'installation.', 'warn')}`;
    $('#bxx').onclick = () => bxXls(rows);
  };
  window.__repage = draw; window.__rerender = draw;
  draw();
}
