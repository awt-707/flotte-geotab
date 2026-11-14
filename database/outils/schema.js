#!/usr/bin/env node
// Schéma de Ludy rangé par domaine (database/schema/*.sql), reconstruit depuis les migrations.
//   node database/outils/schema.js build   : base neuve = prélude + supabase/migrations/*.sql, pg_dump, découpage par domaine
//   node database/outils/schema.js check   : base A (migrations) et base B (database/schema/*.sql) doivent avoir le même catalogue
// Variables : PG_ADMIN_URL (base « postgres » du serveur de test, comme tests/setup_db.sh), PG_DUMP (chemin de pg_dump, build seulement).
// Les migrations restent la référence de la production (une par changement) ; database/schema/ est l'état final lisible, à jour par build.
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const ADMIN = process.env.PG_ADMIN_URL || 'postgresql://postgres@localhost:54322/postgres?host=/tmp';
const OUT = path.join(ROOT, 'database', 'schema'), OUT2 = path.join(ROOT, 'database', 'liens_droits');
const { DOMAINS, domainOfTable, domainOfFunction } = require('./domaines.js');

const dbUrl = name => { const u = new URL(ADMIN.replace(/^postgresql:/, 'http:')); u.pathname = '/' + name; return u.toString().replace(/^http:/, 'postgresql:'); };
const psql = (url, args, input) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
function freshDb(name, files) {
  psql(ADMIN, ['-c', `drop database if exists ${name} with (force)`, '-c', `create database ${name}`]);
  const url = dbUrl(name);
  for (const f of [path.join(ROOT, 'tests', 'lib', 'supabase_prelude.sql'), ...files]) {
    try { psql(url, ['-f', f]); } catch (e) { throw new Error(`${path.relative(ROOT, f)} : ${String(e.stderr || e.message).split('\n').filter(l => /ERROR|ERREUR/.test(l)).join(' ') || e.message}`); }
  }
  return url;
}
const migrations = () => fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort().map(f => path.join(ROOT, 'supabase', 'migrations', f));
const listSql = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d\d_.*\.sql$/.test(f)).sort().map(f => path.join(dir, f)) : [];
// structure de tous les domaines d'abord, puis clés étrangères et droits (ils relient les domaines entre eux)
const schemaFiles = () => [...listSql(OUT), ...listSql(OUT2)];

