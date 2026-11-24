# Estado del plan del backend

Última actualización: 2026-11-22 (cajero confirma pagos, rama `fix/cajero-confirma-pagos`; hora de llegada en pedidos, rama `feat/pedido-hora-llegada`; carta sin caché, 6c, 6a y 6b mezclados en `main`). Leyenda: ✅ hecho y verificado · 🔶 hecho, falta confirmar · ⬜ pendiente.

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

Fix de dinero (rama `fix/dinero-claims-y-pago-pos`, sin migración): **(1)** aceptar un reclamo (`POST /v1/reclamos/{id}/devolver`) pasa por `revertirConsumoEnCuenta` como deshacer: almuerzo de cuenta cobrada o con pagos → 409 `CUENTA_COBRADA`, cuenta abierta sin pagos → línea inversa; **(2)** un pago POS `PENDIENTE` (transferencia/Deuna) ya se confirma o rechaza con `POST /v1/pagos/{id}/confirmar|rechazar` (antes 404) y la venta POS trae `pago.id`. Rechazar el pago no deshace la venta (eso sigue en `POST /v1/caja/ventas/{id}/deshacer`). `GET /v1/pagos/pendientes` sigue listando solo planes.

Entrega D (cobros cruzados: plan, oferta, carta, extras, bebidas y recargo): spec en revisión en [`docs/spec-cobros.md`](spec-cobros.md). PR 2 (`src/billing/cotizar.ts`, función pura), PR 3 (cotizaciones informativas), PR 4 (migraciones de cuentas, **aplicadas en Neon**: 22 aplicadas, 0 pendientes), PR 5a (cuentas de pedidos en caja) y PR 5b (cuentas del QR, abajo; mezclado en `main`, su migración **aplicada en Neon**: 23 aplicadas, 0 pendientes) hechos; **PR 6a** (la mesa se cobra con la selección, `salir`, abajo) mezclado en `main`; **PR 6b** (cuenta automática del QR, abajo) mezclado en `main`, sin migración; **PR 6c** (huecos de cobro, abajo) en la rama `fix/huecos-cobro-6c`, con una migración **pendiente en Neon**; **PR 7a** (carta fija en pedidos y recargo por unidad, abajo) en la rama `feat/pedidos-carta-recargo`, con una migración **pendiente en Neon**; siguen ofertas en pedidos y mesas, POS y canje de oferta (PR 7b en adelante, H.1).

## Cajero confirma pagos (auditoría de seguridad; rama `fix/cajero-confirma-pagos`)

Cierra el hallazgo MEDIO «el cajero autoconfirma transferencias/Deuna» ([`docs/seguridad.md`](seguridad.md#hallazgo-cerrado-el-cajero-autoconfirmaba-transferencias-y-pagos-deuna-auditoría-de-seguridad-22-nov-2026)). Reemplaza al PR #38, que no se usa (su `estadoPagoInicial` dejaba al cajero sin poder confirmar nunca y casi todas las transferencias PENDIENTES sin forma de listarlas). **Una migración pendiente en Neon**: `20261122210000_pago_confirmado_por` (la corre el dueño con `pnpm db:migrate --remoto`). Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades).

### Checklist

- [x] Decisión de producto (del dueño): el cajero **conserva** `pagoConfirmado`, con `referenciaExterna` obligatoria al confirmar TRANSFERENCIA o DEUNA; se guarda quién confirmó (usuario y rol) y el cierre separa cajero y dueño. Efectivo no cambia.
- [x] Migración: `transaccion_pago.confirmado_por_usuario_id` (FK a `usuario`), `confirmado_por_rol` (`rol_personal_enum`) y `confirmado_en`, todas nullable; `ck_pago_confirmado_por` (las tres juntas y solo en un pago `CONFIRMADO`); `fn_pago_solo_cambia_estado` (`CREATE OR REPLACE`) admite fijarlas en el UPDATE que confirma un `PENDIENTE`. El down vuelve la función de la baseline y quita las columnas. Probada up → down → up en local.
- [x] `src/common/pago-confirmado.ts`: `exigirReferenciaAlConfirmar` (422 `REFERENCIA_PAGO_REQUERIDA`, solo rol CAJERO, solo si no es efectivo y queda confirmado), `confirmadoPorSql` / `resolverEstadoPago` (quién sale de la sesión: `app_user_id()` y el rol de `personal_restaurante`, nunca del body) y `errorReferenciaRepetida`.
- [x] Puntos cubiertos: venta de plan y cobrar solicitud (`sales.ts`), venta POS (`pos.ts`), pago de cuenta (`aplicar.ts`, `registrarPago`: cobrar cuenta, validar con `cobro`, canje de pedido con `cobro`), confirmar después (`POST /v1/pagos/{id}/confirmar`, sigue solo del dueño) y **canje de oferta** (`offers.ts`: siempre nacía `CONFIRMADO` con cualquier método y sin referencia; ahora acepta `referenciaExterna` y aplica la misma regla).
- [x] Todo pago que nace `CONFIRMADO` (efectivo y canjes incluidos) guarda quién; los reversos no (el cierre los atribuye al pago original); rechazar no guarda a nadie.
- [x] 409 `REFERENCIA_PAGO_REPETIDA` también en planes y POS (antes `code: "CONFLICT"`).
- [x] Cierre: `porMetodo[].confirmadoPorCajeroCentavos`, `confirmadoPorDuenoCentavos` y `confirmadoSinRegistroCentavos` (pagos de antes de la migración); suman `totalCentavos` del método. `efectivoEsperadoCentavos`, `totalCentavos` y `cierre_caja_detalle` no cambian.
- [x] Pruebas: `test/integration/pago-confirmado-por.int.ts` (13, probe): cajero confirma TRANSFERENCIA con referencia → `CONFIRMADO` con su usuario y rol; sin referencia → 422 en planes, POS, cuenta, validar con `cobro` y canje de oferta, sin crear nada (ni consumo); referencia repetida → 409; dueño confirma sin referencia (al vender y con `/confirmar`) y el cajero no puede `/confirmar` (403); efectivo sin cambios; reintento idempotente; cierre con cajero, dueño, sin registro y un reverso; aislamiento entre locales (misma referencia en dos locales, cierres separados, 403/404 cruzados, RLS como `bck_api`); barreras de la base (`23001` al reescribir quién en un pago confirmado, `23514` al marcarlo en uno pendiente). Prueba de mutación: con la regla y el registro apagados fallan 9 de 13. Ajustada `checkout.int.ts` (igualdad exacta de `porMetodo`).

### Migración: GRANT y RLS antes y después

Comparado en el contenedor local (`relacl`, `attacl`, `relrowsecurity`/`relforcerowsecurity`, `pg_policies`, `information_schema.column_privileges`, ACL y dueño de `fn_pago_solo_cambia_estado`, triggers):

| Qué                             | Antes                                                                                     | Después                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| `relacl` de `transaccion_pago`  | `postgres=arwdDxt`, `bocadoo_servicio=arwdDxt`, `bocadoo_app=arw`                         | igual                                       |
| GRANT por columna (`attacl`)    | ninguno                                                                                   | ninguno                                     |
| RLS                             | activado, sin FORCE                                                                       | igual                                       |
| Políticas                       | `tenant_total` (ALL), `comensal_lee_pagos_cuenta` (SELECT)                                | igual                                       |
| `column_privileges` por grantee | 19 columnas                                                                               | 22 (las 3 nuevas heredan el GRANT de tabla) |
| `fn_pago_solo_cambia_estado`    | dueño `postgres`, SECURITY INVOKER, EXECUTE a `PUBLIC`, `bocadoo_app`, `bocadoo_servicio` | igual                                       |
| Triggers                        | `trg_auditoria_transaccion_pago`, `trg_pago_solo_cambia_estado`                           | igual                                       |

### Decisiones

- **Quién confirma sale de la sesión**, en SQL (como `PERSONAL_ACTUAL`), no del JWT ni del body. El rol que se guarda es el del momento (si el cajero pasa a dueño después, sus pagos anteriores siguen como de cajero).
- **Reversos al grupo del original**, para que cajero + dueño + sin registro sume siempre el total del método.
- **Efectivo también se registra y desglosa**: quien lo cobra es quien lo confirma.
- **El dueño sigue sin necesitar referencia**, ni al cobrar ni al confirmar después.
- **La regla vive en la API, no en la base**: un CHECK no puede saber si el método es efectivo (`metodo_pago.es_efectivo`) ni el rol de la sesión. La base sí impide reescribir quién confirmó o marcarlo sin confirmar.

### Límites

- **`GET /v1/pagos/pendientes` sigue listando solo pagos de planes**: los pendientes de POS y de cuentas solo se ven en `pagosPendientes` del cierre o en cada venta o cuenta. Queda para otra PR (decisión del dueño).
- Los pagos que ya existen (también los del seed de demo) quedan con quién confirmó en NULL y salen en `confirmadoSinRegistroCentavos`.
- La referencia se valida en forma (1..100, sin espacios al borde) y en unicidad por local y método, no contra el banco.

## Reportes y cierre con cuentas de cobro (entrega D, PR 8; rama `feat/reportes-cuentas`)

**Sin migración**, solo campos nuevos (`pnpm openapi:breaking` limpio). El cierre de caja y los reportes del dueño incluyen lo cobrado en cuentas. Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades).

- [x] **Hallazgo:** el dinero de las cuentas ya entraba en el cierre (los pagos de cuentas van en `porMetodo[].posCentavos`, una vez cada uno por `ck_pago_origen_unico`). Lo que faltaba eran los almuerzos sueltos de cuentas, el desglose, y en el resumen diario los pagos de cuentas salían como `pedidos` (`CASE … ELSE 'pedidos'`).
- [x] Una sola definición para cierre y reportes: `src/cobro/resumen-dia.ts` (`resumenCuentasDia`). Reglas: ABIERTA no suma (se informa); COBRADA suma por el método de sus pagos CONFIRMADOS; PENDIENTE y RECHAZADO no suman dinero; ANULADA no suma. Almuerzos sueltos = líneas `CAJA` de tipo `ALMUERZO` no omitidas de cuentas COBRADAS (las `PLAN` ya están en `consumo_almuerzo`), por el día local de la línea.
- [x] Cierre: `cuentasCobradas { cantidad, totalCentavos }`, `porMetodo[].cuentasCentavos`; `almuerzosSueltos`, `almuerzosServidos` y `almuerzosParaLlevar` suman los de cuentas COBRADAS. `efectivoEsperadoCentavos` y `totalCentavos` no cambian de fórmula.
- [x] `resumen-diario`: `ingresos.porOrigen.cuentas` (y `pedidos` deja de mezclarlas) y `cuentas { cobradas, abiertas, saldoAbiertasCentavos, almuerzosSueltos }`. `ranking-platos`: `unidadesCuentas` (QR y mesa; las de pedido se excluyen porque ya están en `orden_detalle`). `horas-pico`: `cuentas` y `totalCuentas`, informativos (no entran en `total`).
- [x] `test/integration/reportes-cuentas.int.ts` (7): QR sin plan cobrado en efectivo y por transferencia; para llevar; ABIERTA solo en `cuentasAbiertas`; ANULADA y pago RECHAZADO (y PENDIENTE) no suman; sin doble conteo con POS y plan; reporte = cierre del mismo día (con una cuenta de pedido); aislamiento entre locales. Ajustadas las pruebas que comparaban estas respuestas con igualdad estricta.

Decisiones (consultadas): `porOrigen.cuentas` sale de `pedidos`; solo COBRADAS cuentan en almuerzos y ranking; los almuerzos y platos van por el día de su línea; ranking sin cuentas de pedido.

Límites conocidos:

- Una cuenta cobrada con un pago `PENDIENTE` queda `COBRADA`: su almuerzo cuenta como suelto aunque el dinero aún no esté en el arqueo; al rechazarse el pago vuelve a `ABIERTA` y deja de contar.
- `almuerzosParaLlevar` usa `cuenta.para_llevar` (una marca por cuenta): en una cuenta de mesa `INVITO_YO` con miembros mixtos cuenta todos o ninguno.
- Anular una cuenta de un día ya cerrado resta sus almuerzos de ese día en el reporte (cuenta COBRADA → ANULADA), mientras el dinero se revierte el día de la anulación; `movimientosDespuesDelCierre` solo mira el efectivo.

## Carta fija en pedidos y recargo por unidad (entrega D, PR 7a; rama `feat/pedidos-carta-recargo`)

`POST /v1/mis/pedidos` y `POST /v1/mis/pedidos/cotizar` aceptan `cartaItems` (carta fija), el recargo para llevar pasa a ser por unidad de `ALMUERZO` y `A_LA_CARTA`, y `totalCentavos` / `recargoLlevarCentavos` del pedido salen de lo guardado y coinciden con la cotización. **Una migración aditiva** (`20261122200000_orden_detalle_es_carta`: `orden_detalle.es_carta BOOLEAN NOT NULL DEFAULT false`), probada solo en `bocadoo-test-pg` (up, rollback y up); **falta aplicarla en Neon** con `pnpm db:migrate --remoto` antes del merge. Las columnas de dinero (`recargo_unitario_centavos`, `precio_almuerzo_centavos`) ya existían desde el PR 4 y `orden_cabecera` no tiene columna ni FK del menú que sea `NOT NULL`: el pedido solo de carta no necesita más esquema. Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades).

