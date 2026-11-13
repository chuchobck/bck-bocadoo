# ADR 0003: access JWT ES256 y refresh opaco rotativo

- Estado: aceptada (fase 4)
- Fecha: 2026-11-13

## Contexto

La API es consumida por una app móvil, un frontend web y un backoffice. Necesita sesiones largas sin dejar tokens robados utilizables para siempre, y poder validar peticiones sin ir a la base en cada una.

## Decisión

- **Access token JWT ES256** de 15 min, con `kid`, `iss`, `aud` y `typ: at+jwt`. La verificación fija `algorithms: ['ES256']` (sin `none` ni HS256) y solo acepta `kid` conocidos.
- **Refresh token opaco** de 30 días (32 bytes aleatorios), guardado como SHA-256, de **un solo uso**: cada refresh entrega uno nuevo de la misma familia. Reutilizar uno viejo revoca toda la familia.
- Contraseñas con **argon2id** (parámetros OWASP).
- Llaves en variables de entorno, rotables por `kid` sin cortar sesiones (`JWT_PREVIOUS_PUBLIC_KEYS`).
- Autorización en tres capas: guard JWT global, guards de rol y tenant, y RLS.

## Alternativas descartadas

- Sesiones solo en servidor: obligan a consultar la base en cada petición.
- HS256: un secreto compartido que, si se filtra, permite emitir tokens.
- Refresh JWT: no se puede revocar ni detectar su reutilización sin estado en servidor.

## Consecuencias

- Un access token robado vale hasta 15 min; los refresh robados se detectan al reutilizarse.
- Hay estado en base (`sesion_refresh`, `evento_seguridad`) solo en login, refresh y logout.
- El rate limit en memoria exige una sola instancia, o un almacén compartido si se escala.
