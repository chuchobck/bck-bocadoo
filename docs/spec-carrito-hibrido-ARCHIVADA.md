# [ARCHIVADA] Spec: Carrito híbrido (split-tender) + sincronización de carta en tiempo real

> Recibida de Chucho/frontend el 22 nov 2026, **antes** de que este backend tuviera construida la Entrega D (cuentas
> de cobro). Se archiva el 23 nov 2026: todo lo que pedía ya está cubierto, pero con una forma distinta a la que
> describía (`cuenta_cobro` en vez de columnas nuevas en `Pedido`/`PedidoItem`). Se deja el documento completo abajo
> como referencia histórica; el estado real de cada punto es:
>
> - **1.A** (`GET /v1/restaurantes/{slug}/carta`): ya existe desde la entrega C ("carta fija"), con el header
>   anti-caché pedido. El campo `seccion` que le faltaba se agregó en el PR #52 (23 nov). El punto de "POSTRE con
>   `precioCentavos > 0`" no aplica tal cual: `categoria` es un enum (`ALMUERZO`/`A_LA_CARTA`/`EXTRA`/`BEBIDA`) y
>   `seccion` (`POSTRE` entre otras) solo tiene sentido dentro de `ALMUERZO`; un postre que se vende suelto se crea
>   como `EXTRA`, que la carta ya incluye.
> - **1.B** (`POST`/`PATCH /v1/menu/platos`): ya aceptaba y persistía categoría, precio y `agotado` antes de esta
>   spec; no hizo falta ningún cambio.
> - **2** (columnas nuevas en `Pedido`/`PedidoItem`): **no se implementó así**. La Entrega D resolvió lo mismo con
>   `cuenta_cobro` + `cuenta_cobro_linea` (ver `docs/spec-cobros.md`): un libro de solo-inserción por pagador, en vez
>   de columnas sueltas en la cabecera del pedido. `cash_to_collect_cents` ↔ `cuenta.saldoCentavos`;
>   `plan_credits_used` se deriva de las líneas con `fuente: 'PLAN'`; `balance_payment_channel` no se construyó
>   (todavía no hay canal digital de cobro del saldo, solo caja).
> - **3** (`POST /v1/mis/pedidos` con almuerzo + carta mezclados): implementado tal cual se pedía (`dto.almuerzo` +
>   `dto.cartaItems` en la misma petición, ver `src/orders/orders.ts`), solo que el cobro resultante se resuelve con
>   `cotizar()`/`cuenta_cobro` en vez de las columnas de la sección 2.
>
> Para trabajo nuevo en este tema, usar `docs/spec-cobros.md` y `ESTADO_BACKEND.md`, no este documento.

---

## 1. Catálogo y sincronización en tiempo real (dueño ↔ comensal)

### A. Exponer carta y extras al comensal — `GET /v1/restaurantes/{slug}/carta`

- Debe devolver **todos** los platos activos (`activo = true`) del restaurante cuyas categorías sean:
  - `A_LA_CARTA`
  - `BEBIDA`
  - `EXTRA`
  - `POSTRE` cuando tenga `precioCentavos > 0` (o `categoria = EXTRA` con `seccion = POSTRE`)
- **Importante:** no exigir ningún flag extra de "carta publicada" distinto de tener ítems activos en el catálogo.
- **Anti-caché:** cabecera `Cache-Control: no-store, no-cache, must-revalidate` en este endpoint, para que el comensal nunca lea una caché vieja al abrir el modal de menú.
- **Payload por ítem:**
  ```json
  {
    "id": "uuid",
    "nombre": "Churrasco",
    "descripcion": "Con huevo, arroz y papas",
    "categoria": "A_LA_CARTA",
    "seccion": "PLATOS_FUERTES",
    "precioCentavos": 550,
    "fotoUrl": "https://...",
    "orden": 1,
    "agotado": false
  }
  ```
  (El cliente móvil acepta tanto un array directo `[...]` como `{ "items": [...] }`.)

### B. Gestión permanente del dueño — `GET /v1/menu/platos`, `POST /v1/menu/platos`, `PATCH /v1/menu/platos/{id}`

- Confirmar que `POST`/`PATCH` acepten y persistan las categorías `A_LA_CARTA`, `BEBIDA`, `POSTRE` y `EXTRA`, actualicen `precioCentavos` y `agotado` (bool), y devuelvan el objeto con su `id` real.
- Permitir que el dueño consulte todos sus ítems permanentes (`agotado: false` y `agotado: true`) para gestionar su carta y bebidas desde su panel.

## 2. Cambios de base de datos (`Pedido` y `PedidoItem` — esquema split-tender)

En **`Pedido`** (`orden_cabecera`), agregar:

- `plan_credits_used` / `planCreditsUsed` (`int`, default `0`): cupos de plan prepago descontados en esta orden (`1` si incluye el almuerzo del día cubierto por plan, `0` si no).
- `cash_to_collect_cents` / `cashToCollectCents` (`int`, default `0`): saldo restante en centavos a cobrar en caja al llegar (carta + extras + recargo para llevar + almuerzo suelto si no usa plan).
- `balance_payment_channel` / `balancePaymentChannel` (enum `'CAJA_LOCAL' | 'DEUNA' | 'WALLET'`, default `'CAJA_LOCAL'`): deja lista la estructura para Deuna en un sprint posterior.

En **`PedidoItem`** (líneas de detalle), guardar:

- `plato_id` / `platoId` (UUID)
- `cantidad` (int)
- `precio_unitario_centavos` / `precioUnitarioCentavos` (int)
- `cubierto_por_plan` / `cubiertoPorPlan` (bool: `true` para los platos del almuerzo del día cubiertos por el cupo, `false` para carta y extras).

## 3. Contrato de creación de orden mixta — `POST /v1/mis/pedidos`

Aceptar en una misma transacción: solo menú del día, solo carta/extras, o ambos combinados:

```json
{
  "restaurante": "<restaurantId>",
  "paraLlevar": false,
  "horaLlegada": "2026-11-22T18:00:00Z",
  "almuerzo": { "platos": ["<sopaId>", "<fuerteId>"] },
  "cartaItems": [{ "platoId": "<cartaOExtraId>", "cantidad": 2 }]
}
```

- `horaLlegada` en ISO-8601 UTC.
- `almuerzo` y `cartaItems` son opcionales individualmente, pero el request debe traer al menos uno con ítems.

## Notas de encaje con lo que ya existe (a revisar al implementar)

- Esta spec llega **antes** de leer `docs/spec-cobros.md` (entrega D) a fondo: puede chocar o solaparse con el módulo `src/billing/cotizar.ts` y `src/cobro/aplicar.ts` que ya cobran carta, extras y recargo en pedidos y mesas. Antes de programar, comparar con la Entrega D (sobre todo el PR 7, que toca justamente "carta y ofertas en pedidos") para no duplicar o contradecir la regla de cobro ya construida.
- `GET /v1/restaurantes/{slug}/carta` ya existe (entrega C, "carta fija"); revisar si ya cumple A o si falta ajustar categorías/cabecera de caché.
- El pago en el mismo paso (Deuna/wallet) no existe todavía como canal — por ahora solo se deja la columna `balance_payment_channel` lista, sin lógica de cobro digital.
