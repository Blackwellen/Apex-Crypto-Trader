#!/usr/bin/env bash
# Usage: DATABASE_URL=postgres://... ./migrate.sh   (applies migrations/*.sql in order, once each)
set -euo pipefail
: "${DATABASE_URL:?}"
cd "$(dirname "$0")"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qc "create table if not exists schema_migrations(name text primary key, applied_at timestamptz default now())"
for f in migrations/*.sql; do
  n=$(basename "$f")
  if [ "$(psql "$DATABASE_URL" -Atc "select 1 from schema_migrations where name='$n'")" = "1" ]; then continue; fi
  echo "applying $n"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q --single-transaction -f "$f" -c "insert into schema_migrations(name) values ('$n')"
done
