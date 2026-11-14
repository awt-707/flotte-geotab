// ============================================================================
// Contrôle des courses Uber (14/11/2026, demande d'Ahmed : chauffeurs qui acceptent une course sans aller chercher le client
// — annulation « par le client », sans pénalité — pendant qu'ils font des courses en cachette). Page #/uberctl.
// Export Uber Fleet « Activité des courses » importé ici (aussi souvent que voulu : l'export va jusqu'à quelques minutes avant
// son téléchargement), puis croisé avec le GPS Geotab (relais geotab-live ?mode=track, un appel par véhicule et par jour) :
// constat de chaque annulation (le véhicule est-il allé vers la prise en charge ?) et trajets sans course Uber en cours.
// Calculs : site/uberctl_calc.js. Résultats gardés dans la base (uber_trips.chk, uber_days) : vus par tous, sans tout refaire.
// ============================================================================
const UBX = { run: null, prog: '', err: '' };

const ubxMap = p => p ? 'https://www.google.com/maps/search/?api=1&query=' + p.lat + ',' + p.lon : '';
const ubxRoute = (a, b) => a && b ? 'https://www.google.com/maps/dir/?api=1&origin=' + a.lat + ',' + a.lon + '&destination=' + b.lat + ',' + b.lon : '';
const ubxM = m => m == null ? '' : m >= 1000 ? f1(m / 1000) + ' km' : f0(m) + ' m';
const ubxDrvKey = t => t.driver_uuid || ('N:' + (t.driver_name || ''));

/** Courses de la période (et la veille / le lendemain : courses voisines des fenêtres) et journées analysées */
async function ubxLoad(p) {
  const a = dayBounds(addDays(p.from, -1)).start.toISOString(), b = dayBounds(addDays(p.to, 1)).end.toISOString();
  const [trips, days] = await Promise.all([
    all('uber_trips', '*', q => q.gte('requested_at', a).lte('requested_at', b)),
    all('uber_days', '*', q => q.gte('day', addDays(p.from, -1)).lte('day', addDays(p.to, 1)))]);
  return { trips, days };
}

/** Position de la prise en charge : plus code de l'adresse (exact), sinon adresse précise trouvée par Photon (OpenStreetMap) */
async function ubxPickup(t, ref) {
  if (t.pu_prec) return t.pu_lat != null ? { lat: t.pu_lat, lon: t.pu_lon, prec: t.pu_prec } : null;
  const pc = ubcPlusCode(t.pickup_addr, ref);
  if (pc) return { lat: pc.lat, lon: pc.lon, prec: 'plus code' };
  try {
    const r = await fetch(ADDR_API + '?q=' + encodeURIComponent(t.pickup_addr || '') + '&limit=1&bbox=' + ADDR_BBOX + (ref ? '&lat=' + ref.lat + '&lon=' + ref.lon : ''));
    const j = await r.json(), f = j && j.features && j.features[0];
    if (f && ['house', 'street', 'other'].indexOf(f.properties.type) >= 0) return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], prec: 'adresse' };
    return { lat: null, lon: null, prec: 'non localisée' };
  } catch (e) { return null; }   // Photon indisponible : réessayé à la prochaine analyse
}

/** Journées (véhicule × jour du Maroc) à analyser : jamais analysées, analysées avant la fin de leur fenêtre, ou annulation sans constat */
function ubxTodo(trips, days, p, ok) {
  const D = {}; days.forEach(d => { D[d.vehicle_key + '|' + d.day] = d; });
  const g = {};
  trips.forEach(t => { if (!t.vehicle_key || !ok(t.vehicle_key)) return; const day = localDay(t.requested_at); if (day < p.from || day > p.to) return;
    (g[t.vehicle_key + '|' + day] = g[t.vehicle_key + '|' + day] || { key: t.vehicle_key, day, trips: [] }).trips.push(t); });
  return Object.values(g).filter(x => { const d = D[x.key + '|' + x.day];
    return !d || new Date(d.computed_at) < new Date(d.win_to) || x.trips.some(t => t.status !== 'completed' && !t.chk); }).sort((a, b) => (a.day + a.key).localeCompare(b.day + b.key));
}