### Checklist

- [x] `cartaItems: [{ platoId, cantidad }]` (hasta 10, cantidad entera 1–10) en crear y cotizar. Reglas: `platoAgotadoSql` → 409 `PLATO_AGOTADO`; inexistente, de otro local, inactivo o de categoría `ALMUERZO` → 422 `PLATO_NO_DISPONIBLE`; sin precio → 422 `PLATO_SIN_PRECIO`.
- [x] Tope combinado `extras` + `cartaItems` ≤ 10 renglones (400 `PEDIDO_DEMASIADOS_ITEMS`); los duplicados de `platoId` se permiten (un renglón por entrada, como en `extras`) y el mismo plato puede ir en `extras` y en `cartaItems`.
- [x] Un pedido solo de carta no exige menú publicado; `assertMenuPublicado` solo con almuerzo o extras. `PEDIDO_VACIO` cuenta `cartaItems`.
- [x] Líneas con precio congelado: cada renglón guarda `precio_unitario_centavos` y `recargo_unitario_centavos`, calculados por `cotizar` (misma regla y mismo mapeo por categoría; `src/billing` sigue puro). El recargo del almuerzo (una unidad) va en su primer renglón de plato.
- [x] `totalCentavos` = `cotizacion.saldoPorCobrarCentavos` y `recargoLlevarCentavos` = `cotizacion.recargoCentavos` al crear; `create` verifica que lo que va a insertar coincide con la cotización y falla si no. Pedidos viejos (todo en 0) siguen con la regla vieja y no se reescriben.
- [x] `cartaItems` en `PedidoResponse` y `PedidoCaja` (lista, detalle, `canjear`, `servir`; dueño y cajero); `extras` no cambia; la cotización de un pedido creado trae las líneas de carta (`carta:i`).
- [x] Canje: un pedido solo de carta no toca el plan, abre la cuenta `ABIERTA` y se cobra por cuentas; con almuerzo + carta el plan solo cubre el almuerzo. El canje y la lectura usan el recargo unitario guardado en el pedido.
- [x] `POST /v1/mis/pedidos` con P = 0 y sin plan → 409 `ALMUERZO_SIN_PRECIO` como cotizar (un solo cálculo compartido: `cotizacionDelPedido`).
- [x] `cotizar` ya no responde 409 `PEDIDO_ACTIVO`; crear lo conserva.
- [x] OpenAPI corregido y `docs/openapi.json` regenerado (`openapi:lint` limpio; `openapi:breaking` marca 16 errores que son correcciones de contrato ya validado por el servidor: ver la nota de la sección Novedades; etiqueta `cambio-incompatible`).
- [x] `test/integration/pedidos-carta.int.ts` (11 casos): carta sin menú, plan + A_LA_CARTA para llevar (total = saldo), tope y duplicados, validaciones, menú solo con almuerzo/extras, canje de carta sola y de almuerzo + carta, recargo congelado, pedido anterior, P = 0 y `PEDIDO_ACTIVO`. Se actualizaron los 3 casos de `cotizaciones.int.ts` que fijaban la divergencia y el 409 de cotizar. Unitaria de `entradaPedido` con carta.

### Decisiones

- **Marcador `es_carta`:** carta y extras del menú quedan iguales en `orden_detalle` (sin sección, con precio); hacía falta una marca para sacar `cartaItems` aparte sin cambiar `extras`. Decidido con migración aditiva en vez de inferir por categoría (que habría movido extras del menú y pedidos históricos).
- **Plan al crear:** ahora se estima con `cargarPlanes` (suma `almuerzos_restantes` y exige `dias_validos`, igual que cotizar). Antes `create` solo miraba que hubiera un plan vigente, aunque no tuviera saldo.
- **Recargo congelado:** si algún renglón guardó recargo > 0, ese es R; si todos están en 0 se usa el del local de hoy (un pedido anterior, o uno hecho con R = 0).

### Huecos de dinero que se vieron (no se cambiaron)

- Un pedido hecho con R = 0 para llevar y después con R subido: su `cotizacion` informativa y el canje usan el R de hoy (no hay forma de distinguir «R = 0 congelado» de «pedido anterior»); el `totalCentavos` guardado no cambia y el canje con `cobro` puede dar `SALDO_CAMBIO`, que la caja confirma.
- `GET /v1/caja/movimientos`: un pedido solo de carta sale con `platoNombre: null` (solo junta los platos del almuerzo) y su `monto` sigue siendo `total_centavos` (lo por cobrar al pedir), como antes.
- Un plato de la carta que se agota o se desactiva después de pedir se canjea igual (el pedido ya congeló plato y precio); no hay revalidación en caja.
- Canje sin `cobro` de un almuerzo sin precio (P = 0 sin plan) sigue sin cuenta (I-12, PR 6c).

### Límites

- **No entra aquí:** ofertas en pedidos ni en mesas, `paraLlevar` por línea (POS), regla completa de `SALDO_CAMBIO`, cambios de `venceEn` o `horaLlegada`, retirar o deprecar `extras`, retirar `aplicarSeleccion`, reportes.

## Hora de llegada en pedidos (rama `feat/pedido-hora-llegada`)

`POST /v1/mis/pedidos` acepta `horaLlegada` opcional: la app ya la mandaba y recibía 400 (campo no permitido). **Una migración aditiva** (`20261122190000_orden_hora_llegada`: `orden_cabecera.hora_llegada TIMESTAMPTZ`, nullable, sin default ni backfill), probada solo en `bocadoo-test-pg` (up, rollback y up); **falta aplicarla en Neon** con `pnpm db:migrate --remoto` antes del merge. Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades).

### Checklist

- [x] Validación compartida con las mesas: `src/common/hora-llegada.ts` (`ARRIVAL_WINDOW`, `horaLlegadaEnVentana`), usada por `POST /v1/mis/mesas` y por pedidos. Ventana de 5 min atrás a 12 h adelante, mismo 400 `HORA_LLEGADA_INVALIDA`; formato con `@IsISO8601({ strict: true })` como en mesas (400 `BAD_REQUEST`).
- [x] `POST /v1/mis/pedidos/cotizar` comparte el DTO y valida igual (antes también respondía 400 si llegaba el campo).
- [x] Se guarda al crear y sale en `PedidoResponse` (crear, detalle, listado, cancelar) y en `PedidoCaja` (lista y detalle de caja, `canjear` → `pedido`, `servir`) para cajero y dueño: todas pasan por `ORDER_SELECT` + `renderOrders`. `null` si no se manda.
- [x] Sin cambios de RLS ni de GRANT: la columna cae bajo las políticas de `orden_cabecera` y el `GRANT SELECT, INSERT, UPDATE` por tabla de `bocadoo_app`.
- [x] `docs/openapi.json` regenerado: `openapi:lint` limpio, `openapi:breaking` sin cambios incompatibles (campo opcional en el cuerpo, campo nuevo en la respuesta).
- [x] `test/integration/diner-orders.int.ts` (+4, 10 en total): válida (incluido el borde de 3 min atrás) se persiste y se devuelve en cada vista; ausente → `null` en la base y en las respuestas; más de 5 min atrás y más de 12 h → `HORA_LLEGADA_INVALIDA` (también en `cotizar`) sin crear nada; formatos inválidos → 400 `BAD_REQUEST`; la caja de otro local no ve el pedido (404, lista vacía y RLS por tenant). `test/unit/hora-llegada.spec.ts`: bordes exactos de la ventana.

### Límites

- Fija el vencimiento: `venceEn = max(creadoEn, horaLlegada) + 30 min` (helper `src/orders/vencimiento.ts`; sin hora, `creadoEn + 30 min`; pedidos ya creados no cambian). No cambia el cobro, y la caja no ordena ni filtra por ella.
- Un reintento con la misma `Idempotency-Key` devuelve el pedido guardado sin revalidar la ventana.
- Se acepta cualquier ISO 8601 con zona (como en mesas), no solo `Z`; la respuesta siempre sale en UTC.
- **No entra aquí** (entró en el PR 7a, arriba): `cartaItems`, recargo por unidad, ofertas ni campos derivados.

## Carta sin caché (rama `feat/carta-sin-cache`)

`GET /v1/restaurantes/{slug}/carta` manda siempre `Cache-Control: no-store, no-cache, must-revalidate`, para que la app del comensal nunca muestre una carta vieja tras un cambio del dueño o del cajero. Sin migración; cuerpo y categorías sin cambios.

### Checklist

- [x] Cabecera en el 200 y en el 404 `RESTAURANTE_NO_ENCONTRADO`: el controlador la pone en la respuesta **antes** de consultar, y el filtro de errores responde sobre esa misma respuesta, así que el 404 la conserva sin tocar el filtro.
- [x] Helmet (`@fastify/helmet` 13 / `helmet` 8) no pone `Cache-Control` y nada más la escribe en la app: no hay valor contradictorio (la prueba exige un único valor y que Helmet siga poniendo `x-content-type-options`).
- [x] Contrato: cabecera documentada en `api-contrato.md` y en `docs/openapi.json` (200 y 404; `ApiProblems` acepta `headers` opcionales). `openapi:lint` limpio, `openapi:breaking` sin cambios incompatibles.
- [x] `test/integration/carta-fija.int.ts` (+1, 9 en total): cabecera en 200 y 404 (slug inexistente y mal formado) y un plato marcado agotado por el cajero sale `agotado: true` en la siguiente lectura. Sin la línea del controlador la prueba falla (comprobado).

### Límites

- Las respuestas que se cortan antes del controlador (un 429 del rate limit) no la llevan; no traen carta que cachear. Un 5xx del servicio sí la lleva.
- **No entra aquí** (PR 7): carta en pedidos, `horaLlegada` y campos nuevos.

## Huecos de cobro (entrega D, PR 6c; rama `fix/huecos-cobro-6c`)

**Una migración** (`20261122180000_limite_saas_despues_del_plan`, probada solo en `bocadoo-test-pg`; **falta aplicarla en Neon** con `pnpm db:migrate --remoto` antes del merge) y **cambios de comportamiento** sin cambio de esquema: `pnpm openapi:breaking` sin cambios incompatibles (solo suma el 422 de `PATCH /v1/restaurante`); conviene la etiqueta `cambio-incompatible` en la PR. Cierra los tres huecos de cobro que dejó el 6b. Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades).

### Checklist

- [x] **Canje sin `cobro`** (`redeemIn`, `src/orders/orders.ts`): si la cotización final deja saldo > 0, abre la cuenta `ABIERTA` del pedido (origen el pedido, sin pago) con la misma regla que el QR del 6b; con saldo 0, sin cuenta. Sin `cobro` no hay `SALDO_CAMBIO` (no llega saldo esperado). Con `cobro`, sin cambios. La huella de idempotencia no cambia (sin `cobro` ≠ `{ "cobro": {} }`): la misma llave devuelve la misma cuenta (`yaCanjeado: true`) y con otro cuerpo → 409. Dos canjes a la vez: el pedido ya se bloqueaba `FOR UPDATE`, así que el segundo ve `CANJEADA` y la misma cuenta.
- [x] **`porCobrarCentavos`** (decisión de Oe en este PR): con cotización final vale su saldo también sin cuenta. Antes, sin cuenta, la fórmula vieja pedía el almuerzo a P cuando quedaba omitido (`DUPLICADO`, `LIMITE_SAAS`; I-10) aunque la cotización dijera 0. La fórmula vieja solo queda sin cotización (P = 0 sin plan).
- [x] **`LIMITE_SAAS` sin plan**: migración nueva que reordena `fn_descontar_almuerzo` (`CREATE OR REPLACE`, misma firma y salida): primero busca el plan FIFO; si no hay plan que descontar hoy responde la razón real (`SIN_PLAN`, `SIN_SALDO`, `VENCIDO`, `DIA_NO_VALIDO`) y la caja cobra el almuerzo a P; solo con plan mira el límite SaaS. `LIMITE_SAAS` sigue sin devolver `suscripcion_id`. Vale para QR, búsqueda manual, preorden y mesa sin tocar código de la API.
- [x] **P > 0** (`src/restaurant/restaurant.service.ts`): `PATCH /v1/restaurante` con `precioSueltoCentavos: 0` en un local `ACTIVO` → 422 `PRECIO_ALMUERZO_REQUERIDO` y no guarda nada del PATCH. `activar` ahora bloquea la fila (`FOR UPDATE`): sin eso, un PATCH a 0 simultáneo podía dejar un local `ACTIVO` con P = 0 (la prueba de concurrencia falla 3 de 3 sin el candado). `null`/`""` siguen en 400 por el DTO (columna NOT NULL), en cualquier estado.

