# Flujo del QR: del pase del comensal al canje en caja

Cómo viaja un almuerzo desde el teléfono del comensal hasta el descuento en el plan, y cómo se entera la app. El contrato
de cada endpoint está en [`api-contrato.md`](./api-contrato.md); aquí va el porqué.

## 1. El código

- `GET /v1/pase` o `GET /v1/pase/codigo?restaurante=` devuelven `BCD1.<usuario>.<restaurante|0>.<mac>` (`src/checkout/pass-code.ts`).
- `mac` = HMAC-SHA256 del secreto QR del usuario sobre `v1|usuario|restaurante|paso`, recortado a 22 caracteres base64url. El paso dura **30 s**; al verificar se acepta el anterior y el siguiente (relojes desfasados). Un código auténtico de hasta 40 pasos atrás da `QR_EXPIRADO`; lo demás, `QR_INVALIDO`.
- Con `restaurante` el código solo vale en ese local (`OTRO_LOCAL` en otro) y exige el menú de hoy publicado.
- `POST /v1/pase/rotar` cambia el secreto: invalida todos los códigos anteriores (teléfono perdido, captura compartida).

## 2. El canje

`POST /v1/caja/validar` (QR o búsqueda manual) responde **siempre 200** con un `resultado`. El descuento lo hace `fn_descontar_almuerzo` en una sola transacción: bloquea al cliente, mira idempotencia, duplicado, límite SaaS y descuenta del plan que vence primero (FIFO).

### Segundo escaneo del mismo código

El QR **no es de un solo uso**: se dibuja durante su paso y vale hasta el final del siguiente, o sea, menos de 60 s entre el primer y el último escaneo posible. Lo que la base detecta es **al comensal**: si ya tiene un canje sin deshacer en ese local de hace menos de 60 s, el resultado es `DUPLICADO` (200, `descontado: false`, `almuerzosRestantes` = saldo). Como la ventana cubre la vida entera del código, un segundo escaneo del mismo QR siempre da `DUPLICADO`. El reintento con la misma `Idempotency-Key` devuelve la respuesta original sin descontar. La respuesta trae además `consumoPrevio: { creadoEn }` (hora ISO de ese canje previo, solo con `DUPLICADO`) para mostrar "ya canjeado hace X s". La hora se lee en la capa de servicio (`CheckoutService.validate`) con una consulta del último consumo del comensal en ese local en los últimos 60 s (mismo criterio que la función), en la misma transacción: `fn_descontar_almuerzo` no cambió y no hay migración.

### Deshacer

`POST /v1/caja/consumos/{id}/deshacer` en los 10 s siguientes: consumo inverso (los consumos son de solo inserción) y el almuerzo vuelve al plan.

## 3. Aviso en tiempo real a la app del comensal

Antes, la caja descontaba al instante pero la app seguía mostrando el saldo viejo y el mismo QR hasta refrescar. Ahora la app abre **`GET /v1/pase/eventos`** (Server-Sent Events) y recibe:

| Evento             | Cuándo                                                                                                | `data`                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `CANJE_REGISTRADO` | Se descontó un almuerzo: `validar` (QR o manual), validar una mesa (a quien pagó) o canjear un pedido | `tipo`, `consumoId`, `restauranteNombre`, `saldoRestante`, `platoNombre` (o `null`), `hora` |
| `CANJE_REVERTIDO`  | La caja deshizo el canje                                                                              | `tipo`, `consumoId`, `restauranteNombre`, `saldoRestante`, `hora`                           |
| `LATIDO`           | Cada 20 s                                                                                             | `hora`                                                                                      |
| `FIN`              | Justo antes de que el servidor cierre                                                                 | `motivo`: `REEMPLAZADA`, `TOKEN_VENCIDO` o `APAGADO`                                        |

`saldoRestante` es el total de almuerzos de sus planes vigentes **en ese local**, el mismo número que `almuerzosRestantes` de la caja.

### Garantías

