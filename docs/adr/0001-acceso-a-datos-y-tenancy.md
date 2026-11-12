# ADR 0001: acceso a datos y multi-tenant

- Estado: aceptada (fase 3)
- Fecha: 2026-11-12

## Contexto
Bocadoo es multi-tenant (tenant = restaurante). La base ya aísla con RLS (`app_tenant_id()` / `app_user_id()` leen `app.current_tenant_id` y `app.current_user_id`). La API corre sobre el pooler de Neon (pgbouncer en modo transacción).

## Decisión
1. **node-postgres (`pg`), sin ORM.** Cada consulta debe ejecutarse dentro de una transacción que fija el contexto RLS; con `pg` eso es explícito y verificable. Prisma queda descartado por ahora.
2. **Solo `DbService`.** Los pools no se exponen; el código de negocio recibe un `Queryable` (únicamente `query`) dentro de `scope()`, `forRequest()` o `service()`.
3. **Contexto transaccional.** `scope()` abre `BEGIN`, ejecuta `set_config('app.current_tenant_id', …, true)` y `set_config('app.current_user_id', …, true)` y confirma o hace `ROLLBACK`. El `true` limita el valor a la transacción: una conexión reutilizada nunca arrastra el tenant anterior y es compatible con el pooler en modo transacción.
4. **Dos roles, dos pools.** `bck_api` (miembro de `bocadoo_app`, sujeto a RLS) por el pooler para todos los endpoints; `bck_servicio` (BYPASSRLS propio) por conexión directa solo para login, cron y facturación. Las migraciones usan `neondb_owner` por conexión directa y no pasan por la API.
5. **Ids validados.** `tenantId` y `userId` viajan como texto a `set_config`; se validan con `^[1-9][0-9]{0,18}$` y que quepan en BIGINT antes de abrir la conexión.
6. **Contexto del request** en `AsyncLocalStorage` (`RequestContextStore`); lo llena la capa de seguridad (fase 4) tras validar el JWT y `forRequest()` lo consume.
7. **Readiness.** `GET /health/ready` comprueba ambos roles y responde 503 `problem+json` si alguno falla; `/health` sigue sin tocar la base.

## Consecuencias
- Un olvido en el código no filtra datos: RLS es la segunda barrera. Las pruebas de integración (`pnpm test:db`) fallan si la API usa un rol con BYPASSRLS.
- Quien llame a `service()` desde un endpoint de negocio rompe el aislamiento: debe vigilarse en revisión (y con lint en la fase de calidad).
- Sin sentencias preparadas con nombre (compatibilidad con pgbouncer en modo transacción).
- Más código manual que con un ORM; a cambio, SQL visible y verificable.