/** Analyse Geotab des journées à faire (une à la fois ; la page peut changer : l'analyse continue et reste visible au retour) */
async function ubxAnalyze(trips, todo) {
  if (UBX.run) return UBX.run;
  UBX.err = '';
  UBX.run = (async () => {
    const P = S.P, now = Date.now();
    for (let i = 0; i < todo.length; i++) {
      const x = todo[i]; UBX.prog = 'Analyse Geotab : ' + (i + 1) + ' / ' + todo.length + ' journées (' + plateTxt(x.key) + ', ' + fmtDay(x.day) + ')'; ubxPaintProg();
      const b = dayBounds(x.day), ms = s => new Date(s).getTime();
      const veh = trips.filter(t => t.vehicle_key === x.key);
      // fenêtre : activité Uber du jour (30 min avant la première demande, 1 h après la dernière dépose), dans la journée
      const from = Math.max(b.start.getTime(), Math.min(...x.trips.map(t => ms(t.requested_at))) - 30 * MIN);
      const to = Math.min(b.end.getTime(), Math.max(...x.trips.map(t => t.dropoff_at ? ms(t.dropoff_at) : ms(t.requested_at) + 15 * MIN)) + 60 * MIN, now);
      let gps;
      try { gps = (await relay({ mode: 'track', key: x.key, from: new Date(from).toISOString(), to: new Date(to).toISOString() })).gps || []; }
      catch (e) { UBX.err = 'Geotab : ' + e.message; continue; }
      // annulations : constat
      const byDrv = {}; veh.forEach(t => { (byDrv[ubxDrvKey(t)] = byDrv[ubxDrvKey(t)] || []).push(t); });
      for (const t of x.trips.filter(t => t.status !== 'completed')) {
        const r = ms(t.requested_at), L = byDrv[ubxDrvKey(t)] || [];
        const busy = L.some(y => y !== t && y.status === 'completed' && ms(y.requested_at) < r && y.dropoff_at && ms(y.dropoff_at) > r);
        const nx = L.map(y => ms(y.requested_at)).filter(y => y > r).sort((a, c) => a - c)[0] || null;
        const near = gps.length ? gps.reduce((a, c) => Math.abs(c[0] - r) < Math.abs(a[0] - r) ? c : a) : null;
        const ref = near && Math.abs(near[0] - r) <= 3 * MIN ? { lat: near[2], lon: near[3] } : null;
        const pu = await ubxPickup(t, ref);
        const chk = ubcCancelCheck(t, gps, pu && pu.lat != null ? pu : null, busy, nx, P);
        const upd = { chk, chk_at: new Date().toISOString() };
        if (pu) Object.assign(upd, { pu_lat: pu.lat, pu_lon: pu.lon, pu_prec: pu.prec });
        const { error } = await sb.from('uber_trips').update(upd).eq('uuid', t.uuid);
        if (!error) Object.assign(t, upd);
      }
      // trajets sans course Uber
      const od = ubcOffDrive(gps, veh, from, to, P);
      od.segs.forEach(s => { const o = ubcOwnerAt(veh, new Date(s.a).getTime()), d = veh.find(t => ubxDrvKey(t) === o); s.owner = o; s.owner_name = d ? d.driver_name : null; });
      const row = { vehicle_key: x.key, day: x.day, agency_id: (vehOf(x.key) || {}).agency_id || null, win_from: new Date(from).toISOString(), win_to: new Date(to).toISOString(),
        km_uber: od.km_uber, km_off: od.km_off, n_gps: od.n, segs: od.segs, computed_at: new Date().toISOString(), computed_by: S.session.user.id };
      const { error } = await sb.from('uber_days').upsert(row, { onConflict: 'vehicle_key,day' });
      if (error) UBX.err = error.message;
    }
    UBX.prog = '';
  })().finally(() => { UBX.run = null; ubxPaintProg(); if (location.hash.indexOf('#/uberctl') === 0) pageUberCtl(); });
  return UBX.run;
}
function plateTxt(k) { const v = vehOf(k); return v && v.plate ? v.plate : k; }
function ubxPaintProg() { const e = $('#ubxprog'); if (e) e.innerHTML = UBX.prog ? msg(esc(UBX.prog) + ' — la page peut être quittée, l\'analyse continue.', 'warn') : (UBX.err ? msg(esc(UBX.err), 'err') : ''); }

