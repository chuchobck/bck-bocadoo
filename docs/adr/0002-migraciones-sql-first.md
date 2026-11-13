# ADR 0002: migraciones SQL-first con dbmate

- Estado: aceptada
- Fecha: 2026-11-13

## Contexto

El esquema usa RLS, triggers, particiones y funciones. Los ORM con migraciones generadas (Prisma Migrate) pelean con eso y esconden el SQL real.

## Decisión

- El SQL es la fuente de verdad: archivos `db/migrations/AAAAMMDDHHMMSS_nombre.sql` con `-- migrate:up` y `-- migrate:down`, aplicados con **dbmate**.
- Una migración ya aplicada **no se edita**: se crea otra nueva.
- Se aplican con la conexión **directa** de `neondb_owner` (`DATABASE_MIGRATE_URL`); el DDL no pasa por el pooler. La API nunca migra.
- La baseline (`20261112000000`) se aplicó a mano con psql y se registra con `pnpm db:baseline` sin volver a ejecutarla.
- Toda tabla nueva trae en su migración RLS y sus `GRANT` explícitos: la app (`bocadoo_app`) solo recibe lo que necesita.

## Consecuencias

- Revisar un PR de base de datos es leer SQL.
- El CI aplica las migraciones desde cero en un Postgres 16 limpio, así que una migración rota no llega a `main`.
- Sin generación automática de tipos: los DTO y consultas se escriben a mano.
