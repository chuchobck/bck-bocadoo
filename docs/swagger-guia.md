# Guía de Swagger con cuentas demo

Recorrido paso a paso por `/docs` (Swagger UI) para probar los tres flujos principales: **dueño**, **cajero** y **comensal**. El contrato completo está en `docs/openapi.json` (se regenera con `pnpm openapi:export`) y las reglas de cada endpoint en `docs/api-contrato.md`.

Swagger agrupa los endpoints por quién puede llamarlos: **Público**, **Comensal**, **Caja** (dueño y cajero) y **Dueño**.

## 1. Preparar el entorno

1. Postgres 16 con las migraciones y el seed demo (`db/seeds/demo.sql`) aplicados. Para probar en local usa un contenedor Docker, no Neon.
2. Las cuentas demo nacen **sin contraseña**. Asígnale una a todas (solo desarrollo; el script se niega con `NODE_ENV=production`):

   ```
   DEMO_PASSWORD='una-clave-de-10-o-mas' pnpm db:demo-passwords
   ```

   Usa `DATABASE_SERVICE_URL` de tu `.env`: confirma que apunta a la base donde quieres la clave. La contraseña no se guarda en el repo.

3. `pnpm dev` y abre <http://localhost:3000/docs> (Swagger está apagado en producción).

## 2. Cuentas demo

Todas terminan en `@demo.bocadoo.test` y comparten la contraseña que asignaste. Datos ficticios.

| Rol      | Correo                            | Local                                  |
| -------- | --------------------------------- | -------------------------------------- |
| Dueño    | `maria.guaman@demo.bocadoo.test`  | La Cuchara de San Blas                 |
| Cajero   | `juan.pilataxi@demo.bocadoo.test` | La Cuchara de San Blas                 |
| Comensal | `kevin.simbana@demo.bocadoo.test` | cliente de La Cuchara, con plan activo |

Otros dueños: `daniela.andrade` (Verde Limón), `lucia.paredes` (Sazón Criolla), `ramon.zambrano` (El Rincón Manabita) y `vicente.chicaiza` (Don Vicho Almuerzos).

## 3. Cómo autenticarse en Swagger

1. En **Público → `POST /v1/auth/login`**, pulsa _Try it out_ con `{"identificador": "<correo>", "password": "<tu clave>"}`.
2. Copia `accessToken` de la respuesta (dura 15 minutos; después usa `POST /v1/auth/refresh` con el `refreshToken`, que sirve una sola vez).
3. Pulsa **Authorize** (arriba a la derecha), pega el token (sin la palabra `Bearer`) y confirma.
4. Los endpoints de **Caja** y **Dueño** piden además el encabezado **`x-restaurant-id`**: es el `id` del restaurante que devuelve `GET /v1/auth/me` en `restaurantes[]`. Cópialo en el campo del endpoint.
5. Los `POST` que cobran o crean piden **`Idempotency-Key`**: un UUID nuevo por operación (repetir la petición con la misma clave devuelve el mismo resultado sin cobrar dos veces).

Los errores llegan como `application/problem+json` con un `code` estable (por ejemplo `OFERTA_AGOTADA`); decide por el `code`, no por el texto de `detail`.

## 4. Flujo del dueño (María Guamán)

1. **Login** como `maria.guaman@…` y Authorize. En **Comensal → `GET /v1/auth/me`** copia el `id` de _La Cuchara de San Blas_ como `x-restaurant-id`.
2. **Dueño → `GET /v1/restaurante`**: perfil, estado `ACTIVO`, precio suelto.
3. **`GET /v1/menu/hoy`**: el menú de hoy. Con `PUT /v1/menu/hoy` lo defines y con `POST /v1/menu/hoy/publicar` lo publicas (los comensales solo ven lo publicado).
4. **`GET /v1/planes`**: plantillas de plan; anota un `id`.
5. **`GET /v1/clientes?q=Kevin`**: busca al cliente y anota su `id`. Luego **`POST /v1/clientes/{id}/planes`** con `{"planId": "<id del plan>", "metodoPago": "EFECTIVO"}` y una `Idempotency-Key`: vende el plan (efectivo queda confirmado; con `TRANSFERENCIA` queda pendiente).
6. **`GET /v1/pagos/pendientes`** y `POST /v1/pagos/{id}/confirmar` (o `…/rechazar`, que anula el plan).
7. **Ofertas flash**: `POST /v1/ofertas` con una `Idempotency-Key` y
   `{"titulo": "Churrasco a mitad de tarde", "precioCentavos": 450, "precioOriginalCentavos": 650, "stock": 5, "duracionMinutos": 60}`. Aparece en la vitrina pública (`GET /v1/restaurantes/la-cuchara-de-san-blas/ofertas`). Ciérrala con `POST /v1/ofertas/{id}/cerrar`.
