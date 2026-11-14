// API officielle Uber des flottes (14/11/2026) : identifiants saisis dans Ludy, test de connexion (droits ouverts par Uber,
// organisation, statuts des chauffeurs). Faux Uber.
const test = require('node:test'), assert = require('node:assert');
const env = require('./lib/env'), { collector } = require('./lib/v6');
const ADMIN = '11111111-1111-1111-1111-111111111111', MGR = '22222222-2222-2222-2222-222222222222';
const as = (uid, sql) => env.psql(`begin; set local role authenticated; set local request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; ${sql}; commit;`);
const last = s => s.split('\n').filter(Boolean).pop();

test('coffre : identifiants Uber écrits par l\'administrateur, secret jamais renvoyé', () => {
  env.resetDb(); env.psql('truncate integration_secrets');
  try {
    as(ADMIN, "select integration_set('uber_client_id', 'UB-ID'); select integration_set('uber_client_secret', 'UB-SECRET')");
    assert.strictEqual(last(as(ADMIN, "select string_agg(name || ':' || coalesce(shown, '-'), ',' order by name) from integration_status()")), 'uber_client_id:UB-ID,uber_client_secret:-');
    assert.throws(() => as(MGR, "select integration_set('uber_client_secret', 'x')"), /administrateur|droits/);
  } finally { env.psql('truncate integration_secrets'); env.resetDb(); }
});

test('collecteur : droits ouverts par Uber testés un par un, organisation et statuts des chauffeurs lus', () => {
  const B = collector(Date.UTC(2026, 10, 14, 12, 0));
  env.psql('truncate integration_secrets');
  try {
    B.ctx.__uber = [];
    B.run(`var __f0 = UrlFetchApp.fetch; UrlFetchApp.fetch = function (u, o) {
      if (u.indexOf('uber.com') >= 0) { __uber.push({ u, o });
        const r = (c, b) => ({ getResponseCode: () => c, getContentText: () => JSON.stringify(b) });
        if (u.indexOf('/oauth/v2/token') >= 0) {
          if (o.payload.client_secret !== 'UB-SECRET') return r(401, { error: 'invalid_client' });
          return o.payload.scope === 'supplier.fleet.drivers.live_location.read' ? r(400, { error: 'invalid_scope' }) : r(200, { access_token: 'T-' + o.payload.scope, expires_in: 2592000 });
        }
        if (u.indexOf('/v1/vehicle-suppliers/orgs') >= 0) return r(200, { organizations: [{ id: 'ORG-ENC', name: 'Flotte Test' }] });
        if (u.indexOf('/v1/vehicle-suppliers/drivers/actions') >= 0) return u.indexOf('org_id=ORG-ENC') >= 0 ? r(200, { driverStatusOverviews: [
          { statusEntries: [{ status: 'DRIVER_STATUS_ONLINE' }, { status: 'DRIVER_STATUS_ONTRIP' }] }, { statusEntries: [{ status: 'DRIVER_STATUS_OFFLINE' }] }, { statusEntries: [] }] }) : r(400, {});
      } return __f0(u, o); }`);
    assert.match(B.run(`jobUberTest_('${MGR}')`), /réservé à l'administrateur/);
    assert.match(B.run(`jobUberTest_('${ADMIN}')`), /identifiant ou secret manquant/);
    env.psql("insert into integration_secrets (name, value) values ('uber_client_id', 'UB-ID'), ('uber_client_secret', 'FAUX')");
    assert.match(B.run(`jobUberTest_('${ADMIN}')`), /identifiants refusés par Uber \(invalid_client\)/);
    env.psql("update integration_secrets set value = 'UB-SECRET' where name = 'uber_client_secret'");
    const r = B.run(`jobUberTest_('${ADMIN}')`);
    assert.match(r, /organisation de la flotte : ouvert/); assert.match(r, /statut des chauffeurs en temps réel : ouvert/);
    assert.match(r, /position des chauffeurs en direct : non ouvert par Uber \(invalid_scope\)/);
    assert.match(r, /organisations : Flotte Test/); assert.match(r, /chauffeurs lus : ontrip 1, offline 1, sans activité 1/);
    const call = B.ctx.__uber.find(x => x.u.indexOf('/drivers/actions') >= 0);
    assert.strictEqual(call.o.headers.Authorization, 'Bearer T-solutions.suppliers.drivers.status.read');
  } finally { env.psql('truncate integration_secrets'); }
});
