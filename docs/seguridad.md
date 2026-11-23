# Seguridad: modelo de amenazas y flujos de autenticación

Fase 4 (`v0.4.0`). Complementa el [ADR 0001](adr/0001-acceso-a-datos-y-tenancy.md).

## Capas de defensa

| Capa             | Qué hace                                                                                                           | Dónde                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1. Autenticación | Guard JWT global: todo endpoint exige token salvo que lleve `@Public()`                                            | `src/authz/jwt-auth.guard.ts`         |
| 2. Autorización  | `TenantGuard` resuelve el restaurante desde la pertenencia (`personal_restaurante`), `RolesGuard` comprueba el rol | `src/authz/`                          |
| 3. Base de datos | RLS por tenant y por usuario; `bck_api` sin BYPASSRLS                                                              | migración baseline, `DbService`       |
| Abuso            | Rate limit, límite de body, validación estricta, CORS con lista blanca, helmet                                     | `src/security/`, `src/app.factory.ts` |
| Rastro           | `evento_seguridad` (solo inserción) y `log_actividad` con el usuario real                                          | tablas + triggers                     |

## Flujos

### Registro

`POST /v1/auth/register` (comensal) y `POST /v1/auth/register-owner` (dueño + restaurante en `BORRADOR`). Contraseña de 10 a 128 caracteres, hash **argon2id** (19 MiB, 2 pasadas). Un dato duplicado responde un 409 genérico. Límite: 10 registros por IP y hora. `register-owner` se puede cerrar con `REGISTER_OWNER_ENABLED=false` (ver «Endurecimiento para el piloto»).

### Login

`POST /v1/auth/login` con correo o nombre de usuario. Devuelve:

- **access token**: JWT **ES256** de 15 min, con `kid`, `iss`, `aud`, `typ: at+jwt`, `sub` = `public_id` (UUID) y `uid` = id interno. `uid` solo viaja dentro del token (que ve únicamente su dueño); nunca aparece en respuestas.
- **refresh token**: 32 bytes aleatorios (base64url), **opaco**. En base solo se guarda su SHA-256.

Contraseña incorrecta y usuario inexistente dan la **misma respuesta** (401 `Credenciales inválidas.`) y gastan el mismo tiempo (argon2 contra un hash señuelo).

### Refresh con rotación

`POST /v1/auth/refresh`: cada refresh token sirve **una vez**; la respuesta trae uno nuevo de la misma _familia_. La rotación es un único `UPDATE ... WHERE usado_en IS NULL`, así que de dos peticiones simultáneas con el mismo token solo una gana.

Si llega un token **ya usado**, se asume robo: se revoca **toda la familia** (también el token legítimo más reciente), se registra `REFRESH_REUSO` y el usuario debe iniciar sesión de nuevo.

### Logout

- `POST /v1/auth/logout` (con el refresh token): cierra la familia de ese dispositivo. Idempotente.
- `POST /v1/auth/logout-all` (con access token): revoca todas las sesiones del usuario.

El access token ya emitido sigue valiendo hasta que expire (máximo 15 min); es el precio de no consultar la base en cada request.

### Acceso a un restaurante

Los endpoints del personal llevan `@Roles('DUENO', 'CAJERO')` y exigen el encabezado `x-restaurant-id` (UUID). `TenantGuard` comprueba, **como `bck_api` y con RLS**, que el usuario tenga una fila activa en ese restaurante; si no → 403 y evento `ACCESO_DENEGADO`. El tenant del request sale de esa fila, nunca de un id mandado a ciegas. `RolesGuard` comprueba el rol → 403 si no alcanza.

## Amenazas consideradas

