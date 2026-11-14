#!/usr/bin/env node
// Production ↔ dépôt (lecture seule sur la production, par l'API de gestion Supabase).
//   node database/outils/production.js ecarts   : catalogue de la production comparé à une base neuve = migrations + database/modules/*.sql
//   node database/outils/production.js extraire : réécrit database/modules/bureau_raphael.sql et database/plateforme/stockage.sql depuis la production
// Jeton : SUPABASE_ACCESS_TOKEN (supabase.com > Account > Access Tokens ; dans une session Claude, injecté par le proxy).
// Projet : SUPABASE_REF (cgiiwumbblimvmrypxlc par défaut). Les requêtes sont envoyées en lecture seule (read_only).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const REF = process.env.SUPABASE_REF || 'cgiiwumbblimvmrypxlc';
const { DOMAINS } = require('./domaines.js');
const LUDY_TABLES = new Set(Object.values(DOMAINS).flatMap(d => d.tables));
const LUDY_FUNCS = new Set(Object.values(DOMAINS).flatMap(d => d.functions));

async function prod(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + (process.env.SUPABASE_ACCESS_TOKEN || 'proxy'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: true }) });
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error('API Supabase : ' + JSON.stringify(d).slice(0, 500));
  return d;
}
const L = xs => 'array[' + [...xs].map(x => "'" + x.replace(/'/g, "''") + "'").join(',') + ']::text[]';
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";

/** Objets de la production qui ne sont pas à Ludy (application de bureau) : tables, fonctions, déclencheurs, colonnes ajoutées aux tables de Ludy */
async function foreignObjects() {
  const tabs = (await prod("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1")).map(r => r.relname).filter(t => !LUDY_TABLES.has(t));
  const fns = [...new Set((await prod("select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1")).map(r => r.proname))].filter(f => !LUDY_FUNCS.has(f));
  const trg = (await prod("select c.relname || '.' || t.tgname n, c.relname t from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal order by 1"))
    .filter(r => !LUDY_TABLES.has(r.t) || !localTriggers().has(r.n)).map(r => r.n);
  return { tabs, fns, trg };
}
let _lt = null;
function localTriggers() {   // déclencheurs de Ludy = ceux du schéma rangé
  if (_lt) return _lt; _lt = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'database', 'schema'))) {
    for (const m of fs.readFileSync(path.join(ROOT, 'database', 'schema', f), 'utf8').matchAll(/CREATE (?:CONSTRAINT )?TRIGGER (\w+) .*? ON public\.(\w+)/g)) _lt.add(m[2] + '.' + m[1]);
  }
  return _lt;
}

