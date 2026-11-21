# Contrato de API para frontend

Contrato de la API de Bocadoo (backend NestJS). **Todo lo que dice este documento sale del código y de respuestas reales de la API**; si algo no está aquí, no está garantizado.

- Contrato máquina-legible: [`docs/openapi.json`](./openapi.json) (el mismo documento que sirve `GET /docs-json`). Se regenera con `pnpm openapi:export` y una prueba (`test/unit/openapi.spec.ts`) falla si el archivo quedó desactualizado respecto del código.
- Este archivo explica lo que el OpenAPI no dice: convenciones, errores, flujos y estado de cada endpoint.
- Estado del plan y fases: [`docs/estado.md`](./estado.md). Modelo de amenazas: [`docs/seguridad.md`](./seguridad.md).

## Novedades

### Entrega D · PR 3: cotizaciones informativas (solo campos nuevos y un endpoint sin efectos)

Detalle de diseño en [`docs/spec-cobros.md`](./spec-cobros.md) (secciones B, E.2, E.3, E.5 y E.6). **Sin migraciones y sin cambios incompatibles**: ningún campo existente cambia de tipo ni de significado (`pnpm openapi:breaking` limpio). Todo lo nuevo es **informativo**: nada de esto cobra ni descuenta.

| Dónde                                                                                                                                        | Qué es nuevo                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /v1/mis/pedidos/cotizar` (**endpoint nuevo**)                                                                                          | `200` con la `Cotizacion`. Sin `Idempotency-Key`, no escribe nada.                         |
| `POST /v1/mis/pedidos`, `GET /v1/mis/pedidos`, `GET /v1/mis/pedidos/{id}`, `POST /v1/mis/pedidos/{id}/cancelar`                              | `cotizacion` (objeto `Cotizacion`)                                                         |
| `GET /v1/caja/pedidos`, `GET /v1/caja/pedidos/{id}`, `POST /v1/caja/pedidos/{id}/canjear` (en `pedido`), `POST /v1/caja/pedidos/{id}/servir` | `cotizacion` (objeto `Cotizacion`)                                                         |
| `GET /v1/mis/mesas`, `GET /v1/mis/mesas/{id}` (y las respuestas de crear, unirse, cancelar y `PUT …/seleccion`, que devuelven la misma mesa) | `miembros[].cotizacion` y `cotizacion` de la mesa (ambos pueden ser `null`, ver «Mesas»)   |
| `GET /v1/caja/mesas/{id}`                                                                                                                    | `miembros[].cotizacion` y `cotizacion` de la mesa                                          |
| `POST /v1/caja/mesas/{id}/validar`                                                                                                           | `cotizacion` y `miembros[].cotizacion` informativas (E.5): cada miembro con 1 almuerzo     |
| `GET /v1/caja/mesas/{id}`, `POST /v1/caja/mesas/{id}/validar`, `GET /v1/caja/pedidos` y `/{id}`                                              | **Cambio de valor** (mismo tipo): `cubiertos` y `almuerzosDisponibles` (INC-12, ver abajo) |

#### El objeto `Cotizacion`

Siempre `estimada: true` en esta entrega: es una estimación con el precio y el plan **de hoy**; el cobro real lo fija la caja (PR 4 y siguientes). Montos en centavos enteros.

```json
{
  "estimada": true,
  "lineas": [
    {
      "ref": "almuerzo#1",
      "personaRef": "0",
      "pagadorRef": "0",
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
    },
    {
      "ref": "extra:0",
      "personaRef": "0",
      "pagadorRef": "0",
      "tipo": "EXTRA",
      "nombre": "Huevo frito",
      "platoId": "df24243e-cc29-406a-94fd-fde6bf11d38e",
      "ofertaId": null,
      "cantidad": 2,
      "paraLlevar": true,
      "precioUnitarioCentavos": 75,
      "subtotalCentavos": 150,
      "recargoUnitarioCentavos": 0,
      "recargoCentavos": 0,
      "fuente": "CAJA",
      "pagador": "PROPIO",
      "cubiertoPorPlanCentavos": 0,
      "porCobrarCentavos": 150,
      "omitida": null
    }
  ],
  "porPagador": [{ "pagadorRef": "0", "subtotal": 500, "recargo": 25, "total": 525, "cubierto": 350, "saldo": 175 }],
  "subtotalCentavos": 500,
  "recargoCentavos": 25,
  "totalCentavos": 525,
  "cubiertoPorPlanCentavos": 350,
  "saldoPorCobrarCentavos": 175,
  "monedaCodigo": "USD",
  "avisos": []
}
```

- `totalCentavos = subtotalCentavos + recargoCentavos` y `saldoPorCobrarCentavos = totalCentavos − cubiertoPorPlanCentavos` (lo que se pagaría en caja).
- `fuente`: de dónde sale el precio de la línea (`PLAN` = lo cubre un almuerzo del plan, `CAJA` = precio normal; `OFERTA` llega en el PR 7). `pagador`: `PROPIO` o `ANFITRION` (mesa `INVITO_YO`).
- Cada almuerzo que cubre el plan es **su propia línea** de cantidad 1 con `ref` terminado en `#k` (`almuerzo#1`).
- El plan de hoy se lee con la misma condición que la caja: plan `ACTIVA`, `vence_el >= hoy` y hoy en `dias_validos`. Un plan sin saldo, vencido o en un día no válido no cubre: el almuerzo se cobra a precio suelto.
- `avisos[]`: `{ codigo, lineaRef }` (`PLAN_NO_ALCANZA`, `PLATO_AGOTADO`). `DUPLICADO` y `LIMITE_SAAS` no se estiman en esta entrega (dependen de lo que pase en caja).
- `unidadesPlan` (lo que descontará la caja) es interno y **no** se expone.

#### `POST /v1/mis/pedidos/cotizar`

Mismo cuerpo y mismas validaciones que `POST /v1/mis/pedidos` (almuerzo y extras del menú de hoy, `paraLlevar`), pero **sin `Idempotency-Key` y sin efectos**: no crea el pedido, no toma número del día y no toca el plan. Para mostrar el total antes de pedir. Carta y ofertas llegan en el PR 7.

```json
{
  "restaurante": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "paraLlevar": true,
  "almuerzo": { "platos": ["41c0703f-3521-48eb-98ec-6d6d8efd5979"] },
  "extras": [{ "plato": "df24243e-cc29-406a-94fd-fde6bf11d38e", "cantidad": 2 }]
}
```

→ `200` con la `Cotizacion` de arriba (comensal con un plan que vale hoy). Errores: los de crear pedido (`PEDIDO_VACIO`, `ALMUERZO_INVALIDO`, `RESTAURANTE_NO_ENCONTRADO`, `RESTAURANTE_PAUSADO`, `LOCAL_LLENO_SOLO_LLEVAR`, `MENU_NO_PUBLICADO`, `PEDIDO_ACTIVO`, `PLATO_AGOTADO`, `PLATO_NO_DISPONIBLE`, `PLATO_SIN_PRECIO`) y 409 `ALMUERZO_SIN_PRECIO` (local con almuerzo en 0 y sin plan; no puede pasar en un local `ACTIVO`). Sin token, 401.

#### Pedidos: `cotizacion` y su relación con `totalCentavos`

- **`totalCentavos`, `recargoLlevarCentavos` y `almuerzo.precioCentavos` siguen con la regla de hoy** (sin cambios).
- Para un pedido ya creado todavía no existe el snapshot del precio del almuerzo: se toma `subtotal − extras`. Un almuerzo guardado en 0 (lo cubrió el plan al pedir) se muestra como `PLAN` con precio 0, así que `subtotalCentavos`, `totalCentavos` y `cubiertoPorPlanCentavos` de ese pedido son menores que los de `POST /v1/mis/pedidos/cotizar` por el precio del almuerzo; `saldoPorCobrarCentavos` es el mismo.
- La cotización de un pedido se recalcula en cada lectura con el plan de **hoy** del comensal (si el pedido se guardó con el almuerzo cobrado y después el comensal compra un plan, la cotización lo cubrirá; `totalCentavos` no cambia).
- **Diferencia conocida, cambia en el PR 7:** si un extra del menú es un plato `A_LA_CARTA` (o un plato `ALMUERZO` con precio pedido como extra cuya sección es `SOPA` o `FUERTE`; un `JUGO` cuenta como bebida y un `POSTRE` como extra y no pagan recargo) y el pedido es `paraLlevar`, la cotización suma el recargo **por unidad** (decisión D2) y `totalCentavos` aún no. Ejemplo: almuerzo + 1 plato a la carta de 600 para llevar, sin plan → `totalCentavos` 975 (`recargoLlevarCentavos` 25) y `cotizacion.saldoPorCobrarCentavos` 1000 (`recargoCentavos` 50). Hasta el PR 7 el frontend debe mostrar `totalCentavos` como lo que se paga; la `cotizacion` es informativa.

#### Qué debe hacer frontend con esto

- **`miembros[].cotizacion` puede ser `null` en `GET /v1/mis/mesas*` (a).** No es un error ni «sin datos»: el comensal solo puede leer su propio plan, así que no se puede calcular una cotización cuyo pagador es otra persona. `CADA_UNO`: el anfitrión ve la suya y los invitados `null` (la `cotizacion` de la mesa también `null` si hay más miembros); `INVITO_YO`: el anfitrión ve todo, un invitado todo `null`. La caja (`GET /v1/caja/mesas/{id}`) siempre ve todo. Se completará en el PR 4 con una función de base que dé solo los almuerzos disponibles del pagador. Mostrar «—» o esconder el monto cuando sea `null`.
- **Cotización de un pedido ya creado (b).** Mientras no exista el snapshot del precio (PR 4), el único valor confiable es **`cotizacion.saldoPorCobrarCentavos`**. `subtotalCentavos`, `totalCentavos` y `cubiertoPorPlanCentavos` de un pedido creado pueden ser menores que los de `POST /v1/mis/pedidos/cotizar` (un almuerzo cubierto por plan se guardó en 0) y no deben mostrarse como desglose.
- **Diferencia con `totalCentavos` (c).** Un plato a la carta (o `SOPA`/`FUERTE` suelto) para llevar suma recargo por unidad en la cotización y no en `totalCentavos`; **cambia en el PR 7**. Hasta entonces, lo que se paga es `totalCentavos`.

#### Mesas: `cotizacion` y visibilidad

- Cada `miembros[].cotizacion` cotiza lo que eligió el miembro (`seleccion`); **sin selección cuenta como 1 almuerzo**. Usa su `paraLlevar`. En `INVITO_YO` paga el anfitrión (su plan cubre primero al anfitrión y luego a los invitados por orden de llegada; `PLAN_NO_ALCANZA` si no alcanza); en `CADA_UNO`, cada quien con su plan.
- **Misma visibilidad que `seleccion`**: el anfitrión y la caja ven la de todos; un invitado solo la suya (las demás vienen `null`). La `cotizacion` de la **mesa** es solo para el anfitrión y la caja (`null` para un invitado).
- **Limitación de la API del comensal (RLS):** un comensal solo puede leer **su propio plan**. Por eso, en `GET /v1/mis/mesas*`, una cotización cuyo plan de pagador no es suyo viene `null`: en `CADA_UNO` el anfitrión ve la suya pero las de los invitados salen `null` (y la de la mesa también si hay otros miembros); en `INVITO_YO` el anfitrión sí ve todas y la de la mesa, pero un invitado ve todo `null` (paga el plan del anfitrión). La caja (`GET /v1/caja/mesas/{id}`) ve todas. No se inventa un plan: resolverlo requiere una función de base con permisos propios (migración), fuera de este PR.
- Un plato de la selección agotado hoy queda `omitida: "PLATO_AGOTADO"` (no se cobra) con su aviso; un almuerzo con un plato agotado solo avisa.
- Tras validar la mesa (el plan ya se descontó), la caja reconstruye la cotización sumando lo que se descontó en esa mesa; la vista del comensal usa el plan actual.

#### `POST /v1/caja/mesas/{id}/validar`: cotización informativa

Agrega `cotizacion` y `miembros[].cotizacion` con **cada miembro con 1 almuerzo y su `paraLlevar`** (E.5, sin extras ni la selección), calculados con el plan de **antes** de descontar. No cambia los descuentos, `descontados`, `porCobrar` ni `resultados`. En el reintento (`yaValidada: true`) se reconstruye con lo descontado en la mesa.

#### INC-12: `cubiertos` y `almuerzosDisponibles` cuentan `dias_validos` (cambio de valor, mismo tipo)

`cubiertos` y `miembros[].almuerzosDisponibles` (`GET /v1/caja/mesas/{id}` y `POST …/validar`) y `cliente.almuerzosDisponibles` (`GET /v1/caja/pedidos` y `/{id}`) ahora suman solo los planes que valen hoy: `ACTIVA`, `vence_el >= hoy` **y hoy dentro de `dias_validos`**. Antes un plan en un día no válido contaba saldo y la caja veía «cubierto» para después recibir `DIA_NO_VALIDO`. El tipo no cambia (entero); el número es más exacto: un cliente con plan en un día no válido pasa de `N` a `0`. `GET /v1/mis/consumos` y el saldo del plan **no** cambian.

## 1. Convenciones

### 1.1 URL base y prefijo

- Todas las rutas de negocio cuelgan de `/v1`. Fuera del prefijo solo están `GET /health` y `GET /health/ready`.
- La URL base del despliegue **no está definida todavía** (el despliegue en Render está pendiente, ver `docs/estado.md`). El frontend debe leerla de su configuración. En local, la API escucha en `PORT` (3000 por defecto).
- Swagger UI en `/docs` y el JSON en `/docs-json`: encendidos salvo en producción (o si `SWAGGER_ENABLED=true`). Por eso este repositorio versiona `docs/openapi.json`.
- CORS: solo los orígenes listados en `CORS_ORIGINS` (por defecto `http://localhost:3001`). Métodos `GET, POST, PUT, PATCH, DELETE, OPTIONS`. Cabeceras permitidas: `authorization`, `content-type`, `x-restaurant-id`, `idempotency-key`, `x-request-id`. Cabeceras legibles desde JavaScript: `x-request-id`, `retry-after`.
- Cuerpo máximo: 100 KB (413 `PAYLOAD_TOO_LARGE`).

### 1.2 Autenticación

Todo endpoint exige `Authorization: Bearer <accessToken>` salvo los marcados como **Público** en la referencia (registro, login, refresh, logout, vitrina y salud).

- **Registro** (`POST /v1/auth/register` o `/v1/auth/register-owner`): responde 201 con el usuario y **no devuelve tokens**. Hay que llamar a login después.
- **Login** (`POST /v1/auth/login` con `identificador` —correo o nombre de usuario— y `password`): devuelve `accessToken`, `refreshToken`, `tokenType: "Bearer"`, `expiresIn` (segundos) y `usuario`.
- **Access token:** JWT firmado con **ES256**, vida corta (900 s = 15 min por defecto; usa `expiresIn`, no lo des por fijo). No dependas del contenido del JWT: para saber quién es la persona y en qué locales trabaja, llama a `GET /v1/auth/me`.
- **Refresh token:** opaco (43 caracteres), vive 30 días por defecto y **sirve una sola vez**. `POST /v1/auth/refresh` con `{ "refreshToken" }` devuelve un par nuevo (access + refresh); el refresh anterior queda inservible.
- **Si el refresh falla** (siempre 401 `UNAUTHORIZED`, "Sesión inválida o expirada."; ocurre con un token vencido, ya usado, de una sesión cerrada o de un usuario desactivado): la sesión terminó. El cliente debe **borrar ambos tokens y llevar a la pantalla de login**. No reintentar con el mismo token.
- **Regla de oro del refresh:** reusar un refresh token ya rotado se trata como robo y **revoca toda la sesión**, incluido el token nuevo. Por eso el cliente debe:
  1. hacer **un solo refresh a la vez** (si varias peticiones reciben 401 a la vez, que esperen al mismo refresh);
  2. **guardar el refresh token nuevo antes** de reintentar nada;
  3. reintentar la petición original **una sola vez** con el access token nuevo.
- **Cuándo refrescar:** al recibir 401 en un endpoint protegido (o poco antes de que pase `expiresIn`). Ojo: un 401 en `POST /v1/auth/login` significa credenciales inválidas, no token vencido.
- **Logout:** `POST /v1/auth/logout` con `{ "refreshToken" }` cierra ese dispositivo (204, idempotente). `POST /v1/auth/logout-all` (con Bearer) cierra todos (204). Un access token ya emitido sigue valiendo hasta que vence.

### 1.3 Roles y restaurante activo (`x-restaurant-id`)

- **Comensal:** cualquier usuario con sesión. Sus endpoints (`/v1/mis/*`, `/v1/pase`, `/v1/mesas/invitacion/*`, …) **no llevan** `x-restaurant-id`: solo ven lo suyo.
- **Personal** (`DUENO` y `CAJERO`): sus endpoints exigen además `x-restaurant-id: <uuid>`, que es el `id` de un restaurante de `GET /v1/auth/me` → `restaurantes[]`. Una misma persona puede trabajar en varios locales (el frontend debe dejar elegir) y ser comensal a la vez.
- Respuestas de acceso, en este orden: sin token → **401**; sin `x-restaurant-id` o que no es UUID → **400**; el usuario no trabaja ahí (o el local no existe, o la persona está desactivada) → **403** `FORBIDDEN` "No tienes acceso a este restaurante."; rol insuficiente → **403** `FORBIDDEN` "Tu rol no permite esta acción.".
- Dueño puede todo lo del cajero; el cajero no edita catálogo, perfil, personal ni planes, no ve la bandeja de opiniones ni cierra caja de días pasados.

### 1.4 Errores (`application/problem+json`, RFC 9457)

Todo error (también los de validación y los de rutas inexistentes) tiene esta forma:

```json
{
  "type": "about:blank",
  "title": "CONFLICT",
  "status": 409,
  "code": "PEDIDO_ACTIVO",
  "detail": "Ya tienes un pedido en camino a este restaurante.",
  "instance": "/v1/mis/pedidos",
  "requestId": "6b1f7a52-9e0f-4d3b-8f19-2f1d0c8d6a11"
}
```

- Decide por **`code`** (y el status HTTP), nunca por `detail`: el texto está en español pensado para mostrarse, pero puede cambiar. Los mensajes de validación de campos (400 `BAD_REQUEST`) los genera el validador, vienen unidos con `; ` y algunos están en inglés.
- Los DTO son estrictos: **un campo no declarado da 400** (`property x should not exist`).
- `requestId` es el mismo valor de la cabecera `x-request-id`: guárdalo y muéstralo en "contactar soporte".
- 5xx: `code: "ERROR_INTERNO"` y un `detail` genérico (nunca se filtran detalles internos). `GET /health/ready` responde 503 si la base no contesta.
- **Códigos genéricos** (el nombre del estado HTTP), usados por las fases 1–7 y por validación y seguridad: `BAD_REQUEST` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404 (también ruta inexistente), `CONFLICT` 409, `PAYLOAD_TOO_LARGE` 413, `TOO_MANY_REQUESTS` 429, `SERVICE_UNAVAILABLE` 503. En los módulos de las fases 5–7 un mismo `CONFLICT` o `NOT_FOUND` tiene varios significados: ahí solo el `detail` los distingue (ver "Errores propios del módulo" en cada sección). Es una limitación conocida, ver la sección Estado.
- Algunos errores de base de datos se traducen: violación de unicidad → 409 "Ya existe un registro con esos datos."; referencia rota → 409; valor fuera de rango o mal formado → 400 "Algún dato tiene un valor no permitido."; permiso denegado por RLS → 403.

**Códigos de negocio estables** (los de la fase 8 más `IDEMPOTENCY_KEY_INVALIDA`; salen de la declaración de cada endpoint y están verificados contra el código):

| Código                        | HTTP | Dónde puede aparecer                                                                                                       |
| ----------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `ALMUERZO_INVALIDO`           | 400  | `POST /v1/mis/pedidos`; `PUT /v1/mis/mesas/{id}/seleccion`                                                                 |
| `SELECCION_INVALIDA`          | 400  | `PUT /v1/mis/mesas/{id}/seleccion` (un plato del almuerzo repetido como plato suelto)                                      |
| `CURSOR_INVALIDO`             | 400  | `GET /v1/mis/consumos`; `GET /v1/mis/pedidos`; `GET /v1/opiniones`                                                         |
| `HORA_LLEGADA_INVALIDA`       | 400  | `POST /v1/mis/mesas`                                                                                                       |
| `IDEMPOTENCY_KEY_INVALIDA`    | 400  | `POST /v1/mis/consumos/{id}/opinion`; `POST /v1/mis/consumos/{id}/reclamo`; `POST /v1/mis/mesas` y 1 más                   |
| `OPINION_VACIA`               | 400  | `POST /v1/mis/consumos/{id}/opinion`                                                                                       |
| `PEDIDO_VACIO`                | 400  | `POST /v1/mis/pedidos`                                                                                                     |
| `SOLO_ANFITRION`              | 403  | `POST /v1/mis/mesas/{id}/cancelar`                                                                                         |
| `CLIENTE_NO_ENCONTRADO`       | 404  | `GET /v1/clientes/{id}/sellos`; `POST /v1/clientes/{id}/sellos/canjear`                                                    |
| `CONSUMO_NO_ENCONTRADO`       | 404  | `GET /v1/mis/consumos/{id}`; `POST /v1/mis/consumos/{id}/opinion`; `POST /v1/mis/consumos/{id}/opinion/descartar` y 1 más  |
| `MESA_NO_ENCONTRADA`          | 404  | `GET /v1/mesas/invitacion/{id}`; `GET /v1/mis/mesas/{id}`; `PUT /v1/mis/mesas/{id}/seleccion` y 2 más                      |
| `PLATO_NO_ENCONTRADO`         | 404  | `PATCH /v1/menu/platos/{id}/agotado`                                                                                       |
| `OPINION_NO_ENCONTRADA`       | 404  | `POST /v1/opiniones/{id}/responder`                                                                                        |
| `PEDIDO_NO_ENCONTRADO`        | 404  | `GET /v1/caja/pedidos/{id}`; `GET /v1/mis/pedidos/{id}`; `POST /v1/caja/pedidos/{id}/canjear` y 2 más                      |
| `RESTAURANTE_NO_ENCONTRADO`   | 404  | `GET /v1/pase`; `POST /v1/mis/mesas`; `POST /v1/mis/pedidos`; `GET /v1/restaurantes/{slug}/carta`                          |
| `TARJETA_NO_CONFIGURADA`      | 404  | `GET /v1/clientes/{id}/sellos`; `GET /v1/sellos/config`; `POST /v1/clientes/{id}/sellos/canjear`                           |
| `CONSUMO_REVERTIDO`           | 409  | `POST /v1/mis/consumos/{id}/opinion`; `POST /v1/mis/consumos/{id}/opinion/descartar`; `POST /v1/mis/consumos/{id}/reclamo` |
| `IDEMPOTENCY_KEY_REUTILIZADA` | 409  | `POST /v1/caja/pedidos/{id}/canjear`; `POST /v1/clientes/{id}/sellos/canjear`; `POST /v1/mis/mesas` y 1 más                |
| `LOCAL_LLENO_SOLO_LLEVAR`     | 409  | `POST /v1/mis/pedidos` (con `paraLlevar` ausente o `false` y el local `LLENO`)                                             |
| `MENU_NO_PUBLICADO`           | 409  | `POST /v1/mis/pedidos`; `GET /v1/pase/codigo`; `GET /v1/pase`; `POST /v1/caja/validar`; `PUT /v1/mis/mesas/{id}/seleccion` |
| `MESA_CERRADA`                | 409  | `POST /v1/mesas/invitacion/{id}/unirse`; `POST /v1/mis/mesas/{id}/cancelar`; `PUT /v1/mis/mesas/{id}/seleccion`            |
| `MESA_LLENA`                  | 409  | `POST /v1/mesas/invitacion/{id}/unirse`                                                                                    |
| `MESA_VENCIDA`                | 409  | `POST /v1/mesas/invitacion/{id}/unirse`                                                                                    |
| `OPINION_AUN_NO_DISPONIBLE`   | 409  | `POST /v1/mis/consumos/{id}/opinion`; `POST /v1/mis/consumos/{id}/opinion/descartar`                                       |
| `OPINION_VENCIDA`             | 409  | `POST /v1/mis/consumos/{id}/opinion`; `POST /v1/mis/consumos/{id}/opinion/descartar`                                       |
| `OPINION_YA_ENVIADA`          | 409  | `POST /v1/mis/consumos/{id}/opinion`; `POST /v1/mis/consumos/{id}/opinion/descartar`                                       |
| `OPINION_YA_RESPONDIDA`       | 409  | `POST /v1/opiniones/{id}/responder`                                                                                        |
| `RESTAURANTE_PAUSADO`         | 409  | `POST /v1/mis/pedidos`; `POST /v1/mis/mesas`; `POST /v1/ofertas/{id}/canjear`; `PUT /v1/mis/mesas/{id}/seleccion`          |
| `PEDIDO_ACTIVO`               | 409  | `POST /v1/mis/pedidos`                                                                                                     |
| `PEDIDO_CANCELADO`            | 409  | `POST /v1/caja/pedidos/{id}/canjear`                                                                                       |
| `PEDIDO_EXPIRADO`             | 409  | `POST /v1/caja/pedidos/{id}/canjear`; `POST /v1/mis/pedidos/{id}/cancelar`                                                 |
| `PEDIDO_NO_CANCELABLE`        | 409  | `POST /v1/mis/pedidos/{id}/cancelar`                                                                                       |
| `PEDIDO_NO_CANJEADO`          | 409  | `POST /v1/caja/pedidos/{id}/servir`                                                                                        |
| `PLATO_AGOTADO`               | 409  | `POST /v1/mis/pedidos`; `PUT /v1/mis/mesas/{id}/seleccion`                                                                 |
| `RECLAMO_VENCIDO`             | 409  | `POST /v1/mis/consumos/{id}/reclamo`                                                                                       |
| `RECLAMO_YA_EXISTE`           | 409  | `POST /v1/mis/consumos/{id}/reclamo`                                                                                       |
| `RESTAURANTE_NO_DISPONIBLE`   | 409  | `POST /v1/mesas/invitacion/{id}/unirse`; `PUT /v1/mis/mesas/{id}/seleccion`                                                |
| `SIN_PREMIOS`                 | 409  | `POST /v1/clientes/{id}/sellos/canjear`                                                                                    |
| `PLATO_NO_DISPONIBLE`         | 422  | `POST /v1/mis/pedidos`; `PUT /v1/mis/mesas/{id}/seleccion`                                                                 |
| `PLATO_NO_ES_DE_CARTA`        | 422  | `PATCH /v1/menu/platos/{id}/agotado` (el plato es de ALMUERZO: se agota en el menú del día)                                |
| `PLATO_SIN_PRECIO`            | 422  | `POST /v1/mis/pedidos`; `PUT /v1/mis/mesas/{id}/seleccion`                                                                 |

