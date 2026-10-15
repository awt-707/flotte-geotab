#!/usr/bin/env bash
# Base de test vierge imitant Supabase : rôles, schéma auth, migrations, 2 comptes de test, puis PostgREST sur le port 3001.
# Local : PG_ADMIN_URL / PG_URL par défaut sur le Postgres de test (socket /tmp, port 54322). CI : variables fournies par le workflow.
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN_URL=${PG_ADMIN_URL:-"postgresql://postgres@localhost:54322/postgres?host=/tmp"}
DB_URL=${PG_URL:-"postgresql://postgres@localhost:54322/flotte?host=/tmp"}
AUTH_URI=${PGRST_DB_URI:-"postgresql://authenticator:authpass@localhost:54322/flotte?host=/tmp"}
q() { psql "$1" -v ON_ERROR_STOP=1 -q "${@:2}"; }
q "$ADMIN_URL" -c "drop database if exists flotte with (force)" -c "create database flotte"
q "$DB_URL" -f tests/lib/supabase_prelude.sql
q "$DB_URL" -c "alter role authenticator password 'authpass'"
for f in supabase/migrations/*.sql; do echo "migration $f"; q "$DB_URL" -f "$f"; done
# 1er compte = administrateur, le 2e reste « en attente »
q "$DB_URL" -c "insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'admin@x')" \
            -c "insert into auth.users (id, email) values ('22222222-2222-2222-2222-222222222222', 'new@x')"
pkill -x postgrest 2>/dev/null || true
PGRST_DB_URI="$AUTH_URI" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_DB_MAX_ROWS=1000 PGRST_SERVER_PORT=3001 \
PGRST_JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long" \
  nohup "${POSTGREST_BIN:-postgrest}" > "${TMPDIR:-/tmp}/postgrest.log" 2>&1 &
for i in $(seq 1 30); do curl -sf http://localhost:3001/ >/dev/null && break; sleep 0.5; done
curl -sf http://localhost:3001/ >/dev/null || { cat "${TMPDIR:-/tmp}/postgrest.log"; exit 1; }
echo "Base de test prête (PostgREST sur :3001)"
