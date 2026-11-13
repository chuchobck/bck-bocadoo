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

## Seguridad

Registro, login con JWT ES256, refresh rotativo, roles y tenant, rate limit. Modelo de amenazas, flujos y rotación de llaves en `docs/seguridad.md`.

    pnpm keys:generate                                   # llave JWT para .env o Render
    DEMO_PASSWORD='clave-de-10+' pnpm db:demo-passwords  # contraseña a los usuarios demo (solo desarrollo)

Endpoints nuevos: sin token no entra nadie salvo `@Public()`; los de un restaurante llevan `@Roles('DUENO', 'CAJERO')` y el encabezado `x-restaurant-id`.

## Jobs (cron)

Vencer planes y crear las particiones mensuales: `node dist/jobs/cli.js all` (Cron Job de Render con la misma imagen). Son idempotentes y se pueden correr a mano con `pnpm jobs <expire-plans|create-partitions|all>`. Detalle, configuración de Render y qué hacer si falla en `docs/jobs.md`.

## Estado y API

Estado de las fases, checklist y tabla de endpoints en `docs/estado.md`. Swagger en `/docs` (apagado en producción).

## Documentación

Decisiones de arquitectura en `docs/adr/`.