| Amenaza                                                                                                | Mitigación                                                                                                              | Prueba                                 |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Fuerza bruta de contraseñas                                                                            | 5 intentos por IP+cuenta cada 15 min, 20 por cuenta (anti rotación de IP), 429 con `Retry-After`                        | `abuse.int.ts`                         |
| Enumeración de cuentas                                                                                 | Misma respuesta y tiempo similar; registro duplicado genérico                                                           | `auth.int.ts`                          |
| Robo de refresh token                                                                                  | Rotación, hash en base, detección de reutilización, logout-all                                                          | `auth.int.ts`                          |
| JWT `alg: none`, firma alterada, HS256 con la pública, `kid` falso, audiencia o emisor ajenos, vencido | `jose` con `algorithms: ['ES256']`, `kid` en lista cerrada, `iss`/`aud`/`typ` obligatorios                              | `auth.int.ts`, `token.service.spec.ts` |
| Escalada de privilegios (cajero → dueño)                                                               | `RolesGuard` + evento                                                                                                   | `authz.int.ts`                         |
| Acceso entre restaurantes cambiando ids                                                                | `TenantGuard` por pertenencia + RLS como segunda barrera                                                                | `authz.int.ts`, `rls.int.ts`           |
| Inyección SQL                                                                                          | Solo consultas parametrizadas; ids de contexto validados por regex                                                      | `rls.int.ts`                           |
| Campos extra / mass assignment                                                                         | `ValidationPipe` con `whitelist` + `forbidNonWhitelisted`                                                               | `abuse.int.ts`                         |
| Cuerpos enormes                                                                                        | Límite de 100 kB → 413                                                                                                  | `abuse.int.ts`                         |
| Otros orígenes en el navegador                                                                         | CORS con lista blanca (`CORS_ORIGINS`)                                                                                  | `abuse.int.ts`                         |
| IP falsificada con `x-forwarded-for` para esquivar rate limits                                         | `trustProxy` por número de saltos (`TRUST_PROXY_HOPS`), no `true`                                                       | `trust-proxy.spec.ts`                  |
| Filtración de secretos en logs                                                                         | pino redacta `authorization`, `password`, `refreshToken`, `accessToken`; la línea de log lleva la ruta sin query string | `log-privacy.spec.ts`                  |

## QR del comensal (fase 7)

- Cada usuario tiene un **secreto** de 32 bytes, guardado cifrado con AES-256-GCM (llave `QR_SECRET_KEY`, fuera del repo) y atado a su id: copiar el valor cifrado a otro usuario no funciona. La tabla solo la lee el rol de servicio.
- El código es `HMAC-SHA256(secreto, usuario | restaurante | paso de 30 s)` truncado a 132 bits. La caja acepta el paso actual ±1.
- Una captura de pantalla sirve como máximo 90 segundos, y la regla de doble escaneo (60 s) impide usarla dos veces seguidas. `POST /v1/pase/rotar` invalida todo lo anterior.
- Cada intento, válido o no, queda en `intento_escaneo` con el personal que escaneó.

| Amenaza                          | Mitigación                                                                 | Prueba                                 |
| -------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| QR falsificado o alterado        | HMAC con secreto por usuario; comparación en tiempo constante              | `pass-code.spec.ts`, `checkout.int.ts` |
| Captura de pantalla reenviada    | Vence en 30 s (±1 paso); doble escaneo → `DUPLICADO`; rotación del secreto | `checkout.int.ts`                      |
| Volcado de la tabla de secretos  | Cifrado AES-256-GCM con llave fuera de la base                             | `checkout.int.ts`                      |
| Doble cobro por reintento de red | `Idempotency-Key` obligatoria en caja y pagos                              | `checkout.int.ts`, `plans.int.ts`      |
| Dos cajas a la vez               | Bloqueo de fila del cliente en la función atómica                          | `checkout.int.ts`                      |
| Cajero que altera precios        | Los precios de almuerzo y platos los pone el servidor                      | `checkout.int.ts`                      |

### Menú publicado como condición del pase y del canje

El frontend bloquea el pase y el escaneo sin menú publicado, pero la regla la impone el servidor (`assertMenuPublicado`, en `src/diner/common.ts`, la misma que usa `POST /v1/mis/pedidos`): 409 `MENU_NO_PUBLICADO`. El "hoy" es la fecha local del restaurante (`zona_horaria`), no la del servidor.