- **Solo después del COMMIT.** La caja junta los eventos en un colector (`PassEventBus.pending()`) mientras corre la transacción y llama `flush()` después de `await db.forRequest(...)`. Si la transacción falla, incluso en el COMMIT, `flush()` no se alcanza y no sale nada: nunca se avisa de un canje que se revirtió.
- **Sin repetidos por reintento.** Solo avisa el consumo creado en esa transacción; un reintento con la misma `Idempotency-Key` o un `DUPLICADO` no emiten. Deshacer dos veces emite una sola vez.
- **Solo lo propio.** La conexión se suscribe con el `usuario_id` del JWT; no hay parámetro para pedir eventos de otro. Un cliente del local sin cuenta en la app no genera eventos.
- **Sin historial.** Es un aviso, no una cola: lo que pase con la app desconectada no se reenvía. Al conectar o reconectar, la app vuelve a pedir `GET /v1/pase`.

### Conexión

- `Authorization: Bearer <accessToken>` (el `EventSource` del navegador no manda cabeceras: usar un cliente SSE que sí, como `react-native-sse` o `fetch` con stream). El token **no** va en la URL (quedaría en logs).
- Respuesta `text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Accel-Buffering: no` (que ningún proxy acumule). Lo primero que llega es `retry: 5000` y un comentario `: conectado`.
- **Máximo 2 conexiones por usuario**: la 3.ª cierra la más vieja con `FIN` `REEMPLAZADA` (y `retry: 60000`). Ante `REEMPLAZADA` la app **no** reconecta sola hasta volver a primer plano; si no, dos teléfonos se echarían en bucle.
- **Tope global** por instancia: `PASS_EVENTS_MAX_CONNECTIONS` (1000 por defecto). Lleno → 503 `EVENTOS_SATURADO`; reintentar con espera.
- Al vencer el access token: `FIN` `TOKEN_VENCIDO`; la app hace `POST /v1/auth/refresh` y reconecta.
- Al apagar la API (SIGTERM, `enableShutdownHooks`): `FIN` `APAGADO` a todas y no se aceptan nuevas; la app reconecta tras `retry`.
- Cliente que no lee (más de 64 KB sin enviar): se corta.
- **Rate limit:** cada (re)conexión es una petición y cuenta en el tope general por IP (120/min). Con `retry: 5000` una conexión reconecta como mucho 12 veces por minuto. Ante 429, esperar `retry-after`.

## 4. Límite: una sola instancia

El bus (`src/pass-events/bus.ts`) vive en la memoria del proceso: un canje validado en la instancia A solo llega a conexiones abiertas en A. **Hoy la API corre en una sola instancia**, igual que los rate limits en memoria. Para escalar a varias hay que repartir los eventos entre instancias; el resto (colector post-COMMIT, hub de conexiones, contrato SSE) no cambia: solo `PassEventBus.publish` pasa a publicar afuera y cada instancia entrega a sus conexiones locales.

| Opción                    | Cómo                                                                                                                                                                                                     | Ojo con                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Postgres `LISTEN/NOTIFY`  | `pg_notify('pase_eventos', json)` **dentro** de la transacción del canje (Postgres solo entrega los NOTIFY tras el COMMIT, gratis). Cada instancia mantiene una conexión que hace `LISTEN pase_eventos`. | `LISTEN` necesita una sesión fija: **no funciona por el pooler de Neon** (modo transacción). Requiere una conexión **directa** dedicada por instancia, con reconexión. Payload máximo 8000 bytes (sobra). Sin persistencia: igual que hoy. |
| Redis Pub/Sub (o Streams) | Publicar tras el COMMIT (como hoy `flush()`) en un canal por usuario o uno global; cada instancia se suscribe.                                                                                           | Un servicio más que operar. Pub/Sub no guarda historial; Redis Streams sí permitiría reenviar con `Last-Event-ID`.                                                                                                                         |

Con varias instancias los topes de conexiones pasan a ser por instancia; el de "2 por usuario" necesitaría también un registro compartido si se quiere global.
