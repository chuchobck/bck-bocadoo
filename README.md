# bck-bocadoo
Backend de Bocadoo.

## Base de datos
Postgres 16 en Neon. Esquema en `db/migrations`, datos demo en `db/seeds/demo.sql`.
Roles: `bck_api` (RLS, pooler), `bck_servicio` (BYPASSRLS), `neondb_owner` (solo migraciones).

## API (fase 2)
    pnpm install
    cp .env.example .env     # en esta fase las URLs de BD pueden ser de ejemplo
    pnpm dev                 # http://localhost:3000/health  y  /docs (Swagger)
    pnpm test

## Pruebas
    pnpm test        # unitarias y e2e, sin base de datos
    pnpm test:db     # integración (RLS, multi-tenant) contra la base de .env: Neon o un Postgres 16 local

`pnpm test:db` necesita las tres URLs de `.env` y los roles `bck_api` (sujeto a RLS) y `bck_servicio` (BYPASSRLS) con el esquema y el seed aplicados.
Con pnpm 11, si pide aprobar scripts de build: `pnpm approve-builds`.

## Migraciones
dbmate, con la conexión **directa** de `neondb_owner` (`DATABASE_MIGRATE_URL` en `.env`, sin `-pooler`).

    pnpm db:status       # qué está aplicado y qué falta
    pnpm db:migrate      # aplica las pendientes
    pnpm db:new nombre   # crea una migración nueva
    pnpm db:rollback     # revierte la última
    pnpm db:baseline     # una sola vez: registra la baseline aplicada a mano con psql

## Documentación
Decisiones de arquitectura en `docs/adr/`.

