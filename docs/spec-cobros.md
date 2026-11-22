# Spec de cobros cruzados (entrega D)

Estado: **borrador para revisión**. Solo documento: no hay código, migraciones ni pruebas en esta entrega.

Objetivo: que cualquier cobro de Bocadoo (plan de almuerzos, oferta flash, carta, extras, bebidas y recargo para llevar)
se calcule con **una sola regla**, en todos los flujos, y que la implementación pueda hacerse de forma mecánica con
pruebas de tabla (sección G).

Convenciones del documento:

- `archivo:línea` apunta al código de `main` en `f7f5626`. `baseline:N` es `db/migrations/20261112000000_baseline_schema_v1.sql`.
- Dinero siempre en **centavos enteros** (`BIGINT` en la base, `number` entero en la API).
- Símbolos de precio usados en la matriz y las pruebas: **P** = almuerzo suelto (`restaurante.precio_suelto_centavos`),
  **R** = recargo para llevar por unidad (`restaurante.recargo_para_llevar_centavos`), **C** = plato `A_LA_CARTA`,
  **E** = `EXTRA`, **B** = `BEBIDA`, **O** = precio de una oferta flash.

Decisiones ya tomadas que esta spec aplica (no se discuten): D1 centavos enteros · D2 recargo por unidad a `ALMUERZO` y
`A_LA_CARTA` · D3 `paraLlevar` por línea solo en el POS · D4 oferta vs plan se decide por `ofertaId` · D5 el plan solo
cubre `ALMUERZO` · D6 `INVITO_YO` paga el anfitrión, `CADA_UNO` cada miembro · D7 `momentoCobro` sigue configurable ·
D8 la selección de mesa se convierte en cobro.

---

## A. Inventario: cómo se fija el precio hoy

### A.1 Pedido del comensal (preorden)

|                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoints        | `POST /v1/mis/pedidos` (crear, `src/orders/orders.ts:440-465`); `POST /v1/caja/pedidos/{id}/canjear` (canjear, `src/orders/orders.ts:705-720`)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cómo calcula hoy | Al crear: `almuerzo = (hay almuerzo y no lo cubre un plan) ? P : 0` (`src/orders/orders.ts:343`); `recargo = (hay almuerzo y paraLlevar) ? R : 0`, una sola vez por pedido (`src/orders/orders.ts:344`); `subtotal = almuerzo + Σ extras` (`src/orders/orders.ts:345`); `total = subtotal + recargo` (`src/orders/orders.ts:361`, CHECK en `baseline:503`). Al canjear: descuenta el plan con `fn_descontar_almuerzo` canal `PREORDEN` (`src/orders/orders.ts:620-629`) y responde `porCobrarCentavos = extras + recargo + (hay almuerzo y no se descontó ? P : 0)` (`src/orders/orders.ts:591`). |
| Origen de precio | P y R del restaurante (`src/orders/orders.ts:277`); extras: `COALESCE(menu_diario_detalle.precio_centavos, plato.precio_centavos)` del menú de hoy (`src/orders/orders.ts:311`). Los platos del almuerzo se guardan con precio 0 (`src/orders/orders.ts:371`) y el precio del almuerzo se deduce como `subtotal − extras` (`src/orders/orders.ts:195`). La cobertura del plan al crear es una estimación (`src/orders/orders.ts:334-342`).                                                                                                                                                        |
| Qué NO cubre     | Platos de la carta fija (solo acepta platos del menú del día, `src/orders/orders.ts:311-313`); ofertas flash; recargo para platos a la carta; registro del pago del `porCobrar` (el canje solo cambia el estado, `src/orders/orders.ts:635-638`; `transaccion_pago.orden_id` existe pero ningún código lo usa, `baseline:679`); `momentoCobro`.                                                                                                                                                                                                                                                   |

### A.2 POS / venta directa

|                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoints        | `POST /v1/caja/ventas` (`src/checkout/pos.ts:414-424`), `POST /v1/caja/ventas/{id}/deshacer` (`src/checkout/pos.ts:426-437`)                                                                                                                                                                                                                                                                                                                                                                               |
| Cómo calcula hoy | Por ítem: `ALMUERZO` = P × cantidad (`src/checkout/pos.ts:116-119`); `PLATO` = `plato.precio_centavos` × cantidad (`src/checkout/pos.ts:120-136`); `LIBRE` = precio enviado por la caja (`src/checkout/pos.ts:137-141`). Recargo: una línea "Recargo para llevar" con `cantidad = Σ almuerzos` si la **venta** es para llevar (`src/checkout/pos.ts:143-151`). `total = Σ cantidad × precio` y debe ser > 0 (`src/checkout/pos.ts:152-153`). Pago en la misma transacción (`src/checkout/pos.ts:172-185`). |
| Origen de precio | P y R del restaurante (`src/checkout/pos.ts:110`); platos: precio de catálogo, **sin** el precio del día (`src/checkout/pos.ts:124`).                                                                                                                                                                                                                                                                                                                                                                      |
| Qué NO cubre     | Planes (no los consulta: "Venta suelta (sin plan)", `src/checkout/pos.ts:418`); `paraLlevar` por línea (es de la venta, `src/checkout/pos.ts:77-80`); recargo a platos a la carta; agotados (`src/checkout/pos.ts:122-129` no los mira); ofertas.                                                                                                                                                                                                                                                          |

### A.3 QR en caja (validar)

|                  |                                                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint         | `POST /v1/caja/validar` (`src/checkout/checkout.ts:540-556`)                                                                                                                                                                                                                              |
| Cómo calcula hoy | No calcula dinero. Exige menú publicado (`src/checkout/checkout.ts:166`) y llama a `fn_descontar_almuerzo` (`src/checkout/checkout.ts:222-230`), que descuenta 1 almuerzo FIFO y guarda `para_llevar` en el consumo (`db/migrations/20261116000000_descontar_almuerzo_mesa.sql:103-108`). |
| Origen de precio | Ninguno hacia el comensal. El consumo guarda `valor_unitario_centavos = suscripcion_plan.precio_unitario_centavos` (valor contable del pasivo, misma migración `:107`).                                                                                                                   |
| Qué NO cubre     | Recargo para llevar (se guarda `para_llevar`, `src/checkout/checkout.ts:227`, pero nadie lo cobra); extras, carta y bebidas; el almuerzo cuando no hay plan (responde `SIN_PLAN` y el cobro queda fuera del sistema).                                                                     |

### A.4 Canje de oferta flash

|                  |                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint         | `POST /v1/ofertas/{id}/canjear` (`src/offers/offers.ts:451-475`)                                                                                                                                                                         |
| Cómo calcula hoy | `monto = oferta.precio_centavos × cantidad` (`src/offers/offers.ts:320`); descuenta stock con `UPDATE` condicional (`src/offers/offers.ts:311-318`); canje y pago `CONFIRMADO` en la misma transacción (`src/offers/offers.ts:322-334`). |
| Origen de precio | `oferta_flash.precio_centavos`, fijado al publicar (`src/offers/offers.ts:208-225`); la API no puede cambiarlo después (`db/migrations/20261118000000_ofertas_flash.sql:10-11`).                                                         |
| Qué NO cubre     | `paraLlevar` y recargo (el DTO no lo tiene, `src/offers/offers.ts:78-92`); relación con el plan; deshacer (`docs/estado.md:205`); otros ítems en el mismo cobro.                                                                         |

### A.5 Mesa grupal (validar mesa)

|                  |                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoints        | `POST /v1/caja/mesas/{id}/validar` (`src/checkout/checkout.ts:581-592`); vista previa `GET /v1/caja/mesas/{id}` (`src/checkout/checkout.ts:570-579`); selección `PUT /v1/mis/mesas/{id}/seleccion` (`src/tables/tables.ts:328-345`)                                                                                                                                                      |
| Cómo calcula hoy | Por **cada** miembro descuenta 1 almuerzo del pagador: el anfitrión en `INVITO_YO`, el propio miembro en `CADA_UNO` (`src/checkout/checkout.ts:397-415`), con clave derivada por miembro (`src/checkout/checkout.ts:98-101`, `:406`). Quien no descuenta suma 1 a `porCobrar` (`src/checkout/checkout.ts:426`). La vista previa estima `cubiertos` (`src/checkout/checkout.ts:485-486`). |
| Origen de precio | Ninguno: `porCobrar` es un conteo de personas, no dinero. La selección guarda platos y cantidades sin precio (`src/tables/selection.ts:216-224`); el precio solo se valida al elegir (`src/tables/selection.ts:175`, `:210`).                                                                                                                                                            |
| Qué NO cubre     | La selección (es informativa, `docs/mesas-flujo.md:158`; validar no la lee); precios, recargo, extras, carta y bebidas; registro del "por cobrar" (`docs/mesas-flujo.md:56-57`); menú publicado (`docs/mesas-flujo.md:406-413`); local lleno; un miembro que se va (`docs/mesas-flujo.md:640-641`).                                                                                      |

### A.6 Inconsistencias encontradas

Graves primero. "Grave" = hoy se cobra mal o se pierde plata/saldo sin registro.

| #      | Gravedad | Inconsistencia                                                                                                                                                                                                                                                                                   |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| INC-01 | Grave    | Validar una mesa descuenta 1 almuerzo a **todos** los miembros sin mirar su selección (`src/checkout/checkout.ts:397-415`). Un miembro que solo eligió una bebida pierde un almuerzo de su plan (o del anfitrión).                                                                               |
| INC-02 | Grave    | El "por cobrar" de una mesa es un número de personas (`src/checkout/checkout.ts:426`): no hay montos ni registro; la caja cobra "a ojo" en el POS sin vínculo con la mesa (`docs/mesas-flujo.md:56-57`).                                                                                         |
| INC-03 | Grave    | El recargo para llevar se cobra en la preorden aunque el plan cubra el almuerzo (`src/orders/orders.ts:344`), pero en QR y en mesa solo se guarda `para_llevar` y no se cobra nunca (`src/checkout/checkout.ts:227`, `:408`). El mismo comensal paga o no el recargo según el flujo.             |
| INC-04 | Grave    | El canje de una preorden calcula `porCobrarCentavos` pero no registra ningún pago (`src/orders/orders.ts:591`, `:635-638`): el dinero de extras y recargo no entra al arqueo salvo que la caja haga una venta POS aparte.                                                                        |
| INC-05 | Grave    | `momento_cobro` se guarda y se expone (`baseline:251`, `src/restaurant/restaurant.service.ts:9`, `:60`, `:92`, `src/restaurant/dto.ts:39-42`) pero **ningún flujo lo lee**.                                                                                                                      |
| INC-06 | Media    | El canje de la preorden usa el **precio actual** del almuerzo (`src/orders/orders.ts:587-591`) mientras los extras usan el precio guardado al pedir (`src/orders/orders.ts:379`). `totalCentavos` mostrado al comensal (`src/orders/orders.ts:116`) puede no coincidir con lo que cobra la caja. |
| INC-07 | Media    | Recargo: la preorden lo aplica una vez por pedido y solo con almuerzo (`src/orders/orders.ts:344`); el POS por unidad de almuerzo (`src/checkout/pos.ts:143-151`); ninguno a platos a la carta (contra D2).                                                                                      |
| INC-08 | Media    | `paraLlevar` en el POS es de toda la venta (`src/checkout/pos.ts:77-80`); D3 lo pide por línea.                                                                                                                                                                                                  |
| INC-09 | Media    | Precio de un plato: POS usa el de catálogo (`src/checkout/pos.ts:124`); preorden y selección usan el del día si existe (`src/orders/orders.ts:311`, `src/tables/selection.ts:175`).                                                                                                              |
| INC-10 | Media    | Agotado: la preorden solo mira `menu_diario_detalle.agotado` (`src/orders/orders.ts:311`, `:321`); la selección mira además `plato.agotado_en` (`src/tables/selection.ts:177`); el POS no mira nada (`src/checkout/pos.ts:122-129`).                                                             |
| INC-11 | Media    | Carta fija: la selección de mesa la acepta sin menú publicado (`src/tables/selection.ts:203-209`); la preorden no acepta carta y exige menú publicado siempre (`src/orders/orders.ts:285`, `:311-313`).                                                                                          |
| INC-12 | Media    | Estimación del plan: la preorden mira `dias_validos` (`src/orders/orders.ts:337-338`); la vista de caja del pedido (`src/orders/orders.ts:538-540`) y la de mesa (`src/checkout/checkout.ts:460-462`, `:485-486`) no. La caja ve "cubierto" y luego recibe `DIA_NO_VALIDO`.                      |
| INC-13 | Media    | `DUPLICADO` y `LIMITE_SAAS` cuentan como "por cobrar" en la mesa (`src/checkout/checkout.ts:426`): se le cobraría al comensal un almuerzo que ya tiene pagado en su plan.                                                                                                                        |
| INC-14 | Media    | `INVITO_YO` con anfitrión sin ficha: todos salen `SIN_PLAN` sin monto (`src/checkout/checkout.ts:398-401`).                                                                                                                                                                                      |
| INC-15 | Baja     | `RESTAURANTE_PAUSADO`: el canje de oferta en caja lo bloquea (`src/offers/offers.ts:294-295`); POS (`src/checkout/pos.ts:103-187`), validar QR (`src/checkout/checkout.ts:157-235`) y validar mesa (`src/checkout/checkout.ts:387-431`) no.                                                      |
| INC-16 | Baja     | `MENU_NO_PUBLICADO`: validar QR lo exige (`src/checkout/checkout.ts:166`); validar mesa no (`src/checkout/checkout.ts:387-431`).                                                                                                                                                                 |
| INC-17 | Baja     | `LOCAL_LLENO_SOLO_LLEVAR` solo existe en la preorden (`src/orders/orders.ts:287-296`); selección y mesas no lo miran (`src/tables/selection.ts:130-225`).                                                                                                                                        |
| INC-18 | Baja     | Reintentar `validar` mesa no devuelve el detalle original (`src/checkout/checkout.ts:391`): la caja pierde qué miembros quedaron por cobrar.                                                                                                                                                     |
| INC-19 | Baja     | `precio_solo_segundo_centavos` y `precio_solo_sopa_centavos` se exponen (`src/restaurant/restaurant.service.ts:10`) pero ningún flujo los usa: un almuerzo de solo sopa cuesta P (`src/orders/orders.ts:343`).                                                                                   |
| INC-20 | Baja     | Almuerzo con P = 0: el POS responde 409 genérico sin `code` (`src/checkout/pos.ts:117`); la preorden lo cotiza gratis (`src/orders/orders.ts:343`).                                                                                                                                              |

