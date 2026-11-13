# Estado del plan del backend

Última actualización: 2026-11-13 (fase 10). Leyenda: ✅ hecho y verificado · 🔶 hecho, falta confirmar · ⬜ pendiente.

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
| 8   | Comensal                     | 🔶     | `v0.8.0`      | ver abajo; migraciones aplicadas en Neon, mezclada en `main`; falta el tag               |
| 9   | Ofertas, reportes y SaaS     | 🔶     | `v0.9.0`      | ver abajo; migraciones aplicadas en Neon, mezclada en `main`; falta el tag               |
| 10  | Documentación viva y Swagger | 🔶     | `v1.0.0-rc.1` | ver abajo; rama `fase-10/docs`, falta revisión, merge y tag                              |

## Fase 10: checklist

Solo documentación, etiquetas, ejemplos y pruebas de contrato: ningún comportamiento de negocio cambió. Pruebas corridas contra un Postgres 16 local en Docker (`bocadoo-test-pg`), **nunca contra Neon**.

- [x] **Cada endpoint documentado** (111 operaciones): resumen, respuesta de éxito con esquema, errores `application/problem+json` (`401`, `403`, `429`, `500` y los códigos de negocio) y ejemplo de petición y respuesta. Los errores y ejemplos comunes salen de `src/common/openapi-enrich.ts`. Evidencia: `test/unit/openapi-contract.spec.ts`
- [x] **DTO duplicado resuelto**: `CanjeResponse` existía en ofertas y en pedidos con formas distintas y una pisaba a la otra en Swagger (`POST /v1/caja/pedidos/{id}/canjear` mostraba la forma de la oferta). Ahora `OfertaCanjeResponse` y `PedidoCanjeResponse`
- [x] **Tipos corregidos en el contrato**: campos que aceptan `null` aparecían como `object` y las listas de números como listas de textos. El formato real de las respuestas no cambió
- [x] **Grupos por rol**: `Público`, `Comensal`, `Caja` y `Dueño`, sacados de `@Roles` de cada handler; el módulo queda en `x-dominio`
- [x] **Contrato revisado en CI**: Spectral (`pnpm openapi:lint`, reglas en `.spectral.yaml`) en el job `quality`, y job `contrato` con oasdiff contra la rama base (`pnpm openapi:breaking` en local, necesita Docker). Contra `main` marca 164 errores, todos correcciones de lo mal documentado: **la PR necesita la etiqueta `cambio-incompatible`**
- [x] **Pruebas de contrato**: cada operación (resumen, un grupo por rol coherente con `x-restaurant-id` y seguridad, errores, 429/500, ejemplos válidos contra su esquema con ajv). No necesitan base de datos
- [x] **Guía de Swagger**: `docs/swagger-guia.md` con las cuentas demo y los flujos de dueño, cajero y comensal
- [x] **`docs/api-contrato.md` al día**: las migraciones de las fases 8 y 9 ya están aplicadas en Neon; sección Estado y cambios de la fase 10. `info.version` = `1.0.0-rc.1`
- [x] **Sin tocar Neon**: `pnpm test:db` solo contra Postgres local en Docker; ninguna migración aplicada

Límite conocido: las pruebas de contrato validan el documento, no las respuestas reales de la API; contrastar cada respuesta viva con su esquema (con el patrón _probe_) queda pendiente.

Resultado al cerrar la fase (base local): `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm openapi:lint`, `pnpm test` (602 pruebas en 9 archivos) y `pnpm test:db` (239 pruebas en 33 archivos) en verde.

## Fase 9: checklist

Evidencia: archivo de prueba (`test/integration/…`) y, cuando aplica, el comando. Todo corrido contra un Postgres 16 local (`bocadoo-test-pg`), **nunca contra Neon**.

