// Courses privées : découverte client, devis et missions avec chauffeur (cahier des charges « Process de découverte client »,
// grille tarifaire Ludy). Partie 1 : calculs purs (testés sous Node). Partie 2 : page du site (utilise les outils d'app.js).

// ---------- 1. Calculs ----------
/** Types de prestation (section 3) et formule tarifaire de la grille proposée pour chacun */
const CRS_KINDS = [['Transfert aéroport', 'aeroport'], ['Transfert simple', 'interville'], ['Aller-retour', 'interville'], ['Déplacement interville', 'interville'],
  ['Mise à disposition à l\'heure', 'heure'], ['Mise à disposition à la journée', 'journee'], ['Mise à disposition sur plusieurs jours', 'jours'],
  ['Circuit touristique', 'jours'], ['Roadshow professionnel', 'jours'], ['Transport d\'une délégation', 'jours'], ['Service événementiel', 'jours'],
  ['Disponibilité de nuit', 'jours'], ['Disponibilité 24 h/24', 'special'], ['Chauffeur dédié résidant avec le client', 'special']];
const CRS_BASES = { aeroport: 'Transfert aéroport (grille)', interville: 'Interville depuis la ville de départ (grille)', heure: 'Tarif horaire (grille)',
  demi: 'Demi-journée (grille)', journee: 'Journée complète (grille)', jours: 'Journée × nombre de jours (grille)', special: 'Tarification spécifique (prix fixé par la direction)',
  convenu: 'Prix convenu avec le client (course rapide)' };
const CRS_LEVELS = ['Standard', 'Premium', 'VIP', 'Protocolaire'];
const CRS_DISPO = ['Disponibilité planifiée', 'Disponibilité flexible', 'Disponibilité immédiate', 'Disponibilité 24 h/24'];
const CRS_KM = ['Moins de 100 km par jour', 'De 100 à 200 km par jour', 'De 200 à 300 km par jour', 'De 300 à 500 km par jour', 'Plus de 500 km par jour'];
const CRS_CITIES = ['Casablanca', 'Rabat', 'Marrakech', 'Tanger', 'Agadir', 'Fès', 'Meknès', 'Chefchaouen', 'Essaouira', 'Ouarzazate', 'Merzouga', 'Tétouan', 'Aéroports', 'Circuits dans le désert'];
const CRS_EXTRAS = ['Accueil nominatif à l\'aéroport', 'Pancarte personnalisée', 'Suivi du vol', 'Assistance bagages', 'Eau à bord', 'Wi-Fi', 'Chargeurs de téléphone',
  'Siège bébé ou rehausseur', 'Chauffeur en costume', 'Chauffeur bilingue', 'Coordinateur', 'Organisation d\'un convoi', 'Sécurité ou garde du corps', 'Réservations de restaurants',
  'Assistance touristique', 'Guide touristique agréé', 'Organisation d\'excursions', 'Facturation détaillée par trajet', 'Rapport quotidien des kilomètres et horaires', 'Confidentialité renforcée'];
const CRS_STATUS = ['Demande', 'Devis envoyé', 'Accepté', 'Acompte reçu', 'Confirmée', 'En cours', 'Terminée', 'Facturée', 'Annulée', 'Refusée'];
const CRS_BLOCK = ['Acompte reçu', 'Confirmée', 'En cours'];   // véhicule bloqué pour la mission

/** Ville de départ et aéroport d'une grille (grilles d'avant les villes de départ : Casablanca, aéroport Mohammed V) */
function crsOrigin(G) { return (G && G.origin) || 'Casablanca'; }
function crsAirport(G) { return 'aéroport ' + ((G && G.airportName) || 'Mohammed V'); }
function crsN(v) { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; }
function crsMoney(v) { const n = Math.round(crsN(v) * 100) / 100, s = Math.abs(n).toFixed(Number.isInteger(n) ? 0 : 2).split('.'); return (n < 0 ? '-' : '') + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (s[1] ? ',' + s[1] : '') + ' MAD'; }
/** Heures « HH:MM » → nombre d'heures ; durée d'une journée (fin après minuit acceptée) */
function crsHM(t) { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] + +m[2] / 60 : null; }
function crsSpan(a, b) { const x = crsHM(a), y = crsHM(b); if (x === null || y === null) return null; return y > x ? y - x : y + 24 - x; }
/** Nombre de jours de la mission (date de début et de fin, jours calendaires inclus) */
function crsDays(f) {
  const a = String(f.startDate || '').slice(0, 10), b = String(f.endDate || f.startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return 0;
  return Math.max(1, Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8))) / 86400000) + 1);
}
/** Heures par jour : saisies, sinon amplitude entre l'heure de début et de fin */
function crsHoursDay(f) { if (f.h24) return 24; const h = crsN(f.hoursDay); return h > 0 ? h : (crsSpan(f.dayStart, f.dayEnd) || 0); }
/** Formule selon l'amplitude quotidienne (section 5) */
function crsAmplitude(f) {
  const h = crsHoursDay(f);
  if (f.h24) return 'Disponibilité 24 h/24 (relais de chauffeurs obligatoire)';
  if (!h) return '';
  return h <= 5 ? 'Demi-journée (jusqu\'à 5 h)' : h <= 10 ? 'Journée standard (jusqu\'à 10 h)' : h <= 12 ? 'Journée longue (10 à 12 h)' : h <= 15 ? 'Journée très longue (12 à 15 h)' : 'Disponibilité étendue (plus de 15 h)';
}
/** Formule tarifaire proposée pour la prestation */
function crsBase(f, G) {
  if (f.base) return f.base;
  const k = (CRS_KINDS.find(x => x[0] === f.kind) || [])[1] || '';
  if (k === 'journee' || k === 'jours') {
    if (crsDays(f) > 1) return 'jours';
    // une journée : demi-journée si les heures et les km tiennent dans son forfait
    const H = (G && G.half) || { h: 4, km: 80 }, h = crsHoursDay(f);
    return h > 0 && h <= crsN(H.h) && crsN(f.kmDay) <= crsN(H.km) ? 'demi' : k === 'jours' ? 'jours' : 'journee';
  }
  return k;
}
function crsCities(f) { return [...new Set([f.startCity, f.endCity].concat(f.cities || []).map(c => String(c || '').trim()).filter(c => c && c !== 'Aéroports' && c !== 'Circuits dans le désert'))]; }
/** Classement (parcours court, point 3) : Standard / Intensive / 24h-VIP, avec les raisons */
function crsLevel(f) {
  const why = [], h = crsHoursDay(f), km = crsN(f.kmDay), cities = crsCities(f);
  if (f.h24 || f.kind === 'Disponibilité 24 h/24' || f.dispo === 'Disponibilité 24 h/24') why.push('disponibilité 24 h/24');
  if (f.dispo === 'Disponibilité immédiate') why.push('disponibilité immédiate');
  if (f.service === 'VIP' || f.service === 'Protocolaire') why.push('client ' + f.service);
  if (why.length) return { level: '24h / VIP', why };
  if (h > 10) why.push(h + ' h par jour');
  if (km > 200) why.push(km + ' km par jour');
  if (cities.length > 1) why.push('plusieurs villes (' + cities.join(', ') + ')');
  if (crsN(f.driverNights) > 0) why.push(crsN(f.driverNights) + ' nuit(s) du chauffeur à l\'extérieur');
  if (f.night) why.push('utilisation de nuit');
  return why.length ? { level: 'Intensive', why } : { level: 'Standard', why: ['planning connu, utilisation normale, kilométrage maîtrisé'] };
}
/** Validation de l'exploitation obligatoire avant l'envoi du prix (section 17) : liste des raisons */
function crsValidation(f, total, G) {
  const r = [], days = crsDays(f), km = crsN(f.kmDay), cities = crsCities(f), endH = crsHM(f.dayEnd), startH = crsHM(f.dayStart);
  if (days > 3) r.push('plus de trois jours consécutifs (' + days + ' jours)');
  if (km > 300) r.push('plus de 300 km par jour (' + km + ' km)');
  if (cities.length > 1) r.push('plusieurs villes');
  if (f.afterMidnight || (endH !== null && startH !== null && endH < startH)) r.push('disponibilité après minuit');
  if (f.h24 || f.dispo === 'Disponibilité 24 h/24' || f.kind === 'Disponibilité 24 h/24') r.push('disponibilité 24 h/24');
  if (crsN(f.drivers) >= 2) r.push(crsN(f.drivers) + ' chauffeurs');
  if (f.international) r.push('déplacement international');
  if (crsN(f.nVeh) > 1) r.push('convoi de ' + crsN(f.nVeh) + ' véhicules');
  if (f.service === 'VIP' || f.service === 'Protocolaire') r.push('client ' + f.service);
  if (f.planning === 'non') r.push('planning non défini');
  if (f.kmUnlimited) r.push('kilométrage illimité demandé');
  const lim = G && crsN(G.validationAmount);
  if (lim > 0 && total > lim) r.push('montant important (' + crsMoney(total) + ')');
  if (f.riskNote) r.push('risque signalé : ' + f.riskNote);
  return r;
}
/** Points à définir avant d'envoyer un prix de mise à disposition (section 18, règle finale) */
function crsMissing(f, G) {
  const b = crsBase(f, G), out = [];
  if (!f.client) out.push('nom du client');
  if (!f.startDate) out.push('date de début');
  if (!f.cat) out.push('véhicule');
  if (!crsN(f.pax)) out.push('nombre de passagers');
  if (b === 'aeroport' || b === 'interville') { if (!f.dest) out.push('destination'); return out; }
  if (b === 'convenu') { if (!crsN(f.agreedPrice)) out.push('prix convenu'); return out; }
  if (!crsHoursDay(f)) out.push('heures incluses par jour');
  if (!crsN(f.kmDay) && !f.kmUnlimited) out.push('kilométrage estimé par jour');
  if (!f.startCity) out.push('ville de prise en charge (zone d\'utilisation)');
  if (b === 'special' && !crsN(f.dayPrice)) out.push('prix journalier fixé par la direction');
  return out;
}
/** Le véhicule peut-il transporter les passagers ? (sièges de la catégorie × nombre de véhicules) */
function crsSeatsOk(f, G) { const c = ((G && G.cats) || []).find(x => x.id === f.cat); return !c || !crsN(f.pax) || crsN(f.pax) <= crsN(c.seats) * Math.max(1, crsN(f.nVeh) || 1); }

/**
 * Prix du devis selon la grille (prix TTC). Lignes { label, qty, unit, amount, kind } ; remises en négatif.
 * Ce qui n'est pas dans la grille (frais du chauffeur, second chauffeur, péages hors forfait, prestations complémentaires, prix 24 h/24)
 * est saisi au devis : rien n'est estimé.
 */
