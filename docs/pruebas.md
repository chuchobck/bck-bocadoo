# Pruebas y bases de datos

Regla: **ninguna prueba corre contra Neon**. Las de integración van contra un Postgres 16 local (`bocadoo-test-pg` en tu máquina, el servicio `postgres` en CI). Las migraciones sí se aplican a Neon, pero solo a propósito (`--remoto`).

## Comandos

| Qué                                     | Comando                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Unitarias y e2e (sin base)              | `pnpm test`                                                                                                     |
| Integración completa en local           | `pnpm test:db:local`                                                                                            |
| Una suite (o varias)                    | `pnpm test:db:local test/integration/auth.int.ts`                                                               |
| Migraciones pendientes en la base local | `DATABASE_MIGRATE_URL='postgresql://postgres:postgres@localhost:55432/bocadoo?sslmode=disable' pnpm db:migrate` |
| Estado de Neon (lectura, a propósito)   | `pnpm db:status --remoto`                                                                                       |
| Aplicar a Neon (desde la rama)          | `pnpm db:migrate --remoto`                                                                                      |

`pnpm test:db` sigue existiendo (lo usa CI con sus variables), pero **ya no lee `.env`**: sin URLs en el entorno aborta.

## bocadoo-test-pg

Postgres 16 en Docker, puerto **55432** (no choca con otro Postgres en 5432), zona horaria UTC como Neon y CI (las pruebas de `jobs` lo asumen).

Cada día, si está detenido (por ejemplo después de reiniciar WSL o Docker):

```bash
docker start bocadoo-test-pg
```

Crearlo desde cero (la primera vez, o para descartarlo con `docker rm -f bocadoo-test-pg`):

```bash
docker run -d --name bocadoo-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bocadoo -p 55432:5432 postgres:16
# Esquema (todas las migraciones)
DATABASE_MIGRATE_URL='postgresql://postgres:postgres@localhost:55432/bocadoo?sslmode=disable' pnpm db:migrate
# Roles de la API (las mismas claves que CI; solo valen en este contenedor) y seed demo
docker exec -i bocadoo-test-pg psql -U postgres -d bocadoo -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE bck_api LOGIN PASSWORD 'apipw' IN ROLE bocadoo_app;
CREATE ROLE bck_servicio LOGIN PASSWORD 'svcpw' BYPASSRLS IN ROLE bocadoo_servicio;
SQL
docker exec -i bocadoo-test-pg psql -U postgres -d bocadoo -v ON_ERROR_STOP=1 -q < db/seeds/demo.sql
```

Después de crear una migración nueva, aplícala aquí (comando de migraciones locales de la tabla) antes de correr las suites.

Las suites de concurrencia clonan la base (`CREATE DATABASE … TEMPLATE`, ver `test/integration/scratch-db.ts`): mientras corren, no dejes un `psql` ni un IDE conectado a `bocadoo`.

### Si las suites de QR fallan al azar

Comprueba primero el reloj. Síntoma: `QR_INVALIDO` o `QR_EXPIRADO` sueltos (o cuentas que "faltan" porque su validación no pasó), y la hora de `date -u` distinta de la real. El código del pase cambia cada 30 s y el servidor solo acepta ±1 paso: un salto de reloj de minutos invalida el código entre emitirlo y validarlo.

```bash
date -u +%T; powershell.exe -NoProfile -c "[DateTime]::UtcNow.ToString('HH:mm:ss')"    # deben coincidir con la hora real
journalctl -b | grep -c "Clock change detected"                                       # debe quedarse quieto
```

Visto en WSL (2026-11-22): el reloj de Windows iba 6 min 10 s adelantado (servicio `w32time` detenido); Hyper-V empujaba esa hora a WSL y `systemd-timesyncd` la devolvía a la de NTP cada 5 s. Se arregla en Windows (PowerShell como administrador): `Set-Service w32time -StartupType Automatic; Start-Service w32time; w32tm /resync /force`, y luego `wsl --shutdown`.

## Qué hace `pnpm test:db:local`

`scripts/test-db-local.sh`:

1. Borra del entorno las `PGHOST`, `PGPORT`, `PGSERVICE`… y cualquier `DATABASE_*` / `PROBE_*` heredada.
2. Exporta las cuatro URLs a `localhost:55432` (`BOCADOO_TEST_PG_PORT` cambia el puerto), `NODE_ENV=test` y `LOG_LEVEL=silent`.
3. Revisa el host **parseado** de cada variable con `node scripts/db-guard.mjs check`.
4. Si `bocadoo-test-pg` existe y está detenido, avisa y sale.
5. Corre `vitest --config vitest.db.config.ts` con los argumentos que le pases.

## Barreras

Todas usan `scripts/db-guard.mjs` (probado en `test/unit/db-guard.spec.ts`). El host se obtiene **parseando** la URL como lo hace `pg` (`new URL`, más `?host=` y `?hostaddr=`, que pisan al host de la URL), nunca buscando texto: `postgresql://…@ep-x.neon.tech/neondb?x=localhost:55432` contiene "localhost" y va a Neon. Local es `localhost`, `127.x.x.x`, `::1` (también `::ffff:127.x.x.x`) o un socket Unix. Una URL sin host o ilegible cuenta como no local.

1. **`vitest.db.config.ts` no lee `.env`** y su `globalSetup` (`test/integration/global-setup.ts`) aborta toda la corrida, antes de cargar cualquier suite, si alguna `DATABASE_*`, `PROBE_*`, `PGHOST` o `PGHOSTADDR` no es local, o si faltan `DATABASE_URL` / `DATABASE_SERVICE_URL`.
2. **Segunda barrera, ya conectado**: el mismo `globalSetup` se conecta con cada URL y aborta si el servidor define `neon.tenant_id` (un túnel o port-forward a Neon en `localhost` pasaría la primera).
3. **`src/jobs/cli.ts`** solo carga `.env` cuando se lanza como proceso; importado desde las pruebas (`jobs-concurrency.int.ts`) ya no puede meter las URLs de `.env` en el worker.
4. **`scripts/db.mjs`** imprime siempre `Destino: host/base (local|REMOTO)`. En local corre sin banderas (y se niega si el servidor resulta ser Neon). Si no es local:
   - exige `--remoto`;
   - se niega si `git status` muestra cambios en `db/migrations/` (modificados, en stage o sin seguimiento): lo que se aplica es lo que está commiteado;
   - pide escribir el host exacto; si no coincide o stdin se cierra, no hace nada.
   - **No exige estar en `main`**: el flujo aplica la migración a Neon desde la rama, antes del merge.
   - `db:new` no se conecta: solo crea el archivo.
5. **`scripts/load-seed.mjs`** (crea miles de filas para la prueba de carga) imprime el destino y, si no es local, exige `--remoto` y escribir el host.

`vitest.config.ts` (unitarias) no lee `.env` y fija sus URLs a `localhost`; ninguna unitaria se conecta.

## Lo que sigue leyendo `.env`

A propósito, porque su destino normal es Neon: `pnpm dev` / `node dist/main.js`, `pnpm jobs`, `scripts/db.mjs` (para `--remoto`) y `pnpm db:demo-passwords` (pone contraseñas a los usuarios demo; solo actualiza hashes de `@demo.bocadoo.test`).