### Por qué migración y no una consulta del plan aparte

- Un solo lugar: los cuatro canales (QR, MANUAL, PREORDEN, MESA) llaman a la función; la alternativa repetía la consulta (o la metía en `deduct`) y la mesa `INVITO_YO`, que descuenta varias unidades seguidas, la habría tenido que repetir por unidad.
- La respuesta es verdadera en la base: `intento_escaneo` registra `SIN_PLAN` (no `LIMITE_SAAS`) y `rechazadosPorLimite` de `GET /v1/suscripcion/uso` deja de contar a quien no tenía nada que descontar. Con la consulta aparte, el intento y el `resultado` habrían dicho `LIMITE_SAAS` mientras se cobraba P.
- Atómico: el plan se lee bajo el candado de la ficha que ya toma la función, en la misma sentencia; una consulta aparte leería el plan sin ese candado.
- Menos candados: quien no tiene plan ya no bloquea la fila SaaS del local. El orden es ficha → plan → SaaS; ninguna otra función bloquea SaaS y luego un plan.

### Migración: GRANT y RLS antes y después

| Objeto                                                                       | Antes                                                                                                                               | Después                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `fn_descontar_almuerzo(bigint ×3, uuid, canal, boolean, bigint ×3, boolean)` | `SECURITY DEFINER`, dueño `postgres`, `search_path = public, pg_temp`, `EXECUTE` a `bocadoo_app` y `bocadoo_servicio` (no a PUBLIC) | Igual (`CREATE OR REPLACE` conserva dueño y ACL); solo cambia el orden plan → límite SaaS |
| Políticas RLS, tablas y demás funciones                                      | —                                                                                                                                   | Sin cambios                                                                               |

Verificado con `pg_proc.proacl`, `prosecdef`, `proconfig` y `md5(prosrc)` antes de `up`, tras `up`, tras `down` (el `md5` vuelve exacto al original) y tras el segundo `up`.

### Verificación

- [x] `test/integration/huecos-cobro.int.ts` (15, probe): canje sin cobro con saldo (con plan para llevar + Cola, quien no es cliente, cuerpo `{}`), saldo 0 sin cuenta, plan agotado entre pedir y canjear (sin `cobro` abre la cuenta; con `{ "cobro": {} }` sigue el 409 `SALDO_CAMBIO`), idempotencia con y sin plan (misma cuenta, `IDEMPOTENCY_KEY_REUTILIZADA` con otro cuerpo u otro pedido), `LIMITE_SAAS` con plan (solo la Cola); `LIMITE_SAAS` por suspensión y por tope (ficha sin plan → `SIN_PLAN` con cuenta P, con plan → `LIMITE_SAAS`, plan de otro día → `DIA_NO_VALIDO` con cuenta, contador y `rechazadosPorLimite`), canje de una ficha sin plan en un local suspendido, la función como `bck_api` (tenant propio y ajeno) y `bck_servicio`, y su ACL; `PATCH` con 0 / `null` / `""` / negativo en `ACTIVO`, `BORRADOR` y `PAUSADO`, `activar` sin precio, cajero 403, otro dueño 403, Swagger del 422; roles (cajero, otro local 404, comensal 403, sin sesión 401) y RLS de la cuenta como `bck_api` y `bck_servicio`. Las de `LIMITE_SAAS` fallan con la función vieja (comprobado con `down`).
- [x] `test/integration/huecos-cobro-concurrency.int.ts` (3, clon descartable): dos cajas canjean el mismo pedido a la vez (4 veces, con y sin plan) → una cuenta, un consumo; la misma llave 4 veces a la vez → todas 200, una cuenta; PATCH a 0 contra `activar` (4 veces) → nunca `ACTIVO` con P = 0.
- [x] Ajustadas: `cuentas-caja.int.ts` y `cotizaciones.int.ts` asumían que el canje sin cuerpo no abre cuenta.
- [x] Resultados: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (965), `pnpm openapi:lint` limpio y `pnpm openapi:breaking` (sin cambios incompatibles). Integración contra `bocadoo-test-pg` (nunca Neon): **51 de 51 suites, 448 de 448 pruebas**.

### Huecos que quedan (no se cambiaron en este PR)

- **Reintento de un canje sin cuenta con el almuerzo omitido** (`yaCanjeado: true`): la cotización se reconstruye como `SIN_PLAN` porque no se guarda el resultado del primer canje, así que `porCobrarCentavos` del reintento vuelve a pedir P (+ R). Solo pasa con `DUPLICADO`/`LIMITE_SAAS` y saldo 0 (sin cuenta).
- **Local `PAUSADO` con P = 0**: el PATCH lo permite (la regla es para `ACTIVO`) y la caja sigue atendiendo un local pausado, así que un QR o canje sin plan sigue sin cotización ni cuenta. Se puede cerrar exigiendo P > 0 también en `PAUSADO` o con un CHECK en la base cuando la consulta de Neon dé 0 filas.
- ~~**Validar mesa con `aplicarSeleccion: false`**: sin cambios (PR 9).~~ Retirado en el PR 9.
- **Candados de mesa `CADA_UNO` contra un QR del mismo miembro** (sin verificar con prueba): la mesa descuenta miembro por miembro en una transacción y la fila SaaS queda tomada desde el primero; un QR simultáneo de otro miembro toma su ficha y luego espera la fila SaaS. Ya existía con el orden anterior; el nuevo lo reduce (quien no tiene plan no toma la fila SaaS).

## Cuenta automática del QR (entrega D, PR 6b; mezclado en `main`)

**Sin migración** y **un cambio de comportamiento** en `POST /v1/caja/validar` (E.4, H.2): sin `items` ni `cobro`, si la cotización final deja saldo > 0 se abre la cuenta `ABIERTA` y se devuelve en `cuenta`. Así el almuerzo suelto de quien no tiene plan, y el recargo para llevar de quien sí lo tiene, nunca quedan sin registrar. `pnpm openapi:breaking` no lo detecta (0 errores: el esquema no cambia); conviene la etiqueta `cambio-incompatible` en la PR. Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades).

### Checklist

- [x] `validateIn` (`src/checkout/checkout.ts`): la cuenta ya no depende de `items`/`cobro`; con saldo 0 y sin platos sigue sin cuenta (G-17). Origen: el consumo si hubo plan; si no, el intento de escaneo (como en 5b). Un QR de alguien que no es cliente del local ya no sale antes con `SIN_PLAN` sin cotización: se cotiza a P y abre su cuenta.
- [x] `DUPLICADO` sin plan (decisión de Oe): quien no tiene plan no deja consumo, así que la regla de 60 s de `fn_descontar_almuerzo` no lo veía. Ahora, si esa persona (misma ficha o mismo usuario) ya tiene una cuenta QR sin consumo creada hace < 60 s y no `ANULADA`, responde `DUPLICADO`, `cuenta: null`, aviso `DUPLICADO`, y registra el intento `DUPLICADO`. Vale entre QR y búsqueda manual. La regla del plan no cambia.
- [x] Candado por persona: `pg_advisory_xact_lock(7002, hashtext('u:<usuario>' | 'c:<cliente>'))` antes de las comprobaciones de idempotencia (antes del candado de fila de `fn_descontar_almuerzo`; nadie más toma 7002, sin interbloqueos). Dos cajas a la vez: una abre la cuenta y la otra ve `DUPLICADO`; la misma llave repetida a la vez ve la cuenta de la primera.
- [x] P = 0 sin `items` ni `cobro` (decisión de Oe): como antes, `SIN_PLAN` sin cotización ni cuenta. Con ellos, el 409 `ALMUERZO_SIN_PRECIO` de siempre.
- [x] `DUPLICADO` y `LIMITE_SAAS` siguen sin cobrar nada; la huella de idempotencia no cambia (sin `items` ni `cobro` = otro cuerpo que con `{ "cobro": {} }`).

### Verificación

- [x] `test/integration/cuentas-qr.int.ts` (37, probe; 12 nuevas): QR sin plan → cuenta `ABIERTA` con la cotización (P, línea `ALMUERZO`/`CAJA`, origen el intento `SIN_PLAN`, a nombre del comensal) y cobro por `/cobrar`; para llevar en `DESPUES_DE_SERVIR` (P + R) y `MANUAL` de una ficha sin plan; G-17, 18a, 18b (con G-43: deshacer la anula), 20, 21 (sin `cobro`), 22 y 23 sin `items` ni `cobro`; `DUPLICADO` sin plan (también con `items`/`cobro`; anulada o pasados 60 s abre otra) y entre canales; idempotencia (misma llave → misma cuenta, un consumo; otro cuerpo → 409) con y sin plan; roles (cajero, otro local 404, comensal 403, sin sesión 401) y RLS como `bck_api` (local, comensal dueño, ajeno, otro local) y `bck_servicio`. La prueba de 5b «sin items ni cobro no crea cuenta» se reemplazó por estas.
- [x] `test/integration/cuentas-qr-concurrency.int.ts` (8, clon descartable; 3 nuevas): dos cajas con el mismo QR sin plan (4 veces) y con plan para llevar (3 veces): una cuenta y un `DUPLICADO`; la misma llave 4 veces a la vez: una cuenta, un intento. Sin el candado fallan las dos de «sin plan» (comprobado quitándolo).
- [x] Ajustadas: `cuentas-cobro.int.ts` (validar una ficha sin plan ya abre la cuenta de su intento) y `cuentas-caja.int.ts` (G-48 de pedido contaba todas las cuentas de la base; `checkout.int.ts`, sin probe, ahora confirma una cuenta propia).
- [x] Resultados: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (965), `pnpm openapi:lint` limpio y `pnpm openapi:breaking` (0 errores). Integración contra `bocadoo-test-pg` (nunca Neon): **49 de 49 suites, 430 de 430 pruebas**.

### Huecos en otras rutas (no se cambiaron en este PR; los de canje, `LIMITE_SAAS` y P = 0 se cerraron en el PR 6c)

- **Canje de pedido sin `cobro`** (`POST /v1/caja/pedidos/{id}/canjear`): sigue sin cuenta; `porCobrarCentavos` informa lo que falta, pero el almuerzo suelto de un pedido sin plan (y el recargo y los extras) no queda registrado. Propuesta: la misma regla del QR (saldo > 0 → cuenta `ABIERTA`), sin `SALDO_CAMBIO` cuando no hay `cobro` (la confirmación de I-6 solo aplica a quien cobra), anunciada como cambio de comportamiento.
- ~~**Validar mesa con `aplicarSeleccion: false`**: 1 almuerzo por miembro y `cuentas: []`; quien no tiene plan queda en `porCobrar` sin cuenta.~~ **Cerrado en el PR 9**: se retiró la opción (cualquier campo en el cuerpo → 400).
- **`LIMITE_SAAS` de un cliente sin plan**: `fn_descontar_almuerzo` mira el límite SaaS antes que el plan, así que una ficha sin plan en un local suspendido responde `LIMITE_SAAS` y no se cobra su almuerzo suelto (I-10 pensaba en lo ya prepagado). En cambio, un QR de alguien que no es cliente nunca pasa por la función y sí abre cuenta. Propuesta: en `LIMITE_SAAS`, si la persona no tiene plan vigente, cobrar a P (necesita consultar el plan aparte o cambiar el orden en la función: migración).
- **P = 0** sin `items` ni `cobro`: el almuerzo y el recargo para llevar no se cobran (decisión de este PR). Propuesta: exigir P > 0 también en `PATCH /v1/restaurante` de un local `ACTIVO`.
- **POS y canje de oferta**: cobran en el momento (pago en la misma transacción); sin hueco.

## La mesa se cobra con la selección (entrega D, PR 6a; rama `feat/mesas-cobro-6a`)

**Una migración** (`20261122120000_mesa_salida_rls`, probada solo en `bocadoo-test-pg`; **falta aplicarla en Neon** con `pnpm db:migrate --remoto` antes del merge) y **un cambio incompatible de comportamiento** (I-4): `POST /v1/caja/mesas/{id}/validar` sin cuerpo cobra la selección. `pnpm openapi:breaking` no lo detecta (el cuerpo es opcional, 0 errores); conviene la etiqueta `cambio-incompatible` en la PR para dejarlo a la vista. Cierra INC-01 (validar mesa descontaba un almuerzo a cada miembro sin mirar lo que pidió). Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades); flujo en [`docs/mesas-flujo.md`](mesas-flujo.md).

### Checklist