- [x] **`DbService` en todo, nunca `service()` en negocio**: ofertas, reportes, SaaS y eventos usan `forRequest()` / `scope()`. `service()` solo aparece en `src/jobs/` (cron), que la regla de ESLint autoriza junto a auth y seguridad. Evidencia: `pnpm lint` (regla `no-restricted-syntax`)
- [x] **Solo `public_id` hacia afuera**: ofertas, canjes, platos y usuarios salen con `public_id` (`expectOnlyPublicIds` en `offers*.int.ts`). Excepción heredada: `clienteId` en `GET /v1/reportes/clientes-a-contactar` es el id numérico del cliente dentro del local, el mismo de `/v1/clientes` (ver "Pendientes transversales")
- [x] **DTO con whitelist y errores `problem+json` con código estable**: `OFERTA_AGOTADA`, `STOCK_INSUFICIENTE`, `OFERTA_CERRADA`, `RANGO_INVALIDO`, `EVENTO_USUARIO_AJENO`, `EVENTOS_LIMITE_TASA`… (`offers*.int.ts`, `reports-*.int.ts`, `events.int.ts`: campos de más → 400)
- [x] **`Idempotency-Key` en los POST que crean**: publicar oferta, canjear oferta y enviar un lote de eventos (misma llave → misma respuesta; otra oferta → 409 `IDEMPOTENCY_KEY_REUTILIZADA`). Cerrar una oferta no crea nada y es repetible. Evidencia: `offers.int.ts`, `offers-redeem.int.ts`, `events.int.ts`
- [x] **Todo en Swagger**: `docs/openapi.json` regenerado en cada commit (`pnpm openapi:export`); `test/unit/openapi.spec.ts` falla si está desactualizado
- [x] **Stock de ofertas nunca negativo con canjes concurrentes**: `UPDATE … WHERE stock_restante >= cantidad` (bloqueo de fila) más el `CHECK` de la tabla. Prueba concurrente con conexiones reales sobre un clon descartable de la base: 20 canjes a la vez sobre 5 unidades → exactamente 5 pasan, stock 0, 5 canjes, 5 cobros; mezcla de cantidades; 6 peticiones con la misma llave → un solo canje. Evidencia: `offers-concurrency.int.ts`
- [x] **Reportes en la zona horaria del restaurante**: "hoy" y los días de un rango son locales (`restaurante.zona_horaria`). Evidencia: `reports-summary.int.ts` (compra a las 23:30 locales cuenta en su día local; cambiar la zona del local cambia el día) y `reports-seed.int.ts`
- [x] **Las cifras cuadran con SQL directo sobre la demo**: cada día del seed (≈52 días) contra sumas de sus filas y el efectivo contra los 43 cierres de caja sembrados; ventas de planes, horas pico (también contra `vw_consumo_por_hora`), almuerzos pendientes (contra `vw_pasivo_almuerzos`), clientes a contactar, ofertas y uso de escaneos. Evidencia: `reports-seed.int.ts`
- [x] **Ingesta de eventos con límite de tamaño y de tasa, y rechazo de eventos a nombre de otro usuario**: máx. 50 eventos por lote, propiedades de 1 KB y 20 claves, cuerpo de 100 kB (413), 20 lotes y 500 eventos por usuario y minuto (429 `EVENTOS_LIMITE_TASA`), 60 lotes por IP y minuto (429 con `Retry-After`). Un `usuarioId` ajeno rechaza el lote entero (403) y la base lo exige con RLS (`42501`). Evidencia: `events.int.ts`, `events-concurrency.int.ts`
- [x] **Jobs idempotentes, por CLI y documentados**: `node dist/jobs/cli.js <expire-plans|create-partitions|all>`; correrlos dos veces no cambia nada (segunda corrida: `vencidos: 0`, `creadas: []`, filas idénticas); doble disparo simultáneo → una copia se salta (`EN_EJECUCION`, candado de Postgres). Documentado en `docs/jobs.md`. Evidencia: `jobs.int.ts`, `jobs-concurrency.int.ts` y una corrida real del binario compilado sobre un clon de la base
- [x] **Sin comisión (modelo SaaS)**: ningún endpoint, campo de respuesta ni parámetro habla de comisiones. Evidencia: `test/unit/openapi.spec.ts` (nombres de rutas y propiedades del contrato) y `saas.int.ts` (el cuerpo de la suscripción no contiene `comisi`, `commission` ni `tasa`). Las columnas `tasa_comision_*` de `catalogo_plan_saas` y la tabla `libro_comision_bocadoo` **siguen en el esquema** (vienen de la baseline y no se editan): la API no las lee ni las escribe
- [x] **Migraciones probadas en local** (up/down/up) y, después, aplicadas en Neon
- [x] **Las pruebas que escriben limpian lo que crean**: casi todo usa el patrón _probe_ (rollback); las de concurrencia (`*-concurrency.int.ts`) usan un clon descartable de la base que se borra al terminar (`scratch-db.ts`). Conteos de las tablas de la fase iguales antes y después de `pnpm test:db`

