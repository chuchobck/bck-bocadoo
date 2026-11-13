# Estado del plan del backend

Última actualización: 2026-11-12 (fase 8). Leyenda: ✅ hecho y verificado · 🔶 hecho, falta confirmar · ⬜ pendiente.

| #   | Fase                         | Estado | Tag           | Evidencia                                                                                |
| --- | ---------------------------- | ------ | ------------- | ---------------------------------------------------------------------------------------- |
| 0   | Entorno y repo               | ✅     | —             |                                                                                          |
| 1   | Base de datos en Neon        | ✅     | `v0.1.0`      | 59 tablas, 71 políticas, seed; `bck_api` sin BYPASSRLS                                   |
| 2   | Fundaciones de la API        | ✅     | `v0.2.0`      | health, errores RFC 9457, config validada, Swagger                                       |
| 3   | Datos y multi-tenant         | ✅     | `v0.3.0`      | RLS, `DbService`; pruebas de aislamiento también corridas contra Neon (pooler)           |
| 4   | Seguridad                    | ✅     | `v0.4.0`      | argon2id, JWT ES256, refresh rotativo, roles y tenant, rate limit                        |
| —   | Calidad automática           | ✅     | —             | ESLint con reglas de arquitectura, Prettier, husky + commitlint, CI (4 jobs), Dockerfile |
| 5   | Restaurante, menú y vitrina  | ✅     | `v0.5.0`      | ver abajo                                                                                |
| 6   | Clientes y planes            | ✅     | `v0.6.0`      | ver abajo                                                                                |
| 7   | Caja                         | ✅     | `v0.7.0`      | ver abajo; carga en `docs/carga.md`                                                      |
| 8   | Comensal                     | 🔶     | `v0.8.0`      | ver abajo; faltan las 6 migraciones en Neon (esperan confirmación) y el tag              |
| 9   | Ofertas, reportes y SaaS     | ⬜     | `v0.9.0`      |                                                                                          |
| 10  | Documentación viva y Swagger | ⬜     | `v1.0.0-rc.1` |                                                                                          |

## Fase 8: checklist

- [x] El comensal solo ve lo suyo: el servicio usa `DbService.scope({ userId })` sin tenant y RLS lo repite en la base. Probado por ambos lados: por la API (otro comensal recibe 404) y directo en SQL como `bck_api` (lecturas vacías, inserciones ajenas rechazadas con `42501`)
- [x] El personal entra con `@Roles(...)` + `x-restaurant-id` y `DbService.forRequest()`; ningún endpoint de negocio usa `service()` (regla de ESLint)
- [x] Hacia afuera solo `public_id` (pruebas con `expectOnlyPublicIds`); `plato` ganó `public_id` para poder pedir platos sin ids internos
- [x] Entradas con DTO y whitelist; errores `application/problem+json` con `code` de negocio estable (`PEDIDO_NO_ENCONTRADO`, `MESA_LLENA`, `OPINION_VENCIDA`…)
- [x] `Idempotency-Key` obligatoria en los POST que crean recursos (pedidos, mesas, opiniones, reclamos, canje en caja y de sellos); misma llave → misma respuesta; repetir con otra llave → 409 (`OPINION_YA_ENVIADA`, `RECLAMO_YA_EXISTE`, `PEDIDO_ACTIVO`); en pedidos, mesas y sellos, la llave usada para otro recurso → `IDEMPOTENCY_KEY_REUTILIZADA`
- [x] Pre-pedidos: vencen a los 30 min; el QR del pedido es su `public_id`; un pedido activo por local
- [x] Mesa compartida: el link (`public_id` de la mesa) se valida antes de unirse (vencida, llena, cancelada, ya miembro)
- [x] Opiniones: solo sobre consumos propios no revertidos, una por almuerzo, desde 25 min hasta 24 h; descartar cuenta como la única
- [x] Reclamos: sobre consumos propios, uno por almuerzo, dentro de 7 días
- [x] Tarjeta de sellos: la suma un trigger en `consumo_almuerzo` (ningún camino de la caja se la salta) y el reverso la descuenta
- [x] Todo documentado en Swagger (`/docs`); una prueba revisa en `/docs-json` cada ruta de la fase y su parámetro `Idempotency-Key`
- [x] Las pruebas que escriben hacen rollback (patrón _probe_) y no dejan filas: conteos idénticos antes y después

### Endpoints de la fase 8