- [x] `validar` mesa: una sola cotización de la selección de los miembros activos → `descontarYRecotizar` (`src/cobro/aplicar.ts`) → una cuenta `ABIERTA` por pagador con saldo (`origen` mesa + miembro; en `INVITO_YO` una sola del anfitrión, recargos incluidos). Sin cuenta si el saldo es 0. Sin `cobro` en `validar`. Llave por miembro `deriveKey(K, miembro_id)` (consumo) y `deriveKey(K, 'cuenta:' + miembro_id)` (cuenta); el reintento devuelve las mismas cuentas.
- [x] `aplicarSeleccion` (default `true`); `false` = 1 almuerzo por miembro, cotización informativa y `cuentas: []`.
- [x] Candados: la mesa `FOR UPDATE` y luego `pg_advisory_xact_lock(miembro_id)` de cada miembro en orden; `fn_salir_mesa` y `PUT …/seleccion` toman el mismo candado del miembro después de la mesa (mismo orden, sin interbloqueos).
- [x] `POST /v1/mis/mesas/{id}/salir` (E.7) y `miembros[].salio`; quien salió no cuenta en `personas`/`cubiertos` ni en la cotización.
- [x] Migración: políticas de la selección con `salio_en IS NULL`; `fn_mesa_invitacion` cuenta solo activos; `fn_unirse_mesa` reactiva a quien salió (misma fila, selección vacía); `fn_salir_mesa` con el candado del miembro. Up/down/up en local.
- [x] Cotización del comensal con `fn_plan_pagador_mesa` (E.6): ya no hay `null` por el plan ajeno.
- [x] `cotizar` (puro): `PlanPersona.trasAgotarse` para que un `DUPLICADO`/`LIMITE_SAAS` de la base a mitad del plan omita el resto (B.3 paso 5, I-10) en vez de cobrarlo a P.
- [x] 409 `CUENTA_DE_MESA` al agregar o quitar platos en una cuenta de mesa (antes era un 500 latente).

### Migración: GRANT y RLS antes y después

| Objeto                                             | Antes                                                              | Después                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `mesa_compartida_miembro_item` (tabla)             | `bocadoo_app=ard`, `bocadoo_servicio=arwdDxt`                      | Igual                                                                           |
| Política `comensal_lee` (SELECT)                   | Mi miembro (sin mirar `salio_en`) o soy anfitrión                  | Mi miembro **con `salio_en IS NULL`** o soy anfitrión                           |
| Política `comensal_escribe` (INSERT)               | Mi miembro y mesa abierta sin validar                              | Mi miembro **activo** y mesa abierta sin validar                                |
| Política `comensal_borra` (DELETE)                 | Mi miembro y mesa abierta sin validar                              | Mi miembro **activo** y mesa abierta sin validar                                |
| Política `personal_lee`, tablas `mesa_compartida*` | —                                                                  | Sin cambios                                                                     |
| `fn_mesa_invitacion(uuid)`                         | `SECURITY DEFINER`, `EXECUTE` a `bocadoo_app` y `bocadoo_servicio` | Igual; cuenta solo miembros activos y `YA_ERES_MIEMBRO` solo si sigo en la mesa |
| `fn_unirse_mesa(uuid, boolean)`                    | `SECURITY DEFINER`, `EXECUTE` a `bocadoo_app` y `bocadoo_servicio` | Igual; reactiva la fila de quien salió                                          |
| `fn_salir_mesa(uuid)`                              | `SECURITY DEFINER`, `EXECUTE` solo a `bocadoo_app`                 | Igual; toma `pg_advisory_xact_lock(miembro_id)` antes de borrar la selección    |
| `fn_plan_pagador_mesa(bigint, bigint)`             | `SECURITY DEFINER`, `EXECUTE` solo a `bocadoo_app`                 | Sin cambios (no la toca esta migración)                                         |

Verificado con `pg_class.relacl`, `pg_proc.proacl` y `pg_policy` antes y después de `up` y tras `down`/`up`. Las tres funciones conservan `search_path = public, pg_temp`.

### Verificación

- [x] `test/integration/mesa-cobro.int.ts` (25, probe): G-28, 30, 31, 32, 34, 35, 36, 38, 39, **46 literal** (la cuenta `INVITO_YO` del caso 31, 500 EFECTIVO + 225 TRANSFERENCIA, reintento y saldo viejo) y 47; cuerpo vacío/`{}`/`true` iguales, campo de más → 400; deshacer en una cuenta de mesa; `CUENTA_DE_MESA`; anular; lista por `origen=MESA`; salir (200, repetir, anfitrión, validada, cancelada, no miembro); reingreso (cupo sin los que salieron, mesa llena, validada); cotización del comensal en `CADA_UNO` e `INVITO_YO` igual a la de la caja; RLS como `bck_api` (quien salió no lee, no inserta ni borra selección; `fn_plan_pagador_mesa` le da `NULL`; el anfitrión sigue leyendo) y `bck_servicio` (ve todo, no ejecuta `fn_salir_mesa`); cuentas de mesa: el pagador ve la suya, el invitado de `INVITO_YO`, un ajeno y otro local no; roles (comensal 403, otro local 404, cajero 200).
- [x] `test/integration/mesa-cobro-concurrency.int.ts` (4, clon descartable): validar contra salir (se vieron los dos órdenes en cada corrida), dos cajas validando a la vez, la misma llave 4 veces a la vez, elegir contra salir.
- [x] Pruebas viejas ajustadas al nuevo default: `checkout.int.ts` (mesas con `aplicarSeleccion: false` y el 409 `ALMUERZO_SIN_PRECIO` del default sin precio), `cotizaciones.int.ts` (visibilidad sin `null`; E.5 con `false`), `diner-tables.int.ts` (`salio`).
- [x] Unitarios: `cotizar.spec.ts` y `cobro-aplicar.spec.ts` (`trasAgotarse`, G-31 con la base respondiendo `SIN_SALDO`, `LIMITE_SAAS` a mitad y al inicio).
- [x] Resultados: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (965), `pnpm openapi:lint` limpio y `pnpm openapi:breaking` (0 errores). Integración contra `bocadoo-test-pg` (nunca Neon): **49 de 49 suites, 415 de 415 pruebas**.

### Decisiones y límites

- **Sin `cobro` en `validar` mesa** (B.5 literal): las cuentas nacen `ABIERTA` y se cobran por `POST /v1/caja/cuentas/{id}/cobrar`.
- **Saldo 0 = sin cuenta** (como el QR): `cuentaId: null` y deshacer sigue igual.
- **Reingreso permitido** con las reglas de un invitado nuevo.
- **Ofertas en la selección** (G-29, G-33) pasan al PR 7.
- **Quien salió sigue viendo la mesa** (salir responde la mesa, E.7) pero no selecciones ni cotizaciones.
- **Salir después de validar → 409 `MESA_CERRADA`** (D): su cuenta queda `ABIERTA` para cobrarla o anularla.
- **`SIN_ALMUERZO`**: nuevo valor de `resultados[].resultado` para quien solo pidió platos sueltos (no hubo escaneo de almuerzo).
- **`porCobrar`** con selección = almuerzos que van a cuenta a precio suelto.
- **Agregar/quitar en cuentas de mesa → 409 `CUENTA_DE_MESA`**: recotizar una cuenta de varios comensales queda para después.
- **Límite conocido:** el 409 `IDEMPOTENCY_KEY_REUTILIZADA` de un reintento con otro cuerpo solo se detecta si la primera validación dejó alguna cuenta (la huella va en la cuenta); sin cuentas, responde `yaValidada`.
- **Preexistente, sin cambio:** `personaRef`/`pagadorRef` de las cotizaciones de mesa son `miembro_id` internos (spec B, `ref` = `miembro_id`), visibles al anfitrión, a la caja y ahora al invitado en su propia cotización. Si se quiere ocultar, es un cambio de contrato aparte.

## Blindaje de las pruebas contra Neon (rama `chore/blindar-pruebas-db`)

Sin migraciones ni cambios de contrato. Detalle y comandos en [`docs/pruebas.md`](pruebas.md).

- [x] `vitest.db.config.ts` ya no lee `.env`; su `globalSetup` aborta si alguna `DATABASE_*`, `PROBE_*`, `PGHOST` o `PGHOSTADDR` no tiene host local (host parseado, nunca búsqueda de texto) y, ya conectado, si el servidor define `neon.tenant_id`.
- [x] `src/jobs/cli.ts` carga `.env` solo al lanzarse como proceso (importado desde `jobs-concurrency.int.ts` lo cargaba en el worker).
- [x] `scripts/db.mjs` imprime siempre el destino; fuera de local exige `--remoto`, `db/migrations` sin cambios y escribir el host. No exige `main`. `scripts/load-seed.mjs` con la misma barrera.
- [x] `pnpm test:db:local` (`scripts/test-db-local.sh`) contra `bocadoo-test-pg`.
- [x] Unitarias de la validación del host: `test/unit/db-guard.spec.ts`.
- [x] Resultados: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (950). Integración contra `bocadoo-test-pg`: **47 de 47 suites, 386 de 386** en la última corrida completa. En la primera fallaron 2 intermitentes (`catalog` «Concurrido», minutos restantes 13,8 en vez de ~20; `cuentas-qr` «sin N+1», 5 cuentas en vez de 6) y, al repetir esas dos suites 3 veces, falló una vez otra de `cuentas-qr` (G-48); `cuentas-qr` también falla de forma intermitente en `main` con el mismo entorno (otra prueba: «cuentasAbiertas»).

## Cuentas del QR en caja, lista del día y líneas (entrega D, PR 5b; mezclado en `main`)

**Una migración** (`20261121160000_referencia_pago_por_restaurante`, **aplicada en Neon** antes del merge: 23 aplicadas, 0 pendientes; las pruebas, solo en `bocadoo-test-pg`) **y sin cambios incompatibles** (`pnpm openapi:breaking`: 0 errores). Cierra INC-04 para el QR (validar con `cobro` deja cuenta y pago registrados). Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades).

### Checklist

- [x] Migración: `uq_pago_referencia_externa` pasa de `(metodo_pago_id, referencia_externa)` a `(restaurante_id, metodo_pago_id, referencia_externa)`, mismo nombre (lo usan `pos.ts`, `sales.ts` y `aplicar.ts` para traducir el 23505) y mismo predicado (`referencia_externa IS NOT NULL AND revierte_a_pago_id IS NULL`). El up comprueba en `pg_indexes` que la definición de partida es la esperada (si no, falla sin tocar nada) y es idempotente. Sin cambios de GRANT, RLS ni políticas (un índice no tiene permisos propios; verificado comparando `relacl`, `relrowsecurity` y `pg_policies` antes y después). El down vuelve al índice global y falla (23505) si ya hay referencias repetidas entre locales.
- [x] `POST /v1/caja/validar` con `items` y `cobro` opcionales: con plan, cuenta del consumo; sin plan (incluido quien no es cliente del local), cuenta del intento de escaneo con el almuerzo a P. `DUPLICADO` y `LIMITE_SAAS` no cobran nada. `SALDO_CAMBIO` sin descontar ni cobrar. Pago en el mismo paso con `cobro.metodoPago`. Sin `items` ni `cobro`, lo de siempre más `cotizacion` informativa. Reutiliza `descontarYRecotizar`, `persistirCuenta` y `registrarPago` de `aplicar.ts`.
- [x] `GET /v1/caja/cuentas`: día local del restaurante (`HOY_TENANT`), filtros `estado` y `origen`, cursor `(creada_en, public_id)` como el resto de la API; render por lote (3 consultas para toda la página).
- [x] `POST /v1/caja/cuentas/{id}/items` y `…/lineas/{ref}/quitar` (E.11): `FOR UPDATE` de la cuenta (como cobrar y anular), recotizan **toda** la cuenta con `cotizar` y los precios guardados, revierten lo que cambia con líneas nuevas y nunca editan montos. Idempotencia por las llaves derivadas de las líneas (`deriveKey`), sin tabla nueva.
- [x] `cuentasAbiertas { cantidad, saldoCentavos }` en `GET /v1/caja/cierre/{fecha}`; los totales de siempre no cambian. Los pagos de cuentas ya estaban en `porMetodo[].posCentavos` (5a) y cada pago tiene un solo origen (`ck_pago_origen_unico`), así que no se cuentan dos veces.
- [x] Reglas de plato suelto compartidas (`src/cobro/platos.ts`): la selección de mesa y la caja validan igual (activo, menú o carta, precio, agotado).
- [x] Funciones puras nuevas en `src/cobro/adaptador.ts`: `entradaQr`, `entradaDeCuenta` (reconstruye la entrada de una cuenta con precios congelados) y `diferenciaLineas` (qué revertir e insertar; nunca toca una unidad del plan).

### Verificación