8. **Reportes** (solo dueño): `GET /v1/reportes/resumen-diario`, `…/ventas-planes`, `…/horas-pico`, `…/ranking-platos`, `…/almuerzos-pendientes`, `…/clientes-a-contactar`.
9. **`GET /v1/suscripcion`** y `GET /v1/suscripcion/uso`: plan SaaS y escaneos usados.
10. Al cerrar el día: **`GET /v1/caja/cierre/hoy`** para ver lo esperado y `POST /v1/caja/cierre/hoy` con `{"efectivoContadoCentavos": <lo contado>}`.

## 5. Flujo del cajero (Juan Pilataxi)

1. Login como `juan.pilataxi@…`, Authorize y `x-restaurant-id` del mismo local.
2. **Validar un almuerzo**: `POST /v1/caja/validar` con una `Idempotency-Key` y, para búsqueda manual, `{"clienteId": "<id del cliente>"}` (o `{"codigoQr": "<texto del QR>"}`). La respuesta siempre es 200 con un `resultado`: `OK`, `OK_ADVERTENCIA`, `DUPLICADO` (mismo comensal en menos de 1 minuto), `SIN_SALDO`, `VENCIDO`, etc.
3. **Deshacer** un error en los 10 segundos siguientes: `POST /v1/caja/consumos/{id}/deshacer` con el `consumo.id` de la respuesta. Pasado ese tiempo → 409; se registra como reclamo.
4. **Venta suelta**: `POST /v1/caja/ventas` con `Idempotency-Key` y
   `{"items": [{"tipo": "ALMUERZO", "cantidad": 1}], "metodoPago": "EFECTIVO"}`; `GET /v1/caja/ventas` lista las de hoy.
5. **Pedidos del comensal**: `GET /v1/caja/pedidos`, y con el QR del pedido `POST /v1/caja/pedidos/{id}/canjear` y luego `…/servir`.
6. **Canjear una oferta**: `POST /v1/ofertas/{id}/canjear` con `{"cantidad": 1, "metodoPago": "EFECTIVO"}` y `Idempotency-Key`.
7. Comprueba los límites: `GET /v1/reportes/resumen-diario` o `POST /v1/ofertas` responden **403** (son de dueño), y `POST /v1/caja/cierre/hoy/reabrir` también.

## 6. Flujo del comensal (Kevin Simbaña)

1. Login como `kevin.simbana@…` y Authorize. **No** hace falta `x-restaurant-id`.
2. **Vitrina (sin token)**: `GET /v1/restaurantes` y `GET /v1/restaurantes/la-cuchara-de-san-blas` (menú de hoy, planes, ocupación). Anota los `id` de los platos del menú.
3. **Pase**: `GET /v1/pase` devuelve su QR rotativo (`codigo.codigo`, vale 30 s) y sus planes por local. `GET /v1/pase/codigo` solo renueva el código. `POST /v1/pase/rotar` invalida los anteriores.
4. **Pedir antes de llegar**: `POST /v1/mis/pedidos` con `Idempotency-Key` y
   `{"restaurante": "<id del local>", "almuerzo": {"platos": ["<id sopa>", "<id fuerte>"]}}`. Un pedido activo a la vez (otro → 409 `PEDIDO_ACTIVO`); `POST /v1/mis/pedidos/{id}/cancelar` lo cancela.
5. **Mesa compartida**: `POST /v1/mis/mesas` con `{"restaurante": "<id>", "horaLlegada": "<ISO futura>", "modo": "CADA_UNO"}`; comparte el `id` para que otros usen `POST /v1/mesas/invitacion/{id}/unirse`.
6. **Historial**: `GET /v1/mis/consumos`, `GET /v1/mis/sellos` (tarjeta de sellos) y `GET /v1/mis/opiniones/pendientes` (a los 25 minutos de un almuerzo se puede opinar con `POST /v1/mis/consumos/{id}/opinion`).
7. **Reclamo**: si le descontaron de más, `POST /v1/mis/consumos/{id}/reclamo` con `{"mensaje": "…(10 a 500 caracteres)"}`; el local lo ve en `GET /v1/reclamos`.
8. **Pedir un plan**: `POST /v1/restaurantes/{slug}/solicitudes-plan` con `{"planId": "<id de la vitrina>"}`; el local la cobra en caja.

## 7. Si algo falla

| Respuesta                      | Causa habitual                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| 401 `UNAUTHORIZED`             | No pulsaste Authorize, o el token venció (15 min): usa `refresh`.                              |
| 400 `BAD_REQUEST`              | Falta `x-restaurant-id` o un campo; no se admiten campos de más.                               |
| 400 `IDEMPOTENCY_KEY_INVALIDA` | Falta `Idempotency-Key` o no es un UUID.                                                       |
| 403 `FORBIDDEN`                | Tu rol no alcanza (un cajero llamando a un endpoint de dueño) o no trabajas en ese local.      |
| 429 `TOO_MANY_REQUESTS`        | Límite por IP; el login limita a 5 intentos por cuenta cada 15 minutos. Respeta `Retry-After`. |
