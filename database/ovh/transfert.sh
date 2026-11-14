#!/usr/bin/env bash
# Reprise des données de Supabase (flotte_luxury) vers la nouvelle base, déjà installée par database/installer.sh.
#   SOURCE_URL=postgresql://postgres.<ref>:…@<pooler>:5432/postgres   (Supabase > Connect > Session pooler ; mot de passe de la base)
#   CIBLE_URL=postgresql://postgres:…@<serveur OVH>:5432/postgres
#   bash database/ovh/transfert.sh [--avec-comptes]
# --avec-comptes : copie aussi les comptes (auth.users, auth.identities : mots de passe chiffrés gardés, personne n'a à recréer son compte).
#                  Seulement vers un Supabase auto-hébergé (même schéma auth). Vers un autre service de connexion : voir database/OVH.md.
# Les fichiers (PDF, justificatifs…) se copient à part : node database/ovh/copie_fichiers.js
# À lancer site et collecteur arrêtés (ou pendant une heure creuse) : ce qui est écrit pendant la copie n'est pas repris.
set -euo pipefail
: "${SOURCE_URL:?SOURCE_URL manquante}" "${CIBLE_URL:?CIBLE_URL manquante}"
AUTH=0; [ "${1:-}" = "--avec-comptes" ] && AUTH=1
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
echo "→ export des données (schéma public)"
pg_dump "$SOURCE_URL" --data-only --schema=public --no-owner --no-privileges -Fc -f "$D/public.dump"
if [ "$AUTH" = 1 ]; then
  echo "→ export des comptes"
  pg_dump "$SOURCE_URL" --data-only --table=auth.users --table=auth.identities --no-owner --no-privileges -Fc -f "$D/auth.dump"
  pg_restore -d "$CIBLE_URL" --data-only --disable-triggers --no-owner "$D/auth.dump"
fi
echo "→ import (déclencheurs coupés pendant la copie : historique et gardes déjà appliqués à la source)"
pg_restore -d "$CIBLE_URL" --data-only --disable-triggers --no-owner "$D/public.dump"
echo "→ compteurs des identifiants remis au plus haut"
psql "$CIBLE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
do $$ declare r record; m bigint; begin
  for r in select s.relname seq, t.relname tab, a.attname col from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
    join pg_class t on t.oid = d.refobjid join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where s.relkind = 'S' and s.relnamespace = 'public'::regnamespace loop
    execute format('select max(%I) from public.%I', r.col, r.tab) into m;
    if m is not null then perform setval('public.' || quote_ident(r.seq), m); end if;
  end loop;
end $$;
analyze;
SQL
echo "Données reprises. Comparer le nombre de lignes : psql \"\$SOURCE_URL\" et \"\$CIBLE_URL\" -c \"select relname, n_live_tup from pg_stat_user_tables order by 1\""