Resultados del escáner de caja: **no son errores**. `POST /v1/caja/validar` responde 200 con `resultado` ∈ `OK`, `OK_ADVERTENCIA`, `DUPLICADO`, `SIN_PLAN`, `SIN_SALDO`, `VENCIDO`, `DIA_NO_VALIDO`, `OTRO_LOCAL`, `QR_EXPIRADO`, `QR_INVALIDO`, `LIMITE_SAAS`.

### 1.5 Idempotency-Key

- Cabecera `Idempotency-Key: <UUID>` **obligatoria** en los POST que crean o cobran algo (lista abajo). Falta o no es UUID → 400 `IDEMPOTENCY_KEY_INVALIDA`.
- Genera **un UUID por intención del usuario** (un toque en "Pedir", un escaneo) y **reutilízalo en los reintentos** de esa misma operación (corte de red, doble toque). No generes uno nuevo al reintentar.
- Repetir la misma petición con la misma clave devuelve el **mismo resultado** (mismo status y mismo recurso) sin duplicar el cobro o el recurso. Verificado con pedidos, venta de plan y validación de caja (en la repetición de `validar` algún campo derivado, como `diasParaVencer`, puede venir `null`).
- La misma clave usada para **otro** recurso u otro cliente → 409: `IDEMPOTENCY_KEY_REUTILIZADA` en pedidos, mesas y canje de sellos; `CONFLICT` genérico con `detail` en las ventas y la caja de las fases 6–7.
- Repetir una acción de negocio que ya ocurrió con **otra** clave no es un reintento y da su propio 409 (`PEDIDO_ACTIVO`, `OPINION_YA_ENVIADA`, `RECLAMO_YA_EXISTE`, `SIN_PREMIOS`…).
- Los demás POST/PATCH/PUT no llevan la cabecera (crear platos, planes o clientes, publicar menú, activar local…): protégelos con deshabilitar el botón mientras se envían.

Endpoints que la exigen:

- `POST /v1/clientes/{id}/planes`
- `POST /v1/planes-vendidos/{id}/deshacer`
- `POST /v1/solicitudes-plan/{id}/cobrar`
- `POST /v1/caja/validar`
- `POST /v1/caja/mesas/{id}/validar`
- `POST /v1/caja/ventas`
- `POST /v1/caja/ventas/{id}/deshacer`
- `POST /v1/mis/consumos/{id}/reclamo`
- `POST /v1/mis/pedidos`
- `POST /v1/caja/pedidos/{id}/canjear`
- `POST /v1/mis/mesas`
- `POST /v1/mesas/invitacion/{id}/unirse`
- `POST /v1/mis/consumos/{id}/opinion`
- `POST /v1/mis/consumos/{id}/opinion/descartar`
- `POST /v1/clientes/{id}/sellos/canjear`

### 1.6 Paginación

- **Cursor opaco.** Query `limit` (1–50, **20 por defecto**) y `cursor`. La respuesta trae `{ "items": [...], "nextCursor": "..." }`; `nextCursor: null` significa que no hay más. Pásalo tal cual como `cursor` en la siguiente llamada. Un cursor inválido → 400 `CURSOR_INVALIDO` (fase 8) o `BAD_REQUEST` "cursor inválido." (fases 5–6).
- Paginados: `GET /v1/restaurantes`, `GET /v1/clientes`, `GET /v1/mis/consumos`, `GET /v1/mis/pedidos`, `GET /v1/opiniones`. Las demás listas devuelven un arreglo completo sin paginar.

### 1.7 Límites de uso (rate limits)

Por IP, en memoria de la instancia y **solo se enteran por el status 429** (no hay cabeceras `X-RateLimit-*`). Valores por defecto, configurables por variables de entorno:

| Alcance                                                                    | Límite                                              | Ventana    |
| -------------------------------------------------------------------------- | --------------------------------------------------- | ---------- |
| Todos los endpoints                                                        | 120 peticiones por IP                               | 1 minuto   |
| `POST /v1/auth/login`                                                      | 5 por IP y cuenta; 20 por cuenta desde cualquier IP | 15 minutos |
| `POST /v1/auth/register`, `/register-owner`                                | 10 por IP (compartido)                              | 1 hora     |
| `POST /v1/restaurante/personal/cajeros`, `POST /v1/clientes/{id}/vincular` | 20 por IP (compartido)                              | 1 hora     |

- El límite de login cuenta **todos** los intentos, no solo los fallidos.
- Respuesta: `429` `TOO_MANY_REQUESTS` con la cabecera **`retry-after`** (segundos). Espera ese tiempo; no reintentes en automático un login.

### 1.8 `x-request-id`

Cada respuesta (también los errores) trae `x-request-id`. Si el cliente manda su propio `x-request-id`, el servidor lo reutiliza; si no, genera un UUID. En los errores coincide con `requestId`.

### 1.9 Fechas, zona horaria y dinero

- **Instantes** (`creadoEn`, `expiraEn`, `horaLlegada`…): ISO 8601 en **UTC**, con milisegundos y `Z`: `2026-11-13T03:42:31.353Z`. En los cuerpos que reciben una hora (`horaLlegada`) se manda también ISO 8601 con zona.
- **Fechas de calendario** (`fecha`, `venceEl`, `fechaLocal`, `hoy`): `AAAA-MM-DD` en la **zona horaria del restaurante** (`zonaHoraria` del perfil, hoy `America/Guayaquil`), no la del dispositivo ni la del servidor. Cerca de la medianoche UTC la fecha local y la UTC difieren (el ejemplo del historial muestra `fecha` `2026-11-13T03:42Z` con `fechaLocal` `2026-11-12`).
- Las rutas con `{fecha}` (menú, cierre de caja) aceptan además la palabra **`hoy`**, resuelta con la zona del local. Una fecha inexistente (`2026-02-31`) → 400.
- **Horarios:** `abre`/`cierra` en `HH:MM` (hora local del restaurante); `diaSemana` ISO: **1 = lunes … 7 = domingo**. `diasValidos` de un plan usa la misma convención.
- **Dinero:** siempre **enteros en centavos** (`precioCentavos`, `totalCentavos`…) con `monedaCodigo` (`USD`). Nunca decimales.

### 1.10 Identificadores

- Hacia afuera salen **`public_id` (UUID)** de: usuarios, restaurantes, planes vendidos, pagos, consumos, ventas, pedidos, mesas compartidas y los platos del menú que ve el comensal.
- Dentro de un restaurante, las tablas administrativas usan **ids numéricos como texto** (`"166"`): plantillas de plan, clientes, solicitudes de plan, reclamos (lado del personal), platos y renglones de menú, mesas físicas. Solo valen dentro del `x-restaurant-id` en uso (la base lo hace cumplir con RLS). Trátalos como cadenas opacas.
- `slug` identifica al restaurante en la vitrina (`/v1/restaurantes/{slug}`).

### 1.11 Cuerpos de las peticiones

- JSON con `content-type: application/json`. **Un POST sin cuerpo no debe llevar `content-type: application/json`**: el servidor responde 400 "Body cannot be empty…". Ajusta el cliente HTTP para no enviar ese header cuando no hay cuerpo.
- Un JSON mal formado → 400.

## 2. Flujos para frontend

Orden de llamadas de cada flujo. "(P)" = personal (con `x-restaurant-id`), "(C)" = comensal.

| Flujo                    | Orden de llamadas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registro de comensal     | 1. `POST /v1/auth/register` (201, sin tokens) → 2. `POST /v1/auth/login` → guardar `accessToken` y `refreshToken` → 3. `GET /v1/auth/me` (para un comensal puro, `restaurantes` viene vacío).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Registro de dueño        | 1. `POST /v1/auth/register-owner` (crea el restaurante en `BORRADOR`) → 2. `POST /v1/auth/login` → 3. `GET /v1/auth/me` y guardar `restaurantes[0].id` como `x-restaurant-id` → 4. (P) `PATCH /v1/restaurante` con `precioSueltoCentavos` > 0 → 5. (P) `PUT /v1/restaurante/horarios` → 6. (P) `POST /v1/menu/platos` por cada plato → 7. (P) `PUT /v1/menu/hoy` y `POST /v1/menu/hoy/publicar` → 8. (P) `POST /v1/planes` → 9. (P) `POST /v1/restaurante/activar` (409 si falta el precio o un horario) → opcional: `POST /v1/restaurante/personal/cajeros`, `PUT /v1/sellos/config`.                                                     |
| Login                    | 1. `POST /v1/auth/login` (401 = credenciales; 429 = esperar `retry-after`) → 2. `GET /v1/auth/me` → si `restaurantes` tiene elementos, dejar elegir entre entrar como personal de uno de ellos o como comensal. Después, ante un 401 en cualquier endpoint: **un** `POST /v1/auth/refresh` y reintentar una vez; si el refresh da 401, volver al login.                                                                                                                                                                                                                                                                                    |
| Ver vitrina (sin sesión) | 1. `GET /v1/restaurantes?q=&zonaId=&ciudadId=&etiqueta=&limit=&cursor=` → 2. `GET /v1/restaurantes/{slug}` (horarios, `abiertoAhora`, `ocupacion`, `menuHoy` y `planes`). Ambos son públicos.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pedir (preorden)         | 1. (C) `GET /v1/restaurantes/{slug}` y tomar los `id` (UUID) de los platos de `menuHoy` → 2. (C) `POST /v1/mis/pedidos` con `Idempotency-Key` → 3. (C) mostrar `qr` (= `id` del pedido) y seguir con `GET /v1/mis/pedidos/{id}` (`EN_CAMINO`; vence a los 30 min) → 4. (P cajero) `GET /v1/caja/pedidos/{id}`, `POST …/canjear` (con `Idempotency-Key`; descuenta el almuerzo) y `POST …/servir` → (C) puede `POST /v1/mis/pedidos/{id}/cancelar` mientras esté `EN_CAMINO`. Para pedir **un plan**: (C) `POST /v1/restaurantes/{slug}/solicitudes-plan` → (P) `GET /v1/solicitudes-plan` y `POST …/{id}/cobrar`.                          |
| Pagar en caja con QR     | 1. (C) `GET /v1/pase` (planes y código) o `GET /v1/pase/codigo?restaurante={id}` y **renovar cada ≤ 30 s**, dibujando `codigo` como QR → 2. (P) escanear y `POST /v1/caja/validar` con `{ "codigoQr" }` y una `Idempotency-Key` nueva por escaneo → 3. mostrar `resultado` y `mensaje` (siempre 200) → 4. (P) `POST /v1/caja/consumos/{id}/deshacer` dentro de 10 s, si se equivocó. En paralelo, (C) con `GET /v1/pase/eventos` abierto la app recibe `CANJE_REGISTRADO` / `CANJE_REVERTIDO` con el saldo nuevo al instante. Sin app: buscar con `GET /v1/clientes?q=` y validar con `{ "clienteId" }`. Sin plan: `POST /v1/caja/ventas`. |
| Abrir mesa compartida    | 1. (C anfitrión) `POST /v1/mis/mesas` con `restaurante`, `horaLlegada`, `modo` y `Idempotency-Key` → 2. compartir el link armado con `invitacion` (= `id` de la mesa) → 3. (C invitado) `GET /v1/mesas/invitacion/{id}` (mirar `puedeUnirse` y `motivo`) → 4. `POST /v1/mesas/invitacion/{id}/unirse` (con `Idempotency-Key`) → 5. ambos `GET /v1/mis/mesas/{id}` → 6. (P) `GET /v1/caja/mesas/{id}` y `POST …/validar` → antes de eso el anfitrión puede `POST /v1/mis/mesas/{id}/cancelar`.                                                                                                                                              |
| Dejar opinión            | 1. (C) `GET /v1/mis/opiniones/pendientes` (aparece 25 min después de validar; vence a las 24 h) → 2. (C) `POST /v1/mis/consumos/{id}/opinion` con `etiquetas` y `comentario` (o `…/opinion/descartar`), con `Idempotency-Key` → 3. (C) `GET /v1/mis/opiniones` para ver la respuesta → (P dueño) `GET /v1/opiniones` y `POST /v1/opiniones/{id}/responder`.                                                                                                                                                                                                                                                                                |

## 3. Referencia por módulo

Los ejemplos salen de respuestas reales de la API corriendo contra una base local con todas las migraciones (datos de prueba). En las listas se muestra solo el primer elemento. Los tokens van recortados. El esquema completo de cada cuerpo está en `docs/openapi.json`.

### Auth

#### `POST /v1/auth/register`

**Registrar una cuenta de comensal**

- **Rol:** Público (sin token)
- **Estado:** Estable

> No devuelve tokens: después hay que llamar a `POST /v1/auth/login`.

Request:

```json
{
  "nombre": "Carlos Cajero",
  "correo": "carlos@ejemplo.com",
  "password": "Contrasena-segura-1",
  "aceptaTerminos": true
}
```

Response `201`:

```json
{
  "usuario": {
    "id": "d58b9554-f8b3-4132-b386-8bcb9cbe5007",
    "nombre": "Carlos Cajero",
    "correo": "carlos@ejemplo.com"
  }
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`        | Ejemplo de `detail`                                                                                                                                                                               |
| ---- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `BAD_REQUEST` | property extra should not exist; nombre must be longer than or equal to 2 characters; correo must be an email; password must be longer than or equal to 10 characters; Debes aceptar los términos |
| 409  | `CONFLICT`    | No se pudo completar el registro con esos datos.                                                                                                                                                  |

#### `POST /v1/auth/register-owner`

**Registrar una cuenta de dueño con su restaurante (en borrador)**

- **Rol:** Público (sin token)
- **Estado:** Estable

> Crea la cuenta y el restaurante en estado `BORRADOR` (el usuario queda como `DUENO`). No devuelve tokens: hay que hacer login.
>
> `restaurante` exige solo `nombre` y `ciudadId`. Admite además, **todos opcionales y validados solo si vienen**, los datos de negocio de «Perfil de negocio» (más abajo): `direccion`, `latitud`, `longitud`, `telefono`, `puestos`, `mesas`, `cedulaRuc`, `precioAlmuerzoCentavos`, `precioSoloSegundoCentavos`, `precioSoloSopaCentavos`, `recargoParaLlevarCentavos`. El `slug` lo genera siempre el servidor (nombre sin acentos, minúsculas y guiones + sufijo aleatorio de 6 caracteres); no se envía.

Request:

```json
{
  "nombre": "Rosa Andrade",
  "correo": "rosa@ejemplo.com",
  "password": "Contrasena-segura-1",
  "aceptaTerminos": true,
  "restaurante": {
    "nombre": "Doña Rosa",
    "ciudadId": 1
  }
}
```

Response `201`:

```json
{
  "usuario": {
    "id": "bd80b064-ecd3-494b-ab56-bcf44b6d123f",
    "nombre": "Rosa Andrade",
    "correo": "rosa@ejemplo.com"
  },
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c",
    "estado": "BORRADOR"
  }
}
```

#### `POST /v1/auth/login`

**Iniciar sesión con correo o nombre de usuario**

- **Rol:** Público (sin token)
- **Estado:** Estable

> `identificador` es el correo o el nombre de usuario. Un 401 aquí significa credenciales inválidas (el mensaje es el mismo exista o no la cuenta).

Request:

```json
{
  "identificador": "rosa@ejemplo.com",
  "password": "Contrasena-segura-1"
}
```

Response `200`:

```json
{
  "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIiwi…",
  "refreshToken": "kRmeI6gl…",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "usuario": {
    "id": "bd80b064-ecd3-494b-ab56-bcf44b6d123f",
    "nombre": "Rosa Andrade"
  }
}
```

#### `POST /v1/auth/refresh`

**Rotar el refresh token y obtener un access token nuevo**

- **Rol:** Público (sin token)
- **Estado:** Estable

Cada refresh token sirve una sola vez. Reutilizar uno viejo revoca toda la sesión.

> El refresh token sirve **una sola vez**. Ver "Autenticación" para el manejo del fallo.

Request:

```json
{
  "refreshToken": "faAkiYKJ…"
}
```

Response `200`:

```json
{
  "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIiwi…",
  "refreshToken": "6LMIG3Ge…",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "usuario": {
    "id": "bd80b064-ecd3-494b-ab56-bcf44b6d123f",
    "nombre": "Rosa Andrade"
  }
}
```

#### `POST /v1/auth/logout`

**Cerrar la sesión de este dispositivo**

- **Rol:** Público (sin token)
- **Estado:** Estable

> Idempotente: un token desconocido no es error. Responde 204 sin cuerpo.

Request:

```json
{
  "refreshToken": "OL7UD59o…"
}
```

Response `204`:

Sin cuerpo.

#### `POST /v1/auth/logout-all`

**Cerrar la sesión en todos los dispositivos**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** Estable

Request: sin cuerpo (no envíes `content-type`).

Response `204`:

Sin cuerpo.

#### `GET /v1/auth/me`

**Mi usuario y los restaurantes donde trabajo**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** Estable

> `restaurantes` es la lista de locales donde la persona trabaja; el `id` de cada uno es el valor de `x-restaurant-id`. Un comensal puro recibe la lista vacía.

Response `200`:

```json
{
  "usuario": {
    "id": "bd80b064-ecd3-494b-ab56-bcf44b6d123f",
    "nombre": "Rosa Andrade"
  },
  "restaurantes": [
    {
      "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
      "nombre": "Doña Rosa",
      "rol": "DUENO"
    }
  ]
}
```

### Restaurante

#### Perfil de negocio (campos opcionales)

Datos que completa la app después del registro. **Todos son opcionales** en `POST /v1/auth/register-owner` (dentro de `restaurante`) y en `PATCH /v1/restaurante`: quien no los envía sigue funcionando igual que antes. La obligatoriedad la impone la app, no la API. **Dinero siempre en centavos enteros.**

| Campo                       | Tipo / rango                   | Notas                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `direccion`                 | texto ≤ 200, `null` borra      |                                                                                                                                                                                                                                                                                                              |
| `latitud`, `longitud`       | número, 6 decimales, `null`    | Deben caer dentro del país del local (Ecuador, con Galápagos; cajas aproximadas). Si solo llega una se valida por eje.                                                                                                                                                                                       |
| `telefono`                  | texto, `null` borra            | Ecuador: móvil `09XXXXXXXX` (10 dígitos). También acepta el mismo número ya en E.164 (`+5939XXXXXXXX`). **Se guarda y responde en E.164.** Otros formatos: 400                                                                                                                                               |
| `puestos`                   | entero 1..1000                 | Ya existía (antes también 1..1000). Base de la ocupación.                                                                                                                                                                                                                                                    |
| `mesas`                     | entero 1..200, `null` borra    | Informativo (no crea mesas operativas). `puestos` ≥ `mesas`: si llegan las dos se comparan entre sí; si llega una se compara con la guardada, pero solo si `puestos` ya fue indicado alguna vez (el 20 por defecto no cuenta: `mesas: 30` sin `puestos` pasa; con `puestos: 20` da 400). 400 si no se cumple |
| `cedulaRuc`                 | 10 dígitos (cédula) o 13 (RUC) | Validada por país. **Privada**: nunca en endpoints públicos; en `GET /v1/restaurante` sale enmascarada (`*********0001`). `null` la borra                                                                                                                                                                    |
| `precioAlmuerzoCentavos`    | entero 100..5000               | Es el mismo dato que `precioSueltoCentavos` (misma columna). Si llegan los dos deben ser iguales. Los dos salen en las respuestas                                                                                                                                                                            |
| `precioSoloSegundoCentavos` | entero 1..5000, `null`         | `null` = no se vende solo el segundo                                                                                                                                                                                                                                                                         |
| `precioSoloSopaCentavos`    | entero 1..5000, `null`         | `null` = no se vende solo la sopa                                                                                                                                                                                                                                                                            |
| `recargoParaLlevarCentavos` | entero ≥ 0                     | Ya existía. Los locales **nuevos** parten en 25 (antes 0); los existentes no cambian                                                                                                                                                                                                                         |

Validación por país (hoy solo `EC`; otros países usan reglas genéricas: teléfono E.164, rangos del planeta y `cedulaRuc` no admitido → 400). El punto de extensión es `src/restaurant/country/`.

- **Cédula (10 dígitos):** provincia `01`–`24` o `30`; tercer dígito < 6; dígito verificador módulo 10.
- **RUC (13 dígitos):** provincia como la cédula y los 3 últimos dígitos distintos de `000`. Persona natural: tercer dígito < 6 y módulo 10 sobre los 10 primeros. Sociedad privada: tercer dígito 9, módulo 11. Sociedad pública: tercer dígito 6, módulo 11.
- Ejemplo válido generado (no es de nadie): `1700000993001`.

`GET /v1/restaurante` suma `perfilCompleto` (boolean) y `datosPendientes` (lista, en este orden, de `cedulaRuc`, `telefono`, `direccion`, `coordenadas`, `mesas`, `puestos`, `precioAlmuerzo`). **No bloquea ninguna operación** (activar, caja, etc. siguen con sus reglas de siempre). `puestos` figura como pendiente mientras el dueño no lo haya indicado (los locales anteriores a este cambio cuentan como indicados); `precioAlmuerzo`, mientras el precio sea 0; `coordenadas`, si falta la latitud o la longitud.

Los precios (`precioAlmuerzoCentavos`, `precioSoloSegundoCentavos`, `precioSoloSopaCentavos`) y `recargoParaLlevarCentavos` son **públicos**: salen también en `GET /v1/restaurantes` y `GET /v1/restaurantes/{slug}`. La cédula/RUC, no.

Errores propios del módulo (estas fases usan el `code` genérico del estado HTTP; se distinguen por el `detail`):

- 400 · "No hay nada que actualizar." · horarios que se traslapan o con `cierra` ≤ `abre` · `zonaId` que no es de la ciudad del local
- 409 · activar sin precio suelto o sin horario · pausar un local que no está activo · activar un local en `BAJA`
- 404 · "Mesa no encontrada."

#### `GET /v1/restaurante`

**Perfil de mi restaurante (el de x-restaurant-id)**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Response `200`:

```json
{
  "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "nombre": "Doña Rosa",
  "slug": "dona-rosa-23902c",
  "descripcionCorta": null,
  "etiquetas": [],
  "paisCodigo": "EC",
  "ciudadId": 1,
  "zonaId": null,
  "monedaCodigo": "USD",
  "zonaHoraria": "America/Guayaquil",
  "direccion": null,
  "latitud": null,
  "longitud": null,
  "telefono": null,
  "logoUrl": null,
  "puestos": 20,
  "mesas": null,
  "cedulaRuc": null,
  "anotarMesa": false,
  "momentoCobro": "ANTES_DE_SERVIR",
  "precioSueltoCentavos": 0,
  "precioAlmuerzoCentavos": 0,
  "precioSoloSegundoCentavos": null,
  "precioSoloSopaCentavos": null,
  "recargoParaLlevarCentavos": 25,
  "llenoManualHasta": null,
  "concurridoManualHasta": null,
  "estado": "BORRADOR",
  "creadoEn": "2026-11-13T03:47:35.716Z",
  "actualizadoEn": "2026-11-13T03:47:35.716Z"
}
```

