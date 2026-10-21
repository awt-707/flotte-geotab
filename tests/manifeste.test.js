// Manifestes de passagers : PDF identique au modèle (formulaires officiels), message de partage, droits par agence
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const env = require('./lib/env'), M = require('../site/manifeste.js'), { jsPDF } = require('jspdf');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
// texte d'un PDF compressé (flux inflatés)
const pdfText = buf => { const b = Buffer.from(buf), out = []; let i = 0;
  for (;;) { const a = b.indexOf('stream', i); if (a < 0) break; let s = a + 6; if (b[s] === 13) s++; if (b[s] === 10) s++; const e = b.indexOf('endstream', s); if (e < 0) break;
    try { out.push(require('zlib').inflateSync(b.slice(s, e)).toString('latin1')); } catch (x) { } i = e + 9; }
  return out.join('\n'); };
const BG = f => new Uint8Array(fs.readFileSync(path.join(env.ROOT, 'site', 'manifeste', f)));
// cachet de test : PNG 1×1
const STAMP = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const D = {
  type: 'resident', company: { nom: 'LUXURY & DISCOVERY', adresse: 'IMM 33 RUE LOUBNANE, RABAT', tel: '0701042514', autorisation: 'TT/43186/2025', dossier: '2939/TOUR/2025' },
  vehicule: { plaque: '86433-T-1', marque: 'HYUNDAI', modele: 'Staria', places: 9, remplacement: '' },
  donneur: 'Karim Bennani', cin: 'BK123456', nbPassagers: 3, passagers: ['Karim Bennani', 'Sara Alami', 'Yassine Idrissi'],
  depart: 'Aéroport Mohammed V, Casablanca', terminus: 'Hôtel Sofitel, Rabat', prestation: 'Transfert aéroport', nature: 'Transfert',
  dateDepart: '17/10/2026 à 14:30', dateRetour: '', observations: 'Vol AT 205', etabli: '16/10/2026', chauffeur: 'Zakaria Elhmami', chauffeurTel: '06 12 34 56 78', dateDep: '2026-10-17T14:30'
};

test('manifeste : nom du fichier, numéro WhatsApp, places, message détaillé', () => {
  assert.strictEqual(M.manifFileName(D), 'Manifeste-Mission-171026-14h30-Zakaria-Elhmami.pdf');
  assert.strictEqual(M.manifFrDate('2026-10-17T14:30'), '17/10/2026 à 14:30');
  assert.strictEqual(M.manifFrDate('2026-10-18'), '18/10/2026');
  assert.strictEqual(M.manifWa('06 12 34 56 78'), '212612345678');
  assert.strictEqual(M.manifWa('+212 6 12 34 56 78'), '212612345678');
  assert.strictEqual(M.manifWa('00212612345678'), '212612345678');
  assert.strictEqual(M.manifWa('612345678'), '212612345678');
  assert.strictEqual(M.manifWa('+212 (0)6 12 34 56 78'), '212612345678');
  assert.strictEqual(M.manifWa('12'), '');
  assert.strictEqual(M.manifSeats('HYUNDAI STARIA', null), 9);
  assert.strictEqual(M.manifSeats('Sonata', ''), 4);
  assert.strictEqual(M.manifSeats('Staria', 7), 7);
  assert.strictEqual(M.manifSeats('Tucson', null), '');
  const t = M.manifText(D, 'https://x/sign/a.pdf?token=t');
  assert.deepStrictEqual(t.split('\n'), [
    '📄 Ludy · Manifeste de passagers', 'Mission du 17/10/2026 à 14:30', 'Chauffeur : Zakaria Elhmami · 06 12 34 56 78',
    'Véhicule : 86433-T-1 · Hyundai Staria · 9 places', 'Client : Karim Bennani (résident)', 'Passagers (3) : Karim Bennani, Sara Alami, Yassine Idrissi',
    'Trajet : Aéroport Mohammed V, Casablanca → Hôtel Sofitel, Rabat', 'Prestation : Transfert aéroport · nature : Transfert', 'Observations : Vol AT 205',
    'Manifeste PDF : https://x/sign/a.pdf?token=t (lien valable 7 jours)']);
  const n = M.manifText(Object.assign({}, D, { type: 'non', nbPassagers: 4, passagers: [], observations: '', dateRetour: '18/10/2026' }), null);
  assert.ok(n.includes('Client : Karim Bennani (non résident)\nPassagers : 4\n'));
  assert.ok(n.includes('Retour : 18/10/2026') && !n.includes('Manifeste PDF'));
});

