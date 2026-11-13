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

`POST /v1/auth/register` (comensal) y `POST /v1/auth/register-owner` (dueño + restaurante en `BORRADOR`). Contraseña de 10 a 128 caracteres, hash **argon2id** (19 MiB, 2 pasadas). Un dato duplicado responde un 409 genérico. Límite: 10 registros por IP y hora.

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

| Amenaza                                                                                                | Mitigación                                                                                       | Prueba                                 |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Fuerza bruta de contraseñas                                                                            | 5 intentos por IP+cuenta cada 15 min, 20 por cuenta (anti rotación de IP), 429 con `Retry-After` | `abuse.int.ts`                         |
| Enumeración de cuentas                                                                                 | Misma respuesta y tiempo similar; registro duplicado genérico                                    | `auth.int.ts`                          |
| Robo de refresh token                                                                                  | Rotación, hash en base, detección de reutilización, logout-all                                   | `auth.int.ts`                          |
| JWT `alg: none`, firma alterada, HS256 con la pública, `kid` falso, audiencia o emisor ajenos, vencido | `jose` con `algorithms: ['ES256']`, `kid` en lista cerrada, `iss`/`aud`/`typ` obligatorios       | `auth.int.ts`, `token.service.spec.ts` |
| Escalada de privilegios (cajero → dueño)                                                               | `RolesGuard` + evento                                                                            | `authz.int.ts`                         |
| Acceso entre restaurantes cambiando ids                                                                | `TenantGuard` por pertenencia + RLS como segunda barrera                                         | `authz.int.ts`, `rls.int.ts`           |
| Inyección SQL                                                                                          | Solo consultas parametrizadas; ids de contexto validados por regex                               | `rls.int.ts`                           |
| Campos extra / mass assignment                                                                         | `ValidationPipe` con `whitelist` + `forbidNonWhitelisted`                                        | `abuse.int.ts`                         |
| Cuerpos enormes                                                                                        | Límite de 100 kB → 413                                                                           | `abuse.int.ts`                         |
| Otros orígenes en el navegador                                                                         | CORS con lista blanca (`CORS_ORIGINS`)                                                           | `abuse.int.ts`                         |
| Filtración de secretos en logs                                                                         | pino redacta `authorization`, `password`, `refreshToken`, `accessToken`                          | prueba manual                          |

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

## Límites conocidos (a revisar)

- El rate limit es **en memoria**: vale para una sola instancia. Si la API escala a varias, hay que moverlo a un almacén compartido.
- Sin verificación de correo ni recuperación de contraseña (fuera del alcance de v1). Login con Google, después de v1.
- Los access tokens no se pueden revocar antes de su vencimiento (15 min).
- `Idempotency-Key` y los secretos del QR llegan con la fase 7.