- `GET /v1/pase/codigo` y `GET /v1/pase` con `restaurante`: no emiten código si el local no publicó. Sin `restaurante` el código no pertenece a un local, así que no hay menú que comprobar; la regla se aplica al canjear (`validar`).
- `POST /v1/caja/validar` (QR y manual): el chequeo va primero, dentro del servicio y bajo el tenant de la petición (RLS), así que no descuenta ni registra `intento_escaneo`. El menú de otro local no cuenta.
- **Decisión de negocio:** un pedido preordenado mientras el menú estaba publicado **sí** se canjea (`POST /v1/caja/pedidos/{id}/canjear`) aunque luego se despublique; solo se bloquean pases nuevos y canjes directos sin preorden.
- Pruebas: `test/integration/menu-publicado.int.ts`.

## IP del cliente y proxies (`TRUST_PROXY_HOPS`)

Los rate limits por IP (login incluido) dependen de `request.ip`, que Fastify saca de `x-forwarded-for`. Con `trustProxy: true` se confía en toda la cabecera, y el cliente puede mandar la suya ("1.2.3.4") para parecer otra IP en cada petición y esquivar los límites.

Ahora `trustProxy` es un **número de saltos** (`TRUST_PROXY_HOPS`, entero 0-5): solo se confía en los últimos N saltos, contando desde el socket, y `request.ip` es la primera dirección que queda fuera de ellos. Lo que el cliente anteponga a la cadena queda más allá de esa dirección y se ignora.

| Entorno             | Valor por defecto | Motivo                                                                                           |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| Producción (Render) | 3                 | Cadena real: cliente → Cloudflare → proxy interno de Render; la app ve `remoteAddress` 127.0.0.1 |
| Desarrollo y test   | 0                 | Sin proxy: `x-forwarded-for` se ignora y `request.ip` es la IP del socket                        |

Ejemplo con 3 saltos: `x-forwarded-for: cliente, cf, interno` → `request.ip = cliente`. Si el atacante manda `1.2.3.4, cliente, cf, interno`, sigue siendo `cliente`.

- Si cambia la infraestructura (se quita Cloudflare, otro proveedor), **revisa el valor**: demasiado alto permite falsificar la IP; demasiado bajo hace que todos los clientes compartan la IP de un proxy y se bloqueen entre sí.
- Verificación en producción: haz una petición con `x-forwarded-for: 1.2.3.4` y comprueba en `evento_seguridad`/logs que la IP registrada no es `1.2.3.4`.
- Pruebas: `test/trust-proxy.spec.ts`.

## Llaves JWT

Las llaves **nunca van al repo**: viven en `.env` (local) o en las variables de Render.

```
pnpm keys:generate           # imprime JWT_KEY_ID y JWT_PRIVATE_KEY (PEM con \n escapados)
```

En producción `JWT_PRIVATE_KEY` es obligatoria (la app no arranca sin ella). En desarrollo, si falta, se genera una llave efímera y los tokens mueren al reiniciar.

### Rotación sin cortar sesiones

1. Genera una llave nueva con otro `kid` (`pnpm keys:generate k20270101`).
2. Saca la **pública** de la llave vieja y ponla en `JWT_PREVIOUS_PUBLIC_KEYS='{"k20261112":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}'`.
3. Pon la nueva en `JWT_PRIVATE_KEY` y su `kid` en `JWT_KEY_ID`; despliega.
4. Pasados 15 minutos (vida del access token) quita `JWT_PREVIOUS_PUBLIC_KEYS`.

Los refresh tokens no dependen de las llaves JWT, así que la rotación no cierra sesiones.

## Hallazgo abierto: invitar cajero / vincular cliente filtran si un correo existe (auditoría OWASP, 22 nov 2026)

**MEDIO, sin arreglar a propósito: necesita una decisión de producto, no solo de seguridad.**

