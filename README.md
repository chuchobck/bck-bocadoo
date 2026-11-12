# bck-bocadoo
Backend de Bocadoo.

## Base de datos
Postgres 16 en Neon. Esquema en `db/migrations`, datos demo en `db/seeds/demo.sql`.
Roles: `bck_api` (RLS, pooler), `bck_servicio` (BYPASSRLS), `neondb_owner` (solo migraciones).