### Endpoints de la fase 9

| Ruta                                                                        | Quién                                   | Para qué                                                          |
| --------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `POST /v1/ofertas`, `GET /v1/ofertas`, `POST …/:id/cerrar`                  | publicar y cerrar: dueño                | Ofertas flash (publicar con `Idempotency-Key`, listar con cursor) |
| `POST /v1/ofertas/:id/canjear`                                              | dueño, cajero                           | Canje en caja con control de stock (`Idempotency-Key`)            |
| `GET /v1/restaurantes/:slug/ofertas`                                        | público                                 | Ofertas vigentes con stock de un local                            |
| `GET /v1/reportes/resumen-diario`, `…/ventas-planes`                        | dueño                                   | Resumen del día y ventas de planes                                |
| `GET /v1/reportes/horas-pico`, `…/ranking-platos`, `…/almuerzos-pendientes` | dueño                                   | Horas pico, platos más pedidos y lo que se debe en almuerzos      |
| `GET /v1/reportes/clientes-a-contactar`                                     | dueño                                   | Planes por vencer, clientes que no vienen y por renovar           |
| `GET /v1/suscripcion`, `GET /v1/suscripcion/uso`                            | suscripción: dueño; uso: dueño y cajero | Plan SaaS, ciclo, límites y escaneos usados                       |
| `POST /v1/eventos`                                                          | usuario con sesión                      | Eventos de producto en lote (`Idempotency-Key`)                   |

### Decisiones de la fase

- **Canje de ofertas en caja**: lo registra el personal (dueño o cajero), con el comensal opcional por `public_id`. El cobro se guarda `CONFIRMADO` en la misma transacción (la oferta se entrega al pagar), así que entra al arqueo de caja del día; no usa el flujo de pagos pendientes. Las ofertas no tienen deshacer.
- **Estado de una oferta** calculado con la hora de la base: `CERRADA` > `AGOTADA` > `EXPIRADA` > `PROGRAMADA` > `VIGENTE`. La API solo puede cambiar `activa` y `stock_restante` de una oferta publicada (permiso por columnas); el canje es de solo inserción (trigger de la baseline).
- **Reportes solo para el dueño.** Definiciones: almuerzos servidos = consumos netos de devoluciones (igual que el cierre de caja); horas pico cuentan almuerzos y tickets que **no** fueron devueltos/deshechos (un reverso no mueve la hora); pasivo = planes `ACTIVA` con saldo y que no pasaron su último día local (no se cuenta un plan vencido que espera al job); ranking de platos = ventas sueltas netas + pedidos canjeados (las dos fuentes por separado: un plato cobrado en caja y en el pedido cuenta en ambas).
- **Clientes a contactar**: tres motivos (`POR_VENCER`, `SIN_VENIR`, `PARA_RENOVAR`), umbrales por query, un cliente con todos sus motivos, sin paginación (`limit` y `total`). La actividad es lo más reciente entre el último almuerzo servido y la última compra.
- **Eventos**: sin consentimiento de analítica (`usuario.consiente_analitica`) los eventos se guardan **anonimizados** (sin usuario ni sesión) en vez de descartarse. `fn_consiente_analitica()` (SECURITY DEFINER) devuelve solo el consentimiento del propio usuario, porque `bck_api` no puede leer esa columna. `evento_lote` guarda cada lote (idempotencia y tasa por usuario entre instancias).
- **SaaS**: la API solo lee la suscripción (RLS `tenant_lee`). Un local sin fila de suscripción responde `SIN_SUSCRIPCION` y se comporta como sin límite (igual que `fn_descontar_almuerzo`).
- **Jobs**: la migración `20261118000200` hizo `SECURITY DEFINER` a `fn_crear_particion_mensual`: `bck_servicio` no es dueño de las tablas particionadas y no podía crear particiones. Los meses de las particiones son UTC; si la partición `DEFAULT` ya tiene filas del mes, el job lo informa por partición y sale con código 1.
- **ESLint**: `src/jobs/**` quedó autorizado para `service()` (cron) y `src/jobs/cli.ts` para `console` (su salida son líneas JSON).
- Migraciones nuevas (probadas up/down/up en local y **ya aplicadas en Neon**): `20261118000000_ofertas_flash`, `20261118000100_eventos_analitica`, `20261118000200_particiones_security_definer`.
- Pruebas de concurrencia con conexiones reales: `test/integration/scratch-db.ts` clona la base de `PROBE_DATABASE_URL` (`CREATE DATABASE … TEMPLATE`), corre contra el clon y lo borra. Postgres exige que **nadie más** esté conectado a la base original al clonar: con una sesión abierta (psql, un IDE) esas suites fallan con un mensaje claro. En `pnpm test:db` las suites corren una a la vez, así que se cumple.

