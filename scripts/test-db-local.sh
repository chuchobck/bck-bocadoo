#!/usr/bin/env bash
# Corre las suites de integración contra bocadoo-test-pg (Postgres 16 en Docker, puerto 55432). Nunca lee .env.
# Uso: pnpm test:db:local [archivos o filtros de vitest]     p. ej.  pnpm test:db:local test/integration/auth.int.ts
# Levantar el contenedor y prepararlo: docs/pruebas.md.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${BOCADOO_TEST_PG_PORT:-55432}"
BASE="localhost:${PORT}/bocadoo?sslmode=disable"

# Sin variables heredadas que puedan desviar la conexión (libpq/pg las usan como respaldo).
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE
# Ni otras DATABASE_* / PROBE_* del shell: solo las de abajo.
for name in $(compgen -e); do
  case "$name" in DATABASE_* | PROBE_*) unset "$name" ;; esac
done

export NODE_ENV=test
export LOG_LEVEL=silent
export DATABASE_URL="postgresql://bck_api:apipw@${BASE}"
export DATABASE_SERVICE_URL="postgresql://bck_servicio:svcpw@${BASE}"
export DATABASE_MIGRATE_URL="postgresql://postgres:postgres@${BASE}"
export PROBE_DATABASE_URL="postgresql://postgres:postgres@${BASE}"

# Chequeo del host PARSEADO (el mismo de vitest y db.mjs), no búsqueda de texto: aborta si algo apunta fuera.
node scripts/db-guard.mjs check

if command -v docker >/dev/null 2>&1 && docker inspect bocadoo-test-pg >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' bocadoo-test-pg)" != "true" ]; then
    echo "bocadoo-test-pg está detenido: docker start bocadoo-test-pg" >&2
    exit 1
  fi
fi

exec pnpm exec vitest run --config vitest.db.config.ts "$@"
