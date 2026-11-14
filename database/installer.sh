#!/usr/bin/env bash
# Installe la base de Ludy dans une base PostgreSQL vide (nouveau serveur, OVH, base d'essai).
#   DB_URL=postgresql://postgres:…@hôte:5432/postgres bash database/installer.sh [--hors-supabase] [--sans-module-bureau]
# Ordre : (rôles hors Supabase) → structure de chaque domaine → clés étrangères et droits → module de bureau → stockage → temps réel.
# Ne touche pas aux données : les reprendre ensuite avec database/ovh/transfert.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DB_URL:?DB_URL (adresse de la base cible) manquante}"
HORS=0; MODULE=1
for a in "$@"; do case "$a" in --hors-supabase) HORS=1 ;; --sans-module-bureau) MODULE=0 ;; *) echo "option inconnue : $a"; exit 2 ;; esac; done
run() { echo "→ $1"; psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$1"; }
[ "$HORS" = 1 ] && run database/plateforme/roles_hors_supabase.sql
for f in database/schema/*.sql database/liens_droits/*.sql; do run "$f"; done
[ "$MODULE" = 1 ] && for f in database/modules/*.sql; do run "$f"; done
run database/plateforme/stockage.sql
run database/plateforme/temps_reel.sql
psql "$DB_URL" -q -c "notify pgrst, 'reload schema'" >/dev/null 2>&1 || true
echo "Base de Ludy installée. Vérifier : node database/outils/schema.js check (dépôt) ; reprendre les données : database/ovh/transfert.sh"