| Ruta                                                             | Quién               | Para qué                                                    |
| ---------------------------------------------------------------- | ------------------- | ----------------------------------------------------------- |
| `GET /v1/pase`                                                   | comensal            | Pase con QR rotativo, planes vigentes y almuerzos restantes |
| `GET /v1/mis/consumos`, `GET …/:id`                              | comensal            | Historial de almuerzos (cursor)                             |
| `GET·POST /v1/mis/pedidos`, `GET …/:id`, `POST …/:id/cancelar`   | comensal            | Pre-pedidos (vencen a los 30 min)                           |
| `GET /v1/caja/pedidos`, `GET …/:id`, `POST …/:id/canjear·servir` | dueño, cajero       | Pedidos de comensales; canjear descuenta el almuerzo        |
| `GET·POST /v1/mis/mesas`, `GET …/:id`, `POST …/:id/cancelar`     | comensal            | Mesas compartidas que creo o donde estoy                    |
| `GET /v1/mesas/invitacion/:id`, `POST …/:id/unirse`              | comensal            | Ver el link de invitación y unirse                          |
| `GET /v1/mis/opiniones`, `…/pendientes`                          | comensal            | Opiniones dadas y almuerzos por opinar                      |
| `POST /v1/mis/consumos/:id/opinion`, `…/opinion/descartar`       | comensal            | "¿Qué tal hoy?"                                             |
| `GET /v1/opiniones`, `POST …/:id/responder`                      | dueño               | Bandeja de opiniones y respuesta                            |
| `GET /v1/mis/reclamos`, `POST /v1/mis/consumos/:id/reclamo`      | comensal            | Reclamos del comensal (la caja los resuelve, fase 7)        |
| `GET /v1/mis/sellos`                                             | comensal            | Mis tarjetas de sellos                                      |
| `GET·PUT /v1/sellos/config`                                      | dueño (GET: cajero) | Configurar la tarjeta                                       |
| `GET /v1/clientes/:id/sellos`, `POST …/sellos/canjear`           | dueño, cajero       | Ver la tarjeta de un cliente y canjear un premio            |

### Decisiones de la fase

- `DbService` no tiene `withScope`/`withRequestScope`/`withService`: sus métodos son `scope()`, `forRequest()` y `service()`. Se usaron con el mismo sentido (comensal: `scope({ userId })`; personal: `forRequest()`).
- Precio del pedido calculado en el servidor: el almuerzo cuesta 0 si un plan lo cubre, si no `precio_suelto`; extras y recargo para llevar con precios del menú.
- La invitación a una mesa es su `public_id`; vence una hora después de la llegada; capacidad por defecto 12. Unirse pasa por `fn_unirse_mesa` (SECURITY DEFINER) que valida todo en una sola transacción.
- Las etiquetas de opinión son una lista cerrada: `RICO`, `BUENA_PORCION`, `RAPIDO`, `BUENA_ATENCION`, `LIMPIO`, `FRIO`, `SALADO`, `PORCION_PEQUENA`, `DEMORA`, `MALA_ATENCION`. El id de una opinión hacia afuera es el `public_id` del consumo.
- Los sellos solo cuentan almuerzos (`cuenta = ALMUERZO`); `PLATO` queda para después. Cambiar la meta no toca los premios ya ganados. El seed demo dejó de insertar sellos a mano: los crea el trigger.
- El pase reutiliza `QrSecretService` de la fase 7 (usa el rol de servicio porque es parte de la autenticación del QR).
- Se mantienen ids numéricos dentro del tenant en `/v1/clientes/:id/sellos` (como el resto de `/v1/clientes`).
- Migraciones nuevas (aplicadas y probadas up/down/up **solo en la base local**; **no** en Neon hasta que se confirme):
  `20261117000000_preordenes_comensal`, `20261117000100_mesas_compartidas_comensal`, `20261117000200_opiniones_comensal`,
  `20261117000300_opiniones_respuesta`, `20261117000400_reclamos_comensal`, `20261117000500_tarjeta_sellos`.
  Además de columnas e índices, endurecen las políticas `comensal_crea` para que la base exija lo mismo que la API.

### Patrón _probe_ (pruebas que no dejan basura)