/** DDL exact d'un ensemble de tables / fonctions / déclencheurs, lu dans le catalogue de la production */
async function ddl(tables, fns, trgs) {
  const cols = await prod(`select c.relname t, a.attnum n, quote_ident(a.attname) col, format_type(a.atttypid, a.atttypmod) typ, a.attnotnull nn,
    pg_get_expr(d.adbin, d.adrelid) def, a.attidentity idn, a.attgenerated gen
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname = any(${L(tables)}) order by 1, 2`);
  const cons = await prod(`select c.relname t, co.conname n, co.contype ty, pg_get_constraintdef(co.oid) def from pg_constraint co join pg_class c on c.oid = co.conrelid
    where c.relnamespace = 'public'::regnamespace and c.relname = any(${L(tables)}) order by 1, case co.contype when 'p' then 0 when 'u' then 1 when 'c' then 2 when 'x' then 3 else 4 end, 2`);
  const idx = await prod(`select i.indexdef def from pg_indexes i where i.schemaname = 'public' and i.tablename = any(${L(tables)})
    and not exists (select 1 from pg_constraint co where co.conname = i.indexname and co.connamespace = 'public'::regnamespace) order by i.tablename, i.indexname`);
  const rls = await prod(`select relname t, relrowsecurity r, relforcerowsecurity f from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(${L(tables)}) order by 1`);
  const pol = await prod(`select tablename t, policyname n, permissive p, roles::text roles, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = any(${L(tables)}) order by 1, 2`);
  const acl = await prod(`select c.relname t, a.grantee::regrole::text g, string_agg(a.privilege_type, ', ' order by a.privilege_type) p
    from pg_class c, aclexplode(c.relacl) a where c.relnamespace = 'public'::regnamespace and c.relname = any(${L(tables)}) and a.grantee <> 0 and a.grantee <> c.relowner and a.privilege_type <> 'MAINTAIN' group by 1, 2 order by 1, 2`);
  const cacl = await prod(`select c.relname t, quote_ident(at.attname) col, x.grantee::regrole::text g, string_agg(x.privilege_type, ', ' order by x.privilege_type) p
    from pg_class c join pg_attribute at on at.attrelid = c.oid, aclexplode(at.attacl) x where c.relnamespace = 'public'::regnamespace and c.relname = any(${L(tables)}) and x.grantee <> 0 group by 1, 2, 3 order by 1, 2, 3`);
  const fdef = await prod(`select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def,
    (select json_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end order by 1) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner) ex
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any(${L(fns)}) order by p.proname, 1`);
  const tdef = await prod(`select c.relname t, tg.tgname n, pg_get_triggerdef(tg.oid) def, tg.tgenabled::text en from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
    where c.relnamespace = 'public'::regnamespace and not tg.tgisinternal and (c.relname || '.' || tg.tgname) = any(${L(trgs)}) order by 1, 2`);
  const o = [], by = {};
  cols.forEach(c => (by[c.t] = by[c.t] || []).push(c));
  o.push('-- ----------------------------------------------------------------------------- Tables');
  for (const t of tables) {
    if (!by[t]) continue;
    const ls = by[t].map(c => '  ' + c.col + ' ' + c.typ + (c.gen === 's' ? ` generated always as (${c.def}) stored` : c.def != null ? ' default ' + c.def : '') +
      (c.idn === 'a' ? ' generated always as identity' : c.idn === 'd' ? ' generated by default as identity' : '') + (c.nn ? ' not null' : ''));
    o.push(`\ncreate table public.${t} (\n${ls.join(',\n')}\n);`);
  }
  o.push('\n-- ----------------------------------------------------------------------------- Fonctions');
  fdef.forEach(f => o.push('\n' + f.def.trim() + ';'));
  fdef.forEach(f => { o.push(`revoke all on function public.${f.sig.replace(/^public\./, '')} from public, anon, authenticated, service_role;`);
    (f.ex || []).forEach(g => o.push(`grant execute on function public.${f.sig.replace(/^public\./, '')} to ${g};`)); });
  o.push('\n-- ----------------------------------------------------------------------------- Clés, contrôles et index');
  cons.filter(c => c.ty !== 'f').forEach(c => o.push(`alter table public.${c.t} add constraint ${c.n} ${c.def};`));
  idx.forEach(i => o.push(i.def + ';'));
  o.push('\n-- ----------------------------------------------------------------------------- Clés étrangères');
  cons.filter(c => c.ty === 'f').forEach(c => o.push(`alter table public.${c.t} add constraint ${c.n} ${c.def};`));
  o.push('\n-- ----------------------------------------------------------------------------- Déclencheurs');
  tdef.forEach(t => { o.push(t.def + ';'); if (t.en === 'D') o.push(`alter table public.${t.t} disable trigger ${t.n};   -- désactivé en production`); });
  o.push('\n-- ----------------------------------------------------------------------------- Sécurité des lignes et droits');
  rls.forEach(r => { if (r.r) o.push(`alter table public.${r.t} enable row level security;`); if (r.f) o.push(`alter table public.${r.t} force row level security;`); });
  pol.forEach(p => { const roles = p.roles.replace(/[{}]/g, '').split(',').join(', ');
    o.push(`create policy ${/^[a-z_][a-z0-9_]*$/.test(p.n) ? p.n : '"' + p.n.replace(/"/g, '""') + '"'} on public.${p.t} as ${p.p.toLowerCase()} for ${p.cmd.toLowerCase()} to ${roles}` +
      (p.qual ? ` using (${p.qual})` : '') + (p.with_check ? ` with check (${p.with_check})` : '') + ';'); });
  tables.filter(t => by[t]).forEach(t => o.push(`revoke all on public.${t} from anon, authenticated, service_role;`));
  acl.forEach(a => o.push(`grant ${a.p.toLowerCase()} on public.${a.t} to ${a.g};`));
  cacl.forEach(a => o.push(`grant ${a.p.toLowerCase()} (${a.col}) on public.${a.t} to ${a.g};`));
  return o.join('\n');
}

