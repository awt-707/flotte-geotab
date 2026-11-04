import test from 'node:test';
import assert from 'node:assert/strict';
import {BoltClient} from '../server/bolt.mjs';

test('unsupported Bolt finance is a capability result, without reading credentials or returning a successful zero report', async () => {
  let credentials = 0, requests = 0;
  const client = new BoltClient({credentials: async () => {credentials++; throw Error('Credentials must not be requested');}, fetchFn: async () => {requests++; throw Error('No provider request is needed');}});
  const capability = client.financialCapabilities();
  assert.equal(capability.status, 'unsupported');
  assert.equal(capability.reasonCode, 'NO_DOCUMENTED_FINANCIAL_ENDPOINT');
  assert.equal(capability.coverage.complete, false);
  assert.equal(capability.canReplaceLegacyStatements, false);
  assert.equal(capability.canPopulateCashShifts, false);
  assert.equal(capability.endpoint, null);
  assert.equal(capability.authorization, 'not_checked');
  assert.equal(Object.hasOwn(capability, 'rows'), false, 'unavailable finance is not an empty successful statement');
  assert.equal(Object.hasOwn(capability, 'total'), false, 'unavailable finance must not imply zero revenue');

  // Capability metadata must not broaden the provider endpoint allowlist.
  for (const endpoint of ['getDriverEarnings', 'getPayouts', 'getTransactions', 'getFinancialSummary']) {
    await assert.rejects(client.call(endpoint, {company_id: 1}), error => error.status === 400 && /non autorisé/.test(error.message));
  }
  assert.equal(credentials, 0);
  assert.equal(requests, 0);
});

test('operational Bolt prices and cash payment labels cannot claim financial statement coverage', () => {
  const client = new BoltClient({credentials: async () => null});
  const capability = client.financialCapabilities();
  assert.equal(capability.operationalData.endpoint, 'getRideHistory');
  assert.equal(capability.operationalData.usableAsStatement, false);
  assert.ok(capability.operationalData.fields.includes('payment_method'));
  assert.ok(capability.operationalData.fields.includes('price.total'));
  for (const metric of ['revenue', 'gross', 'net', 'commission', 'bonus', 'payout', 'cashCollected', 'endBalance']) assert.equal(capability.metrics[metric], false);

  // A caller decorating its response cannot accidentally enable finance for
  // another caller that shares the same Bolt client.
  capability.status = 'available';
  capability.coverage.complete = true;
  capability.metrics.net = true;
  const next = client.financialCapabilities();
  assert.equal(next.status, 'unsupported');
  assert.equal(next.coverage.complete, false);
  assert.equal(next.metrics.net, false);
});