- [x] `test/integration/cuentas-qr.int.ts` (25, probe): G-44 y G-48 **literales con QR**; G-17, 18a, 18b, 20, 21, 22 (y la regla de 60 s), 23 y 45 con QR; `LIMITE_SAAS`; `SALDO_CAMBIO`; `ALMUERZO_SIN_PRECIO`; QR sin plan (cuenta del intento, a nombre del comensal) y `MANUAL`; lista del día con una zona horaria cuya fecha local no es la UTC, filtros, cursor y sin N+1; agregar (fusión), quitar, `LINEA_DE_PLAN`, `CUENTA_CERRADA`, `SALDO_NEGATIVO`, anulación al quitar todo, idempotencia; cierre con cuentas abiertas y sin doble conteo entre efectivo, transferencia y Deuna; roles (cajero, otro local 404, comensal 403, sin sesión 401); RLS como `bck_api` y `bck_servicio`; referencia externa por local (misma en dos locales sí, repetida en el mismo → 409).
- [x] `test/integration/cuentas-qr-concurrency.int.ts` (5, clon descartable): agregar contra cobrar y quitar contra un pago parcial (nunca queda pagado > por cobrar); la misma llave de agregar 5 veces a la vez; agregar y quitar a la vez; validar con la misma llave 4 veces a la vez (un consumo, una cuenta, un pago).
- [x] Unitarios: `test/unit/cobro-cuenta-qr.spec.ts` (15: G 17–22 con `entradaQr`, recotización sin cambios, precios congelados, fusión, quitar, PLAN emparejadas por orden, ofertas).
- [x] Resultados: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (913), `pnpm openapi:lint` limpio y `pnpm openapi:breaking` (0 errores). Integración contra Postgres 16 local (`bocadoo-test-pg`, nunca Neon): **47 de 47 suites, 386 de 386 pruebas** (las 45 de antes y las 2 nuevas). De las inestables conocidas no falló ninguna en la corrida completa; en una corrida suelta de `cuentas-qr.int.ts` un QR salió `QR_INVALIDO` una vez y no se repitió en 9 corridas (parece la misma inestabilidad del QR de checkout).

### Decisiones y límites

- **La spec choca con lo pedido para este PR** en la cuenta automática: E.4 y H.2 (casos 18 y 20) dicen que un QR con saldo crea la cuenta aunque no lleguen `items` ni `cobro`. Se siguió lo pedido (sin `items` ni `cobro`, sin cambios). **Resuelto en el PR 6b**; activarla después es un cambio de comportamiento que hay que anunciar (H.2).
- **El índice nuevo conserva `metodo_pago_id`**: lo pedido era `(restaurante, referencia_externa)`. Quitar el método endurecería la regla (hoy la misma referencia en dos métodos del mismo local se acepta) y podría fallar con datos existentes en Neon. Si se quiere sin método, es otra migración.
- **La lista devuelve `{ fecha, items, nextCursor }`** y no `Cuenta[]` como dice E.11: se pidió paginación por cursor como el resto. Solo el día de hoy; `estado` por defecto `TODAS`.
- **Códigos nuevos que la spec no listaba:** 404 `LINEA_NO_ENCONTRADA`, 409 `SALDO_NEGATIVO`, 422 `CANTIDAD_INVALIDA` (un plato pasaría de 100 unidades). `CUENTA_CERRADA` también para agregar platos en `ANTES_DE_SERVIR` con pagos (B.5).
- **Quitar quita la línea entera** (no unidades). Una cuenta sin pagos que queda sin líneas pasa a `ANULADA` ("Se quitaron todas las líneas").
- **Agregar un plato que ya está** suma cantidad al precio guardado de esa línea, no al de hoy.
- **Idempotencia de agregar/quitar**: se reconoce por las llaves derivadas de las líneas, que llevan el id de la cuenta; la misma llave usada en **otra** cuenta no se detecta como reutilizada (cada cuenta la trata como nueva).
- **Cuentas de mesa** en agregar/quitar: no soportadas hasta PR 6 (hoy no existen).
- **QR de quien no es cliente sin `items` ni `cobro`:** `cotizacion: null`, como antes (hasta el PR 6b: ahora abre su cuenta).
- **`almuerzosSueltos` del cierre** no cuenta los almuerzos cobrados en cuentas del QR sin plan (solo POS); es el PR 8 de H.1.
- **No entra en 5b:** la selección de mesa como cobro, `salir` y las cuentas de mesa (PR 6); ofertas y carta en pedidos y recargo por unidad (PR 7); reportes (PR 8).

## Cuentas de cobro en caja para pedidos (entrega D, PR 5a; rama `feat/cuentas-caja-5a`)