/** Import de l'export « Activité des courses » (.csv ou .xlsx) */
async function ubxImport(file) {
  const buf = await file.arrayBuffer(), wb = cshReadBook(buf, file.name), rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  const res = ubcParseTrips(rows);
  if (res.error) throw new Error(res.error);
  const tot = { added: 0, updated: 0, same: 0, skipped: 0, no_vehicle: 0 };
  for (let i = 0; i < res.rows.length; i += 500) {
    const { data, error } = await sb.rpc('import_uber_trips', { p_rows: res.rows.slice(i, i + 500) });
    if (error) throw new Error(/import_uber_trips|PGRST202/.test(error.message) ? 'Module pas encore installé : migration 20261130000000_controle_uber.sql à exécuter' : error.message);
    Object.keys(tot).forEach(k => { tot[k] += (data && data[k]) || 0; });
  }
  const days = res.rows.map(r => r.requested_at).sort();
  return Object.assign(tot, { n: res.rows.length, bad: res.bad.length, from: days[0], to: days[days.length - 1] });
}

async function pageUberCtl() {
  const rid = ROUTING, q = qs(), tab = q.get('t') || 'synthese', drv = q.get('d') || '', vf = q.get('v') || '';
  const p = period(), ok = inAgency(), go = () => pageUberCtl().catch(e => { if (rid === ROUTING) $('#page').innerHTML = msg('Erreur : ' + esc(e.message || e), 'err'); });
  let data;
  try { data = await ubxLoad(p); }
  catch (e) { if (rid !== ROUTING) return; $('#page').innerHTML = `<h1>Contrôle Uber</h1>${msg(/42P01|PGRST205|does not exist|Could not find the table/.test(e.message || '') ? 'Module pas encore installé : migration <code>20261130000000_controle_uber.sql</code> à exécuter (Supabase > SQL Editor).' : 'Erreur : ' + esc(e.message), 'err')}`; return; }
  if (rid !== ROUTING) return;
  const inP = t => { const d = localDay(t.requested_at); return d >= p.from && d <= p.to; };
  const trips = data.trips.filter(t => (!t.vehicle_key || ok(t.vehicle_key)) && inP(t));
  const days = data.days.filter(d => ok(d.vehicle_key) && d.day >= p.from && d.day <= p.to);
  const segs = []; days.forEach(d => (d.segs || []).forEach(s => segs.push(Object.assign({ vehicle_key: d.vehicle_key, day: d.day }, s))));
  const st = ubcDriverStats(trips, segs);
  const todo = canEdit() ? ubxTodo(data.trips, data.days, p, ok) : [];
  const n = trips.length, cx = trips.filter(t => t.status !== 'completed'), rcx = cx.filter(t => t.status === 'rider_cancelled').length;
  const chk = cx.filter(t => t.chk && t.chk.v !== 'nm' && t.chk.v !== 'rapide'), sus = cx.filter(t => t.chk && ubcSuspect(t.chk.v));
  const kmU = days.reduce((s, d) => s + (+d.km_uber || 0), 0), kmO = days.reduce((s, d) => s + (+d.km_off || 0), 0);
  const fleetRate = n ? cx.length / n : 0;
  const tabs = [['synthese', 'Par chauffeur'], ['annulations', 'Annulations'], ['hors', 'Trajets sans course Uber'], ['jours', 'Par véhicule et par jour'], ['import', 'Importer l\'export Uber']];
  const dname = drv ? (st.find(o => o.key === drv) || {}).name || drv : '';
  const link = (t, extra) => '#/uberctl?t=' + t + (extra || '');
  const head = `<div class="head"><h1>Contrôle Uber${dname ? ' · ' + esc(dname) : ''}</h1><div class="sub">Export Uber « Activité des courses » croisé avec le GPS Geotab : pour chaque annulation, ce que le véhicule a fait dans les 15 min après la demande (l'export ne donne pas l'heure de l'annulation) ; trajets du véhicule alors qu'aucune course Uber n'était en cours (de la demande à la dépose). Rien n'est estimé : « non mesuré » sans GPS ou sans adresse précise.</div></div>
    <div class="tabs">${tabs.map(t => `<a class="tab ${t[0] === tab ? 'on' : ''}" href="${link(t[0], drv ? '&d=' + encodeURIComponent(drv) : '')}">${t[1]}</a>`).join('')}${drv ? ` <a class="tab" href="${link(tab)}">✕ tous les chauffeurs</a>` : ''}</div>
    <div id="ubxprog"></div>${tab !== 'import' ? periodBar(go) : ''}
    ${todo.length && !UBX.run && tab !== 'import' ? `<div class="panel row"><b>${todo.length} journée(s) à vérifier avec Geotab</b> <button id="ubxgo">Lancer la vérification Geotab</button> <span class="small">un appel Geotab par véhicule et par jour</span></div>` : ''}
    ${n ? cards([['Courses demandées', f0(n)], ['Annulées', f0(cx.length) + ' (' + f0(fleetRate * 100) + ' %)', fleetRate > 0.1 ? 'warn' : ''], ['dont par le client', f0(rcx)],
      ['Annulations vérifiées avec le GPS', f0(chk.length) + ' / ' + f0(cx.length)], ['Véhicule pas allé vers le client', f0(sus.length), sus.length ? 'crit' : ''],
      ['km sans course Uber', days.length ? f0(kmO) + ' km (' + f0(kmU + kmO ? 100 * kmO / (kmU + kmO) : 0) + ' %)' : NM, kmO ? 'warn' : '']]) : ''}`;
  const T = drv ? trips.filter(t => ubxDrvKey(t) === drv) : trips, SG = drv ? segs.filter(s => s.owner === drv) : segs;
  const vTxt = c => { if (!c) return `<span class="nm">pas encore vérifiée</span>`; const d = UBC_V[c.v] || UBC_V.nm; return badge(d.t, { ok: 'ok', bad: 'crit', warn: 'warn', mute: '' }[d.lv]); };
  const facts = t => { const c = t.chk; if (!c || c.v === 'nm') return c && c.why ? esc(c.why) : '';
    if (c.v === 'rapide') return 'nouvelle demande ' + f0(c.min) + ' min après';
    const a = []; if (c.d0 != null) a.push('à ' + ubxM(c.d0) + ' de la prise en charge à la demande', 'au plus près ' + ubxM(c.dmin), 'à ' + ubxM(c.dend) + ' ' + f0(c.min) + ' min après');
    a.push(ubxM(c.path) + ' parcourus en ' + f0(c.min) + ' min'); if (c.why) a.push(c.why); return esc(a.join(' · ')); };
  const maps = t => { const c = t.chk || {}, pu = t.pu_lat != null ? { lat: t.pu_lat, lon: t.pu_lon } : null;
    return [pu ? `<a href="${ubxMap(pu)}" target="_blank" rel="noopener">prise en charge</a>` : '', c.at ? `<a href="${ubxMap(c.at)}" target="_blank" rel="noopener">véhicule à la demande</a>` : '',
      c.at && c.end ? `<a href="${ubxRoute(c.at, c.end)}" target="_blank" rel="noopener">trajet après</a>` : ''].filter(Boolean).join(' · '); };
  const dlink = (k, name) => `<a href="${link('annulations', '&d=' + encodeURIComponent(k))}">${esc(name || '—')}</a>`;
  let body = '';
  if (tab === 'import') {
    body = `<div class="panel">${canEdit() ? `<h3>Importer l'export « Activité des courses »</h3>
      <p class="small">Uber Fleet (fleet.uber.com / supplier.uber.com) > Rapports > « Activité des courses » (trip_activity) > télécharger le CSV, puis le déposer ici. L'export va jusqu'à quelques minutes avant son téléchargement : l'importer plusieurs fois par shift permet de suivre presque en temps réel. Une course importée deux fois n'est comptée qu'une fois (statut mis à jour).</p>
      <label class="file">Fichier CSV ou Excel <input type="file" id="ubxfile" accept=".csv,.xlsx,.xls"></label><div id="ubxres"></div>` : msg('Import réservé aux gestionnaires et à l\'administrateur.', 'warn')}</div>`;
  } else if (tab === 'synthese') {
    const cols = [['Chauffeur (Uber)', o => dlink(o.key, o.name), o => o.name], ['Véhicule(s)', o => esc(o.plates.join(', '))], ['Courses demandées', o => f0(o.n), o => o.n, 'n'], ['Terminées', o => f0(o.done), o => o.done, 'n'],
      ['Annulées par le client', o => f0(o.rcx), o => o.rcx, 'n'], ['Annulées par le chauffeur', o => f0(o.dcx), o => o.dcx, 'n'],
      ['Taux d\'annulation', o => `<b class="${o.cxRate >= Math.max(0.2, 1.5 * fleetRate) ? 'bad' : ''}">${f0(o.cxRate * 100)} %</b>`, o => o.cxRate, 'n'],
      ['Annulations vérifiées (GPS)', o => f0(o.checked), o => o.checked, 'n'], ['Véhicule pas allé vers le client', o => o.susp ? `<b class="bad">${f0(o.susp)}</b>` : '0', o => o.susp, 'n'],
      ['Resté sur place', o => f0(o.still), o => o.still, 'n'], ['Trajets sans course Uber', o => f0(o.offN), o => o.offN, 'n'], ['km sans course Uber', o => o.offKm ? `<b class="${o.offKm >= 20 ? 'bad' : ''}">${f1(o.offKm)}</b>` : '0', o => o.offKm, 'n'],
      ['dont avec une annulation juste avant ou pendant', o => o.offCx ? `<b class="bad">${f0(o.offCx)}</b>` : '0', o => o.offCx, 'n']];
    window.__sort = window.__sort || {}; if (!window.__sort.tubs) window.__sort.tubs = { c: 8, d: true };
    const rows = drv ? st.filter(o => o.key === drv) : st;
    body = `<div class="panel"><h3>Par chauffeur (taux moyen de la flotte : ${f0(fleetRate * 100)} %)</h3>${table('tubs', cols, rows, { page: true, empty: n ? 'Aucun chauffeur' : 'Aucune course importée sur la période : onglet « Importer l\'export Uber »' })}
      <p class="small">« Véhicule pas allé vers le client » : dans les 15 min après la demande, le véhicule ne s'est pas rapproché de l'adresse de prise en charge (localisée par le plus code de l'adresse Uber ou par OpenStreetMap). « Resté sur place » : le véhicule n'a pas bougé (l'annulation a pu venir vite : à vérifier). « km sans course Uber » : trajets d'au moins 1,5 km roulés alors qu'aucune course Uber n'était en cours (déplacements à vide compris : à comparer entre chauffeurs).</p>
      <button class="ghost" id="ubxpdf">PDF</button> <button class="ghost" id="ubxxls">Tableur</button></div>`;
    UBX.pdf = () => rptSimple({ kind: 'uber', title: 'Contrôle des courses Uber' + (dname ? ' · ' + dname : ''), period: fmtDay(p.from) + ' → ' + fmtDay(p.to), from: p.from, to: p.to,
      summary: [['Courses demandées', f0(n)], ['Annulées', f0(cx.length)], ['Vérifiées avec le GPS', f0(chk.length)], ['Pas allé vers le client', f0(sus.length)], ['km sans course Uber', f0(kmO)]],
      tables: [colsTable('Par chauffeur', cols, rows.slice().sort((a, b) => b.susp - a.susp || b.cxRate - a.cxRate))].concat(drv ? [colsTable('Annulations', ubxCxCols(vTxt, facts, () => ''), T.filter(t => t.status !== 'completed')), colsTable('Trajets sans course Uber', ubxSegCols(() => ''), SG)] : []),
      fileName: 'controle_uber_' + p.from + '_' + p.to });
    UBX.xls = [['Par chauffeur', cols, rows]];
  } else if (tab === 'annulations') {
    const sel = q.get('f') || 'toutes';
    const L = T.filter(t => t.status !== 'completed' && (!vf || t.vehicle_key === vf)).filter(t => sel === 'toutes' || (sel === 'suspectes' ? t.chk && ubcSuspect(t.chk.v) : sel === 'surplace' ? t.chk && t.chk.v === 'immobile' : !t.chk || t.chk.v === 'nm'))
      .sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)));
    const cols = ubxCxCols(vTxt, facts, maps);
    body = `<div class="panel"><div class="row"><label>Afficher <select id="ubxf">${[['toutes', 'Toutes les annulations'], ['suspectes', 'Véhicule pas allé vers le client'], ['surplace', 'Véhicule resté sur place'], ['nm', 'Pas encore vérifiées / non mesurées']].map(o => `<option value="${o[0]}" ${o[0] === sel ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></label></div>
      ${table('tubc', cols, L, { page: true, empty: 'Aucune annulation sur la période' })}<button class="ghost" id="ubxpdf">PDF</button> <button class="ghost" id="ubxxls">Tableur</button></div>`;
    UBX.pdf = () => rptSimple({ kind: 'uber', title: 'Annulations Uber' + (dname ? ' · ' + dname : ''), period: fmtDay(p.from) + ' → ' + fmtDay(p.to), from: p.from, to: p.to,
      summary: [['Annulations', f0(L.length)], ['Pas allé vers le client', f0(L.filter(t => t.chk && ubcSuspect(t.chk.v)).length)]], tables: [colsTable('Annulations', ubxCxCols(vTxt, facts, () => ''), L)], fileName: 'annulations_uber_' + p.from + '_' + p.to });
    UBX.xls = [['Annulations', ubxCxCols(vTxt, facts, () => ''), L]];
  } else if (tab === 'hors') {
    const L = SG.slice().sort((a, b) => String(b.a).localeCompare(String(a.a)));
    const cols = ubxSegCols(s => `<a href="${ubxRoute(s.from, s.to)}" target="_blank" rel="noopener">trajet sur la carte</a>`);
    body = `<div class="panel"><h3>Trajets sans course Uber (au moins 1,5 km hors course)</h3>${table('tubh', cols, L, { page: true, empty: days.length ? 'Aucun trajet sans course Uber' : 'Aucune journée vérifiée avec Geotab sur la période' })}
      <p class="small">Le véhicule roule alors qu'aucune course Uber n'est en cours : course faite hors de l'application, ou déplacement à vide (retour, plein, recherche de clients). Les trajets précédés d'annulations sont les plus suspects.</p>
      <button class="ghost" id="ubxpdf">PDF</button> <button class="ghost" id="ubxxls">Tableur</button></div>`;
    UBX.pdf = () => rptSimple({ kind: 'uber', title: 'Trajets sans course Uber' + (dname ? ' · ' + dname : ''), period: fmtDay(p.from) + ' → ' + fmtDay(p.to), from: p.from, to: p.to,
      summary: [['Trajets', f0(L.length)], ['km sans course Uber', f1(L.reduce((s, x) => s + x.km_off, 0))]], tables: [colsTable('Trajets sans course Uber', ubxSegCols(() => ''), L)], fileName: 'hors_uber_' + p.from + '_' + p.to });
    UBX.xls = [['Trajets sans course Uber', ubxSegCols(() => ''), L]];
  } else {
    const cols = [['Jour', d => fmtDay(d.day), d => d.day], ['Véhicule', d => vlink(d.vehicle_key), d => plateTxt(d.vehicle_key)], ['Fenêtre analysée', d => esc(fmtDT(d.win_from).slice(6) + ' → ' + fmtDT(d.win_to).slice(6))],
      ['km pendant une course Uber', d => f1(+d.km_uber), d => +d.km_uber, 'n'], ['km sans course Uber', d => f1(+d.km_off), d => +d.km_off, 'n'],
      ['Part sans course Uber', d => { const t = +d.km_uber + +d.km_off, r = t ? +d.km_off / t : 0; return t ? `<b class="${r >= 0.3 ? 'bad' : ''}">${f0(r * 100)} %</b>` : NM; }, d => (+d.km_uber + +d.km_off) ? +d.km_off / (+d.km_uber + +d.km_off) : -1, 'n'],
      ['Trajets sans course Uber', d => f0((d.segs || []).length), d => (d.segs || []).length, 'n'], ['Relevés GPS', d => f0(d.n_gps), d => d.n_gps, 'n']];
    window.__sort = window.__sort || {}; if (!window.__sort.tubj) window.__sort.tubj = { c: 5, d: true };
    body = `<div class="panel">${table('tubj', cols, days, { page: true, empty: 'Aucune journée vérifiée avec Geotab sur la période' })}</div>`;
    UBX.pdf = null; UBX.xls = [['Par véhicule et par jour', cols, days]];
  }
  $('#page').innerHTML = head + body;
  ubxPaintProg();
  if ($('#ubxgo')) $('#ubxgo').onclick = () => { ubxAnalyze(data.trips, todo); ubxPaintProg(); $('#ubxgo').closest('.panel').remove(); };
  if ($('#ubxf')) $('#ubxf').onchange = e => { location.hash = link('annulations', (drv ? '&d=' + encodeURIComponent(drv) : '') + '&f=' + e.target.value); };
  if ($('#ubxpdf')) $('#ubxpdf').onclick = () => { try { reportPdf(UBX.pdf()); } catch (e) { uiNote(e.message); } };
  if ($('#ubxxls')) $('#ubxxls').onclick = () => { if (!window.XLSX) { uiNote('Bibliothèque tableur non chargée, réessayez dans un instant.'); return; }
    const wb = XLSX.utils.book_new(); UBX.xls.forEach(([name, cols, rows]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols.map(c => txtOf(c[0]))].concat(rows.map(r => cols.map(c => { const v = c[2] ? c[2](r) : null; return c[3] === 'n' && typeof v === 'number' ? Math.round(v * 100) / 100 : txtOf(c[1](r)); })))), name.slice(0, 31)));
    XLSX.writeFile(wb, 'controle_uber_' + p.from + '_' + p.to + '.xlsx'); };
  if ($('#ubxfile')) $('#ubxfile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return; $('#ubxres').innerHTML = '<div class="loading">Import…</div>';
    try {
      const r = await ubxImport(f);
      $('#ubxres').innerHTML = msg(`${f0(r.n)} courses lues (${r.from ? fmtDTY(r.from) : ''} → ${r.to ? fmtDTY(r.to) : ''}) : ${f0(r.added)} nouvelles, ${f0(r.updated)} mises à jour, ${f0(r.same)} déjà importées${r.skipped ? ', ' + f0(r.skipped) + ' d\'autres agences ignorées' : ''}${r.no_vehicle ? ', ' + f0(r.no_vehicle) + ' sur une plaque inconnue de Ludy' : ''}${r.bad ? ', ' + f0(r.bad) + ' lignes illisibles' : ''}. Vérification Geotab lancée.`, 'ok');
      // période de l'export : vérifiée tout de suite
      if (r.from) { lsSet('periode', { sel: 'Personnalisé', from: localDay(r.from), to: localDay(r.to) }); const pp = period(), d2 = await ubxLoad(pp); ubxAnalyze(d2.trips, ubxTodo(d2.trips, d2.days, pp, inAgency())); ubxPaintProg(); }
    } catch (err) { $('#ubxres').innerHTML = msg('Import impossible : ' + esc(err.message), 'err'); }
  };
  window.__repage = () => pageUberCtl();
}
function ubxCxCols(vTxt, facts, maps) {
  return [['Demande (heure du Maroc)', t => esc(fmtDT(t.requested_at)), t => t.requested_at], ['Chauffeur (Uber)', t => esc(t.driver_name || '—'), t => t.driver_name || ''], ['Véhicule', t => esc(t.plate || ''), t => t.plate || ''],
    ['Statut Uber', t => esc(UBC_ST[t.status] || t.status), t => t.status], ['Paiement', t => esc(t.payment === 'cash' ? 'Espèces' : t.payment || ''), t => t.payment || ''],
    ['Prise en charge', t => esc(t.pickup_addr || '') + (t.pu_prec ? `<div class="small">${esc(t.pu_prec === 'non localisée' ? 'adresse non localisée' : 'localisée par ' + t.pu_prec)}</div>` : '')],
    ['Constat Geotab', t => vTxt(t.chk), t => t.chk ? Object.keys(UBC_V).indexOf(t.chk.v) : 99], ['Ce que le véhicule a fait', facts, null, 'wide'], ['Carte', maps]];
}
function ubxSegCols(mapCell) {
  return [['Début (heure du Maroc)', s => esc(fmtDT(s.a)), s => s.a], ['Fin', s => esc(fmtDT(s.b).slice(6)), s => s.b], ['Véhicule', s => esc(plateTxt(s.vehicle_key)), s => plateTxt(s.vehicle_key)],
    ['Chauffeur (dernière course Uber)', s => esc(s.owner_name || '—'), s => s.owner_name || ''], ['km sans course Uber', s => f1(s.km_off), s => s.km_off, 'n'], ['Durée (min)', s => f0(s.min), s => s.min, 'n'],
    ['Annulations juste avant ou pendant', s => s.cancels ? `<b class="bad">${f0(s.cancels)}</b>` : '0', s => s.cancels, 'n'], ['Carte', mapCell]];
}