---

## B. Modelo de cobro objetivo

### B.1 Una función, dos fases

Todos los flujos usan el mismo módulo, `src/billing/` (nombre propuesto):

1. **`cotizar(entrada) → cotizacion`**: función **pura** (sin base de datos ni Nest; ESLint lo impone igual que hoy con
   las reglas de arquitectura). Recibe precios ya resueltos por el servidor y devuelve líneas y totales. Es la que se
   prueba con las tablas de la sección G.
2. **`aplicar(q, cotizacion)`**: dentro de la transacción del flujo, llama a `fn_descontar_almuerzo` por cada unidad que
   la cotización marcó `PLAN`, recotiza con los resultados reales (una unidad que la base rechaza pasa a `CAJA` u
   `omitida`, ver B.3 paso 5), toma stock de ofertas y escribe la cuenta (sección F).

Los flujos del comensal (crear preorden, ver mesa, cotizar) solo llaman a `cotizar` y devuelven la cotización como
**estimada** (`estimada: true`). Los flujos de caja llaman a las dos fases y la cotización resultante es **final**.

### B.2 Entrada

```text
EntradaCobro
  flujo                PREORDEN | POS | QR | OFERTA | MESA
  modoMesa             CADA_UNO | INVITO_YO | null          (solo MESA)
  momentoCobro         ANTES_DE_SERVIR | DESPUES_DE_SERVIR  (restaurante.momento_cobro)
  precioAlmuerzo       entero ≥ 0   P  (snapshot del pedido si existe; si no, restaurante.precio_suelto_centavos)
  recargoLlevar        entero ≥ 0   R  (restaurante.recargo_para_llevar_centavos)
  paraLlevarCabecera   bool         pedido.tipo = LLEVAR | venta.paraLlevar | dto.paraLlevar de validar/canje
  personas[]           una sola fuera de MESA
    ref                id estable (miembro_id, cliente_id o "0")
    orden              entero: anfitrión 0; resto por (unido_en, miembro_id)
    esAnfitrion        bool
    paraLlevar         bool         solo MESA (mesa_compartida_miembro.para_llevar)
    plan.estado        OK | SIN_PLAN | SIN_SALDO | VENCIDO | DIA_NO_VALIDO | DUPLICADO | LIMITE_SAAS
    plan.disponibles   entero ≥ 0   almuerzos que el plan cubre HOY (0 si estado ≠ OK)
  items[]
    ref                id estable de la línea (para la clave de idempotencia por línea)
    personaRef
    tipo               ALMUERZO | A_LA_CARTA | EXTRA | BEBIDA | OFERTA | LIBRE
    cantidad           entero 1..100
    precioUnitario     entero ≥ 0   resuelto por el servidor (B.3 paso 2)
    paraLlevar         bool | null  SOLO flujo POS; en otros flujos debe ser null
    ofertaId           uuid | null  obligatorio si tipo = OFERTA
    categoriaBase      ALMUERZO | A_LA_CARTA | EXTRA | BEBIDA | null   (categoría del plato de la oferta)
    disponible         bool         false = agotado al momento de aplicar (solo MESA, B.3 paso 4)
    nombre             string | null  opcional; se copia tal cual a la línea de salida
    platoId            uuid | null    opcional (public_id); se copia tal cual a la línea de salida
```

`cotizar` rechaza con un error tipado (`CotizarError`, con `code`) las entradas que no cumplen este contrato. Además de
los rangos de arriba: `paraLlevar` por línea fuera del POS, `disponible = false` fuera de `MESA`, `tipo = LIBRE` fuera del
POS, `OFERTA` sin `ofertaId`, y un `ALMUERZO` (sin `ofertaId`) cuyo `precioUnitario` ≠ `precioAlmuerzo` (el precio del
almuerzo es P, B.3 paso 2; así `cubierto = P × unidades PLAN` se cumple siempre).

`plan.disponibles` se calcula con la **misma** condición que `fn_descontar_almuerzo`
(`db/migrations/20261116000000_descontar_almuerzo_mesa.sql:82-87`): `estado = 'ACTIVA'`, `vence_el >= hoy` y hoy en
`dias_validos`. Esto corrige INC-12 en todas las vistas.

### B.3 Algoritmo (orden fijo)

1. **Normalizar.**
   - Un almuerzo con `ofertaId` se convierte en una línea `OFERTA` con `categoriaBase = ALMUERZO` (D4: precio de la
     oferta, no consume plan).
   - Un plato pedido suelto toma `tipo = plato.categoria`. Un plato de categoría `ALMUERZO` con precio pedido como
     suelto se mapea por su sección (`plato.seccion`): `JUGO` → `BEBIDA`, `POSTRE` y `ADICIONAL` → `EXTRA`, `SOPA` y
     `FUERTE` → `A_LA_CARTA` (sin sección: `A_LA_CARTA`, el caso conservador). Así lo que hoy no paga recargo (un
     jugo, un postre o un adicional aparte) sigue sin pagarlo, alineado con I-1; solo el plato fuerte o la sopa servidos aparte, que
     ocupan envase propio, pagan recargo como `A_LA_CARTA`.
   - Las líneas se ordenan por `(persona.orden, posición en el pedido)`.
2. **Precio unitario** (lo pone siempre el servidor):
   - `ALMUERZO` → P.
   - `A_LA_CARTA`, `EXTRA`, `BEBIDA` → `COALESCE(precio del menú publicado de hoy, plato.precio_centavos)`; `NULL` →
     422 `PLATO_SIN_PRECIO` (como hoy, `src/tables/selection.ts:210`).
   - `OFERTA` → `oferta_flash.precio_centavos`.
   - `LIBRE` (solo POS) → el que manda la caja.
   - Si una línea `ALMUERZO` va a `CAJA` y P = 0 → 409 `ALMUERZO_SIN_PRECIO` (ver decisión I-12).
3. **Para llevar y recargo** por línea `i`:
   - `llevar(i) = flujo = POS ? (i.paraLlevar ?? paraLlevarCabecera) : flujo = MESA ? persona.paraLlevar : paraLlevarCabecera`.
   - `aplicaRecargo(i) = tipo ∈ {ALMUERZO, A_LA_CARTA}` **o** (`tipo = OFERTA` y `categoriaBase ∈ {ALMUERZO, A_LA_CARTA, null}`).
     `EXTRA`, `BEBIDA` y `LIBRE` no pagan recargo (decisión I-1, recomendada).
   - `recargoUnitario(i) = llevar(i) ∧ aplicaRecargo(i) ? R : 0`.
4. **Omitidas.** Una línea con `disponible = false` (plato de carta, extra o bebida agotado entre elegir y validar la
   mesa) queda `omitida = PLATO_AGOTADO`: cantidad cobrada 0. Un almuerzo nunca se omite por agotado (se sirve otro plato
   de la misma sección); solo se avisa.
5. **Plan** (solo líneas `ALMUERZO`, solo flujos PREORDEN, QR y MESA; el POS no consulta planes):
   - `pagador(i) = (MESA ∧ INVITO_YO) ? anfitrión : persona(i)`.
   - `saldo[pagador] = plan.estado = OK ? plan.disponibles : 0`.
   - Por cada unidad, en orden: si `saldo[pagador] > 0` → `fuente = PLAN`, `saldo[pagador] −= 1`; si no → según el
     estado del plan del pagador:
     - `SIN_PLAN`, `SIN_SALDO`, `VENCIDO`, `DIA_NO_VALIDO` → `fuente = CAJA` (paga P).
     - `DUPLICADO`, `LIMITE_SAAS` → `omitida` con ese motivo (no se cobra lo que el plan ya pagó; decisión I-10).
   - En `aplicar`, cada unidad `PLAN` llama a `fn_descontar_almuerzo` (como hoy, una llamada por unidad). Si la base
     devuelve otro resultado, esa unidad se reclasifica con la regla de arriba según ese resultado.
6. **Montos por línea** (todo entero, sin divisiones):
   - `subtotal(i) = q(i) × p(i)`
   - `recargo(i) = q(i) × recargoUnitario(i)`
   - `cubierto(i) = fuente(i) = PLAN ? subtotal(i) : 0`
   - `porCobrar(i) = subtotal(i) − cubierto(i) + recargo(i)`
   - Si `omitida(i)`: `subtotal = recargo = cubierto = porCobrar = 0`.
   - **Partición del plan.** Cada unidad que el plan cubre es su propia línea de salida `PLAN` de cantidad 1 (así cada
     una tiene su consumo, F.1). Una línea `ALMUERZO` de cantidad q con k unidades cubiertas da k líneas `PLAN` × 1 y,
     si k < q, una línea `CAJA` (u omitida) × (q − k).
   - **Refs de salida** (los usa la clave por línea de F.3, que exige refs únicos): la línea `PLAN` de la unidad k lleva
     `ref#k` (k = 1, 2, …, en orden de descuento), aunque la línea de entrada tenga cantidad 1; todas las demás (`CAJA`,
     incluido el resto no cubierto, `OFERTA` y omitidas) conservan el `ref` de entrada sin sufijo. Por eso el `ref` de
     entrada no puede contener `#`. `avisos[].lineaRef` usa el `ref` de entrada.
7. **Totales** (por pagador y de la operación):
   - `subtotalCentavos = Σ subtotal(i)`
   - `recargoCentavos = Σ recargo(i)`
   - `totalCentavos = subtotalCentavos + recargoCentavos`
   - `cubiertoPorPlanCentavos = Σ cubierto(i)` (= P × unidades `PLAN`)
   - `saldoPorCobrarCentavos = totalCentavos − cubiertoPorPlanCentavos`

Invariantes que las pruebas verifican siempre: `total = subtotal + recargo`, `saldo = total − cubierto`, `saldo ≥ 0`,
`cubierto = P × unidadesPlan`, y la suma por pagador es igual al total de la operación.

**Redondeo.** Ninguna regla de esta spec divide: todo es suma y producto de enteros. Los máximos (`cantidad ≤ 100`,
precio ≤ 100 000 000, `src/restaurant/dto.ts:50`) dan productos < 2⁵³, seguros en `number`; la implementación
verifica `Number.isSafeInteger` en cada total. Si en el futuro alguna regla reparte un monto (por ejemplo, dividir una
cuenta entre N), se usa **resto mayor**: `floor(monto / N)` a cada parte y los centavos sobrantes, uno a uno, a las
primeras partes en orden de `persona.orden`.

**El valor contable del plan no cambia.** `cubiertoPorPlanCentavos` es un dato de la cuenta (lo que el comensal no
paga). El consumo sigue guardando `valor_unitario_centavos` del plan
(`db/migrations/20261116000000_descontar_almuerzo_mesa.sql:107`) para el pasivo y los reportes.

### B.4 Salida

```text
Cotizacion
  estimada                  bool
  lineas[]
    ref, personaRef, pagadorRef
    tipo, nombre, platoId (public_id) | null, ofertaId | null
    cantidad, paraLlevar
    precioUnitarioCentavos, subtotalCentavos
    recargoUnitarioCentavos, recargoCentavos
    fuente                  PLAN | OFERTA | CAJA
    pagador                 PROPIO | ANFITRION
    cubiertoPorPlanCentavos, porCobrarCentavos
    omitida                 null | PLATO_AGOTADO | DUPLICADO | LIMITE_SAAS
  porPagador[]              { pagadorRef, subtotal, recargo, total, cubierto, saldo } (en centavos)
  subtotalCentavos, recargoCentavos, totalCentavos, cubiertoPorPlanCentavos, saldoPorCobrarCentavos
  unidadesPlan[]            { personaRef, pagadorRef }   (lo que `aplicar` descuenta)
  avisos[]                  { codigo, lineaRef | null }  OFERTA_AGOTADA, OFERTA_EXPIRADA, PLATO_AGOTADO, DUPLICADO, LIMITE_SAAS, PLAN_NO_ALCANZA
```

`estimada` no viene en la entrada: es un segundo parámetro, `cotizar(entrada, { estimada })`, con `true` por defecto
(flujos del comensal); `aplicar` lo pasa en `false`. `monedaCodigo` (ejemplo de E.1) no lo pone la función: lo agrega el
endpoint al responder.

**Fuente de pago por línea.** Las cuatro fuentes pedidas (PLAN, OFERTA, EFECTIVO/TRANSFERENCIA, ANFITRION) quedan en dos
campos, porque son preguntas distintas:

- `fuente` dice **de dónde sale el precio**: `PLAN` (lo cubre un almuerzo del plan; 0 por cobrar del precio), `OFERTA`
  (precio de la oferta, se cobra) o `CAJA` (precio normal, se cobra).
- `pagador` dice **quién paga**: `PROPIO` o `ANFITRION` (`INVITO_YO`). Con un solo campo se perdería si el anfitrión pagó
  con su plan o en caja. En `INVITO_YO`, las líneas propias del anfitrión son `PROPIO`; `ANFITRION` solo aparece en las
  líneas de los invitados (`pagador = PROPIO` exactamente cuando `pagadorRef = personaRef`).