function crsPrice(f, G) {
  if (f && f.kind === 'Aller-retour' && !f.roundTrip) f = Object.assign({}, f, { roundTrip: true, returnEmpty: false });   // type « Aller-retour » = retour facturé
  G = G || {}; const cat = f.cat, base = crsBase(f, G), nVeh = Math.max(1, crsN(f.nVeh) || 1), lines = [], notes = [];
  const val = (o, k) => crsN(o && o[k]);
  const add = (label, qty, unit, kind) => { const amount = Math.round(qty * unit * 100) / 100; if (amount) lines.push({ label, qty, unit, amount, kind: kind || 'base' }); return amount; };
  const days = crsDays(f) || 1, hDay = crsHoursDay(f), kmDay = crsN(f.kmDay), nightPct = crsN(G.nightPct);
  let inc = { h: null, km: null }, extraH = val(G.hourly, cat), extraKm = val(G.kmExtra, cat), baseSum = 0;
  const vehTxt = nVeh > 1 ? ' × ' + nVeh + ' véhicules' : '';
  if (base === 'convenu') {
    // course rapide : prix convenu avec le client (proposé depuis la grille, modifiable), sans devis préalable
    const route = [f.startAddr || f.startCity, f.endAddr || f.endCity].filter(Boolean).join(' → ');
    if (!crsN(f.agreedPrice)) notes.push('Prix convenu à saisir.');
    baseSum += add('Course' + (route ? ' ' + route : '') + (f.gridRef ? ' (' + f.gridRef + ')' : '') + ' : prix convenu' + vehTxt, 1, crsN(f.agreedPrice));
  } else if (base === 'aeroport' || base === 'interville') {
    const tab = base === 'aeroport' ? G.airport : G.intercity, row = (tab || []).find(r => r.dest === f.dest), p = val(row, cat);
    const what = (base === 'aeroport' ? 'Transfert ' + crsAirport(G) + ' ↔ ' : crsOrigin(G) + ' → ') + (f.dest || '?');
    if (!row) notes.push('Destination absente de la grille : prix à fixer par la direction.');
    else if (!p) notes.push('Pas de prix dans la grille pour cette catégorie de véhicule.');
    // chaque trajet : prix de la grille ; nuit (22h–6h) ou jour férié : +15 % sur ce trajet (nuit et férié non cumulables)
    const nightTxt = 'Nuit (' + (G.nightFrom || 22) + 'h–' + (G.nightTo || 6) + 'h) ou jour férié : +' + nightPct + ' % (non cumulables)';
    // course retour (grille) : course dans le sens du retour d'un véhicule qui rentrerait à vide (déposé par un autre client) : −30 % sur ce trajet
    const retour = !f.roundTrip && f.returnEmpty && crsN(G.returnPct);
    let go = add((retour && base === 'interville' ? (f.dest || '?') + ' → ' + crsOrigin(G) : what) + (f.roundTrip ? ' (aller)' : '') + vehTxt, nVeh, p); baseSum += go;
    if (retour && go) { const r = add('Course retour : véhicule qui rentre à vide (−' + G.returnPct + ' %)', 1, -go * crsN(G.returnPct) / 100, 'remise'); go += r; baseSum += r; }
    if ((f.night || f.holiday) && nightPct && go) add(nightTxt + (f.roundTrip ? ', aller' : ''), 1, go * nightPct / 100, 'majoration');
    if (f.roundTrip) {
      let back = add(what + ' (retour)' + vehTxt, nVeh, p); baseSum += back;
      if ((f.nightReturn || f.holiday) && nightPct && back) add(nightTxt + ', retour', 1, back * nightPct / 100, 'majoration');
    }
    const free = base === 'aeroport' ? crsN(G.waitFreeAirport) : crsN(G.waitFreeOther), w = Math.max(0, crsN(f.waitMin) - free);
    if (w > 0) add('Attente au-delà de ' + free + ' min incluses (' + crsN(f.waitMin) + ' min prévues)', Math.ceil(w / 15) * nVeh, val(G.wait15, cat), 'attente');
  } else if (base === 'heure') {
    const h = Math.max(crsN(G.hourlyMinH), Math.ceil(hDay || crsN(f.hours)));
    baseSum += add('Mise à disposition à l\'heure (minimum ' + crsN(G.hourlyMinH) + ' h)' + vehTxt, h * nVeh, val(G.hourly, cat));
    inc = { h, km: null };
    if (kmDay > 0) notes.push('Tarif horaire : kilométrage non forfaitisé dans la grille ; au-delà d\'un usage en ville, à préciser au devis.');
    if ((f.night || f.holiday) && nightPct) add('Nuit (' + (G.nightFrom || 22) + 'h–' + (G.nightTo || 6) + 'h) ou jour férié : +' + nightPct + ' % (non cumulables)', 1, baseSum * nightPct / 100, 'majoration');
  } else if (base === 'demi' || base === 'journee' || base === 'jours' || base === 'special') {
    const F = base === 'demi' ? G.half : G.day, nd = base === 'jours' || base === 'special' ? days : 1;
    const dayP = base === 'special' ? crsN(f.dayPrice) : val(F, cat);
    if (base === 'special' && !dayP) notes.push('Disponibilité 24 h/24 / chauffeur dédié : tarification spécifique, prix journalier à fixer par la direction (rotation de chauffeurs).');
    const lbl = base === 'demi' ? 'Demi-journée (' + F.h + ' h · ' + F.km + ' km inclus)' : base === 'special' ? 'Mise à disposition spécifique (prix fixé par la direction)' : 'Journée complète (' + (F || {}).h + ' h · ' + (F || {}).km + ' km inclus)';
    baseSum += add(lbl + (nd > 1 ? ' × ' + nd + ' jours' : '') + vehTxt, nd * nVeh, dayP);
    inc = base === 'special' ? { h: hDay || null, km: f.kmUnlimited ? null : (kmDay || null) } : { h: crsN(F && F.h), km: crsN(F && F.km) };
    // dépassements prévus dès la découverte (heure commencée, km au-delà du forfait), au tarif de la grille
    if (base !== 'special' && hDay > inc.h) add('Heures prévues au-delà de ' + inc.h + ' h / jour (' + hDay + ' h / jour, heure commencée)', Math.ceil(hDay - inc.h) * nd * nVeh, extraH, 'depassement');
    if (base !== 'special' && kmDay > inc.km) add('Km prévus au-delà de ' + inc.km + ' km / jour (' + kmDay + ' km / jour)', (kmDay - inc.km) * nd * nVeh, extraKm, 'depassement');
    // inclus au devis = forfait + dépassements prévus déjà facturés (le contrôle Geotab ne les refacture pas)
    if (base !== 'special') inc = { h: Math.max(inc.h, Math.ceil(hDay || 0)), km: Math.max(inc.km, kmDay || 0) };
    const nn = Math.min(nd, crsN(f.nightDays) || ((f.night || f.holiday) ? nd : 0));
    if (nn && nightPct && dayP) add('Nuit (' + (G.nightFrom || 22) + 'h–' + (G.nightTo || 6) + 'h) ou jour férié : +' + nightPct + ' % sur ' + nn + ' jour(s) (non cumulables)', nn * nVeh, dayP * nightPct / 100, 'majoration');
  } else notes.push('Choisir le type de prestation pour calculer le prix.');
  // frais saisis au devis (absents de la grille) : jamais estimés
  if (crsN(f.secondDriver)) add('Second chauffeur / relais', 1, crsN(f.secondDriver), 'frais');
  if (crsN(f.driverHotel)) add('Hébergement du chauffeur' + (crsN(f.driverNights) ? ' (' + crsN(f.driverNights) + ' nuit(s))' : ''), 1, crsN(f.driverHotel), 'frais');
  if (crsN(f.driverMeals)) add('Repas du chauffeur', 1, crsN(f.driverMeals), 'frais');
  if (crsN(f.tolls)) add('Péages et parkings (non inclus au forfait)', 1, crsN(f.tolls), 'frais');
  (f.extrasPrice || []).forEach(x => { if (crsN(x.amount)) add(x.label, 1, crsN(x.amount), 'option'); });
  const gross = lines.reduce((s, l) => s + l.amount, 0);
  const pro = f.pro && crsN(G.proPct) ? Math.round(gross * crsN(G.proPct)) / 100 : 0;
  if (pro) lines.push({ label: 'Remise agences, DMC et entreprises (−' + G.proPct + ' % sur facture)', qty: 1, unit: -pro, amount: -pro, kind: 'remise' });
  const total = Math.round((gross - pro) * 100) / 100, vat = crsN(G.vat), ht = vat ? Math.round(total / (1 + vat / 100) * 100) / 100 : total;
  // acompte (grille) : courses intervilles (hors « En ville ») et mises à disposition de plusieurs jours
  const depOn = (base === 'interville' && !/^en ville/i.test(f.dest || '')) || (['heure', 'demi', 'journee', 'jours', 'special'].includes(base) && days > 1);
  const deposit = depOn ? Math.round(total * crsN(G.depositPct)) / 100 : 0;
  return { base, lines, total, ht, vat, tva: Math.round((total - ht) * 100) / 100, deposit, depositPct: depOn ? crsN(G.depositPct) : 0, included: inc,
    extraHour: extraH, extraKm, wait15: val(G.wait15, cat), notes };
}

/**
 * Contrôle par Geotab : trajets du véhicule pendant la mission, par jour (km, premier départ, dernier arrêt), comparés à ce qui est
 * inclus au devis. Amplitude mesurée = du premier départ au dernier arrêt du véhicule (l'attente avant le premier départ n'est pas vue).
 */
function crsActual(trips, f, price, dayOf, hmOf) {
  const by = {}, inc = (price && price.included) || {};
  (trips || []).forEach(t => {
    const s = new Date(t.start_at).getTime(), e = t.end_at ? new Date(t.end_at).getTime() : s, d = dayOf(s), o = by[d] = by[d] || { day: d, n: 0, km: 0, first: s, last: e, fuel: 0, fuelN: 0 };
    o.n++; o.km += crsN(t.km); if (s < o.first) o.first = s; if (e > o.last) o.last = e;
    if (t.fuel_l !== null && t.fuel_l !== undefined && t.fuel_l !== '') { o.fuel += crsN(t.fuel_l); o.fuelN++; }
  });
  const days = Object.values(by).sort((a, b) => a.day.localeCompare(b.day));
  days.forEach(o => { o.h = Math.round((o.last - o.first) / 36000) / 100; o.from = hmOf(o.first); o.to = hmOf(o.last);
    o.overH = inc.h ? Math.max(0, Math.ceil(o.h - inc.h - 1e-9)) : 0; o.overKm = inc.km ? Math.max(0, Math.round((o.km - inc.km) * 10) / 10) : 0; });
  const km = days.reduce((s, o) => s + o.km, 0), overH = days.reduce((s, o) => s + o.overH, 0), overKm = days.reduce((s, o) => s + o.overKm, 0);
  return { days, km: Math.round(km * 10) / 10, overH, overKm, amountH: overH * crsN(price && price.extraHour), amountKm: Math.round(overKm * crsN(price && price.extraKm) * 100) / 100 };
}

// ---------- 2. Page du site ----------
const CR = { grid: null, grids: [], gridErr: '', list: [], cur: null, f: null };
const CRS_SCRIPT = ['Quelles sont vos dates ?', 'Combien de passagers et de bagages ?', 'Quel véhicule souhaitez-vous ?', 'Quelles villes comptez-vous visiter ?',
  'À quoi ressemble une journée type ?', 'Combien d\'heures et de kilomètres prévoyez-vous par jour ?', 'Aurez-vous besoin du véhicule le soir ou la nuit ?',
  'Votre planning sera-t-il défini à l\'avance ou souhaitez-vous une disponibilité flexible ?'];
const CRS_LVL_CLS = { Standard: 'ok', Intensive: 'warn', '24h / VIP': 'crit' };
const CRS_ST_CLS = { Demande: '', 'Devis envoyé': 'warn', 'Accepté': 'warn', 'Acompte reçu': 'ok', 'Confirmée': 'ok', 'En cours': 'ok', 'Terminée': '', 'Facturée': '', 'Annulée': 'crit', 'Refusée': 'crit' };
/** Grille du jour d'une ville de départ (id de pricing_grid ; 1 = Casablanca) */
function crsGridOf(id) { return CR.grids.find(g => g._id === (+id || 1)) || CR.grid; }
/** Grille proposée par défaut : celle de l'agence choisie (ou de la seule agence), sinon Casablanca */
function crsGridDefault(agencyId) {
  const ag = +agencyId || (agFilter() ? +agFilter() : (S.agencies.length === 1 ? S.agencies[0].id : 0));
  return (ag && CR.grids.find(g => +g._agency === ag)) || CR.grid;
}
/** Grille d'une course : celle de sa date (gardée dans la course) si la ville de départ n'a pas changé, sinon la grille du jour */
function crsG() {
  const id = +(CR.f && CR.f.gridId) || 1, s = CR.cur && CR.cur.data && CR.cur.data.grid;
  return s && (+s._id || 1) === id ? s : crsGridOf(id);
}
function crsGridName(G) { return (G && (G._name || G.origin)) || 'Casablanca'; }
function crsCats() { return (CR.grid && CR.grid.cats) || []; }
function crsCatName(id) { const c = crsCats().find(x => x.id === id); return c ? c.model + ' (' + c.label + ')' : (id || ''); }
async function crsLoadGrid() {
  const r = await sb.from('pricing_grid').select('*').order('id');
  if (r.error) { CR.gridErr = r.error.message; CR.grid = null; CR.grids = []; return; }
  CR.gridErr = '';
  CR.grids = (r.data || []).map(x => Object.assign({}, x.data, { _id: x.id, _name: x.name || (x.data && x.data.origin) || (x.id === 1 ? 'Casablanca' : 'Grille ' + x.id), _agency: x.agency_id || null, _at: x.updated_at }));
  CR.grid = CR.grids.find(g => g._id === 1) || CR.grids[0] || null;
}
function crsTabs(t) {
  return `<div class="tabs">${[['', 'Demandes et devis'], ['planning', 'Planning des véhicules'], ['grille', 'Grille tarifaire']].map(x => `<a href="#/courses${x[0] ? '?t=' + x[0] : ''}" class="${t === x[0] ? 'on' : ''}">${x[1]}</a>`).join('')}</div>`;
}
async function pageCourses() {
  const q = qs(), my = ROUTING, t = q.get('t') || '';
  await crsLoadGrid();
  if (my !== ROUTING) return;
  const head = `<div class="head"><h1>Courses privées</h1><div class="sub">Mise à disposition avec chauffeur et courses privées : découverte client, devis selon la grille tarifaire, validation de l'exploitation, suivi jusqu'à la facture, contrôle réel par Geotab.</div></div>`;
  if (CR.gridErr) { $('#page').innerHTML = head + msg('Module pas encore installé dans la base : exécuter <b>supabase/migrations/20261031000000_courses.sql</b> dans Supabase &gt; SQL Editor. (' + esc(CR.gridErr) + ')', 'err'); return; }
  if (q.get('rapide')) return crsQuick(head);
  if (q.get('id') || q.get('new')) return crsEditor(q.get('id'), head);
  if (t === 'grille') return crsGridPage(head);
  CR.list = await all('missions', 'id,number,created_at,status,agency_id,client_name,client_company,kind,category,vehicle_key,start_at,end_at,level,needs_validation,validated_at,total_ttc,deposit', null, ['start_at', false]).catch(e => { CR.listErr = e.message; return []; });
  if (my !== ROUTING) return;
  if (t === 'planning') return crsPlanning(head);
  const fst = q.get('s') || 'actives', act = m => !['Terminée', 'Facturée', 'Annulée', 'Refusée'].includes(m.status);
  const list = CR.list.filter(m => fst === 'toutes' ? true : fst === 'actives' ? act(m) : m.status === fst);
  const n = s => CR.list.filter(m => m.status === s).length, toVal = CR.list.filter(m => m.needs_validation && !m.validated_at && act(m)).length;
  const draw = () => {   // page ou tri de la liste : redessinée avec les courses déjà lues
  $('#page').innerHTML = head + crsTabs('') + `
    ${cards([['À valider par l\'exploitation', f0(toVal), toVal ? 'warn' : ''], ['Demandes', f0(n('Demande'))], ['Devis envoyés', f0(n('Devis envoyé'))],
      ['Acceptés / acompte reçu', f0(n('Accepté') + n('Acompte reçu'))], ['Confirmées', f0(n('Confirmée'))], ['En cours', f0(n('En cours'))]])}
    <div class="bar">${canEdit() ? '<a class="btn" href="#/courses?rapide=1">⚡ Course rapide</a> <a class="btn ghostb" href="#/courses?new=1">+ Nouvelle demande (devis)</a>' : ''}
      <label>Statut <select id="crsf">${[['actives', 'En cours de traitement'], ['toutes', 'Toutes']].concat(CRS_STATUS.map(x => [x, x])).map(x => `<option value="${esc(x[0])}" ${x[0] === fst ? 'selected' : ''}>${esc(x[1])}</option>`).join('')}</select></label></div>
    ${table('tcrs', [['N°', m => `<a href="#/courses?id=${m.id}">${esc(m.number || '#' + m.id)}</a>`, m => m.number], ['Client', m => esc(m.client_name || '') + (m.client_company ? '<div class="small">' + esc(m.client_company) + '</div>' : '')],
      ['Prestation', m => esc(m.kind || '') + '<div class="small">' + esc(crsCatName(m.category)) + '</div>'], ['Début', m => fmtDTY(m.start_at), m => m.start_at || ''], ['Fin', m => fmtDTY(m.end_at), m => m.end_at || ''],
      ['Véhicule', m => m.vehicle_key ? plate((S.veh[m.vehicle_key] || {}).plate || m.vehicle_key) : '<span class="small">à affecter</span>'],
      ['Niveau', m => badge(m.level, CRS_LVL_CLS[m.level])], ['Statut', m => badge(m.status, CRS_ST_CLS[m.status]) + (m.needs_validation ? (m.validated_at ? ' <span class="small ok">validé</span>' : ' <span class="small crit">à valider</span>') : '')],
      ['Total TTC', m => m.total_ttc == null ? '' : crsMoney(m.total_ttc), m => m.total_ttc || 0, 'n']], list, { empty: CR.listErr ? 'Erreur : ' + esc(CR.listErr) : 'Aucune demande', page: true })}`;
  $('#crsf').onchange = e => { location.hash = '#/courses?s=' + encodeURIComponent(e.target.value); };
  };
  draw();
  window.__rerender = () => pageCourses(); window.__repage = draw;
}

