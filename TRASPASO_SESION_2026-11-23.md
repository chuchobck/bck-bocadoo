# Traspaso de sesión — 23 nov 2026

Contexto: sesión de Claude Code trabajando sobre `ESTADO_BACKEND.md` (versión 23 nov 13:15, la que registraba los PRs
#40–#49 ya mergeados por Oe). Esta sesión avanzó la sección "B. Siguiente en código (recomendado, en este orden)".
**No se mergeó ningún PR** (regla de la sesión: solo abrir y pushear, el equipo decide el merge). Tampoco se tocó
Docker en ningún momento (regla explícita del usuario).

## PRs abiertos esta sesión (sin mergear)

1. **#50** `investiga/qr-cobro-plan-completo` — test de verificación: QR con `cobro` y plan que cubre todo (saldo 0 →
   sin cuenta, deshacer sigue funcionando). **CI: verde (5/5)**. Confirma que el caso ya estaba bien cubierto por el
   fix 7b de Oe (#49); no hizo falta tocar código de producto, solo el test.
2. **#51** `fix/pos-recargo-a-la-carta` — INC-07: el POS no cobraba el recargo para llevar a platos sueltos
   `A_LA_CARTA`, solo a `ALMUERZO`. Reusa `tipoDePlato()` de `src/cobro/adaptador.ts` (misma regla que ya usan
   pedidos y mesas). **CI: 4/5 verde**; el check de integración falló por un test _no relacionado_
   (`auth.int.ts` — timing de login fantasma vs. real, flaky conocido de runners compartidos) y ya se relanzó
   (`gh run rerun 45259710337 --failed`) — falta confirmar que quedó en verde.
3. **#52** `feat/carta-seccion` — agrega `seccion: string | null` al payload de `GET /v1/restaurantes/{slug}/carta`,
   para que el frontend pueda replicar la regla de recargo en su propio carrito (carrito híbrido). Cambio aditivo,
   con label `cambio-incompatible` por convención del repo. **CI: verde (5/5)**.
4. **#53** `feat/pagos-pendientes-unificado` — unifica `GET /v1/pagos/pendientes`: antes solo listaba pagos de plan;
   ahora también lista pagos pendientes de venta POS y de cuenta de cobro (un solo `UNION ALL` con discriminador
   `origen: 'PLAN'|'POS'|'CUENTA'`). El endpoint de resolución (`/v1/pagos/{id}/confirmar|rechazar`) no cambió, ya
   era genérico. **Cambio de contrato** (la forma de cada item del array cambia) → label `cambio-incompatible`.
   **CI: en curso al cerrar la sesión, falta confirmar.** Esta es la que más vale la pena revisar con cuidado: el
   `UNION ALL` se escribió leyendo el esquema con cuidado pero nunca corrió contra Postgres real en esta sesión (no
   se tocó Docker), así que la integración de CI es la primera vez que se prueba de verdad.

### Pendiente inmediato para la próxima sesión

- Confirmar que el re-run de CI en #51 quedó verde.
- Confirmar el resultado de CI en #53 (recién lanzado).
- Si #53 falla en el `UNION ALL`, los sospechosos más probables son: nombres de columna de `cuenta_cobro`
  (`nombre_pagador`, `cuenta_id`/`public_id`) o el cast `v.ticket::text` en el `CASE` del origen POS.

## Lo que queda de la lista de "B. Siguiente en código" del ESTADO_BACKEND de 23 nov

Todo lo de esa sección quedó cubierto por los 4 PRs de arriba. Lo que sigue es la sección "C. Después" (menor
prioridad) y los puntos de "A. Antes del piloto" que son decisiones/accesos de Oe, no código:

- Invitación con aceptación (fix real del hallazgo MEDIO de enumeración de correo de la auditoría OWASP; decisión de
  producto de Oe, necesita pantalla en Flutter también).
- PR 9: cambios incompatibles pendientes (retirar `aplicarSeleccion: false`, ids opacos, deprecar `extras`).
- Decidir si el cierre de caja se vuelve un "snapshot verdadero" (necesitaría nueva migración).
- Actualizar o archivar `docs/spec-carrito-hibrido-PENDIENTE.md` (casi todo entregado ya por 7a/7b; con #52 el
  frontend tiene lo que le faltaba de `seccion`).
- Recrear el contenedor local de pruebas (por la flakiness de `perfil-negocio.int.ts`) — no aplica a Claude en esta
  sesión por la prohibición de Docker; es tarea para quien sí pueda tocarlo.
- Compilar el reporte único de frontend para cerrar Entrega D.
- Resto de la sección 5 del documento (deadlock mesa/QR, `vigente_desde` en UTC, endurecimiento, limpieza de
  columnas legacy).

## Notas de proceso para quien continúe

- **No tocar Docker** bajo ninguna circunstancia en este proyecto (regla permanente del usuario, ver memoria
  `feedback_no_tocar_docker.md`). Para probar cosas que necesitan DB, usar el CI de GitHub Actions como oráculo
  (levanta su propio Postgres 16 de servicio) en vez de levantar algo local.
- Cada PR de esta sesión corrió localmente antes de pushear: `tsc --noEmit`, `eslint`, `prettier --check`, suite
  `vitest run test/unit` (sin DB, 972 tests) y `pnpm openapi:export` para mantener `docs/openapi.json` al día (lo
  exige el check `oasdiff`).
- Un PR = un tema; cada uno de los 4 PRs toca una sola cosa, sin mezclar.
- Nunca se mergeó nada; todos están abiertos esperando revisión del equipo.
