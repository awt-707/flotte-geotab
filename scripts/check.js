// Contrôles rapides avant tests : syntaxe, fonctions appelées mais jamais définies, versions CDN, aucune clé secrète publiée
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const errors = [], ok = m => console.log('  ok  ' + m), fail = m => errors.push(m);

// 1. Syntaxe
for (const f of ['collector/dist/Collecteur.gs', 'site/app.js', 'site/cache.js', 'site/lib.js', 'site/report.js', 'site/pages2.js', 'site/direct.js', 'site/adresses.js', 'site/manifeste.js', 'site/contrat_modele.js', 'site/contrat_pdf.js', 'site/contrat.js', 'site/courses.js', 'site/caisse_calc.js', 'site/caisse.js', 'site/plan_calc.js', 'site/plan.js', 'site/planning.js', 'site/connexions.js', 'site/config.js', 'collector/loader/Code.gs']) {
  try { new vm.Script(read(f), { filename: f }); ok('syntaxe ' + f); } catch (e) { fail('syntaxe ' + f + ' : ' + e.message); }
}

// 2. Collecteur : chaque fonction utilitaire appelée (nom_) est définie
const code = read('collector/dist/Collecteur.gs');
const defined = new Set([...code.matchAll(/^\s*(?:function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=)/gm)].map(m => m[1] || m[2]));
const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'/g, "''");
const called = new Set([...noComments.matchAll(/(?<![.\w$])([A-Za-z][A-Za-z0-9]*_)\s*\(/g)].map(m => m[1]));
const missing = [...called].filter(f => !defined.has(f));
missing.length ? fail('fonctions appelées mais non définies : ' + missing.join(', ')) : ok(called.size + ' fonctions internes appelées, toutes définies');

// 3. Versions des bibliothèques du site = versions épinglées dans package.json (celles testées)
const pkg = JSON.parse(read('package.json')).devDependencies, html = read('site/index.html') + read('site/contrat.js');   // contrat.js : bibliothèques chargées à la demande
for (const m of html.matchAll(/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/"]+)\//g)) {
  pkg[m[1]] === m[2] ? ok('CDN ' + m[1] + '@' + m[2]) : fail('CDN ' + m[1] + '@' + m[2] + ' différent de package.json (' + pkg[m[1]] + ')');
}

// 4. Clé publique du site : rôle « anon » uniquement
const cfg = read('site/config.js'), key = (cfg.match(/"SUPABASE_ANON_KEY":\s*"([^"]+)"/) || [])[1] || '';
let role = '';
if (/^sb_publishable_/.test(key)) role = 'anon';
else try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch (e) { }
role === 'anon' ? ok('site/config.js : clé publique (anon)') : fail('site/config.js : la clé doit être la clé anon / publishable (rôle trouvé : ' + (role || 'illisible') + ')');

// 5. Aucune clé secrète dans les fichiers suivis
const walk = d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  if (/^(node_modules|\.git|tests\/out|collector\/dist|desktop\/src-tauri\/target)$/.test(p) || /\.(gz|png|jpg|xlsx)$/.test(p)) return [];
  return e.isDirectory() ? walk(p) : [p];
});
const leaks = walk('.').filter(f => !/^tests\/lib\/.*\.jwt$/.test(f)).filter(f => {
  const t = read(f);
  if (/sb_secret_[A-Za-z0-9]/.test(t)) return true;
  return [...t.matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)].some(m => {
    try { const p = JSON.parse(Buffer.from(m[1], 'base64url').toString()); return p.role === 'service_role' && p.iss === 'supabase' && p.ref; } catch (e) { return false; }
  });
});
leaks.length ? fail('clé secrète trouvée dans : ' + leaks.join(', ')) : ok('aucune clé secrète dans le dépôt');

if (errors.length) { console.error('\n' + errors.map(e => '  ERREUR  ' + e).join('\n')); process.exit(1); }
console.log('\nContrôles OK');
