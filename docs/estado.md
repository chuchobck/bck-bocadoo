# Estado del plan del backend

Última actualización: 2026-11-13. Leyenda: ✅ hecho y verificado · 🔶 hecho, falta confirmar · ⬜ pendiente.

| #   | Fase                         | Estado | Tag           | Evidencia                                                                                |
| --- | ---------------------------- | ------ | ------------- | ---------------------------------------------------------------------------------------- |
| 0   | Entorno y repo               | ✅     | —             |                                                                                          |
| 1   | Base de datos en Neon        | ✅     | `v0.1.0`      | 59 tablas, 71 políticas, seed; `bck_api` sin BYPASSRLS                                   |
| 2   | Fundaciones de la API        | ✅     | `v0.2.0`      | health, errores RFC 9457, config validada, Swagger                                       |
| 3   | Datos y multi-tenant         | ✅     | `v0.3.0`      | RLS, `DbService`; pruebas de aislamiento también corridas contra Neon (pooler)           |
| 4   | Seguridad                    | ✅     | `v0.4.0`      | argon2id, JWT ES256, refresh rotativo, roles y tenant, rate limit                        |
| —   | Calidad automática           | ✅     | —             | ESLint con reglas de arquitectura, Prettier, husky + commitlint, CI (4 jobs), Dockerfile |
| 5   | Restaurante, menú y vitrina  | ✅     | `v0.5.0`      | ver abajo                                                                                |
| 6   | Clientes y planes            | ⬜     | `v0.6.0`      |                                                                                          |
| 7   | Caja                         | ⬜     | `v0.7.0`      | requiere Fable 5.2                                                                       |
| 8   | Comensal                     | ⬜     | `v0.8.0`      |                                                                                          |
| 9   | Ofertas, reportes y SaaS     | ⬜     | `v0.9.0`      |                                                                                          |
| 10  | Documentación viva y Swagger | ⬜     | `v1.0.0-rc.1` |                                                                                          |

## Fase 5: checklist

- [x] La vitrina pública funciona sin token y solo expone datos públicos (sin ids internos ni datos del dueño)
- [x] Listados con paginación por cursor y máximo 50 por página
- [x] El `ILIKE` del nombre puede resolverse con el índice trigram (`EXPLAIN` lo confirma; con pocas filas el planificador elige por costo)
- [x] Marcar agotado guarda `agotado_en`; "Local lleno" dura 20 minutos y expira solo
- [x] El menú es editable libremente (5 sopas, 4 segundos…), con precio del día y porciones
- [x] El cajero marca agotados y "Local lleno", pero no edita catálogo, menú, perfil ni personal
- [x] Un local no ve ni modifica datos de otro aunque conozca el id (guard + RLS)
- [x] "Hoy" se calcula en la zona horaria del restaurante, no en la del servidor

### Endpoints de la fase 5

| Ruta                                                                 | Quién                      | Para qué                                                   |
| -------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| `GET /v1/restaurantes`, `GET /v1/restaurantes/:slug`                 | público                    | Vitrina: búsqueda, detalle, menú de hoy, planes, ocupación |
| `GET·PATCH /v1/restaurante`, `POST …/activar`, `…/pausar`            | dueño (GET también cajero) | Perfil y estado del local                                  |
| `GET·PUT /v1/restaurante/horarios`                                   | dueño                      | Horarios (varios tramos por día)                           |
| `GET·POST·PATCH /v1/restaurante/mesas`                               | dueño                      | Mesas                                                      |
| `POST /v1/restaurante/lleno`                                         | dueño, cajero              | "Local lleno" 20 min                                       |
| `GET·POST·PATCH /v1/restaurante/personal`                            | dueño                      | Cajeros por correo; activar y desactivar                   |
| `GET·POST·PATCH /v1/menu/platos`                                     | dueño (GET también cajero) | Catálogo de platos                                         |
| `GET·PUT /v1/menu/:fecha`, `…/publicar`, `…/despublicar`, `…/copiar` | dueño (GET también cajero) | Menú del día (`hoy` o AAAA-MM-DD)                          |
| `PATCH /v1/menu/:fecha/items/:id/agotado`                            | dueño, cajero              | Agotado con hora                                           |

Los endpoints del personal llevan `Authorization: Bearer …` y `x-restaurant-id`.

### Decisiones de la fase

- Los ids de platos, mesas y renglones de menú son numéricos **dentro del tenant** (esas tablas no tienen `public_id`); RLS impide usarlos desde otro local. Hacia afuera, locales y usuarios salen solo con `public_id` o `slug`.
- Agregar un cajero exige que la persona ya tenga cuenta (búsqueda por correo, con límite por hora). Las invitaciones por correo electrónico quedan para después.
- La ocupación se calcula con consumos y ventas POS netos de los últimos 25 minutos mediante `fn_ocupacion_local` (SECURITY DEFINER, solo devuelve conteos).
- Migraciones nuevas: `20261114000000_menu_horario_delete_grants` y `20261114000100_fn_ocupacion_local`.

## Pendientes transversales

- ⬜ **Rotar la contraseña de `neondb_owner`** (se compartió por mensajería y en una conversación).
- ⬜ Llave JWT (`pnpm keys:generate`) en las variables de Render al desplegar.
- ⬜ Correr en Neon las pruebas que escriben datos (registro, auth, menú…) usando una **rama de Neon** de prueba; hoy solo se corrieron ahí las de aislamiento y readiness.
- ⬜ Pruebas SQL de reglas de negocio (`db/tests/01_rls_and_rules.sql`) antes de la fase 7.
- ⬜ Rate limit en memoria: si la API escala a varias instancias, moverlo a un almacén compartido.