`test/integration/probe.ts`: con `PROBE_DATABASE_URL` (una conexión privilegiada), cada transacción de `DbService`
se convierte en un `SAVEPOINT` con `SET LOCAL ROLE` al rol de la URL del pool (`bck_api` o `bck_servicio`), así RLS
se aplica igual que en producción, y al final de cada prueba todo vuelve atrás. Sin `PROBE_DATABASE_URL` las suites de
la fase 8 se saltan. En Neon no se puede usar todavía: `neondb_owner` no puede hacer `SET ROLE` a `bck_api` ni a
`bck_servicio`. Para correrlas en local: Postgres 16 en Docker con las migraciones aplicadas (como en CI) y
`PROBE_DATABASE_URL` apuntando al superusuario.

Resultado al cerrar la fase (base local): `pnpm typecheck`, `pnpm lint`, `pnpm test` (42 pruebas) y `pnpm test:db`
(176 pruebas en 21 archivos) en verde.

## Fase 7: checklist

- [x] El QR se firma con HMAC-SHA256 y un secreto por usuario cifrado (AES-256-GCM); vence a los 30 s (±1 paso)
- [x] QR de otro local → `OTRO_LOCAL`; QR vencido → `QR_EXPIRADO`; falso o alterado → `QR_INVALIDO`; todos quedan en `intento_escaneo`
- [x] El mismo comensal escaneado en dos cajas a la vez → un solo descuento (prueba concurrente con 6 peticiones)
- [x] Deshacer pasados 10 s → 409; dentro de 10 s devuelve el almuerzo una sola vez aunque se pida tres veces a la vez
- [x] Validar almuerzo: p95 = 23 ms a 50 req/s y 42 ms a 100 req/s (k6, base local). Falta medir contra Neon
- [x] Cierre de caja: efectivo esperado = cobros confirmados en efectivo del día (planes + ventas sueltas) menos reversos; un cierre activo por día
- [x] Todos los resultados del escáner documentados en Swagger (`OK`, `OK_ADVERTENCIA`, `DUPLICADO`, `SIN_PLAN`, `SIN_SALDO`, `VENCIDO`, `DIA_NO_VALIDO`, `OTRO_LOCAL`, `QR_EXPIRADO`, `QR_INVALIDO`, `LIMITE_SAAS`)
- [x] Descuento FIFO (el plan que vence primero), doble escaneo en 60 s → `DUPLICADO`, misma `Idempotency-Key` → mismo consumo
- [x] Consumos, ventas y pagos son libros de solo inserción: se corrigen con movimientos inversos
- [x] `fn_descontar_almuerzo` se llama a través de `DbService` (pendiente heredado de la fase 3)

### Endpoints de la fase 7

| Ruta                                                | Quién                          | Para qué                                             |
| --------------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `GET /v1/pase/codigo`, `POST /v1/pase/rotar`        | comensal con sesión            | Código QR rotativo; invalidar los anteriores         |
| `POST /v1/caja/validar`                             | dueño, cajero                  | Validar por QR o búsqueda manual (`Idempotency-Key`) |
| `POST /v1/caja/consumos/:id/deshacer`               | dueño, cajero                  | Deshacer en 10 segundos                              |
| `GET /v1/caja/mesas/:id`, `POST …/validar`          | dueño, cajero                  | Vista previa y validación de una mesa compartida     |
| `GET·POST /v1/caja/ventas`, `POST …/:id/deshacer`   | dueño, cajero                  | Ventas sueltas (precios del servidor) y su reverso   |
| `GET·POST /v1/caja/cierre/:fecha`, `POST …/reabrir` | dueño, cajero (reabrir: dueño) | Arqueo y cierre de caja                              |
| `GET /v1/reclamos`, `POST …/:id/devolver·rechazar`  | lista: ambos; resolver: dueño  | Reclamos con devolución del almuerzo                 |

### Decisiones de la fase

- `POST /v1/caja/validar` responde siempre 200 con un `resultado`: para la caja, "sin saldo" es una respuesta normal, no un error.
- El código del QR es `BCD1.<usuario>.<restaurante|0>.<mac>`; con restaurante solo vale en ese local. La llave `QR_SECRET_KEY` es obligatoria en producción.
- Migración `20261116000000`: `fn_descontar_almuerzo` gana `p_mesa_local_id` y `p_omitir_duplicado` (mesa "invito yo": el anfitrión paga varios almuerzos seguidos).
- En una mesa, quien no tiene plan queda "por cobrar" y se cobra como venta suelta.
- Las mesas compartidas y los reclamos los crean los comensales en la fase 8; aquí está el lado de la caja.
- Las reglas de negocio de la base (FIFO, idempotencia, duplicado, reverso, solo inserción) quedaron cubiertas por las pruebas de integración en vez de un archivo SQL aparte.

## Fase 6: checklist

