import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { listenLocalStaging } from './listen.mjs';

async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function fixture(handler, fn) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await fn(server.address().port, server); } finally { await stop(server); }
}

test('un port libre demarre le serveur sur la boucle locale', async () => {
  const server = http.createServer((req, res) => res.end('local'));
  assert.equal(await listenLocalStaging(server, 0), 'started');
  try { assert.equal(server.address().address, '127.0.0.1'); } finally { await stop(server); }
});

test('un second lancement conserve le staging deja actif', async () => {
  let requests = 0;
  await fixture((req, res) => {
    requests++; assert.equal(req.url, '/health');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({environment:'staging',project:'ludy-staging'}));
  }, async (port, original) => {
    const duplicate = http.createServer();
    assert.equal(await listenLocalStaging(duplicate, port), 'existing');
    assert.equal(original.listening, true);
    assert.equal(duplicate.listening, false);
    assert.equal(requests, 1);
  });
});

test('un service different ne passe pas pour Ludy et reste intact', async () => {
  await fixture((req, res) => res.end(JSON.stringify({environment:'production',project:'other'})), async (port, original) => {
    await assert.rejects(listenLocalStaging(http.createServer(), port), /occupe par un service/);
    assert.equal(original.listening, true);
  });
});

test('une redirection de la sonde ne valide pas un service etranger', async () => {
  let requests = 0;
  await fixture((req, res) => {
    requests++;
    res.writeHead(302, {Location:'/elsewhere'}); res.end();
  }, async port => {
    await assert.rejects(listenLocalStaging(http.createServer(), port), /occupe par un service/);
    assert.equal(requests, 1);
  });
});
