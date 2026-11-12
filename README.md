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
