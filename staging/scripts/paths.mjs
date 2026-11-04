import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const STAGING_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_DIR = path.join(STAGING_ROOT, '.local');
export const API_URL = 'http://127.0.0.1:57421';
export const SITE_URL = 'http://127.0.0.1:4173';
export const PROJECT_ID = 'ludy-staging';
export const CLI = path.join(STAGING_ROOT, 'node_modules', '.bin', 'supabase');
export function ensureLocalDir() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(LOCAL_DIR, 0o700);
}
export function localCliEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|GEO_|CLOUDFLARE_|OPENAI_API_KEY)/.test(key)));
  return { ...env, DO_NOT_TRACK: '1', SUPABASE_TELEMETRY_DISABLED: '1', SUPABASE_HOME: path.join(LOCAL_DIR, 'supabase-home') };
}
export function writePrivateJson(file, value) {
  ensureLocalDir();
  fs.writeFileSync(path.join(LOCAL_DIR, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(path.join(LOCAL_DIR, file), 0o600);
}