async function extraire() {
  const { tabs, fns, trg } = await foreignObjects();
  // colonnes et contraintes ajoutées aux tables de Ludy, fonctions de Ludy remplacées
  const local = new Set(fs.readdirSync(path.join(ROOT, 'database', 'schema')).flatMap(f => [...fs.readFileSync(path.join(ROOT, 'database', 'schema', f), 'utf8')
    .matchAll(/^CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/gm)].flatMap(m => m[2].split('\n').map(l => l.trim().split(' ')[0]).filter(Boolean).map(c => m[1] + '.' + c.replace(/"/g, '')))));
  const xcols = (await prod(`select c.relname t, quote_ident(a.attname) col, a.attname raw, format_type(a.atttypid, a.atttypmod) typ, a.attnotnull nn, pg_get_expr(d.adbin, d.adrelid) def
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname = any(${L(LUDY_TABLES)}) order by 1, a.attnum`)).filter(c => !local.has(c.t + '.' + c.raw));
  const xcons = (await prod(`select c.relname t, co.conname n, pg_get_constraintdef(co.oid) def, (select array_agg(attname::text) from pg_attribute where attrelid = c.oid and attnum = any(co.conkey)) k
    from pg_constraint co join pg_class c on c.oid = co.conrelid where c.relnamespace = 'public'::regnamespace and c.relname = any(${L(LUDY_TABLES)})`))
    .filter(c => (c.k || []).some(k => xcols.some(x => x.t === c.t && x.raw === k)));
  // fonctions de Ludy dont la définition en production n'est pas celle des migrations (remplacées par l'application de bureau)
  const { freshDb } = require('./schema.js'), { execFileSync } = require('child_process');
  const url = freshDb('ludy_prod_extract', fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort().map(f => path.join(ROOT, 'supabase', 'migrations', f)));
  const hq = "select p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) h from pg_proc p where p.pronamespace = 'public'::regnamespace";
  const mine = new Map(JSON.parse(execFileSync('psql', [url, '-At', '-c', `select coalesce(json_agg(z), '[]') from (${hq}) z`], { encoding: 'utf8' })).map(r => [r.sig, r.h]));
  const over = (await prod(`select p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) h, pg_get_functiondef(p.oid) def from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any(${L(LUDY_FUNCS)}) order by 1`)).filter(f => mine.has(f.sig) && mine.get(f.sig) !== f.h);
  const head = `-- =============================================================================
-- Module de l'application de bureau (Raphael) : objets de la production qui ne viennent pas des migrations de Ludy.
-- Copie exacte du catalogue de la production (${new Date().toISOString().slice(0, 10)}), produite par « node database/outils/production.js extraire » :
-- ne pas modifier à la main. À installer après database/schema/ et database/liens_droits/ (même base).
-- Contenu : ${tabs.length} tables, ${fns.length} fonctions, ${trg.length} déclencheurs, ${xcols.length} colonnes ajoutées aux tables de Ludy.
-- Attention : ce module remplace aussi des fonctions de Ludy (section « Fonctions de Ludy remplacées ») : une migration de Ludy
-- qui les redéfinit efface la version de l'application de bureau, et inversement.
-- =============================================================================
set check_function_bodies = false;
set client_min_messages = warning;

-- ----------------------------------------------------------------------------- Colonnes ajoutées aux tables de Ludy
${xcols.map(c => `alter table public.${c.t} add column if not exists ${c.col} ${c.typ}${c.def != null ? ' default ' + c.def : ''}${c.nn ? ' not null' : ''};`).join('\n')}
${xcons.map(c => `alter table public.${c.t} add constraint ${c.n} ${c.def};`).join('\n')}
`;
  const body = await ddl(tabs, fns, trg);
  const tail = `\n\n-- ----------------------------------------------------------------------------- Fonctions de Ludy remplacées par l'application de bureau\n` +
    over.map(f => f.def.trim() + ';').join('\n\n') +
    `\n\n-- ----------------------------------------------------------------------------- Temps réel\ndo $$ begin\n  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then\n` +
    (await prod("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1")).filter(r => !LUDY_TABLES.has(r.tablename))
      .map(r => `    alter publication supabase_realtime add table public.${r.tablename};\n`).join('') + '  end if;\nend $$;\n';
  // fonctions de Ludy remplacées et temps réel avant les déclencheurs (certains déclencheurs du module visent les tables de Ludy)
  fs.mkdirSync(path.join(ROOT, 'database', 'modules'), { recursive: true });
  const mark = '\n-- ----------------------------------------------------------------------------- Déclencheurs';
  fs.writeFileSync(path.join(ROOT, 'database', 'modules', 'bureau_raphael.sql'), head + '\n' + body.replace(mark, () => tail + mark) + '\n');

  // stockage : seaux et règles de storage.objects (Supabase seulement)
  const buckets = await prod('select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id');
  const spol = await prod("select policyname n, permissive p, roles::text roles, cmd, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1");
  const st = `-- =============================================================================
-- Stockage des fichiers (Supabase Storage) : seaux et règles d'accès, copie de la production (${new Date().toISOString().slice(0, 10)}).
-- Produit par « node database/outils/production.js extraire ». Sans Supabase (schéma storage absent), ce fichier ne fait rien :
-- les mêmes règles sont à reproduire dans le service de fichiers choisi (voir database/OVH.md).
-- =============================================================================
do $$ begin
  if to_regclass('storage.buckets') is null then raise notice 'pas de Supabase Storage : rien à faire'; return; end if;
${buckets.map(b => `  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values (${lit(b.id)}, ${lit(b.id)}, ${b.public}, ${b.file_size_limit ?? 'null'}, ${b.allowed_mime_types ? lit('{' + b.allowed_mime_types.join(',') + '}') : 'null'}) on conflict (id) do nothing;`).join('\n')}
${spol.map(p => `  execute ${lit('drop policy if exists ' + p.n + ' on storage.objects')};\n  execute ${lit(`create policy ${p.n} on storage.objects as ${p.p.toLowerCase()} for ${p.cmd.toLowerCase()} to ${p.roles.replace(/[{}]/g, '')}` + (p.qual ? ` using (${p.qual})` : '') + (p.with_check ? ` with check (${p.with_check})` : ''))};`).join('\n')}
end $$;
`;
  fs.mkdirSync(path.join(ROOT, 'database', 'plateforme'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'database', 'plateforme', 'stockage.sql'), st);
  console.log(`module de bureau : ${tabs.length} tables, ${fns.length} fonctions, ${trg.length} déclencheurs, ${xcols.length} colonnes ajoutées, ${over.length} fonctions de Ludy remplacées ; stockage : ${buckets.length} seaux, ${spol.length} règles`);
}

async function ecarts() {
  const { freshDb, catalog, diff } = require('./schema.js');
  const files = [...fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql')).sort().map(f => path.join(ROOT, 'supabase', 'migrations', f)),
    ...fs.readdirSync(path.join(ROOT, 'database', 'modules')).filter(f => f.endsWith('.sql')).sort().map(f => path.join(ROOT, 'database', 'modules', f))];
  const url = freshDb('ludy_prod_compare', files);
  const local = catalog(url);
  const rows = await prod(fs.readFileSync(path.join(__dirname, 'catalogue.sql'), 'utf8'));
  const remote = new Map(); rows.forEach(r => remote.set(r.kind + ' ' + r.name, r.def));
  // différences sans portée : droit MAINTAIN (PostgreSQL 17), parenthèses des contrôles, extensions et règles du stockage propres à Supabase
  const norm = (k, v) => { v = v || ''; if (/^(acl|col) /.test(k)) v = v.replace(/(=[a-zA-Z]*)m\//g, (m, a) => a.replace('m', '') + '/').split(',').filter(x => !/^(anon|authenticated|service_role)=\//.test(x)).join(',');
    if (/^con /.test(k)) v = v.replace(/[()]/g, ''); return v; };
  const keep = k => !/^(ext|pub) /.test(k) && !/^pol storage\./.test(k);
  const A = new Map([...remote].filter(([k]) => keep(k)).map(([k, v]) => [k, norm(k, v)])), B = new Map([...local].filter(([k]) => keep(k)).map(([k, v]) => [k, norm(k, v)]));
  const d = diff(A, B);
  console.log(d.length ? `${d.length} écarts (A = production, B = dépôt) :\n` + d.join('\n') : 'production identique au dépôt (migrations + modules)');
  process.exitCode = d.length ? 1 : 0;
}

if (require.main === module) {
  const cmd = process.argv[2];
  (cmd === 'extraire' ? extraire() : cmd === 'ecarts' ? ecarts() : Promise.reject(new Error('usage : node database/outils/production.js ecarts|extraire')))
    .catch(e => { console.error(e.message); process.exit(2); });
}