- El **método** (`EFECTIVO`, `TRANSFERENCIA`, `DEUNA`, `src/checkout/pos.ts:43`) es del pago que salda la cuenta, no de
  la línea: una cuenta se puede pagar con varios métodos (I-14).

### B.5 Momento de cobro

El plan se descuenta **siempre al validar/canjear en caja**, en los dos modos (no cambia). Lo que cambia es cuándo se
registra el pago del saldo y si la cuenta admite más líneas:

| Aspecto                        | `ANTES_DE_SERVIR` (por defecto, `baseline:251`)                                                                                                                                     | `DESPUES_DE_SERVIR`                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Al canjear pedido / validar QR | La caja manda `cobro.metodoPago`: cuenta + pago en la misma transacción → `COBRADA`. Sin `cobro.metodoPago` queda `ABIERTA` y la respuesta marca `debeCobrarseAntesDeServir: true`. | La cuenta queda `ABIERTA`. Se puede mandar `cobro.metodoPago` (pago adelantado), no es obligatorio. |
| Validar mesa                   | Una cuenta `ABIERTA` por pagador; se cobra cada una antes de servir (`POST /v1/caja/cuentas/{id}/cobrar`).                                                                          | Igual, pero se cobran al final.                                                                     |
| Agregar líneas después         | No: una cuenta `COBRADA` no admite líneas. Lo que se pida después va por POS (venta nueva).                                                                                         | Sí, mientras esté `ABIERTA` (`POST /v1/caja/cuentas/{id}/items`): bebida extra, postre a la carta…  |
| `servir`                       | Hoy no se bloquea (cambio incompatible: decisión I-5). La respuesta y la cuenta dicen si falta cobrar.                                                                              | No se bloquea.                                                                                      |
| Precio                         | Se congela en cada línea al crearla (snapshot); cambios de precio posteriores no la tocan.                                                                                          | Igual.                                                                                              |
| Cierre de caja                 | Cuentas `ABIERTA` del día se informan en el cierre (`cuentasAbiertas`), no lo bloquean (I-15).                                                                                      | Igual; es el caso esperable si alguien se fue sin pagar.                                            |
| POS y canje de oferta          | Cobro inmediato, como hoy. El momento no los afecta.                                                                                                                                | Igual.                                                                                              |

---

## C. Matriz flujo × tipo × para llevar × plan

Lectura de cada celda: **`fuente · por cobrar por unidad`**. `PLAN · 0` = lo cubre el plan; `PLAN · R` = el plan cubre
el precio y se cobra el recargo; `CAJA · P+R` = se cobra precio y recargo; `OFERTA · O` = precio de la oferta, sin plan.
Multiplicar por la cantidad. "n/a" = el flujo no recibe ese ítem: el DTO lo rechaza con 400 (la API usa
`forbidNonWhitelisted`, `src/app.factory.ts:95`) y se indica el flujo que sí lo hace.

Columnas de plan: **válido** = `plan.estado = OK` con saldo; **sin plan** = `SIN_PLAN` (no es cliente o nunca compró);
**sin saldo** = `SIN_SALDO`, `VENCIDO` o `DIA_NO_VALIDO`. `DUPLICADO` y `LIMITE_SAAS` no son columnas: la unidad de
almuerzo queda omitida (B.3 paso 5) y el resto de la cuenta sigue igual. En `INVITO_YO` las columnas de plan se refieren
al plan **del anfitrión**; "válido" vale mientras le alcance, y cada unidad que no alcanza se cobra como "sin saldo".

| Flujo · quién paga                                   | Ítem                                           | Aquí · válido | Aquí · sin plan | Aquí · sin saldo | Llevar · válido | Llevar · sin plan | Llevar · sin saldo |
| ---------------------------------------------------- | ---------------------------------------------- | ------------- | --------------- | ---------------- | --------------- | ----------------- | ------------------ |
| PREORDEN · el comensal                               | ALMUERZO                                       | PLAN · 0      | CAJA · P        | CAJA · P         | PLAN · R        | CAJA · P+R        | CAJA · P+R         |
| PREORDEN · el comensal                               | A_LA_CARTA                                     | CAJA · C      | CAJA · C        | CAJA · C         | CAJA · C+R      | CAJA · C+R        | CAJA · C+R         |
| PREORDEN · el comensal                               | EXTRA                                          | CAJA · E      | CAJA · E        | CAJA · E         | CAJA · E        | CAJA · E          | CAJA · E           |
| PREORDEN · el comensal                               | BEBIDA                                         | CAJA · B      | CAJA · B        | CAJA · B         | CAJA · B        | CAJA · B          | CAJA · B           |
| PREORDEN · el comensal                               | OFERTA (plato ALMUERZO/A_LA_CARTA)             | OFERTA · O    | OFERTA · O      | OFERTA · O       | OFERTA · O+R    | OFERTA · O+R      | OFERTA · O+R       |
| PREORDEN · el comensal                               | OFERTA (plato EXTRA/BEBIDA)                    | OFERTA · O    | OFERTA · O      | OFERTA · O       | OFERTA · O      | OFERTA · O        | OFERTA · O         |
| POS · quien compra (sin identificar; no mira planes) | ALMUERZO                                       | CAJA · P      | CAJA · P        | CAJA · P         | CAJA · P+R      | CAJA · P+R        | CAJA · P+R         |
| POS · quien compra                                   | A_LA_CARTA                                     | CAJA · C      | CAJA · C        | CAJA · C         | CAJA · C+R      | CAJA · C+R        | CAJA · C+R         |
| POS · quien compra                                   | EXTRA                                          | CAJA · E      | CAJA · E        | CAJA · E         | CAJA · E        | CAJA · E          | CAJA · E           |
| POS · quien compra                                   | BEBIDA                                         | CAJA · B      | CAJA · B        | CAJA · B         | CAJA · B        | CAJA · B          | CAJA · B           |
| POS · quien compra                                   | OFERTA (plato ALMUERZO/A_LA_CARTA)             | n/a → OFERTA  | n/a → OFERTA    | n/a → OFERTA     | n/a → OFERTA    | n/a → OFERTA      | n/a → OFERTA       |
| POS · quien compra                                   | OFERTA (plato EXTRA/BEBIDA)                    | n/a → OFERTA  | n/a → OFERTA    | n/a → OFERTA     | n/a → OFERTA    | n/a → OFERTA      | n/a → OFERTA       |
| QR · el comensal escaneado                           | ALMUERZO                                       | PLAN · 0      | CAJA · P        | CAJA · P         | PLAN · R        | CAJA · P+R        | CAJA · P+R         |
| QR · el comensal escaneado                           | A_LA_CARTA (`items`)                           | CAJA · C      | CAJA · C        | CAJA · C         | CAJA · C+R      | CAJA · C+R        | CAJA · C+R         |
| QR · el comensal escaneado                           | EXTRA (`items`)                                | CAJA · E      | CAJA · E        | CAJA · E         | CAJA · E        | CAJA · E          | CAJA · E           |
| QR · el comensal escaneado                           | BEBIDA (`items`)                               | CAJA · B      | CAJA · B        | CAJA · B         | CAJA · B        | CAJA · B          | CAJA · B           |
| QR · el comensal escaneado                           | OFERTA (plato ALMUERZO/A_LA_CARTA)             | n/a → OFERTA  | n/a → OFERTA    | n/a → OFERTA     | n/a → OFERTA    | n/a → OFERTA      | n/a → OFERTA       |
| QR · el comensal escaneado                           | OFERTA (plato EXTRA/BEBIDA)                    | n/a → OFERTA  | n/a → OFERTA    | n/a → OFERTA     | n/a → OFERTA    | n/a → OFERTA      | n/a → OFERTA       |
| OFERTA · quien canjea (comensal opcional)            | ALMUERZO                                       | n/a → QR      | n/a → POS       | n/a → POS        | n/a → QR        | n/a → POS         | n/a → POS          |
| OFERTA · quien canjea                                | A_LA_CARTA                                     | n/a → POS     | n/a → POS       | n/a → POS        | n/a → POS       | n/a → POS         | n/a → POS          |
| OFERTA · quien canjea                                | EXTRA                                          | n/a → POS     | n/a → POS       | n/a → POS        | n/a → POS       | n/a → POS         | n/a → POS          |
| OFERTA · quien canjea                                | BEBIDA                                         | n/a → POS     | n/a → POS       | n/a → POS        | n/a → POS       | n/a → POS         | n/a → POS          |
| OFERTA · quien canjea                                | OFERTA (plato ALMUERZO/A_LA_CARTA o sin plato) | OFERTA · O    | OFERTA · O      | OFERTA · O       | OFERTA · O+R    | OFERTA · O+R      | OFERTA · O+R       |
| OFERTA · quien canjea                                | OFERTA (plato EXTRA/BEBIDA)                    | OFERTA · O    | OFERTA · O      | OFERTA · O       | OFERTA · O      | OFERTA · O        | OFERTA · O         |
| MESA `CADA_UNO` · cada miembro                       | ALMUERZO                                       | PLAN · 0      | CAJA · P        | CAJA · P         | PLAN · R        | CAJA · P+R        | CAJA · P+R         |
| MESA `CADA_UNO` · cada miembro                       | A_LA_CARTA                                     | CAJA · C      | CAJA · C        | CAJA · C         | CAJA · C+R      | CAJA · C+R        | CAJA · C+R         |
| MESA `CADA_UNO` · cada miembro                       | EXTRA                                          | CAJA · E      | CAJA · E        | CAJA · E         | CAJA · E        | CAJA · E          | CAJA · E           |
| MESA `CADA_UNO` · cada miembro                       | BEBIDA                                         | CAJA · B      | CAJA · B        | CAJA · B         | CAJA · B        | CAJA · B          | CAJA · B           |
| MESA `CADA_UNO` · cada miembro                       | OFERTA (plato ALMUERZO/A_LA_CARTA)             | OFERTA · O    | OFERTA · O      | OFERTA · O       | OFERTA · O+R    | OFERTA · O+R      | OFERTA · O+R       |
| MESA `CADA_UNO` · cada miembro                       | OFERTA (plato EXTRA/BEBIDA)                    | OFERTA · O    | OFERTA · O      | OFERTA · O       | OFERTA · O      | OFERTA · O        | OFERTA · O         |
| MESA `INVITO_YO` · el anfitrión (todas las líneas)   | ALMUERZO                                       | PLAN · 0      | CAJA · P        | CAJA · P         | PLAN · R        | CAJA · P+R        | CAJA · P+R         |
| MESA `INVITO_YO` · el anfitrión                      | A_LA_CARTA                                     | CAJA · C      | CAJA · C        | CAJA · C         | CAJA · C+R      | CAJA · C+R        | CAJA · C+R         |
| MESA `INVITO_YO` · el anfitrión                      | EXTRA                                          | CAJA · E      | CAJA · E        | CAJA · E         | CAJA · E        | CAJA · E          | CAJA · E           |
| MESA `INVITO_YO` · el anfitrión                      | BEBIDA                                         | CAJA · B      | CAJA · B        | CAJA · B         | CAJA · B        | CAJA · B          | CAJA · B           |
| MESA `INVITO_YO` · el anfitrión                      | OFERTA (plato ALMUERZO/A_LA_CARTA)             | OFERTA · O    | OFERTA · O      | OFERTA · O       | OFERTA · O+R    | OFERTA · O+R      | OFERTA · O+R       |
| MESA `INVITO_YO` · el anfitrión                      | OFERTA (plato EXTRA/BEBIDA)                    | OFERTA · O    | OFERTA · O      | OFERTA · O       | OFERTA · O      | OFERTA · O        | OFERTA · O         |

Notas de la matriz:

- "Llevar" en PREORDEN y QR es del pedido / de la petición; en MESA es del miembro; solo en POS es de la línea (D3). En
  POS una línea sin `paraLlevar` hereda el de la venta.
- n/a en POS y QR para ofertas: la oferta se canjea con `POST /v1/ofertas/{id}/canjear` (con `comensalId` si se
  identifica). Mantener un solo camino de stock evita dos implementaciones del `UPDATE` condicional
  (`src/offers/offers.ts:311-318`).
- n/a en OFERTA para ALMUERZO: con plan válido el comensal se valida por QR; sin plan, POS.
- Una oferta "sin plato" solo puede existir en el canje directo (el plato es opcional al publicar,
  `src/offers/offers.ts:25-28`); desde la app solo se piden ofertas con plato (E.2), y se trata como `A_LA_CARTA`.
- En `INVITO_YO` el invitado nunca paga: su `para_llevar` define el recargo, pero la línea va a la cuenta del anfitrión.

---

## D. Casos borde