// planning : véhicules × 14 jours, missions qui bloquent le véhicule (acompte reçu, confirmée, en cours)
function crsPlanning(head) {
  const q = qs(), from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : today(), days = [...Array(14).keys()].map(i => addDays(from, i));
  const ok = inAgency(), vs = S.vehList.filter(v => ok(v.key) && String(v.active || 'OUI').toUpperCase() !== 'NON');
  const live = CR.list.filter(m => !['Annulée', 'Refusée', 'Terminée', 'Facturée'].includes(m.status) && m.start_at);
  const on = (m, d) => { const b = dayBounds(d); return new Date(m.start_at) < b.end && new Date(m.end_at || m.start_at) >= b.start; };
  const cell = (k, d) => live.filter(m => (k ? m.vehicle_key === k : !m.vehicle_key) && on(m, d))
    .map(m => `<a href="#/courses?id=${m.id}" class="badge ${CRS_BLOCK.includes(m.status) ? 'ok' : 'warn'}" title="${esc((m.client_name || '') + ' · ' + m.status)}">${esc((m.number || '#' + m.id).replace(/^DEV-\d{4}-/, ''))}</a>`).join(' ');
  $('#page').innerHTML = head + crsTabs('planning') + `
    <div class="bar"><a class="btn small ghostb" href="#/courses?t=planning&d=${addDays(from, -7)}">← Semaine précédente</a><b>À partir du ${fmtDay(from)}</b><a class="btn small ghostb" href="#/courses?t=planning&d=${addDays(from, 7)}">Semaine suivante →</a></div>
    <div class="small">Vert : véhicule bloqué (acompte reçu, mission confirmée ou en cours). Orange : devis ou demande pas encore confirmés.</div>
    <div class="tw"><table class="plan"><thead><tr><th>Véhicule</th>${days.map(d => `<th class="${d === today() ? 'today' : ''}">${fmtDay(d).slice(0, 5)}</th>`).join('')}</tr></thead>
    <tbody>${vs.map(v => `<tr><td>${plate(v.plate)} <span class="small">${esc(v.model || '')}</span></td>${days.map(d => `<td>${cell(v.key, d)}</td>`).join('')}</tr>`).join('')}
    <tr><td><b>Sans véhicule affecté</b></td>${days.map(d => `<td>${cell('', d)}</td>`).join('')}</tr></tbody></table></div>`;
}

