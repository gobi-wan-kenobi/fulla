#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Starts a local Supabase (Docker) and loads Fulla's schema into it: the same
# supabase/migrations the Android app runs against, bundled into one setup.sql.
# Safe to run again: setup.sql skips migrations the database already has.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$here"
supabase start
node "$root/supabase/scripts/bundle.js" >/dev/null
docker exec -i supabase_db_fulla-web psql -U postgres -v ON_ERROR_STOP=1 -q < "$root/dist/setup.sql"
docker exec -i supabase_db_fulla-web psql -U postgres -q -c "notify pgrst, 'reload schema'"
echo "Migrations applied: $(docker exec supabase_db_fulla-web psql -U postgres -Atc 'select count(*) from fulla.schema_migrations' 2>/dev/null || echo '?')"
if [ ! -f .env.local ]; then
  eval "$(supabase status -o env | grep -E '^(API_URL|ANON_KEY)=')"
  printf 'NEXT_PUBLIC_SUPABASE_URL=%s\nNEXT_PUBLIC_SUPABASE_ANON_KEY=%s\n' "$API_URL" "$ANON_KEY" > .env.local
  echo "Wrote web/.env.local for the local stack."
fi