Campos `perfilCompleto` (boolean) y `datosPendientes` (lista de nombres) en este GET: ver «Perfil de negocio». `cedulaRuc` siempre enmascarada.

Campo `menuAgotado` (boolean, siempre presente) y `ocupacion` (ver «Estados públicos» al final de la sección 4): `menuAgotado` es `true` solo con menú publicado hoy y todas las sopas y todos los segundos agotados.

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`        | Ejemplo de `detail`                                  |
| ---- | ------------- | ---------------------------------------------------- |
| 400  | `BAD_REQUEST` | Falta el encabezado x-restaurant-id o no es un UUID. |
| 403  | `FORBIDDEN`   | No tienes acceso a este restaurante.                 |

#### `PATCH /v1/restaurante`

**Editar el perfil: nombre, contacto, puestos, precios, zona…**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

No cambia estado, slug, moneda ni país.

Request:

```json
{
  "descripcionCorta": "Almuerzos caseros desde 1998",
  "direccion": "Av. 10 de Agosto y Colón",
  "puestos": 24,
  "precioSueltoCentavos": 300,
  "recargoParaLlevarCentavos": 25
}
```

Response `200`:

```json
{
  "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "nombre": "Doña Rosa",
  "slug": "dona-rosa-23902c",
  "descripcionCorta": "Almuerzos caseros desde 1998",
  "etiquetas": [],
  "paisCodigo": "EC",
  "ciudadId": 1,
  "zonaId": null,
  "monedaCodigo": "USD",
  "zonaHoraria": "America/Guayaquil",
  "direccion": "Av. 10 de Agosto y Colón",
  "latitud": null,
  "longitud": null,
  "telefono": null,
  "logoUrl": null,
  "puestos": 24,
  "anotarMesa": false,
  "momentoCobro": "ANTES_DE_SERVIR",
  "precioSueltoCentavos": 300,
  "recargoParaLlevarCentavos": 25,
  "llenoManualHasta": null,
  "concurridoManualHasta": null,
  "estado": "BORRADOR",
  "creadoEn": "2026-11-13T03:47:35.716Z",
  "actualizadoEn": "2026-11-13T03:47:35.822Z"
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`      | Ejemplo de `detail`            |
| ---- | ----------- | ------------------------------ |
| 403  | `FORBIDDEN` | Tu rol no permite esta acción. |

#### `POST /v1/restaurante/activar`

**Publicar el local en la vitrina**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Exige precio de almuerzo suelto y al menos un horario.

> 409 si falta el precio del almuerzo suelto (`precioSueltoCentavos` > 0) o al menos un horario. No exige menú publicado.

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "nombre": "Doña Rosa",
  "slug": "dona-rosa-23902c",
  "descripcionCorta": "Almuerzos caseros desde 1998",
  "etiquetas": [],
  "paisCodigo": "EC",
  "ciudadId": 1,
  "zonaId": null,
  "monedaCodigo": "USD",
  "zonaHoraria": "America/Guayaquil",
  "direccion": "Av. 10 de Agosto y Colón",
  "latitud": null,
  "longitud": null,
  "telefono": null,
  "logoUrl": null,
  "puestos": 24,
  "anotarMesa": false,
  "momentoCobro": "ANTES_DE_SERVIR",
  "precioSueltoCentavos": 300,
  "recargoParaLlevarCentavos": 25,
  "llenoManualHasta": null,
  "concurridoManualHasta": null,
  "estado": "ACTIVO",
  "creadoEn": "2026-11-13T03:47:35.716Z",
  "actualizadoEn": "2026-11-13T03:47:36.082Z"
}
```

#### `POST /v1/restaurante/pausar`

**Sacar el local de la vitrina sin borrarlo**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "nombre": "Doña Rosa",
  "slug": "dona-rosa-23902c",
  "descripcionCorta": "Almuerzos caseros desde 1998",
  "etiquetas": [],
  "paisCodigo": "EC",
  "ciudadId": 1,
  "zonaId": null,
  "monedaCodigo": "USD",
  "zonaHoraria": "America/Guayaquil",
  "direccion": "Av. 10 de Agosto y Colón",
  "latitud": null,
  "longitud": null,
  "telefono": null,
  "logoUrl": null,
  "puestos": 24,
  "anotarMesa": false,
  "momentoCobro": "ANTES_DE_SERVIR",
  "precioSueltoCentavos": 300,
  "recargoParaLlevarCentavos": 25,
  "llenoManualHasta": null,
  "concurridoManualHasta": null,
  "estado": "PAUSADO",
  "creadoEn": "2026-11-13T03:47:35.716Z",
  "actualizadoEn": "2026-11-13T03:49:45.731Z"
}
```

#### `GET /v1/restaurante/horarios`

**Horarios de atención**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Response `200`:

```json
[
  {
    "diaSemana": 1,
    "abre": "11:30",
    "cierra": "15:30"
  }
]
```

#### `PUT /v1/restaurante/horarios`

**Reemplazar todos los horarios**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Varios tramos por día (p. ej. almuerzo y merienda); no se pueden traslapar.

Request:

```json
{
  "horarios": [
    {
      "diaSemana": 1,
      "abre": "11:30",
      "cierra": "15:30"
    }
  ]
}
```

Response `200`:

```json
[
  {
    "diaSemana": 1,
    "abre": "11:30",
    "cierra": "15:30"
  }
]
```

#### `GET /v1/restaurante/mesas`

**Mesas del local**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Response `200`:

```json
[
  {
    "id": "15",
    "etiqueta": "Mesa 1",
    "capacidad": 4,
    "activo": true
  }
]
```

#### `POST /v1/restaurante/mesas`

**Crear una mesa**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request:

```json
{
  "etiqueta": "Mesa 1",
  "capacidad": 4
}
```

Response `201`:

```json
{
  "id": "15",
  "etiqueta": "Mesa 1",
  "capacidad": 4,
  "activo": true
}
```

#### `PATCH /v1/restaurante/mesas/{id}`

**Editar o desactivar una mesa**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request:

```json
{
  "capacidad": 6
}
```

Response `200`:

```json
{
  "id": "15",
  "etiqueta": "Mesa 1",
  "capacidad": 6,
  "activo": true
}
```

#### `POST /v1/restaurante/lleno`

**Marcar el estado manual del local: Libre, Concurrido o Lleno**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request (manda `nivel`, o `lleno` por compatibilidad; al menos uno):

```json
{
  "nivel": "CONCURRIDO"
}
```

- `nivel`: `LIBRE` | `CONCURRIDO` | `LLENO`. Cualquier otro valor → 400 de validación.
- `lleno` (booleano, sigue funcionando): `true` equivale a `nivel: "LLENO"`; `false`, a `nivel: "LIBRE"`.
- **Si llegan los dos y se contradicen, gana `nivel`** (por ejemplo `{ "lleno": true, "nivel": "LIBRE" }` deja el local en `LIBRE`).
- Sin `nivel` ni `lleno` → 400.
- `LLENO` y `CONCURRIDO` duran 20 minutos y expiran solos (se miden con el reloj de la base, no el del cliente); son excluyentes entre sí. `LIBRE` limpia ambos.
- Es un estado **manual**: no baja un nivel automático más alto (ver abajo).

Response `200`:

```json
{
  "lleno": false,
  "nivel": "CONCURRIDO",
  "llenoManualHasta": null,
  "concurridoManualHasta": null,
  "concurridoManualHasta": "2026-11-13T04:09:42.029Z"
}
```

`lleno` es `true` solo cuando `nivel` es `LLENO`. `llenoManualHasta` y `concurridoManualHasta` son `null` cuando ese estado no está activo.

##### Cómo se ve en la ocupación (`ocupacion.nivel` y `ocupacion.lleno`)

La escala de `ocupacion.nivel` **no cambia**: `LIBRE`, `MODERADO`, `LLENO`. El "Concurrido" manual se muestra como `MODERADO`.

| Estado manual vigente | Resultado                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `LLENO`               | `nivel: "LLENO"`, `lleno: true`                                                                       |
| `CONCURRIDO`          | `nivel: "MODERADO"`, `lleno: false`, salvo que el cálculo automático ya dé `LLENO` (gana el más alto) |
| vencido o ninguno     | lo que calcula el aforo (`LIBRE` <50%, `MODERADO` 50–89%, `LLENO` ≥90%)                               |

Se lee en `GET /v1/restaurantes`, `GET /v1/restaurantes/{slug}` y `GET /v1/restaurante` (este último trae `ocupacion` desde esta versión; es `null` si el local no está `ACTIVO`).

##### Los 4 estados para las apps (Libre, Concurrido, Lleno, Cerrado)

- Libre / Concurrido / Lleno: `ocupacion.nivel` = `LIBRE` / `MODERADO` / `LLENO`. Ojo: `MODERADO` también aparece por aforo (50–89%) sin que nadie lo marque; la API no distingue si es manual o automático.
- Cerrado: un local `PAUSADO` **sí aparece** en `GET /v1/restaurantes` y `GET /v1/restaurantes/{slug}` con `estado: "PAUSADO"` y `abiertoAhora: false` (ver «Estados públicos» al final). Su `ocupacion` en la vitrina es la de un local sin consumos (`LIBRE`, 0 %): no es un dato real, la app debe mostrar «Cerrado» por `estado`. Su personal lo ve con `GET /v1/restaurante` (`ocupacion: null`).
- **No hay evento en tiempo real** para la ocupación: las apps la leen con los GET anteriores (polling). Una opción futura, solo como idea: reutilizar el canal SSE del pase (`pass-events`) o agregar un SSE público por local; no está construida.

#### `GET /v1/restaurantes`

**Buscar restaurantes por zona, ciudad, texto o etiqueta**

- **Rol:** Público (sin token)
- **Estado:** Estable
- **Query:** `q`, `zonaId`, `ciudadId`, `etiqueta`, `limit`, `cursor`

Público, sin token. Restaurantes `ACTIVO` y `PAUSADO` (campo `estado`); `BORRADOR` y `BAJA` no aparecen. Paginación por cursor: máximo 50 por página; pasa `nextCursor` como `cursor`.

> Un `PAUSADO` se lista con `estado: "PAUSADO"` y `abiertoAhora: false`. Paginación por cursor.

Response `200`:

```json
{
  "items": [
    {
      "id": "657c4b4f-fb2b-4e49-b845-23b807dee8a8",
      "nombre": "Doña Rosa",
      "slug": "dona-rosa-00b8d3",
      "descripcionCorta": "Almuerzos caseros desde 1998",
      "etiquetas": [],
      "zona": null,
      "ciudadId": 1,
      "direccion": "Av. 10 de Agosto y Colón",
      "latitud": null,
      "longitud": null,
      "logoUrl": null,
      "precioSueltoCentavos": 300,
      "monedaCodigo": "USD",
      "estado": "ACTIVO",
      "abiertoAhora": false,
      "menuAgotado": false,
      "ocupacion": {
        "nivel": "LIBRE",
        "porcentaje": 0,
        "lleno": false
      }
    }
  ],
  "nextCursor": "eyJuIjoiRG_DsWEgUm9zYSIsImkiOiIyMjcifQ"
}
```

#### `GET /v1/restaurantes/{slug}`

**Detalle de un restaurante: horarios, menú publicado de hoy, planes visibles y ocupación**

- **Rol:** Público (sin token)
- **Estado:** Estable · requiere la migración 20261117000000 (aplicada en Neon)

Público, sin token. Un local `PAUSADO` se ve (`estado: "PAUSADO"`, `abiertoAhora: false`); uno en `BORRADOR` o `BAJA` responde 404.

> Los platos de `menuHoy` traen `id` (UUID): es el que se manda en `POST /v1/mis/pedidos`. Los locales en `BORRADOR` o `BAJA` responden 404; un `PAUSADO` responde 200 pero no admite órdenes nuevas.

Response `200`:

```json
{
  "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "nombre": "Doña Rosa",
  "slug": "dona-rosa-23902c",
  "descripcionCorta": "Almuerzos caseros desde 1998",
  "etiquetas": [],
  "zona": null,
  "ciudadId": 1,
  "direccion": "Av. 10 de Agosto y Colón",
  "latitud": null,
  "longitud": null,
  "logoUrl": null,
  "precioSueltoCentavos": 300,
  "monedaCodigo": "USD",
  "estado": "ACTIVO",
  "abiertoAhora": false,
  "menuAgotado": false,
  "ocupacion": {
    "nivel": "LIBRE",
    "porcentaje": 0,
    "lleno": false
  },
  "telefono": null,
  "horarios": [
    {
      "diaSemana": 1,
      "abre": "11:30",
      "cierra": "15:30"
    }
  ],
  "menuHoy": {
    "fecha": "2026-11-12",
    "publicado": true,
    "secciones": [
      {
        "seccion": "JUGO",
        "platos": [
          {
            "id": "e0b88488-3c25-4302-aaea-54ea6d3c6f18",
            "nombre": "Jugo de naranjilla",
            "descripcion": null,
            "fotoUrl": null,
            "etiquetas": [],
            "precioCentavos": null,
            "agotado": false
          }
        ]
      }
    ]
  },
  "planes": [
    {
      "id": "171",
      "tipo": "SEMANAL",
      "nombre": "Plan semanal",
      "almuerzos": 5,
      "precioCentavos": 1500,
      "vigenciaDias": 7,
      "diasValidos": [1],
      "incluye": ["Sopa"]
    }
  ]
}
```

#### `GET /v1/restaurantes/{slug}/carta`

**Carta fija de un restaurante (a la carta, extras y bebidas)**

- **Rol:** público, sin token
- **Estado:** Nuevo (rama `feat/carta-fija-seleccion-mesa`)

Solo platos **activos y con precio** de las categorías `A_LA_CARTA`, `EXTRA` y `BEBIDA`, de un local `ACTIVO` (en borrador, pausado, de baja o inexistente → 404 `RESTAURANTE_NO_ENCONTRADO`). No depende del menú del día. Orden: categoría, `orden`, nombre. Sin ids internos: `id` es el `public_id` del plato. No incluye `agotadoEn`.

Response `200`:

```json
{
  "monedaCodigo": "USD",
  "items": [
    {
      "id": "6a9c3a52-6c6e-4a41-8d0d-0a3f4e2a9b11",
      "categoria": "A_LA_CARTA",
      "nombre": "Ceviche",
      "descripcion": "De camarón",
      "fotoUrl": null,
      "etiquetas": [],
      "precioCentavos": 700,
      "agotado": false,
      "orden": 1
    }
  ]
}
```

`agotado` es "agotado hoy" (lo marcan dueño o cajero) y vuelve solo a medianoche en la zona horaria del local.

#### `POST /v1/restaurantes/{slug}/solicitudes-plan`

**Pedir un plan a un restaurante (comensal con sesión)**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

El local la ve en sus solicitudes y la cobra en caja.

Request:

```json
{
  "planId": "171"
}
```

Response `201`:

```json
{
  "id": "12",
  "estado": "PENDIENTE",
  "plan": "Plan semanal",
  "creadaEn": "2026-11-13T03:47:36.478Z"
}
```

### Personal

Errores propios del módulo (estas fases usan el `code` genérico del estado HTTP; se distinguen por el `detail`):

- 404 · "No existe una cuenta con ese correo." (la persona debe registrarse primero)
- 409 · ya es parte del personal · solo se puede activar o desactivar a un cajero
- 429 · límite de 20 altas por IP y hora (`invite`)

#### `GET /v1/restaurante/personal`

**Personal del restaurante (dueño y cajeros)**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Response `200`:

```json
[
  {
    "usuarioId": "bd80b064-ecd3-494b-ab56-bcf44b6d123f",
    "nombre": "Rosa Andrade",
    "nombreVisible": "Rosa Andrade",
    "rol": "DUENO",
    "activo": true
  }
]
```

#### `POST /v1/restaurante/personal/cajeros`

**Agregar un cajero por su correo**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

La persona debe haberse registrado antes. Límite de intentos por hora.

Request:

```json
{
  "correo": "carlos@ejemplo.com",
  "nombreVisible": "Carlos"
}
```

Response `201`:

```json
{
  "usuarioId": "d58b9554-f8b3-4132-b386-8bcb9cbe5007",
  "nombre": "Carlos Cajero",
  "nombreVisible": "Carlos",
  "rol": "CAJERO",
  "activo": true
}
```

#### `PATCH /v1/restaurante/personal/{usuarioId}`

**Activar o desactivar a un cajero**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Un cajero desactivado pierde el acceso de inmediato.

Request:

```json
{
  "activo": false
}
```

Response `200`:

```json
{
  "usuarioId": "d58b9554-f8b3-4132-b386-8bcb9cbe5007",
  "nombre": "Carlos Cajero",
  "nombreVisible": "Carlos",
  "rol": "CAJERO",
  "activo": false
}
```

### Menú

Errores propios del módulo (estas fases usan el `code` genérico del estado HTTP; se distinguen por el `detail`):

- 400 · plato repetido en el mismo menú · plato inexistente, inactivo o de otro local · `copiar` con origen = destino · fecha inválida
- 404 · plato no encontrado · "No hay menú el AAAA-MM-DD." · el plato no está en el menú de ese día
- 409 · publicar sin menú o sin platos · modificar un día pasado · `copiar` sobre un día con platos sin `reemplazar`

#### `GET /v1/menu/platos`

**Catálogo de platos del restaurante**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Query:** `categoria` (ALMUERZO, A_LA_CARTA, EXTRA, BEBIDA), `soloActivos` (true, false)

Response `200`:

```json
[
  {
    "id": "296",
    "categoria": "ALMUERZO",
    "seccion": "FUERTE",
    "nombre": "Arroz con menestra y carne",
    "descripcion": null,
    "precioCentavos": null,
    "fotoUrl": null,
    "etiquetas": [],
    "activo": true,
    "orden": 0,
    "agotado": false,
    "agotadoEn": null
  }
]
```

#### `POST /v1/menu/platos`

**Crear un plato en el catálogo**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request:

```json
{
  "categoria": "ALMUERZO",
  "seccion": "JUGO",
  "nombre": "Jugo de naranjilla"
}
```

Response `201`:

```json
{
  "id": "293",
  "categoria": "ALMUERZO",
  "seccion": "JUGO",
  "nombre": "Jugo de naranjilla",
  "descripcion": null,
  "precioCentavos": null,
  "fotoUrl": null,
  "etiquetas": [],
  "activo": true,
  "orden": 0,
  "agotado": false,
  "agotadoEn": null
}
```

#### `PATCH /v1/menu/platos/{id}`

**Editar o desactivar un plato**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Los platos no se borran: se desactivan.

Request:

```json
{
  "descripcion": "Con maracuyá fresco",
  "activo": true
}
```

Response `200`:

```json
{
  "id": "299",
  "categoria": "ALMUERZO",
  "seccion": "POSTRE",
  "nombre": "Mousse de maracuyá",
  "descripcion": "Con maracuyá fresco",
  "precioCentavos": null,
  "fotoUrl": null,
  "etiquetas": [],
  "activo": true,
  "orden": 0,
  "agotado": false,
  "agotadoEn": null
}
```

#### `PATCH /v1/menu/platos/{id}/agotado`

**Marcar o quitar "agotado" en un plato de la carta fija**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Nuevo (rama `feat/carta-fija-seleccion-mesa`) · requiere la migración `20261121140000`

Para los platos de carta (`A_LA_CARTA`, `EXTRA`, `BEBIDA`). El cajero solo puede esto: crear, editar precios o desactivar sigue siendo del dueño (403). El agotado vale **hasta medianoche en la zona horaria del local** y luego el plato vuelve solo; repetir `agotado: true` conserva la hora original. Un plato `ALMUERZO` se agota en el menú del día (`PATCH /v1/menu/{fecha}/items/{id}/agotado`).

Request: `{ "agotado": true }` (cualquier otro campo → 400). Response `200`: el plato, con `agotado` y `agotadoEn` (hora en que se marcó; `null` si no está agotado hoy).

| HTTP | `code`                 | Ejemplo de `detail`                                                         |
| ---- | ---------------------- | --------------------------------------------------------------------------- |
| 404  | `PLATO_NO_ENCONTRADO`  | No existe o es de otro local                                                |
| 422  | `PLATO_NO_ES_DE_CARTA` | Solo los platos de la carta se agotan aquí; el almuerzo, en el menú del día |

Campos nuevos en los platos (todas las respuestas de `/v1/menu/platos*`): `orden` (entero 0–1000, menor primero dentro de su categoría; también se envía, opcional, en `POST` y `PATCH`), `agotado` (boolean) y `agotadoEn`. El listado `GET /v1/menu/platos` ahora ordena por categoría, `orden` y nombre.

#### `GET /v1/menu/{fecha}`

**Menú de un día (incluye borrador)**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable · requiere la migración 20261117000000 (aplicada en Neon)

> `{fecha}` es `hoy` (en la zona horaria del local) o `AAAA-MM-DD`. Los renglones del menú usan ids numéricos del tenant; `platoId` también.

Response `200`:

```json
{
  "fecha": "2026-11-12",
  "publicado": true,
  "publicadoEn": "2026-11-13T03:47:36.033Z",
  "items": [
    {
      "id": "587",
      "platoId": "293",
      "nombre": "Jugo de naranjilla",
      "categoria": "ALMUERZO",
      "descripcion": null,
      "fotoUrl": null,
      "etiquetas": [],
      "seccion": "JUGO",
      "precioCentavos": null,
      "precioDelDiaCentavos": null,
      "porciones": 40,
      "agotado": false,
      "agotadoEn": null,
      "orden": 0
    }
  ]
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`        | Ejemplo de `detail`             |
| ---- | ------------- | ------------------------------- |
| 400  | `BAD_REQUEST` | Fecha inválida: usa AAAA-MM-DD. |

#### `PUT /v1/menu/{fecha}`

**Definir el menú del día**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable · requiere la migración 20261117000000 (aplicada en Neon)

Lista completa y libre: sin límite de sopas o segundos. Lo que quede fuera se quita; lo que se mantiene conserva su estado de agotado.

> Reemplaza todos los platos del día. No se puede modificar un día pasado.

Request:

```json
{
  "items": [
    {
      "platoId": "293",
      "seccion": "JUGO",
      "porciones": 40,
      "orden": 0
    }
  ]
}
```

Response `200`:

```json
{
  "fecha": "2026-11-12",
  "publicado": false,
  "publicadoEn": null,
  "items": [
    {
      "id": "587",
      "platoId": "293",
      "nombre": "Jugo de naranjilla",
      "categoria": "ALMUERZO",
      "descripcion": null,
      "fotoUrl": null,
      "etiquetas": [],
      "seccion": "JUGO",
      "precioCentavos": null,
      "precioDelDiaCentavos": null,
      "porciones": 40,
      "agotado": false,
      "agotadoEn": null,
      "orden": 0
    }
  ]
}
```

#### `POST /v1/menu/{fecha}/publicar`

**Publicar el menú en la vitrina**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable · requiere la migración 20261117000000 (aplicada en Neon)

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "fecha": "2026-11-12",
  "publicado": true,
  "publicadoEn": "2026-11-13T03:47:36.033Z",
  "items": [
    {
      "id": "587",
      "platoId": "293",
      "nombre": "Jugo de naranjilla",
      "categoria": "ALMUERZO",
      "descripcion": null,
      "fotoUrl": null,
      "etiquetas": [],
      "seccion": "JUGO",
      "precioCentavos": null,
      "precioDelDiaCentavos": null,
      "porciones": 40,
      "agotado": false,
      "agotadoEn": null,
      "orden": 0
    }
  ]
}
```

#### `POST /v1/menu/{fecha}/despublicar`

**Sacar el menú de la vitrina**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable · requiere la migración 20261117000000 (aplicada en Neon)

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "fecha": "2026-11-12",
  "publicado": false,
  "publicadoEn": null,
  "items": [
    {
      "id": "587",
      "platoId": "293",
      "nombre": "Jugo de naranjilla",
      "categoria": "ALMUERZO",
      "descripcion": null,
      "fotoUrl": null,
      "etiquetas": [],
      "seccion": "JUGO",
      "precioCentavos": null,
      "precioDelDiaCentavos": null,
      "porciones": 40,
      "agotado": false,
      "agotadoEn": null,
      "orden": 0
    }
  ]
}
```

#### `POST /v1/menu/{fecha}/copiar`

**Copiar el menú de otro día**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable · requiere la migración 20261117000000 (aplicada en Neon)

Por defecto, el último menú anterior con platos. Queda como borrador y sin agotados.

Request:

```json
{
  "desde": "2026-11-12"
}
```

Response `200`:

```json
{
  "fecha": "2026-11-14",
  "publicado": false,
  "publicadoEn": null,
  "items": [
    {
      "id": "593",
      "platoId": "293",
      "nombre": "Jugo de naranjilla",
      "categoria": "ALMUERZO",
      "descripcion": null,
      "fotoUrl": null,
      "etiquetas": [],
      "seccion": "JUGO",
      "precioCentavos": null,
      "precioDelDiaCentavos": null,
      "porciones": 40,
      "agotado": false,
      "agotadoEn": null,
      "orden": 0
    }
  ]
}
```

#### `PATCH /v1/menu/{fecha}/items/{id}/agotado`

**Marcar o quitar "agotado" en un plato del menú**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable · requiere la migración 20261117000000 (aplicada en Neon)

Guarda a qué hora se acabó.

Request:

```json
{
  "agotado": true
}
```

Response `200`:

```json
{
  "fecha": "2026-11-12",
  "publicado": true,
  "publicadoEn": "2026-11-13T03:49:42.190Z",
  "items": [
    {
      "id": "587",
      "platoId": "293",
      "nombre": "Jugo de naranjilla",
      "categoria": "ALMUERZO",
      "descripcion": null,
      "fotoUrl": null,
      "etiquetas": [],
      "seccion": "JUGO",
      "precioCentavos": null,
      "precioDelDiaCentavos": null,
      "porciones": 40,
      "agotado": true,
      "agotadoEn": "2026-11-13T03:49:42.220Z",
      "orden": 0
    }
  ]
}
```

### Planes, pagos y solicitudes

Errores propios del módulo (estas fases usan el `code` genérico del estado HTTP; se distinguen por el `detail`):

- 404 · plan, cliente, pago o solicitud no encontrados
- 409 · plan desactivado o sin cupos · referencia de pago ya usada · `Idempotency-Key` usada en otra venta · pago ya confirmado/rechazado · solicitud ya resuelta · plan con almuerzos consumidos al deshacer · solicitud pendiente duplicada
- 403 · el cajero solo puede deshacer ventas del mismo día

#### `GET /v1/planes`

**Plantillas de plan del restaurante, con cupos disponibles**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Response `200`:

```json
[
  {
    "id": "171",
    "tipo": "SEMANAL",
    "nombre": "Plan semanal",
    "almuerzos": 5,
    "precioCentavos": 1500,
    "vigenciaDias": 7,
    "cupos": 30,
    "cuposDisponibles": 30,
    "vendidosActivos": 0,
    "diasValidos": [1],
    "incluye": ["Sopa"],
    "visibleEnMarketplace": true,
    "activo": true
  }
]
```

#### `POST /v1/planes`

**Crear una plantilla de plan**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request:

```json
{
  "tipo": "SEMANAL",
  "nombre": "Plan semanal",
  "almuerzos": 5,
  "precioCentavos": 1500,
  "vigenciaDias": 7,
  "cupos": 30,
  "diasValidos": [1],
  "incluye": ["Sopa"],
  "visibleEnMarketplace": true
}
```

Response `201`:

```json
{
  "id": "171",
  "tipo": "SEMANAL",
  "nombre": "Plan semanal",
  "almuerzos": 5,
  "precioCentavos": 1500,
  "vigenciaDias": 7,
  "cupos": 30,
  "cuposDisponibles": 30,
  "vendidosActivos": 0,
  "diasValidos": [1],
  "incluye": ["Sopa"],
  "visibleEnMarketplace": true,
  "activo": true
}
```

#### `PATCH /v1/planes/{id}`

**Editar o desactivar una plantilla**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

No cambia los planes ya vendidos.

Request:

```json
{
  "cupos": 40
}
```

Response `200`:

```json
{
  "id": "171",
  "tipo": "SEMANAL",
  "nombre": "Plan semanal",
  "almuerzos": 5,
  "precioCentavos": 1500,
  "vigenciaDias": 7,
  "cupos": 40,
  "cuposDisponibles": 39,
  "vendidosActivos": 1,
  "diasValidos": [1],
  "incluye": ["Sopa"],
  "visibleEnMarketplace": true,
  "activo": true
}
```

#### `POST /v1/clientes/{id}/planes`

**Vender un plan a un cliente**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Idempotency-Key:** obligatoria (UUID)

Crea el plan y el pago en una sola transacción. Efectivo queda confirmado; transferencia/Deuna, pendiente salvo pagoConfirmado.

> `planId` es el id numérico de la plantilla (`GET /v1/planes`). Efectivo queda confirmado; transferencia y Deuna quedan `PENDIENTE` salvo `pagoConfirmado`.

Request:

```json
{
  "metodoPago": "TRANSFERENCIA",
  "planId": "171",
  "referenciaExterna": "TRF-EJEMPLO"
}
```

Response `201`:

```json
{
  "id": "4a17f54f-88e3-40fb-9e9f-a3662649548f",
  "cliente": {
    "id": "198",
    "nombre": "Luis Pérez"
  },
  "planId": "171",
  "origen": "VENTA",
  "nombrePlan": "Plan semanal",
  "almuerzosTotales": 5,
  "almuerzosRestantes": 5,
  "precioPagadoCentavos": 1500,
  "precioUnitarioCentavos": 300,
  "monedaCodigo": "USD",
  "diasValidos": [1],
  "compradaEn": "2026-11-13T03:49:42.426Z",
  "venceEl": "2026-11-18",
  "estado": "ACTIVA",
  "anuladaEn": null,
  "anotacion": null,
  "pago": {
    "id": "b4d073bc-05b5-4cf7-88a9-0ef86afaeb4e",
    "estado": "PENDIENTE",
    "metodo": "TRANSFERENCIA",
    "montoCentavos": 1500,
    "fecha": "2026-11-12",
    "comprobanteUrl": null,
    "reverso": null
  }
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                     | Ejemplo de `detail`                                        |
| ---- | -------------------------- | ---------------------------------------------------------- |
| 400  | `IDEMPOTENCY_KEY_INVALIDA` | Falta el encabezado Idempotency-Key (UUID) o no es válido. |

#### `POST /v1/planes-vendidos/{id}/deshacer`

**Deshacer la venta de un plan**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Idempotency-Key:** obligatoria (UUID)

Registra un pago inverso (nunca borra). Solo sin almuerzos consumidos; el cajero, solo el mismo día.

Request:

```json
{
  "motivo": "Se cobró al cliente equivocado"
}
```

Response `200`:

```json
{
  "id": "fb9a8acc-8cb8-4158-9c84-cf5499165d2f",
  "cliente": {
    "id": "199",
    "nombre": "María Torres"
  },
  "planId": "171",
  "origen": "VENTA",
  "nombrePlan": "Plan semanal",
  "almuerzosTotales": 5,
  "almuerzosRestantes": 5,
  "precioPagadoCentavos": 1500,
  "precioUnitarioCentavos": 300,
  "monedaCodigo": "USD",
  "diasValidos": [1],
  "compradaEn": "2026-11-13T03:49:42.496Z",
  "venceEl": "2026-11-18",
  "estado": "ANULADA",
  "anuladaEn": "2026-11-13T03:49:42.512Z",
  "anotacion": "Se cobró al cliente equivocado",
  "pago": {
    "id": "3ddda921-6027-4897-a527-e26509321e6b",
    "estado": "CONFIRMADO",
    "metodo": "EFECTIVO",
    "montoCentavos": 1500,
    "fecha": "2026-11-12",
    "comprobanteUrl": null,
    "reverso": {
      "id": "d823b7d5-a620-4044-8c37-d3c1fd930a07",
      "montoCentavos": -1500
    }
  }
}
```

#### `GET /v1/pagos/pendientes`

**Transferencias y pagos Deuna por confirmar**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

> Devuelve **planes vendidos** con su pago. El id para confirmar o rechazar es `pago.id`, no el `id` del elemento.

Response `200`:

```json
[
  {
    "id": "4a17f54f-88e3-40fb-9e9f-a3662649548f",
    "cliente": {
      "id": "198",
      "nombre": "Luis Pérez"
    },
    "planId": "171",
    "origen": "VENTA",
    "nombrePlan": "Plan semanal",
    "almuerzosTotales": 5,
    "almuerzosRestantes": 5,
    "precioPagadoCentavos": 1500,
    "precioUnitarioCentavos": 300,
    "monedaCodigo": "USD",
    "diasValidos": [1],
    "compradaEn": "2026-11-13T03:49:42.426Z",
    "venceEl": "2026-11-18",
    "estado": "ACTIVA",
    "anuladaEn": null,
    "anotacion": null,
    "pago": {
      "id": "b4d073bc-05b5-4cf7-88a9-0ef86afaeb4e",
      "estado": "PENDIENTE",
      "metodo": "TRANSFERENCIA",
      "montoCentavos": 1500,
      "fecha": "2026-11-12",
      "comprobanteUrl": null,
      "reverso": null
    }
  }
]
```

#### `POST /v1/pagos/{id}/confirmar`

**Confirmar un pago pendiente**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "4a17f54f-88e3-40fb-9e9f-a3662649548f",
  "cliente": {
    "id": "198",
    "nombre": "Luis Pérez"
  },
  "planId": "171",
  "origen": "VENTA",
  "nombrePlan": "Plan semanal",
  "almuerzosTotales": 5,
  "almuerzosRestantes": 5,
  "precioPagadoCentavos": 1500,
  "precioUnitarioCentavos": 300,
  "monedaCodigo": "USD",
  "diasValidos": [1],
  "compradaEn": "2026-11-13T03:49:42.426Z",
  "venceEl": "2026-11-18",
  "estado": "ACTIVA",
  "anuladaEn": null,
  "anotacion": null,
  "pago": {
    "id": "b4d073bc-05b5-4cf7-88a9-0ef86afaeb4e",
    "estado": "CONFIRMADO",
    "metodo": "TRANSFERENCIA",
    "montoCentavos": 1500,
    "fecha": "2026-11-12",
    "comprobanteUrl": null,
    "reverso": null
  }
}
```

#### `POST /v1/pagos/{id}/rechazar`

**Rechazar un pago pendiente**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Anula el plan asociado.

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "785396a7-f616-4686-aaad-6aa81034be7e",
  "cliente": {
    "id": "200",
    "nombre": "Pedro Salas"
  },
  "planId": "171",
  "origen": "VENTA",
  "nombrePlan": "Plan semanal",
  "almuerzosTotales": 5,
  "almuerzosRestantes": 5,
  "precioPagadoCentavos": 1500,
  "precioUnitarioCentavos": 300,
  "monedaCodigo": "USD",
  "diasValidos": [1],
  "compradaEn": "2026-11-13T03:50:57.110Z",
  "venceEl": "2026-11-18",
  "estado": "ANULADA",
  "anuladaEn": "2026-11-13T03:50:57.137Z",
  "anotacion": "Pago rechazado",
  "pago": {
    "id": "77741391-8e50-481c-a81a-ea5f36f6f0a9",
    "estado": "RECHAZADO",
    "metodo": "DEUNA",
    "montoCentavos": 1500,
    "fecha": "2026-11-12",
    "comprobanteUrl": null,
    "reverso": null
  }
}
```

