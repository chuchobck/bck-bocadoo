# bck-bocadoo
Backend de Bocadoo (SaaS multi-tenant de almuerzos prepago por QR). Base de datos: Postgres 16 en Neon.
## Reglas
- SQL primero: migraciones en db/migrations (formato dbmate); nunca editar una ya aplicada.
- Dinero en BIGINT centavos. Ledgers append-only. Tenant = restaurante (RLS).
- La API usa el rol bck_api (sujeto a RLS) por el pooler. bck_servicio (BYPASSRLS) solo para auth y cron.
- Commits en inglés (Conventional Commits), documentación en español.
- Endpoints: protegidos por defecto (guard JWT global); `@Public()` solo como excepción explícita. Los del personal de un restaurante usan `@Roles(...)` y `x-restaurant-id`. Entradas siempre con DTO (whitelist).
- Los secretos (llaves JWT, contraseñas de BD) nunca van al repo. Detalle en docs/seguridad.md.

