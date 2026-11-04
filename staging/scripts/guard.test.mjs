import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalProject, assertLocalUrl } from './guard.mjs';

test('le staging accepte uniquement son API locale exacte', () => {
  assert.doesNotThrow(() => assertLocalUrl('http://127.0.0.1:57421'));
  for (const candidate of [
    'https://example.supabase.co',
    'http://127.0.0.1:54321',
    'http://localhost:57421',
    'http://127.0.0.1:57421@elsewhere.invalid',
    'http://127.0.0.1:57421/redirect',
    'http://127.0.0.1:57421?target=production'
  ]) assert.throws(() => assertLocalUrl(candidate));
});

test('une configuration Supabase ambiante interdit le demarrage', () => {
  const previous = process.env.SUPABASE_URL;
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    assert.throws(() => assertLocalProject(), /Retirer SUPABASE_URL/);
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previous;
  }
});