#### `GET /v1/solicitudes-plan`

**Solicitudes de plan hechas por comensales desde la app**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Response `200`:

```json
[
  {
    "id": "12",
    "creadaEn": "2026-11-13T03:47:36.478Z",
    "cliente": {
      "id": "195",
      "nombre": "Ana Mora"
    },
    "plan": {
      "id": "171",
      "nombre": "Plan semanal",
      "precioCentavos": 1500,
      "almuerzos": 5
    }
  }
]
```

#### `POST /v1/solicitudes-plan/{id}/cobrar`

**Cobrar una solicitud: vende el plan y la marca cobrada**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Idempotency-Key:** obligatoria (UUID)

Request:

```json
{
  "metodoPago": "EFECTIVO"
}
```

Response `200`:

```json
{
  "id": "22d016e4-b99b-4c1d-8673-94690d057463",
  "cliente": {
    "id": "195",
    "nombre": "Ana Mora"
  },
  "planId": "171",
  "origen": "VENTA",
  "nombrePlan": "Plan semanal",
  "almuerzosTotales": 5,
  "almuerzosRestantes": 5,
  "precioPagadoCentavos": 1500,
  "precioUnitarioCentavos": 300,
  "monedaCodigo": "USD",
  "diasValidos": [1],
  "compradaEn": "2026-11-13T03:47:36.505Z",
  "venceEl": "2026-11-18",
  "estado": "ACTIVA",
  "anuladaEn": null,
  "anotacion": null,
  "pago": {
    "id": "7cb86c27-d969-4f8a-b903-1dbeb9efc85c",
    "estado": "CONFIRMADO",
    "metodo": "EFECTIVO",
    "montoCentavos": 1500,
    "fecha": "2026-11-12",
    "comprobanteUrl": null,
    "reverso": null
  }
}
```

#### `POST /v1/solicitudes-plan/{id}/rechazar`