- **Dónde:** `POST /v1/restaurante/personal/cajeros` (`src/staff/staff.service.ts`, `inviteCashier`) y `POST /v1/clientes/{id}/vincular` (`src/customers/customers.ts`, `link`). Las dos usan `UsersLookupService` (BYPASSRLS) para buscar la cuenta por correo.
- **El problema real no es solo el oráculo:** cualquiera puede registrarse como dueño gratis (`POST /v1/auth/register-owner`, 10 por hora por IP) y usar su restaurante falso para sondear correos ajenos. `inviteCashier` responde 201 con el **nombre real** de la cuenta si existe, 404 si no. Peor: si existe, **la asocia de inmediato** como cajero de ese restaurante falso (o como cliente vinculado, en el caso de `link`), sin que la persona dueña de la cuenta lo sepa ni lo acepte. Esa persona la ve aparecer en su propio `GET /v1/auth/me`.
- **Por qué no lo arreglé ya:** la causa de fondo es que hoy no existe un paso de aceptación — es, por diseño actual, "agregar y ya queda" (documentado como aceptado en `ESTADO_BACKEND.md`: "invitación sin correo, para después"). Las dos correcciones posibles cambian ese comportamiento:
  1. **Invitación pendiente con aceptación:** el cajero/cliente queda en un estado "pendiente" hasta que la persona invitada lo acepta desde su propia sesión. Cierra el problema de raíz (ya no hay asociación sin consentimiento, y se puede hacer la respuesta genérica sin romper la UX legítima). Necesita una tabla y migración nuevas, 2-3 endpoints nuevos (listar, aceptar, rechazar invitaciones propias) y que el frontend (Flutter) construya la pantalla correspondiente.
  2. **Mitigación parcial sin cambiar el flujo:** limitar también por cuenta de dueño (no solo por IP) y endurecer el límite de `invite`; no cierra el oráculo ni la asociación sin consentimiento, solo lo encarece.
- **Queda para que lo decida Oe** (dueño del proyecto): si el piloto puede convivir con esto un tiempo más, o si vale la pena construir la opción 1 antes del piloto con locales reales.

## Hallazgo cerrado: el cajero autoconfirmaba transferencias y pagos Deuna (auditoría de seguridad, 22 nov 2026)

**MEDIO, cerrado** (rama `fix/cajero-confirma-pagos`, migración `20261122210000_pago_confirmado_por`).

- **Qué pasaba:** un CAJERO podía mandar `pagoConfirmado: true` con `TRANSFERENCIA` o `DEUNA` y dejar `CONFIRMADO` un depósito inventado, sin referencia y sin rastro de quién lo confirmó. En el canje de ofertas (`POST /v1/ofertas/{id}/canjear`) era peor: el cobro nacía siempre `CONFIRMADO` con cualquier método y ni siquiera aceptaba referencia. El dinero entraba al cierre como cobrado.
- **Decisión de producto (del dueño):** el cajero conserva `pagoConfirmado` (en caja hace falta), pero (1) con `referenciaExterna` obligatoria al confirmar TRANSFERENCIA o DEUNA, (2) queda guardado quién confirmó (usuario y rol) y (3) el cierre separa lo confirmado por cajero de lo confirmado por el dueño. Efectivo no cambia.
- **Arreglo:**
  - Regla en la API (`src/common/pago-confirmado.ts`, `exigirReferenciaAlConfirmar`) en todos los puntos donde un pago nace confirmado: venta y cobro de planes, POS, pago de cuentas (cobrar, validar con `cobro`, canje de pedido con `cobro`) y canje de oferta. Sin referencia → 422 `REFERENCIA_PAGO_REQUERIDA` y la transacción se deshace entera. El rol sale de `TenantGuard` (fila de `personal_restaurante`), no del cuerpo.
  - La referencia no se puede repetir en el local (`uq_pago_referencia_externa`, por restaurante y método): un mismo depósito no paga dos veces → 409 `REFERENCIA_PAGO_REPETIDA`, ahora igual en todos los cobros.
  - `transaccion_pago.confirmado_por_usuario_id`, `confirmado_por_rol` y `confirmado_en`, llenadas en SQL desde la sesión (`app_user_id()` y el rol de `personal_restaurante`). La base impide reescribirlas: `fn_pago_solo_cambia_estado` solo deja tocarlas en el UPDATE que confirma un `PENDIENTE`, y `ck_pago_confirmado_por` exige las tres juntas y solo en un pago `CONFIRMADO`. Un pago ya confirmado no cambia.
  - Confirmar después (`POST /v1/pagos/{id}/confirmar`) sigue siendo solo del dueño.
  - Cierre de caja: `porMetodo[].confirmadoPorCajeroCentavos` / `confirmadoPorDuenoCentavos` / `confirmadoSinRegistroCentavos`, para que el dueño revise contra el banco lo que confirmó el cajero.