// --------------------------------------------------------------------------- découpage du pg_dump
/** Blocs du pg_dump : { name, type, sql } (chaque bloc commence par « -- Name: …; Type: …; Schema: … ») */
function blocks(dump) {
  const out = [], re = /^--\n-- (?:Data for )?Name: (.+?); Type: (.+?); Schema: (.+?); Owner: .*\n--\n/gm;
  let m, last = null;
  while ((m = re.exec(dump))) {
    if (last) last.sql = dump.slice(last.end, m.index).trim();
    last = { name: m[1], type: m[2], schema: m[3], end: re.lastIndex };
    out.push(last);
  }
  if (last) last.sql = dump.slice(last.end).trim();
  out.forEach(b => { b.sql = b.sql.split('\n').filter(l => !/^\\(un)?restrict /.test(l)).join('\n').trim(); });
  return out.filter(b => b.sql);
}
/** Domaine d'un bloc d'après sa table ou sa fonction */
function domainOf(b, seqOwner) {
  const n = b.name, t = b.type;
  const fn = s => domainOfFunction(s.replace(/^FUNCTION /, '').replace(/\(.*$/, ''));
  if (t === 'FUNCTION') return fn(n);
  if (t === 'ACL' && /^FUNCTION /.test(n)) return fn(n);
  if (t === 'ACL' && /^(TABLE|SEQUENCE) /.test(n)) { const x = n.split(' ')[1]; return domainOfTable(seqOwner[x] || x); }
  if (t === 'ACL' && /^COLUMN /.test(n)) return domainOfTable(n.split(' ')[1].split('.')[0]);
  if (t === 'COMMENT' && /^(TABLE|COLUMN) /.test(n)) return domainOfTable(n.split(' ')[1].split('.')[0]);
  if (t === 'COMMENT' && /^FUNCTION /.test(n)) return fn(n);
  if (t === 'DEFAULT ACL' || t === 'SCHEMA' || t === 'EXTENSION' || t === 'COMMENT' || (t === 'ACL' && /^SCHEMA /.test(n))) return '00';
  if (t === 'SEQUENCE' || t === 'SEQUENCE OWNED BY') return domainOfTable(seqOwner[n.split(' ')[0]] || n.split(' ')[0]);
  if (t === 'INDEX') { const m = b.sql.match(/ ON (?:ONLY )?public\.(\w+)/); return domainOfTable(m ? m[1] : n); }
  return domainOfTable(n.split(' ')[0]);   // TABLE, DEFAULT, CONSTRAINT, FK CONSTRAINT, POLICY, TRIGGER, ROW SECURITY
}
// ordre d'installation à l'intérieur d'un fichier (le pg_dump est déjà trié par dépendances)
const PHASE = { TABLE: 1, SEQUENCE: 1, 'SEQUENCE OWNED BY': 1, DEFAULT: 1, FUNCTION: 0, CONSTRAINT: 2, INDEX: 2, 'FK CONSTRAINT': 3.5, TRIGGER: 3, 'ROW SECURITY': 4, POLICY: 4, ACL: 5, COMMENT: 5, 'DEFAULT ACL': 6 };
const TITLES = { 0: 'Fonctions', 1: 'Tables', 2: 'Clés et index', 3: 'Déclencheurs', 3.5: 'Clés étrangères', 4: 'Sécurité des lignes (RLS)', 5: 'Droits et commentaires', 6: 'Droits par défaut' };

// Supabase donne par défaut tous les droits aux nouveaux objets (ALTER DEFAULT PRIVILEGES) ; le pg_dump suppose l'inverse.
// Pendant l'installation ils sont retirés : chaque objet reçoit exactement les droits écrits dans liens_droits/,
// et la section « Droits par défaut » de liens_droits/00_socle.sql remet ensuite ceux de la base d'origine.
const DEFAULTS_OFF = `-- Droits par défaut retirés pendant l'installation (remis à la fin de liens_droits/00_socle.sql)
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
`;
function build() {
  const url = freshDb('ludy_schema_build', migrations());
  const dump = execFileSync(process.env.PG_DUMP || 'pg_dump', ['--schema-only', '--no-owner', '-n', 'public', url], { encoding: 'utf8', maxBuffer: 1 << 28 });
  psql(ADMIN, ['-c', 'drop database if exists ludy_schema_build with (force)']);
  const bl = blocks(dump), seqOwner = {};
  bl.filter(b => b.type === 'SEQUENCE OWNED BY').forEach(b => { const m = b.sql.match(/OWNED BY public\.(\w+)\./); if (m) seqOwner[b.name] = m[1]; });
  bl.filter(b => b.type === 'SEQUENCE').forEach(b => { const m = b.sql.match(/AS IDENTITY|OWNED BY public\.(\w+)/); if (m && m[1]) seqOwner[b.name] = m[1]; });
  bl.filter(b => b.type === 'TABLE').forEach(b => { (b.sql.match(/SEQUENCE NAME public\.(\w+)/g) || []).forEach(s => { seqOwner[s.split('.')[1]] = b.name; }); });
  const by = {}, unknown = [];
  for (const b of bl) {
    if (b.schema !== 'public' && b.schema !== '-') continue;
    if (b.type === 'SCHEMA') continue;            // le schéma public existe déjà
    const d = domainOf(b, seqOwner);
    if (!DOMAINS[d]) { unknown.push(b.type + ' ' + b.name); continue; }
    (by[d] = by[d] || []).push(b);
  }
  if (unknown.length) throw new Error('Objets sans domaine (à ranger dans database/outils/domaines.js) :\n  ' + unknown.join('\n  '));
  [OUT, OUT2].forEach(d => { fs.mkdirSync(d, { recursive: true }); listSql(d).forEach(f => fs.unlinkSync(f)); });
  for (const d of Object.keys(DOMAINS).sort()) {
    const D = DOMAINS[d], list = (by[d] || []).map((b, i) => ({ b, i, p: PHASE[b.type] ?? 5 })).sort((x, y) => x.p - y.p || x.i - y.i);
    const tables = (by[d] || []).filter(x => x.type === 'TABLE').map(x => x.name);
    const head = part => `-- =============================================================================\n-- ${D.title}${part}\n-- ${D.about.join('\n-- ')}\n` +
      (tables.length ? `-- Tables : ${tables.join(', ')}\n` : '') +
      `-- Fichier produit par « node database/outils/schema.js build » depuis supabase/migrations/ : ne pas modifier à la main\n` +
      `-- (ajouter une migration, puis relancer build).\n-- =============================================================================\n` +
      `SET check_function_bodies = false;\nSET client_min_messages = warning;\nSELECT pg_catalog.set_config('search_path', '', false);\n`;
    const files = [[OUT, ' (structure)', x => x.p < 4 && x.b.type !== 'FK CONSTRAINT', ''], [OUT2, ' (clés étrangères et droits : RLS, règles, GRANT)', x => x.p >= 4 || x.b.type === 'FK CONSTRAINT', '']];
    for (const [dir, part, keep] of files) {
      let s = head(part), ph = -1;
      for (const x of list.filter(keep)) {
        if (x.p !== ph) { ph = x.p; s += `\n-- ----------------------------------------------------------------------------- ${TITLES[ph]}\n`; }
        s += '\n' + x.b.sql.replace(/\n{3,}/g, '\n\n') + '\n';
      }
      if (d === '00' && dir === OUT) s = s.replace(/\n(-- -{10,})/, (m, a) => '\n' + DEFAULTS_OFF + '\n' + a);
      fs.writeFileSync(path.join(dir, `${d}_${D.file}.sql`), s);
    }
  }
  console.log('database/schema/ et database/liens_droits/ : ' + Object.keys(DOMAINS).length + ' domaines, ' + bl.length + ' objets');
}

// --------------------------------------------------------------------------- comparaison de deux bases
const CATALOG = fs.readFileSync(path.join(__dirname, 'catalogue.sql'), 'utf8');
function catalog(url) {
  const rows = JSON.parse(psql(url, ['-At', '-c', `select coalesce(json_agg(z), '[]') from (${CATALOG}) z`]));
  const m = new Map(); rows.forEach(r => m.set(r.kind + ' ' + r.name, r.def)); return m;
}
function diff(a, b) {
  const out = [];
  for (const [k, v] of a) if (!b.has(k)) out.push('seulement dans A : ' + k); else if (b.get(k) !== v) out.push('différent : ' + k + '\n    A ' + v + '\n    B ' + b.get(k));
  for (const k of b.keys()) if (!a.has(k)) out.push('seulement dans B : ' + k);
  return out;
}
function check() {
  const a = freshDb('ludy_schema_a', migrations()), b = freshDb('ludy_schema_b', schemaFiles());
  const d = diff(catalog(a), catalog(b));
  psql(ADMIN, ['-c', 'drop database if exists ludy_schema_a with (force)', '-c', 'drop database if exists ludy_schema_b with (force)']);
  if (d.length) { console.error('database/schema/ ne correspond plus aux migrations (relancer « node database/outils/schema.js build ») :\n' + d.slice(0, 40).join('\n')); process.exit(1); }
  console.log('database/schema/ identique aux migrations (' + schemaFiles().length + ' fichiers)');
}

module.exports = { blocks, diff, catalog, freshDb };
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'build') build(); else if (cmd === 'check') check();
  else { console.error('usage : node database/outils/schema.js build|check'); process.exit(2); }
}