**Rechazar una solicitud de plan**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "13",
  "estado": "RECHAZADA"
}
```

### Clientes

Errores propios del módulo (estas fases usan el `code` genérico del estado HTTP; se distinguen por el `detail`):

- 409 · teléfono ya registrado en el local · cuenta ya vinculada a otro cliente
- 404 · cliente no encontrado · "No existe una cuenta con ese correo."
- 400 · `cursor` inválido · `venceEl` en el pasado · "No hay nada que actualizar."

#### `GET /v1/clientes`

**Buscar clientes por nombre o teléfono**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Query:** `q`, `limit`, `cursor`

Paginación por cursor (máximo 50). Incluye almuerzos disponibles.

Response `200`:

```json
{
  "items": [
    {
      "id": "195",
      "nombre": "Ana Mora",
      "telefono": null,
      "correo": null,
      "nota": null,
      "activo": true,
      "vinculadoApp": true,
      "almuerzosDisponibles": 4,
      "proximoVencimiento": "2026-11-18"
    }
  ],
  "nextCursor": null
}
```

#### `POST /v1/clientes`

**Crear un cliente**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Teléfono en E.164; repetido en el mismo restaurante → 409.

Request:

```json
{
  "nombre": "Juan Pérez",
  "telefono": "+593987654321",
  "nota": "Almuerza a las 13:00"
}
```

Response `201`:

```json
{
  "id": "196",
  "nombre": "Juan Pérez",
  "telefono": "+593987654321",
  "correo": null,
  "nota": "Almuerza a las 13:00",
  "activo": true,
  "vinculadoApp": false,
  "almuerzosDisponibles": 0,
  "proximoVencimiento": null,
  "planes": []
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`     | Ejemplo de `detail`                                        |
| ---- | ---------- | ---------------------------------------------------------- |
| 409  | `CONFLICT` | Ya existe un cliente con ese teléfono en este restaurante. |

#### `GET /v1/clientes/{id}`

**Ficha del cliente con todos sus planes**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Response `200`:

```json
{
  "id": "195",
  "nombre": "Ana Mora",
  "telefono": null,
  "correo": null,
  "nota": null,
  "activo": true,
  "vinculadoApp": true,
  "almuerzosDisponibles": 4,
  "proximoVencimiento": "2026-11-18",
  "planes": [
    {
      "id": "22d016e4-b99b-4c1d-8673-94690d057463",
      "cliente": {
        "id": "195",
        "nombre": "Ana Mora"
      },
      "planId": "171",
      "origen": "VENTA",
      "nombrePlan": "Plan semanal",
      "almuerzosTotales": 5,
      "almuerzosRestantes": 4,
      "precioPagadoCentavos": 1500,
      "precioUnitarioCentavos": 300,
      "monedaCodigo": "USD",
      "diasValidos": [1],
      "compradaEn": "2026-11-13T03:47:36.505Z",
      "venceEl": "2026-11-18",
      "estado": "ACTIVA",
      "anuladaEn": null,
      "anotacion": null,
      "pago": {
        "id": "7cb86c27-d969-4f8a-b903-1dbeb9efc85c",
        "estado": "CONFIRMADO",
        "metodo": "EFECTIVO",
        "montoCentavos": 1500,
        "fecha": "2026-11-12",
        "comprobanteUrl": null,
        "reverso": null
      }
    }
  ]
}
```

#### `PATCH /v1/clientes/{id}`

**Editar o desactivar un cliente**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request:

```json
{
  "nota": "Prefiere sin ají"
}
```

Response `200`:

```json
{
  "id": "196",
  "nombre": "Juan Pérez",
  "telefono": "+593987654321",
  "correo": null,
  "nota": "Prefiere sin ají",
  "activo": true,
  "vinculadoApp": false,
  "almuerzosDisponibles": 0,
  "proximoVencimiento": null,
  "planes": []
}
```

#### `POST /v1/clientes/{id}/migrar-cartulina`

**Migrar el saldo de una cartulina de papel**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Crea un plan de origen MIGRADA, sin cobro.

Request:

```json
{
  "almuerzosRestantes": 7,
  "venceEl": "2026-12-15",
  "precioUnitarioCentavos": 300
}
```

Response `201`:

```json
{
  "id": "196",
  "nombre": "Juan Pérez",
  "telefono": "+593987654321",
  "correo": null,
  "nota": "Prefiere sin ají",
  "activo": true,
  "vinculadoApp": false,
  "almuerzosDisponibles": 7,
  "proximoVencimiento": "2026-12-15",
  "planes": [
    {
      "id": "dc0cffbe-aaae-4906-ad28-096fa29b0e8c",
      "cliente": {
        "id": "196",
        "nombre": "Juan Pérez"
      },
      "planId": null,
      "origen": "MIGRADA",
      "nombrePlan": "Cartulina migrada",
      "almuerzosTotales": 7,
      "almuerzosRestantes": 7,
      "precioPagadoCentavos": 2100,
      "precioUnitarioCentavos": 300,
      "monedaCodigo": "USD",
      "diasValidos": [1],
      "compradaEn": "2026-11-13T03:49:42.335Z",
      "venceEl": "2026-12-15",
      "estado": "ACTIVA",
      "anuladaEn": null,
      "anotacion": null,
      "pago": null
    }
  ]
}
```

#### `POST /v1/clientes/{id}/vincular`

**Vincular el cliente con su cuenta de la app**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Por el correo de la cuenta. Límite de intentos por hora.

Request:

```json
{
  "correo": "luis@ejemplo.com"
}
```

Response `200`:

```json
{
  "id": "196",
  "nombre": "Juan Pérez",
  "telefono": "+593987654321",
  "correo": null,
  "nota": "Prefiere sin ají",
  "activo": true,
  "vinculadoApp": true,
  "almuerzosDisponibles": 7,
  "proximoVencimiento": "2026-12-15",
  "planes": [
    {
      "id": "dc0cffbe-aaae-4906-ad28-096fa29b0e8c",
      "cliente": {
        "id": "196",
        "nombre": "Juan Pérez"
      },
      "planId": null,
      "origen": "MIGRADA",
      "nombrePlan": "Cartulina migrada",
      "almuerzosTotales": 7,
      "almuerzosRestantes": 7,
      "precioPagadoCentavos": 2100,
      "precioUnitarioCentavos": 300,
      "monedaCodigo": "USD",
      "diasValidos": [1],
      "compradaEn": "2026-11-13T03:49:42.335Z",
      "venceEl": "2026-12-15",
      "estado": "ACTIVA",
      "anuladaEn": null,
      "anotacion": null,
      "pago": null
    }
  ]
}
```

#### `POST /v1/clientes/{id}/desvincular`

**Quitar el vínculo con la cuenta de la app**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "196",
  "nombre": "Juan Pérez",
  "telefono": "+593987654321",
  "correo": null,
  "nota": "Prefiere sin ají",
  "activo": true,
  "vinculadoApp": false,
  "almuerzosDisponibles": 7,
  "proximoVencimiento": "2026-12-15",
  "planes": [
    {
      "id": "dc0cffbe-aaae-4906-ad28-096fa29b0e8c",
      "cliente": {
        "id": "196",
        "nombre": "Juan Pérez"
      },
      "planId": null,
      "origen": "MIGRADA",
      "nombrePlan": "Cartulina migrada",
      "almuerzosTotales": 7,
      "almuerzosRestantes": 7,
      "precioPagadoCentavos": 2100,
      "precioUnitarioCentavos": 300,
      "monedaCodigo": "USD",
      "diasValidos": [1],
      "compradaEn": "2026-11-13T03:49:42.335Z",
      "venceEl": "2026-12-15",
      "estado": "ACTIVA",
      "anuladaEn": null,
      "anotacion": null,
      "pago": null
    }
  ]
}
```

### Caja y pase (checkout)

Errores propios del módulo (estas fases usan el `code` genérico del estado HTTP; se distinguen por el `detail`):

- 400 · enviar `codigoQr` y `clienteId` juntos o ninguno · `mesaLocalId` inexistente · venta con total 0, ítem LIBRE sin nombre/precio, plato sin precio o método de pago no disponible
- 404 · cliente, validación, venta, mesa, reclamo o cierre no encontrado
- 409 · `Idempotency-Key` ya usada para otro cliente u operación · referencia de pago repetida · mesa que no está abierta · caja ya cerrada · reclamo ya resuelto · almuerzo ya devuelto
- 403 · el cajero solo puede cerrar la caja de hoy o deshacer ventas del mismo día

#### `GET /v1/pase/codigo`

**Código QR del comensal (cambia cada 30 segundos)**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** Estable
- **Query:** `restaurante`

La app lo pide de nuevo cuando vence. Con `restaurante` el código solo vale en ese local y el local debe haber publicado el menú de hoy (409 `MENU_NO_PUBLICADO`).

> El código dura 30 s: pedir uno nuevo antes de que expire (`expiraEn`). Con `?restaurante=` solo vale en ese local y exige el menú de hoy publicado (fecha local del restaurante). Sin `restaurante` el código no es de un local concreto y se emite igual; la regla se aplica al canjear en `POST /v1/caja/validar`.

Response `200`:

```json
{
  "codigo": "BCD1.14e792c7-edf3-4407-8729-f4a80c39a6a3.a108d856-5d0e-4e0c-a36a-e8e5b855d1f4.gSKCeMRQoK5dSIl2ihVRdN",
  "validoSegundos": 30,
  "expiraEn": "2026-11-13T03:48:00.000Z"
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                      | Ejemplo de `detail`                           |
| ---- | --------------------------- | --------------------------------------------- |
| 404  | `RESTAURANTE_NO_ENCONTRADO` | Restaurante no encontrado.                    |
| 409  | `MENU_NO_PUBLICADO`         | El restaurante aún no publicó el menú de hoy. |

#### `POST /v1/pase/rotar`

**Invalidar todos mis códigos anteriores**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** Estable

Para un teléfono perdido o una captura de pantalla compartida.

Request: sin cuerpo (no envíes `content-type`).

Response `204`:

Sin cuerpo.

#### `GET /v1/pase/eventos`

**Eventos del pase en tiempo real (Server-Sent Events)**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (rama `feat/pase-eventos`)
- **Respuesta:** `text/event-stream` (conexión abierta)

Avisa a la app del comensal en cuanto la caja descuenta o devuelve un almuerzo, sin recargar: con `saldoRestante` la app actualiza el saldo de ese local y vuelve a pedir el código. Solo llegan los eventos del usuario del token. Flujo completo, garantías y límites en [`qr-flujo.md`](./qr-flujo.md).

| `event:`           | `data` (JSON)                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `CANJE_REGISTRADO` | `tipo`, `consumoId` (UUID), `restauranteNombre`, `saldoRestante` (entero), `platoNombre` (`string \| null`), `hora` (ISO) |
| `CANJE_REVERTIDO`  | `tipo`, `consumoId` (el consumo deshecho), `restauranteNombre`, `saldoRestante`, `hora`                                   |
| `LATIDO`           | `hora`; cada 20 s                                                                                                         |
| `FIN`              | `motivo`: `REEMPLAZADA` (no reconectar sola), `TOKEN_VENCIDO` (refresh y reconectar) o `APAGADO` (reconectar)             |

Response `200` (`text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Accel-Buffering: no`):

```text
retry: 5000
: conectado

event: CANJE_REGISTRADO
data: {"tipo":"CANJE_REGISTRADO","consumoId":"62fb9399-5082-4571-9169-55b77c49e676","restauranteNombre":"La Sazón","saldoRestante":4,"platoNombre":null,"hora":"2026-11-13T17:00:00.000Z"}

event: LATIDO
data: {"hora":"2026-11-13T17:00:20.000Z"}
```

Errores posibles (además de los comunes: 401, 429, 5xx):

| HTTP | `code`             | Ejemplo de `detail`                                                      |
| ---- | ------------------ | ------------------------------------------------------------------------ |
| 503  | `EVENTOS_SATURADO` | No hay lugar para más conexiones de eventos. Reintenta en unos segundos. |

> Máximo **2 conexiones por usuario** (la 3.ª cierra la más vieja con `FIN` `REEMPLAZADA`) y un tope por instancia (`PASS_EVENTS_MAX_CONNECTIONS`, 1000). Sin historial: al conectar o reconectar, pedir `GET /v1/pase`. Cada reconexión cuenta en el rate limit general (120/min por IP); `retry: 5000` lo respeta. **Solo una instancia** de la API: con varias, ver "Límite: una sola instancia" en `qr-flujo.md`.

#### `POST /v1/caja/validar`

**Validar un almuerzo por QR o por búsqueda manual**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Idempotency-Key:** obligatoria (UUID)

Siempre responde 200 con un `resultado`, salvo 409 `MENU_NO_PUBLICADO` si el local no publicó el menú de hoy (fecha local del local). Descuenta del plan que vence primero (FIFO). Resultados: **OK**: Almuerzo descontado. · **OK_ADVERTENCIA**: Almuerzo descontado. Es el último o el plan vence pronto: ofrece renovar. · **DUPLICADO**: Este comensal ya fue validado hace menos de un minuto. No se descontó otra vez. · **SIN_PLAN**: No tiene un plan en este restaurante. · **SIN_SALDO**: Su plan ya no tiene almuerzos. · **VENCIDO**: Su plan está vencido. · **DIA_NO_VALIDO**: Su plan no vale hoy. · **OTRO_LOCAL**: Ese código es de otro restaurante. · **QR_EXPIRADO**: El código venció. Pídele que actualice su pase. · **QR_INVALIDO**: Código no válido. · **LIMITE_SAAS**: El restaurante alcanzó el límite de validaciones de su plan Bocadoo.

> Responde **siempre 200** con un `resultado`; "sin saldo", "duplicado" o "QR vencido" no son errores HTTP. Se manda `codigoQr` o `clienteId` (uno solo; si no, 400).

Request:

```json
{
  "codigoQr": "BCD1.14e792c7-edf3-4407-8729-f4a80c39a6a3.a108d856-5d0e-4e0c-a36a-e8e5b855d1f4.gSKCeMRQoK5dSIl2ihVRdN"
}
```

Response `200`:

```json
{
  "resultado": "OK",
  "mensaje": "Almuerzo descontado.",
  "descontado": true,
  "consumo": {
    "id": "62fb9399-5082-4571-9169-55b77c49e676",
    "creadoEn": "2026-11-13T03:47:36.549Z",
    "deshacerHasta": "2026-11-13T03:47:46.549Z"
  },
  "plan": {
    "nombre": "Plan semanal",
    "venceEl": "2026-11-18"
  },
  "almuerzosRestantes": 4,
  "diasParaVencer": 6,
  "platoNombre": null,
  "cliente": {
    "id": "195",
    "nombre": "Ana Mora"
  }
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                     | Ejemplo de `detail`                                        |
| ---- | -------------------------- | ---------------------------------------------------------- |
| 400  | `IDEMPOTENCY_KEY_INVALIDA` | Falta el encabezado Idempotency-Key (UUID) o no es válido. |
| 403  | `FORBIDDEN`                | No tienes acceso a este restaurante.                       |
| 409  | `MENU_NO_PUBLICADO`        | El restaurante aún no publicó el menú de hoy.              |

> Sin menú publicado hoy, `validar` (QR o manual) responde 409 **antes** de tocar nada: no descuenta y no registra `intento_escaneo`. `platoNombre` es siempre `null` aquí (un canje directo no tiene preorden). Los pedidos preordenados se canjean por `POST /v1/caja/pedidos/{id}/canjear`.

#### `POST /v1/caja/consumos/{id}/deshacer`

**Deshacer una validación**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Solo en los 10 segundos siguientes; después → 409. Devuelve el almuerzo al plan.

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "6c24d679-3ddf-4ac2-a021-a031d1d0898f",
  "revertido": true
}
```

#### `GET /v1/caja/mesas/{id}`

**Vista previa de una mesa compartida**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Quiénes vienen, quién paga y cuántos almuerzos cubren los planes.

> **Novedad (PR 3):** `miembros[].cotizacion` y `cotizacion` de la mesa; `cubiertos` y `almuerzosDisponibles` ahora cuentan `dias_validos` (INC-12). Ver [Novedades](#novedades).

Response `200`:

```json
{
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "validadaEn": null,
  "personas": 2,
  "cubiertos": 1,
  "miembros": [
    {
      "nombre": "Ana Mora",
      "esAnfitrion": true,
      "paraLlevar": false,
      "tieneCuenta": true,
      "almuerzosDisponibles": 3,
      "seleccion": {
        "almuerzo": { "platos": [{ "id": "…", "nombre": "Seco de pollo", "seccion": "FUERTE" }] },
        "extras": [{ "id": "…", "nombre": "Cola", "categoria": "BEBIDA", "cantidad": 1 }]
      }
    }
  ]
}
```

`miembros[].seleccion` (nuevo, solo lectura para el personal): lo que eligió cada miembro con `PUT /v1/mis/mesas/{id}/seleccion`; vacía si aún no eligió. También sale en la respuesta de `POST /v1/caja/mesas/{id}/validar`. Es informativa: no cambia cómo se descuentan los planes ni genera cobro de extras.

#### `POST /v1/caja/mesas/{id}/validar`

**Validar toda la mesa de una vez**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Idempotency-Key:** obligatoria (UUID)

CADA_UNO: cada quien con su plan. INVITO_YO: paga el anfitrión. Sin plan → por cobrar.

Request: sin cuerpo (no envíes `content-type`).

> **Novedad (PR 3):** suma `cotizacion` y `miembros[].cotizacion` informativas (cada miembro con 1 almuerzo y su `paraLlevar`). Los descuentos, `descontados` y `porCobrar` no cambian. Ver [Novedades](#novedades).

Response `200`:

```json
{
  "modo": "CADA_UNO",
  "estado": "EN_MESA",
  "horaLlegada": "2026-11-13T04:39:00.000Z",
  "validadaEn": "2026-11-13T03:49:45.449Z",
  "personas": 2,
  "cubiertos": 2,
  "miembros": [
    {
      "nombre": "Ana Mora",
      "esAnfitrion": true,
      "paraLlevar": false,
      "tieneCuenta": true,
      "almuerzosDisponibles": 3
    }
  ],
  "yaValidada": false,
  "resultados": [
    {
      "miembro": "Ana Mora",
      "resultado": "OK",
      "descontado": true,
      "consumoId": "f38889e0-2ade-4ccc-8323-fd112f8db371"
    }
  ],
  "descontados": 1,
  "porCobrar": 1
}
```

#### `GET /v1/caja/ventas`

**Ventas sueltas de hoy**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Response `200`:

```json
[
  {
    "id": "0e98d6e3-f04b-4875-a60d-ac56fd48c717",
    "ticket": 2,
    "fecha": "2026-11-12",
    "totalCentavos": 750,
    "monedaCodigo": "USD",
    "paraLlevar": true,
    "mesaTexto": null,
    "creadoEn": "2026-11-13T03:49:45.468Z",
    "deshecha": false,
    "pago": {
      "estado": "CONFIRMADO",
      "metodo": "EFECTIVO"
    },
    "items": [
      {
        "nombre": "Almuerzo",
        "esAlmuerzo": true,
        "cantidad": 2,
        "precioUnitarioCentavos": 300,
        "subtotalCentavos": 600
      }
    ]
  }
]
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`      | Ejemplo de `detail`                  |
| ---- | ----------- | ------------------------------------ |
| 403  | `FORBIDDEN` | No tienes acceso a este restaurante. |

#### `GET /v1/caja/movimientos`

**Movimientos del día de la caja**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (nuevo; solo lectura)
- **Query:** `fecha` (`AAAA-MM-DD`, opcional: por defecto **hoy en la zona horaria del restaurante**; una fecha inexistente → 400; la palabra `hoy` no se acepta aquí). **El dueño puede consultar cualquier fecha; el cajero solo hoy** (hora local del restaurante): otra fecha → 403 `CAJERO_SOLO_HOY`, igual que el cierre de caja · `limit` (1–50, por defecto 20) · `cursor` (el `nextCursor` anterior; inválido → 400 `CURSOR_INVALIDO`)

Lista unificada de lo que pasó en caja ese día local, de la hora más reciente a la más antigua. **Reemplaza** la mezcla que hace hoy el frontend en "Cobros de hoy" (`GET /v1/caja/ventas` + `GET /v1/caja/pedidos?estado=SERVIDA` + una lista en memoria de los canjes de `POST /v1/caja/validar`): los canjes directos ahora se recuperan del servidor. Los endpoints anteriores no cambian.

| `tipo`          | Qué es                                                                                        | Fuente                                      | `hora`             | `montoCentavos`              | `medioPago` / `pagoEstado` | `platoNombre`                          | `comensalNombre`                                                    |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------ | ---------------------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `VENTA`         | Venta suelta (`POST /v1/caja/ventas`)                                                         | `venta_pos_cabecera`, día = `fecha_local`   | cuándo se registró | total del ticket             | del pago                   | `null`                                 | `null` (la caja no muestra nombre en las ventas)                    |
| `PEDIDO`        | Preorden canjeada en caja (estado `CANJEADA` o `SERVIDA`)                                     | `orden_cabecera.canjeada_en`, en hora local | cuándo se canjeó   | `totalCentavos` del pedido   | `null`                     | platos del almuerzo unidos con `" + "` | nombre de la cuenta (el mismo `comensal.nombre` de `/caja/pedidos`) |
| `CANJE_DIRECTO` | Almuerzo descontado de un plan por QR o búsqueda manual (`POST /v1/caja/validar`), sin pedido | `consumo_almuerzo` canal `QR` o `MANUAL`    | cuándo se descontó | `null` (ya estaba prepagado) | `null`                     | `null` (no hay preorden)               | nombre del cliente (el mismo `cliente.nombre` de `validar`)         |

Notas:

- No hay tablas ni migraciones nuevas: los tres tipos salen de datos que ya se guardaban. Las validaciones de **mesa** (`canal` `MESA`) y el consumo que crea el canje de un pedido (`PREORDEN`) **no** salen como `CANJE_DIRECTO`: el segundo ya está como `PEDIDO`.
- Una venta deshecha y un consumo revertido salen con `revertido: true` (el reverso no es otra fila) y no cuentan en `resumen`. Un pedido nunca se revierte.
- `PEDIDO.montoCentavos` es el valor de la preorden, **no** dinero cobrado: lo que la caja cobra aparte sale de `porCobrarCentavos` al canjear y, si se cobró, ya es una `VENTA` (por eso `valorPedidosCentavos` no debe sumarse a `ventasConfirmadasCentavos`).
- `resumen` es de **todo el día**, no de la página, y **no mezcla dinero con valor de pedidos**: `ventas.ventasConfirmadasCentavos` es el único dinero cobrado (ventas con pago `CONFIRMADO`; una transferencia `PENDIENTE` cuenta en `ventas.cantidad` pero no suma, y las ventas deshechas no cuentan en nada). `pedidos.valorPedidosCentavos` es el valor de las preórdenes canjeadas, **no** dinero cobrado: no se suma a las ventas. `canjesDirectos` solo tiene `cantidad` (sin los revertidos): no mueven dinero.
- No se expone ningún dato personal que la caja no mostrara ya.

Response `200`:

```json
{
  "fecha": "2026-11-13",
  "zonaHoraria": "America/Guayaquil",
  "monedaCodigo": "USD",
  "resumen": {
    "ventas": { "cantidad": 2, "ventasConfirmadasCentavos": 1050 },
    "pedidos": { "cantidad": 1, "valorPedidosCentavos": 125 },
    "canjesDirectos": { "cantidad": 1 }
  },
  "items": [
    {
      "id": "7d0e1c64-52a0-4b0b-8a43-0f6f1b9e2c11",
      "tipo": "CANJE_DIRECTO",
      "hora": "2026-11-13T17:05:12.000Z",
      "montoCentavos": null,
      "medioPago": null,
      "pagoEstado": null,
      "platoNombre": null,
      "comensalNombre": "Ana Pérez",
      "revertido": false
    },
    {
      "id": "b1070383-90ef-4353-b00d-9019fcf067c2",
      "tipo": "PEDIDO",
      "hora": "2026-11-13T16:48:30.000Z",
      "montoCentavos": 125,
      "medioPago": null,
      "pagoEstado": null,
      "platoNombre": "Sopa de quinua + Seco de pollo",
      "comensalNombre": "Luis Mora",
      "revertido": false
    },
    {
      "id": "0e98d6e3-f04b-4875-a60d-ac56fd48c717",
      "tipo": "VENTA",
      "hora": "2026-11-13T16:20:05.000Z",
      "montoCentavos": 700,
      "medioPago": "EFECTIVO",
      "pagoEstado": "CONFIRMADO",
      "platoNombre": null,
      "comensalNombre": null,
      "revertido": false
    }
  ],
  "nextCursor": "eyJ0IjoiMjAyNi0xMS0xM1QxNjoyMDowNS4xMjM0NTZaIiwicCI6IjNmNmM5YTUyLTFiN2UtNGQwOC05YzM0LTVhOGUwZjIxYjdkNiJ9"
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`            | Ejemplo de `detail`                                                   |
| ---- | ----------------- | --------------------------------------------------------------------- |
| 403  | `CAJERO_SOLO_HOY` | El cajero solo puede consultar los movimientos de hoy.                |
| 400  | `CURSOR_INVALIDO` | cursor inválido.                                                      |
| 403  | `FORBIDDEN`       | No tienes acceso a este restaurante. (quien no es personal del local) |

#### `POST /v1/caja/ventas`

**Registrar una venta suelta (sin plan)**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Idempotency-Key:** obligatoria (UUID)

Los precios de almuerzo y platos los pone el servidor. Efectivo queda confirmado.

Request:

```json
{
  "items": [
    {
      "tipo": "ALMUERZO",
      "cantidad": 2
    }
  ],
  "metodoPago": "EFECTIVO"
}
```

Response `201`:

```json
{
  "id": "e542ebe9-c76c-4033-b192-d62471917c53",
  "ticket": 1,
  "fecha": "2026-11-12",
  "totalCentavos": 600,
  "monedaCodigo": "USD",
  "paraLlevar": false,
  "mesaTexto": null,
  "creadoEn": "2026-11-13T03:48:39.770Z",
  "deshecha": false,
  "pago": {
    "estado": "CONFIRMADO",
    "metodo": "EFECTIVO"
  },
  "items": [
    {
      "nombre": "Almuerzo",
      "esAlmuerzo": true,
      "cantidad": 2,
      "precioUnitarioCentavos": 300,
      "subtotalCentavos": 600
    }
  ]
}
```

#### `POST /v1/caja/ventas/{id}/deshacer`

**Deshacer una venta suelta**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Idempotency-Key:** obligatoria (UUID)

Registra una venta y un pago inversos. El cajero, solo las del mismo día.

Request:

```json
{}
```

Response `200`:

```json
{
  "id": "d8cc873b-1525-4f5d-975c-f5dd9deef985",
  "ticket": 3,
  "fecha": "2026-11-12",
  "totalCentavos": 300,
  "monedaCodigo": "USD",
  "paraLlevar": false,
  "mesaTexto": null,
  "creadoEn": "2026-11-13T03:49:45.520Z",
  "deshecha": true,
  "pago": {
    "estado": "CONFIRMADO",
    "metodo": "TRANSFERENCIA"
  },
  "items": [
    {
      "nombre": "Almuerzo",
      "esAlmuerzo": true,
      "cantidad": 1,
      "precioUnitarioCentavos": 300,
      "subtotalCentavos": 300
    }
  ]
}
```

#### `GET /v1/caja/cierre/{fecha}`

**Arqueo del día: lo esperado por método de pago y el cierre, si existe**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Efectivo esperado = cobros confirmados en efectivo del día (planes + ventas sueltas + pedidos + ofertas), menos reversos.

> `{fecha}` es `hoy` o `AAAA-MM-DD`.

Response `200`:

```json
{
  "fecha": "2026-11-12",
  "efectivoEsperadoCentavos": 2100,
  "totalCentavos": 2100,
  "porMetodo": [
    {
      "metodo": "EFECTIVO",
      "nombre": "Efectivo",
      "esEfectivo": true,
      "planesCentavos": 1500,
      "posCentavos": 600,
      "totalCentavos": 2100
    }
  ],
  "almuerzosServidos": 3,
  "almuerzosConPlan": 1,
  "almuerzosSueltos": 2,
  "almuerzosParaLlevar": 0,
  "pagosPendientes": 0,
  "cierre": null
}
```

#### `POST /v1/caja/cierre/{fecha}`

**Cerrar la caja**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Un solo cierre activo por día (repetir → 409). El cajero solo cierra el día de hoy.

Request:

```json
{
  "efectivoContadoCentavos": 900,
  "nota": "Cuadra con lo esperado"
}
```

Response `201`:

```json
{
  "fecha": "2026-11-12",
  "efectivoEsperadoCentavos": 2850,
  "totalCentavos": 4350,
  "porMetodo": [
    {
      "metodo": "EFECTIVO",
      "nombre": "Efectivo",
      "esEfectivo": true,
      "planesCentavos": 1500,
      "posCentavos": 1350,
      "totalCentavos": 2850
    }
  ],
  "almuerzosServidos": 9,
  "almuerzosConPlan": 5,
  "almuerzosSueltos": 4,
  "almuerzosParaLlevar": 2,
  "pagosPendientes": 0,
  "cierre": {
    "efectivoEsperadoCentavos": 2850,
    "efectivoContadoCentavos": 900,
    "diferenciaCentavos": -1950,
    "nota": "Cuadra con lo esperado",
    "cerradoEn": "2026-11-13T03:49:45.591Z",
    "cerradoPor": "Carlos",
    "movimientosDespuesDelCierre": false
  }
}
```

#### `POST /v1/caja/cierre/{fecha}/reabrir`

**Reabrir la caja de un día**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

El cierre anterior queda en el historial.

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "fecha": "2026-11-12",
  "efectivoEsperadoCentavos": 2850,
  "totalCentavos": 4350,
  "porMetodo": [
    {
      "metodo": "EFECTIVO",
      "nombre": "Efectivo",
      "esEfectivo": true,
      "planesCentavos": 1500,
      "posCentavos": 1350,
      "totalCentavos": 2850
    }
  ],
  "almuerzosServidos": 9,
  "almuerzosConPlan": 5,
  "almuerzosSueltos": 4,
  "almuerzosParaLlevar": 2,
  "pagosPendientes": 0,
  "cierre": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`      | Ejemplo de `detail`            |
| ---- | ----------- | ------------------------------ |
| 403  | `FORBIDDEN` | Tu rol no permite esta acción. |

#### `GET /v1/reclamos`

**Reclamos de comensales sobre un almuerzo**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable
- **Query:** `estado` (PENDIENTE, DEVUELTO, RECHAZADO)

Por defecto, los pendientes.

Response `200`:

```json
[
  {
    "id": "26",
    "estado": "PENDIENTE",
    "mensaje": "Me descontaron el almuerzo pero ese día no fui.",
    "respuesta": null,
    "creadoEn": "2026-11-13T03:48:39.639Z",
    "resueltoEn": null,
    "cliente": {
      "id": "195",
      "nombre": "Ana Mora"
    },
    "consumo": {
      "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
      "fecha": "2026-11-13T03:18:39.060Z",
      "canal": "PREORDEN",
      "plan": "Plan semanal"
    }
  }
]
```

#### `POST /v1/reclamos/{id}/devolver`

**Aceptar el reclamo y devolver el almuerzo al plan**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request:

```json
{
  "respuesta": "Tienes razón, te devolvimos el almuerzo."
}
```

Response `200`:

```json
{
  "id": "26",
  "estado": "DEVUELTO",
  "mensaje": "Me descontaron el almuerzo pero ese día no fui.",
  "respuesta": "Tienes razón, te devolvimos el almuerzo.",
  "creadoEn": "2026-11-13T03:48:39.639Z",
  "resueltoEn": "2026-11-13T03:48:39.686Z",
  "cliente": {
    "id": "195",
    "nombre": "Ana Mora"
  },
  "consumo": {
    "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
    "fecha": "2026-11-13T03:18:39.060Z",
    "canal": "PREORDEN",
    "plan": "Plan semanal"
  }
}
```

#### `POST /v1/reclamos/{id}/rechazar`

**Rechazar el reclamo con una explicación**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** Estable

Request:

```json
{
  "respuesta": "El almuerzo sí se sirvió ese día."
}
```

Response `200`:

```json
{
  "id": "27",
  "estado": "RECHAZADO",
  "mensaje": "Ese día no estuve en el local.",
  "respuesta": "El almuerzo sí se sirvió ese día.",
  "creadoEn": "2026-11-13T03:49:43.088Z",
  "resueltoEn": "2026-11-13T03:49:43.123Z",
  "cliente": {
    "id": "198",
    "nombre": "Luis Pérez"
  },
  "consumo": {
    "id": "5648e87e-ce09-4ae2-9c7f-bdaf300e1604",
    "fecha": "2026-11-13T03:19:42.649Z",
    "canal": "MANUAL",
    "plan": "Plan semanal"
  }
}
```

### Fase 8 · Pase del comensal

#### `GET /v1/pase`

**Pase del comensal: QR rotativo y planes vigentes por local**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Query:** `restaurante`

El código cambia cada 30 segundos (`codigo.expiraEn`); la app vuelve a pedir el pase o `GET /v1/pase/codigo` cuando vence. Con `restaurante` el código solo vale en ese local. Solo se listan planes activos y no vencidos, en orden FIFO. Con `restaurante`, 409 `MENU_NO_PUBLICADO` si el local no publicó el menú de hoy.

> Incluye el código sin restaurante (`BCD1.<usuario>.0.<mac>`) y los planes vigentes por local. `hoy` es la fecha local de cada restaurante.

Response `200`:

```json
{
  "usuario": {
    "id": "14e792c7-edf3-4407-8729-f4a80c39a6a3",
    "nombre": "Ana Mora"
  },
  "codigo": {
    "codigo": "BCD1.14e792c7-edf3-4407-8729-f4a80c39a6a3.0.BMGSjvmIum-NrDTP3tCh1r",
    "validoSegundos": 30,
    "expiraEn": "2026-11-13T03:48:00.000Z"
  },
  "locales": [
    {
      "restaurante": {
        "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
        "nombre": "Doña Rosa",
        "slug": "dona-rosa-23902c",
        "logoUrl": null
      },
      "hoy": "2026-11-12",
      "almuerzosDisponibles": 5,
      "planes": [
        {
          "id": "22d016e4-b99b-4c1d-8673-94690d057463",
          "nombre": "Plan semanal",
          "almuerzosRestantes": 5,
          "almuerzosTotales": 5,
          "venceEl": "2026-11-18",
          "diasParaVencer": 6,
          "diasValidos": [1],
          "valeHoy": true
        }
      ]
    }
  ]
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                      | Ejemplo de `detail` |
| ---- | --------------------------- | ------------------- |
| 404  | `RESTAURANTE_NO_ENCONTRADO` | —                   |

### Fase 8 · Historial de almuerzos

#### `GET /v1/mis/consumos`

**Mis almuerzos consumidos (todos los locales)**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Query:** `limit`, `cursor`, `restaurante`

Del más reciente al más antiguo, con paginación por cursor (máximo 50 por página).

> Paginación por cursor (`nextCursor`). Filtro opcional `restaurante` (UUID).

Response `200`:

```json
{
  "items": [
    {
      "id": "62fb9399-5082-4571-9169-55b77c49e676",
      "fecha": "2026-11-13T03:47:36.549Z",
      "fechaLocal": "2026-11-12",
      "restaurante": {
        "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
        "nombre": "Doña Rosa",
        "slug": "dona-rosa-23902c"
      },
      "plan": {
        "id": "22d016e4-b99b-4c1d-8673-94690d057463",
        "nombre": "Plan semanal"
      },
      "canal": "QR",
      "paraLlevar": false,
      "revertido": false,
      "revertidoEn": null
    }
  ],
  "nextCursor": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`            | Ejemplo de `detail` |
| ---- | ----------------- | ------------------- |
| 400  | `CURSOR_INVALIDO` | —                   |

#### `GET /v1/mis/consumos/{id}`

**Un almuerzo consumido**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Response `200`:

```json
{
  "id": "6c24d679-3ddf-4ac2-a021-a031d1d0898f",
  "fecha": "2026-11-13T03:49:42.576Z",
  "fechaLocal": "2026-11-12",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "plan": {
    "id": "4a17f54f-88e3-40fb-9e9f-a3662649548f",
    "nombre": "Plan semanal"
  },
  "canal": "QR",
  "paraLlevar": false,
  "revertido": true,
  "revertidoEn": "2026-11-13T03:49:42.625Z"
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                  | Ejemplo de `detail`    |
| ---- | ----------------------- | ---------------------- |
| 404  | `CONSUMO_NO_ENCONTRADO` | Consumo no encontrado. |

### Fase 8 · Pedidos (preórdenes)

#### `POST /v1/mis/pedidos`

**Hacer una preorden del menú de hoy**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Idempotency-Key:** obligatoria (UUID)

El pedido vence a los 30 minutos. Su QR es el public_id (`qr`): la caja lo escanea y descuenta el almuerzo del plan. Precios del servidor: el almuerzo vale 0 si un plan vigente lo cubre, si no el precio suelto del local. Un pedido en camino a la vez por local.

> `almuerzo.platos` y `extras[].plato` son los `id` (UUID) del menú de hoy en la vitrina. El precio lo calcula el servidor. Un pedido activo por local; vence a los 30 minutos. `qr` es el mismo `id`.

Request:

```json
{
  "restaurante": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "paraLlevar": false,
  "almuerzo": {
    "platos": ["41c0703f-3521-48eb-98ec-6d6d8efd5979"]
  },
  "extras": [
    {
      "plato": "df24243e-cc29-406a-94fd-fde6bf11d38e",
      "cantidad": 1
    }
  ]
}
```

> **Novedad (PR 3):** la respuesta suma `cotizacion` (ver [Novedades](#novedades)). `totalCentavos` y `recargoLlevarCentavos` no cambian. Para saber el total antes de pedir: `POST /v1/mis/pedidos/cotizar`.

Response `201`:

```json
{
  "id": "b1070383-90ef-4353-b00d-9019fcf067c2",
  "qr": "b1070383-90ef-4353-b00d-9019fcf067c2",
  "numero": 1,
  "fecha": "2026-11-12",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "estado": "EN_CAMINO",
  "paraLlevar": false,
  "almuerzo": {
    "platos": [
      {
        "id": "41c0703f-3521-48eb-98ec-6d6d8efd5979",
        "nombre": "Sopa de quinua",
        "seccion": "SOPA"
      }
    ],
    "precioCentavos": 0,
    "cubiertoPorPlan": true
  },
  "extras": [
    {
      "id": "df24243e-cc29-406a-94fd-fde6bf11d38e",
      "nombre": "Porción de aguacate",
      "cantidad": 1,
      "precioUnitarioCentavos": 75,
      "subtotalCentavos": 75
    }
  ],
  "recargoLlevarCentavos": 0,
  "totalCentavos": 75,
  "monedaCodigo": "USD",
  "creadoEn": "2026-11-13T03:48:38.964Z",
  "venceEn": "2026-11-13T04:18:38.964Z",
  "canjeadoEn": null,
  "servidoEn": null,
  "canceladoEn": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                        | Ejemplo de `detail`                               |
| ---- | ----------------------------- | ------------------------------------------------- |
| 400  | `ALMUERZO_INVALIDO`           | —                                                 |
| 400  | `IDEMPOTENCY_KEY_INVALIDA`    | —                                                 |
| 400  | `PEDIDO_VACIO`                | Pide un almuerzo, extras o ambos.                 |
| 404  | `RESTAURANTE_NO_ENCONTRADO`   | —                                                 |
| 409  | `IDEMPOTENCY_KEY_REUTILIZADA` | —                                                 |
| 409  | `LOCAL_LLENO_SOLO_LLEVAR`     | Local lleno y la preorden no es para llevar       |
| 409  | `MENU_NO_PUBLICADO`           | —                                                 |
| 409  | `PEDIDO_ACTIVO`               | Ya tienes un pedido en camino a este restaurante. |
| 409  | `PLATO_AGOTADO`               | —                                                 |
| 409  | `RESTAURANTE_PAUSADO`         | El local está pausado                             |
| 422  | `PLATO_NO_DISPONIBLE`         | —                                                 |
| 422  | `PLATO_SIN_PRECIO`            | —                                                 |

#### `GET /v1/mis/pedidos`

**Mis pedidos, del más reciente al más antiguo**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Query:** `limit`, `cursor`

> **Novedad (PR 3):** cada pedido suma `cotizacion` (ver [Novedades](#novedades)).

Response `200`:

```json
{
  "items": [
    {
      "id": "b1070383-90ef-4353-b00d-9019fcf067c2",
      "qr": "b1070383-90ef-4353-b00d-9019fcf067c2",
      "numero": 1,
      "fecha": "2026-11-12",
      "restaurante": {
        "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
        "nombre": "Doña Rosa",
        "slug": "dona-rosa-23902c"
      },
      "estado": "EN_CAMINO",
      "paraLlevar": false,
      "almuerzo": {
        "platos": [
          {
            "id": "41c0703f-3521-48eb-98ec-6d6d8efd5979",
            "nombre": "Sopa de quinua",
            "seccion": "SOPA"
          }
        ],
        "precioCentavos": 0,
        "cubiertoPorPlan": true
      },
      "extras": [
        {
          "id": "df24243e-cc29-406a-94fd-fde6bf11d38e",
          "nombre": "Porción de aguacate",
          "cantidad": 1,
          "precioUnitarioCentavos": 75,
          "subtotalCentavos": 75
        }
      ],
      "recargoLlevarCentavos": 0,
      "totalCentavos": 75,
      "monedaCodigo": "USD",
      "creadoEn": "2026-11-13T03:48:38.964Z",
      "venceEn": "2026-11-13T04:18:38.964Z",
      "canjeadoEn": null,
      "servidoEn": null,
      "canceladoEn": null
    }
  ],
  "nextCursor": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`            | Ejemplo de `detail` |
| ---- | ----------------- | ------------------- |
| 400  | `CURSOR_INVALIDO` | —                   |

#### `GET /v1/mis/pedidos/{id}`

**Un pedido mío**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

> **Novedad (PR 3):** suma `cotizacion` (ver [Novedades](#novedades)).

Response `200`:

```json
{
  "id": "b1070383-90ef-4353-b00d-9019fcf067c2",
  "qr": "b1070383-90ef-4353-b00d-9019fcf067c2",
  "numero": 1,
  "fecha": "2026-11-12",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "estado": "EN_CAMINO",
  "paraLlevar": false,
  "almuerzo": {
    "platos": [
      {
        "id": "41c0703f-3521-48eb-98ec-6d6d8efd5979",
        "nombre": "Sopa de quinua",
        "seccion": "SOPA"
      }
    ],
    "precioCentavos": 0,
    "cubiertoPorPlan": true
  },
  "extras": [
    {
      "id": "df24243e-cc29-406a-94fd-fde6bf11d38e",
      "nombre": "Porción de aguacate",
      "cantidad": 1,
      "precioUnitarioCentavos": 75,
      "subtotalCentavos": 75
    }
  ],
  "recargoLlevarCentavos": 0,
  "totalCentavos": 75,
  "monedaCodigo": "USD",
  "creadoEn": "2026-11-13T03:48:38.964Z",
  "venceEn": "2026-11-13T04:18:38.964Z",
  "canjeadoEn": null,
  "servidoEn": null,
  "canceladoEn": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                 | Ejemplo de `detail`   |
| ---- | ---------------------- | --------------------- |
| 404  | `PEDIDO_NO_ENCONTRADO` | Pedido no encontrado. |

#### `POST /v1/mis/pedidos/{id}/cancelar`

**Cancelar mi pedido mientras está en camino**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "13c82d34-68e0-47b0-ab8b-f3d8bc7df9b9",
  "qr": "13c82d34-68e0-47b0-ab8b-f3d8bc7df9b9",
  "numero": 2,
  "fecha": "2026-11-12",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "estado": "CANCELADA",
  "paraLlevar": false,
  "almuerzo": {
    "platos": [
      {
        "id": "41c0703f-3521-48eb-98ec-6d6d8efd5979",
        "nombre": "Sopa de quinua",
        "seccion": "SOPA"
      }
    ],
    "precioCentavos": 0,
    "cubiertoPorPlan": true
  },
  "extras": [],
  "recargoLlevarCentavos": 0,
  "totalCentavos": 0,
  "monedaCodigo": "USD",
  "creadoEn": "2026-11-13T03:49:44.299Z",
  "venceEn": "2026-11-13T04:19:44.299Z",
  "canjeadoEn": null,
  "servidoEn": null,
  "canceladoEn": "2026-11-13T03:49:44.322Z"
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                 | Ejemplo de `detail`                |
| ---- | ---------------------- | ---------------------------------- |
| 404  | `PEDIDO_NO_ENCONTRADO` | —                                  |
| 409  | `PEDIDO_EXPIRADO`      | —                                  |
| 409  | `PEDIDO_NO_CANCELABLE` | El pedido ya fue canjeado en caja. |

#### `GET /v1/caja/pedidos`

**Preórdenes de hoy**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Query:** `estado` (ACTIVOS, EN_CAMINO, CANJEADA, SERVIDA, EXPIRADA, CANCELADA, TODOS)

Por defecto las activas, en orden de número ("Pedido #N").

> **Novedad (PR 3):** cada pedido suma `cotizacion`; `cliente.almuerzosDisponibles` ahora cuenta `dias_validos` (INC-12). Ver [Novedades](#novedades).

Response `200`:

```json
[
  {
    "id": "b1070383-90ef-4353-b00d-9019fcf067c2",
    "qr": "b1070383-90ef-4353-b00d-9019fcf067c2",
    "numero": 1,
    "fecha": "2026-11-12",
    "restaurante": {
      "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
      "nombre": "Doña Rosa",
      "slug": "dona-rosa-23902c"
    },
    "estado": "EN_CAMINO",
    "paraLlevar": false,
    "almuerzo": {
      "platos": [
        {
          "id": "41c0703f-3521-48eb-98ec-6d6d8efd5979",
          "nombre": "Sopa de quinua",
          "seccion": "SOPA"
        }
      ],
      "precioCentavos": 0,
      "cubiertoPorPlan": true
    },
    "extras": [
      {
        "id": "df24243e-cc29-406a-94fd-fde6bf11d38e",
        "nombre": "Porción de aguacate",
        "cantidad": 1,
        "precioUnitarioCentavos": 75,
        "subtotalCentavos": 75
      }
    ],
    "recargoLlevarCentavos": 0,
    "totalCentavos": 75,
    "monedaCodigo": "USD",
    "creadoEn": "2026-11-13T03:48:38.964Z",
    "venceEn": "2026-11-13T04:18:38.964Z",
    "canjeadoEn": null,
    "servidoEn": null,
    "canceladoEn": null,
    "comensal": {
      "nombre": "Ana Mora"
    },
    "cliente": {
      "nombre": "Ana Mora",
      "almuerzosDisponibles": 4
    }
  }
]
```

#### `GET /v1/caja/pedidos/{id}`

**Ver un pedido por su QR (public_id)**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)

> **Novedad (PR 3):** suma `cotizacion`; `cliente.almuerzosDisponibles` ahora cuenta `dias_validos` (INC-12). Ver [Novedades](#novedades).

Response `200`:

```json
{
  "id": "b1070383-90ef-4353-b00d-9019fcf067c2",
  "qr": "b1070383-90ef-4353-b00d-9019fcf067c2",
  "numero": 1,
  "fecha": "2026-11-12",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "estado": "EN_CAMINO",
  "paraLlevar": false,
  "almuerzo": {
    "platos": [
      {
        "id": "41c0703f-3521-48eb-98ec-6d6d8efd5979",
        "nombre": "Sopa de quinua",
        "seccion": "SOPA"
      }
    ],
    "precioCentavos": 0,
    "cubiertoPorPlan": true
  },
  "extras": [
    {
      "id": "df24243e-cc29-406a-94fd-fde6bf11d38e",
      "nombre": "Porción de aguacate",
      "cantidad": 1,
      "precioUnitarioCentavos": 75,
      "subtotalCentavos": 75
    }
  ],
  "recargoLlevarCentavos": 0,
  "totalCentavos": 75,
  "monedaCodigo": "USD",
  "creadoEn": "2026-11-13T03:48:38.964Z",
  "venceEn": "2026-11-13T04:18:38.964Z",
  "canjeadoEn": null,
  "servidoEn": null,
  "canceladoEn": null,
  "comensal": {
    "nombre": "Ana Mora"
  },
  "cliente": {
    "nombre": "Ana Mora",
    "almuerzosDisponibles": 4
  }
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                 | Ejemplo de `detail` |
| ---- | ---------------------- | ------------------- |
| 404  | `PEDIDO_NO_ENCONTRADO` | —                   |

#### `POST /v1/caja/pedidos/{id}/canjear`

**Canjear el QR del pedido**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Idempotency-Key:** obligatoria (UUID)

Si el pedido lleva almuerzo y el comensal es cliente, descuenta del plan que vence primero (canal PREORDEN, mismos resultados que `POST /v1/caja/validar`). `porCobrarCentavos` es lo que se cobra aparte como venta suelta. Un pedido preordenado se canjea aunque el menú ya no esté publicado (no responde `MENU_NO_PUBLICADO`).

> `platoNombre`: platos del almuerzo preordenado unidos con `+`; `null` si el pedido solo lleva extras. Es campo nuevo y opcional.

Request: sin cuerpo (no envíes `content-type`).

> **Novedad (PR 3):** `pedido` suma `cotizacion`. `porCobrarCentavos` no cambia. Ver [Novedades](#novedades).

Response `200`:

```json
{
  "pedido": {
    "id": "b1070383-90ef-4353-b00d-9019fcf067c2",
    "qr": "b1070383-90ef-4353-b00d-9019fcf067c2",
    "numero": 1,
    "fecha": "2026-11-12",
    "restaurante": {
      "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
      "nombre": "Doña Rosa",
      "slug": "dona-rosa-23902c"
    },
    "estado": "CANJEADA",
    "paraLlevar": false,
    "almuerzo": {
      "platos": [
        {
          "id": "41c0703f-3521-48eb-98ec-6d6d8efd5979",
          "nombre": "Sopa de quinua",
          "seccion": "SOPA"
        }
      ],
      "precioCentavos": 0,
      "cubiertoPorPlan": true
    },
    "extras": [
      {
        "id": "df24243e-cc29-406a-94fd-fde6bf11d38e",
        "nombre": "Porción de aguacate",
        "cantidad": 1,
        "precioUnitarioCentavos": 75,
        "subtotalCentavos": 75
      }
    ],
    "recargoLlevarCentavos": 0,
    "totalCentavos": 75,
    "monedaCodigo": "USD",
    "creadoEn": "2026-11-13T03:48:38.964Z",
    "venceEn": "2026-11-13T04:18:38.964Z",
    "canjeadoEn": "2026-11-13T03:48:39.060Z",
    "servidoEn": null,
    "canceladoEn": null,
    "comensal": {
      "nombre": "Ana Mora"
    },
    "cliente": {
      "nombre": "Ana Mora",
      "almuerzosDisponibles": 3
    }
  },
  "platoNombre": "Sopa de quinua",
  "yaCanjeado": false,
  "almuerzo": {
    "resultado": "OK",
    "mensaje": "Almuerzo descontado.",
    "descontado": true,
    "consumoId": "993eb546-9036-4c58-a594-78c6c58f71f6"
  },
  "porCobrarCentavos": 75
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                        | Ejemplo de `detail` |
| ---- | ----------------------------- | ------------------- |
| 404  | `PEDIDO_NO_ENCONTRADO`        | —                   |
| 409  | `IDEMPOTENCY_KEY_REUTILIZADA` | —                   |
| 409  | `PEDIDO_CANCELADO`            | —                   |
| 409  | `PEDIDO_EXPIRADO`             | —                   |

#### `POST /v1/caja/pedidos/{id}/servir`

**Marcar el pedido como servido**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "b1070383-90ef-4353-b00d-9019fcf067c2",
  "qr": "b1070383-90ef-4353-b00d-9019fcf067c2",
  "numero": 1,
  "fecha": "2026-11-12",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "estado": "SERVIDA",
  "paraLlevar": false,
  "almuerzo": {
    "platos": [
      {
        "id": "41c0703f-3521-48eb-98ec-6d6d8efd5979",
        "nombre": "Sopa de quinua",
        "seccion": "SOPA"
      }
    ],
    "precioCentavos": 0,
    "cubiertoPorPlan": true
  },
  "extras": [
    {
      "id": "df24243e-cc29-406a-94fd-fde6bf11d38e",
      "nombre": "Porción de aguacate",
      "cantidad": 1,
      "precioUnitarioCentavos": 75,
      "subtotalCentavos": 75
    }
  ],
  "recargoLlevarCentavos": 0,
  "totalCentavos": 75,
  "monedaCodigo": "USD",
  "creadoEn": "2026-11-13T03:48:38.964Z",
  "venceEn": "2026-11-13T04:18:38.964Z",
  "canjeadoEn": "2026-11-13T03:48:39.060Z",
  "servidoEn": "2026-11-13T03:48:39.090Z",
  "canceladoEn": null,
  "comensal": {
    "nombre": "Ana Mora"
  },
  "cliente": {
    "nombre": "Ana Mora",
    "almuerzosDisponibles": 3
  }
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                 | Ejemplo de `detail` |
| ---- | ---------------------- | ------------------- |
| 404  | `PEDIDO_NO_ENCONTRADO` | —                   |
| 409  | `PEDIDO_NO_CANJEADO`   | —                   |

### Fase 8 · Mesas compartidas

#### `POST /v1/mis/mesas`

**Crear una mesa compartida e invitar por link**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Idempotency-Key:** obligatoria (UUID)

El anfitrión entra como primer miembro. Comparte `invitacion` en un link; la caja valida la mesa entera al llegar.

> `horaLlegada` entre ahora y las próximas 12 horas (ISO 8601). La invitación es el `id` de la mesa; el link lo arma la app.

Request:

```json
{
  "restaurante": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
  "horaLlegada": "2026-11-13T04:28:00Z",
  "modo": "CADA_UNO"
}
```

Response `201`:

```json
{
  "id": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "invitacion": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "anfitrion": {
    "nombre": "Ana Mora"
  },
  "soyAnfitrion": true,
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "validadaEn": null,
  "miembros": [
    {
      "nombre": "Ana Mora",
      "esAnfitrion": true,
      "paraLlevar": false,
      "soyYo": true
    }
  ]
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                        | Ejemplo de `detail`   |
| ---- | ----------------------------- | --------------------- |
| 400  | `HORA_LLEGADA_INVALIDA`       | —                     |
| 400  | `IDEMPOTENCY_KEY_INVALIDA`    | —                     |
| 404  | `RESTAURANTE_NO_ENCONTRADO`   | —                     |
| 409  | `IDEMPOTENCY_KEY_REUTILIZADA` | —                     |
| 409  | `RESTAURANTE_PAUSADO`         | El local está pausado |

#### `GET /v1/mis/mesas`

**Mis mesas (como anfitrión o invitado)**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

> **Novedad (PR 3):** `miembros[].cotizacion` y `cotizacion` de la mesa, con la visibilidad de `seleccion` (ver [Novedades](#novedades)).

Response `200`:

```json
[
  {
    "id": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
    "invitacion": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
    "restaurante": {
      "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
      "nombre": "Doña Rosa",
      "slug": "dona-rosa-23902c"
    },
    "anfitrion": {
      "nombre": "Ana Mora"
    },
    "soyAnfitrion": false,
    "horaLlegada": "2026-11-13T04:28:00.000Z",
    "modo": "CADA_UNO",
    "estado": "ABIERTA",
    "validadaEn": null,
    "miembros": [
      {
        "nombre": "Ana Mora",
        "esAnfitrion": true,
        "paraLlevar": false,
        "soyYo": false
      }
    ]
  }
]
```

#### `GET /v1/mis/mesas/{id}`

**Una mesa mía, con sus miembros**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

> **Novedad (PR 3):** `miembros[].cotizacion` y `cotizacion` de la mesa (solo anfitrión). Pueden ser `null` si el plan del pagador no es legible para el comensal (ver [Novedades](#novedades)).

Response `200`:

```json
{
  "id": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "invitacion": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "anfitrion": {
    "nombre": "Ana Mora"
  },
  "soyAnfitrion": true,
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "validadaEn": null,
  "miembros": [
    {
      "nombre": "Ana Mora",
      "esAnfitrion": true,
      "paraLlevar": false,
      "soyYo": true,
      "seleccion": { "almuerzo": null, "extras": [] }
    }
  ]
}
```

`miembros[].seleccion` (nuevo): lo que eligió ese miembro (ver `PUT …/seleccion`). **El anfitrión ve la de todos; un invitado solo la suya** y las demás vienen `null` (no se muestran). Vacía (`{ "almuerzo": null, "extras": [] }`) = todavía no eligió. La misma regla aplica a `GET /v1/mis/mesas` y a las respuestas de crear, unirse y cancelar.

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`               | Ejemplo de `detail` |
| ---- | -------------------- | ------------------- |
| 404  | `MESA_NO_ENCONTRADA` | —                   |

#### `PUT /v1/mis/mesas/{id}/seleccion`

**Elegir mi almuerzo y mis platos en la mesa (reemplaza mi selección completa)**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`; cualquier miembro (anfitrión o invitado), solo sobre lo suyo
- **Estado:** Nuevo (rama `feat/carta-fija-seleccion-mesa`) · requiere la migración `20261121140100`
- **Idempotencia:** no lleva `Idempotency-Key`: es un reemplazo completo, repetir la misma petición deja el mismo resultado

Request:

```json
{
  "almuerzo": { "platos": ["<public_id jugo>", "<public_id sopa>", "<public_id fuerte>"] },
  "extras": [
    { "plato": "<public_id de un extra del menú de hoy>", "cantidad": 2 },
    { "plato": "<public_id de un plato de la carta fija>", "cantidad": 1 }
  ]
}
```

- `almuerzo.platos`: 1 a 4 `public_id` del **menú publicado de hoy**, a lo sumo uno por sección (`JUGO`, `SOPA`, `FUERTE`, `POSTRE`; las mismas reglas que `POST /v1/mis/pedidos`). Omitido = sin almuerzo.
- `extras`: hasta 10 platos sueltos con `cantidad` entera 1–10; sin repetir plato. Cada uno debe tener precio y ser de la carta fija (`A_LA_CARTA`, `EXTRA`, `BEBIDA`, activo, no agotado hoy) **o** estar en el menú publicado de hoy. Los de carta no exigen menú publicado.
- Cuerpo `{}` = borra mi selección. Cualquier campo no declarado → 400.
- Mientras la mesa esté `ABIERTA` o `EN_CAMINO` y sin validar. El local debe estar `ACTIVO`. Una selección rechazada **no** borra la anterior. No calcula ni cobra importes: la caja sigue validando la mesa como antes.

Response `200`: la mesa completa (igual que `GET /v1/mis/mesas/{id}`), con mi `seleccion`:

```json
{
  "almuerzo": {
    "platos": [
      { "id": "…", "nombre": "Jugo de mora", "seccion": "JUGO" },
      { "id": "…", "nombre": "Seco de pollo", "seccion": "FUERTE" }
    ]
  },
  "extras": [{ "id": "…", "nombre": "Cola", "categoria": "BEBIDA", "cantidad": 2 }]
}
```

Errores posibles (además de los comunes: 401, 400 de validación —cantidad fuera de 1–10 o decimal, UUID mal formado, platos repetidos, más de 4 o 10 elementos—, 429, 5xx):

| HTTP | `code`                      | Cuándo                                                                     |
| ---- | --------------------------- | -------------------------------------------------------------------------- |
| 400  | `ALMUERZO_INVALIDO`         | Dos platos de la misma sección, o uno que no es de JUGO/SOPA/FUERTE/POSTRE |
| 400  | `SELECCION_INVALIDA`        | El mismo plato en `almuerzo` y en `extras`                                 |
| 404  | `MESA_NO_ENCONTRADA`        | No existe o no soy miembro                                                 |
| 409  | `MESA_CERRADA`              | Cancelada, validada en caja o ya no abierta                                |
| 409  | `RESTAURANTE_PAUSADO`       | El local está pausado                                                      |
| 409  | `RESTAURANTE_NO_DISPONIBLE` | El local no está activo                                                    |
| 409  | `MENU_NO_PUBLICADO`         | Hay almuerzo (o un plato de almuerzo suelto) y hoy no hay menú publicado   |
| 409  | `PLATO_AGOTADO`             | Agotado en el menú del día o en la carta (hoy)                             |
| 422  | `PLATO_NO_DISPONIBLE`       | No existe, está inactivo, es de otro local o no está en el menú de hoy     |
| 422  | `PLATO_SIN_PRECIO`          | Plato suelto que solo se sirve dentro del almuerzo                         |

#### `POST /v1/mis/mesas/{id}/cancelar`

**Cancelar la mesa (solo el anfitrión, antes de la caja)**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "id": "7c3ffb95-4e17-4e05-a798-cf0f72521039",
  "invitacion": "7c3ffb95-4e17-4e05-a798-cf0f72521039",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "anfitrion": {
    "nombre": "Ana Mora"
  },
  "soyAnfitrion": true,
  "horaLlegada": "2026-11-13T04:39:00.000Z",
  "modo": "INVITO_YO",
  "estado": "CANCELADA",
  "validadaEn": null,
  "miembros": [
    {
      "nombre": "Ana Mora",
      "esAnfitrion": true,
      "paraLlevar": false,
      "soyYo": true
    }
  ]
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`               | Ejemplo de `detail`                       |
| ---- | -------------------- | ----------------------------------------- |
| 403  | `SOLO_ANFITRION`     | Solo el anfitrión puede cancelar la mesa. |
| 404  | `MESA_NO_ENCONTRADA` | —                                         |
| 409  | `MESA_CERRADA`       | —                                         |

#### `GET /v1/mesas/invitacion/{id}`

**Validar un link de invitación antes de unirse**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Dice quién invita, a dónde y a qué hora, cuántos van y si todavía se puede (`puedeUnirse`, `motivo`).

> Validar antes de unirse: `puedeUnirse` y `motivo`.

Response `200`:

```json
{
  "id": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "anfitrion": {
    "nombre": "Ana Mora"
  },
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "personas": 1,
  "capacidad": 12,
  "puedeUnirse": true,
  "motivo": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`               | Ejemplo de `detail` |
| ---- | -------------------- | ------------------- |
| 404  | `MESA_NO_ENCONTRADA` | Mesa no encontrada. |

#### `POST /v1/mesas/invitacion/{id}/unirse`

**Unirse a la mesa por su link**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Idempotency-Key:** obligatoria (UUID)

Vuelve a validar con la mesa bloqueada (cupo, estado, vencimiento). Unirse dos veces no duplica al miembro.

> Repetirlo no duplica al miembro: devuelve la mesa.

Request:

```json
{
  "paraLlevar": false
}
```

Response `200`:

```json
{
  "id": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "invitacion": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "restaurante": {
    "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
    "nombre": "Doña Rosa",
    "slug": "dona-rosa-23902c"
  },
  "anfitrion": {
    "nombre": "Ana Mora"
  },
  "soyAnfitrion": false,
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "validadaEn": null,
  "miembros": [
    {
      "nombre": "Ana Mora",
      "esAnfitrion": true,
      "paraLlevar": false,
      "soyYo": false
    }
  ]
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                      | Ejemplo de `detail` |
| ---- | --------------------------- | ------------------- |
| 404  | `MESA_NO_ENCONTRADA`        | —                   |
| 409  | `MESA_CERRADA`              | —                   |
| 409  | `MESA_LLENA`                | —                   |
| 409  | `MESA_VENCIDA`              | —                   |
| 409  | `RESTAURANTE_NO_DISPONIBLE` | —                   |

### Fase 8 · Opiniones

#### `GET /v1/mis/opiniones/pendientes`

**Tarjetas "¿Qué tal hoy?" por responder**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Almuerzos propios no revertidos, de 25 minutos a 24 horas de antigüedad, sin opinión ni descarte.

> Aparecen 25 minutos después de validar el almuerzo y vencen a las 24 horas.

Response `200`:

```json
[
  {
    "consumo": {
      "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
      "fecha": "2026-11-13T03:18:39.060Z",
      "restaurante": {
        "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
        "nombre": "Doña Rosa",
        "slug": "dona-rosa-23902c"
      }
    },
    "expiraEn": "2026-11-14T03:18:39.060Z",
    "etiquetasDisponibles": ["RICO"]
  }
]
```

#### `GET /v1/mis/opiniones`

**Mis opiniones enviadas, con la respuesta del restaurante**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Response `200`:

```json
[
  {
    "consumo": {
      "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
      "fecha": "2026-11-13T03:18:39.060Z",
      "restaurante": {
        "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
        "nombre": "Doña Rosa",
        "slug": "dona-rosa-23902c"
      }
    },
    "etiquetas": ["RICO"],
    "comentario": "La sopa estaba muy rica, gracias.",
    "descartada": false,
    "creadoEn": "2026-11-13T03:48:39.565Z",
    "respuesta": null
  }
]
```

#### `POST /v1/mis/consumos/{id}/opinion`

**Opinar sobre un almuerzo mío**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Idempotency-Key:** obligatoria (UUID)

Una por almuerzo. Etiquetas cerradas y comentario privado (solo lo lee el restaurante).

> `{id}` es el `id` del consumo (historial). Una opinión por almuerzo propio.

Request:

```json
{
  "etiquetas": ["RICO"],
  "comentario": "La sopa estaba muy rica, gracias."
}
```

Response `201`:

```json
{
  "consumo": {
    "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
    "fecha": "2026-11-13T03:18:39.060Z",
    "restaurante": {
      "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
      "nombre": "Doña Rosa",
      "slug": "dona-rosa-23902c"
    }
  },
  "etiquetas": ["RICO"],
  "comentario": "La sopa estaba muy rica, gracias.",
  "descartada": false,
  "creadoEn": "2026-11-13T03:48:39.565Z",
  "respuesta": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                      | Ejemplo de `detail`                           |
| ---- | --------------------------- | --------------------------------------------- |
| 400  | `IDEMPOTENCY_KEY_INVALIDA`  | —                                             |
| 400  | `OPINION_VACIA`             | —                                             |
| 404  | `CONSUMO_NO_ENCONTRADO`     | Consumo no encontrado.                        |
| 409  | `CONSUMO_REVERTIDO`         | —                                             |
| 409  | `OPINION_AUN_NO_DISPONIBLE` | Podrás opinar 25 minutos después de almorzar. |
| 409  | `OPINION_VENCIDA`           | —                                             |
| 409  | `OPINION_YA_ENVIADA`        | Ya opinaste sobre ese almuerzo.               |

#### `POST /v1/mis/consumos/{id}/opinion/descartar`

**Cerrar la tarjeta sin opinar**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Idempotency-Key:** obligatoria (UUID)

Cuenta como la única opinión de ese almuerzo.

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "consumo": {
    "id": "5648e87e-ce09-4ae2-9c7f-bdaf300e1604",
    "fecha": "2026-11-13T03:19:42.649Z",
    "restaurante": {
      "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
      "nombre": "Doña Rosa",
      "slug": "dona-rosa-23902c"
    }
  },
  "etiquetas": [],
  "comentario": null,
  "descartada": true,
  "creadoEn": "2026-11-13T03:49:43.070Z",
  "respuesta": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                      | Ejemplo de `detail` |
| ---- | --------------------------- | ------------------- |
| 404  | `CONSUMO_NO_ENCONTRADO`     | —                   |
| 409  | `CONSUMO_REVERTIDO`         | —                   |
| 409  | `OPINION_AUN_NO_DISPONIBLE` | —                   |
| 409  | `OPINION_VENCIDA`           | —                   |
| 409  | `OPINION_YA_ENVIADA`        | —                   |

#### `GET /v1/opiniones`

**Bandeja de opiniones de los comensales**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Query:** `limit`, `cursor`, `estado` (TODAS, SIN_RESPONDER, RESPONDIDAS)

Más recientes primero, con cursor. Incluye un resumen de los últimos 30 días por etiqueta.

Response `200`:

```json
{
  "items": [
    {
      "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
      "cliente": {
        "nombre": "Ana Mora"
      },
      "almuerzoEn": "2026-11-13T03:18:39.060Z",
      "plan": {
        "nombre": "Plan semanal"
      },
      "creadoEn": "2026-11-13T03:48:39.565Z",
      "etiquetas": ["RICO"],
      "comentario": "La sopa estaba muy rica, gracias.",
      "respuesta": null
    }
  ],
  "nextCursor": null,
  "resumen": {
    "total": 1,
    "sinResponder": 1,
    "conComentario": 1,
    "etiquetas": {
      "RICO": 1,
      "BUENA_PORCION": 1
    }
  }
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`            | Ejemplo de `detail`            |
| ---- | ----------------- | ------------------------------ |
| 400  | `CURSOR_INVALIDO` | —                              |
| 403  | `FORBIDDEN`       | Tu rol no permite esta acción. |

#### `POST /v1/opiniones/{id}/responder`

**Responder una opinión**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)

El comensal ve la respuesta en `GET /v1/mis/opiniones`. Una por opinión.

> `{id}` es el `id` del consumo al que se opinó (así sale en la bandeja).

Request:

```json
{
  "respuesta": "¡Gracias, Ana! Te esperamos mañana."
}
```

Response `200`:

```json
{
  "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
  "cliente": {
    "nombre": "Ana Mora"
  },
  "almuerzoEn": "2026-11-13T03:18:39.060Z",
  "plan": {
    "nombre": "Plan semanal"
  },
  "creadoEn": "2026-11-13T03:48:39.565Z",
  "etiquetas": ["RICO"],
  "comentario": "La sopa estaba muy rica, gracias.",
  "respuesta": {
    "texto": "¡Gracias, Ana! Te esperamos mañana.",
    "respondidoEn": "2026-11-13T03:48:39.618Z"
  }
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                  | Ejemplo de `detail`             |
| ---- | ----------------------- | ------------------------------- |
| 404  | `OPINION_NO_ENCONTRADA` | —                               |
| 409  | `OPINION_YA_RESPONDIDA` | Esa opinión ya tiene respuesta. |

### Fase 8 · Reclamos del comensal

#### `GET /v1/mis/reclamos`

**Mis reclamos y cómo se resolvieron**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Response `200`:

```json
[
  {
    "consumo": {
      "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
      "fecha": "2026-11-13T03:18:39.060Z",
      "restaurante": {
        "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
        "nombre": "Doña Rosa",
        "slug": "dona-rosa-23902c"
      }
    },
    "estado": "PENDIENTE",
    "mensaje": "Me descontaron el almuerzo pero ese día no fui.",
    "respuesta": null,
    "creadoEn": "2026-11-13T03:48:39.639Z",
    "resueltoEn": null
  }
]
```

#### `POST /v1/mis/consumos/{id}/reclamo`

**Reclamar por un almuerzo mío**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Idempotency-Key:** obligatoria (UUID)

Hasta 7 días después; uno por almuerzo. Si el restaurante lo acepta, el almuerzo vuelve al plan.

> Dentro de los 7 días siguientes al almuerzo; uno por almuerzo.

Request:

```json
{
  "mensaje": "Me descontaron el almuerzo pero ese día no fui."
}
```

Response `201`:

```json
{
  "consumo": {
    "id": "993eb546-9036-4c58-a594-78c6c58f71f6",
    "fecha": "2026-11-13T03:18:39.060Z",
    "restaurante": {
      "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
      "nombre": "Doña Rosa",
      "slug": "dona-rosa-23902c"
    }
  },
  "estado": "PENDIENTE",
  "mensaje": "Me descontaron el almuerzo pero ese día no fui.",
  "respuesta": null,
  "creadoEn": "2026-11-13T03:48:39.639Z",
  "resueltoEn": null
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                     | Ejemplo de `detail`                     |
| ---- | -------------------------- | --------------------------------------- |
| 400  | `IDEMPOTENCY_KEY_INVALIDA` | —                                       |
| 404  | `CONSUMO_NO_ENCONTRADO`    | —                                       |
| 409  | `CONSUMO_REVERTIDO`        | —                                       |
| 409  | `RECLAMO_VENCIDO`          | —                                       |
| 409  | `RECLAMO_YA_EXISTE`        | Ya hiciste un reclamo por ese almuerzo. |

### Fase 8 · Sellos

#### `GET /v1/mis/sellos`

**Mis tarjetas de sellos**

- **Rol:** Usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Una por local donde soy cliente y que tiene la tarjeta activa (o donde tengo premios).

Response `200`:

```json
[
  {
    "restaurante": {
      "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4",
      "nombre": "Doña Rosa",
      "slug": "dona-rosa-23902c"
    },
    "sellos": 1,
    "meta": 5,
    "faltan": 4,
    "premiosDisponibles": 0,
    "premio": "Un almuerzo gratis",
    "nombre": "Tarjeta Doña Rosa",
    "activa": true
  }
]
```

#### `GET /v1/sellos/config`

**Configuración de la tarjeta de sellos**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Response `200`:

```json
{
  "activa": true,
  "meta": 5,
  "premio": "Un almuerzo gratis",
  "nombre": "Tarjeta Doña Rosa",
  "cuenta": "ALMUERZO"
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                   | Ejemplo de `detail` |
| ---- | ------------------------ | ------------------- |
| 404  | `TARJETA_NO_CONFIGURADA` | —                   |

#### `PUT /v1/sellos/config`

**Configurar la tarjeta de sellos**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Cada almuerzo validado suma un sello; al llegar a la meta se gana un premio. Cambiar la meta no toca los sellos ya ganados.

Request:

```json
{
  "activa": true,
  "meta": 5,
  "premio": "Un almuerzo gratis",
  "nombre": "Tarjeta Doña Rosa"
}
```

Response `200`:

```json
{
  "activa": true,
  "meta": 5,
  "premio": "Un almuerzo gratis",
  "nombre": "Tarjeta Doña Rosa",
  "cuenta": "ALMUERZO"
}
```

#### `GET /v1/clientes/{id}/sellos`

**Tarjeta de sellos de un cliente**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)

Response `200`:

```json
{
  "sellos": 1,
  "meta": 5,
  "faltan": 4,
  "premiosDisponibles": 0,
  "premio": "Un almuerzo gratis",
  "nombre": "Tarjeta Doña Rosa",
  "activa": true
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                   | Ejemplo de `detail` |
| ---- | ------------------------ | ------------------- |
| 404  | `CLIENTE_NO_ENCONTRADO`  | —                   |
| 404  | `TARJETA_NO_CONFIGURADA` | —                   |

#### `POST /v1/clientes/{id}/sellos/canjear`

**Canjear un premio de la tarjeta de sellos**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 8)
- **Idempotency-Key:** obligatoria (UUID)

Request: sin cuerpo (no envíes `content-type`).

Response `200`:

```json
{
  "sellos": 1,
  "meta": 2,
  "faltan": 1,
  "premiosDisponibles": 0,
  "premio": "Un almuerzo gratis",
  "nombre": "Tarjeta Doña Rosa",
  "activa": true,
  "yaCanjeado": false
}
```

Errores posibles (además de los comunes: 401, 400 de validación, 429, 5xx):

| HTTP | `code`                        | Ejemplo de `detail`                        |
| ---- | ----------------------------- | ------------------------------------------ |
| 404  | `CLIENTE_NO_ENCONTRADO`       | —                                          |
| 404  | `TARJETA_NO_CONFIGURADA`      | —                                          |
| 409  | `IDEMPOTENCY_KEY_REUTILIZADA` | —                                          |
| 409  | `SIN_PREMIOS`                 | Este cliente no tiene premios por canjear. |

### Fase 9 · Ofertas flash

Modelo SaaS: el local paga su suscripción y se queda con todo lo que cobra. **No existe ningún endpoint ni campo de comisión.**

Estados de una oferta (`estado`, calculado con la hora de la base): `CERRADA` (el dueño la cerró), `AGOTADA` (stock 0), `EXPIRADA` (pasó `expiraEn`), `PROGRAMADA` (aún no empieza) y `VIGENTE`. Se evalúan en ese orden.

#### `POST /v1/ofertas`

**Publicar una oferta flash**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)
- **Encabezado obligatorio:** `Idempotency-Key` (UUID). Misma llave → misma oferta, sin publicar otra (aunque el cuerpo cambie).

Empieza al publicarse y dura `duracionMinutos` (5–1440, por defecto 120).

Request:

```json
{
  "titulo": "Churrasco a mitad de tarde",
  "descripcion": "Últimos churrascos del día",
  "platoId": "uuid del plato (opcional)",
  "precioCentavos": 450,
  "precioOriginalCentavos": 650,
  "stock": 8,
  "duracionMinutos": 120
}
```

Response `201`:

```json
{
  "id": "6f0c1c5e-3a0b-4d1e-9d57-0a8c1d6f2b11",
  "titulo": "Churrasco a mitad de tarde",
  "descripcion": "Últimos churrascos del día",
  "plato": { "id": "uuid", "nombre": "Churrasco" },
  "precioCentavos": 450,
  "precioOriginalCentavos": 650,
  "descuentoPorcentaje": 31,
  "moneda": "USD",
  "stockTotal": 8,
  "stockRestante": 8,
  "canjeadas": 0,
  "iniciaEn": "2026-11-18T15:00:00.000Z",
  "expiraEn": "2026-11-18T17:00:00.000Z",
  "estado": "VIGENTE"
}
```

Errores posibles (además de los comunes: 401, 403, 400 de validación, 429, 5xx):

| HTTP | `code`                     | Ejemplo de `detail`                                           |
| ---- | -------------------------- | ------------------------------------------------------------- |
| 400  | `IDEMPOTENCY_KEY_INVALIDA` | Falta el encabezado Idempotency-Key (UUID) o no es válido.    |
| 404  | `PLATO_NO_ENCONTRADO`      | El plato no existe o está inactivo.                           |
| 422  | `OFERTA_PRECIO_INVALIDO`   | El precio de la oferta debe ser menor que el precio original. |

#### `GET /v1/ofertas`

**Ofertas del local**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Más recientes primero. Query: `limit` (1–50, por defecto 20), `cursor` (el `nextCursor` anterior) y `estado` (uno de los cinco). Response `200`: `{ "items": [<oferta>], "nextCursor": "…" | null }`.

#### `POST /v1/ofertas/{id}/cerrar`

**Cerrar una oferta**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Deja de aceptar canjes. No necesita `Idempotency-Key`: repetirlo devuelve la misma oferta ya `CERRADA`. Response `200`: la oferta. Error: 404 `OFERTA_NO_ENCONTRADA` (también si es de otro local).

#### `POST /v1/ofertas/{id}/canjear`

**Canjear una oferta en caja**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)
- **Encabezado obligatorio:** `Idempotency-Key` (UUID). Misma llave → mismo canje, sin descontar otra vez; la llave de otra oferta → 409.

Descuenta el stock y registra el cobro (siempre `CONFIRMADO`: la oferta se entrega al pagar) en una sola transacción. **El stock nunca queda negativo**, tampoco con canjes simultáneos: el descuento es un `UPDATE` condicional (`stock_restante >= cantidad`) y los canjes que no alcanzan reciben 409 sin cobro. El cobro cuenta en el arqueo de caja del día. Sin comisión: el local cobra el 100 % del precio de la oferta.

Request:

```json
{ "cantidad": 2, "metodoPago": "EFECTIVO", "comensalId": "uuid (opcional)" }
```

`cantidad` 1–10 (por defecto 1); `metodoPago`: `EFECTIVO`, `TRANSFERENCIA` o `DEUNA`; `comensalId` es el `public_id` de un comensal con cuenta (si no se manda, es un canje de mostrador).

Response `201`:

```json
{
  "id": "0c9f0a52-5d3b-4f3c-8f64-6a3a0e0b7b11",
  "cantidad": 2,
  "montoCentavos": 900,
  "moneda": "USD",
  "metodoPago": "EFECTIVO",
  "comensalId": null,
  "creadoEn": "2026-11-18T15:20:00.000Z",
  "oferta": { "id": "…", "stockTotal": 3, "stockRestante": 1, "canjeadas": 2, "estado": "VIGENTE", "…": "…" }
}
```

Errores posibles (además de los comunes: 401, 403, 400 de validación, 429, 5xx):

| HTTP | `code`                        | Cuándo                                                 |
| ---- | ----------------------------- | ------------------------------------------------------ |
| 400  | `IDEMPOTENCY_KEY_INVALIDA`    | Falta la llave o no es UUID                            |
| 404  | `OFERTA_NO_ENCONTRADA`        | No existe o es de otro local                           |
| 404  | `COMENSAL_NO_ENCONTRADO`      | `comensalId` inexistente                               |
| 409  | `OFERTA_AGOTADA`              | No quedan unidades                                     |
| 409  | `STOCK_INSUFICIENTE`          | Pidió más de las que quedan (el `detail` dice cuántas) |
| 409  | `OFERTA_CERRADA`              | El dueño la cerró                                      |
| 409  | `OFERTA_EXPIRADA`             | Ya pasó `expiraEn`                                     |
| 409  | `OFERTA_NO_INICIADA`          | Aún no empieza                                         |
| 409  | `IDEMPOTENCY_KEY_REUTILIZADA` | La llave ya se usó con otra oferta                     |
| 409  | `RESTAURANTE_PAUSADO`         | El local está pausado: no se canjean ofertas           |
| 422  | `METODO_PAGO_NO_DISPONIBLE`   | El método no existe en el país del local               |

#### `GET /v1/restaurantes/{slug}/ofertas`

**Ofertas flash vigentes de un local (vitrina)**

- **Rol:** público, sin token
- **Estado:** En revisión (fase 9)

Solo las `VIGENTE` con stock, por vencer primero. Response `200`: `{ "items": [<oferta>] }`. Error: 404 `RESTAURANTE_NO_ENCONTRADO`.

### Fase 9 · Reportes

Solo el **dueño** (`@Roles('DUENO')`; el cajero recibe 403). Todos usan la **zona horaria del restaurante** (`zonaHoraria` en la respuesta): "hoy" y los días de un rango son días locales del local, no de UTC ni del servidor. Salen de los libros de solo inserción (consumos, ventas, pagos): los reversos restan, y el efectivo del resumen es el mismo que el "efectivo esperado" del cierre de caja.

Errores comunes de los reportes: 400 `FECHA_INVALIDA` (no es una fecha real AAAA-MM-DD), 400 `RANGO_INVALIDO` (`desde` > `hasta`), 400 `RANGO_MUY_LARGO` (más de 366 días).

#### `GET /v1/reportes/resumen-diario`

**Resumen del día**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Query: `fecha` (AAAA-MM-DD; por defecto, hoy en la zona del local).

Response `200`:

```json
{
  "fecha": "2026-11-13",
  "zonaHoraria": "America/Guayaquil",
  "moneda": "USD",
  "almuerzos": { "servidos": 2, "paraLlevar": 1, "porCanal": { "QR": 0, "MANUAL": 2, "PREORDEN": 0, "MESA": 0 } },
  "ingresos": {
    "totalCentavos": 7100,
    "porOrigen": { "planes": 5500, "ventas": 700, "ofertas": 900, "pedidos": 0 },
    "porMetodo": [
      { "metodo": "DEUNA", "centavos": 3400 },
      { "metodo": "EFECTIVO", "centavos": 3700 }
    ],
    "pendientesPorConfirmar": { "cantidad": 1, "centavos": 1500 }
  },
  "ventasPos": { "tickets": 2, "reversos": 1, "totalCentavos": 700, "almuerzos": 2 },
  "planesVendidos": { "cantidad": 4, "centavos": 7000 },
  "ofertas": { "unidades": 2, "centavos": 900 },
  "escaneos": { "total": 4, "validos": 3, "rechazados": 1 }
}
```

- `almuerzos.servidos`: almuerzos descontados de planes **netos** de devoluciones (igual que el cierre de caja).
- `ingresos`: cobros `CONFIRMADO` del día **netos** de reversos; los `PENDIENTE` (transferencia o Deuna sin confirmar) van aparte y no suman al total.
- `planesVendidos`: planes de venta (no cartulinas migradas) comprados ese día local, sin los anulados.

#### `GET /v1/reportes/ventas-planes`

**Ventas de planes**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Query: `desde` y `hasta` (días locales, ambos incluidos; por defecto los últimos 30 días con hoy).

Response `200`:

```json
{
  "desde": "2026-10-15",
  "hasta": "2026-11-13",
  "zonaHoraria": "America/Guayaquil",
  "moneda": "USD",
  "total": { "vendidos": 2, "anulados": 1, "ingresoCentavos": 3000 },
  "porPlan": [
    { "nombre": "Semanal", "vendidos": 2, "anulados": 1, "ingresoCentavos": 3000, "almuerzosVendidos": 10, "almuerzosConsumidos": 1 }
  ],
  "porDia": [
    { "fecha": "2026-11-11", "vendidos": 1, "ingresoCentavos": 1500 },
    { "fecha": "2026-11-13", "vendidos": 1, "ingresoCentavos": 1500 }
  ]
}
```

`vendidos` no cuenta los planes anulados (van en `anulados`); `ingresoCentavos` es el precio pagado de los vendidos. `porDia` solo trae los días con ventas.

#### `GET /v1/reportes/horas-pico`

**Horas pico**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Query: `desde`, `hasta` (días locales; por defecto los últimos 30 días). Siempre devuelve las 24 horas locales (0–23). Los almuerzos devueltos y los tickets deshechos **no cuentan**, así un reverso no mueve la hora. La suma de `almuerzos` de todas las horas es igual a `almuerzos.servidos` de los resúmenes diarios del mismo rango.

Response `200`:

```json
{
  "desde": "2026-11-13",
  "hasta": "2026-11-13",
  "zonaHoraria": "America/Guayaquil",
  "porHora": [
    { "hora": 0, "almuerzos": 0, "ventas": 0, "total": 0 },
    { "hora": 12, "almuerzos": 3, "ventas": 2, "total": 5 },
    { "hora": 13, "almuerzos": 2, "ventas": 0, "total": 2 }
  ],
  "horaPico": 12,
  "totalAlmuerzos": 7,
  "totalVentas": 3
}
```

(El ejemplo omite las demás horas.) `horaPico` es la hora con más `total` (la más temprana si hay empate) y `null` si no hubo movimiento.

#### `GET /v1/reportes/ranking-platos`

**Ranking de platos**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Query: `desde`, `hasta`, `limit` (1–50, por defecto 10). Cuenta los platos **vendidos sueltos** en caja (netos de tickets deshechos) y los incluidos en **pedidos de comensales ya canjeados o servidos**; las dos fuentes se muestran por separado porque un plato de un pedido que además se cobra en caja cuenta en ambas. Orden: más unidades primero, empate por nombre.

Response `200`:

```json
{
  "desde": "2026-10-15",
  "hasta": "2026-11-13",
  "zonaHoraria": "America/Guayaquil",
  "moneda": "USD",
  "items": [
    {
      "posicion": 1,
      "plato": { "id": "7d1c…", "nombre": "Huevo frito" },
      "unidades": 5,
      "unidadesVentas": 3,
      "unidadesPedidos": 2,
      "ingresoCentavos": 375
    }
  ]
}
```

`plato.id` es el `public_id` del plato. Los platos dentro del almuerzo cuestan 0 (los cubre el plan o el precio del almuerzo), por eso su `ingresoCentavos` es 0.

#### `GET /v1/reportes/almuerzos-pendientes`

**Almuerzos pendientes (lo que debes)**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Foto de hoy (sin parámetros): los almuerzos prepagados que quedan en planes `ACTIVA` que todavía no vencieron en hora local. Un plan que venció ayer y espera al job de expiración no se puede consumir, así que no cuenta como deuda. El valor es `almuerzos restantes × precio unitario` de cada plan.

Response `200`:

```json
{
  "fecha": "2026-11-13",
  "zonaHoraria": "America/Guayaquil",
  "moneda": "USD",
  "total": { "clientes": 4, "planes": 4, "almuerzos": 49, "pasivoCentavos": 7700 },
  "porPlan": [
    { "nombre": "Mensual", "planes": 2, "almuerzos": 40, "pasivoCentavos": 5000 },
    { "nombre": "Semanal", "planes": 2, "almuerzos": 9, "pasivoCentavos": 2700 }
  ],
  "porVencimiento": [
    { "rango": "HOY", "planes": 1, "almuerzos": 4, "pasivoCentavos": 1200 },
    { "rango": "EN_1_A_3_DIAS", "planes": 1, "almuerzos": 5, "pasivoCentavos": 1500 },
    { "rango": "EN_4_A_7_DIAS", "planes": 1, "almuerzos": 20, "pasivoCentavos": 2500 },
    { "rango": "EN_MAS_DE_7_DIAS", "planes": 1, "almuerzos": 20, "pasivoCentavos": 2500 }
  ]
}
```

#### `GET /v1/reportes/clientes-a-contactar`

**Clientes a quienes escribirles**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Los clientes con los que conviene hablar hoy, con su motivo:

| `motivos`      | Cuándo                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| `POR_VENCER`   | Tiene un plan vigente con almuerzos sin usar que vence en `diasVencer` días o menos      |
| `SIN_VENIR`    | Tiene un plan vigente pero lleva `diasSinVenir` días o más sin actividad                 |
| `PARA_RENOVAR` | No tiene plan vigente y su último plan se acabó o venció hace `diasRenovar` días o menos |

La **actividad** de un cliente es lo más reciente entre su último almuerzo servido (los devueltos no cuentan) y la compra de su último plan; todas las fechas son del día local del restaurante. Un cliente trae todos sus motivos (el primero es el más urgente). No aparecen los clientes desactivados, los que nunca compraron un plan ni los que solo tienen planes anulados.

Query (todos opcionales): `limit` (1–100, por defecto 20), `diasVencer` (1–30, por defecto 3), `diasSinVenir` (3–90, por defecto 7), `diasRenovar` (1–90, por defecto 30). Sin paginación: va primero lo más urgente (`POR_VENCER`, por vencimiento; luego `SIN_VENIR`, por más tiempo sin venir; luego `PARA_RENOVAR`, el que se quedó sin plan más recién) y `total` cuenta todos los que cumplen aunque `limit` recorte.

Response `200`:

```json
{
  "fecha": "2026-11-13",
  "zonaHoraria": "America/Guayaquil",
  "total": 5,
  "items": [
    {
      "clienteId": "42",
      "nombre": "Carla Mena",
      "telefono": "+593990000123",
      "motivos": ["POR_VENCER", "SIN_VENIR"],
      "almuerzosRestantes": 4,
      "venceEl": "2026-11-14",
      "ultimaVisita": "2026-11-05",
      "diasSinActividad": 8
    }
  ]
}
```

`clienteId` es el id del cliente dentro del local, el mismo que usan `/v1/clientes/{id}` y `/v1/clientes/{id}/sellos` (ver "Limitaciones conocidas"). `venceEl` y `ultimaVisita` son `null` si no aplican; `almuerzosRestantes` es 0 sin plan vigente. Errores: los comunes (400 de validación, 401, 403, 429).

### Fase 9 · Suscripción SaaS

Modelo SaaS: el local paga una **mensualidad** por su plan de Bocadoo (con un tope de escaneos por ciclo en los planes bajos) y se queda con todo lo que cobra a sus comensales. **No existe ningún endpoint ni campo de comisión**, y la API solo **lee** la suscripción (la escribe el rol de servicio).

#### `GET /v1/suscripcion`

**Suscripción SaaS del local**

- **Rol:** dueño · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Response `200`:

```json
{
  "estado": "FREEMIUM",
  "plan": { "codigo": "FREEMIUM", "nombre": "Gratis", "precioMensualCentavos": 0, "moneda": "USD" },
  "ciclo": { "inicio": "2026-11-01", "fin": "2026-12-01", "diasRestantes": 18, "vencido": false },
  "proximoCobro": null,
  "limites": { "escaneosMes": null, "mesaGrupal": false, "reportesAvanzados": false }
}
```

- `estado`: `TRIAL`, `FREEMIUM`, `ACTIVA_PRO`, `MOROSA`, `SUSPENDIDA`, `CANCELADA` o `SIN_SUSCRIPCION` (el local todavía no tiene plan SaaS asignado: se comporta como sin límite y `plan`, `ciclo` son `null`). Un local `SUSPENDIDA` recibe `LIMITE_SAAS` en la caja.
- `plan.precioMensualCentavos` y `moneda` son el precio vigente en el país del local; `null` si el plan no tiene precio ahí.
- `ciclo.diasRestantes` se cuenta desde hoy en la zona horaria del local. `ciclo.vencido` es `true` si `fin` ya pasó y el ciclo no se renovó (los contadores siguen siendo del ciclo anterior).
- `limites.escaneosMes`: `null` = sin límite. `mesaGrupal` y `reportesAvanzados` se informan pero **hoy la API no los exige** en los endpoints.

#### `GET /v1/suscripcion/uso`

**Uso de escaneos del ciclo**

- **Rol:** dueño, cajero · con `Authorization` y `x-restaurant-id`
- **Estado:** En revisión (fase 9)

Response `200`:

```json
{
  "ciclo": { "inicio": "2026-11-01", "fin": "2026-12-01", "diasRestantes": 18, "vencido": false },
  "escaneosUsados": 4,
  "limite": 5,
  "restantes": 1,
  "porcentaje": 80,
  "nivel": "CERCA_DEL_LIMITE",
  "rechazadosPorLimite": 0
}
```

- `escaneosUsados`: el contador que aplica el límite; cuenta cada almuerzo descontado en el ciclo (deshacerlo no lo devuelve).
- `nivel`: `ILIMITADO` (sin tope), `NORMAL`, `CERCA_DEL_LIMITE` (desde el 80 %) o `LIMITE_ALCANZADO` (desde el 100 %: `POST /v1/caja/validar` responde `LIMITE_SAAS`).
- `rechazadosPorLimite`: escaneos de la caja rechazados por `LIMITE_SAAS` desde que empezó el ciclo.
- Sin suscripción: todo en cero/`null` y `nivel: "ILIMITADO"`.

### Fase 9 · Eventos de producto

#### `POST /v1/eventos`

**Enviar eventos de producto en lote**

- **Rol:** cualquier usuario con sesión (`Authorization`), sin `x-restaurant-id`
- **Estado:** En revisión (fase 9)
- **Encabezado obligatorio:** `Idempotency-Key` (UUID). Misma llave (del mismo usuario) → misma respuesta y **ningún evento duplicado**, aunque el cuerpo cambie: manda el primer lote.

Materia prima de analítica (qué miró, qué buscó, qué oferta vio). Todo el lote se guarda o se rechaza.

Request:

```json
{
  "sesionId": "uuid de la sesión de la app (opcional)",
  "plataforma": "ANDROID",
  "versionApp": "1.4.2",
  "eventos": [
    { "tipo": "oferta.impresion", "restauranteId": "uuid del local (opcional)", "propiedades": { "posicion": 2 } },
    { "tipo": "menu.visto", "ocurridoEn": "2026-11-18T15:04:05Z", "usuarioId": "uuid propio (opcional)" }
  ]
}
```

Response `201`:

```json
{ "aceptados": 2, "anonimizado": false }
```

**Límites**

| Qué              | Límite                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Eventos por lote | 1 a 50 (si no, 400)                                                                       |
| Cuerpo           | 100 kB (413)                                                                              |
| `tipo`           | 3–60 caracteres: minúsculas, dígitos, `_` y puntos (`menu.visto`)                         |
| `propiedades`    | objeto de hasta 20 claves y 1024 bytes (422 `EVENTO_MUY_GRANDE`)                          |
| `ocurridoEn`     | de hace 7 días a 5 minutos en el futuro; por defecto, ahora (422 `EVENTO_FECHA_INVALIDA`) |
| Tasa por usuario | 20 lotes y 500 eventos por minuto (429 `EVENTOS_LIMITE_TASA`)                             |
| Tasa por IP      | 60 lotes por minuto, con o sin sesión (429, con `Retry-After`)                            |

**Identidad.** El evento es siempre de la sesión. `usuarioId` es opcional y solo sirve para verificar: si es de otro usuario, el lote completo se rechaza con 403 `EVENTO_USUARIO_AJENO` (y la base lo exige también con RLS). **Consentimiento:** si el usuario no aceptó la analítica (`consiente_analitica`), los eventos se guardan **anonimizados** (sin usuario ni sesión) y la respuesta trae `anonimizado: true`. Reintentar un lote ya aceptado no cuenta contra el límite de tasa.

Errores posibles (además de los comunes: 401, 400 de validación, 413, 5xx):

| HTTP | `code`                      | Cuándo                                           |
| ---- | --------------------------- | ------------------------------------------------ |
| 400  | `IDEMPOTENCY_KEY_INVALIDA`  | Falta la llave o no es UUID                      |
| 403  | `EVENTO_USUARIO_AJENO`      | Un evento nombra a otro usuario                  |
| 404  | `RESTAURANTE_NO_ENCONTRADO` | Un `restauranteId` no existe                     |
| 422  | `EVENTO_MUY_GRANDE`         | Propiedades por encima de 20 claves o 1024 bytes |
| 422  | `EVENTO_FECHA_INVALIDA`     | `ocurridoEn` fuera de la ventana                 |
| 429  | `EVENTOS_LIMITE_TASA`       | Más de 20 lotes o 500 eventos en un minuto       |

### Salud

#### `GET /health`

**Estado del servicio (liveness, no toca la base)**

- **Rol:** Público (sin token)
- **Estado:** Estable

Response `200`:

```json
{
  "status": "ok",
  "servicio": "bck-bocadoo",
  "hora": "2026-11-13T03:49:45.769Z"
}
```

#### `GET /health/ready`

**Listo para recibir tráfico (readiness): ambos roles de base de datos responden**

- **Rol:** Público (sin token)
- **Estado:** Estable

Response `200`:

```json
{
  "status": "ok",
  "db": {
    "app": "bck_api",
    "service": "bck_servicio"
  }
}
```

## 4. Estado

Criterio: **Estable** = endpoint de las fases 1–7, cerradas con tag (`v0.1.0` a `v0.7.0`) y pruebas de integración. **En revisión** = endpoint de las fases 8 y 9: ambas ya están mezcladas en `main` y sus migraciones aplicadas en Neon, pero aún sin tag (`v0.8.0`, `v0.9.0`); su contrato puede cambiar tras la revisión. La fase 10 (`v1.0.0-rc.1`) solo documenta: no cambia ningún comportamiento.

| Módulo                                                                                                                                                                                                                                                                                                                                                  | Estado                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Auth, restaurante, personal, menú, catálogo y vitrina, planes, pagos, solicitudes, clientes, caja (validar, deshacer, mesas, ventas, cierre), reclamos del personal, `GET /v1/pase/codigo`, `POST /v1/pase/rotar`, salud                                                                                                                                | **Estable**              |
| `GET /v1/pase`, `/v1/mis/consumos*`, `/v1/mis/pedidos*`, `/v1/caja/pedidos*`, `GET /v1/caja/movimientos`, `/v1/mis/mesas*`, `/v1/mesas/invitacion/*`, `/v1/mis/opiniones*`, `/v1/mis/consumos/{id}/opinion*`, `/v1/opiniones*`, `/v1/mis/reclamos`, `/v1/mis/consumos/{id}/reclamo`, `/v1/mis/sellos`, `/v1/sellos/config`, `/v1/clientes/{id}/sellos*` | **En revisión (fase 8)** |
| `/v1/ofertas*`, `GET /v1/restaurantes/{slug}/ofertas`, `/v1/reportes/*`, `GET /v1/suscripcion`, `GET /v1/suscripcion/uso`, `POST /v1/eventos`                                                                                                                                                                                                           | **En revisión (fase 9)** |

Cada endpoint de la referencia (sección 3) lleva su propio campo **Estado**.

### Migraciones de las fases 8 y 9

- Las **seis migraciones de la fase 8** (`20261117000000` a `20261117000500`: `preordenes_comensal`, `mesas_compartidas_comensal`, `opiniones_comensal`, `opiniones_respuesta`, `reclamos_comensal` y `tarjeta_sellos`) y las **tres de la fase 9** (`20261118000000` a `20261118000200`: `ofertas_flash`, `eventos_analitica` y `particiones_security_definer`) **ya están aplicadas en Neon**. Los endpoints de ambas fases funcionan allí; una base nueva debe correr todas las migraciones en orden (`pnpm db:migrate`) antes de levantar la API.
- Algunos endpoints estables también dependen de ellas: `GET /v1/menu/{fecha}`, `PUT /v1/menu/{fecha}`, `POST /v1/menu/{fecha}/publicar`, `…/despublicar`, `…/copiar`, `PATCH /v1/menu/{fecha}/items/{id}/agotado` y `GET /v1/restaurantes/{slug}` leen `plato.public_id` (migración `20261117000000`). Sobre una base sin ella fallan con 500.
- La migración `20261117000500` agrega un trigger sobre `consumo_almuerzo`: con la tarjeta de sellos activa, `POST /v1/caja/validar` y el canje de pedidos suman sellos en la misma transacción.
- No hay ningún endpoint ni campo de comisión: el modelo es SaaS (el local paga una mensualidad).

### Cambios de documentación de la fase 10

- `docs/openapi.json` ahora documenta, en **todas** las operaciones, la respuesta de éxito con su esquema, los errores (`401`, `403`, `429`, `500` y los códigos de negocio) como `application/problem+json` (esquema `ProblemDetails`) y un ejemplo de cada petición y respuesta.
- Los endpoints se agrupan por **rol** (`Público`, `Comensal`, `Caja`, `Dueño`) en lugar de por módulo; el módulo queda en `x-dominio`. Si tu generador de clientes agrupaba por la etiqueta anterior, regenera.
- El esquema `CanjeResponse` estaba duplicado (ofertas y pedidos): ahora son `OfertaCanjeResponse` y `PedidoCanjeResponse`. Antes, `POST /v1/caja/pedidos/{id}/canjear` mostraba en Swagger la forma de la oferta, que no era la real.
- Se corrigieron tipos mal declarados (campos que aceptan `null` aparecían como `object`; `diasValidos` aparecía como lista de textos y es de números). **El formato real de las respuestas no cambió.**
- Guía para probar en Swagger con las cuentas demo: [`docs/swagger-guia.md`](./swagger-guia.md).

### Limitaciones conocidas (pueden cambiar el contrato)

- Las fases 5–7 no tienen códigos de negocio propios (`CONFLICT`, `NOT_FOUND`, `BAD_REQUEST` genéricos con `detail`); la fase 8 sí. Migrarlos a códigos estables cambiaría el `code` de esos errores, no el status.
- Ids numéricos del tenant en `/v1/clientes`, plantillas de plan, solicitudes y reclamos del personal; la fase 8 los mantiene en `/v1/clientes/{id}/sellos*` y la 9 en `clienteId` de `/v1/reportes/clientes-a-contactar` por coherencia. Se evalúa pasarlos a `public_id`.
- En esta rama `GET /v1/pase/codigo` con un restaurante inexistente responde 404 `RESTAURANTE_NO_ENCONTRADO` (antes `NOT_FOUND`) y la falta de `Idempotency-Key` da `IDEMPOTENCY_KEY_INVALIDA` (antes `BAD_REQUEST`); el status no cambia.
- La tarjeta de sellos solo cuenta almuerzos (`cuenta: "ALMUERZO"`); `PLATO` queda para después.
- Los límites de uso por IP viven en memoria de cada instancia; el límite por usuario de `POST /v1/eventos` está en la base y vale para todas.

### Eventos del pase (rama `feat/pase-eventos`)

Solo adiciones (oasdiff sin cambios incompatibles): la operación nueva `GET /v1/pase/eventos` (`text/event-stream`, 503 `EVENTOS_SATURADO`). Ningún endpoint existente cambió su respuesta: `validar`, mesas, canje de pedido y deshacer ahora además avisan por ese stream tras el COMMIT. El segundo escaneo de un QR sigue respondiendo 200 `DUPLICADO` (no se creó `QR_YA_CANJEADO`: ver `docs/estado.md`).

### Menú publicado en pase y caja

El servidor impone que el menú de hoy esté publicado (fecha local del restaurante, no la del servidor). Si no, responde **409 `MENU_NO_PUBLICADO`** (`application/problem+json`, el mismo código que `POST /v1/mis/pedidos`):

| Endpoint                             | Con menú sin publicar                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/pase/codigo?restaurante=`   | 409. Sin `restaurante` el código no es de un local: se emite igual y la regla se aplica al canjear                                         |
| `GET /v1/pase?restaurante=`          | 409 (emite el mismo código). Sin `restaurante` responde 200                                                                                |
| `POST /v1/caja/validar`              | 409 por QR y por búsqueda manual, antes de tocar nada: no descuenta y no registra `intento_escaneo`                                        |
| `POST /v1/caja/pedidos/{id}/canjear` | **No se bloquea**: un pedido preordenado con el menú publicado se canjea aunque después se despublique. Nunca responde `MENU_NO_PUBLICADO` |

Cambios de contrato (solo adiciones): respuesta `409` en los tres primeros endpoints y campo nuevo opcional `platoNombre` (`string | null`) en `POST /v1/caja/validar` (siempre `null`: un canje directo no tiene preorden) y en `POST /v1/caja/pedidos/{id}/canjear` (platos del almuerzo preordenado unidos con `+`; `null` si solo lleva extras). `GET /v1/restaurantes/{slug}` ya exponía `menuHoy.publicado` y no cambió. Nota: el código del pase se pide con `GET`, no `POST`.

- Los reportes son solo para el dueño y usan la zona horaria del local; no hay gating por plan SaaS (`limites.reportesAvanzados` se informa, pero no se exige).
- `info.version` del OpenAPI es `1.0.0-rc.1` (candidata de la fase 10); aún no hay tag.
- `POST /v1/auth/register*` no devuelve tokens; el comensal debe iniciar sesión tras registrarse.

### Estados públicos: PAUSADO, LLENO y menuAgotado (rama `fix/estados-publicos`)

Solo adiciones al contrato (`oasdiff`: sin cambios incompatibles).

- **`estado` (`ACTIVO` | `PAUSADO`)** en `GET /v1/restaurantes` y `GET /v1/restaurantes/{slug}`. Un `PAUSADO` aparece en el listado y en el detalle (menú, horarios y planes incluidos) con `abiertoAhora: false` aunque el horario esté abierto. `BORRADOR` y `BAJA` siguen sin aparecer (404 por slug). `ocupacion` de un `PAUSADO` es `LIBRE`/0 % (no hay dato real): mostrar «Cerrado» por `estado`.
- **409 `RESTAURANTE_PAUSADO`** (problem+json) si el local está `PAUSADO`: `POST /v1/mis/pedidos`, `POST /v1/mis/mesas` (mesa nueva) y `POST /v1/ofertas/{id}/canjear`. Un `BORRADOR`/`BAJA` sigue respondiendo 404 `RESTAURANTE_NO_ENCONTRADO` en pedidos y mesas. Lo ya creado no se toca: pedidos y mesas existentes se leen igual, el reintento con la misma `Idempotency-Key` devuelve el original, y `POST /v1/caja/pedidos/{id}/canjear` y `POST /v1/caja/validar` no cambian. Unirse a una mesa ya creada tampoco cambia.
- **409 `LOCAL_LLENO_SOLO_LLEVAR`** en `POST /v1/mis/pedidos` cuando la ocupación vigente es `LLENO` (la misma de `ocupacion.nivel`: "Lleno" manual vigente o aforo ≥ 90 %) y el pedido no es para llevar (`paraLlevar` ausente o `false`, es decir tipo `AQUI`; incluye pedidos solo de extras). Con `paraLlevar: true` se permite, con los mismos precios y recargo de siempre. No afecta a caja, QR, validar ni planes. Orden de las comprobaciones: `RESTAURANTE_PAUSADO` → `MENU_NO_PUBLICADO` → `LOCAL_LLENO_SOLO_LLEVAR`.
- **`menuAgotado` (boolean)** en la vitrina, el detalle y `GET /v1/restaurante`: `true` solo si hay menú publicado hoy (fecha local del local) y **todos** los platos de las secciones `SOPA` y `FUERTE` del día tienen `agotado = true` (el mismo marcador de `PATCH /v1/menu/{fecha}/items/{id}/agotado`). Jugo, postre y adicionales no cuentan. Sin menú publicado, o sin ninguna sopa ni segundo en el menú, es `false` (eso lo cubre `MENU_NO_PUBLICADO`).

### Perfil de negocio del restaurante (rama `feat/perfil-restaurante-v2`)

Solo adiciones al contrato (`oasdiff`: sin cambios incompatibles). Detalle en «Perfil de negocio» (sección Restaurante).

- Campos nuevos **opcionales** en `register-owner` (dentro de `restaurante`) y `PATCH /v1/restaurante`: `mesas`, `cedulaRuc`, `precioAlmuerzoCentavos`, `precioSoloSegundoCentavos`, `precioSoloSopaCentavos` (más `telefono`, `direccion`, `latitud`, `longitud`, `puestos` y `recargoParaLlevarCentavos`, que ya existían y ahora comparten reglas).
- Respuestas nuevas: `mesas`, `cedulaRuc` (enmascarada), `precioAlmuerzoCentavos`, `precioSoloSegundoCentavos`, `precioSoloSopaCentavos` en `GET`/`PATCH`/`activar`/`pausar` de `/v1/restaurante`; `perfilCompleto` y `datosPendientes` solo en `GET /v1/restaurante`; precios y `recargoParaLlevarCentavos` también en la vitrina y el detalle.
- Cambio de comportamiento sin cambio de esquema: `telefono` ahora se valida por país (Ecuador: móvil `09XXXXXXXX` o `+5939XXXXXXXX`; antes aceptaba cualquier E.164) y se guarda en E.164; los locales nuevos parten con `recargoParaLlevarCentavos` = 25.

### Carta fija y selección por comensal en mesas (rama `feat/carta-fija-seleccion-mesa`)

Solo adiciones al contrato (`oasdiff`: sin cambios incompatibles). Migraciones nuevas, **sin aplicar en Neon**: `20261121140000_carta_fija_agotado_orden` y `20261121140100_mesa_miembro_seleccion`.

- `PATCH /v1/menu/platos/{id}/agotado` (dueño y cajero) y campos `orden`, `agotado`, `agotadoEn` en los platos.
- `GET /v1/restaurantes/{slug}/carta` (público, solo locales `ACTIVO`).
- `PUT /v1/mis/mesas/{id}/seleccion` y `miembros[].seleccion` en `GET /v1/mis/mesas`, `GET /v1/mis/mesas/{id}`, `GET /v1/caja/mesas/{id}` y `POST /v1/caja/mesas/{id}/validar`.
- Códigos nuevos: `PLATO_NO_ENCONTRADO`, `PLATO_NO_ES_DE_CARTA`, `SELECCION_INVALIDA`. Se reutilizan `MENU_NO_PUBLICADO`, `RESTAURANTE_PAUSADO`, `RESTAURANTE_NO_DISPONIBLE`, `MESA_CERRADA`, `PLATO_AGOTADO`, `PLATO_NO_DISPONIBLE`, `PLATO_SIN_PRECIO` y `ALMUERZO_INVALIDO`.
- Cambio de comportamiento sin cambio de esquema: `GET /v1/menu/platos` ordena por categoría, `orden` y nombre (antes, categoría y nombre).

## 5. Mantenimiento de este contrato

- Cada cambio de endpoint o DTO exige `pnpm openapi:export` y commitear `docs/openapi.json`; `pnpm test` falla si no se hizo. En CI, `pnpm openapi:lint` (Spectral) revisa el contrato y el job `contrato` (oasdiff) falla ante cambios incompatibles contra la rama base; `pnpm openapi:breaking` lo corre en local (necesita Docker).
- `pnpm openapi:export` arranca la app sin base de datos ni `.env` (variables ficticias) y escribe el documento de `GET /docs-json`.
- Los ejemplos de este archivo se capturaron de la API real; si un DTO cambia, hay que volver a revisarlos.