- **Riesgo que queda:** un cajero todavía puede inventar una referencia con formato válido; el sistema no la verifica contra el banco. Lo que cambia es que queda a su nombre, no se puede repetir y el dueño la ve separada en el cierre.
- **Pruebas:** `test/integration/pago-confirmado-por.int.ts` (roles, referencia, 409, cierre, aislamiento entre locales y barreras de la base como `bck_api`).

## Rate limiting: memoria acotada (auditoría OWASP, 22 nov 2026)

Hallazgo ALTO cerrado: el guard evaluaba todos los checks del preset (p. ej. `a:ip:identificador`, `c:identificador` del login) aunque el tope general por IP ya hubiera rechazado la petición, creando una clave nueva por cada intento con un identificador inventado. Con suficientes intentos desde una sola IP, el mapa crecía sin límite real hasta agotar la memoria del proceso (`sweep()` recorría todo el mapa sin liberar nada mientras la ventana de 15 min seguía activa). Arreglo en `src/security/rate-limit.ts`:

- El tope general por IP se evalúa primero y solo: si ya está excedido, no se miran ni se crean las claves del preset.
- Tope duro de memoria (`MAX_ENTRIES = 100 000`): el mapa de contadores nunca crece más allá de eso. Al llegar al tope, cada clave nueva expulsa primero la más vieja (orden de inserción, O(1)), en vez del barrido completo anterior.
- Cubre tanto el ataque de una sola IP (el guard corta temprano) como una botnet con miles de IPs/identificadores distintos (el tope duro acota la memoria de todas formas).
- Pruebas: `test/unit/rate-limit.spec.ts` (reproduce el ataque: 200 intentos con identificadores distintos tras agotar el tope de la IP no crean ninguna clave nueva; confirma el tope de 100 000 y el orden de expulsión).

## Endurecimiento para el piloto (22 nov 2026)

Mitigación parcial del hallazgo abierto de arriba (opción 2): encarece el sondeo de correos, pero **no cierra el oráculo ni la asociación sin consentimiento**; eso sigue necesitando la invitación con aceptación.

- **Registro de dueños cerrable:** `REGISTER_OWNER_ENABLED` (por defecto `true`). Con `false`, `POST /v1/auth/register-owner` responde 403 `REGISTRO_CERRADO` antes de validar el body y sin crear nada. `POST /v1/auth/register` (comensal) no cambia. Para el piloto, ponerla en `false` en Render y dar de alta a los dueños por otra vía.
- **Tope por cuenta:** `POST /v1/restaurante/personal/cajeros` y `POST /v1/clientes/{id}/vincular` admiten como máximo `USER_INVITE_RATE_LIMIT_MAX` (10) por usuario autenticado y hora, además del tope por IP (20). 429 con `Retry-After`. Lo aplica `UserRateLimitGuard` (guard de método, porque `RateLimitGuard` global corre antes que el JWT y no conoce al usuario). Comparte el mapa y el tope `MAX_ENTRIES` del guard global, y solo crea la clave para un usuario ya autenticado (sin token → 401, sin clave), así que no reabre el hallazgo de memoria. Pruebas: `rate-limit.spec.ts`, `endurecimiento.int.ts`.
- **Logs sin datos personales:** la línea `request completed` registra la ruta **sin query string** (`/v1/clientes?q=0991234567` → `/v1/clientes`) más `requestId`, `method`, `statusCode` y `ms`. Prueba: `test/unit/log-privacy.spec.ts`.

## Límites conocidos (a revisar)

- El rate limit es **en memoria**: vale para una sola instancia. Si la API escala a varias, hay que moverlo a un almacén compartido. El tope duro de memoria lo hace seguro mientras tanto, pero sigue sin compartirse entre instancias.
- Sin verificación de correo ni recuperación de contraseña (fuera del alcance de v1). Login con Google, después de v1.
- Los access tokens no se pueden revocar antes de su vencimiento (15 min).
