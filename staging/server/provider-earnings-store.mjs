import {normalizeUberEarnings} from './uber-earnings.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = (code, message, status = 502) => Object.assign(new Error(message), {code, status});

/** db is the server's already-authorized service client: {rpc(name, args)}.
 * This module never creates a client, reads a credential, or makes a provider
 * request. The configured organization must come from trusted server settings.
 */
export function createProviderEarningsStore({db, organizationId, now = Date.now} = {}) {
  if (typeof db?.rpc !== 'function') throw new TypeError('A server RPC client is required.');
  if (typeof organizationId !== 'function' && !UUID.test(organizationId || '')) throw new TypeError('A configured Uber organization is required.');
  if (typeof now !== 'function') throw new TypeError('A clock function is required.');
  async function ingest(payload) {
    const expected = typeof organizationId === 'function' ? await organizationId() : organizationId;
    if (!UUID.test(expected || '')) throw fail('earnings_configuration', 'La flotte Earnings configurée est indisponible.', 409);
    const snapshot = normalizeUberEarnings(payload, {organizationId: expected, now: now()});
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 4 * 1024 * 1024) throw fail('earnings_size', 'Relevé Earnings trop volumineux.', 413);
    let response;
    try { response = await db.rpc('provider_earnings_commit', {p_snapshot: snapshot}); }
    catch { throw fail('earnings_storage', 'Enregistrement du relevé Earnings indisponible.'); }
    if (response?.error) throw fail('earnings_storage', 'Enregistrement du relevé Earnings indisponible.');
    const receipt = response?.data;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !UUID.test(receipt.snapshot_id || '') ||
        !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || typeof receipt.duplicate !== 'boolean' ||
        typeof receipt.ignored !== 'boolean' || !Number.isSafeInteger(receipt.rows) || receipt.rows < 0 || receipt.rows > 5000 ||
        typeof receipt.coverage_complete !== 'boolean' || typeof receipt.mapping_complete !== 'boolean' ||
        ['matched', 'unmatched'].some(key => receipt[key] !== undefined &&
          (!Number.isSafeInteger(receipt[key]) || receipt[key] < 0 || receipt[key] > receipt.rows)) ||
        (receipt.matched !== undefined && receipt.unmatched !== undefined && receipt.matched + receipt.unmatched !== receipt.rows)) {
      throw fail('earnings_receipt', 'Le reçu du relevé Earnings est invalide.');
    }
    return {
      snapshot_id: receipt.snapshot_id, revision: receipt.revision, duplicate: receipt.duplicate, ignored: receipt.ignored,
      ...(receipt.ignored && ['stale_observation', 'complete_snapshot_preserved'].includes(receipt.reason) ? {reason: receipt.reason} : {}),
      rows: receipt.rows, ...(Number.isSafeInteger(receipt.matched) ? {matched: receipt.matched} : {}),
      ...(Number.isSafeInteger(receipt.unmatched) ? {unmatched: receipt.unmatched} : {}),
      coverage_complete: receipt.coverage_complete, mapping_complete: receipt.mapping_complete
    };
  }
  return Object.freeze({ingest});
}