// ---------- fiche de découverte, devis, statuts ----------
function crsField(k, label, type, opt) {
  const f = CR.f, v = f[k] == null ? '' : f[k], o = opt || {}, ro = !CR.edit ? 'disabled' : '';
  if (type === 'check') return `<label class="chk"><input type="checkbox" data-f="${k}" ${v ? 'checked' : ''} ${ro}> ${label}</label>`;
  if (type === 'select') return `<label>${label} <select data-f="${k}" ${ro}>${o.empty !== false ? `<option value="">${esc(o.empty || '—')}</option>` : ''}${o.options.map(x => { const [val, txt] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(txt)}</option>`; }).join('')}</select></label>`;
  if (type === 'area') return `<label class="wide">${label} <textarea data-f="${k}" rows="${o.rows || 2}" ${ro} placeholder="${esc(o.ph || '')}">${esc(v)}</textarea></label>`;
  return `<label>${label} <input data-f="${k}" type="${type || 'text'}" value="${esc(v)}" ${o.size ? 'size="' + o.size + '"' : ''} ${o.step ? 'step="' + o.step + '"' : ''} ${o.min !== undefined ? 'min="' + o.min + '"' : ''} placeholder="${esc(o.ph || '')}" ${o.list ? 'list="' + o.list + '"' : ''} ${o.addr ? 'data-addr' : ''} ${ro}></label>`;
}
/** Villes de départ proposées (grilles du jour ; celle d'une course dont la grille a été retirée reste proposée) */
function crsGridOpts(cur) {
  const o = CR.grids.map(g => [String(g._id), crsGridName(g)]), id = String(+cur || 1);
  if (!o.some(x => x[0] === id)) { const s = CR.cur && CR.cur.data && CR.cur.data.grid; o.push([id, crsGridName(s) + ' (grille retirée)']); }
  return o;
}
function crsChecks(k, items) { const sel = CR.f[k] || []; return `<div class="crschk">${items.map(x => `<label class="chk"><input type="checkbox" data-fa="${k}" value="${esc(x)}" ${sel.includes(x) ? 'checked' : ''} ${CR.edit ? '' : 'disabled'}> ${esc(x)}</label>`).join('')}</div>`; }
function crsForm() {
  const f = CR.f, G = crsG() || {}, base = crsBase(f, G), tab = base === 'aeroport' ? G.airport : base === 'interville' ? G.intercity : null;
  const vs = S.vehList.filter(v => String(v.active || 'OUI').toUpperCase() !== 'NON');
  return `
  <details class="panel" open><summary><h2>1. Client</h2></summary><div class="mfrow">
    ${crsField('client', 'Nom et prénom', 'text', { size: 26 })}${crsField('company', 'Société, agence ou hôtel', 'text', { size: 24 })}${crsField('nationality', 'Nationalité du client final', 'text', { size: 14 })}
    ${crsField('phone', 'Téléphone', 'tel', { size: 15 })}${crsField('email', 'E-mail', 'email', { size: 24 })}
    ${crsField('clientType', 'Type de client', 'select', { options: ['Particulier', 'Professionnel', 'Agence / DMC', 'Hôtel'] })}
    ${crsField('ice', 'ICE (professionnel)', 'text', { size: 16 })}${crsField('billing', 'Adresse de facturation', 'text', { size: 30 })}${crsField('prescriber', 'Prescripteur / intermédiaire', 'text', { size: 20 })}
    ${crsField('service', 'Niveau de service', 'select', { options: CRS_LEVELS })}${crsField('lang', 'Langue du chauffeur', 'select', { options: ['Français', 'Anglais', 'Arabe', 'Espagnol', 'Autre'] })}
    ${crsField('pro', 'Remise agences, DMC et entreprises (' + (G.proPct || 0) + ' % sur facture)', 'check')}</div></details>
  <details class="panel" open><summary><h2>2. Prestation</h2></summary>
    <div class="small"><b>Question centrale :</b> le client souhaite-t-il réserver des trajets définis ou disposer librement du véhicule et du chauffeur ? Une mise à disposition bloque le véhicule, même quand il ne roule pas.</div>
    <div class="mfrow">${CR.grids.length > 1 || (+f.gridId || 1) !== 1 ? crsField('gridId', 'Ville de départ (grille tarifaire)', 'select', { empty: false, options: crsGridOpts(f.gridId) }) : ''}
    ${crsField('kind', 'Type de prestation', 'select', { options: CRS_KINDS.map(x => x[0]) })}
    ${crsField('base', 'Formule tarifaire', 'select', { empty: 'Automatique : ' + (CRS_BASES[crsBase(Object.assign({}, f, { base: '' }), G)] || '—'), options: Object.keys(CRS_BASES).map(k => [k, CRS_BASES[k]]) })}
    ${base === 'convenu' ? crsField('agreedPrice', 'Prix convenu (MAD TTC)', 'number', { min: 0 }) : ''}
    ${tab ? crsField('dest', base === 'aeroport' ? 'Destination (depuis / vers l\'' + crsAirport(G) + ')' : 'Destination depuis ' + crsOrigin(G), 'select', { options: tab.map(r => r.dest) }) : ''}
    ${tab ? crsField('roundTrip', 'Aller-retour', 'check') + (!f.roundTrip ? crsField('returnEmpty', 'Course retour : sens du retour, le véhicule rentrerait à vide (−' + (G.returnPct || 0) + ' %)', 'check') : '') : ''}
    ${crsField('dispo', 'Niveau de disponibilité', 'select', { options: CRS_DISPO })}${crsField('planning', 'Planning', 'select', { options: [['oui', 'Confirmé'], ['partiel', 'Approximatif'], ['non', 'Non défini']] })}
    ${crsField('changes', 'Changements de dernière minute probables', 'check')}${crsField('flatOrReal', 'Facturation', 'select', { options: ['Prix forfaitaire', 'Selon l\'utilisation réelle'] })}</div></details>
  <details class="panel" open><summary><h2>3. Dates et horaires</h2></summary><div class="mfrow">
    ${crsField('startDate', 'Date de début', 'date')}${crsField('startTime', 'Heure de prise en charge', 'time')}${crsField('endDate', 'Date de fin', 'date')}${crsField('endTime', 'Heure de fin le dernier jour', 'time')}
    ${tab ? '' : crsField('dayStart', 'Début habituel de la journée', 'time') + crsField('dayEnd', 'Fin habituelle', 'time') + crsField('hoursDay', 'Heures d\'utilisation par jour', 'number', { min: 0, step: 0.5 })}
    ${crsField('night', tab ? 'Trajet de nuit (' + (G.nightFrom || 22) + 'h–' + (G.nightTo || 6) + 'h)' + (f.roundTrip ? ', aller' : '') : 'Utilisation de nuit (' + (G.nightFrom || 22) + 'h–' + (G.nightTo || 6) + 'h)', 'check')}
    ${tab && f.roundTrip ? crsField('nightReturn', 'Retour de nuit', 'check') : ''}${crsField('holiday', 'Jour férié', 'check')}
    ${tab ? '' : crsField('nightDays', 'Jours avec nuit ou jour férié (majoration)', 'number', { min: 0 }) + crsField('afterMidnight', 'Disponibilité après minuit', 'check') + crsField('h24', 'Disponibilité 24 h/24 (relais de chauffeurs)', 'check') + crsField('weekends', 'Week-ends inclus', 'check')}
    ${crsField('waitMin', 'Attente prévue (min)', 'number', { min: 0, step: 5 })}
    ${crsField('dayPlan', 'Journée type / planning jour par jour', 'area', { rows: 3, ph: '« Pouvez-vous me décrire une journée type avec le véhicule ? »' })}</div>
    <div class="small" id="crsamp"></div></details>
  <details class="panel" open><summary><h2>4. Kilométrage et itinéraire</h2></summary><div class="mfrow">
    ${tab ? '' : crsField('kmDay', 'Km estimés par jour', 'number', { min: 0 }) + crsField('kmCat', 'Estimation du client', 'select', { options: CRS_KM }) + crsField('kmUnlimited', 'Kilométrage illimité demandé', 'check')}
    ${crsField('startCity', 'Ville de prise en charge', 'text', { list: 'crscity', size: 16 })}${crsField('startAddr', 'Hôtel ou adresse de départ', 'text', { size: 30, addr: 1 })}
    ${crsField('endCity', 'Ville de fin', 'text', { list: 'crscity', size: 16 })}${crsField('endAddr', 'Adresse ou hôtel de fin', 'text', { size: 30, addr: 1 })}
    ${crsField('backEvening', 'Le véhicule revient chaque soir à son point de départ', 'check')}${crsField('international', 'Déplacement international', 'check')}</div>
    <datalist id="crscity">${CRS_CITIES.map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>
    <div class="small">Villes visitées :</div>${crsChecks('cities', CRS_CITIES)}
    <div class="mfrow">${crsField('itinerary', 'Itinéraire prévisionnel (nuits dans chaque ville, aéroports, gares, zones rurales, trajets à vide…)', 'area', { rows: 3 })}</div></details>
  <details class="panel" open><summary><h2>5. Véhicule</h2></summary><div class="mfrow">
    ${crsField('cat', 'Catégorie (grille)', 'select', { options: crsCats().map(c => [c.id, c.model + ' — ' + c.label]) })}${crsField('nVeh', 'Nombre de véhicules', 'number', { min: 1 })}
    ${crsField('pax', 'Passagers', 'number', { min: 1 })}${crsField('bags', 'Bagages (nombre et volume)', 'text', { size: 18 })}
    ${crsField('vehicleKey', 'Véhicule affecté (bloqué à la confirmation)', 'select', { empty: 'À affecter', options: vs.filter(v => !f.cat || String(v.model || '').toUpperCase().indexOf(f.cat) >= 0).map(v => [v.key, v.plate + (v.model ? ' · ' + v.model : '')]) })}
    ${crsField('childSeat', 'Siège enfant', 'check')}${crsField('replacement', 'Véhicule de remplacement identique demandé', 'check')}${crsField('vehNotes', 'Exigences (couleur, standing, équipements)', 'text', { size: 30 })}</div>
    <div id="crsvinfo" class="small"></div></details>
  <details class="panel" open><summary><h2>6. Chauffeur et frais</h2></summary><div class="mfrow">
    ${crsField('drivers', 'Nombre de chauffeurs', 'number', { min: 1 })}${crsField('driverName', 'Chauffeur prévu', 'text', { list: 'crsdrv', size: 22 })}${crsField('driverPhone', 'Téléphone du chauffeur', 'tel', { size: 15, ph: 'contrat en cours sinon' })}
    <datalist id="crsdrv">${Object.keys(S.drv || {}).filter(c => c !== HORS).map(c => `<option value="${esc(S.drv[c])}"></option>`).join('')}</datalist>
    ${crsField('dress', 'Tenue particulière', 'text', { size: 16 })}${crsField('driverNights', 'Nuits du chauffeur à l\'extérieur', 'number', { min: 0 })}
    ${crsField('hotelBy', 'Hôtel du chauffeur pris en charge par', 'select', { options: ['Le client', 'Luxury & Discovery (refacturé avec marge)', 'Sans objet'] })}
    ${crsField('mealsBy', 'Repas du chauffeur pris en charge par', 'select', { options: ['Le client', 'Luxury & Discovery (refacturé)', 'Sans objet'] })}</div>
    <div class="small">Montants hors grille (devis) : saisis ici, jamais estimés. Si l'hébergement est organisé par Luxury & Discovery, intégrer la marge de gestion.</div>
    <div class="mfrow">${crsField('secondDriver', 'Second chauffeur / relais (MAD)', 'number', { min: 0 })}${crsField('driverHotel', 'Hébergement chauffeur (MAD)', 'number', { min: 0 })}
    ${crsField('driverMeals', 'Repas chauffeur (MAD)', 'number', { min: 0 })}${crsField('tolls', 'Péages / parkings hors forfait (MAD)', 'number', { min: 0 })}
    ${base === 'special' ? crsField('dayPrice', 'Prix journalier fixé par la direction (MAD TTC)', 'number', { min: 0 }) : ''}</div></details>
  <details class="panel"><summary><h2>7. Prestations complémentaires</h2></summary>${crsChecks('extras', CRS_EXTRAS)}
    <div class="small">Chiffrées séparément lorsqu'elles génèrent un coût :</div><div class="mfrow">${(f.extras || []).map(x => `<label>${esc(x)} (MAD) <input type="number" min="0" data-fx="${esc(x)}" value="${esc(((f.extrasPrice || []).find(y => y.label === x) || {}).amount || '')}" ${CR.edit ? '' : 'disabled'}></label>`).join('')}</div></details>
  <details class="panel"><summary><h2>8. Risque et remarques</h2></summary><div class="mfrow">
    ${crsField('riskNote', 'Risque commercial à signaler (validation exploitation)', 'text', { size: 40 })}${crsField('validDays', 'Validité du devis (jours)', 'number', { min: 1 })}
    ${crsField('notes', 'Remarques internes (non imprimées)', 'area', { rows: 2 })}${crsField('quoteNotes', 'Remarques imprimées sur le devis', 'area', { rows: 2 })}</div></details>
  <details class="panel" open><summary><h2>9. Manifeste (créé automatiquement à la confirmation)</h2></summary><div class="mfrow">
    ${crsField('mfType', 'Client', 'select', { empty: false, options: ['Résident', 'Non résident'] })}
    ${f.mfType === 'Non résident' ? '' : crsField('cin', 'N° CIN ou passeport du client', 'text', { size: 14 })}
    ${f.mfType === 'Non résident' ? '' : crsField('paxNames', 'Autres passagers (un nom par ligne ; le client est le passager 1)', 'area', { rows: 3 })}
    ${crsField('flight', 'N° de vol / observations', 'text', { size: 24 })}</div>
    <div class="small">Le manifeste reprend le véhicule, le chauffeur (contrat en cours sinon chauffeur prévu), le client, les adresses de départ et de fin, la date et le nombre de passagers.</div></details>`;
}
function crsRead() {
  const f = CR.f;
  document.querySelectorAll('[data-f]').forEach(i => { const k = i.dataset.f; f[k] = i.type === 'checkbox' ? i.checked : i.value; });
  const arr = {}; document.querySelectorAll('[data-fa]').forEach(i => { (arr[i.dataset.fa] = arr[i.dataset.fa] || []); if (i.checked) arr[i.dataset.fa].push(i.value); });
  Object.keys(arr).forEach(k => { f[k] = arr[k]; });
  const xp = []; document.querySelectorAll('[data-fx]').forEach(i => { if (i.value !== '') xp.push({ label: i.dataset.fx, amount: crsN(i.value) }); });
  f.extrasPrice = xp.filter(x => (f.extras || []).includes(x.label));
  return f;
}
function crsTimes(f) {
  const d0 = f.startDate, d1 = f.endDate || f.startDate;
  const a = d0 ? parseLocalDT(d0 + ' ' + (f.startTime || f.dayStart || '00:00')) : null;
  let b = d1 ? parseLocalDT(d1 + ' ' + (f.endTime || f.dayEnd || '23:59')) : null;
  if (a && b && b <= a) b = new Date(a.getTime() + Math.max(1, crsHoursDay(f) || 1) * HOUR);
  return { a, b };
}
function crsSide() {
  const f = CR.f, G = crsG() || {}, m = CR.cur || {}, p = crsPrice(f, G), lv = crsLevel(f), val = crsValidation(f, p.total, G), miss = crsMissing(f, G);
  const amp = $('#crsamp'); if (amp) amp.textContent = crsAmplitude(f) ? 'Formule selon l\'amplitude : ' + crsAmplitude(f) + (f.h24 ? ' : au minimum deux chauffeurs en rotation, temps de repos organisés, majoration de mobilisation permanente.' : '') : '';
  const vi = $('#crsvinfo'); if (vi) vi.innerHTML = crsSeatsOk(f, G) ? '' : '<span class="crit">Trop de passagers pour la catégorie choisie : ' + esc(crsCatName(f.cat)) + '.</span>';
  const validated = !!m.validated_at, needVal = val.length > 0;
  const st = m.status || 'Demande', fin = ['Terminée', 'Facturée', 'Annulée', 'Refusée'].includes(st);
  const nexts = { Demande: ['Devis envoyé'], 'Devis envoyé': ['Accepté', 'Refusée'], 'Accepté': p.deposit ? ['Acompte reçu'] : ['Confirmée'], 'Acompte reçu': ['Confirmée'], 'Confirmée': ['En cours'], 'En cours': ['Terminée'], 'Terminée': ['Facturée'] }[st] || [];
  const inc = p.included || {};
  $('#crsside').innerHTML = `
    <div class="panel"><h2>Classement</h2>
      <div>${badge(lv.level === '24h / VIP' ? '🔴 24h / VIP' : lv.level === 'Intensive' ? '🟠 Intensive' : '🟢 Standard', CRS_LVL_CLS[lv.level])} <span class="small">${esc(lv.why.join(' · '))}</span></div>
      <div class="small">${esc(lv.level === 'Standard' ? '→ Tarif forfaitaire standard.' : lv.level === 'Intensive' ? '→ Tarif renforcé + frais associés.' : '→ Véhicule dédié + rotation de chauffeurs + tarification spécifique.')}</div>
      ${crsAmplitude(f) ? `<div class="small">Amplitude : <b>${esc(crsAmplitude(f))}</b></div>` : ''}
      ${needVal ? `<div class="msg ${validated ? 'ok' : 'warn'}"><b>${validated ? 'Validé par l\'exploitation' : 'Validation de l\'exploitation obligatoire avant d\'envoyer le prix'}</b><br>${val.map(esc).join(' · ')}</div>` : '<div class="small ok">Pas de validation de l\'exploitation nécessaire.</div>'}
      ${miss.length ? `<div class="msg warn"><b>À préciser avant d'envoyer un prix</b> : ${miss.map(esc).join(', ')}.</div>` : ''}</div>
    <div class="panel"><h2>Prix (grille ${esc(G.valid || '')}, TTC)</h2>
      ${p.lines.length ? `<table class="crslines"><tbody>${p.lines.map(l => `<tr><td>${esc(l.label)}${l.qty !== 1 ? `<div class="small">${esc(String(l.qty))} × ${crsMoney(l.unit)}</div>` : ''}</td><td class="n">${crsMoney(l.amount)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th>Total TTC</th><th class="n">${crsMoney(p.total)}</th></tr><tr><td class="small">dont TVA ${p.vat} %</td><td class="n small">${crsMoney(p.tva)}</td></tr><tr><td class="small">Total HT</td><td class="n small">${crsMoney(p.ht)}</td></tr>
        ${p.deposit ? `<tr><td>Acompte à la réservation (${p.depositPct} %)</td><td class="n">${crsMoney(p.deposit)}</td></tr>` : ''}</tfoot></table>` : '<div class="empty">Choisir la prestation, le véhicule et les dates.</div>'}
      ${p.notes.map(n => msg(esc(n), 'warn')).join('')}
      <div class="small">${inc.h || inc.km ? 'Inclus : ' + [inc.h ? inc.h + ' h / jour' : '', inc.km ? inc.km + ' km / jour' : ''].filter(Boolean).join(' · ') + '. ' : ''}Au-delà : ${crsMoney(p.extraHour)} / heure commencée · ${crsMoney(p.extraKm)} / km · attente ${crsMoney(p.wait15)} / 15 min.</div></div>
    <div class="panel"><h2>Statut : ${badge(st, CRS_ST_CLS[st])}</h2>
      ${m.number ? `<div class="small">Devis ${esc(m.number)}${m.created_at ? ' · créé le ' + fmtDTY(m.created_at) : ''}</div>` : '<div class="small">Pas encore enregistré.</div>'}
      <div class="mfgo">${CR.edit ? '<button id="crssave">Enregistrer</button>' : ''} <button class="ghost" id="crspdf" ${p.lines.length ? '' : 'disabled'}>Devis PDF</button>
        ${CR.edit && m.id ? `<button class="ghost" id="crswa">WhatsApp</button><button class="ghost" id="crsmail">Envoyer par e-mail (PDF joint)</button>` : ''}</div>
      <div id="crsmailbox"></div>
      ${CR.edit && m.id && !fin ? `<div class="mfgo">${nexts.map(x => `<button class="small" data-crst="${esc(x)}">${esc(x === 'Devis envoyé' ? 'Devis envoyé au client' : x === 'Confirmée' ? 'Confirmer (bloque le véhicule)' : x)}</button>`).join(' ')}
        <button class="small ghost" data-crst="Annulée">Annuler</button></div>` : ''}
      ${isAdmin() && m.id && needVal && !validated && !fin ? '<div class="mfgo"><button class="small" id="crsval">Valider (exploitation)</button></div>' : ''}
      <div id="crsres" class="small"></div>
      ${(m.data && m.data.history || []).length ? `<div class="small">${m.data.history.slice(-6).reverse().map(h => esc(fmtDTY(h.at) + ' · ' + h.status + (h.by ? ' · ' + h.by : ''))).join('<br>')}</div>` : ''}</div>
    <details class="panel"><summary><h2>Script d'appel (8 questions)</h2></summary><ol class="small">${CRS_SCRIPT.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
      <div class="small"><i>Question clé : « Pouvez-vous me décrire une journée type avec le véhicule ? »</i><br>Règle : pas de prix « X MAD/jour » sans heures incluses, kilomètres inclus, zone d'utilisation et conditions de dépassement.</div></details>
    <div class="panel" id="crsmf" hidden></div>
    <div id="crsgeo"></div>`;
  crsBindSide(p, val, miss);
  crsMailBox(); crsMfRender();
  return p;
}
async function crsEditor(id, head) {
  const my = ROUTING; CR.edit = canEdit(); CR.mailOpen = false; CR.mailRes = ''; CR.mfRes = ''; CR.mailTo = '';
  if (typeof addrSetPlaces === 'function') addrSetPlaces(MANIF_PLACES);
  if (id) {
    const r = await sb.from('missions').select('*').eq('id', id).maybeSingle();
    if (my !== ROUTING) return;
    if (r.error || !r.data) { $('#page').innerHTML = head + msg('Demande introuvable' + (r.error ? ' : ' + esc(r.error.message) : '') + '.', 'err'); return; }
    CR.cur = r.data; CR.f = Object.assign({}, (r.data.data && r.data.data.f) || {});
  } else {
    CR.cur = null;
    const G0 = crsGridDefault();
    CR.f = { gridId: (G0 && G0._id) || 1, kind: '', cat: (crsCats()[0] || {}).id || '', nVeh: 1, drivers: 1, pax: 1, service: 'Standard', clientType: 'Particulier', dispo: 'Disponibilité planifiée', planning: 'oui', startCity: crsOrigin(G0), validDays: 7, startDate: today(), cities: [], extras: [] };
  }
  const m = CR.cur || {};
  $('#page').innerHTML = head + crsTabs('') + `<div class="bar"><a href="#/courses">← Toutes les demandes</a> <b>${esc(m.number || 'Nouvelle demande')}</b>${m.client_name ? ' · ' + esc(m.client_name) : ''}</div>
    ${CR.edit ? '' : msg('Lecture seule : les devis sont faits par les gestionnaires et l\'administrateur.', 'warn')}
    <div class="crsgrid"><div id="crsform">${crsForm()}</div><div id="crsside"></div></div>`;
  const rerenderForm = () => { const open = [...document.querySelectorAll('#crsform details')].map(d => d.open); $('#crsform').innerHTML = crsForm(); document.querySelectorAll('#crsform details').forEach((d, i) => { if (open[i] !== undefined) d.open = open[i]; }); };
  $('#crsform').addEventListener('input', () => { crsRead(); crsSide(); });
  // champs qui changent le formulaire lui-même (type, formule, aller-retour, catégorie, prestations) : formulaire redessiné
  let origin = crsOrigin(crsG());
  $('#crsform').addEventListener('change', e => { const k = e.target.dataset.f || e.target.dataset.fa; crsRead();
    if (k === 'gridId') { const o = crsOrigin(crsG()); if (!CR.f.startCity || CR.f.startCity === origin) CR.f.startCity = o; origin = o; }   // ville de prise en charge suivie
    if (['gridId', 'kind', 'base', 'roundTrip', 'cat', 'extras', 'clientType', 'mfType'].includes(k)) { if (k === 'clientType') CR.f.pro = CR.f.clientType !== 'Particulier'; if (k === 'kind' && CR.f.kind === 'Aller-retour') { CR.f.roundTrip = true; CR.f.returnEmpty = false; } rerenderForm(); } crsSide(); });
  crsSide();
  crsGeotab();
}
function crsRow(f, p) {
  const t = crsTimes(f), lv = crsLevel(f), val = crsValidation(f, p.total, crsG());
  const v = f.vehicleKey ? S.veh[f.vehicleKey] : null;
  return { client_name: f.client || null, client_company: f.company || null, client_phone: f.phone || null, client_email: f.email || null, kind: f.kind || null, category: f.cat || null,
    vehicle_key: f.vehicleKey || null, driver_name: f.driverName || null, start_at: t.a ? t.a.toISOString() : null, end_at: t.b ? t.b.toISOString() : null,
    level: lv.level, needs_validation: val.length > 0, total_ttc: p.lines.length ? p.total : null, deposit: p.deposit || null,
    agency_id: v && v.agency_id ? v.agency_id : (CR.cur && CR.cur.agency_id) || (agFilter() ? +agFilter() : (S.agencies.length === 1 ? S.agencies[0].id : null)) };
}
async function crsSave(status) {
  const G = crsG(), f = crsRead(), p = crsPrice(f, G), m = CR.cur, row = crsRow(f, p), out = $('#crsres');
  const hist = ((m && m.data && m.data.history) || []).slice();
  if (status) hist.push({ at: new Date().toISOString(), status, by: S.profile.email || '' });
  row.data = Object.assign({}, m && m.data, { f, price: p, history: hist, grid: G || null });   // grille du devis gardée : prix de sa date
  if (status) row.status = status;
  out.textContent = 'Enregistrement…';
  const r = m ? await sb.from('missions').update(row).eq('id', m.id).select('*').single() : await sb.from('missions').insert(Object.assign(row, { status: 'Demande', data: Object.assign(row.data, { history: [{ at: new Date().toISOString(), status: 'Demande', by: S.profile.email || '' }] }) })).select('*').single();
  if (r.error) { out.innerHTML = '<span class="err">Non enregistré : ' + esc(r.error.message) + '</span>'; return null; }
  CR.cur = r.data;
  if (!m) { history.replaceState(null, '', '#/courses?id=' + r.data.id); }
  crsSide(); crsGeotab();
  $('#crsres').innerHTML = '<span class="ok">Enregistré' + (status ? ' : ' + esc(status) : '') + '.</span>';
  return r.data;
}
/** Véhicule déjà bloqué par une autre mission sur la période ? */
async function crsConflicts(m) {
  if (!m.vehicle_key || !m.start_at) return [];
  const rows = await all('missions', 'id,number,status,start_at,end_at,client_name', q => q.eq('vehicle_key', m.vehicle_key).in('status', CRS_BLOCK).lt('start_at', m.end_at || m.start_at));
  return rows.filter(x => x.id !== m.id && new Date(x.end_at || x.start_at) > new Date(m.start_at));
}
function crsBindSide(p, val, miss) {
  const sv = $('#crssave'); if (sv) sv.onclick = () => crsSave();
  const pdf = $('#crspdf'); if (pdf) pdf.onclick = () => { try { crsPdf(CR.cur || {}, crsRead(), p, crsG()); } catch (e) { alert(e.message); } };
  document.querySelectorAll('[data-crst]').forEach(b => { b.onclick = async () => {
    const to = b.dataset.crst, f = crsRead(), m = CR.cur;
    if (to === 'Devis envoyé' && miss.length) { alert('À préciser avant d\'envoyer un prix : ' + miss.join(', ') + '.'); return; }
    if (['Devis envoyé', 'Accepté', 'Acompte reçu', 'Confirmée'].includes(to) && val.length && !m.validated_at) { alert('Validation de l\'exploitation obligatoire (' + val.join(', ') + ').' + (isAdmin() ? ' Cliquez « Valider (exploitation) ».' : ' L\'administrateur doit valider.')); return; }
    if (to === 'Confirmée' || to === 'Acompte reçu') {
      if (!f.vehicleKey) { alert('Affecter un véhicule avant de le bloquer pour la mission.'); return; }
      const c = await crsConflicts(Object.assign({}, m, crsRow(f, p)));
      if (c.length) { alert('Véhicule déjà bloqué sur cette période : ' + c.map(x => (x.number || '#' + x.id) + ' (' + (x.client_name || '') + ', ' + x.status + ')').join(' ; ')); return; }
    }
    if ((to === 'Annulée' || to === 'Refusée') && !confirm('Passer la demande en « ' + to + ' » ?')) return;
    const saved = await crsSave(to);
    if (saved && ['Confirmée', 'En cours'].includes(to) && !(saved.data && saved.data.manifest)) crsManifest(true);   // manifeste automatique
  }; });
  const vb = $('#crsval'); if (vb) vb.onclick = async () => {
    const m = CR.cur, r = await sb.from('missions').update({ validated_at: new Date().toISOString(), validated_by: S.session.user.id }).eq('id', m.id).select('*').single();
    if (r.error) { alert(r.error.message); return; }
    CR.cur = r.data; crsSide();
  };
  const msgTxt = () => crsQuoteText(p);
  const wa = $('#crswa'); if (wa) wa.onclick = () => {
    if (miss.length) { alert('À préciser avant d\'envoyer un prix : ' + miss.join(', ') + '.'); return; }
    if (val.length && !(CR.cur && CR.cur.validated_at)) { alert('Validation de l\'exploitation obligatoire avant d\'envoyer le prix (' + val.join(', ') + ').'); return; }
    const n = typeof manifWa === 'function' ? manifWa(CR.f.phone) : ''; const u = 'https://wa.me/' + n + '?text=' + encodeURIComponent(msgTxt()); if (!openOut(u)) window.open(u, '_blank', 'noopener'); };
  const ml = $('#crsmail'); if (ml) ml.onclick = () => { CR.mailOpen = true; CR.mailRes = ''; CR.mailTo = CR.f.email || CR.mailTo || ''; crsMailBox(); const i = $('#crsmto'); if (i) i.focus(); };
}
/** Résumé du devis (WhatsApp, corps de l'e-mail) */
function crsQuoteText(p) {
  const f = CR.f, m = CR.cur || {}, inc = p.included || {}, t = crsTimes(f);
  return ['Ludy · Devis ' + (m.number || ''), (f.kind || '') + ' · ' + crsCatName(f.cat), t.a ? 'Du ' + fmtDTY(t.a) + (t.b ? ' au ' + fmtDTY(t.b) : '') : '',
    [f.startAddr || f.startCity, f.endAddr || f.endCity || f.dest].filter(Boolean).length > 1 ? 'Trajet : ' + [f.startAddr || f.startCity, f.endAddr || f.endCity || f.dest].filter(Boolean).join(' → ') : '',
    inc.h || inc.km ? 'Inclus : ' + [inc.h ? inc.h + ' h/jour' : '', inc.km ? inc.km + ' km/jour' : ''].filter(Boolean).join(', ') : '',
    'Total : ' + crsMoney(p.total) + ' TTC' + (p.deposit ? ' · acompte ' + crsMoney(p.deposit) : ''), 'Au-delà : ' + crsMoney(p.extraHour) + ' / heure, ' + crsMoney(p.extraKm) + ' / km',
    'Devis détaillé en PDF joint.'].filter(Boolean).join('\n');
}

// ---------- devis envoyé par Ludy (PDF joint, expéditeur réglé dans Réglages > E-mails aux clients) ----------
function crsMailBox() {
  const box = $('#crsmailbox'); if (!box) return;
  if (!CR.mailOpen) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="mfrow"><label>Envoyer le devis à <input id="crsmto" type="text" inputmode="email" value="${esc(CR.mailTo || '')}" placeholder="client@exemple.com" size="28"></label>
    <button class="small" id="crsmgo">Envoyer</button><button class="ghost small" id="crsmx">Fermer</button></div>
    <div class="small">Envoyé par Ludy avec le devis en PDF joint (expéditeur : Réglages &gt; E-mails aux clients).</div><div id="crsmres">${CR.mailRes || ''}</div>`;
  $('#crsmto').oninput = e => { CR.mailTo = e.target.value; };
  $('#crsmx').onclick = () => { CR.mailOpen = false; CR.mailRes = ''; crsMailBox(); };
  $('#crsmgo').onclick = () => crsSendQuote();
}
async function crsSendQuote() {
  const G = crsG() || {}, say = (h, cls) => { CR.mailRes = msg(h, cls); const o = $('#crsmres'); if (o) o.innerHTML = CR.mailRes; };
  const list = String(CR.mailTo || '').split(/[,;\s]+/).filter(Boolean);
  let f = crsRead(), p = crsPrice(f, G);
  if (!CR.cur || !CR.cur.id) { say('Enregistrer la demande avant d\'envoyer le devis.', 'err'); return; }
  if (!list.length || list.length > 10 || list.some(x => !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x))) { say('Adresse e-mail invalide.', 'err'); return; }
  const miss = crsMissing(f, G), val = crsValidation(f, p.total, G);
  if (!p.lines.length || !p.total) { say('Pas de prix à envoyer.', 'err'); return; }
  if (miss.length) { say('À préciser avant d\'envoyer un prix : ' + esc(miss.join(', ')) + '.', 'err'); return; }
  if (val.length && !CR.cur.validated_at) { say('Validation de l\'exploitation obligatoire avant d\'envoyer le prix (' + esc(val.join(', ')) + ').', 'err'); return; }
  const btn = $('#crsmgo'); if (btn) btn.disabled = true;
  say('Préparation du devis…');
  try {
    const sv = await crsSave(); if (!sv) throw new Error('fiche non enregistrée');   // devis envoyé = fiche enregistrée
    f = CR.f; p = crsPrice(f, G);
    // prix changé à l'enregistrement : la base a pu retirer la validation, contrôlée à nouveau sur la fiche enregistrée
    if (sv.needs_validation && !sv.validated_at) throw new Error('validation de l\'exploitation obligatoire avant d\'envoyer ce prix (' + crsValidation(f, p.total, G).join(', ') + ')');
    const m = CR.cur, doc = crsPdf(m, f, p, G, true), blob = doc.output('blob'), name = crsPdfName(m, f);
    const path = today().slice(0, 7) + '/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)) + '.pdf';
    const up = await sb.storage.from('devis').upload(path, blob, { contentType: 'application/pdf', upsert: false });
    if (up.error) throw new Error(/bucket/i.test(up.error.message || '') ? 'stockage des devis pas encore installé : exécuter supabase/migrations/20261102000000_devis_mail.sql (' + up.error.message + ')' : up.error.message);
    const { data, error } = await sb.from('jobs').insert({ kind: 'quote_mail', arg: JSON.stringify({ id: m.id, to: list.join(','), path, name, subject: 'Devis Ludy ' + (m.number || ''), body: crsQuoteText(p) }) }).select('id').single();
    if (error) throw new Error(/row-level|policy/i.test(error.message) ? 'envoi non autorisé (exécuter supabase/migrations/20261102000000_devis_mail.sql) : ' + error.message : error.message);
    if (CR.cur.status === 'Demande') await crsSave('Devis envoyé');
    say('Envoi demandé à ' + esc(list.join(', ')) + ' : Ludy l\'envoie dans les 5 minutes avec le devis en PDF joint.', 'ok');
    const t0 = Date.now(), my = ROUTING, id = m.id, poll = async () => {
      if (my !== ROUTING || !CR.cur || CR.cur.id !== id || Date.now() - t0 > 8 * 60000) return;
      const r = await sb.from('jobs').select('done_at,result').eq('id', data.id).maybeSingle();
      if (r.data && r.data.done_at) { say(esc(r.data.result || 'Envoyé'), /^Erreur/.test(r.data.result || '') ? 'err' : 'ok'); return; }
      setTimeout(poll, 20000);
    };
    setTimeout(poll, 20000);
  } catch (e) { say('Envoi impossible : ' + esc(e.message || e), 'err'); }
  if ($('#crsmgo')) $('#crsmgo').disabled = false;
}

// ---------- manifeste de la course (automatique à la confirmation) ----------
function crsLocalDT(d) { const p = parts(d); return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute; }
/** Brouillon du manifeste repris de la course : véhicule, départ, chauffeur, client, passagers, adresses */
function crsMfDraft(m, f) {
  const a = m.start_at ? new Date(m.start_at) : null, b = m.end_at ? new Date(m.end_at) : null;
  const dep = a ? crsLocalDT(a) : '', ret = b && a && crsLocalDT(b).slice(0, 10) !== dep.slice(0, 10) ? crsLocalDT(b).slice(0, 10) : '';
  const kind = f.kind || '', base = crsBase(f, crsG() || {});
  const pre = kind === 'Transfert aéroport' ? 'Transfert aéroport' : kind === 'Circuit touristique' ? 'Circuit' : base === 'interville' || base === 'aeroport' || base === 'convenu' ? 'Transfert' : 'Mise à disposition';
  const G = crsG() || {}, terminus = f.endAddr || f.endCity || (base === 'aeroport' ? 'A' + crsAirport(G).slice(1) + ', ' + crsOrigin(G) : f.dest) || '';
  return { type: f.mfType === 'Non résident' ? 'non' : 'resident', vehicle: m.vehicle_key || '', remplacement: '', dateDep: dep, dateRet: ret,
    chauffeur: String(f.driverName || m.driver_name || '').trim(), chauffeurTel: String(f.driverPhone || '').trim(), donneur: String(f.client || m.client_name || '').trim(),
    cin: f.cin || '', nb: Math.max(1, crsN(f.pax) || 1), passengers: String(f.paxNames || '').split(/\n|;/).map(x => x.trim()).filter(Boolean), donneurVoyage: true,
    depart: String(f.startAddr || f.startCity || '').trim(), terminus: String(terminus).trim(), prestation: pre, nature: pre === 'Mise à disposition' ? 'Mise à disposition' : 'Transfert',
    obs: [f.flight, m.number ? 'Course ' + m.number : ''].filter(Boolean).join(' · ') };
}
async function crsManifest(auto) {
  const m = CR.cur; if (!m || !m.id) return null;
  CR.mfRes = msg('Création du manifeste…'); CR.mfLast = null; crsMfRender();
  const err = await mfEnsure();
  if (err) { CR.mfRes = msg('Manifestes pas encore installés dans la base : ' + esc(err), 'err'); crsMfRender(); return null; }
  const st = await mfDriverFill(crsMfDraft(m, CR.f)), bad = mfCheck(st);
  if (bad.length) { CR.mfRes = msg((auto ? 'Manifeste automatique non créé' : 'Manifeste non créé') + ' : à compléter ' + esc(bad.join(', ')) + ' (fiche, section 9), puis « Créer le manifeste ».', 'warn'); crsMfRender(); return null; }
  try {
    const r = await mfMake(st, { mission_id: m.id, mission: m.number || '' });
    r.noReturn = true; r.missionId = m.id; CR.mfLast = r; CR.mfRes = '';
    if (r.id) {
      const data = Object.assign({}, m.data, { manifest: { id: r.id, name: r.name, path: r.path, at: new Date().toISOString() } });
      const u = await sb.from('missions').update({ data }).eq('id', m.id).select('*').single();
      if (!u.error && CR.cur && CR.cur.id === m.id) CR.cur = u.data;
    }
  } catch (e) { CR.mfRes = msg('Manifeste non créé : ' + esc(e.message || e), 'err'); }
  crsMfRender();
  return CR.mfLast;
}
function crsMfRender() {
  const box = $('#crsmf'), m = CR.cur || {}; if (!box) return;
  if (!m.id) { box.hidden = true; return; }
  box.hidden = false;
  const man = m.data && m.data.manifest, canMake = CR.edit && m.vehicle_key && m.start_at;
  const again = canMake ? `<button class="ghost small" id="crsmfgo">${man ? 'Refaire le manifeste' : 'Créer le manifeste'}</button>` : '';
  if (CR.mfLast && CR.mfLast.missionId === m.id) {
    box.innerHTML = '<h2>Manifeste</h2>' + (CR.mfRes || '') + '<div id="crsmfd"></div>' + again;
    mfDone(CR.mfLast, $('#crsmfd'));
  } else if (man) {
    box.innerHTML = `<h2>Manifeste</h2><div class="small">${esc(man.name || '')} · créé le ${esc(fmtDTY(man.at))}</div>${CR.mfRes || ''}
      <div class="mfgo">${man.path ? '<button class="ghost small" id="crsmfpdf">Ouvrir le PDF</button>' : ''}<a class="btn small ghostb" href="#/manifeste">Page Manifestes (WhatsApp, e-mail)</a> ${again}</div>`;
    const b = $('#crsmfpdf'); if (b) b.onclick = async () => { try { const u = await mfLink(man.path); if (!openOut(u)) window.open(u, '_blank', 'noopener'); } catch (e) { alert('PDF indisponible (effacé après ' + ((S.P && S.P.manifestKeepDays) || 30) + ' jours ?) : ' + e.message); } };
  } else {
    box.innerHTML = `<h2>Manifeste</h2><div class="small">Créé automatiquement à la confirmation de la course (véhicule, chauffeur, client, trajet).</div>${CR.mfRes || ''}<div class="mfgo">${again}</div>`;
  }
  const g = $('#crsmfgo'); if (g) g.onclick = async () => { crsRead(); if (!await crsSave()) return; crsManifest(false); };
}

// ---------- course rapide : sans devis, lancée tout de suite (véhicule bloqué, manifeste créé) ----------
function crsCatOf(v) { const mo = String((v && v.model) || '').toUpperCase(); return (crsCats().find(c => mo.indexOf(String(c.id).toUpperCase()) >= 0) || {}).id || ''; }
async function crsQuick(head) {
  const my = ROUTING; await mfEnsure(); if (my !== ROUTING) return;
  const G = CR.grid || {}, ok = inAgency(), vs = S.vehList.filter(v => ok(v.key) && String(v.active || 'OUI').toUpperCase() !== 'NON').sort((a, b) => String(a.plate).localeCompare(String(b.plate)));
  const dep0 = mfNowLocal(), q = CR.q = CR.q || { veh: '', dep: dep0, end: crsLocalDT(new Date((parseLocalDT(dep0) || new Date()).getTime() + 2 * HOUR)), type: 'Non résident', pax: 1 };
  if (typeof addrSetPlaces === 'function') addrSetPlaces(MANIF_PLACES);
  // tarifs de chaque ville de départ (grille de l'agence en premier) : valeur « grille|A ou I|destination »
  const G1 = crsGridDefault(), gs = (CR.grids.length ? CR.grids : [G]).slice().sort((a, b) => (b === G1) - (a === G1));
  const rows = gs.map(g => [crsGridName(g), [].concat((g.airport || []).map(r => [(g._id || 1) + '|A|' + r.dest, 'A' + crsAirport(g).slice(1) + ' ↔ ' + r.dest]))
    .concat((g.intercity || []).map(r => [(g._id || 1) + '|I|' + r.dest, crsOrigin(g) + ' → ' + r.dest]))]);
  const opt = r => `<option value="${esc(r[0])}" ${r[0] === q.grid ? 'selected' : ''}>${esc(r[1])}</option>`;
  const v = (k, d) => esc(q[k] == null ? (d || '') : q[k]);
  $('#page').innerHTML = head + crsTabs('') + `<div class="bar"><a href="#/courses">← Toutes les demandes</a> <b>⚡ Course rapide</b> <span class="small">sans devis : la course est confirmée tout de suite, le véhicule est bloqué et le manifeste est créé.</span></div>
    ${canEdit() ? '' : msg('Lecture seule : les courses sont créées par les gestionnaires et l\'administrateur.', 'warn')}
    <div class="grid2 mfgrid"><div><div class="panel"><h2>Course</h2>
      <div class="mfrow"><label>Véhicule <select id="qkveh"><option value="">Choisir…</option>${vs.map(x => `<option value="${esc(x.key)}" ${x.key === q.veh ? 'selected' : ''}>${esc(x.plate)}${x.model ? ' · ' + esc(x.model) : ''}</option>`).join('')}</select></label>
        <label>Départ le <input type="datetime-local" id="qkdep" value="${v('dep')}"></label><label>Fin prévue <input type="datetime-local" id="qkend" value="${v('end')}"></label></div>
      <div class="mfrow"><label>Adresse de départ <input id="qkfrom" data-addr value="${v('from')}" placeholder="Hôtel, adresse, aéroport…" size="34"></label>
        <button type="button" class="ghost small" id="qkswap" title="Inverser départ et arrivée">⇅</button>
        <label>Adresse d'arrivée <input id="qkto" data-addr value="${v('to')}" placeholder="Hôtel, adresse, aéroport…" size="34"></label></div>
      <div class="mfrow"><label>Chauffeur <input id="qkdrv" list="qkdrvl" value="${v('drv')}" placeholder="Contrat en cours, sinon choisir" size="24" autocomplete="off"></label>
        <datalist id="qkdrvl">${Object.keys(S.drv || {}).filter(c => c !== HORS).map(c => `<option value="${esc(S.drv[c])}"></option>`).join('')}</datalist>
        <label>Téléphone du chauffeur <input id="qktel" value="${v('tel')}" placeholder="06…" size="14"></label></div><div id="qkdinfo" class="small"></div>
      <div class="mfrow"><label>Tarif de la grille (option) <select id="qkgrid"><option value="">—</option>${rows.length > 1 ? rows.map(g => `<optgroup label="Départ ${esc(g[0])}">${g[1].map(opt).join('')}</optgroup>`).join('') : rows.map(g => g[1].map(opt).join('')).join('')}</select></label>
        <label>Prix convenu (MAD TTC) <input type="number" min="0" id="qkprice" value="${v('price')}" style="width:120px"></label></div><div id="qkpinfo" class="small"></div></div>
      <div class="panel"><h2>Client et passagers</h2>
        <div class="mfrow"><label>Nom et prénom du client <input id="qkcli" value="${v('client')}" size="26"></label><label>Téléphone <input id="qkcph" value="${v('cphone')}" size="14"></label>
          <label>E-mail (option) <input id="qkcml" value="${v('cmail')}" size="22"></label></div>
        <div class="seg" role="group" aria-label="Type de client">${['Résident', 'Non résident'].map(t => `<button type="button" data-qkt="${t}" class="${q.type === t ? '' : 'ghost'}">${t}</button>`).join('')}</div>
        <div class="mfrow">${q.type === 'Résident' ? `<label>N° CIN ou passeport <input id="qkcin" value="${v('cin')}" size="14"></label>` : ''}
          <label>Passagers <input type="number" min="1" id="qkpax" value="${v('pax', 1)}" style="width:80px"></label>
          <label>N° de vol / observations <input id="qkobs" value="${v('obs')}" size="22"></label></div>
        ${q.type === 'Résident' ? `<label class="mfobs">Autres passagers (un nom par ligne ; le client est le passager 1) <textarea id="qknames" rows="3">${v('names')}</textarea></label>` : ''}
        <div class="mfgo"><button id="qkgo" ${canEdit() ? '' : 'disabled'}>Lancer la course</button> <button class="ghost" id="qknew">Effacer</button></div><div id="qkres"></div></div></div>
    <div><div id="qkdone"></div></div></div>`;
  const rd = () => { ['veh', 'dep', 'end', 'from', 'to', 'drv', 'tel', 'grid', 'price', 'client', 'cphone', 'cmail', 'cin', 'pax', 'obs', 'names'].forEach(k => { const e = $('#qk' + ({ client: 'cli', cphone: 'cph', cmail: 'cml' }[k] || k)); if (e) q[k] = e.value; }); return q; };
  const gridPrice = () => { rd(); const vv = S.veh[q.veh], cat = crsCatOf(vv), [gid, t, dest] = String(q.grid || '').split('|'), g = crsGridOf(gid), row = ((t === 'A' ? g.airport : g.intercity) || []).find(r => r.dest === dest);
    const pr = row && cat ? crsN(row[cat]) : 0, info = $('#qkpinfo');
    if (row && pr) { $('#qkprice').value = q.price = pr; info.textContent = 'Prix de la grille ' + crsGridName(g) + ' ' + (g.valid || '') + ' pour ' + crsCatName(cat) + ' : ' + crsMoney(pr) + ' (modifiable).'; }
    else info.textContent = q.grid ? (cat ? 'Pas de prix dans la grille pour ce véhicule.' : 'Choisir le véhicule pour le prix de la grille.') : ''; };
  const drvAuto = async () => { rd(); const el = $('#qkdinfo'), t = parseLocalDT(q.dep); if (!q.veh || !t) { el.textContent = ''; return; }
    const key = q.veh + '|' + q.dep; CR.qDrv = key; el.textContent = 'Recherche du contrat…';
    const c = await mfContractAt(q.veh, t.getTime()).catch(() => null); if (CR.qDrv !== key) return;
    if (c) { if (!q.drvManual) { $('#qkdrv').value = q.drv = c.name || ''; $('#qktel').value = q.tel = c.phone || ''; } el.textContent = 'Contrat ' + c.num + ' : ' + (c.name || c.code) + (c.phone ? ' · ' + c.phone : '') + (q.drvManual ? ' (chauffeur saisi à la main gardé)' : ''); }
    else el.innerHTML = '<b>Aucun contrat</b> sur ce véhicule à cette heure : choisir le chauffeur.'; };
  $('#qkveh').onchange = () => { q.drvManual = false; drvAuto(); if (q.grid) gridPrice(); };
  $('#qkdep').onchange = () => { const old = q.dep; rd(); const a = parseLocalDT(old), b = parseLocalDT(q.end), n = parseLocalDT(q.dep);
    if (n && a && b && b > a) { q.end = crsLocalDT(new Date(n.getTime() + (b - a))); $('#qkend').value = q.end; } drvAuto(); };   // fin décalée d'autant
  $('#qkdrv').oninput = $('#qktel').oninput = () => { q.drvManual = true; };
  $('#qkdrv').onchange = () => { rd(); mfDriverFill({ chauffeur: q.drv }).then(st => { if (st.chauffeurTel && !$('#qktel').value) $('#qktel').value = q.tel = st.chauffeurTel; }); };
  $('#qkgrid').onchange = gridPrice;
  $('#qkswap').onclick = () => { const a = $('#qkfrom').value; $('#qkfrom').value = $('#qkto').value; $('#qkto').value = a; rd(); };
  document.querySelectorAll('[data-qkt]').forEach(b => b.onclick = () => { rd(); q.type = b.dataset.qkt; crsQuick(head); });
  $('#qknew').onclick = () => { CR.q = null; crsQuick(head); };
  $('#qkgo').onclick = () => crsQuickGo(head);
  if (q.veh && !q.drv) drvAuto();
}
async function crsQuickGo(head) {
  const q = CR.q, res = $('#qkres'), btn = $('#qkgo');
  ['veh', 'dep', 'end', 'from', 'to', 'drv', 'tel', 'grid', 'price', 'client', 'cphone', 'cmail', 'cin', 'pax', 'obs', 'names'].forEach(k => { const e = $('#qk' + ({ client: 'cli', cphone: 'cph', cmail: 'cml' }[k] || k)); if (e) q[k] = e.value; });
  const vv = S.veh[q.veh], a = parseLocalDT(q.dep), b = parseLocalDT(q.end), bad = [];
  const G = (q.grid ? crsGridOf(String(q.grid).split('|')[0]) : crsGridDefault(vv && vv.agency_id)) || {};
  if (!vv) bad.push('le véhicule'); if (!a) bad.push('la date de départ'); if (a && (!b || b <= a)) bad.push('une fin prévue après le départ');
  if (!String(q.from || '').trim()) bad.push('l\'adresse de départ'); if (!String(q.to || '').trim()) bad.push('l\'adresse d\'arrivée');
  if (!String(q.client || '').trim()) bad.push('le client'); if (!crsN(q.price)) bad.push('le prix convenu');
  const f = { quick: true, gridId: G._id || 1, kind: 'Transfert simple', base: 'convenu', agreedPrice: crsN(q.price), gridRef: q.grid ? ($('#qkgrid').selectedOptions[0] || {}).textContent : '', cat: crsCatOf(vv), nVeh: 1, drivers: 1,
    vehicleKey: q.veh, driverName: String(q.drv || '').trim(), driverPhone: String(q.tel || '').trim(), client: String(q.client || '').trim(), phone: String(q.cphone || '').trim(), email: String(q.cmail || '').trim(),
    clientType: 'Particulier', service: 'Standard', dispo: 'Disponibilité planifiée', planning: 'oui', pax: Math.max(1, crsN(q.pax) || 1), startAddr: String(q.from || '').trim(), endAddr: String(q.to || '').trim(),
    startDate: (q.dep || '').slice(0, 10), startTime: (q.dep || '').slice(11, 16), endDate: (q.end || '').slice(0, 10), endTime: (q.end || '').slice(11, 16),
    mfType: q.type, cin: q.type === 'Résident' ? String(q.cin || '').trim() : '', paxNames: q.type === 'Résident' ? q.names || '' : '', flight: String(q.obs || '').trim(), cities: [], extras: [] };
  // le manifeste doit pouvoir être établi : vérifié avant de lancer la course
  if (!bad.length) { const err = await mfEnsure(); if (err) bad.push('les manifestes (base : ' + err + ')');
    else { const st = await mfDriverFill(crsMfDraft({ vehicle_key: q.veh, start_at: a.toISOString(), end_at: b.toISOString() }, f)); mfCheck(st).forEach(x => { if (!bad.includes(x)) bad.push(x); });
      if (!f.driverPhone && st.chauffeurTel) f.driverPhone = st.chauffeurTel; if (!f.driverName && st.chauffeur) f.driverName = st.chauffeur; } }
  if (bad.length) { res.innerHTML = msg('À compléter : ' + esc(bad.join(', ')) + '.', 'err'); return; }
  btn.disabled = true; res.innerHTML = msg('Lancement…');
  try {
    CR.cur = null; CR.f = f; CR.edit = canEdit();
    const p = crsPrice(f, G), row = crsRow(f, p);
    const c = await crsConflicts(Object.assign({ id: null }, row));
    if (c.length) throw new Error('véhicule déjà bloqué sur cette période : ' + c.map(x => (x.number || '#' + x.id) + ' (' + (x.client_name || '') + ', ' + x.status + ')').join(' ; '));
    const status = a.getTime() <= Date.now() + 15 * MIN ? 'En cours' : 'Confirmée';
    const ins = await sb.from('missions').insert(Object.assign(row, { needs_validation: false, status,
      data: { f, price: p, quick: true, history: [{ at: new Date().toISOString(), status: 'Course rapide : ' + status, by: S.profile.email || '' }] } })).select('*').single();
    if (ins.error) throw new Error(ins.error.message);
    CR.cur = ins.data;
    const done = $('#qkdone');
    if (done) done.innerHTML = `<div class="panel mfok"><h2>Course ${esc(ins.data.number || '')} lancée</h2><div class="small">${esc(status)} · ${esc((vv || {}).plate || '')} bloqué du ${esc(fmtDTY(a))} au ${esc(fmtDTY(b))} · visible sur En direct pendant la course.</div>
      <div class="mfgo"><a class="btn small" href="#/courses?id=${ins.data.id}">Ouvrir la fiche</a> <button class="ghost small" id="qkagain">Nouvelle course rapide</button></div></div><div class="panel" id="crsmf"></div>`;
    if ($('#qkagain')) $('#qkagain').onclick = () => { CR.q = null; crsQuick(head); };
    res.innerHTML = '';
    await crsManifest(true);
  } catch (e) { res.innerHTML = msg('Course non lancée : ' + esc(e.message || e), 'err'); }
  if ($('#qkgo')) $('#qkgo').disabled = false;
}

// contrôle réel par Geotab : trajets du véhicule affecté pendant la mission
async function crsGeotab() {
  const box = $('#crsgeo'), m = CR.cur; if (!box) return;
  if (!m || !m.vehicle_key || !m.start_at || new Date(m.start_at) > new Date() || !['Confirmée', 'En cours', 'Terminée', 'Facturée'].includes(m.status)) { box.innerHTML = ''; return; }
  const a = new Date(m.start_at), b = new Date(Math.min(Date.now(), new Date(m.end_at || m.start_at).getTime()));
  let trips = [];
  try { trips = await all('trips', 'id,vehicle_key,start_at,end_at,km,fuel_l,driver_name', q => q.eq('vehicle_key', m.vehicle_key).gte('start_at', a.toISOString()).lt('start_at', b.toISOString()), ['start_at']); }
  catch (e) { box.innerHTML = msg('Trajets Geotab illisibles : ' + esc(e.message), 'err'); return; }
  const p = crsPrice(CR.f, crsG()), r = crsActual(trips, CR.f, p, t => localDay(t), t => localHM(t));
  CR.actual = r;
  box.innerHTML = `<div class="panel"><h2>Contrôle réel (Geotab)</h2>
    <div class="small">Véhicule ${esc((S.veh[m.vehicle_key] || {}).plate || m.vehicle_key)} du ${fmtDTY(a)} au ${fmtDTY(b)}${b < new Date(m.end_at || 0) ? ' (mission en cours)' : ''}. Amplitude = du premier départ au dernier arrêt du véhicule (l'attente avant le premier départ n'est pas mesurée).</div>
    ${table('tcrsg', [['Jour', d => fmtDay(d.day)], ['Trajets', d => f0(d.n), null, 'n'], ['Km', d => f1(d.km), null, 'n'], ['Premier départ', d => esc(d.from)], ['Dernier arrêt', d => esc(d.to)], ['Amplitude (h)', d => f1(d.h), null, 'n'],
      ['Heures au-delà', d => d.overH ? '<b class="crit">' + f0(d.overH) + '</b>' : '0', null, 'n'], ['Km au-delà', d => d.overKm ? '<b class="crit">' + f1(d.overKm) + '</b>' : '0', null, 'n']], r.days, { empty: 'Aucun trajet Geotab sur la période' })}
    ${cards([['Km mesurés', f1(r.km)], ['Heures au-delà (heures commencées)', f0(r.overH), r.overH ? 'warn' : ''], ['Km au-delà du forfait', f1(r.overKm), r.overKm ? 'warn' : ''],
      ['Dépassements à facturer (TTC)', crsMoney(r.amountH + r.amountKm), r.amountH + r.amountKm ? 'warn' : '']])}
    <div class="mfgo"><button class="ghost small" id="crsgpdf">Rapport km et horaires (PDF)</button></div></div>`;
  $('#crsgpdf').onclick = () => { try { crsActualPdf(m, CR.f, p, r); } catch (e) { alert(e.message); } };
}

// ---------- grille tarifaire (lecture : administrateur et gestionnaires ; modification : administrateur) ----------
function crsGridPage(head, work) {
  // une grille par ville de départ (#/courses?t=grille&g=<id>) ; work = grille en cours de modification (destination ajoutée ou retirée)
  const gid = +(qs().get('g') || 0) || (crsGridDefault() || {})._id || 1, cur = crsGridOf(gid) || {};
  const G = work || JSON.parse(JSON.stringify(cur)), adm = isAdmin(), cats = G.cats || [], ro = adm ? '' : 'disabled';
  const ags = S.agencies || [], one = CR.grids.length > 1;
  const inp = (path, v, w) => `<input data-g="${esc(path)}" value="${esc(v == null ? '' : v)}" style="width:${w || 90}px" ${ro}>`;
  const catCols = row => cats.map(c => `<td class="n">${inp(row + '.' + c.id, ((path => path.split('.').reduce((o, k) => o && o[k], G))(row) || {})[c.id], 80)}</td>`).join('');
  const tbl = (key, title) => `<h3>${title}</h3><div class="tw"><table><thead><tr><th>Destination</th>${cats.map(c => `<th class="n">${esc(c.model)}</th>`).join('')}${adm ? '<th></th>' : ''}</tr></thead><tbody>
    ${(G[key] || []).map((r, i) => `<tr><td>${inp(key + '.' + i + '.dest', r.dest, 160)}</td>${cats.map(c => `<td class="n">${inp(key + '.' + i + '.' + c.id, r[c.id], 80)}</td>`).join('')}${adm ? `<td><button class="ghost small" data-gdel="${key}.${i}">Retirer</button></td>` : ''}</tr>`).join('')}</tbody></table></div>
    ${adm ? `<button class="ghost small" data-gadd="${key}">+ Destination</button>` : ''}`;
  $('#page').innerHTML = head + crsTabs('grille') + `
    ${adm ? msg('Grille modifiable par l\'administrateur seul. Les devis déjà enregistrés gardent les prix de leur date.', 'ok') : msg('Lecture seule : la grille est modifiée par l\'administrateur.', 'warn')}
    ${one || adm ? `<div class="tabs">${CR.grids.map(g => `<a href="#/courses?t=grille&g=${g._id}" class="${g._id === G._id ? 'on' : ''}">Départ ${esc(crsGridName(g))}</a>`).join('')}</div>` : ''}
    <div class="panel"><h2>Grille au départ de ${esc(crsGridName(G))}</h2>
    ${G.calc ? `<div class="small">${esc(G.calc)}</div>` : ''}
    <div class="mfrow"><label>Nom ${adm ? `<input id="gname" value="${esc(G._name || '')}" style="width:140px">` : esc(G._name || '')}</label>
      <label>Ville de départ (intervilles) ${inp('origin', crsOrigin(G), 130)}</label><label>Aéroport des transferts ${inp('airportName', G.airportName || 'Mohammed V', 150)}</label>
      <label>Proposée par défaut aux courses de l'agence <select id="gag" ${ro}><option value="">—</option>${ags.map(a => `<option value="${a.id}" ${+G._agency === +a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label></div>
    <div class="mfrow"><label>En vigueur ${inp('valid', G.valid, 90)}</label><label>TVA (%) ${inp('vat', G.vat, 60)}</label>
      <label>Seuil « montant important » pour la validation (MAD, vide = aucun) ${inp('validationAmount', G.validationAmount, 100)}</label></div>
    <h3>Véhicules</h3><div class="tw"><table><thead><tr><th>Code</th><th>Modèle</th><th>Libellé</th><th class="n">Places</th></tr></thead><tbody>
      ${cats.map((c, i) => `<tr><td>${esc(c.id)}</td><td>${inp('cats.' + i + '.model', c.model, 150)}</td><td>${inp('cats.' + i + '.label', c.label, 180)}</td><td class="n">${inp('cats.' + i + '.seats', c.seats, 60)}</td></tr>`).join('')}</tbody></table></div>
    <h3>1. Mise à disposition avec chauffeur</h3><div class="tw"><table><thead><tr><th>Formule</th><th>Heures</th><th>Km inclus</th>${cats.map(c => `<th class="n">${esc(c.model)}</th>`).join('')}</tr></thead><tbody>
      <tr><td>Tarif horaire (minimum ${inp('hourlyMinH', G.hourlyMinH, 50)} h)</td><td></td><td></td>${catCols('hourly')}</tr>
      <tr><td>Demi-journée</td><td>${inp('half.h', (G.half || {}).h, 50)}</td><td>${inp('half.km', (G.half || {}).km, 60)}</td>${catCols('half')}</tr>
      <tr><td>Journée complète</td><td>${inp('day.h', (G.day || {}).h, 50)}</td><td>${inp('day.km', (G.day || {}).km, 60)}</td>${catCols('day')}</tr></tbody></table></div>
    ${tbl('airport', '2. Transferts ' + crsAirport(G))}${tbl('intercity', '3. Intervilles depuis ' + crsOrigin(G))}
    <h3>4. Suppléments et conditions</h3><div class="tw"><table><tbody>
      <tr><td>Nuit et jours fériés (%)</td><td>${inp('nightPct', G.nightPct, 60)} de ${inp('nightFrom', G.nightFrom, 40)} h à ${inp('nightTo', G.nightTo, 40)} h</td></tr>
      <tr><td>Attente (MAD / 15 min)</td><td>${cats.map(c => esc(c.model) + ' ' + inp('wait15.' + c.id, (G.wait15 || {})[c.id], 60)).join(' ')} · incluses : aéroport ${inp('waitFreeAirport', G.waitFreeAirport, 50)} min, ailleurs ${inp('waitFreeOther', G.waitFreeOther, 50)} min</td></tr>
      <tr><td>Km au-delà du forfait (MAD / km)</td><td>${cats.map(c => esc(c.model) + ' ' + inp('kmExtra.' + c.id, (G.kmExtra || {})[c.id], 60)).join(' ')}</td></tr>
      <tr><td>Agences, DMC et entreprises : remise sur facture (%)</td><td>${inp('proPct', G.proPct, 60)}</td></tr>
      <tr><td>Acompte intervilles et plusieurs jours (%)</td><td>${inp('depositPct', G.depositPct, 60)}</td></tr>
      <tr><td>Course retour (véhicule qui rentre à vide) : remise (%)</td><td>${inp('returnPct', G.returnPct, 60)}</td></tr></tbody></table></div>
    <div class="mfrow"><label class="wide">Annulation <textarea data-g="cancel" rows="2" ${ro}>${esc(G.cancel || '')}</textarea></label>
      <label class="wide">Notes imprimées <textarea data-g="notes" rows="2" ${ro}>${esc(G.notes || '')}</textarea></label>
      <label class="wide">Mentions légales (bas du devis) <textarea data-g="company" rows="2" ${ro}>${esc(G.company || '')}</textarea></label>
      <label class="wide">Contact <input data-g="contact" value="${esc(G.contact || '')}" size="60" ${ro}></label></div>
    ${adm ? `<div class="mfgo"><button id="gsave">Enregistrer la grille</button> <button class="ghost" id="gcopy">+ Nouvelle ville de départ (copie de cette grille)</button>
      ${G._id !== 1 ? '<button class="ghost" id="gdrop">Retirer cette grille</button>' : ''} <span id="gres"></span></div>` : ''}
    ${G._at ? `<div class="small">Dernière modification : ${fmtDTY(G._at)}</div>` : ''}</div>`;
  if (!adm) return;
  const my0 = ROUTING;
  const setPath = (o, path, v) => { const k = path.split('.'); let x = o; k.slice(0, -1).forEach((p, i) => { if (x[p] == null) x[p] = /^\d+$/.test(k[i + 1]) ? [] : {}; x = x[p]; }); x[k[k.length - 1]] = v; };
  const read = () => { document.querySelectorAll('[data-g]').forEach(i => { const p = i.dataset.g, raw = i.value.trim(), last = p.split('.').pop();
    const txt = ['valid', 'cancel', 'notes', 'company', 'contact', 'dest', 'model', 'label', 'origin', 'airportName'].includes(last);
    setPath(G, p, txt ? raw : raw === '' ? null : crsN(raw)); }); return G; };
  const meta = () => { G._name = $('#gname').value.trim(); G._agency = +$('#gag').value || null; };
  document.querySelectorAll('[data-gadd]').forEach(b => { b.onclick = () => { read(); meta(); (G[b.dataset.gadd] = G[b.dataset.gadd] || []).push({ dest: '' }); crsGridPage(head, G); }; });
  document.querySelectorAll('[data-gdel]').forEach(b => { b.onclick = () => { read(); meta(); const [k, i] = b.dataset.gdel.split('.'); G[k].splice(+i, 1); crsGridPage(head, G); }; });
  const clean = g => { const d = {}; Object.keys(g).forEach(k => { if (k[0] !== '_') d[k] = g[k]; }); return d; };   // _id, _name… : pas dans la base
  const fail = r => { $('#gres').innerHTML = '<span class="err">Non enregistrée : ' + esc(r.error ? r.error.message : 'droits insuffisants') + (r.error && /name|agency_id|column/i.test(r.error.message) ? ' (exécuter supabase/migrations/20261117000000_grilles_villes.sql)' : '') + '</span>'; };
  $('#gcopy').onclick = async () => {
    const name = (prompt('Ville de départ de la nouvelle grille (copie de la grille ' + crsGridName(G) + ', prix à adapter) :') || '').trim();
    if (!name) return;
    if (CR.grids.some(g => crsGridName(g).toLowerCase() === name.toLowerCase())) { $('#gres').innerHTML = '<span class="err">Une grille « ' + esc(name) + ' » existe déjà.</span>'; return; }
    read(); const d = clean(G); d.origin = name; delete d.calc;
    const r = await sb.from('pricing_grid').insert({ name, data: d }).select('id');
    if (r.error || !r.data || !r.data.length) return fail(r);
    await crsLoadGrid(); location.hash = '#/courses?t=grille&g=' + r.data[0].id;
  };
  if ($('#gdrop')) $('#gdrop').onclick = async () => {
    if (!confirm('Retirer la grille ' + crsGridName(G) + ' ? Les devis déjà enregistrés gardent leurs prix.')) return;
    const r = await sb.from('pricing_grid').delete().eq('id', G._id).select('id');
    if (r.error || !r.data || !r.data.length) return fail(r);
    await crsLoadGrid(); location.hash = '#/courses?t=grille';
  };
  $('#gsave').onclick = async () => {
    read();
    const bad = []; ['hourly', 'half', 'day', 'kmExtra', 'wait15'].forEach(k => cats.forEach(c => { if (!(crsN((G[k] || {})[c.id]) > 0)) bad.push(k + ' ' + c.model); }));
    if (bad.length && !confirm('Prix vides ou à 0 : ' + bad.join(', ') + '. Enregistrer quand même ?')) return;
    meta(); if (!G._name) G._name = crsOrigin(G);
    const row = { data: clean(G), updated_at: new Date().toISOString(), updated_by: S.session.user.id };
    if (CR.grids.length > 1 || G._id !== 1 || G._agency || G._name !== 'Casablanca') Object.assign(row, { name: G._name, agency_id: G._agency });   // colonnes de la migration 20261117
    const r = await sb.from('pricing_grid').update(row).eq('id', G._id || 1).select('updated_at');
    if (r.error || !r.data || !r.data.length) return fail(r);
    await crsLoadGrid(); if (my0 !== ROUTING) return;
    crsGridPage(head); $('#gres').innerHTML = '<span class="ok">Grille enregistrée.</span>';
  };
}

// ---------- PDF : devis et rapport km / horaires ----------
function crsPdfDoc() {
  if (!window.jspdf) throw new Error('bibliothèque PDF non chargée, réessayez dans un instant');
  if (window.applyPlugin && !window.jspdf.jsPDF.API.autoTable) window.applyPlugin(window.jspdf.jsPDF);
  return new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
}
function crsCl(v) { return String(v == null ? '' : v).replace(/[  ]/g, ' ').replace(/[↔→]/g, '-').replace(/[−]/g, '-').replace(/[🟢🟠🔴]/g, ''); }
function crsPdfName(m, f) { return 'Devis-' + (m.number || 'Ludy') + (f.client ? '-' + String(f.client).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-') : '') + '.pdf'; }
function crsPdf(m, f, p, G, keep) {
  const doc = crsPdfDoc(), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 14, acc = [123, 30, 46], ink = [20, 32, 43], mute = [93, 107, 120];
  const t = crsTimes(f), inc = p.included || {}, cl = crsCl, draft = m.needs_validation !== false && crsValidation(f, p.total, G).length && !m.validated_at;
  const font = (st, sz, c) => { doc.setFont('helvetica', st); doc.setFontSize(sz); doc.setTextColor(...(c || ink)); };
  try { doc.addImage(RPT_LOGO, 'PNG', M, 10, 38, 9.3); } catch (e) { }
  font('bold', 16); doc.text('DEVIS' + (m.number ? ' N° ' + m.number : ''), W - M, 15, { align: 'right' });
  font('normal', 9, mute); doc.text('Établi le ' + fmtDay(today()) + ' · valable ' + (crsN(f.validDays) || 7) + ' jours · grille ' + cl(G.valid || ''), W - M, 20.5, { align: 'right' });
  if (draft) { font('bold', 10, [180, 35, 24]); doc.text('PROJET - en attente de validation de l\'exploitation', W - M, 26, { align: 'right' }); }
  let y = 34;
  const box = (title, rows, x, w) => { font('bold', 9, acc); doc.text(title.toUpperCase(), x, y); let yy = y + 5; rows.filter(r => r[1]).forEach(r => { font('normal', 8, mute); doc.text(cl(r[0]), x, yy); font('normal', 9); const l = doc.splitTextToSize(cl(r[1]), w - 34); doc.text(l, x + 34, yy); yy += 4.4 * l.length; }); return yy; };
  const y1 = box('Client', [['Nom', f.client], ['Société', f.company], ['Téléphone', f.phone], ['E-mail', f.email], ['ICE', f.ice], ['Facturation', f.billing]], M, (W - 2 * M) / 2 - 4);
  const cities = crsCities(f);
  const y2 = box('Mission', [['Prestation', f.kind], ['Début', t.a ? (f.startTime || f.dayStart ? fmtDTY(t.a) : fmtDay(f.startDate)) : ''], ['Fin', t.b ? (f.endTime || f.dayEnd ? fmtDTY(t.b) : fmtDay(f.endDate || f.startDate)) : ''], ['Véhicule', crsCatName(f.cat) + (crsN(f.nVeh) > 1 ? ' × ' + f.nVeh : '')],
    ['Passagers', f.pax ? f.pax + (f.bags ? ' · bagages : ' + f.bags : '') : ''], ['Itinéraire', [f.startCity, f.dest].concat(cities).filter((x, i, a) => x && a.indexOf(x) === i).join(' - ')], ['Chauffeurs', String(crsN(f.drivers) || 1) + (f.lang ? ' · ' + f.lang : '')]], W / 2 + 2, (W - 2 * M) / 2 - 2);
  y = Math.max(y1, y2) + 4;
  doc.autoTable({ startY: y, margin: { left: M, right: M }, head: [['Désignation', 'Qté', 'Prix unitaire', 'Montant TTC']],
    body: p.lines.map(l => [cl(l.label), String(l.qty), cl(crsMoney(l.unit)), cl(crsMoney(l.amount))]),
    foot: [['Total TTC', '', '', cl(crsMoney(p.total))], ['dont TVA ' + p.vat + ' %', '', '', cl(crsMoney(p.tva))], ['Total HT', '', '', cl(crsMoney(p.ht))]].concat(p.deposit ? [['Acompte à la réservation (' + p.depositPct + ' %)', '', '', cl(crsMoney(p.deposit))]] : []),
    styles: { fontSize: 8.5, cellPadding: 1.8, textColor: ink }, headStyles: { fillColor: [15, 38, 51], textColor: 255 }, footStyles: { fillColor: [243, 245, 247], textColor: ink, fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'right', cellWidth: 14 }, 2: { halign: 'right', cellWidth: 30 }, 3: { halign: 'right', cellWidth: 32 } } });
  y = doc.lastAutoTable.finalY + 6;
  const para = (title, lines) => { if (y > H - 40) { doc.addPage(); y = 18; } font('bold', 9, acc); doc.text(title.toUpperCase(), M, y); y += 4.6;
    lines.filter(Boolean).forEach(s => { font('normal', 8.5); const l = doc.splitTextToSize(cl(s), W - 2 * M); if (y + l.length * 4 > H - 18) { doc.addPage(); y = 18; } doc.text(l, M, y); y += l.length * 4 + 0.6; }); y += 2; };
  para('Inclus', [inc.h ? 'Amplitude horaire incluse : ' + inc.h + ' h par jour' + (crsHoursDay(f) ? ' (prévue : ' + crsHoursDay(f) + ' h)' : '') + '.' : '',
    inc.km ? 'Kilomètres inclus : ' + inc.km + ' km par jour.' : '', f.kmUnlimited ? 'Kilométrage illimité.' : '', 'Véhicule avec chauffeur' + (crsN(f.drivers) > 1 ? ' (' + f.drivers + ' chauffeurs)' : '') + ', carburant selon le forfait.',
    (p.base === 'aeroport' || p.base === 'interville') ? 'Forfait tout compris : péages, carburant, bagages et retour à vide inclus.' : (crsN(f.tolls) ? 'Péages et parkings : inclus au devis (ligne dédiée).' : 'Péages et parkings : non inclus, refacturés au réel.'),
    (f.extras || []).length ? 'Prestations : ' + f.extras.join(', ') + '.' : '']);
  para('En supplément', ['Heure supplémentaire : ' + crsMoney(p.extraHour) + ' par heure commencée au-delà de l\'amplitude convenue.', 'Kilomètre supplémentaire : ' + crsMoney(p.extraKm) + ' par km au-delà du forfait.',
    'Attente : ' + crsMoney(p.wait15) + ' par 15 min au-delà de ' + (p.base === 'aeroport' ? crsN(G.waitFreeAirport) : crsN(G.waitFreeOther)) + ' min incluses.',
    'Nuit (' + (G.nightFrom || 22) + 'h-' + (G.nightTo || 6) + 'h) et jours fériés : +' + crsN(G.nightPct) + ' % (non cumulables).',
    f.hotelBy || f.mealsBy ? 'Hôtel du chauffeur : ' + (f.hotelBy || '-') + ' · repas : ' + (f.mealsBy || '-') + '.' : 'Hôtel et repas du chauffeur facturés lorsqu\'un retour quotidien à la base n\'est pas possible.']);
  para('Conditions', ['Toute heure commencée au-delà de l\'amplitude convenue et tout kilomètre au-delà du forfait sont facturés aux tarifs ci-dessus.',
    'Toute modification importante de l\'itinéraire peut entraîner une révision du prix.', f.h24 ? 'Disponibilité 24 h/24 : rotation de chauffeurs, tarification spécifique.' : '',
    'Réservation confirmée après validation écrite du devis' + (p.deposit ? ', paiement de l\'acompte (' + crsMoney(p.deposit) + ')' : '') + ' et transmission des informations nécessaires à l\'organisation.',
    G.cancel ? (/^annulation/i.test(G.cancel) ? G.cancel : 'Annulation : ' + G.cancel) : '', 'TVA ' + p.vat + ' % incluse. ' + (G.notes || ''), f.quoteNotes || '']);
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) { doc.setPage(i); font('normal', 6.8, mute); const l = doc.splitTextToSize(cl((G.company || '') + (G.contact ? ' · ' + G.contact : '')), W - 2 * M); doc.text(l, W / 2, H - 9, { align: 'center' }); doc.text('Page ' + i + ' / ' + n, W - M, H - 4, { align: 'right' }); }
  if (!keep) doc.save(crsPdfName(m, f));
  return doc;
}
function crsActualPdf(m, f, p, r) {
  const doc = crsPdfDoc(), W = doc.internal.pageSize.getWidth(), M = 14;
  try { doc.addImage(RPT_LOGO, 'PNG', M, 10, 38, 9.3); } catch (e) { }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text('Rapport kilomètres et horaires', W - M, 15, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(crsCl((m.number || '') + ' · ' + (f.client || '') + ' · ' + ((S.veh[m.vehicle_key] || {}).plate || '')), W - M, 20.5, { align: 'right' });
  doc.text(crsCl('Mesuré par le boîtier Geotab du véhicule : du premier départ au dernier arrêt de chaque jour.'), M, 30);
  doc.autoTable({ startY: 34, margin: { left: M, right: M }, head: [['Jour', 'Trajets', 'Km', 'Premier départ', 'Dernier arrêt', 'Amplitude (h)', 'Heures au-delà', 'Km au-delà']],
    body: r.days.map(d => [fmtDay(d.day), String(d.n), f1(d.km), d.from, d.to, f1(d.h), String(d.overH), f1(d.overKm)].map(crsCl)),
    foot: [['Total', '', f1(r.km), '', '', '', String(r.overH), f1(r.overKm)].map(crsCl)], styles: { fontSize: 8.5 }, headStyles: { fillColor: [15, 38, 51] }, footStyles: { fillColor: [243, 245, 247], textColor: 20 } });
  let y = doc.lastAutoTable.finalY + 7;
  [['Inclus', (p.included.h ? p.included.h + ' h / jour' : '') + (p.included.km ? ' · ' + p.included.km + ' km / jour' : '')], ['Heures au-delà', r.overH + ' × ' + crsMoney(p.extraHour) + ' = ' + crsMoney(r.amountH)],
    ['Km au-delà', f1(r.overKm) + ' × ' + crsMoney(p.extraKm) + ' = ' + crsMoney(r.amountKm)], ['Dépassements TTC', crsMoney(r.amountH + r.amountKm)]]
    .forEach(x => { doc.setFont('helvetica', 'normal'); doc.text(crsCl(x[0]), M, y); doc.setFont('helvetica', 'bold'); doc.text(crsCl(x[1]), M + 50, y); y += 5.5; });
  doc.save('Km-horaires-' + (m.number || 'mission') + '.pdf');
}

if (typeof module !== 'undefined') module.exports = { CRS_KINDS, crsDays, crsHoursDay, crsAmplitude, crsBase, crsLevel, crsValidation, crsMissing, crsPrice, crsActual, crsSeatsOk, crsMoney, crsSpan, crsOrigin, crsAirport };
