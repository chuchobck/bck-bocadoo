# Mesas compartidas: guía para la app Flutter

Cómo funciona una mesa compartida desde que el anfitrión la crea hasta que la caja la valida. Todo lo de aquí sale del
código (`src/tables/tables.ts`, `src/checkout/checkout.ts`, las migraciones `20261116000000` y `20261117000100`) y de
las pruebas de integración. Lo que el código no deja claro está marcado con **(no claro)** y reunido en la sección
[Dudas del código](#10-dudas-del-código). El contrato general de la API está en [`api-contrato.md`](./api-contrato.md); el
aviso en tiempo real, en [`qr-flujo.md`](./qr-flujo.md).

## 1. Resumen del flujo

```text
Anfitrión (app)                 Invitado (app)                    Caja (personal)
───────────────                 ──────────────                    ───────────────
POST /v1/mis/mesas
  → mesa ABIERTA, 1 miembro
comparte el link
(bocadoo://mesa/<id>)  ───────► GET  /v1/mesas/invitacion/{id}
                                  (puedeUnirse / motivo)
                                POST /v1/mesas/invitacion/{id}/unirse
                                  → miembro agregado
GET /v1/mis/mesas/{id} ◄──────► GET /v1/mis/mesas/{id}
(refrescar a mano)               (refrescar a mano)
                                                                  GET  /v1/caja/mesas/{id}   (vista previa)
                                                                  POST /v1/caja/mesas/{id}/validar
                                                                    → estado EN_MESA, se descuentan almuerzos
(opcional, antes de la caja)
POST /v1/mis/mesas/{id}/cancelar
  → estado CANCELADA
```

1. **Crear.** El anfitrión elige restaurante, `horaLlegada` y `modo`. Queda en estado `ABIERTA` y él es el primer miembro.
2. **Invitar.** La app arma el link con el `id` de la mesa (campo `invitacion`, igual a `id`) y lo comparte.
3. **Unirse.** El invitado abre el link, la app pide la vista previa y, si `puedeUnirse` es `true`, llama a `unirse`.
4. **Ver.** Anfitrión y miembros consultan la mesa con `GET /v1/mis/mesas/{id}`; **no hay aviso en tiempo real** (sección 7).
5. **Salir o cancelar.** Solo el anfitrión puede cancelar, y solo antes de que la caja valide. **No existe un endpoint para que un invitado salga** (no claro: ver dudas).
6. **Validar.** Cuando llegan, la caja valida **la mesa entera de una vez** (no escanea el QR de cada uno). Ahí se descuentan los almuerzos y la mesa pasa a `EN_MESA`.

### Los dos modos y el saldo de cada comensal

El modo se fija al crear y no se puede cambiar. **Hasta la validación en caja nadie pierde saldo**: crear, unirse y
cancelar no tocan ningún plan.

| Momento de la validación en caja | `CADA_UNO` (por defecto)                                            | `INVITO_YO`                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Quién paga cada almuerzo         | Cada miembro, con **su propio** plan en ese local                   | El **anfitrión** paga el almuerzo de todos (incluido el suyo), con **su** plan                                |
| Cuánto se descuenta              | 1 almuerzo del plan de cada miembro que tenga uno                   | 1 almuerzo del plan del anfitrión **por cada miembro**, mientras le alcance                                   |
| Quien no tiene plan o saldo      | Queda "por cobrar" (`porCobrar`); no se descuenta nada de nadie más | Los miembros que no alcanzan quedan "por cobrar"                                                              |
| Regla de duplicado (< 60 s)      | **Sí aplica** por comensal                                          | **No aplica** (el anfitrión paga varios seguidos a propósito)                                                 |
| Saldo del invitado               | Baja 1 si tiene plan                                                | **No cambia**                                                                                                 |
| Saldo del anfitrión              | Baja 1 (el suyo)                                                    | Baja tantos como miembros cubra                                                                               |
| Aviso SSE `CANJE_REGISTRADO`     | Uno a **cada** miembro al que se le descontó                        | Uno **por almuerzo**, todos al **anfitrión** (con `saldoRestante` decreciente); los invitados no reciben nada |

Cada almuerzo sale del plan que vence primero (FIFO) y queda en el historial del pagador con `canal: "MESA"` (lo confirma
la prueba `diner-tables.int.ts`: `GET /v1/mis/consumos` → `canal: "MESA"`).

El "por cobrar" **no genera ningún registro en el backend**: la respuesta de la caja solo lo cuenta. El cobro suelto lo
hace el cajero aparte (`docs/estado.md`: "se cobra como venta suelta").

## 2. Endpoints

Todos exigen `Authorization: Bearer <accessToken>`. Los de comensal **no** llevan `x-restaurant-id`. Los de caja sí
(`@Roles('DUENO', 'CAJERO')` más `x-restaurant-id: <uuid del restaurante>`). Los ids de mesa y restaurante son UUID
(`public_id`). Ningún endpoint de mesas es `@Public()`. Cuerpos con campos de más → 400 (whitelist).

### 2.1 Lado del comensal

#### `POST /v1/mis/mesas` — crear mesa

- **Rol:** cualquier usuario con sesión. **Cabecera obligatoria:** `Idempotency-Key` (UUID).
- **Pantalla:** _Crear mesa_ (y de ahí a _Invitar_).
- **Request:**

| Campo         | Tipo                      | Obligatorio | Notas                                                                  |
| ------------- | ------------------------- | ----------- | ---------------------------------------------------------------------- |
| `restaurante` | UUID                      | sí          | `id` público del restaurante                                           |
| `horaLlegada` | ISO 8601 estricto         | sí          | De 5 minutos atrás a 12 horas adelante (sección 4). Mandar UTC con `Z` |
| `modo`        | `CADA_UNO` \| `INVITO_YO` | no          | Por defecto `CADA_UNO`                                                 |
| `paraLlevar`  | boolean                   | no          | Del anfitrión; por defecto `false`                                     |

- **Response `201`:** objeto **Mesa** (abajo).
- **Idempotencia:** misma llave y mismo restaurante → devuelve la mesa original (también `201`), aunque `horaLlegada` o
  `modo` del segundo intento sean distintos (los ignora). Misma llave con otro restaurante → `409 IDEMPOTENCY_KEY_REUTILIZADA`.
- Solo acepta restaurantes en estado `ACTIVO`. **No exige** menú publicado ni que el anfitrión tenga plan.

#### `GET /v1/mis/mesas` — mis mesas

- **Rol:** cualquier usuario con sesión.
- **Pantalla:** _Mis mesas_ (lista).
- **Response `200`:** arreglo de **Mesa**; las mesas donde soy anfitrión **o** miembro, de la más lejana a la más cercana
  en `horaLlegada` (orden descendente), **máximo 50**, sin paginación ni filtro. Incluye mesas en cualquier estado,
  también `CANCELADA` y `EN_MESA`.

#### `GET /v1/mis/mesas/{id}` — ver una mesa

- **Rol:** cualquier usuario con sesión, pero **solo si es anfitrión o miembro**. Un no miembro recibe `404`, aunque la mesa exista.
- **Pantalla:** _Ver mesa_ (detalle y estado, el que la app refresca).
- **Response `200`:** objeto **Mesa**.

#### `POST /v1/mis/mesas/{id}/cancelar` — cancelar

- **Rol:** solo el anfitrión de esa mesa. Sin cuerpo y sin `Idempotency-Key` (repetirlo no falla: sobre una mesa ya
  `CANCELADA` devuelve la mesa con `200`).
- **Pantalla:** _Ver mesa_ (botón "Cancelar mesa", visible si `soyAnfitrion`).
- **Response `200`:** objeto **Mesa** con `estado: "CANCELADA"`.

#### `GET /v1/mesas/invitacion/{id}` — validar el link antes de unirse

- **Rol:** cualquier usuario con sesión (no hace falta ser miembro: es la única forma de ver algo de una mesa ajena).
- **Pantalla:** _Unirse a mesa_ (se abre al tocar el link o escanear el QR).
- **Response `200`:** objeto **Invitación**:

| Campo         | Tipo               | Notas                                                                                                 |
| ------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `id`          | UUID               | El mismo que viene en el link                                                                         |
| `restaurante` | `{id,nombre,slug}` |                                                                                                       |
| `anfitrion`   | `{nombre}`         |                                                                                                       |
| `horaLlegada` | fecha ISO          |                                                                                                       |
| `modo`        | enum               | `CADA_UNO` o `INVITO_YO`: la app debe decirle al invitado quién paga                                  |
| `estado`      | enum               | Estado actual de la mesa                                                                              |
| `personas`    | número             | Miembros actuales (incluye al anfitrión)                                                              |
| `capacidad`   | número             | Tope de miembros (12 en la práctica, sección 5)                                                       |
| `puedeUnirse` | boolean            | `true` si `motivo` es `null`                                                                          |
| `motivo`      | string \| null     | `MESA_CERRADA`, `MESA_VENCIDA`, `MESA_LLENA`, `RESTAURANTE_NO_DISPONIBLE`, `YA_ERES_MIEMBRO` o `null` |

Aquí un link inservible **no es un error HTTP**: responde `200` con `puedeUnirse: false` y el `motivo`. Solo `404`
si el UUID no existe.

#### `POST /v1/mesas/invitacion/{id}/unirse` — unirse

- **Rol:** cualquier usuario con sesión activa. **Cabecera obligatoria:** `Idempotency-Key` (UUID), aunque el servidor
  solo comprueba que sea un UUID válido: **no la usa** para deduplicar. Unirse dos veces no duplica al miembro.
- **Pantalla:** _Unirse a mesa_ (botón "Unirme"), después _Ver mesa_.
- **Request:** `{ "paraLlevar": false }` (opcional; cuerpo vacío `{}` vale).
- **Response `200`:** objeto **Mesa** (con `soyAnfitrion: false` y `soyYo: true` en la fila del invitado).
- Valida todo otra vez con la mesa bloqueada, así que entre la vista previa y el `unirse` pueden aparecer `MESA_LLENA`,
  `MESA_CERRADA`, etc. (sección 6).

#### Objeto Mesa

| Campo          | Tipo                      | Notas                                                                                                |
| -------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`           | UUID                      | `public_id` de la mesa                                                                               |
| `invitacion`   | UUID                      | **Igual a `id`**; lo que va en el link                                                               |
| `restaurante`  | `{id, nombre, slug}`      |                                                                                                      |
| `anfitrion`    | `{nombre}`                |                                                                                                      |
| `soyAnfitrion` | boolean                   | Para mostrar/ocultar "Cancelar"                                                                      |
| `horaLlegada`  | fecha ISO (UTC)           |                                                                                                      |
| `modo`         | `CADA_UNO` \| `INVITO_YO` |                                                                                                      |
| `estado`       | enum                      | `ABIERTA`, `EN_CAMINO`, `EN_MESA`, `FINALIZADA`, `CANCELADA`                                         |
| `validadaEn`   | fecha ISO \| null         | Cuándo la validó la caja                                                                             |
| `miembros`     | arreglo                   | El anfitrión primero, luego por orden de unión. Cada uno: `{nombre, esAnfitrion, paraLlevar, soyYo}` |

Los miembros **no traen id** ni saldo: la app solo puede identificarse a sí misma con `soyYo`. El `nombre` es una
copia del nombre del usuario al momento de unirse.

#### Selección de cada comensal (rama `feat/carta-fija-seleccion-mesa`)

Después de crear o unirse, cada miembro puede decir qué va a comer con `PUT /v1/mis/mesas/{id}/seleccion` (reemplaza su selección completa; `{}` la borra): almuerzo por sección del **menú publicado de hoy** más platos sueltos con cantidad (extras del menú o de la carta fija). Se valida con las reglas de los pedidos (`MENU_NO_PUBLICADO`, `PLATO_AGOTADO`, `PLATO_NO_DISPONIBLE`, `PLATO_SIN_PRECIO`, `ALMUERZO_INVALIDO`) y además `MESA_CERRADA` y `RESTAURANTE_PAUSADO`. La selección se ve en `miembros[].seleccion`: el anfitrión ve la de todos, un invitado solo la suya (las demás `null`) y la caja la de todos en `GET /v1/caja/mesas/{id}`. Es informativa: validar la mesa no la convierte en cobro.

### 2.2 Lado de caja

#### `GET /v1/caja/mesas/{id}` — vista previa

- **Rol:** `DUENO` o `CAJERO` del restaurante de `x-restaurant-id`. Solo ve mesas de **ese** restaurante (otra → `404`).
- **Pantalla:** _Validar en caja_ (al abrir el link/QR de la mesa).
- **Response `200`:**

| Campo         | Tipo              | Notas                                                                                                                                |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `modo`        | enum              |                                                                                                                                      |
| `estado`      | enum              | Funciona en cualquier estado, también `CANCELADA`                                                                                    |
| `horaLlegada` | fecha ISO         |                                                                                                                                      |
| `validadaEn`  | fecha ISO \| null |                                                                                                                                      |
| `personas`    | número            |                                                                                                                                      |
| `cubiertos`   | número            | `CADA_UNO`: miembros con algún almuerzo disponible. `INVITO_YO`: el menor entre `personas` y los almuerzos disponibles del anfitrión |
| `miembros`    | arreglo           | `{nombre, esAnfitrion, paraLlevar, tieneCuenta, almuerzosDisponibles}`                                                               |

`tieneCuenta` = el miembro tiene ficha de cliente **en este restaurante** (no significa "tiene cuenta en la app").
`almuerzosDisponibles` suma los planes `ACTIVA` y no vencidos del miembro en ese local. **Es una estimación**: no
considera los días válidos del plan, el límite SaaS ni el duplicado (sección 7).

#### `POST /v1/caja/mesas/{id}/validar` — validar toda la mesa

- **Rol:** `DUENO` o `CAJERO`. **Cabecera obligatoria:** `Idempotency-Key` (UUID). Sin cuerpo (no mandar `content-type`).
- **Pantalla:** _Validar en caja_ (botón "Validar mesa").
- **Response `200`:** la vista previa más:

| Campo         | Tipo    | Notas                                                                             |
| ------------- | ------- | --------------------------------------------------------------------------------- |
| `yaValidada`  | boolean | `true` si la mesa ya estaba validada: no se descontó nada                         |
| `resultados`  | arreglo | Uno por miembro, en orden de unión: `{miembro, resultado, descontado, consumoId}` |
| `descontados` | número  | Cuántos almuerzos se descontaron                                                  |
| `porCobrar`   | número  | Miembros **no** descontados (`resultados` con `descontado: false`)                |

`resultado` es el mismo catálogo del escáner (`OK`, `OK_ADVERTENCIA`, `SIN_PLAN`, `SIN_SALDO`, `VENCIDO`,
`DIA_NO_VALIDO`, `DUPLICADO`, `LIMITE_SAAS`; textos en `RESULTADOS` de `checkout.ts`). `consumoId` sirve para
`POST /v1/caja/consumos/{id}/deshacer` (10 s). Quien no tiene ficha de cliente (o el anfitrión sin ficha en `INVITO_YO`) sale como `SIN_PLAN`.

> **Repetir la petición** (misma llave u otra) sobre una mesa ya validada responde `200` con `yaValidada: true`,
> `resultados: []` y **sin** los campos `descontados` ni `porCobrar`. No reenvía el detalle original (ver dudas).

La vista previa y la validación **no** se pueden hacer desde `/v1/mis/*`, y el comensal **no** tiene forma de validar su propia mesa.

## 3. Máquina de estados

Los cinco valores del enum son `ABIERTA`, `EN_CAMINO`, `EN_MESA`, `FINALIZADA`, `CANCELADA`. **El código solo
implementa tres transiciones:**

| De                      | A           | Qué la causa                       | Quién                                                    |
| ----------------------- | ----------- | ---------------------------------- | -------------------------------------------------------- |
| (nada)                  | `ABIERTA`   | `POST /v1/mis/mesas`               | Cualquier comensal con sesión (queda como anfitrión)     |
| `ABIERTA` o `EN_CAMINO` | `CANCELADA` | `POST /v1/mis/mesas/{id}/cancelar` | Solo el anfitrión, mientras `validadaEn` sea `null`      |
| `ABIERTA` o `EN_CAMINO` | `EN_MESA`   | `POST /v1/caja/mesas/{id}/validar` | `DUENO` o `CAJERO` del local (fija también `validadaEn`) |

```text
              cancelar (anfitrión)
   ┌─────────────────────────────────► CANCELADA   (final)
ABIERTA ──┐
          │  validar (caja)
          └─────────────────────────► EN_MESA      (final en la práctica)

EN_CAMINO ─ igual que ABIERTA, pero ningún endpoint la produce
FINALIZADA ─ ningún endpoint ni proceso la produce
```

- **`EN_CAMINO`**: el código la trata igual que `ABIERTA` (se puede unir, cancelar y validar) y la política de la base de
  datos deja al anfitrión pasarla a `EN_CAMINO`, pero **no hay endpoint, evento ni cron que lo haga**. La app no debería
  esperarla.
- **`FINALIZADA`**: ningún código la asigna. Una mesa `EN_MESA` se queda así para siempre.
- **No hay vencimiento automático**: una mesa que nadie cancela ni valida queda `ABIERTA` para siempre. Solo deja de
  admitir invitados (`MESA_VENCIDA`, sección 4) y la caja aún puede validarla.
- Desde `EN_MESA` o `CANCELADA` no hay vuelta: cancelar una `EN_MESA` da `409 MESA_CERRADA` y validar una `CANCELADA`
  da `409 CONFLICT`.
- **Deshacer en caja no reabre la mesa:** `POST /v1/caja/consumos/{id}/deshacer` devuelve el almuerzo al plan, pero la
  mesa sigue `EN_MESA` y `validadaEn` no cambia.

## 4. Ventana de llegada

| Regla                                        | Valor                                                           | Dónde se aplica                                       |
| -------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| Fijar `horaLlegada` al **crear**: más pronto | **5 minutos antes** de "ahora" (hora del servidor)              | `ARRIVAL_WINDOW.pastMs` en `tables.ts`                |
| Fijar `horaLlegada` al **crear**: más tarde  | **12 horas después** de "ahora"                                 | `ARRIVAL_WINDOW.futureMs`                             |
| Fuera de ese rango                           | `400 HORA_LLEGADA_INVALIDA`                                     |                                                       |
| Cambiar `horaLlegada` después de crear       | **No se puede** (no hay endpoint)                               |                                                       |
| Unirse (y ver la invitación como posible)    | Hasta **1 hora después** de `horaLlegada`; luego `MESA_VENCIDA` | `fn_mesa_invitacion`: `hora_llegada < ahora − 1 hora` |
| Unirse antes de la llegada                   | Sin límite inferior                                             |                                                       |
| Validar en caja                              | **Sin ventana**: no se compara con `horaLlegada`                | `validateTable`                                       |

Ojo con el mensaje: el `detail` de `HORA_LLEGADA_INVALIDA` dice "entre ahora y las próximas 12 horas", pero el servidor
admite hasta 5 minutos en el pasado (para tolerar el desfase de reloj del teléfono). La app no debería mostrar ese texto
tal cual.

## 5. Invitaciones

**Formato.** La invitación es el `public_id` (UUID) de la mesa; no hay token firmado, ni caducidad propia, ni código
corto. La respuesta trae `invitacion` y la descripción del campo dice que va en `bocadoo://mesa/<invitacion>`. **El
servidor no genera ni valida ese link:** "el link lo arma la app". Tampoco define el contenido del QR: lo razonable es
codificar ese mismo link, pero eso lo decide el frontend (no claro: ver dudas, sobre el esquema `bocadoo://` y los _universal links_).

**Cómo valida el servidor.** Dos pasos, ambos con el usuario autenticado:

1. `GET /v1/mesas/invitacion/{id}` (`fn_mesa_invitacion`, solo lectura). Un no miembro no puede leer la mesa (RLS), así
   que esta función devuelve solo lo necesario para decidir, sin ids internos. Orden de las comprobaciones, la primera que
   se cumple da el `motivo`:

   | Orden | Condición                                                      | `motivo`                     |
   | ----- | -------------------------------------------------------------- | ---------------------------- |
   | 1     | El usuario ya es miembro                                       | `YA_ERES_MIEMBRO`            |
   | 2     | El restaurante no está `ACTIVO` (por ejemplo `PAUSADO`)        | `RESTAURANTE_NO_DISPONIBLE`  |
   | 3     | La mesa no está `ABIERTA`/`EN_CAMINO`, o ya tiene `validadaEn` | `MESA_CERRADA`               |
   | 4     | `horaLlegada` fue hace más de 1 hora                           | `MESA_VENCIDA`               |
   | 5     | `personas >= capacidad`                                        | `MESA_LLENA`                 |
   | —     | Ninguna                                                        | `null` (`puedeUnirse: true`) |

2. `POST /v1/mesas/invitacion/{id}/unirse` (`fn_unirse_mesa`): bloquea la fila de la mesa, **repite la misma validación**
   (así dos invitados a la vez no pasan del cupo) e inserta al miembro. Devuelve `UNIDO` o `YA_ERES_MIEMBRO` (ambos → `200`
   con la mesa) o el motivo de rechazo (→ error 409, sección 6).

Como `YA_ERES_MIEMBRO` se evalúa primero, un miembro que vuelve a abrir el link de una mesa **cancelada o ya validada** ve
`puedeUnirse: false, motivo: YA_ERES_MIEMBRO`, y `unirse` le responde `200` con la mesa (que mostrará `CANCELADA` o
`EN_MESA`). Hay que mirar `estado` de la mesa devuelta, no asumir que `200` significa "mesa viva".

**Invitado CON cuenta.** Es el único camino que existe: el invitado inicia sesión, abre el link y se une. Entra con su
`nombre` de usuario y su `paraLlevar`. No necesita ser cliente del restaurante ni tener plan para unirse (la caja lo
marcará "por cobrar" si no tiene).

**Invitado SIN cuenta.** **El backend no tiene ningún endpoint ni flujo que lo permita.** `unirse` exige sesión (el guard JWT
es global y el endpoint no es `@Public()`), así que quien no tiene cuenta debe registrarse (`POST /v1/auth/register`) e
iniciar sesión (`POST /v1/auth/login`) antes. La base sí admite miembros sin usuario (`usuario_id` nulo, comentado como
"invitado sin cuenta") y la caja los trata (aparecen con `tieneCuenta: false`, resultado `SIN_PLAN`), pero **ningún
código del backend los crea**: solo las pruebas y la base directamente. Si el flujo de la app quiere "invitar a alguien sin app", hoy no hay soporte (ver dudas).

No confundir con `tieneCuenta` de la vista de caja, que significa "ficha de cliente en este restaurante": un
usuario de la app sin ficha en el local sale con `tieneCuenta: false`.

**Límites.**

- **Miembros por mesa:** `capacidad`, que es **12** salvo que la mesa tenga una mesa física del local (`mesa_local_id`)
  con otra capacidad. La creación desde la app **nunca** asigna `mesa_local_id`, así que en la práctica **siempre 12**
  (anfitrión incluido). Con 12 miembros, el siguiente recibe `MESA_LLENA`.
- **Cupo del local:** **el código no comprueba el aforo ni la ocupación del restaurante**. No lee horarios ni el número de
  mesas del local al crear o unirse. Lo único del local que se exige es `estado = 'ACTIVO'`.
- **Local lleno:** no existe ese concepto; lo más parecido es `MESA_LLENA`, que es de **la mesa** (12 personas), no del local.
- **Local cerrado/pausado/baja:** `RESTAURANTE_NO_DISPONIBLE` (409) al unirse. Al **crear**, un local no activo da
  `404 RESTAURANTE_NO_ENCONTRADO` (el mismo error que un UUID inexistente). Si el local solo está fuera de su horario del día, el código no lo detecta.

## 6. Errores

Formato de todos: `application/problem+json` con `type`, `title`, `status`, `code`, `detail`, `instance`, `requestId`.
**La app debe decidir por `code`, no por `detail`.** Ejemplo real de la forma (de `api-contrato.md`):

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

El texto de "Qué mostrar" es una **sugerencia** de UX; el código solo define status y `code`.

### 6.1 Lado del comensal

| Endpoint                              | Status | `code`                              | Cuándo                                                                                       | Qué mostrar                                                                                          |
| ------------------------------------- | ------ | ----------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/mis/mesas`                  | 400    | `HORA_LLEGADA_INVALIDA`             | `horaLlegada` fuera de [−5 min, +12 h]                                                       | "Elige una hora de llegada dentro de las próximas 12 horas" (no mostrar el `detail`)                 |
| `POST /v1/mis/mesas`                  | 404    | `RESTAURANTE_NO_ENCONTRADO`         | UUID inexistente **o** local no activo (pausado, borrador, baja)                             | "Este restaurante no está disponible"; volver a la lista                                             |
| `POST /v1/mis/mesas`                  | 409    | `IDEMPOTENCY_KEY_REUTILIZADA`       | La misma llave ya creó una mesa en **otro** restaurante                                      | Error interno de la app: generar una llave nueva por cada intento nuevo de crear                     |
| `POST /v1/mis/mesas`, `POST …/unirse` | 400    | `IDEMPOTENCY_KEY_INVALIDA`          | Falta `Idempotency-Key` o no es UUID                                                         | Error de programación; no mostrar al usuario                                                         |
| `GET /v1/mis/mesas/{id}`              | 404    | `MESA_NO_ENCONTRADA`                | La mesa no existe **o** el usuario no es anfitrión ni miembro (el servidor no los distingue) | "No encontramos esta mesa"; si venía de un link, ofrecer la vista previa de invitación               |
| `POST …/cancelar`                     | 404    | `MESA_NO_ENCONTRADA`                | Igual que arriba                                                                             | Igual; refrescar la lista                                                                            |
| `POST …/cancelar`                     | 403    | `SOLO_ANFITRION`                    | Un miembro que no es anfitrión intenta cancelar                                              | "Solo quien creó la mesa puede cancelarla" (mejor: no mostrar el botón si `soyAnfitrion` es `false`) |
| `POST …/cancelar`                     | 409    | `MESA_CERRADA`                      | La mesa ya tiene `validadaEn` o no está `ABIERTA`/`EN_CAMINO` (p. ej. `EN_MESA`)             | "La caja ya validó la mesa; ya no se puede cancelar"; refrescar la mesa                              |
| `GET /v1/mesas/invitacion/{id}`       | 404    | `MESA_NO_ENCONTRADA`                | El UUID no corresponde a ninguna mesa                                                        | "Este link no es válido"                                                                             |
| `GET /v1/mesas/invitacion/{id}`       | 200    | (sin `code`; `motivo` en el cuerpo) | `puedeUnirse: false`                                                                         | Ver tabla de `motivo` abajo                                                                          |
| `POST …/unirse`                       | 404    | `MESA_NO_ENCONTRADA`                | El UUID no corresponde a ninguna mesa                                                        | "Este link no es válido"                                                                             |
| `POST …/unirse`                       | 409    | `MESA_CERRADA`                      | Mesa cancelada, `EN_MESA`, `FINALIZADA` o ya validada                                        | "Esta mesa ya no recibe invitados"                                                                   |
| `POST …/unirse`                       | 409    | `MESA_VENCIDA`                      | Pasó más de 1 hora de `horaLlegada`                                                          | "Esta invitación venció"                                                                             |
| `POST …/unirse`                       | 409    | `MESA_LLENA`                        | Ya hay 12 miembros                                                                           | "La mesa está llena"                                                                                 |
| `POST …/unirse`                       | 409    | `RESTAURANTE_NO_DISPONIBLE`         | El local no está `ACTIVO`                                                                    | "El restaurante no está disponible ahora"                                                            |

`motivo` de la vista previa (el mismo vocabulario que los `code` de `unirse`, salvo `YA_ERES_MIEMBRO`):

| `motivo`                    | Qué mostrar                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `null`                      | Botón "Unirme"                                                                       |
| `YA_ERES_MIEMBRO`           | No es un error: llevar a _Ver mesa_ (`GET /v1/mis/mesas/{id}`) y mostrar su `estado` |
| `MESA_CERRADA`              | "Esta mesa ya no recibe invitados"                                                   |
| `MESA_VENCIDA`              | "Esta invitación venció"                                                             |
| `MESA_LLENA`                | "La mesa está llena"                                                                 |
| `RESTAURANTE_NO_DISPONIBLE` | "El restaurante no está disponible ahora"                                            |

### 6.2 Lado de caja

Aquí **no hay códigos propios de mesa**: la caja usa excepciones genéricas, así que `NOT_FOUND` y `CONFLICT` significan
varias cosas y solo el `detail` las distingue (limitación ya documentada en `api-contrato.md`).

| Endpoint                                   | Status | `code`                     | Cuándo                                                                             | Qué mostrar                                                  |
| ------------------------------------------ | ------ | -------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET`/`POST /v1/caja/mesas/{id}[/validar]` | 404    | `NOT_FOUND`                | `detail`: "Mesa no encontrada." La mesa no existe **o es de otro restaurante**     | "Esta mesa no es de este local o no existe"                  |
| `POST …/validar`                           | 409    | `CONFLICT`                 | `detail`: "La mesa está cancelada." (o `finalizada`). Ya no se puede validar       | "La mesa fue cancelada por el anfitrión"; no ofrecer validar |
| `POST …/validar`                           | 400    | `IDEMPOTENCY_KEY_INVALIDA` | Falta `Idempotency-Key` o no es UUID                                               | Error de programación                                        |
| ambos                                      | 400    | `BAD_REQUEST`              | `{id}` no es UUID ("Identificador inválido.") o falta/no es UUID `x-restaurant-id` | Error de programación                                        |
| ambos                                      | 403    | `FORBIDDEN`                | "No tienes acceso a este restaurante." (no trabaja ahí o está desactivado)         | "No tienes acceso a este restaurante"; volver a elegir local |
| ambos                                      | 403    | `FORBIDDEN`                | "Tu rol no permite esta acción." (no es `DUENO` ni `CAJERO`)                       | "Tu rol no permite validar mesas"                            |

Los dos `403` comparten `code`; se distinguen por `detail`.

**Importante:** el resultado de cada miembro (`SIN_PLAN`, `SIN_SALDO`, `VENCIDO`, `DIA_NO_VALIDO`, `DUPLICADO`,
`LIMITE_SAAS`, `OK_ADVERTENCIA`) **no es un error**: la validación responde `200` y esos casos van en `resultados`.
Mostrar por cada miembro su `resultado` y destacar los `descontado: false` como "por cobrar" (los textos de cada
`resultado` están en `RESULTADOS`, en `src/checkout/checkout.ts`).

### 6.3 Errores comunes a todos los endpoints

| Status | `code`              | Cuándo                                                                                                                                 | Qué mostrar                                                    |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 400    | `BAD_REQUEST`       | Cuerpo inválido (`horaLlegada` no ISO, `modo` fuera de la lista, `paraLlevar` no booleano, **campos de más**), o `{id}` que no es UUID | Error de programación; `detail` une los mensajes de validación |
| 400    | `BAD_REQUEST`       | Un valor que Postgres rechaza ("Algún dato tiene un valor no permitido.")                                                              | "Revisa los datos"                                             |
| 401    | `UNAUTHORIZED`      | Sin token o token vencido                                                                                                              | `POST /v1/auth/refresh`; si falla, ir a login                  |
| 403    | `FORBIDDEN`         | Permiso denegado por la base: "No tienes permiso para esa acción." (p. ej. usuario inactivo al unirse)                                 | "No puedes realizar esta acción"                               |
| 409    | `CONFLICT`          | Violación de unicidad no prevista: "Ya existe un registro con esos datos."                                                             | "Algo cambió; vuelve a intentar" y refrescar                   |
| 413    | `PAYLOAD_TOO_LARGE` | Cuerpo demasiado grande (según `api-contrato.md`)                                                                                      | Error de programación                                          |
| 429    | `TOO_MANY_REQUESTS` | Más de 120 peticiones por minuto por IP (límite general). Cabecera `retry-after` (segundos)                                            | "Demasiados intentos"; esperar `retry-after`                   |
| 5xx    | `ERROR_INTERNO`     | Error del servidor (`detail` genérico)                                                                                                 | "Algo salió mal"; mostrar `requestId` para soporte             |

## 7. Reglas que afectan a la app

### 7.1 Qué se descuenta y cuándo

- **Solo en `POST /v1/caja/mesas/{id}/validar`.** Crear, unirse, cancelar y consultar no tocan ningún saldo.
- Se descuenta **1 almuerzo por miembro** (`cantidad = 1`), del plan `ACTIVA` que vence primero y que vale hoy
  (`dias_validos` incluye el día de hoy del local). `paraLlevar` de cada miembro queda en su consumo.
- Todo ocurre en **una sola transacción**: la mesa pasa a `EN_MESA` y `validadaEn` se fija junto con los descuentos. Un fallo
  deja todo como estaba.
- Se puede validar con cualquier cantidad de miembros, incluso si **nadie** tiene plan: la mesa igual pasa a `EN_MESA`
  con `descontados: 0` y todos "por cobrar".
- **Una sola validación:** una mesa se valida una vez. Repetir (misma llave u otra, desde otra caja) no descuenta de nuevo (`yaValidada: true`). Dos cajas a la vez: se descuenta una sola vez (prueba `checkout.int.ts`).
- Cada miembro usa una llave de idempotencia derivada de la `Idempotency-Key` de la petición, así que un reintento tras un
  corte no duplica descuentos.

### 7.2 Relación con `MENU_NO_PUBLICADO`

- **Ningún endpoint de mesas devuelve `MENU_NO_PUBLICADO`.** Ni crear/unirse (comensal) ni `GET`/`POST /v1/caja/mesas/*`
  llaman a la comprobación de menú publicado.
- Esa comprobación sí existe en `POST /v1/caja/validar` (QR o manual), en `GET /v1/pase` y en `GET /v1/pase/codigo?restaurante=`
  (y en `POST /v1/mis/pedidos`). Es decir: **si el local no publicó el menú de hoy, los comensales de una mesa pueden
  crearla y unirse, y la caja puede validarla**, aunque no pueda validar un QR suelto. La app no debe bloquear la
  creación de la mesa por "menú no publicado" salvo que el producto lo decida; el backend no lo exige (ver dudas).

### 7.3 Relación con `DUPLICADO`

`DUPLICADO` es la regla "mismo comensal con un canje sin deshacer en ese local hace menos de 60 s" (`qr-flujo.md`).

- **`INVITO_YO`: no aplica** (`p_omitir_duplicado`). El anfitrión paga todos los almuerzos seguidos.
- **`CADA_UNO`: sí aplica por miembro.** Si un miembro fue validado hace menos de 60 s en ese local (por ejemplo la caja
  escaneó su QR justo antes de validar la mesa), su resultado en la mesa es `DUPLICADO`, `descontado: false`, y **cuenta
  como "por cobrar"** aunque sí tenga plan. Es un caso raro, pero la caja debe mirar `resultados` y no solo `porCobrar`.
- El **reintento** de la misma mesa **no** produce `DUPLICADO` (devuelve `yaValidada`).
- Una mesa `CADA_UNO` validada no bloquea al comensal en el QR normal después de 60 s.

### 7.4 ¿La mesa emite eventos en tiempo real (SSE)?

**La mesa como tal no emite ningún evento.** El único aviso SSE relacionado es el que ya existe para el pase
(`GET /v1/pase/eventos`), y solo por el descuento de saldo:

| Cosa que pasa                                  | ¿Emite SSE?                | Detalle                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caja valida la mesa y se descuenta un almuerzo | **Sí**, `CANJE_REGISTRADO` | A **quien pagó** ese almuerzo (cada miembro en `CADA_UNO`; el anfitrión, uno por almuerzo, en `INVITO_YO`). `data`: `tipo`, `consumoId`, `restauranteNombre`, `saldoRestante`, `platoNombre` (`null`), `hora`. Se emite tras el COMMIT y solo si el pagador tiene cuenta en la app |
| Caja deshace un canje de mesa (10 s)           | **Sí**, `CANJE_REVERTIDO`  | A quien pagó ese almuerzo                                                                                                                                                                                                                                                          |
| Miembro sin plan, `DUPLICADO` o `SIN_*`        | No                         | Nada se descontó                                                                                                                                                                                                                                                                   |
| Crear la mesa                                  | **No**                     |                                                                                                                                                                                                                                                                                    |
| Alguien se une a la mesa                       | **No**                     | El anfitrión y los demás miembros **no se enteran**: deben refrescar                                                                                                                                                                                                               |
| El anfitrión cancela                           | **No**                     | Los invitados **no se enteran**: deben refrescar                                                                                                                                                                                                                                   |
| La caja valida la mesa (el cambio a `EN_MESA`) | **No** (el estado)         | El invitado en `INVITO_YO` no recibe ni siquiera el `CANJE_REGISTRADO` (no se le descontó). La app no se entera de `EN_MESA` ni de `validadaEn`                                                                                                                                    |
| Cambio de `estado` por cualquier otra vía      | **No**                     | No existe evento de mesa en `pass-events` (el tipo de evento solo conoce canje registrado/revertido, latido y fin)                                                                                                                                                                 |
| Mesa vencida (pasó 1 h de la llegada)          | **No**                     | No hay proceso que la marque                                                                                                                                                                                                                                                       |

**Qué debe hacer la app:** no hay evento de mesa al que suscribirse. Refrescar con `GET /v1/mis/mesas/{id}`
(a) al abrir la pantalla _Ver mesa_, (b) con _pull-to-refresh_, (c) al volver a primer plano y (d) opcionalmente con un
temporizador mientras la pantalla esté visible (el intervalo es decisión del frontend; el backend no lo fija).
El `CANJE_REGISTRADO` por SSE puede usarse como **señal indirecta** de que la caja ya validó (si el miembro pagó con su
plan), pero no reemplaza el refresco: no trae el id de la mesa y no cubre a los que no pagaron. Tampoco hay que usar
SSE para saber cuántos se unieron.

## 8. Secuencia de ejemplo

Ejemplos tomados de `docs/api-contrato.md`, que se genera con respuestas reales de la API. **Los ids y las horas cambian de
un ejemplo a otro porque salen de distintas corridas**, y las listas `miembros` están recortadas en el contrato; los
campos y las formas son los reales. No lleva tokens: `<accessToken>` es un marcador. Las pruebas
`diner-tables.int.ts` y `diner-e2e.int.ts` recorren este mismo flujo.

**1. Anfitrión crea la mesa** (comensal)

```http
POST /v1/mis/mesas
Authorization: Bearer <accessToken>
Idempotency-Key: 5b0c8f6e-3a1d-4f0e-9c2a-7d1e4b8a6f10
Content-Type: application/json

{ "restaurante": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4", "horaLlegada": "2026-11-13T04:28:00Z", "modo": "CADA_UNO" }
```

```json
// 201
{
  "id": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "invitacion": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "restaurante": { "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4", "nombre": "Doña Rosa", "slug": "dona-rosa-23902c" },
  "anfitrion": { "nombre": "Ana Mora" },
  "soyAnfitrion": true,
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "validadaEn": null,
  "miembros": [{ "nombre": "Ana Mora", "esAnfitrion": true, "paraLlevar": false, "soyYo": true }]
}
```

La app arma el link `bocadoo://mesa/c0d399aa-8863-451c-b315-c8a42cc9dec8` y lo comparte.

**2. Invitado valida el link** (otro comensal)

```http
GET /v1/mesas/invitacion/c0d399aa-8863-451c-b315-c8a42cc9dec8
Authorization: Bearer <accessToken>
```

```json
// 200
{
  "id": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "restaurante": { "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4", "nombre": "Doña Rosa", "slug": "dona-rosa-23902c" },
  "anfitrion": { "nombre": "Ana Mora" },
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "personas": 1,
  "capacidad": 12,
  "puedeUnirse": true,
  "motivo": null
}
```

**3. Invitado se une**

```http
POST /v1/mesas/invitacion/c0d399aa-8863-451c-b315-c8a42cc9dec8/unirse
Authorization: Bearer <accessToken>
Idempotency-Key: 9d3e2a41-6b7c-4c55-8f0a-1a2b3c4d5e6f
Content-Type: application/json

{ "paraLlevar": false }
```

```json
// 200 (el invitado ya aparece en miembros; en el contrato la lista está recortada)
{
  "id": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "invitacion": "c0d399aa-8863-451c-b315-c8a42cc9dec8",
  "restaurante": { "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4", "nombre": "Doña Rosa", "slug": "dona-rosa-23902c" },
  "anfitrion": { "nombre": "Ana Mora" },
  "soyAnfitrion": false,
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "validadaEn": null,
  "miembros": [{ "nombre": "Ana Mora", "esAnfitrion": true, "paraLlevar": false, "soyYo": false }]
}
```

Alternativas del paso 3 (de las pruebas, el cuerpo sigue la forma de la sección 6): mesa llena → `409` `MESA_LLENA`; mesa cancelada → `409` `MESA_CERRADA`;
local pausado → `409` `RESTAURANTE_NO_DISPONIBLE`; `Idempotency-Key` ausente → `400` `IDEMPOTENCY_KEY_INVALIDA`.

**4. Cualquiera de los dos mira la mesa** (se repite al refrescar)

```http
GET /v1/mis/mesas/c0d399aa-8863-451c-b315-c8a42cc9dec8
Authorization: Bearer <accessToken>
```

Responde `200` con el objeto Mesa del paso 1 pero con los dos miembros y `soyAnfitrion` / `soyYo` según quién consulta.

**5. Caja: vista previa** (personal; el ejemplo del contrato es de otra mesa)

```http
GET /v1/caja/mesas/c0d399aa-8863-451c-b315-c8a42cc9dec8
Authorization: Bearer <accessToken>
x-restaurant-id: a108d856-5d0e-4e0c-a36a-e8e5b855d1f4
```

```json
// 200
{
  "modo": "CADA_UNO",
  "estado": "ABIERTA",
  "horaLlegada": "2026-11-13T04:28:00.000Z",
  "validadaEn": null,
  "personas": 2,
  "cubiertos": 1,
  "miembros": [{ "nombre": "Ana Mora", "esAnfitrion": true, "paraLlevar": false, "tieneCuenta": true, "almuerzosDisponibles": 3 }]
}
```

**6. Caja: validar toda la mesa**

```http
POST /v1/caja/mesas/c0d399aa-8863-451c-b315-c8a42cc9dec8/validar
Authorization: Bearer <accessToken>
x-restaurant-id: a108d856-5d0e-4e0c-a36a-e8e5b855d1f4
Idempotency-Key: 0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f
```

```json
// 200 (en el contrato, `miembros` y `resultados` están recortados a un elemento)
{
  "modo": "CADA_UNO",
  "estado": "EN_MESA",
  "horaLlegada": "2026-11-13T04:39:00.000Z",
  "validadaEn": "2026-11-13T03:49:45.449Z",
  "personas": 2,
  "cubiertos": 2,
  "miembros": [{ "nombre": "Ana Mora", "esAnfitrion": true, "paraLlevar": false, "tieneCuenta": true, "almuerzosDisponibles": 3 }],
  "yaValidada": false,
  "resultados": [{ "miembro": "Ana Mora", "resultado": "OK", "descontado": true, "consumoId": "f38889e0-2ade-4ccc-8323-fd112f8db371" }],
  "descontados": 1,
  "porCobrar": 1
}
```

Efecto en la app: a cada comensal al que se le descontó le llega `CANJE_REGISTRADO` por `GET /v1/pase/eventos` (si tiene la
conexión abierta). Para ver `EN_MESA`, el invitado y el anfitrión deben volver a pedir `GET /v1/mis/mesas/{id}`.

**7. Cancelar** (alternativa, solo anfitrión y antes del paso 6; ejemplo de otra mesa `INVITO_YO`)

```http
POST /v1/mis/mesas/7c3ffb95-4e17-4e05-a798-cf0f72521039/cancelar
Authorization: Bearer <accessToken>
```

```json
// 200
{
  "id": "7c3ffb95-4e17-4e05-a798-cf0f72521039",
  "invitacion": "7c3ffb95-4e17-4e05-a798-cf0f72521039",
  "restaurante": { "id": "a108d856-5d0e-4e0c-a36a-e8e5b855d1f4", "nombre": "Doña Rosa", "slug": "dona-rosa-23902c" },
  "anfitrion": { "nombre": "Ana Mora" },
  "soyAnfitrion": true,
  "horaLlegada": "2026-11-13T04:39:00.000Z",
  "modo": "INVITO_YO",
  "estado": "CANCELADA",
  "validadaEn": null,
  "miembros": [{ "nombre": "Ana Mora", "esAnfitrion": true, "paraLlevar": false, "soyYo": true }]
}
```

Tras la validación, el mismo `POST …/cancelar` da `409` `MESA_CERRADA`; un miembro que no es anfitrión recibe `403`
`SOLO_ANFITRION`.

## 9. Pantallas ↔ endpoints

| Pantalla                      | Endpoints                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Crear mesa                    | `POST /v1/mis/mesas` (restaurante de `GET /v1/restaurantes`, hora, modo)                                                      |
| Invitar                       | Sin endpoint propio: usa `invitacion` de la respuesta de crear (o de `GET /v1/mis/mesas/{id}`) para armar link/QR             |
| Unirse (vista previa y botón) | `GET /v1/mesas/invitacion/{id}` → `POST /v1/mesas/invitacion/{id}/unirse`                                                     |
| Ver mesa / lista de mesas     | `GET /v1/mis/mesas/{id}`, `GET /v1/mis/mesas` (refresco manual, sin SSE)                                                      |
| Cancelar (anfitrión)          | `POST /v1/mis/mesas/{id}/cancelar`                                                                                            |
| Salir (invitado)              | **No existe endpoint**                                                                                                        |
| Validar en caja               | `GET /v1/caja/mesas/{id}` → `POST /v1/caja/mesas/{id}/validar` (→ `POST /v1/caja/consumos/{id}/deshacer` si hubo error, 10 s) |

## 10. Dudas del código

Ambigüedades, huecos e inconsistencias encontrados al leer el código. No se cambió nada.

1. **Un invitado no puede salir de la mesa.** No hay endpoint de "salir" ni de quitar miembros; la política de la base de
   datos tampoco permite borrar filas de `mesa_compartida_miembro` al comensal. La pantalla "salir" no tiene respaldo en el
   backend. Si alguien se une por error, queda hasta que el anfitrión cancele o la caja valide (y en `CADA_UNO` se le descuenta).
2. **Invitados sin cuenta no están soportados**, aunque la base los modela (`usuario_id` nulo) y la caja los muestra
   (`tieneCuenta: false`). Ningún endpoint crea esos miembros. Hay que aclarar si el producto los quiere (y cómo se agregarían, por ejemplo por nombre) o si la caja solo ve usuarios de la app sin ficha en el local.
3. **`EN_CAMINO` y `FINALIZADA` no tienen quién las produzca.** El enum y la política RLS del anfitrión (`ABIERTA → EN_CAMINO`)
   prevén `EN_CAMINO`, pero ningún endpoint, evento ni cron la asigna; `FINALIZADA` ni siquiera aparece en el código. La app
   debe tratarlas como estados posibles pero hoy inalcanzables.
4. **Las mesas no vencen.** Una mesa que nadie cancela ni valida queda `ABIERTA` para siempre y aparece en `GET /v1/mis/mesas`
   (máximo 50, sin filtro ni paginación). `MESA_VENCIDA` solo bloquea invitados. La caja puede validar una mesa de hace días o de dentro de 12 horas: `validateTable` no compara con `horaLlegada`.
5. **`HORA_LLEGADA_INVALIDA` miente en el texto.** Dice "entre ahora y las próximas 12 horas" pero acepta hasta 5 minutos
   atrás. Además, la descripción de Swagger dice "de ahora a 12 horas".
6. **`MENU_NO_PUBLICADO` no aplica a mesas**, mientras sí aplica al QR suelto, al pase y a los pedidos. Una mesa se puede validar
   en un local sin menú publicado. ¿Es intencional? Hoy la caja puede descontar almuerzos por mesa donde no podría por QR.
7. **Códigos genéricos en caja.** `GET/POST /v1/caja/mesas/*` responde `NOT_FOUND` y `CONFLICT` genéricos
   (`"Mesa no encontrada."`, `"La mesa está cancelada."`) en vez de códigos estables como `MESA_NO_ENCONTRADA` o
   `MESA_CERRADA` del lado del comensal. Con `CONFLICT` la app de caja solo puede distinguir por `detail`, que "puede cambiar".
8. **Idempotencia de `validar` no reproduce la respuesta original.** Reintentar tras un corte de red devuelve `yaValidada: true`
   con `resultados: []` y sin `descontados`/`porCobrar` (esos campos son obligatorios en el contrato de `MesaValidadaResponse`
   pero faltan en ese caso). Si la respuesta original se perdió, la caja no recupera qué miembros quedaron por cobrar; solo vería `descontado` por consumo en otros endpoints.
9. **`unirse` pide `Idempotency-Key` pero la ignora** (el parámetro se llama `_key`); la idempotencia real es que el miembro es único
   por mesa. Tampoco `cancelar` la pide. Y `crear` con la misma llave pero otro `horaLlegada` o `modo` devuelve la mesa original sin avisar del cambio.
10. **`cubiertos` y `almuerzosDisponibles` son optimistas.** No consideran `dias_validos` del plan (`DIA_NO_VALIDO`), el límite SaaS
    (`LIMITE_SAAS`) ni un posible `DUPLICADO` en `CADA_UNO`. La validación real puede dar menos descontados que `cubiertos`.
11. **`DUPLICADO` en `CADA_UNO` cuenta como "por cobrar"** aunque el comensal tenga plan; y `porCobrar` mezcla "sin plan", "sin saldo",
    "duplicado", "límite SaaS" y "día no válido". Hay que leer `resultados` miembro por miembro.
12. **El "por cobrar" no crea ningún registro.** Solo se devuelve el número; no hay venta ni deuda asociada a la mesa. La doc
    (`estado.md`) dice que se cobra "como venta suelta", pero el backend no vincula esa venta con la mesa.
13. **Deshacer un canje de mesa no reabre la mesa** ni cambia `validadaEn`/`estado`. Si la caja deshace los canjes porque se validó la mesa equivocada, la mesa queda `EN_MESA` sin descuentos y ya no se puede volver a validar (devuelve `yaValidada: true`).
14. **`INVITO_YO` y aviso al invitado.** El invitado en `INVITO_YO` no recibe ningún SSE y su saldo no cambia; solo el anfitrión
    recibe un `CANJE_REGISTRADO` por almuerzo (hasta N eventos seguidos en una sola validación). No hay forma de que el invitado se entere de que "lo invitaron" sin refrescar la mesa.
15. **Capacidad real = 12 siempre.** La creación desde la app nunca fija `mesa_local_id`, así que la capacidad de la mesa física
    del local no se usa; no hay chequeo de aforo ni de horario del local. La pregunta de "local lleno" no tiene implementación.
16. **`YA_ERES_MIEMBRO` tiene prioridad sobre el estado.** Un miembro que abre el link de una mesa cancelada o validada recibe
    `puedeUnirse: false` con `YA_ERES_MIEMBRO` y `unirse` responde `200`; el `motivo` real (cancelada/validada) se pierde. Hay que mirar `estado` de la mesa.
17. **Cancelar una mesa no avisa a los invitados** y no les queda ninguna marca más allá de `estado: CANCELADA` al refrescar. Tampoco se
    notifica al local (no hay aviso a cocina implementado: la columna `avisada_cocina_en` existe pero ningún código la escribe).
18. **Formato del link y del QR.** `bocadoo://mesa/<invitacion>` solo aparece como texto en la descripción de Swagger; el servidor no lo genera, no hay _universal link_ (https) ni se define el contenido del QR. Un invitado sin la app instalada no tiene a dónde llegar con un esquema `bocadoo://`.
19. **Enumeración del link.** `GET /v1/mesas/invitacion/{id}` lo puede consultar cualquier usuario con sesión que conozca el UUID y devuelve
    nombre del anfitrión, restaurante y número de personas. Solo lo limita el rate limit general (120/min por IP); no hay uno específico.
20. **Nombres de miembros como copia.** El `nombre` del miembro se copia al unirse; si el usuario cambia su nombre después, la mesa y la caja siguen mostrando el anterior. Además, dos miembros con el mismo nombre son indistinguibles para la app (no hay id de miembro).
21. **`validadaEn` en la respuesta de `validar`** se calcula con la hora del proceso de la API (`new Date()`), mientras que lo guardado
    en la base usa `CURRENT_TIMESTAMP`. Pueden diferir en milisegundos; `GET /v1/mis/mesas/{id}` devuelve el valor de la base.
22. **Ejemplos del contrato recortados.** Las respuestas de ejemplo de `unirse` y de `validar` en `api-contrato.md` tienen `miembros`
    con un solo elemento aunque `personas` sea 2; por eso aquí se avisa que están recortadas. No se pudo regenerar una secuencia completa de una sola corrida sin ejecutar la API contra una base (no se tocó `.env` ni Neon).