test('manifeste PDF : résident sur 2 pages, non-résident sur 1 page, texte dans les cases', () => {
  const A = { bg1: BG('resident-1.jpg'), bg2: BG('resident-2.jpg'), bg3: BG('non-resident.jpg'), stamp: STAMP, stampW: 150, stampRatio: 0.3 };
  const r = M.buildManifest(jsPDF, D, A), raw = pdfText(r.output('arraybuffer'));
  assert.strictEqual(r.getNumberOfPages(), 2);
  ['Karim Bennani', 'BK123456', 'Yassine Idrissi', '86433-T-1', 'HYUNDAI STARIA', 'TT/43186/2025', '2939/TOUR/2025', 'Vol AT 205', '16/10/2026'].forEach(w => assert.ok(raw.includes(w), w + ' absent du PDF'));
  fs.writeFileSync(path.join(env.OUT, 'manifeste_resident.pdf'), Buffer.from(r.output('arraybuffer')));
  const n = M.buildManifest(jsPDF, Object.assign({}, D, { type: 'non', nbPassagers: 4 }), A), rawN = pdfText(n.output('arraybuffer'));
  assert.strictEqual(n.getNumberOfPages(), 1);
  assert.ok(!rawN.includes('BK123456') && !rawN.includes('Yassine Idrissi'), 'non-résident : ni CIN ni liste des passagers');
  fs.writeFileSync(path.join(env.OUT, 'manifeste_non_resident.pdf'), Buffer.from(n.output('arraybuffer')));
});

test('manifestes : réglages lus par les gestionnaires, modifiés par l\'administrateur ; historique et envoi limités aux véhicules de ses agences', () => {
  env.resetDb();
  env.psql(`update manifest_config set stamp = null, email_to = null;
    insert into profiles (user_id, email, role) values ('${ADMIN}', 'admin@x', 'admin') on conflict (user_id) do update set role = 'admin';
    insert into profiles (user_id, email, role) values ('${MGR}', 'new@x', 'manager') on conflict (user_id) do update set role = 'manager';
    insert into agencies (id, name) overriding system value values (1, 'Rabat'), (2, 'Casa');
    insert into user_agencies (user_id, agency_id) values ('${MGR}', 1);
    insert into vehicles (key, plate, model, agency_id) values ('86433T1', '86433-T-1', 'STARIA', 1), ('86119T1', '86119-T-1', 'SONATA', 2);
    insert into parc (plate, model, agency_id) values ('86433-T-1', 'STARIA', 1), ('86119 T 1', 'SONATA', 2);`);
  try {
    // agrément repris du modèle par la migration (rejouée sur ce parc)
    env.psql(fs.readFileSync(path.join(env.ROOT, 'supabase', 'migrations', '20261027000000_manifestes.sql'), 'utf8'));
    assert.deepStrictEqual(env.psql("select plate || '=' || agrement from parc order by plate").split('\n'), ['86119 T 1=TT/43191/2025', '86433-T-1=TT/43186/2025']);
    assert.strictEqual(as(MGR, "select company->>'dossier' from manifest_config"), '2939/TOUR/2025');
    as(MGR, "update manifest_config set email_to = 'x@y.ma'");   // aucune ligne modifiable : sans effet
    assert.strictEqual(env.psql('select coalesce(email_to, \'\') from manifest_config'), '');
    as(ADMIN, "update manifest_config set email_to = 'dret@exemple.ma'");
    assert.strictEqual(env.psql('select email_to from manifest_config'), 'dret@exemple.ma');
    // gestionnaire : manifeste de ses véhicules seulement
    as(MGR, "insert into manifests (vehicle_key, plate, driver_name, file_path) values ('86433T1', '86433-T-1', 'Z', '2026-10/a.pdf')");
    assert.throws(() => as(MGR, "insert into manifests (vehicle_key, plate) values ('86119T1', '86119-T-1')"), /row-level security/);
    as(ADMIN, "insert into manifests (vehicle_key, plate, file_path) values ('86119T1', '86119-T-1', '2026-10/b.pdf')");
    assert.strictEqual(as(MGR, 'select count(*) from manifests'), '1');
    assert.strictEqual(as(ADMIN, 'select count(*) from manifests'), '2');
    // envoi par e-mail : seulement un manifeste qu'il peut lire
    as(MGR, `insert into jobs (kind, arg) values ('manifest_mail', '{"id":1,"to":"dret@exemple.ma"}')`);
    assert.throws(() => as(MGR, `insert into jobs (kind, arg) values ('manifest_mail', '{"id":2,"to":"dret@exemple.ma"}')`), /row-level security/);
    assert.throws(() => as(MGR, `insert into jobs (kind, arg) values ('manifest_mail', 'n''importe quoi')`), /row-level security/);
    // lecture seule : ni réglages ni création
    env.psql(`update profiles set role = 'viewer' where user_id = '${MGR}'`);
    assert.strictEqual(as(MGR, 'select count(*) from manifest_config'), '0');
    assert.throws(() => as(MGR, "insert into manifests (vehicle_key, plate) values ('86433T1', '86433-T-1')"), /row-level security/);
  } finally { env.psql(`update profiles set role = 'pending' where user_id = '${MGR}'; truncate manifests restart identity; delete from jobs`); }
});