Resultado al cerrar la fase (base local): `pnpm typecheck`, `pnpm lint`, `pnpm test` (45 pruebas) y `pnpm test:db` (239 pruebas en 33 archivos) en verde.

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
- Migraciones nuevas (probadas up/down/up en local y **ya aplicadas en Neon**):
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
- ✅ Las 6 migraciones de la fase 8 están aplicadas en Neon.
- ✅ Las 3 migraciones de la fase 9 (`20261118000000`, `…0100`, `…0200`) están aplicadas en Neon.
- ⬜ Poner la etiqueta `cambio-incompatible` a la PR de la fase 10 (el job `contrato` marca como incompatibles las correcciones de tipos del contrato).
- ⬜ Tags `v0.8.0`, `v0.9.0` y `v1.0.0-rc.1` (esperan revisión y confirmación).
- ⬜ **Crear el Cron Job en Render** (`node dist/jobs/cli.js all`, ver `docs/jobs.md`). Hasta entonces nadie vence planes en la base ni crea particiones: las ventanas actuales cubren hasta febrero de 2027.
- ⬜ **Decisión de negocio: renovar el ciclo de la suscripción SaaS** (`inicio_ciclo_actual`, `fin_ciclo_actual`, `escaneos_usados_ciclo_actual`). Nada lo renueva: en un plan con tope, el contador no vuelve a cero y la caja respondería `LIMITE_SAAS` para siempre. Hoy no pasa porque solo existe el plan `FREEMIUM` sin tope; `GET /v1/suscripcion` ya marca `ciclo.vencido`.
- ⬜ **Decisión de negocio: el registro de un dueño no crea su fila de `suscripcion_saas_restaurante`** (solo el seed lo hace): un local nuevo responde `SIN_SUSCRIPCION` y se comporta como sin límite. Además `permite_mesa_grupal` y `permite_reportes_avanzados` se informan pero no se exigen en ningún endpoint.
- ⬜ Columnas y tabla de comisión de la baseline (`catalogo_plan_saas.tasa_comision_*`, `libro_comision_bocadoo`): la API no las usa ni las expone (modelo SaaS), pero siguen en el esquema; quitarlas pide una migración y una decisión.
- ⬜ `evento_lote` crece sin límite (una fila pequeña por lote): falta una retención (por ejemplo, borrar lotes de más de 30 días en un job).
- ⬜ Un cliente numérico en `/v1/reportes/clientes-a-contactar` (`clienteId`) se suma a la lista de ids numéricos dentro del tenant de más abajo; se pasará a `public_id` junto con `/v1/clientes`.
- ⬜ CI: definir `PROBE_DATABASE_URL` (el superusuario `postgres` del servicio) para que las suites de las fases 8 y 9 corran y no se salten. Las de concurrencia de la fase 9 clonan la base con `CREATE DATABASE … TEMPLATE`, que exige que nadie más esté conectado a ella.
- ⬜ Pasar al patrón _probe_ las suites de las fases 1–7 que hoy dejan datos (por eso no se corren contra Neon).
- ⬜ Revisar en Neon el aumento de filas del 2026-11-12 entre 02:30 y 03:04 UTC (≈66 restaurantes y ≈100 usuarios con prefijos de correo de las pruebas de integración); no vino de las corridas de la fase 8, que fueron contra la base local.
- ⬜ Ids numéricos dentro del tenant en `/v1/clientes`, reclamos y plantillas de plan: evaluar pasarlos a `public_id`.
- ⬜ Rate limit en memoria: si la API escala a varias instancias, moverlo a un almacén compartido.