**Sin migración** (las columnas del snapshot ya estaban en `20261121150100`) **y sin cambios incompatibles** (`pnpm openapi:breaking`: 0 errores; 2 avisos por el `oneOf` de confirmar/rechazar pago). Cierra INC-04 para pedidos (canjear con `cobro` deja la cuenta y su pago registrados) e INC-06 (precio del almuerzo guardado al pedir). Contrato en [`docs/api-contrato.md`](api-contrato.md#novedades).

### Checklist

- [x] `src/cobro/aplicar.ts` (fuera de `src/billing`, que sigue puro): descuenta las unidades PLAN, recotiza con lo que respondió la base y guarda cuenta + líneas de solo-inserción; pagos (parciales, varios métodos), anular (líneas y pagos inversos, pendientes a `RECHAZADO`, almuerzo de vuelta), confirmar/rechazar y deshacer. Un solo punto de entrada que reutilizarán QR (5b) y mesa (PR 6).
- [x] `GET /v1/caja/cuentas/{id}`, `POST …/cobrar`, `POST …/anular` (dueño y cajero; el cajero solo anula cuentas del día local). `FOR UPDATE` de la cuenta en cobrar, anular, confirmar/rechazar y deshacer.
- [x] `POST /v1/caja/pedidos/{id}/canjear` con `cobro` opcional; sin cuerpo, como antes (más `cotizacion`, `cuenta: null`, `avisos`). 409 `SALDO_CAMBIO` contra `saldoEsperadoCentavos` o, sin él, `orden_cabecera.total_centavos`, sin descontar ni cobrar.
- [x] Snapshot `orden_cabecera.precio_almuerzo_centavos` al crear el pedido; la cotización del pedido y el canje lo usan (pedidos viejos: `subtotal − extras` o el precio actual).
- [x] `POST /v1/pagos/{id}/confirmar|rechazar` con pagos de cuenta: actualiza el estado de la cuenta y responde la `Cuenta`.
- [x] Deshacer un consumo con cuenta `ABIERTA` sin pagos: línea inversa (almuerzo y su recargo) y `ANULADA` si queda en 0 (G-43); con cuenta `COBRADA` o con pagos → 409 `CUENTA_COBRADA` (G-45). Se trajo del 5b porque sin esto deshacer un pedido cobrado devolvía el almuerzo y dejaba el pago.
- [x] `deriveKey` y `huella` en `src/common/derive-key.ts` (checkout los reutiliza).

### Verificación

- [x] `test/integration/cuentas-caja.int.ts` (17, probe): G-43, G-45 y G-44, G-46, G-48 adaptados a pedidos (en la spec son de QR y mesa); `SALDO_CAMBIO` con el plan intacto; plan gastado entre pedir y canjear (I-6); INC-06; `ANTES_DE_SERVIR`; validación; confirmar/rechazar; referencia repetida; roles (cajero del día, otro local 404, comensal 403); RLS como `bck_api` y `bck_servicio`.
- [x] `test/integration/cuentas-concurrency.int.ts` (6, clon descartable): pagos simultáneos nunca superan el saldo; misma llave = un pago; doble canje (otras llaves o la misma) = un consumo, una cuenta, un pago; anular y cobrar a la vez.
- [x] Unitarios: `test/unit/cobro-aplicar.spec.ts` (`deriveKey`, `huella`, `estadoPlanDe`, `descontarYRecotizar`) y snapshot en `test/unit/cobro-adaptador.spec.ts`.
- [x] Resultados: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (883), `pnpm openapi:lint` limpio y `pnpm openapi:breaking` (0 errores, 2 avisos). Integración contra Postgres 16 local (`bocadoo-test-pg`, nunca Neon): **45 de 45 suites, 356 de 356 pruebas** (las 43 de antes y las 2 nuevas); ninguna de las inestables conocidas (tiempos de auth, `offers-concurrency`, QR de checkout) falló.

### Decisiones y límites

- **`porCobrarCentavos` sin `cobro`** sigue con la fórmula de siempre (extras + recargo guardado + P si el plan no cubrió), ahora con el P guardado. Solo difiere de `cotizacion.saldoPorCobrarCentavos` en la diferencia conocida de platos `A_LA_CARTA` para llevar (PR 7). Con `cobro`, vale `cotizacion.saldoPorCobrarCentavos` (E.3).
- **`ALMUERZO_SIN_PRECIO`** (P = 0 y sin plan, I-12): solo con `cobro`. Sin cuerpo, el canje sigue como antes.
- **Misma llave sin `cobro` y luego con `cobro`:** el primer canje no deja cuenta ni huella, así que el segundo responde `yaCanjeado: true` con `cuenta: null` en vez de 409. La huella solo existe cuando hay cuenta.
- **`MONTO_EXCEDE_SALDO` (422)** es un código nuevo que la spec no listaba: un pago parcial mayor que el saldo.
- **`REFERENCIA_PAGO_REPETIDA`** era global (el índice `uq_pago_referencia_externa` no llevaba restaurante): la misma referencia de transferencia en dos locales también chocaba. **Resuelto en 5b** (por local).
- **No entra en 5a:** `GET /v1/caja/cuentas` (lista del día), `POST …/items` y `…/lineas/{ref}/quitar` (E.11), `items`/`cobro` en `POST /v1/caja/validar`, `cuentasAbiertas` en el cierre.

## Cuentas de cobro en la base (entrega D, PR 4; rama `feat/db-cuentas-cobro`)

**Solo migraciones y pruebas.** Ningún endpoint ni archivo de `src/` cambia; todo lo nuevo es una tabla nueva, una columna nullable o con default, o una política de solo lectura, así que el código de hoy sigue igual. **Aplicadas en Neon** (22 aplicadas, 0 pendientes, 2026-11-21).

### Migraciones

- `20261121150000_cuentas_cobro` (F.1, F.4, F.5): `cuenta_cobro` (cabecera) y `cuenta_cobro_linea` (libro de solo-inserción, `fn_solo_insercion`); enums `estado_cuenta_cobro_enum`, `tipo_linea_cobro_enum`, `fuente_cobro_enum`, `pagador_linea_enum`, `motivo_omision_enum`.
  - **Cuatro orígenes** (exactamente uno, `ck_cuenta_origen_unico`): `orden_id`, `consumo_id` (QR con plan), `intento_id` (QR sin consumo, p. ej. almuerzo sin plan: FK compuesta a `intento_escaneo`, que gana `UNIQUE (restaurante_id, intento_id)`) y `mesa_compartida_id` + `miembro_id`. Una cuenta no anulada por cada origen (índices parciales, también `uq_cuenta_por_intento`).
  - Trigger `fn_cuenta_cobro_transicion`: solo `ABIERTA → COBRADA`, `COBRADA → ABIERTA` y `ABIERTA|COBRADA → ANULADA` (terminal); ninguna otra columna cambia (también frena al rol de servicio) y no hay `DELETE`. `bocadoo_app`: `SELECT`, `INSERT` y `UPDATE (estado, cobrada_en, anulada_en, anulada_por_personal_id, motivo_anulacion)` en la cabecera; `SELECT`, `INSERT` en las líneas. Las CHECK de montos de las líneas aplican solo con `omitida IS NULL`.
  - `transaccion_pago.cuenta_cobro_id` (FK compuesta) y la CHECK de origen único reemplazada: la migración busca la vieja por su definición en `pg_constraint` (en la base real se llama **`transaccion_pago_check`**) y falla si no hay exactamente una; la nueva se llama `ck_pago_origen_unico`.
  - RLS: `tenant_total` (personal) y `comensal_lee` (solo lectura, lo suyo) en cuentas y líneas; **`comensal_lee_pagos_cuenta`** en `transaccion_pago`: el pagador lee solo los pagos de sus cuentas (no los pagos sin cuenta ni los de cuentas ajenas), sin escritura. Vista `v_cuenta_saldo` con `security_invoker`: el saldo con pagos parciales le cuadra igual al comensal y a la caja.
- `20261121150100_orden_snapshot_ofertas` (F.2): `orden_cabecera.precio_almuerzo_centavos` y `almuerzo_oferta_flash_id`; `orden_detalle.oferta_flash_id` y `recargo_unitario_centavos` (default 0); `canje_oferta_flash.cuenta_cobro_id`. Todas con FK compuesta al mismo restaurante.
- `20261121150200_mesa_salida_ofertas` (F.2, E.7, H.1): `mesa_compartida_miembro.salio_en` y `almuerzo_oferta_flash_id`, `mesa_compartida_miembro_item.oferta_flash_id`, CHECK `ck_miembro_anfitrion_no_sale`. Dos funciones `SECURITY DEFINER` endurecidas (`search_path = public, pg_temp`, objetos con esquema, sin SQL dinámico, `REVOKE ALL FROM PUBLIC`, `EXECUTE` solo a `bocadoo_app`, identidad desde `app_user_id()`):
  - `fn_salir_mesa(p_mesa uuid) → text`: `SALIO`, `YA_SALIO` (repetir no cambia nada), `NO_ENCONTRADA` (mesa inexistente o no es miembro), `ANFITRION_NO_PUEDE_SALIR`, `MESA_CERRADA`. Marca `salio_en` y borra la selección del que sale.
  - `fn_plan_pagador_mesa(p_mesa_compartida_id bigint, p_miembro_id bigint) → integer`: almuerzos que el plan del pagador cubre hoy (condición de `fn_descontar_almuerzo`); pagador = anfitrión en `INVITO_YO`, el propio miembro en `CADA_UNO`. **Acotado:** al propio pagador le da el valor real; a cualquier otro, `LEAST(disponibles, miembros sin salio_en)` (basta para cotizar, un almuerzo por miembro, sin revelar el saldo exacto). El anfitrión pregunta por cualquier miembro y un invitado solo por sí mismo (visibilidad de E.6); `NULL` si quien pregunta no es miembro (o salió) o el miembro no es de esa mesa; `0` sin plan.

### Verificación

- [x] Postgres 16 desechable en Docker (puerto 55432, URLs inline que abortan si hay `neon.tech`, sin leer `.env`): up → down → up tres veces con esquema idéntico (`pg_dump`), y el down deja el esquema igual al de una base nueva migrada hasta `20261121140100` (también el nombre `transaccion_pago_check`). El `up` de cada migración se puede volver a correr sin cambios. Sin la CHECK vieja, o con dos iguales, la migración falla con el mensaje.
- [x] `test/integration/cuentas-cobro.int.ts` (8) y `test/integration/mesa-salida.int.ts` (7), como `bck_api` con RLS (patrón probe): otro local no ve ni escribe cuentas, líneas ni saldos; el comensal ve solo lo suyo y no inserta ni actualiza; `UPDATE`/`DELETE` de líneas fallan (permiso para la API, trigger para el servicio); transiciones inválidas; CHECK de líneas (PLAN, omitidas, montos, reversos); cuenta con origen escaneo (QR `SIN_PLAN` real) y rechazo de 0 o 2 orígenes, de un segundo intento y del intento de otro local; pagos visibles al pagador (saldo con pagos parciales) y no los ajenos ni los sin cuenta; `fn_salir_mesa`; `fn_plan_pagador_mesa` (no miembro, solo el entero, otra mesa, acotado: plan de 20 en mesa de 3 → 3, plan de 1 → 1, el pagador ve el real, `dias_validos`); endurecimiento en `pg_proc`.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test` (845), `pnpm format:check`. Suite de integración: 327 de 333.
- [x] **Preexistentes, fallan igual sin estas migraciones** (bajadas con `rollback`; `src/` no cambió): `estados-publicos` (1), `menu-publicado` (2), `reports-operations` (1) y **`saas` (2: «plan con tope…» y «plan gratuito sin tope…», `precioMensualCentavos` sale `null`)**.

### Hallazgos

- **Resuelto en este PR:** la cuenta de un QR sin plan ya tiene origen (`intento_id`) y el comensal ve los pagos de sus cuentas (`comensal_lee_pagos_cuenta`).
- **Miembro que salió (PR 6):** las políticas de la entrega C no miran `salio_en`: por RLS puede volver a escribir su selección mientras la mesa siga abierta, sigue contando en el cupo de `fn_mesa_invitacion` y `fn_unirse_mesa` le responde `YA_ERES_MIEMBRO`. Anotado en H.1 (PR 6): se cierra junto con el endpoint `salir`.
- **Solo el entero del plan:** `fn_plan_pagador_mesa` no dice por qué un pagador tiene 0 (`SIN_PLAN`, `SIN_SALDO`, `VENCIDO`, `DIA_NO_VALIDO`). Los montos de la cotización no cambian (todos van a `CAJA`), pero los avisos de plan de otro pagador no se pueden mostrar al comensal.
- **CI corre las pruebas probe:** el job de integración define `PROBE_DATABASE_URL` (el superusuario `postgres` del servicio de CI), así que las 43 suites de integración corren en CI. Ojo: las pruebas asumen que la sesión de Postgres está en UTC (como el servicio de CI y Neon); con otra zona en la base fallan `jobs` (límites de partición) y, a veces, `offers-concurrency`.

## Cotizaciones informativas (entrega D, PR 3; rama `feat/cotizaciones-informativas`)

**Sin migraciones y solo adiciones al contrato** (`pnpm openapi:lint` y `pnpm openapi:breaking` limpios). Nada cobra ni descuenta. Detalle y ejemplos en `docs/api-contrato.md` («Novedades»).

### Checklist

- [x] **Adaptador** `src/cobro/` (fuera de `src/billing`, que no puede importar infraestructura): `adaptador.ts` (puro: arma la `EntradaCobro` desde un pedido o una mesa y el plan), `planes.ts` (lee el plan de hoy con la condición de `fn_descontar_almuerzo`: `ACTIVA`, `vence_el >= hoy`, hoy en `dias_validos`), `mesa.ts` (lee precios, selecciones y planes de la mesa), `cotizacion.dto.ts` (forma OpenAPI). Siempre `estimada: true`; `monedaCodigo` lo agrega el endpoint.
- [x] `cotizacion` en `POST/GET /v1/mis/pedidos`, `GET /v1/mis/pedidos/{id}` (y `cancelar`), `GET /v1/caja/pedidos`, `GET /v1/caja/pedidos/{id}`, `canjear` y `servir`. Para pedidos creados el precio del almuerzo es `subtotal − extras`.
- [x] **Endpoint nuevo** `POST /v1/mis/pedidos/cotizar`: sin `Idempotency-Key`, corre en una transacción de solo lectura (no escribe nada), mismos errores de validación que crear pedido.
- [x] `miembros[].cotizacion` y `cotizacion` de la mesa en `GET /v1/mis/mesas`, `GET /v1/mis/mesas/{id}` y `GET /v1/caja/mesas/{id}` (misma visibilidad que `seleccion`; la de la mesa solo anfitrión y caja). Sin selección = 1 almuerzo (I-4); respeta `INVITO_YO` y `CADA_UNO`.
- [x] `POST /v1/caja/mesas/{id}/validar`: `cotizacion` informativa (E.5 literal: cada miembro con 1 almuerzo y su `paraLlevar`, con el plan de antes de descontar). Descuentos, `descontados` y `porCobrar` no cambian.
- [x] **INC-12** (cambio de valor, mismo tipo): `cubiertos` y `almuerzosDisponibles` (mesa y vista de caja del pedido) cuentan `dias_validos`.
- [x] `totalCentavos` y `recargoLlevarCentavos` de los pedidos siguen con la regla de hoy (prueba que lo fija).

### Verificación

- [x] Unitarios: `test/unit/cobro-adaptador.spec.ts` (29 casos: estados de plan, pedido, pedido creado, mesa CADA_UNO/INVITO_YO, selección, agotados, plan ilegible, invariantes).
- [x] Integración contra un Postgres 16 desechable en Docker (migraciones + seed, sin Neon y sin leer `.env`; config temporal): `test/integration/cotizaciones.int.ts` (18 casos: cotizar sin efectos, roles y tenant ajeno, visibilidad por miembro, plan sin saldo y día no válido, `totalCentavos` sin cambios, validar mesa).
- [ ] Suite de integración completa: 314 de 318 pasan; las 4 que fallan (`estados-publicos`, 2 de `menu-publicado`, `reports-operations`) **fallan igual en `main` sin estos cambios** (verificado en un worktree de `9350753`): no se tocaron.

### Diferencias entre la cotización y los totales actuales (a resolver en el PR 7 / snapshot)

1. **Recargo por unidad (esperada, D2):** un extra del menú de categoría `A_LA_CARTA` pedido `paraLlevar` paga recargo por unidad en la cotización y `totalCentavos` aún no. Fijada por prueba; **cambia en el PR 7**.
2. **Resuelta:** un plato de categoría `ALMUERZO` pedido suelto se mapea por sección (`JUGO` → `BEBIDA`, `POSTRE`/`ADICIONAL` → `EXTRA`, `SOPA`/`FUERTE` → `A_LA_CARTA`); solo sopa y fuerte sueltos para llevar pagan recargo en la cotización (y divergen hasta el PR 7). Jugo, postre y adicional no divergen; sin sección → `A_LA_CARTA`.
3. **Almuerzo cubierto al pedir:** el pedido guarda el almuerzo en 0, así que la cotización de un pedido creado muestra el almuerzo `PLAN` a precio 0 (`subtotal`, `total` y `cubierto` menores en P que los de `POST …/cotizar`; el saldo coincide). Se corrige con el snapshot del precio (F.2, PR 4/5).
4. **Plan cambiado después de pedir:** la cotización de un pedido ya creado usa el plan de hoy (si el comensal compró un plan después, la cotización cubre el almuerzo y `totalCentavos` no). Un almuerzo guardado en 0 se muestra siempre cubierto, aunque el plan ya se haya gastado al canjear.

### Ambigüedades de la spec y cómo se resolvieron (implementado lo literal, spec sin tocar)

- **E.6 vs RLS (la importante):** E.6 pide que el anfitrión vea la cotización de todos los miembros, pero la API del comensal (`bck_api`, RLS) solo lee **su propio plan** (`suscripcion_plan.comensal_lee`, `cliente_restaurante.propio_usuario`). Sin migración ni `service()` (prohibido para endpoints de negocio) no se puede calcular el plan de otro miembro: esas cotizaciones salen `null` (no se inventa «sin plan»). Efecto en `GET /v1/mis/mesas*`: `CADA_UNO` → el anfitrión ve la suya y las de los invitados `null` (y la de la mesa también); `INVITO_YO` → el anfitrión ve todas, el invitado todo `null`. La caja ve todo. **Propuesta:** una función `SECURITY DEFINER` que devuelva el estado del plan de los miembros de una mesa a quien sea miembro de ella (migración, PR 4).
- **E.5 vs E.6 en `validar`:** E.5 pide 1 almuerzo por miembro; E.6 pide la selección. En la respuesta de `validar` se usa E.5 (también en `miembros[].cotizacion`, para que la respuesta sea coherente consigo misma); el preview `GET /v1/caja/mesas/{id}` usa E.6.
- **«Reconstruidas desde la base» (E.5, reintento):** sin cuenta guardada, se reconstruye sumando al plan actual lo descontado en esa mesa (`consumo_almuerzo` no revertido). La vista del comensal de una mesa ya validada usa el plan actual.
- **E.1 vs B.4:** el ejemplo de E.1 no trae `porPagador` ni `unidadesPlan`; se expone `porPagador` (B.4) y no `unidadesPlan` (es lo que `aplicar` descontará: interno).
- **`ALMUERZO_SIN_PRECIO` (I-12) en `cotizar`:** 409 literal en el endpoint nuevo; en las respuestas informativas nunca hace fallar la lectura (`cotizacion: null` en mesas; en pedidos no puede ocurrir). Crear pedido con P = 0 sigue dando el almuerzo gratis (I-12 es PR posterior), así que `cotizar` y crear divergirían solo en un local con P = 0, que no puede estar `ACTIVO`.
- **`PEDIDO_ACTIVO` en `cotizar`:** «mismos errores de validación que crear pedido» se tomó incluyendo `PEDIDO_ACTIVO`, `LOCAL_LLENO_SOLO_LLEVAR` y `RESTAURANTE_PAUSADO` (comprobaciones de solo lectura).
- **Orden de los miembros:** `orden` = anfitrión 0 y el resto por `miembro_id` (sigue el orden de unión; `unido_en` se fija al insertar), como pide B.2 salvo empates de reloj.

## Carta fija y selección por comensal en mesas (rama `feat/carta-fija-seleccion-mesa`)

Entrega C. Sin fase propia; **solo adiciones al contrato** (`pnpm openapi:breaking`: sin cambios incompatibles). Detalle en `docs/api-contrato.md`.

### Auditoría (lo que había antes)

- **Carta fija**: `plato` ya tenía `A_LA_CARTA`/`EXTRA`/`BEBIDA`, precio, descripción, foto y `activo`, y el dueño los gestionaba con `POST`/`PATCH /v1/menu/platos`. Faltaban: agotado por plato (solo existía `menu_diario_detalle.agotado`), `orden`, que el cajero pudiera marcar agotado, y una lectura pública de la carta.
- **Mesa compartida**: `mesa_compartida_miembro.sopa_plato_id`/`fuerte_plato_id` no los leía ni escribía ningún código; no había forma de guardar la selección, ni de verla en `GET /v1/mis/mesas/{id}` ni en `GET /v1/caja/mesas/{id}`.
- **Ofertas flash**: el contrato (`api-contrato.md`, Fase 9) estaba cubierto: estados, stock con `UPDATE` condicional, idempotencia, `RESTAURANTE_PAUSADO`. Ver "Huecos de ofertas" abajo.

### Checklist

- [x] **Migración** `20261121140000_carta_fija_agotado_orden` (con su down, idempotente): `plato.agotado_en` y `plato.orden`. Agotado = `agotado_en` dentro de la fecha local de hoy del local: vuelve solo a medianoche, sin job.
- [x] **Migración** `20261121140100_mesa_miembro_seleccion` (con su down, idempotente): tabla `mesa_compartida_miembro_item` (FK compuestas: el plato es del mismo local que la mesa; RLS: personal solo lee, el miembro escribe lo suyo mientras la mesa esté abierta, el anfitrión lee toda su mesa). **Aplicadas en Neon (19 aplicadas, 0 pendientes, 2026-11-21).** Las columnas `sopa_plato_id`/`fuerte_plato_id` no se tocan.
- [x] `PATCH /v1/menu/platos/{id}/agotado` (dueño y cajero; el cajero sigue sin editar nada más), `orden`/`agotado`/`agotadoEn` en los platos.
- [x] `GET /v1/restaurantes/{slug}/carta` público, solo locales `ACTIVO`.
- [x] `PUT /v1/mis/mesas/{id}/seleccion` con validación contra el menú publicado de hoy, agotados (menú y carta), plato de otro local, sección única, precio y cantidad; `miembros[].seleccion` para anfitrión, invitado y caja.
- [x] Pruebas: `test/integration/carta-fija.int.ts` (8), `test/integration/mesa-seleccion.int.ts` (9, incluye RLS directo) y `test/unit/seleccion-dto.spec.ts`. Se corrigió además un test viejo de `diner-tables` (esperaba 404 donde el contrato ya decía 409 `RESTAURANTE_PAUSADO`).
- [x] `docs/openapi.json` regenerado, `openapi:lint` y `openapi:breaking` limpios.
- [ ] `pnpm test:db` **no se corrió** (el `.env` apunta a Neon). Las integraciones se corrieron contra un Postgres 16 local descartable (mismo montaje que el job `integration` de CI) con un config temporal sin `.env`.

### Decisiones pendientes

1. **Selección → cobro.** `POST /v1/caja/mesas/{id}/validar` sigue igual: la selección es informativa y no genera ventas ni cobra extras. _Recomendación_: en la siguiente entrega, al validar, crear una venta por miembro con sus extras (clave de idempotencia derivada por miembro, ya existe el patrón) y, en `INVITO_YO`, cargarlas al anfitrión.
2. **Quién ve la selección de quién.** Hoy: anfitrión ve todas, invitado solo la suya, caja todas (lo impone RLS). _Recomendación_: mantenerlo (privacidad); abrirlo solo si producto lo pide.
3. **Duración del agotado de la carta.** Hoy vale hasta medianoche local. _Recomendación_: mantenerlo; un agotado "permanente" que alguien olvida quitar esconde platos por días.
4. **Importes por miembro.** La mesa no muestra totales. _Recomendación_: añadir `totalEstimadoCentavos` por miembro cuando se defina la regla de cobro del punto 1.
5. **Pedidos con carta.** `POST /v1/mis/pedidos` solo acepta platos del menú del día; la selección de mesa sí acepta la carta fija. _Recomendación_: extender los pedidos de forma aditiva con las mismas reglas (no se hizo aquí para no tocar un endpoint con tanta lógica: `LOCAL_LLENO_SOLO_LLEVAR`, planes, etc.).
6. **Unirse con selección.** `unirse` no recibe selección: son dos llamadas (`unirse` y luego `PUT …/seleccion`). _Recomendación_: dejarlo así.
7. **Columnas heredadas** `sopa_plato_id`/`fuerte_plato_id`. Sin uso; quitarlas es un cambio de esquema destructivo. _Recomendación_: dejarlas y quitarlas más adelante, cuando se confirme que en Neon están vacías.
8. **Ofertas: publicar con el local pausado** (ver abajo). _Recomendación_: responder 409 `RESTAURANTE_PAUSADO`, anunciándolo como cambio de comportamiento.

### Huecos de ofertas flash que NO se cerraron

Revisados contra `src/offers/offers.ts` y el contrato; no se tocó el módulo.

- `offers.ts:189-227` (`publish`): no mira el estado del local, así que un local `PAUSADO` puede publicar. Cambiarlo altera un endpoint existente: queda como decisión 8.
- `offers.ts:294-295` (`redeem`): solo bloquea `PAUSADO`. El contrato dice exactamente eso; no es un hueco del contrato.
- `offers.ts:311-318`: el canje no exige menú publicado ni plato activo. El contrato no lo pide; no se inventó la regla.
- `offers.ts:298`: la búsqueda de `comensalId` usa la política `lectura_perfil_minimo` (`USING (true)`): el personal puede saber si un UUID de comensal existe (404 vs 201). Riesgo bajo; arreglarlo es una decisión de privacidad sobre `usuario`.
- Sin eventos de servidor en el canje ni tope por comensal: el contrato tampoco los prevé (los eventos son `POST /v1/eventos`, del cliente).

## Perfil de negocio del restaurante (rama `feat/perfil-restaurante-v2`)

Sin fase propia. La app hace `register-owner` mínimo → login → `PATCH /v1/restaurante`; **sin cambios incompatibles**: todo campo nuevo es opcional y se valida solo si viene. Detalle en `docs/api-contrato.md` («Perfil de negocio»).

- [x] **Migración** `20261121120000_perfil_negocio_restaurante` (con su down), **aplicada en Neon** (2026-11-21): `restaurante.mesas_total`, `precio_solo_segundo_centavos`, `precio_solo_sopa_centavos` (nullable), `puestos_definidos` (default `true`: no inventa pendientes a locales existentes), `CHECK puestos >= mesas_total`, default de `recargo_para_llevar_centavos` a 25 (solo filas nuevas) y la tabla `restaurante_fiscal`
- [x] **Columnas reutilizadas**: `direccion`, `latitud`, `longitud`, `telefono_e164` (ya exigía E.164), `puestos` (ya permitía hasta 1000), `precio_suelto_centavos` (= `precioAlmuerzoCentavos`; el nombre antiguo sigue vivo en request y response) y `recargo_para_llevar_centavos`
- [x] **Cédula/RUC en tabla aparte** (`restaurante_fiscal`): `restaurante` tiene política `lectura_publica` (`USING true`) y un trigger de auditoría que copia la fila completa a `log_actividad`; la tabla nueva solo tiene política de tenant, sin lectura pública y sin trigger. La app no tiene DELETE: borrar = `NULL`
- [x] Validadores por país en `src/restaurant/country/` (`EC` + genérico como punto de extensión): teléfono, cédula, RUC, coordenadas (cajas aproximadas del continente y Galápagos), con tabla de casos en `test/unit/country-ec.spec.ts`
- [x] Privacidad: enmascarada en `GET`/`PATCH` de `/v1/restaurante`, ausente de la vitrina, redactada en pino (`src/common/log-redact.ts`), ejemplo del OpenAPI generado y comprobado con el validador
- [x] `slug`: el registro ya lo generaba (sin cambios, no se pide)
- [x] `GET /v1/restaurante`: `perfilCompleto` y `datosPendientes`; precios y recargo públicos en vitrina y detalle
- [x] Pruebas: unitarias (`country-ec`, `profile`) y de integración `test/integration/perfil-negocio.int.ts` (clientes anteriores, registro con campos, validaciones, aislamiento y auditoría)
- [x] `docs/openapi.json` regenerado; `pnpm openapi:breaking` sin cambios incompatibles
- [ ] `pnpm test:db` **no se corrió** (sus URLs apuntan a Neon): lo valida la CI de la PR; las pruebas de integración nuevas están sin ejecutar
- [ ] Decisiones a confirmar: rango 1..5000 para `precioSoloSegundo/Sopa` (el pedido solo fijaba 100..5000 para el almuerzo); `telefono` ya no acepta E.164 de otros países ni fijos; `mesas` sin `puestos` no se compara mientras `puestos` nunca se haya definido (el 20 por defecto no cuenta; el `CHECK` de la base también lo omite con `puestos_definidos = false`)

## Estados públicos del restaurante (rama `fix/estados-publicos`)

Sin fase propia. Pedido del frontend para alinear los estados del local. Detalle en `docs/api-contrato.md` («Estados públicos»). **Sin migración.**

- [x] **PAUSADO visible**: `GET /v1/restaurantes` y `GET /v1/restaurantes/{slug}` incluyen locales `PAUSADO` con el campo nuevo `estado` (`ACTIVO` | `PAUSADO`) y `abiertoAhora = false`. `BORRADOR` y `BAJA` siguen ocultos (404 por slug). Reemplaza lo dicho en la sección «Concurrido» (un PAUSADO ya no da 404)
- [x] **Sin órdenes nuevas en PAUSADO**: 409 `RESTAURANTE_PAUSADO` en `POST /v1/mis/pedidos`, `POST /v1/mis/mesas` y `POST /v1/ofertas/{id}/canjear`. Lo ya creado no se toca (lectura, reintento idempotente, canje de pedidos existentes, `validar`, unirse a una mesa existente). Se comprueba después de la lectura idempotente y antes de cualquier escritura
- [x] **LLENO → solo para llevar**: en `POST /v1/mis/pedidos`, si `fn_ocupacion_local` + `occupancy()` (la misma lógica de `ocupacion.nivel`) da `LLENO` y el pedido no es `paraLlevar` (tipo `AQUI`), 409 `LOCAL_LLENO_SOLO_LLEVAR`. Se reutiliza `paraLlevar` → `orden_cabecera.tipo` (`AQUI` | `LLEVAR`); precios y recargos **no se tocaron**
- [x] **`menuAgotado`** en vitrina, detalle y `GET /v1/restaurante`: `true` solo con menú publicado hoy y todos los platos `SOPA` y `FUERTE` con `agotado`. Una sola subconsulta SQL (`menuAgotadoSql`) compartida
- [x] **Decisiones**: (1) el orden de las comprobaciones es PAUSADO → `MENU_NO_PUBLICADO` → LLENO. (2) Un pedido solo de extras sin `paraLlevar` cuenta como `AQUI` y se rechaza con el local lleno. (3) Si el menú no tiene ninguna sopa ni segundo, `menuAgotado` es `false` (no hay nada que agotar). (4) La `ocupacion` de un PAUSADO en la vitrina sale `LIBRE`/0 % porque `fn_ocupacion_local` solo responde para locales `ACTIVO`; se dejó así para no volver nulable un campo requerido (no sería aditivo) y el frontend debe decidir por `estado`. (5) Los códigos `RESTAURANTE_PAUSADO` y `LOCAL_LLENO_SOLO_LLEVAR` son estables y se documentan en la tabla de errores
- [x] Pruebas: `test/integration/estados-publicos.int.ts` (nuevo: visibilidad, los tres 409 de pausa, creado antes de pausar, caja intacta, LLENO manual y por aforo, LLEVAR permitido, `menuAgotado` en las tres lecturas, aislamiento entre locales) y `catalog.int.ts` ajustado al nuevo comportamiento
- [x] Contrato: `docs/openapi.json` regenerado; `pnpm openapi:breaking` sin cambios incompatibles; `pnpm openapi:lint` limpio
- [ ] `pnpm test:db` **no se corrió** (sus URLs apuntan a Neon): lo valida la CI de la PR. Las pruebas nuevas están sin ejecutar
- [ ] Pendiente frontend: tratar 409 `RESTAURANTE_PAUSADO` y `LOCAL_LLENO_SOLO_LLEVAR` en preórdenes/mesas

## Estado manual "Concurrido" (rama `feat/ocupacion-concurrido`)

Sin fase propia. Pedido del frontend: mostrar los mismos 4 estados (Libre, Concurrido, Lleno, Cerrado) en las apps de dueño y comensal. Detalle en `docs/api-contrato.md` (`POST /v1/restaurante/lleno`).

- [x] **Migración** `20261120000817_concurrido_manual` (con su down): `restaurante.concurrido_manual_hasta TIMESTAMPTZ` nullable y `fn_ocupacion_local` recreada con una columna más (`concurrido_manual`); `lleno_manual_hasta` queda igual. **Aplicada en Neon** (2026-11-21)
- [x] `POST /v1/restaurante/lleno` acepta `nivel` (`LIBRE` | `CONCURRIDO` | `LLENO`) además de `lleno`; con los dos, gana `nivel`. LLENO y CONCURRIDO duran 20 min, son excluyentes y LIBRE limpia ambos. La respuesta suma `nivel` y `concurridoManualHasta`. Mismos roles (dueño, cajero) y RLS
- [x] **Escala sin ampliar**: el valor intermedio que ya existía en `ocupacion.nivel` es `MODERADO`; "Concurrido" manual se muestra como `MODERADO`. El aforo ≥90% (o "Lleno" manual) sigue dando `LLENO` y un "Concurrido" manual nunca lo baja. La vigencia se decide con `CURRENT_TIMESTAMP` de la base
- [x] `GET /v1/restaurante` (personal) ahora trae `ocupacion` (misma que la vitrina) y `concurridoManualHasta`; `ocupacion` es `null` si el local no está `ACTIVO`. Antes no traía ocupación
- [x] **Pausado/cerrado, comportamiento actual (no se cambió)**: un local `PAUSADO` no sale en `GET /v1/restaurantes` y `GET /v1/restaurantes/{slug}` responde 404 (ambos filtran `estado = 'ACTIVO'`). No existe un campo `activo` ni `abierto`: `abiertoAhora` solo sigue el horario. El personal ve `estado: "PAUSADO"` en `GET /v1/restaurante`. **Falta** (si el frontend quiere mostrar "Cerrado" en la vitrina): decidir si los pausados deben listarse con un campo `estado`/`activo`, lo que cambia la vitrina pública
- [x] **Sin tiempo real**: no hay evento para la ocupación; las apps hacen polling de los GET. Opción sugerida, no construida: reutilizar el SSE del pase o un SSE público por local
- [x] Pruebas en `catalog.int.ts` (niveles, `lleno` solo, conflicto, inválidos, expiración, no baja un LLENO automático, tres lecturas iguales, aislamiento, pausado) y `restaurant.int.ts`
- [x] Contrato: `docs/openapi.json` solo con adiciones
- [ ] `pnpm test:db` **no se corrió** (sus URLs apuntan a Neon): lo valida la CI de la PR; las pruebas nuevas están sin ejecutar

## Eventos del pase en tiempo real (rama `feat/pase-eventos`)

Sin fase propia. Detalle en `docs/qr-flujo.md` y `docs/api-contrato.md` ("Eventos del pase").

### Cómo se detecta hoy un código "ya canjeado" (revisado antes de programar)

- **El QR no es de un solo uso.** `pass-code.ts` firma `BCD1.<usuario>.<restaurante|0>.<mac>` con un HMAC por pasos de 30 s y `verifyPassCode` acepta el paso anterior y el siguiente. Un código se dibuja durante su paso y vale hasta el final del paso siguiente: entre el primer y el último escaneo posible del **mismo** código pasan menos de 60 s. No hay registro de "códigos usados".
- **Lo que se detecta es el comensal, no el código**, dentro de `fn_descontar_almuerzo` (paso 2, migración `20261116000000`): si el mismo cliente tiene en ese restaurante un consumo (`cantidad = 1`, sin reverso) de hace menos de 60 s, el resultado es **`DUPLICADO`**. Como la ventana (60 s) cubre toda la vida de un código, un segundo escaneo del mismo QR siempre cae aquí, salvo que el primero se haya deshecho.
- `POST /v1/caja/validar` responde entonces **200** con `resultado: "DUPLICADO"`, `descontado: false`, `mensaje` ("ya fue validado hace menos de un minuto") y `almuerzosRestantes` (el saldo restante). Queda en `intento_escaneo`. No trae la hora del primer canje.
- Otros caminos: el reintento con la **misma** `Idempotency-Key` devuelve la respuesta original (`OK`) sin descontar; la mesa "invito yo" omite la regla a propósito (`p_omitir_duplicado`); un pedido preordenado ya canjeado responde 200 con `yaCanjeado: true`.
- **Conclusión: ya existe un equivalente con código de negocio** (`DUPLICADO`), no un error genérico. **No se cambió**: pasarlo a 409 `QR_YA_CANJEADO` rompería el contrato ("`validar` responde siempre 200") y oasdiff lo marcaría. Lo único que falta respecto a lo pedido es la hora del primer canje para mostrar "hace X s"; si la caja lo necesita, se puede **añadir** un campo opcional (p. ej. `consumoPrevio.creadoEn`) sin romper nada. Decisión pendiente.

### Checklist

- [x] Bus en memoria por comensal, tipado (`src/pass-events/bus.ts`): `CANJE_REGISTRADO` y `CANJE_REVERTIDO`. Los eventos se juntan durante la transacción (`PassEventBus.pending()`) y se entregan con `flush()` **solo después del COMMIT** (tras `await db.forRequest(...)`); si la transacción falla no sale nada
- [x] Emiten: `POST /v1/caja/validar`, `POST /v1/caja/mesas/{id}/validar` y `POST /v1/caja/pedidos/{id}/canjear` (registrado, solo si el consumo se creó en esa transacción: un reintento idempotente no repite el evento) y `POST /v1/caja/consumos/{id}/deshacer` (revertido). Un cliente sin cuenta en la app no genera eventos
- [x] `GET /v1/pase/eventos` (SSE): JWT del comensal, solo sus eventos, `LATIDO` cada 20 s, `Cache-Control: no-store`, `X-Accel-Buffering: no`, 2 conexiones por usuario (cierra la más vieja), tope global `PASS_EVENTS_MAX_CONNECTIONS` (1000; después 503 `EVENTOS_SATURADO`), corte al vencer el token, limpieza al cerrar y al apagar (`enableShutdownHooks`)
- [x] Pruebas sin base: `test/unit/pass-events.spec.ts` (bus, aislamiento, cap por usuario y global, latido, token vencido, apagado, transacción fallida) y `test/pass-events-sse.spec.ts` (HTTP real en puerto efímero: 401, cabeceras, entrega solo al dueño del token, 3.ª conexión). Con base (CI): `test/integration/pass-events.int.ts` (validar, reintento, `DUPLICADO`, deshacer y COMMIT fallido simulado)
- [x] `docs/openapi.json` regenerado: solo la operación nueva; `pnpm openapi:breaking` sin cambios incompatibles
- [ ] `pnpm test:db` **no se corrió** (sus URLs apuntan a Neon): lo valida la CI de la PR
- [ ] Límite conocido: **una sola instancia** de la API. Para escalar, ver `docs/qr-flujo.md`
- [ ] Fuera de alcance: `POST /v1/reclamos/{id}/devolver` también devuelve un almuerzo y no emite `CANJE_REVERTIDO` (la app lo ve al refrescar)

## Movimientos del día de la caja (rama `feat/caja-movimientos`)

Sin fase propia: adición posterior a la fase 10, pendiente de revisión y merge. Detalle en `docs/api-contrato.md` (`GET /v1/caja/movimientos`).

- [x] **`GET /v1/caja/movimientos?fecha=` reemplaza la mezcla de `GET /v1/caja/ventas` + `GET /v1/caja/pedidos?estado=SERVIDA` + la lista en memoria de canjes directos que arma hoy el frontend en "Cobros de hoy"**. Los canjes directos por QR ya no se pierden al cerrar la app o cambiar de dispositivo. Los endpoints anteriores siguen igual (el cliente puede migrar cuando quiera)
- [x] **Sin migración**: el canje directo ya queda en `consumo_almuerzo` (canal `QR`/`MANUAL`, sin `orden_id` ni `mesa_compartida_id`), los pedidos en `orden_cabecera.canjeada_en` y las ventas en `venta_pos_cabecera`. Solo lectura, `DbService.forRequest()` con RLS (`@Roles('DUENO', 'CAJERO')`)
- [x] Día local del restaurante (`fecha` opcional, por defecto hoy en su zona horaria), orden por hora descendente, cursor `(hora, public_id)` como los demás listados, `resumen` del día por tipo (cantidad y monto) calculado aparte de la página
- [x] **Decisiones**: los pedidos entran al canjearse (`CANJEADA` y `SERVIDA`), no solo `SERVIDA`; las validaciones de mesa no son `CANJE_DIRECTO`; el monto de `PEDIDO` es el valor de la preorden (no dinero cobrado, y no entra en el dinero del resumen) y `CANJE_DIRECTO` no tiene monto; ventas deshechas y consumos revertidos salen con `revertido: true` y no suman
- [x] **Cajero solo hoy**: otra fecha → 403 `CAJERO_SOLO_HOY` (como el cierre de caja); el dueño consulta cualquier día. `resumen` separado por tipo: `ventas.ventasConfirmadasCentavos` (dinero, solo pagos `CONFIRMADO`), `pedidos.valorPedidosCentavos` (valor de preórdenes, no cobrado) y `canjesDirectos.cantidad`; lo revertido no suma
- [x] Contrato: `docs/openapi.json` solo con adiciones (oasdiff: sin cambios incompatibles); `pnpm openapi:lint` limpio
- [x] Pruebas en `test/integration/caja-movimientos.int.ts` (tres tipos, cursor, zona horaria, cambio de día, aislamiento entre locales, 403)
- [ ] `pnpm test:db` **no se corrió** (sus URLs apuntan a Neon): lo valida la CI de la PR. Las pruebas nuevas están sin ejecutar
- [ ] Pendiente: el frontend debe cambiar "Cobros de hoy" a este endpoint y retirar su lista en memoria

## Menú publicado en pase y caja (rama `fix/menu-publicado-canje`)

Sin fase propia: cambio de comportamiento posterior a la fase 10, pendiente de revisión y merge. Detalle en `docs/api-contrato.md` ("Menú publicado en pase y caja") y `docs/seguridad.md`.

- [x] **Reutiliza `MENU_NO_PUBLICADO`**: la comprobación que estaba en línea en `src/orders/orders.ts` pasó a `assertMenuPublicado` (`src/diner/common.ts`), usada ahora por preórdenes, `GET /v1/pase/codigo`, `GET /v1/pase` (con `restaurante`) y `POST /v1/caja/validar`. Decide por la fecha local del restaurante
- [x] **Decisión de negocio ya resuelta así en el código y dejada tal cual**: `POST /v1/caja/pedidos/{id}/canjear` no mira el menú, así que un pedido preordenado antes de despublicar sí se canjea. Por eso ese endpoint no documenta `MENU_NO_PUBLICADO`
- [x] **`platoNombre`** (opcional, `string | null`) en las respuestas de `validar` (siempre `null`) y de canjear pedido (platos de la preorden). No existe ningún listado "Cobros de hoy": no se creó
- [x] Pruebas en `menu-publicado.int.ts` (publicado/sin publicar, preorden, RLS, fecha local). Las suites existentes que usan `validar` ahora publican un menú (`Harness.publishMenu`)
- [ ] `pnpm test:db` **no se corrió** (sus URLs apuntan a Neon): lo valida la CI de la PR
- [ ] Pendiente: el cliente móvil debe tratar el 409 `MENU_NO_PUBLICADO` en el pase y en `validar`

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

- **Canje de ofertas en caja**: lo registra el personal (dueño o cajero), con el comensal opcional por `public_id`. El cobro se guarda `CONFIRMADO` en la misma transacción (la oferta se entrega al pagar), así que entra al arqueo de caja del día; no usa el flujo de pagos pendientes. Desde «cajero confirma pagos», el cajero que cobra con transferencia o Deuna debe dar `referenciaExterna`. Las ofertas no tienen deshacer.
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
- [x] Pre-pedidos: vencen 30 min después de la hora de llegada (o de crearlos, sin hora); el QR del pedido es su `public_id`; un pedido activo por local
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
| `GET·POST /v1/mis/pedidos`, `GET …/:id`, `POST …/:id/cancelar`   | comensal            | Pre-pedidos (vencen 30 min tras llegar)                     |
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

- Efectivo queda confirmado al vender; transferencia y Deuna quedan pendientes salvo `pagoConfirmado` (el cajero, solo con `referenciaExterna`, desde «cajero confirma pagos»). Rechazar el pago anula el plan.
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
- ✅ CI: `PROBE_DATABASE_URL` definida en el job de integración (superusuario `postgres` del servicio). Las de concurrencia clonan la base con `CREATE DATABASE … TEMPLATE`, que exige que nadie más esté conectado a ella; en `pnpm test:db` las suites corren una a una.
- ⬜ Pasar al patrón _probe_ las suites de las fases 1–7 que hoy dejan datos (por eso no se corren contra Neon).
- ⬜ Revisar en Neon el aumento de filas del 2026-11-12 entre 02:30 y 03:04 UTC (≈66 restaurantes y ≈100 usuarios con prefijos de correo de las pruebas de integración); no vino de las corridas de la fase 8, que fueron contra la base local.
- ⬜ Ids numéricos dentro del tenant en `/v1/clientes`, reclamos y plantillas de plan: evaluar pasarlos a `public_id`.
- ⬜ Rate limit en memoria: si la API escala a varias instancias, moverlo a un almacén compartido.