- [x] Vender plan crea suscripción + pago en una sola transacción (si falla el pago, no queda el plan)
- [x] Editar la plantilla no cambia lo ya vendido (la venta copia nombre, almuerzos, precio, días y vencimiento)
- [x] Se respetan los cupos de la plantilla, también con ventas simultáneas (bloqueo de fila); deshacer libera el cupo
- [x] Dos planes del mismo cliente no suman vencimientos: cada uno vence desde su compra
- [x] Deshacer genera un pago inverso; nunca borra (los pagos son de solo inserción). Un pago pendiente se rechaza
- [x] La misma `Idempotency-Key` devuelve la misma respuesta, también con peticiones simultáneas; con otra venta → 409
- [x] Teléfono en formato E.164; duplicado en el mismo restaurante → 409 con mensaje claro
- [x] Un mismo depósito (referencia de transferencia) no paga dos planes → 409

### Endpoints de la fase 6

| Ruta                                                                | Quién                           | Para qué                                                                |
| ------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `GET·POST·PATCH /v1/planes`                                         | dueño (GET también cajero)      | Plantillas de plan con cupos disponibles                                |
| `GET·POST /v1/clientes`, `GET·PATCH /v1/clientes/:id`               | dueño, cajero                   | Buscar (nombre o teléfono, con cursor), crear, ficha con planes, editar |
| `POST /v1/clientes/:id/migrar-cartulina`                            | dueño                           | Saldo de la cartulina de papel como plan MIGRADA                        |
| `POST /v1/clientes/:id/vincular`, `…/desvincular`                   | dueño, cajero                   | Vincular con la cuenta de la app (por correo)                           |
| `POST /v1/clientes/:id/planes`                                      | dueño, cajero                   | Vender un plan (`Idempotency-Key` obligatoria)                          |
| `POST /v1/planes-vendidos/:id/deshacer`                             | dueño; cajero solo el mismo día | Pago inverso y plan anulado (`Idempotency-Key`)                         |
| `GET /v1/pagos/pendientes`, `POST /v1/pagos/:id/confirmar·rechazar` | dueño                           | Transferencias y Deuna por confirmar                                    |
| `GET /v1/solicitudes-plan`, `POST …/:id/cobrar·rechazar`            | dueño, cajero                   | Solicitudes de comensales                                               |
| `POST /v1/restaurantes/:slug/solicitudes-plan`                      | comensal con sesión             | Pedir un plan visible en la vitrina                                     |

### Decisiones de la fase

- Efectivo queda confirmado al vender; transferencia y Deuna quedan pendientes salvo `pagoConfirmado`. Rechazar el pago anula el plan.
- El plan con pago pendiente ya está activo (el cajero confía en el comprobante); el dueño lo confirma o rechaza después.
- Deshacer solo si no se consumió ningún almuerzo. El consumo FIFO llega en la fase 7.
- Pedir un plan desde la app crea la ficha del cliente en ese local (vinculada a su cuenta) si aún no existía.
- Los ids de plantillas, clientes y solicitudes son numéricos dentro del tenant; planes vendidos y pagos salen con `public_id`.
- Sin migraciones nuevas: el esquema ya tenía la unicidad de teléfono y de cuenta por restaurante, y la de referencia de pago.

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
- ⬜ Prueba de carga contra Neon (ver `docs/carga.md`), con una rama de prueba.
- ⬜ `QR_SECRET_KEY` y `JWT_PRIVATE_KEY` (`pnpm keys:generate`) en las variables de Render al desplegar.
- ⬜ **Aplicar en Neon las 6 migraciones de la fase 8** (esperan confirmación del dueño del proyecto).
- ⬜ CI: definir `PROBE_DATABASE_URL` (el superusuario `postgres` del servicio) para que las suites de la fase 8 corran y no se salten.
- ⬜ Pasar al patrón _probe_ las suites de las fases 1–7 que hoy dejan datos (por eso no se corren contra Neon).
- ⬜ Revisar en Neon el aumento de filas del 2026-11-12 entre 02:30 y 03:04 UTC (≈66 restaurantes y ≈100 usuarios con prefijos de correo de las pruebas de integración); no vino de las corridas de la fase 8, que fueron contra la base local.
- ⬜ Ids numéricos dentro del tenant en `/v1/clientes`, reclamos y plantillas de plan: evaluar pasarlos a `public_id`.
- ⬜ Rate limit en memoria: si la API escala a varias instancias, moverlo a un almacén compartido.