| Caso                                                        | Resultado esperado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan sin saldo a mitad de mesa (`INVITO_YO`)                | Las unidades se cubren en orden (anfitrión primero, luego por `unido_en`, `miembro_id`); al acabarse el saldo, el resto va `CAJA · P` (+R si ese miembro lleva) a la cuenta del anfitrión. Aviso `PLAN_NO_ALCANZA`. La vista previa ya lo muestra (`miembros[].cotizacion`). Prueba G-31, G-36.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Plan sin saldo a mitad de mesa (`CADA_UNO`)                 | Solo afecta a ese miembro: su almuerzo va `CAJA · P` a su propia cuenta. Prueba G-28 (miembro C).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Saldo gastado entre la vista previa y la validación         | Manda el resultado real de `fn_descontar_almuerzo` (paso 5 de B.3), dentro de la misma transacción. La vista previa es estimada. Prueba G-36.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Plan vencido / día no válido                                | `CAJA · P` (+R). La razón exacta queda en `resultados[].resultado` (`VENCIDO`, `DIA_NO_VALIDO`). Pruebas G-19, G-20.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DUPLICADO` (validado hace < 60 s)                          | La unidad de almuerzo queda omitida: no se descuenta ni se cobra (ya se registró hace segundos). Lo demás de la cuenta sí. Pruebas G-22, G-30.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LIMITE_SAAS`                                               | Igual que `DUPLICADO`: omitida con aviso; no se cobra al comensal lo que ya pagó en su plan (decisión I-10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Oferta agotada, vencida, cerrada o no iniciada al **pedir** | Preorden y selección de mesa responden 409 con el código de hoy (`OFERTA_AGOTADA`, `OFERTA_EXPIRADA`, `OFERTA_CERRADA`, `OFERTA_NO_INICIADA`, `STOCK_INSUFICIENTE`, `src/offers/offers.ts:382-396`). No se reserva stock (I-7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Oferta que deja de valer entre pedir y **canjear**          | La línea se recotiza como si no tuviera `ofertaId` (D4): almuerzo → plan si es válido, si no `CAJA · P`; plato → `CAJA` a su precio normal. Aviso `OFERTA_AGOTADA` (o el que corresponda). **Regla de confirmación:** la referencia estimada es `orden_cabecera.total_centavos` (sin columna nueva, F.2). Si el saldo final difiere de ese total por cualquier causa (oferta caída, plan sin saldo, día no válido), el canje responde 409 `SALDO_CAMBIO` y **no descuenta el plan ni cobra nada**, hasta que la caja reenvíe con `cobro.saldoEsperadoCentavos` igual al saldo nuevo (confirmación explícita; basta `cobro` sin `metodoPago` si el saldo nuevo es 0). Prueba G-37. Decisión I-6. |
| Local `PAUSADO`                                             | Flujos del comensal: 409 `RESTAURANTE_PAUSADO` (preorden, `src/orders/orders.ts:284`; selección, `src/tables/selection.ts:154`; mesas, `src/tables/tables.ts:143`). Caja (POS, QR, mesa, canje de pedido): sigue funcionando — "lo ya creado no se toca" (`src/diner/common.ts:27`). El canje de oferta en caja mantiene su 409 actual (INC-15, decisión I-13). Prueba G-40.                                                                                                                                                                                                                                                                                                                    |
| Local `LLENO` (`LOCAL_LLENO_SOLO_LLEVAR`)                   | Solo la preorden aquí recibe 409 (como hoy). Con `paraLlevar: true` se acepta y paga recargo según la matriz. Mesas no lo miran (fuera de alcance; `docs/mesas-flujo.md:671-672`). El cobro no cambia por estar lleno. Prueba G-41.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Menú no publicado                                           | Líneas `ALMUERZO` en preorden y selección → 409 `MENU_NO_PUBLICADO`. Carta fija sin menú: se acepta en preorden y selección (igual que hoy en la selección, `src/tables/selection.ts:203-209`). QR sigue exigiéndolo (`src/checkout/checkout.ts:166`). Validar mesa no lo exige (sin cambio; INC-16 queda como decisión I-13). Prueba G-42.                                                                                                                                                                                                                                                                                                                                                     |
| Plato agotado entre elegir y cobrar                         | **Preorden**: el pedido es un compromiso de 30 min con precio y platos guardados; el canje no vuelve a mirar agotados (como hoy). **Mesa**: la selección puede tener horas; al validar con `aplicarSeleccion`, carta/extra/bebida agotada → línea omitida (`PLATO_AGOTADO`), sin cobro; un plato del almuerzo agotado no quita el almuerzo, solo avisa. Prueba G-38.                                                                                                                                                                                                                                                                                                                            |
| Miembro que se va antes de validar                          | Nuevo `POST /v1/mis/mesas/{id}/salir` (E.7): marca `salio_en`; validar lo ignora (ni almuerzo ni líneas). El anfitrión no puede salir (409 `ANFITRION_NO_PUEDE_SALIR`; debe cancelar). Prueba G-39.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Miembro que se va después de validar sin pagar              | Su cuenta (`CADA_UNO`) queda `ABIERTA`; la caja la cobra o la anula (`POST /v1/caja/cuentas/{id}/anular`). En `INVITO_YO` no pasa nada: paga el anfitrión.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Mesa con miembros con y sin plan (`CADA_UNO`)               | Una cuenta por miembro con sus líneas; cada uno paga lo suyo. Prueba G-28.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `INVITO_YO` con anfitrión sin plan                          | Todo `CAJA` a la cuenta del anfitrión. Prueba G-32.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Reintento (misma `Idempotency-Key`)                         | Misma respuesta y mismos ids: cuentas, líneas, consumos y pagos tienen claves derivadas de la llave (F.3). La mesa ya validada devuelve `yaValidada: true` **con** sus `cuentas` (corrige INC-18 de forma aditiva). Prueba G-47.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Misma llave, otro cuerpo                                    | 409 `IDEMPOTENCY_KEY_REUTILIZADA` (la cuenta guarda la huella de la entrada, F.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Cancelar la preorden                                        | Solo en `EN_CAMINO` (como hoy, `src/orders/orders.ts:411-425`). No hay cuenta todavía: nada que revertir.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Deshacer consumo (10 s) con cuenta `ABIERTA`                | Se revierte el consumo (como hoy) y se insertan líneas inversas del almuerzo **y de su recargo**. Si la cuenta queda en 0 sin pagos → `ANULADA`. Prueba G-43.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Deshacer consumo con cuenta `COBRADA`                       | 409 `CUENTA_COBRADA`: primero se anula la cuenta (devuelve el dinero). Evita un reverso parcial de pago (solo se permite un reverso por pago, `baseline:697`). Prueba G-45.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Anular cuenta                                               | Líneas inversas de todo, un pago inverso por cada pago confirmado (los pendientes pasan a `RECHAZADO`, como el POS, `src/checkout/pos.ts:266-275`), y `fn_revertir_consumo` de cada consumo de la cuenta. El recargo se devuelve con su unidad. Cajero: solo cuentas del día; dueño: cualquiera (igual que el POS, `src/checkout/pos.ts:225-226`). Prueba G-44.                                                                                                                                                                                                                                                                                                                                 |
| Recargo al reversar                                         | Siempre viaja con su unidad: reversar una unidad (consumo, línea o cuenta) reversa `cantidad × recargoUnitario` de esa línea. Un reclamo devuelto (`POST /v1/reclamos/{id}/devolver`) devuelve el almuerzo al plan pero **no** toca la cuenta ni el recargo (decisión I-11).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Oferta en una cuenta anulada                                | Se devuelve el dinero; el canje y el stock no se revierten (las ofertas no tienen deshacer hoy, `docs/estado.md:205`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pago pendiente rechazado                                    | Si un pago `PENDIENTE` de una cuenta se rechaza, el saldo vuelve a ser > 0 y la cuenta vuelve a `ABIERTA`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## E. Cambios de API (solo aditivos)

Todo lo que sigue es un campo opcional nuevo, un campo nuevo en una respuesta o un endpoint nuevo. Ningún campo existente
cambia de tipo ni de significado. Lo que no se pudo hacer así está en la sección I.

### E.1 Objetos nuevos de respuesta

`Cotizacion` (B.4). Ejemplo (prueba G-18, QR para llevar con plan):

```json
{
  "estimada": false,
  "lineas": [
    {
      "ref": "u0#1",
      "tipo": "ALMUERZO",
      "nombre": "Almuerzo",
      "platoId": null,
      "ofertaId": null,
      "cantidad": 1,
      "paraLlevar": true,
      "precioUnitarioCentavos": 350,
      "subtotalCentavos": 350,
      "recargoUnitarioCentavos": 25,
      "recargoCentavos": 25,
      "fuente": "PLAN",
      "pagador": "PROPIO",
      "cubiertoPorPlanCentavos": 350,
      "porCobrarCentavos": 25,
      "omitida": null
    }
  ],
  "subtotalCentavos": 350,
  "recargoCentavos": 25,
  "totalCentavos": 375,
  "cubiertoPorPlanCentavos": 350,
  "saldoPorCobrarCentavos": 25,
  "monedaCodigo": "USD",
  "avisos": []
}
```

`Cuenta`:

```json
{
  "id": "7c1f0a52-2b8e-4b51-9d0e-3a1c6f0d2e11",
  "origen": "QR",
  "estado": "ABIERTA",
  "momentoCobro": "DESPUES_DE_SERVIR",
  "debeCobrarseAntesDeServir": false,
  "pagador": { "nombre": "Ana Pérez", "esAnfitrion": false },
  "cotizacion": { "...": "Cotizacion con estimada = false" },
  "pagadoCentavos": 0,
  "saldoCentavos": 25,
  "pagos": [],
  "creadaEn": "2026-11-21T17:02:11.204Z",
  "cobradaEn": null,
  "anuladaEn": null
}
```

`estado`: `ABIERTA` | `COBRADA` | `ANULADA`. `saldoCentavos = cotizacion.saldoPorCobrarCentavos − Σ pagos no rechazados`.
`pagos[]`: `{ id, metodo, montoCentavos, estado, creadoEn }`.

DTO común `CobroDto` (para pagar en el mismo paso):

| Campo                   | Tipo         | Validación                               | Notas                                                                         |
| ----------------------- | ------------ | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `metodoPago`            | enum         | `EFECTIVO` \| `TRANSFERENCIA` \| `DEUNA` | Opcional: sin él solo se abre la cuenta                                       |
| `saldoEsperadoCentavos` | entero       | `≥ 0`                                    | Obligatorio si hay `metodoPago`. Distinto del saldo real → 409 `SALDO_CAMBIO` |
| `montoCentavos`         | entero       | `1..saldo`                               | Opcional; por defecto todo el saldo (pago parcial: I-14)                      |
| `pagoConfirmado`        | boolean      |                                          | Transferencia/Deuna ya verificada (como `src/checkout/pos.ts:82-85`)          |
| `comprobanteUrl`        | string https | máx. 500                                 | Como el POS                                                                   |
| `referenciaExterna`     | string       | 1..100                                   | Como el POS; repetida → 409 `REFERENCIA_PAGO_REPETIDA`                        |

### E.2 `POST /v1/mis/pedidos` (y nuevo `POST /v1/mis/pedidos/cotizar`)

Request, campos nuevos (todos opcionales):

| Campo               | Tipo                                  | Validación                               | Regla                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extras[].plato`    | uuid (ya existe)                      | —                                        | **Ahora acepta platos de la carta fija** (`A_LA_CARTA`, `EXTRA`, `BEBIDA`) aunque no estén en el menú de hoy, con las reglas de la selección: activo, precio, agotado del menú **y** de la carta (`src/tables/selection.ts:175-211`). |
| `almuerzo.ofertaId` | uuid                                  | `Matches(UUID_RE)`                       | Almuerzo al precio de la oferta; no consume plan (D4). La oferta debe tener plato de categoría `ALMUERZO`; si no → 422 `OFERTA_NO_APLICA_ALMUERZO`.                                                                                   |
| `ofertas`           | `[{ oferta: uuid, cantidad: 1..10 }]` | `ArrayMaxSize(5)`, `ArrayUnique(oferta)` | Ofertas como ítems sueltos. Solo ofertas con plato (422 `OFERTA_SIN_PLATO`).                                                                                                                                                          |

Respuesta, campos nuevos: `extras[].categoria`, `extras[].recargoLlevarCentavos`, `almuerzo.ofertaId`, `ofertas[]`
(`{ id, titulo, cantidad, precioUnitarioCentavos, subtotalCentavos }`) y `cotizacion` (estimada). Los campos de hoy
conservan su significado: `totalCentavos` = `cotizacion.saldoPorCobrarCentavos`, `recargoLlevarCentavos` =
`cotizacion.recargoCentavos`, `almuerzo.precioCentavos` = lo que se cobraría por el almuerzo (0 si lo cubre el plan).

Cambios de comportamiento ya decididos (avisar a frontend, H.2): el recargo pasa a ser por unidad de `ALMUERZO` y
`A_LA_CARTA` (D2), así que un pedido para llevar con un plato a la carta paga un recargo más (prueba G-49); un pedido solo
de carta se acepta sin menú publicado (antes 409).

Errores nuevos: 404 `OFERTA_NO_ENCONTRADA`; 409 `OFERTA_AGOTADA`, `OFERTA_EXPIRADA`, `OFERTA_CERRADA`,
`OFERTA_NO_INICIADA`, `STOCK_INSUFICIENTE`; 422 `OFERTA_NO_APLICA_ALMUERZO`, `OFERTA_SIN_PLATO`.

`POST /v1/mis/pedidos/cotizar`: mismo cuerpo, sin `Idempotency-Key`, sin efectos; responde `200` con la `Cotizacion`
estimada y los mismos errores de validación. Para que la app muestre el total antes de pedir.

Ejemplo (prueba G-49):

```json
{
  "restaurante": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "paraLlevar": true,
  "almuerzo": { "platos": ["41c0703f-3521-48eb-98ec-6d6d8efd5979"] },
  "extras": [{ "plato": "0b9d6a2e-55c4-4f0e-8c2a-1f3e9b7d6c55", "cantidad": 1 }]
}
```

→ `cotizacion`: subtotal 950, recargo 50, total 1000, cubierto 350, saldo 650; `totalCentavos: 650`.

### E.3 `POST /v1/caja/pedidos/{id}/canjear`

Hoy no lleva cuerpo. Cuerpo nuevo **opcional**: `{ "cobro": CobroDto }`.

- Sin cuerpo: igual que hoy; la respuesta suma `cotizacion` (final) y `cuenta: null`.
- Con `cobro` (aunque sea `{}`): crea la cuenta del pedido; con `metodoPago`, registra el pago (B.5).
- `porCobrarCentavos` sigue existiendo y vale `cotizacion.saldoPorCobrarCentavos`. Se calcula con el precio del almuerzo
  guardado en el pedido (F.2), no con el actual (corrige INC-06).

Respuesta nueva: `cotizacion`, `cuenta`, `avisos`. Errores nuevos: 409 `SALDO_CAMBIO`, 409 `REFERENCIA_PAGO_REPETIDA`,
422 `METODO_PAGO_NO_DISPONIBLE`, 409 `ALMUERZO_SIN_PRECIO`.

```json
{ "cobro": { "metodoPago": "EFECTIVO", "saldoEsperadoCentavos": 300 } }
```

### E.4 `POST /v1/caja/validar`

Campos nuevos opcionales:

| Campo   | Tipo                                 | Validación                               | Regla                                                                                             |
| ------- | ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `items` | `[{ plato: uuid, cantidad: 1..10 }]` | `ArrayMaxSize(10)`, `ArrayUnique(plato)` | Carta, extras y bebidas en la misma cuenta. Sin `paraLlevar` por ítem (D3): heredan `paraLlevar`. |
| `cobro` | `CobroDto`                           |                                          | Como E.3                                                                                          |

Se crea cuenta si hay `items`, `cobro`, o el saldo es > 0 (por ejemplo, recargo con plan, o almuerzo sin plan). Sin
cuenta cuando el saldo es 0 (G-17) o la unidad quedó omitida (G-22). La respuesta suma `cotizacion` y `cuenta`; el
`resultado` y el 200 de siempre no cambian.

**Cambio de comportamiento en QR:** hoy `paraLlevar` solo se guarda y el recargo no se cobra nunca (INC-03). Con esta
entrega el recargo de llevar **pasa a cobrarse** y, cuando el saldo resultante es > 0, la cuenta `ABIERTA` se crea
**automáticamente**, aunque el cliente no mande `items` ni `cobro`. Un QR con plan y `paraLlevar` que antes cerraba sin
deuda ahora deja una cuenta con saldo R (casos 18, 20, 21). Ver la lista completa en H.2.

```json
{
  "codigoQr": "BCD1.…",
  "paraLlevar": true,
  "items": [
    { "plato": "6a0e…-cola", "cantidad": 1 },
    { "plato": "0b9d…-churrasco", "cantidad": 1 },
    { "plato": "93c1…-aguacate", "cantidad": 1 }
  ],
  "cobro": { "metodoPago": "EFECTIVO", "saldoEsperadoCentavos": 825 }
}
```

→ prueba G-21: subtotal 1125, recargo 50, total 1175, cubierto 350, saldo 825.

### E.5 `POST /v1/caja/mesas/{id}/validar`

Hoy sin cuerpo. Cuerpo nuevo opcional: `{ "aplicarSeleccion": boolean }`. Por defecto `false` hasta el PR 6; **desde el PR 6 el
defecto pasa a `true`** (cambio incompatible, decisión I-4). `false` queda como opción explícita.

- `false` explícito (antes del PR 6, también sin cuerpo): descuentos como hoy (1 almuerzo por miembro). La respuesta suma `cotizacion` **informativa**
  (cada miembro con 1 almuerzo y su `paraLlevar`) y `cuentas: []`. `porCobrar` sigue siendo el conteo de hoy.
- `true` (defecto desde el PR 6): usa la selección (B.3): solo descuenta a quien eligió almuerzo (o a quien no eligió nada, que cuenta como
  "almuerzo" para no cambiar el caso más común; decisión I-4), crea una cuenta `ABIERTA` por pagador (una sola en
  `INVITO_YO`) y responde `cuentas[]`. Miembros con `salio_en` se ignoran.
- Reintento sobre mesa validada: `yaValidada: true` y **además** `cuentas[]` y `cotizacion` reconstruidas desde la base.

Campos nuevos en la respuesta: `cotizacion`, `cuentas`, `resultados[].cuentaId`, `avisos`. Errores nuevos: ninguno
(los de mesa siguen genéricos, `docs/mesas-flujo.md:654-655`).

### E.6 Vistas de mesa

`GET /v1/mis/mesas/{id}` y `GET /v1/caja/mesas/{id}`: nuevo `miembros[].cotizacion` (estimada, con la misma visibilidad
que `seleccion`: el invitado solo ve la suya) y `cotizacion` de la mesa (solo anfitrión y caja). Es el
`totalEstimadoCentavos` que pedía `docs/estado.md:46`. `cubiertos` y `almuerzosDisponibles` pasan a contar `dias_validos`
(INC-12): mismo tipo, número más exacto. Hasta el PR 4 (función `SECURITY DEFINER` de H.1) el comensal solo puede leer su
propio plan, así que en `GET /v1/mis/mesas*` los valores que dependen del plan de otro pagador (`miembros[].cotizacion`
ajenas y la `cotizacion` de la mesa) salen `null`; la caja los ve todos.

### E.7 `POST /v1/mis/mesas/{id}/salir` (nuevo)

- Comensal miembro, sin cuerpo, sin `Idempotency-Key` (repetir no cambia nada).
- `200` con la `MesaResponse`. 404 `MESA_NO_ENCONTRADA`; 409 `MESA_CERRADA` (ya validada o cancelada);
  409 `ANFITRION_NO_PUEDE_SALIR`.
- Borra su selección y marca `salio_en`. Los demás lo ven con `salio: true` (campo nuevo en `miembros[]`).

### E.8 `PUT /v1/mis/mesas/{id}/seleccion`

Campos nuevos opcionales, con las reglas de E.2: `almuerzo.ofertaId` y `ofertas: [{ oferta, cantidad }]`. Respuesta:
`seleccion.almuerzo.ofertaId`, `seleccion.ofertas[]`. Errores nuevos: los de oferta de E.2.

### E.9 `POST /v1/caja/ventas`

Nuevo `items[].paraLlevar` (boolean, opcional; sin él hereda `paraLlevar` de la venta). El recargo pasa a calcularse por
línea con B.3 paso 3: se mantiene **una** línea "Recargo para llevar" en `venta_pos_detalle` con `cantidad = Σ unidades
con recargo` (así `GET /v1/caja/ventas` no cambia de forma). Respuesta: nuevo `items[].paraLlevar`.

Cambio de comportamiento (D2): un `PLATO` a la carta en una venta para llevar paga recargo (prueba G-13).

### E.10 `POST /v1/ofertas/{id}/canjear`

Nuevo `paraLlevar` (boolean, opcional). Respuesta: nuevos `recargoLlevarCentavos` y `totalCentavos`. `montoCentavos`
conserva su significado (precio × cantidad, `src/offers/offers.ts:97`); el pago registrado es `totalCentavos`.

### E.11 Cuentas (nuevos, `@Roles('DUENO', 'CAJERO')`, `x-restaurant-id`)

| Endpoint                                                       | Idempotency-Key | Cuerpo                                  | Respuesta            | Errores                                                                                                                               |
| -------------------------------------------------------------- | --------------- | --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/caja/cuentas?estado=ABIERTA\|COBRADA\|ANULADA\|TODAS` | —               | —                                       | `Cuenta[]` del día   | 400 validación                                                                                                                        |
| `GET /v1/caja/cuentas/{id}`                                    | —               | —                                       | `Cuenta`             | 404 `CUENTA_NO_ENCONTRADA`                                                                                                            |
| `POST /v1/caja/cuentas/{id}/items`                             | obligatoria     | `{ items: [{ plato, cantidad }] }`      | `Cuenta`             | 404; 409 `CUENTA_CERRADA`, `PLATO_AGOTADO`, `IDEMPOTENCY_KEY_REUTILIZADA`; 422 `PLATO_NO_DISPONIBLE`, `PLATO_SIN_PRECIO`              |
| `POST /v1/caja/cuentas/{id}/lineas/{ref}/quitar`               | obligatoria     | —                                       | `Cuenta`             | 404; 409 `CUENTA_CERRADA`, `LINEA_DE_PLAN` (un almuerzo del plan se quita deshaciendo el consumo)                                     |
| `POST /v1/caja/cuentas/{id}/cobrar`                            | obligatoria     | `CobroDto` con `metodoPago` obligatorio | `Cuenta`             | 404; 409 `CUENTA_CERRADA`, `SALDO_CAMBIO`, `REFERENCIA_PAGO_REPETIDA`, `IDEMPOTENCY_KEY_REUTILIZADA`; 422 `METODO_PAGO_NO_DISPONIBLE` |
| `POST /v1/caja/cuentas/{id}/anular`                            | obligatoria     | `{ motivo?: string 1..200 }`            | `Cuenta` (`ANULADA`) | 404; 403 `SOLO_CUENTAS_DEL_DIA` (cajero); repetir → 200 con la cuenta ya anulada                                                      |

`POST /v1/caja/cuentas/{id}/items` solo en `DESPUES_DE_SERVIR` o mientras la cuenta esté `ABIERTA` sin pagos (B.5). Se
agrega a la lista de `Idempotency-Key` del contrato (`docs/api-contrato.md:113-138`).

`GET /v1/caja/cierre/{fecha}`: nuevo `cuentasAbiertas: { cantidad, saldoCentavos }`. Los pagos de cuentas entran solos al
arqueo como "pos" (todo lo que no es plan, `src/checkout/cash.ts:116-117`).

### E.12 Códigos nuevos

| HTTP | `code`                      | Dónde                                                                         |
| ---- | --------------------------- | ----------------------------------------------------------------------------- |
| 403  | `SOLO_CUENTAS_DEL_DIA`      | anular cuenta (cajero)                                                        |
| 404  | `CUENTA_NO_ENCONTRADA`      | cuentas                                                                       |
| 404  | `OFERTA_NO_ENCONTRADA`      | pedidos, selección (ya existe en ofertas)                                     |
| 409  | `ALMUERZO_SIN_PRECIO`       | canjear, validar con cobro, cuentas                                           |
| 409  | `ANFITRION_NO_PUEDE_SALIR`  | salir de mesa                                                                 |
| 409  | `CUENTA_CERRADA`            | cuentas                                                                       |
| 409  | `CUENTA_COBRADA`            | deshacer consumo ligado a cuenta cobrada                                      |
| 409  | `LINEA_DE_PLAN`             | quitar línea                                                                  |
| 409  | `REFERENCIA_PAGO_REPETIDA`  | cobros (hoy el POS responde un 409 sin `code`, `src/checkout/pos.ts:190-191`) |
| 409  | `SALDO_CAMBIO`              | cobros                                                                        |
| 422  | `MONTO_EXCEDE_SALDO`        | cobrar con `montoCentavos` mayor que el saldo (agregado en el PR 5a)          |
| 422  | `OFERTA_NO_APLICA_ALMUERZO` | pedidos, selección                                                            |
| 422  | `OFERTA_SIN_PLATO`          | pedidos, selección                                                            |

`POST /v1/caja/consumos/{id}/deshacer` solo puede devolver `CUENTA_COBRADA` para consumos creados con cuenta (flujos
nuevos): los consumos de hoy no tienen cuenta y se comportan igual.

---

## F. Cambios de base de datos (descripción, sin SQL final)

Todo en migraciones nuevas (dbmate). Ninguna aplicada se edita. Las de la entrega C ya están aplicadas en Neon
(19 aplicadas, 0 pendientes, 2026-11-21).

### F.1 Tablas nuevas

**`cuenta_cobro`** (cabecera; mutable solo en su estado)

- `cuenta_id` identidad, `public_id` UUID único, `restaurante_id`.
- Origen (exactamente uno): `orden_id`, `consumo_id` (QR con plan), `intento_id` (QR sin consumo: el
  `intento_escaneo` que registra todo escaneo, también los rechazados, p. ej. un almuerzo sin plan, E.4),
  `mesa_compartida_id` (+ `miembro_id` del pagador). FK compuestas `(restaurante_id, …)` como el resto del esquema
  (`intento_escaneo` gana `UNIQUE (restaurante_id, intento_id)` para eso).
- Pagador: `cliente_id` (nullable), `usuario_id` (nullable), `nombre_pagador` (copia).
- `momento_cobro` (copia del local al crear), `para_llevar` de cabecera, `moneda_codigo`.
- `estado` `ABIERTA` | `COBRADA` | `ANULADA`, `cobrada_en`, `anulada_en`, `anulada_por_personal_id`, `motivo_anulacion`.
- `clave_idempotencia` UUID, `huella` (sha256 de la entrada normalizada), `personal_id`, `fecha_local`, `creada_en`.
- Restricciones: `UNIQUE (restaurante_id, clave_idempotencia)`; un solo origen (`num_nonnulls(...) = 1`); índice único
  parcial "una cuenta no anulada por `orden_id`", "por `(mesa_compartida_id, miembro_id)`", "por `consumo_id`" y "por
  `intento_id`".
- Permisos: `GRANT UPDATE (estado, cobrada_en, anulada_en, anulada_por_personal_id, motivo_anulacion)` a `bocadoo_app`
  (mismo patrón que `db/migrations/20261118000000_ofertas_flash.sql:10-11`) y un trigger que solo permite
  `ABIERTA → COBRADA`, `COBRADA → ABIERTA` (pago rechazado) y `* → ANULADA` (terminal).

**`cuenta_cobro_linea`** (libro de solo-inserción)

- `linea_id`, `cuenta_id`, `restaurante_id`, `ref` (de la cotización), `persona_ref`.
- `tipo` (`ALMUERZO`, `A_LA_CARTA`, `EXTRA`, `BEBIDA`, `OFERTA`, `LIBRE`), `fuente` (`PLAN`, `OFERTA`, `CAJA`),
  `pagador` (`PROPIO`, `ANFITRION`), `omitida` (nullable).
- `plato_id`, `oferta_flash_id`, `canje_oferta_id`, `consumo_id` (nullable, FK compuestas), `nombre` (copia).
- `cantidad` (≠ 0; negativa = reverso), `precio_unitario_centavos ≥ 0`, `recargo_unitario_centavos ≥ 0`,
  `subtotal_centavos`, `recargo_centavos`, `cubierto_centavos`.
- `clave_idempotencia` UUID, `revierte_a_linea_id`, `creada_en`.
- CHECKs: con `omitida IS NULL`, `subtotal = cantidad × precio_unitario`, `recargo = cantidad × recargo_unitario` y
  `cubierto = (fuente = 'PLAN') ? subtotal : 0`; con `omitida IS NOT NULL`, `fuente = 'CAJA'` y
  `subtotal = recargo = cubierto = 0` (la línea conserva su cantidad y su precio unitario, solo informativos);
  `fuente = 'PLAN' ⇒ tipo = 'ALMUERZO' ∧ consumo_id NOT NULL ∧ |cantidad| = 1`;
  `fuente = 'OFERTA' ⇒ oferta_flash_id NOT NULL`; `(cantidad > 0) = (revierte_a_linea_id IS NULL)` (como
  `consumo_almuerzo`, `baseline:602`).
- `UNIQUE (restaurante_id, clave_idempotencia)`; índice único parcial "un solo reverso por línea" (como
  `baseline:604`).
- Trigger `fn_solo_insercion` (el de `baseline:1158-1169`): ni `UPDATE` ni `DELETE`.

Saldo de una cuenta (derivado, nunca guardado): `Σ (subtotal − cubierto + recargo)` de sus líneas `−` Σ pagos no
rechazados. Opcional: una vista `v_cuenta_saldo` para la caja y el cierre.

### F.2 Columnas nuevas

| Tabla                          | Columna                                                                      | Para qué                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transaccion_pago`             | `cuenta_cobro_id` (FK compuesta)                                             | Pago de una cuenta. Se reemplaza la CHECK de origen único (`baseline:694`, sin nombre: confirmarlo con `\d transaccion_pago` antes de escribir la migración) por una que incluya la nueva columna. Las filas existentes la cumplen.                                               |
| `orden_cabecera`               | `precio_almuerzo_centavos` (nullable), `almuerzo_oferta_flash_id` (nullable) | Snapshot de P al pedir (INC-06) y oferta aplicada al almuerzo. `subtotal`/`recargo`/`total` conservan su significado de hoy (por cobrar). **No se agrega columna para la cotización estimada**: la referencia del 409 `SALDO_CAMBIO` en el canje es `total_centavos` (ver abajo). |
| `orden_detalle`                | `oferta_flash_id`, `recargo_unitario_centavos` (default 0)                   | Ofertas como ítems y recargo por unidad. Las filas viejas quedan con 0.                                                                                                                                                                                                           |
| `mesa_compartida_miembro`      | `salio_en`, `almuerzo_oferta_flash_id`                                       | Miembro que se va; oferta aplicada al almuerzo del miembro.                                                                                                                                                                                                                       |
| `mesa_compartida_miembro_item` | `oferta_flash_id`                                                            | Ofertas en la selección (siempre con plato, así `plato_id NOT NULL` se mantiene).                                                                                                                                                                                                 |
| `canje_oferta_flash`           | `cuenta_cobro_id` (nullable)                                                 | Canje hecho dentro de una cuenta: su pago es el de la cuenta, no uno propio.                                                                                                                                                                                                      |

**Referencia de la cotización estimada.** `orden_cabecera.total_centavos` ya guarda, desde el pedido, el por cobrar
estimado: almuerzo a precio P si el plan no lo cubre (0 si lo cubre) + extras + recargo de llevar
(`src/orders/orders.ts:340-343`, insert en `:349-362`; la CHECK `total = subtotal + recargo` está en el baseline,
`orden_cabecera`). Por eso no hace falta columna nueva: el canje compara el saldo final con `total_centavos`. Desde el
PR 7 la misma columna se llena con la cotización estimada de B (ofertas, carta y recargo por unidad), con el mismo
significado. Cualquier diferencia entre el saldo final y `total_centavos` (oferta caída, plan sin saldo, día no válido,
precio cambiado) dispara el 409 `SALDO_CAMBIO` hasta que la caja confirme con `cobro.saldoEsperadoCentavos`.

Para salir de la mesa, una función `fn_salir_mesa` (`SECURITY DEFINER`, como `fn_unirse_mesa`) que valida en una
transacción: es miembro, no es anfitrión, la mesa sigue abierta y sin validar; marca `salio_en` y borra su selección.
Así no hace falta abrir `UPDATE` sobre `mesa_compartida_miembro` al comensal.

### F.3 Idempotencia

Se reutiliza `deriveKey(llave, etiqueta)` (`src/checkout/checkout.ts:98-101`; pasa a `src/common/` para compartirla).
Todas las claves salen de la `Idempotency-Key` de la petición (`K`), así un reintento regenera exactamente las mismas:

| Registro                      | Clave                                                                      | Índice que la protege                                                     |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Consumo (QR, preorden)        | `K` (como hoy, `src/checkout/checkout.ts:225`, `src/orders/orders.ts:623`) | `consumo_almuerzo (restaurante_id, clave_idempotencia)`, `baseline:601`   |
| Consumo (mesa, por miembro)   | `deriveKey(K, miembro_id)` (como hoy, `src/checkout/checkout.ts:406`)      | ídem                                                                      |
| Cuenta                        | `deriveKey(K, 'cuenta:' + pagadorRef)`                                     | `cuenta_cobro (restaurante_id, clave_idempotencia)`                       |
| Línea                         | `deriveKey(K, 'linea:' + cuentaRef + ':' + linea.ref)`                     | `cuenta_cobro_linea (restaurante_id, clave_idempotencia)`                 |
| Canje de oferta en una cuenta | `deriveKey(K, 'oferta:' + linea.ref)`                                      | `canje_oferta_flash (restaurante_id, clave_idempotencia)`, `baseline:663` |
| Pago en el mismo paso         | `deriveKey(K, 'pago:' + cuentaRef)`                                        | `transaccion_pago (restaurante_id, clave_idempotencia)`, `baseline:693`   |
| Pago por `/cobrar`, `/anular` | `K` del endpoint                                                           | ídem                                                                      |

- `linea.ref` es determinista: `persona_ref` + posición normalizada (B.3 paso 1). La `huella` de la cuenta detecta "misma
  llave, otro cuerpo" → 409 `IDEMPOTENCY_KEY_REUTILIZADA`.
- Concurrencia: `cobrar`, `anular`, `items` bloquean la cuenta (`FOR UPDATE`); validar mesa ya bloquea la mesa
  (`src/checkout/checkout.ts:390`) y canjear el pedido (`src/orders/orders.ts:666`). Dos peticiones simultáneas con la
  misma llave: gana una por el índice único y la otra devuelve el resultado ganador (el patrón de
  `src/checkout/pos.ts:193-198`).

### F.4 Libro de solo-inserción y reversos

- `cuenta_cobro_linea`, `transaccion_pago`, `consumo_almuerzo` y `canje_oferta_flash` nunca se actualizan ni se borran
  (triggers de `baseline:1158-1186`). Reversar = fila inversa enlazada (`revierte_a_*`), con un solo reverso por fila.
- La cabecera `cuenta_cobro` solo cambia su estado (permiso por columnas + trigger de transiciones).
- Anular una cuenta es una transacción: líneas inversas → pagos inversos (o `RECHAZADO` si estaban pendientes) →
  `fn_revertir_consumo` de sus consumos → `estado = ANULADA`.
- El cierre de caja no cambia de fórmula: suma pagos confirmados con signo (`src/checkout/cash.ts:110-121`).

### F.5 RLS

- `cuenta_cobro` y `cuenta_cobro_linea`: política `tenant_total` (la de `baseline:1439`) para el personal; `comensal_lee`
  (`usuario_id = app_user_id()`, y las líneas vía su cuenta) para que la app pueda mostrar "te falta pagar X". El
  comensal no inserta ni actualiza. `bocadoo_servicio`: todo (jobs).
- `transaccion_pago`: política de solo lectura `comensal_lee_pagos_cuenta` para el pagador: ve los pagos cuyo
  `cuenta_cobro_id` es de una cuenta con `usuario_id = app_user_id()` (así el saldo con pagos parciales le cuadra). No ve
  pagos sin cuenta (planes, POS, ofertas sueltas) ni de cuentas ajenas, y no escribe.
- Ninguna política nueva sobre `orden_*` ni `mesa_*`: las columnas nuevas caen bajo las políticas existentes; las del
  comensal en `orden_detalle` ya exigen pedido propio `EN_CAMINO` (`db/migrations/20261117000000_preordenes_comensal.sql:36-38`).
- Pruebas de RLS directas como `bck_api` (patrón de `test/integration/mesa-seleccion.int.ts`): otro local no ve cuentas;
  el comensal no ve cuentas ajenas ni puede escribir.

> **Nota del PR 4 (lo que quedó en la base; el texto de arriba no cambia).** Migraciones `20261121150000_cuentas_cobro`,
> `20261121150100_orden_snapshot_ofertas` y `20261121150200_mesa_salida_ofertas`. La CHECK de origen de
> `transaccion_pago` se llamaba `transaccion_pago_check`; la nueva es `ck_pago_origen_unico`. Además de lo de F.1:
> `ck_cuenta_mesa_con_miembro` (mesa ⇔ miembro pagador), CHECK de coherencia de `cobrada_en`/`anulada_en`, el reverso de
> una línea debe ser de la misma cuenta, `ck_miembro_anfitrion_no_sale` y la vista `v_cuenta_saldo` (`security_invoker`).
> `fn_salir_mesa(uuid)` devuelve `SALIO`, `YA_SALIO`, `NO_ENCONTRADA`, `ANFITRION_NO_PUEDE_SALIR` o `MESA_CERRADA`;
> `fn_plan_pagador_mesa(bigint, bigint)` devuelve solo un entero, **acotado**: al propio pagador, sus almuerzos
> disponibles reales; a cualquier otro, `LEAST(disponibles, miembros de la mesa sin salio_en)`, que basta para cotizar
> (un almuerzo por miembro) sin revelar el saldo exacto de un plan ajeno. El invitado solo pregunta por sí mismo. Queda
> abierto (PR 6): las políticas de `mesa_*` no miran `salio_en`; detalle en `docs/estado.md`, sección del PR 4.

---

## G. Plan de pruebas (casos de tabla)

Constantes de todos los casos: **P = 350**, **R = 25**, **C = 600** (Churrasco, `A_LA_CARTA`), **E = 75** (Aguacate,
`EXTRA`), **B = 100** (Cola, `BEBIDA`), **O1 = 450** (oferta sobre el Churrasco), **O2 = 250** (oferta sobre un plato
`ALMUERZO`), **O3 = 80** (oferta sobre la Cola). Plan "OK" = 5 almuerzos disponibles salvo que se diga otra cosa.

Columnas de salida: **Sub** = `subtotalCentavos`, **Rec** = `recargoCentavos`, **Tot** = `totalCentavos`, **Cub** =
`cubiertoPorPlanCentavos`, **Saldo** = `saldoPorCobrarCentavos`. Los casos 1–36 y 49 son de la función pura `cotizar`;
37–48 necesitan base (integración). Estado: 43 y 45 cubiertos en 5a (44, 46 y 48 adaptados a pedidos); **44 y 48 cubiertos
literal en 5b; 46 pendiente de PR 6** (es de mesa). En 5b también 17, 18a/b, 20, 21, 22, 23 y 45 con QR (19 en unitarios).

| #   | Flujo              | Entrada                                                                                                               | Líneas esperadas (fuente)                             | Sub     | Rec    | Tot     | Cub     | Saldo  | Otros                                                                                                                                                                                      |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------- | ------ | ------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | PREORDEN           | ALM, aquí, plan OK                                                                                                    | ALM PLAN                                              | 350     | 0      | 350     | 350     | 0      | `totalCentavos` heredado = 0 (igual que hoy)                                                                                                                                               |
| 2   | PREORDEN           | ALM, llevar, plan OK                                                                                                  | ALM PLAN                                              | 350     | 25     | 375     | 350     | 25     | heredado = 25 (igual que hoy)                                                                                                                                                              |
| 3   | PREORDEN           | ALM, aquí, SIN_PLAN                                                                                                   | ALM CAJA                                              | 350     | 0      | 350     | 0       | 350    |                                                                                                                                                                                            |
| 4   | PREORDEN           | ALM, llevar, SIN_SALDO                                                                                                | ALM CAJA                                              | 350     | 25     | 375     | 0       | 375    |                                                                                                                                                                                            |
| 5   | PREORDEN           | ALM + B×2 + E×1, llevar, plan OK                                                                                      | ALM PLAN, B CAJA, E CAJA                              | 625     | 25     | 650     | 350     | 300    | heredado = 300 (igual que hoy)                                                                                                                                                             |
| 6   | PREORDEN           | C×2, llevar, plan OK, sin almuerzo                                                                                    | C CAJA                                                | 1200    | 50     | 1250    | 0       | 1250   | `unidadesPlan` vacío                                                                                                                                                                       |
| 7   | PREORDEN           | ALM + C×1, aquí, SIN_PLAN                                                                                             | ALM CAJA, C CAJA                                      | 950     | 0      | 950     | 0       | 950    |                                                                                                                                                                                            |
| 8   | PREORDEN           | `almuerzo.ofertaId` = O2, aquí, plan OK                                                                               | OFERTA (base ALMUERZO)                                | 250     | 0      | 250     | 0       | 250    | plan intacto                                                                                                                                                                               |
| 9   | PREORDEN           | `almuerzo.ofertaId` = O2, llevar, plan OK                                                                             | OFERTA                                                | 250     | 25     | 275     | 0       | 275    | plan intacto                                                                                                                                                                               |
| 10  | PREORDEN           | `ofertas` O3×2, llevar, VENCIDO                                                                                       | OFERTA (base BEBIDA)                                  | 160     | 0      | 160     | 0       | 160    |                                                                                                                                                                                            |
| 11  | POS                | ALM×3, venta `paraLlevar: true`                                                                                       | ALM CAJA                                              | 1050    | 75     | 1125    | 0       | 1125   | igual que hoy                                                                                                                                                                              |
| 12  | POS                | ALM×2 (`paraLlevar: true`), ALM×1, C×1 (`true`), B×2 (`true`), E×1 (`true`); venta `false`                            | todo CAJA                                             | 1925    | 75     | 2000    | 0       | 2000   | recargo: 2 + 0 + 1 unidades                                                                                                                                                                |
| 13  | POS                | C×1 (PLATO), venta `paraLlevar: true`                                                                                 | C CAJA                                                | 600     | 25     | 625     | 0       | 625    | hoy 600: cambio por D2                                                                                                                                                                     |
| 14  | POS                | ALM×1 `paraLlevar: false` + ALM×1 sin marca; venta `true`                                                             | ALM CAJA ×2                                           | 700     | 25     | 725     | 0       | 725    |                                                                                                                                                                                            |
| 15  | POS                | LIBRE 50×1, venta `true`                                                                                              | LIBRE CAJA                                            | 50      | 0      | 50      | 0       | 50     |                                                                                                                                                                                            |
| 16  | POS                | ítem `tipo: OFERTA`                                                                                                   | —                                                     | —       | —      | —       | —       | —      | 400 validación                                                                                                                                                                             |
| 17  | QR                 | aquí, plan OK                                                                                                         | ALM PLAN                                              | 350     | 0      | 350     | 350     | 0      | sin cuenta                                                                                                                                                                                 |
| 18  | QR                 | llevar, plan OK                                                                                                       | ALM PLAN                                              | 350     | 25     | 375     | 350     | 25     | a) `ANTES` + `cobro` EFECTIVO → cuenta `COBRADA`, pago 25; b) `DESPUES` sin cobro → `ABIERTA`, saldo 25                                                                                    |
| 19  | QR                 | aquí, VENCIDO                                                                                                         | ALM CAJA                                              | 350     | 0      | 350     | 0       | 350    |                                                                                                                                                                                            |
| 20  | QR                 | llevar, DIA_NO_VALIDO                                                                                                 | ALM CAJA                                              | 350     | 25     | 375     | 0       | 375    |                                                                                                                                                                                            |
| 21  | QR                 | llevar, plan OK, `items` B×1, C×1, E×1                                                                                | ALM PLAN, B, C, E CAJA                                | 1125    | 50     | 1175    | 350     | 825    |                                                                                                                                                                                            |
| 22  | QR                 | aquí, DUPLICADO                                                                                                       | ALM omitida                                           | 0       | 0      | 0       | 0       | 0      | sin cuenta; aviso DUPLICADO                                                                                                                                                                |
| 23  | QR                 | con campo `ofertaId`                                                                                                  | —                                                     | —       | —      | —       | —       | —      | 400 validación                                                                                                                                                                             |
| 24  | OFERTA             | O1×2, sin `paraLlevar`                                                                                                | OFERTA                                                | 900     | 0      | 900     | 0       | 900    | `montoCentavos` 900 (igual que hoy)                                                                                                                                                        |
| 25  | OFERTA             | O1×2, `paraLlevar: true`                                                                                              | OFERTA                                                | 900     | 50     | 950     | 0       | 950    | `montoCentavos` 900, `totalCentavos` 950, pago 950                                                                                                                                         |
| 26  | OFERTA             | O3×1, `paraLlevar: true`                                                                                              | OFERTA (base BEBIDA)                                  | 80      | 0      | 80      | 0       | 80     |                                                                                                                                                                                            |
| 27  | OFERTA             | con campo `items`                                                                                                     | —                                                     | —       | —      | —       | —       | —      | 400 validación                                                                                                                                                                             |
| 28  | MESA `CADA_UNO`    | A (anfitrión, OK): ALM + B×1, aquí · B (SIN_PLAN): ALM + E×1, aquí · C (SIN_SALDO): ALM, llevar · D (OK): C×1, aquí   | A: PLAN + CAJA · B: CAJA ×2 · C: CAJA · D: CAJA       | 1825    | 25     | 1850    | 350     | 1500   | por cuenta: A 450/0/450/350/100 · B 425/0/425/0/425 · C 350/25/375/0/375 · D 600/0/600/0/600; 1 consumo; plan de D intacto                                                                 |
| 29  | MESA `CADA_UNO`    | un miembro OK, llevar, `ofertas` O1×1, sin almuerzo                                                                   | OFERTA                                                | 450     | 25     | 475     | 0       | 475    | plan intacto                                                                                                                                                                               |
| 30  | MESA `CADA_UNO`    | miembro DUPLICADO: ALM + B×1, aquí                                                                                    | ALM omitida, B CAJA                                   | 100     | 0      | 100     | 0       | 100    | aviso DUPLICADO                                                                                                                                                                            |
| 31  | MESA `INVITO_YO`   | anfitrión OK con 2; H, G1, G2 (llevar), G3, todos ALM                                                                 | H PLAN, G1 PLAN, G2 CAJA, G3 CAJA (pagador ANFITRION) | 1400    | 25     | 1425    | 700     | 725    | 1 cuenta (anfitrión); 2 consumos; aviso PLAN_NO_ALCANZA                                                                                                                                    |
| 32  | MESA `INVITO_YO`   | anfitrión SIN_PLAN; H: ALM + B×1, G1: ALM, G2: ALM                                                                    | todo CAJA                                             | 1150    | 0      | 1150    | 0       | 1150   |                                                                                                                                                                                            |
| 33  | MESA `INVITO_YO`   | anfitrión OK; H: ALM; G1: `almuerzo.ofertaId` = O2                                                                    | H PLAN, G1 OFERTA                                     | 600     | 0      | 600     | 350     | 250    | 1 consumo                                                                                                                                                                                  |
| 34  | MESA `INVITO_YO`   | anfitrión OK; H: ALM aquí; G1 (llevar): C×1 + E×1, sin almuerzo                                                       | H PLAN, C CAJA, E CAJA                                | 1025    | 25     | 1050    | 350     | 700    | 1 consumo                                                                                                                                                                                  |
| 35  | MESA (heredado)    | sin `aplicarSeleccion`; `CADA_UNO`: A OK aquí, B SIN_PLAN llevar                                                      | A PLAN, B CAJA (informativo)                          | 700     | 25     | 725     | 350     | 375    | `porCobrar` = 1 como hoy; `cuentas: []`                                                                                                                                                    |
| 36  | MESA `INVITO_YO`   | vista previa: anfitrión con 2; al validar la base da OK, SIN_SALDO, SIN_SALDO; H, G1, G2 ALM aquí                     | H PLAN, G1 CAJA, G2 CAJA                              | 1050    | 0      | 1050    | 350     | 700    | estimado era Cub 700 / Saldo 350                                                                                                                                                           |
| 37  | PREORDEN → canjear | pedido del caso 8; al canjear O2 está AGOTADA; plan OK                                                                | ALM PLAN                                              | 350     | 0      | 350     | 350     | 0      | estimado al pedir: `total_centavos` = 250; el canje da 409 `SALDO_CAMBIO` (plan intacto, sin cobro) hasta reenviar con `cobro.saldoEsperadoCentavos: 0`; entonces OFERTA_AGOTADA y plan −1 |
| 38  | MESA `CADA_UNO`    | miembro OK: ALM + C×1; C se agotó antes de validar                                                                    | ALM PLAN, C omitida                                   | 350     | 0      | 350     | 350     | 0      | aviso PLATO_AGOTADO                                                                                                                                                                        |
| 39  | MESA `INVITO_YO`   | anfitrión OK; H, G1, G2 ALM; G2 llamó a `salir` antes                                                                 | H PLAN, G1 PLAN                                       | 700     | 0      | 700     | 700     | 0      | 2 consumos                                                                                                                                                                                 |
| 40  | PREORDEN / POS     | local `PAUSADO`                                                                                                       | —                                                     | —       | —      | —       | —       | —      | preorden 409 `RESTAURANTE_PAUSADO`; POS caso 11 da 1125                                                                                                                                    |
| 41  | PREORDEN           | local LLENO: ALM aquí / ALM llevar con plan OK                                                                        | — / ALM PLAN                                          | — / 350 | — / 25 | — / 375 | — / 350 | — / 25 | aquí → 409 `LOCAL_LLENO_SOLO_LLEVAR`; llevar = caso 2                                                                                                                                      |
| 42  | PREORDEN           | menú no publicado: C×1 aquí / ALM                                                                                     | C CAJA / —                                            | 600     | 0      | 600     | 0       | 600    | con ALM → 409 `MENU_NO_PUBLICADO`                                                                                                                                                          |
| 43  | Reverso            | caso 18b (cuenta `ABIERTA`); deshacer el consumo en 10 s                                                              | ALM PLAN +1 y −1                                      | 0       | 0      | 0       | 0       | 0      | cuenta `ANULADA`; plan +1                                                                                                                                                                  |
| 44  | Reverso            | caso 21 cobrado en EFECTIVO (825); anular cuenta                                                                      | todas las líneas con su inversa                       | 0       | 0      | 0       | 0       | 0      | pago −825; plan +1; efectivo del día neto 0                                                                                                                                                |
| 45  | Reverso            | caso 18a (cobrado 25); deshacer el consumo                                                                            | sin cambios                                           | 350     | 25     | 375     | 350     | 25     | 409 `CUENTA_COBRADA`                                                                                                                                                                       |
| 46  | Cobro              | cuenta del caso 31 (saldo 725): cobrar 500 EFECTIVO (esperado 725); luego 225 TRANSFERENCIA confirmada (esperado 225) | —                                                     | 1400    | 25     | 1425    | 700     | 725    | saldo 225 → 0, `COBRADA`; repetir el 2.º con su llave = mismo pago; esperado 725 tras el 1.º → 409 `SALDO_CAMBIO`                                                                          |
| 47  | Idempotencia       | caso 28 repetido con la misma llave / con otra llave                                                                  | mismas líneas                                         | 1825    | 25     | 1850    | 350     | 1500   | mismos ids de cuenta y consumo; otra llave → `yaValidada: true` con las mismas `cuentas`                                                                                                   |
| 48  | Idempotencia       | caso 21 repetido con la misma llave y otros `items`                                                                   | —                                                     | —       | —      | —       | —       | —      | 409 `IDEMPOTENCY_KEY_REUTILIZADA`                                                                                                                                                          |
| 49  | PREORDEN           | ALM + extra del menú cuyo plato es `A_LA_CARTA` (C×1), llevar, plan OK                                                | ALM PLAN, C CAJA                                      | 950     | 50     | 1000    | 350     | 650    | hoy 625: +25 por D2                                                                                                                                                                        |

Cobertura de la matriz C: cada fila tiene al menos un caso (PREORDEN: 1–10, 49; POS: 11–16; QR: 17–23; OFERTA: 24–27;
`CADA_UNO`: 28–30, 38; `INVITO_YO`: 31–34, 36, 39) y cada columna de plan aparece en al menos un flujo de los que
consultan planes. Bordes de D: 30, 22 (duplicado), 31, 36 (plan no alcanza), 19, 20 (vencido, día), 37 (oferta), 38
(agotado), 39 (se va), 40–42 (pausado, lleno, menú), 43–46 (reversos y cobros), 47–48 (idempotencia).

Además de los casos, cada prueba de `cotizar` verifica las invariantes de B.3 paso 7.

---

## H. Plan de implementación

### H.1 PRs (en orden; cada uno se despliega sin romper el frontend)

1. **docs: spec de cobros** (este documento). Sin código.
2. **feat(billing): pure quote function** — `src/billing/cotizar.ts` + `test/unit/cotizar.spec.ts` con los casos
   1–36 y 49 de G como tabla. Sin base, sin endpoints. Regla ESLint: `src/billing/**` no importa `db`, `nestjs` ni
   `pg`.
3. **feat: informative quotes in responses** — `cotizacion` en `POST/GET /v1/mis/pedidos`, `POST /v1/mis/pedidos/cotizar`,
   `GET /v1/caja/pedidos/*`, vistas de mesa y respuesta de `validar` mesa; `dias_validos` en las estimaciones (INC-12).
   Sin migración. Solo campos nuevos.
4. **feat(db): billing accounts** — migraciones nuevas (nombres tentativos):
   `…_cuentas_cobro` (F.1, `transaccion_pago.cuenta_cobro_id`, CHECK de origen, triggers, RLS, grants),
   `…_orden_snapshot_ofertas` (F.2 de `orden_*` y `canje_oferta_flash`), `…_mesa_salida_ofertas` (F.2 de `mesa_*`,
   `fn_salir_mesa`). Todas nullable o con default: el código de hoy sigue funcionando. Up/down/up en Postgres local;
   aplicar en Neon con revisión. Pruebas de RLS. Además, una función `SECURITY DEFINER` (p. ej. `fn_plan_pagador_mesa`)
   que, a quien sea miembro de la mesa, devuelve **solo los almuerzos disponibles** del plan del pagador (`CADA_UNO`:
   cada miembro; `INVITO_YO`: el anfitrión), calculados con la condición de `fn_descontar_almuerzo`, y nada más del
   plan ni del cliente (sin nombre, teléfono, precios ni vencimientos). Completa `miembros[].cotizacion` en las vistas
   de mesa del comensal (hoy `null`, E.6).
5. **feat(checkout): accounts and payments**, en dos partes:
   - **5a (hecho):** `src/cobro/aplicar.ts` (fuera de `src/billing`, que sigue sin `db`/`nest`/`pg`),
     `GET /v1/caja/cuentas/{id}`, `POST …/cobrar` y `POST …/anular` de E.11, `cobro` en
     `POST /v1/caja/pedidos/{id}/canjear` (con snapshot de P), confirmar/rechazar pagos de cuenta y `CUENTA_COBRADA` en
     deshacer (se adelantó del 5b: sin esto, deshacer un pedido cobrado devolvía el almuerzo y dejaba el pago).
     Integración: 43, 45 y, adaptados a cuentas de pedido, 44, 46 y 48.
   - **5b (hecho):** `cobro`/`items` en `POST /v1/caja/validar`, `GET /v1/caja/cuentas` (lista del día local,
     paginada), `items` y `quitar` de E.11, `cuentasAbiertas` en el cierre y `uq_pago_referencia_externa` por
     restaurante (migración `20261121160000`). Integración: casos 17, 18, 20–23 y 44, 48 literales con QR; 37 queda
     para PR 7 (ofertas en pedidos) y 46 para PR 6 (mesa). La cuenta automática del QR sin `items` ni `cobro` (H.2,
     casos 18 y 20) **no** entra: sin ellos `validar` responde como antes (decisión pendiente).
6. **feat(tables): selection becomes charge** — `aplicarSeleccion` (**`true` por defecto, etiqueta
   `cambio-incompatible`**, I-4), cuentas por pagador, `salir`, ofertas en la selección. Integración: casos 28–36, 38, 39, 47.
   Junto con el endpoint `salir` debe cerrar por RLS el acceso de los miembros con `salio_en`: que no vuelvan a escribir
   su selección (`comensal_escribe`/`comensal_borra` de `mesa_compartida_miembro_item`), que no ocupen cupo en
   `fn_mesa_invitacion` y que puedan (o no, a decidir) volver a unirse con `fn_unirse_mesa` (hoy reciben
   `YA_ERES_MIEMBRO`).
7. **feat(orders,pos,offers): carta, offers and per-unit surcharge** — carta y ofertas en pedidos (E.2), `paraLlevar`
   por línea en POS (E.9), `paraLlevar` en el canje de oferta (E.10). Es el PR con cambios de comportamiento (recargo a
   la carta): se anuncia antes (H.2). Integración: casos 1–16, 24–27, 40–42, 49.
8. **feat(reports): include accounts** — ranking de platos y almuerzos sueltos del cierre cuentan las líneas `CAJA` de
   cuentas (hoy solo `venta_pos_detalle` y `orden_detalle`, `src/checkout/cash.ts:128-131`, `src/reports/operations.ts:139`).
9. **(Después de decidir I-5)** otros cambios incompatibles (el de I-4 ya va en el PR 6), con la etiqueta `cambio-incompatible` (como pide
   `docs/estado.md:388`).

En cada PR: `pnpm typecheck`, `pnpm lint`, `pnpm test`, integraciones contra Postgres local, `pnpm openapi:export`,
`pnpm openapi:lint` y `pnpm openapi:breaking` limpio (salvo el 6 y el 9, que llevan `cambio-incompatible`).

**Condición para el piloto:** no abrir piloto con locales reales hasta que los PR 5 y 6 estén en producción: cierran
INC-04 (el canje de preorden no registra pago) e INC-01 (validar mesa descuenta a todos los miembros).

### H.2 Cómo se avisa a frontend

- Cada PR actualiza `docs/api-contrato.md` (campos, ejemplos y una sección "Novedades" con fecha) y `docs/openapi.json`;
  el job `contrato` de CI confirma que no hay cambios incompatibles.
- Lo nuevo es opt-in (`cobro`, `items`, `paraLlevar` por línea): el frontend lo adopta cuando quiera; sin mandarlo,
  todo responde como hoy más campos nuevos. Excepciones: los cambios de comportamiento de abajo y `aplicarSeleccion`,
  que desde el PR 6 es `true` por defecto (I-4).
- Los **cambios de comportamiento** se anuncian con al menos un PR de anticipación. Casos de G con "antes / después":

  | Caso | Flujo  | Antes                                                              | Después                                                                         |
  | ---- | ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
  | 13   | POS    | Plato a la carta con `paraLlevar`: total 600, sin recargo          | Total 625: recargo 25 por D2 (PR 7)                                             |
  | 18   | QR     | Llevar con plan OK: recargo solo guardado, no se cobra, sin cuenta | Cuenta `ABIERTA` automática con saldo 25 (o `COBRADA` si mandan `cobro`) (PR 5) |
  | 20   | QR     | Llevar, `DIA_NO_VALIDO`: almuerzo y recargo sin cobro registrado   | Cuenta `ABIERTA` con saldo 375 (almuerzo 350 + recargo 25) (PR 5)               |
  | 21   | QR     | `items` no existe; recargo no se cobra                             | Cuenta con B, C, E y recargo 50: saldo 825 (PR 5)                               |
  | 49   | Pedido | Total 625 (recargo solo al almuerzo)                               | Total 1000 en el ejemplo: +25 por D2 al plato a la carta (PR 7)                 |

  También cambian: pedido solo de carta sin menú publicado y agotados de carta en pedidos (si se acepta I-9).

- `docs/mesas-flujo.md` se actualiza en el PR 6 (cierra las dudas 1, 8 y 12 de su sección 10).

---

## I. Decisiones para Oe

| #    | Decisión                                                                      | Recomendación                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Costo                                                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-1  | ¿`EXTRA` y `BEBIDA` pagan recargo para llevar?                                | **No.** (1) El recargo paga el envase del plato servido; un extra (aguacate, huevo) va en la tarrina del almuerzo y una bebida embotellada no usa envase del local. (2) En compras chicas es desproporcionado: 25 sobre una cola de 100 es 25 %. (3) Es lo que pasa hoy en pedidos y POS (`src/orders/orders.ts:344`, `src/checkout/pos.ts:143-151`): cero cambio para el frontend. (4) Si un local lo necesita (jugo en vaso desechable), se agrega después sin romper nada con una marca por plato (`plato.cobra_recargo_llevar`). | El local que sirve bebidas preparadas en vaso desechable no cobra ese envase hasta tener la marca por plato. Decir "sí" cambiaría precios de pedidos actuales y obligaría a avisar a todos.                                                                                                                                |
| I-2  | ¿Quién paga el recargo en `INVITO_YO`?                                        | **El anfitrión**: el recargo va con la línea y la línea es del anfitrión. Una sola cuenta por mesa.                                                                                                                                                                                                                                                                                                                                                                                                                                  | Ninguno técnico. La alternativa (el invitado paga su recargo) obliga a abrir una cuenta por invitado y rompe la idea de "invito yo".                                                                                                                                                                                       |
| I-3  | Plan del anfitrión que no alcanza para toda la mesa (`INVITO_YO`)             | **El anfitrión paga el resto a precio suelto** en su cuenta; se cubren primero el anfitrión y luego los invitados por orden de llegada. La vista previa (app y caja) avisa `PLAN_NO_ALCANZA` con el monto estimado antes de llegar.                                                                                                                                                                                                                                                                                                  | El anfitrión puede sorprenderse en caja si no mira la app. Alternativas: que cada invitado no cubierto pague lo suyo (cuentas extra y contradice D6) o bloquear la validación (mala experiencia en caja).                                                                                                                  |
| I-4  | ¿Cuándo `aplicarSeleccion` pasa a ser el comportamiento por defecto?          | **Que sea `true` por defecto ya en el PR 6**, con la etiqueta `cambio-incompatible`, porque aún no hay usuarios reales. Miembro **sin** selección = 1 almuerzo (como hoy).                                                                                                                                                                                                                                                                                                                                                           | Una caja que no mande el flag recibe el comportamiento nuevo (cuentas por pagador, sin descuento a quien solo pidió bebida) sin haberlo pedido: es incompatible y se anuncia. Con locales reales habría que esperar un release de la app de caja.                                                                          |
| I-5  | ¿Bloquear `servir` con cuenta abierta en `ANTES_DE_SERVIR`?                   | Sí, en un PR posterior (409 `CUENTA_PENDIENTE` en `POST /v1/caja/pedidos/{id}/servir`), anunciado. En esta entrega solo se informa `debeCobrarseAntesDeServir`.                                                                                                                                                                                                                                                                                                                                                                      | Es un error nuevo en un endpoint existente (incompatible). Sin él, `momentoCobro` solo lo hace cumplir el frontend.                                                                                                                                                                                                        |
| I-6  | Oferta que deja de valer entre pedir y canjear                                | **409 `SALDO_CAMBIO` sin descontar el plan ni cobrar** si el saldo final difiere de `orden_cabecera.total_centavos` (la estimada guardada al pedir; sin columna nueva), sea por oferta caída, plan sin saldo o día no válido. La caja ve el saldo nuevo (y los avisos) y reenvía con `cobro.saldoEsperadoCentavos` igual a ese saldo: confirmación explícita. Recién ahí se recotiza sin la oferta (plan o precio normal) y se canjea.                                                                                               | Un paso más en caja cuando la oferta cae (reenviar con el saldo nuevo); a cambio, nunca se consume un almuerzo del plan ni se cobra un monto distinto sin que la caja lo vea. Sin este paso habría que apoyarse en el deshacer de 10 s. No requiere columna nueva: la referencia es `orden_cabecera.total_centavos` (F.2). |
| I-7  | ¿Reservar stock de la oferta al preordenar?                                   | **No**: el stock se toma al canjear (primero que llega a caja).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | El comensal puede perder la oferta en los 30 min. Reservar obliga a liberar stock al vencer/cancelar (un job más y otra fuente de errores).                                                                                                                                                                                |
| I-8  | Almuerzo parcial (`precio_solo_sopa`, `precio_solo_segundo`, INC-19)          | Fuera de esta entrega; el almuerzo vale P sin importar cuántas secciones lleve (como hoy). Definir después si el plan cubre un almuerzo parcial como 1 unidad.                                                                                                                                                                                                                                                                                                                                                                       | El local que vende "solo sopa" sigue cobrándola como almuerzo completo en la app (o la vende por POS como `LIBRE`).                                                                                                                                                                                                        |
| I-9  | Alinear pedidos y POS con precio del día y agotados de carta (INC-09, INC-10) | Pedidos: mirar también `plato.agotado_en` (corrige un hueco). POS: usar el precio del día; **no** bloquear por agotado (la caja ve la cocina), solo avisar.                                                                                                                                                                                                                                                                                                                                                                          | Un pedido que hoy pasa con un plato de carta agotado pasaría a 409 `PLATO_AGOTADO`; el POS podría cobrar distinto si el dueño puso precio del día. Ambos se anuncian.                                                                                                                                                      |
| I-10 | `DUPLICADO` y `LIMITE_SAAS` en la cuenta (INC-13)                             | No cobrar esa unidad (omitida con aviso), en QR y en mesa.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Con `LIMITE_SAAS` el local sirve ese almuerzo sin descontarlo hasta regularizar su plan Bocadoo; cobrarle al comensal lo que ya prepagó es peor.                                                                                                                                                                           |
| I-11 | Reclamo devuelto y recargo                                                    | El reclamo devuelve el almuerzo al plan y no toca la cuenta (el envase se usó).                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Si producto quiere devolver también el recargo, hace falta un reverso parcial de pago, que hoy la base no permite (un solo reverso por pago, `baseline:697`).                                                                                                                                                              |
| I-12 | Almuerzo con P = 0 (INC-20)                                                   | 409 `ALMUERZO_SIN_PRECIO` en todos los flujos que cobran el almuerzo en caja.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | En la preorden es un error nuevo (hoy lo da gratis): incompatible, aunque un local `ACTIVO` no puede tener P = 0 (`src/restaurant/restaurant.service.ts:191`).                                                                                                                                                             |
| I-13 | `PAUSADO` y menú publicado en caja (INC-15, INC-16)                           | Caja nunca bloquea por `PAUSADO` (lo ya creado se atiende); mantener el 409 del canje de oferta por compatibilidad hasta decidir. Validar mesa: no exigir menú publicado (mismo criterio que el canje de preorden).                                                                                                                                                                                                                                                                                                                  | Quitar el 409 de ofertas o exigir menú en mesas son cambios de comportamiento.                                                                                                                                                                                                                                             |
| I-14 | Pagos parciales y varios métodos en una cuenta                                | Permitirlos (`montoCentavos` ≤ saldo); la cuenta pasa a `COBRADA` al llegar a 0. Anular revierte cada pago con su único reverso.                                                                                                                                                                                                                                                                                                                                                                                                     | Más pagos por cuenta en el arqueo. Alternativa: un pago por cuenta (más simple, pero no sirve para "mitad efectivo, mitad transferencia").                                                                                                                                                                                 |
| I-15 | Cuentas abiertas al cerrar la caja                                            | Informar (`cuentasAbiertas`), no bloquear el cierre.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Pueden quedar deudas sin cobrar; bloquear impediría cerrar el día por un comensal que se fue.                                                                                                                                                                                                                              |

---

## Verificación hecha sobre este documento

- Matriz C contra las decisiones: el recargo solo aparece en `ALMUERZO`, `A_LA_CARTA` y ofertas con esa base (D2, I-1);
  el plan solo cubre `ALMUERZO` (D5); toda fila `OFERTA` ignora el plan (D4); `paraLlevar` por línea solo en POS (D3);
  `INVITO_YO` cobra todo al anfitrión (D6).
- Fórmulas de B contra G: cada caso cumple `Tot = Sub + Rec` y `Saldo = Tot − Cub`, y `Cub = 350 × unidades PLAN`.
  En el caso 28 las cuentas suman el total de la mesa (450 + 425 + 375 + 600 = 1850; saldos 100 + 425 + 375 + 600 = 1500).
- Los casos 1, 2, 5, 11 y 24 reproducen exactamente lo que el código cobra hoy; los casos 13 y 49 muestran los únicos
  cambios de precio (D2).
