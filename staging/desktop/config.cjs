'use strict';
const fs = require('node:fs');
const {isIP} = require('node:net');
const {createHash} = require('node:crypto');

const SHELL_ORIGIN = 'ludy-client://shell';
const SHELL_URL = SHELL_ORIGIN + '/status';
const SHELL_PATHS = new Set(['/status', '/client-ui.css', '/client-ui.js', '/logo.png']);
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';
const invalid = () => Object.assign(new Error('Configuration du staging invalide.'), {code:'CONFIG_INVALID'});
function parsed(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try { const url = new URL(value); return url.username || url.password ? null : url; } catch { return null; }
}
function productionHost(host) {
  host = host.replace(/\.$/,'');
  return host === 'ludy-flotte.pages.dev' || host.endsWith('.ludy-flotte.pages.dev') || ['supabase.co','supabase.com','supabase.in'].some(base => host === base || host.endsWith('.' + base));
}
function publicHost(host) {
  return !!host && !host.endsWith('.') && !isIP(host.replace(/^\[|\]$/g,'')) && host.includes('.') && host !== 'localhost' && !['.localhost','.local','.internal'].some(suffix => host.endsWith(suffix));
}
function validateConfig(input, {platform = process.platform} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.environment !== 'staging' || Object.keys(input).some(key => !['environment','serverUrl','appName','mode'].includes(key))) throw invalid();
  const appName = input.appName ?? 'Ludy Staging', mode = input.mode ?? 'remote';
  if (typeof appName !== 'string' || !appName.trim() || appName.length > 80 || /[\u0000-\u001f\u007f]/.test(appName) || !['remote','operator-local'].includes(mode)) throw invalid();
  if (mode === 'operator-local' && platform !== 'linux') throw invalid();
  if (input.serverUrl == null || input.serverUrl === '') return Object.freeze({environment:'staging', appName, mode, serverUrl:null, origin:null, configured:false, partition:'persist:ludy-staging-unconfigured'});
  const url = parsed(input.serverUrl);
  if (!url || url.pathname !== '/' || url.search || url.hash || productionHost(url.hostname)) throw invalid();
  if (mode === 'operator-local') {
    if (url.href !== 'http://127.0.0.1:4173/') throw invalid();
  } else if (url.protocol !== 'https:' || !publicHost(url.hostname)) throw invalid();
  const origin = url.origin;
  return Object.freeze({environment:'staging', appName, mode, serverUrl:origin + '/', origin, configured:true, partition:'persist:ludy-staging-' + createHash('sha256').update(origin).digest('hex').slice(0,16)});
}
function readConfig(filename, options) {
  try {
    const raw = fs.readFileSync(filename); if (raw.length > 8192) throw invalid();
    return validateConfig(JSON.parse(raw.toString('utf8')), options);
  } catch (error) { if (error.code === 'ENOENT') return validateConfig({environment:'staging',serverUrl:null,appName:'Ludy Staging'}, options); throw invalid(); }
}
function isShellURL(value) {
  const url = parsed(value);
  return !!url && url.protocol === 'ludy-client:' && url.hostname === 'shell' && !url.port && SHELL_PATHS.has(url.pathname) && !url.search && !url.hash;
}
function isTrustedURL(value, config, {blob = false} = {}) {
  const url = parsed(value); if (!url || !config?.configured) return false;
  if (url.protocol === 'blob:') {
    const inner = blob ? parsed(value.slice(5)) : null;
    return !!inner && inner.origin === config.origin && (inner.protocol === 'https:' || config.mode === 'operator-local' && inner.protocol === 'http:');
  }
  return url.origin === config.origin && (url.protocol === 'https:' || config.mode === 'operator-local' && url.protocol === 'http:');
}
function isAllowedRequest(value, resourceType, config) {
  const url = parsed(value); if (!url) return false;
  if (isShellURL(value)) return true;
  if (!config?.configured) return false;
  if (isTrustedURL(value, config, {blob:true})) return true;
  if (url.protocol === 'wss:' && config.mode === 'remote' && url.host === new URL(config.origin).host) return true;
  if (config.mode === 'operator-local' && ['http:','ws:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === '57421') return true;
  if (url.protocol === 'data:' && ['image','font'].includes(resourceType)) return true;
  if (url.protocol === 'https:' && url.hostname === 'tile.openstreetmap.org' && !url.port && resourceType === 'image') return true;
  if (url.protocol === 'https:' && url.hostname === 'photon.komoot.io' && !url.port && ['xhr','other'].includes(resourceType)) return true;
  return url.protocol === 'chrome-extension:' && value.startsWith(PDF_VIEWER_ORIGIN + '/');
}
function safeExternalURL(value) {
  const url = parsed(value); if (!url) return null;
  if (url.protocol === 'https:' && publicHost(url.hostname) && !productionHost(url.hostname)) return url.href;
  if (url.protocol === 'mailto:' && /^[^\s@/?]+@[^\s@/?]+$/.test(url.pathname) && !/%(?:0a|0d)/i.test(value)) return url.href;
  if (url.protocol === 'tel:' && /^\+?[0-9().-]{3,32}$/.test(url.pathname) && !url.search && !url.hash) return url.href;
  return null;
}
function downloadName(value) {
  const name = String(value || 'document').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f<>:"|?*]/g,'_').replace(/[. ]+$/,'').slice(0,160);
  return !name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ? 'document' : name;
}
const WEB_PREFERENCES = Object.freeze({sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,safeDialogs:true,navigateOnDragDrop:false});

module.exports = {SHELL_URL,SHELL_ORIGIN,PDF_VIEWER_ORIGIN,WEB_PREFERENCES,validateConfig,readConfig,isShellURL,isTrustedURL,isAllowedRequest,safeExternalURL,downloadName};
