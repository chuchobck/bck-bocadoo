# Jobs de mantenimiento (cron)

Dos tareas periódicas que no dependen de ninguna petición. Corren como **Cron Job de Render** con la misma imagen Docker de la API (no hace falta pg_cron ni otro servicio) y también a mano desde la línea de comandos.

| Job                 | Qué hace                                                                                                                                                | Cuándo                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `expire-plans`      | Pasa a `VENCIDA` los planes `ACTIVA` cuyo último día (`vence_el`) ya pasó, con el **día local de cada restaurante** (`fn_vencer_suscripciones`)         | Una vez al día (o cada hora, ver abajo)    |
| `create-partitions` | Crea las particiones mensuales de `log_actividad` y `evento_analitica`: el mes actual y `--months-ahead` más (3 por defecto). Los meses se miden en UTC | Una vez al día es suficiente (idempotente) |
| `all`               | Los dos, en ese orden y cada uno en su propia transacción                                                                                               |                                            |

> Sin `create-partitions` los eventos y la auditoría de un mes sin partición caen en la partición `DEFAULT`. Funciona, pero después ese mes **ya no se puede crear** mientras la partición `DEFAULT` tenga filas suyas (ver "Si una partición falla"). Por eso conviene que corra con margen: con el valor por defecto, un mes antes.

## Correrlos

    # Compilado (lo que corre Render y la imagen Docker)
    node dist/jobs/cli.js <expire-plans|create-partitions|all> [--months-ahead=N]

    # Desde el repo (compila y corre; usa las URLs de .env, ¡cuidado con a qué base apuntan!)
    pnpm jobs all
    pnpm jobs create-partitions --months-ahead=6

- Usan **`DATABASE_SERVICE_URL`** (rol `bck_servicio`, conexión directa, sin pooler). El resto de variables obligatorias de la API (`DATABASE_URL`) también deben estar definidas, porque la configuración se valida completa.
- `--months-ahead` va de 0 a 12 (por defecto 3).
- **Salida:** una línea JSON por job (la lee el log de Render), con `duracionMs`:

      {"job":"expire-plans","ok":true,"vencidos":3,"duracionMs":41}
      {"job":"create-partitions","ok":true,"creadas":["evento_analitica_2027_02","log_actividad_2027_02"],"existentes":["…"],"errores":[],"duracionMs":57}

- **Código de salida:** `0` todo bien · `1` algún job falló (Render lo marca como corrida fallida) · `2` uso incorrecto (imprime la ayuda).

## Idempotencia y doble disparo

Correrlos dos veces seguidas no duplica ni cambia nada: `expire-plans` solo toca planes `ACTIVA` (la segunda corrida devuelve `vencidos: 0`) y `create-partitions` salta lo que existe (`creadas: []`). Si Render dispara el cron dos veces a la vez, cada job toma un candado de Postgres (`pg_try_advisory_xact_lock`): la segunda copia **no espera**, responde `"omitido":"EN_EJECUCION"` y termina con código 0. El candado es de transacción, así que se suelta solo si el proceso muere.

## Configuración en Render

Cron Job con la misma imagen (Docker) de la API:

| Campo        | Valor                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Comando      | `node dist/jobs/cli.js all`                                                                       |
| Programación | `30 5 * * *` (05:30 UTC = 00:30 en Quito, justo pasada la medianoche local)                       |
| Variables    | Las mismas de la API: `DATABASE_URL`, `DATABASE_SERVICE_URL` (conexión directa de `bck_servicio`) |

Un plan que vence "hoy" deja de valer en la caja a la medianoche local aunque el job no haya corrido (la validación compara `vence_el` con el día local), y el reporte de almuerzos pendientes tampoco lo cuenta. El job solo ordena el estado guardado. Si hay locales en zonas horarias muy distintas a la de Quito, programa `expire-plans` cada hora (`0 * * * *`): es barato e idempotente.

## Si una partición falla

`create-partitions` no se detiene en el primer error: informa cada partición que no pudo crear en `errores`, sigue con las demás y sale con código `1`. La causa habitual es que la partición `DEFAULT` ya tiene filas de ese mes (el job no corrió a tiempo): Postgres no deja crear la partición de un mes con filas ya guardadas en `DEFAULT`. Se arregla a mano, con una conexión de dueño: mover esas filas a una tabla temporal, crear la partición (`SELECT fn_crear_particion_mensual('evento_analitica', '2027-02-01')`) y reinsertarlas.

## Detalles de implementación

- Código: `src/jobs/jobs.ts` (los jobs, sobre `DbService.service()`: el uso permitido del rol de servicio para cron) y `src/jobs/cli.ts` (la entrada por línea de comandos).
- La migración `20261118000200_particiones_security_definer` hace `SECURITY DEFINER` a `fn_crear_particion_mensual`: `bck_servicio` no es dueño de las tablas particionadas y sin eso no podía crear particiones. La función conserva su lista cerrada de tablas y solo la ejecuta el rol de servicio.
- Pruebas: `test/integration/jobs.int.ts` (zonas horarias, estados, particiones y el caso de `DEFAULT` con filas) y `test/integration/jobs-concurrency.int.ts` (doble disparo, candado y CLI sobre un clon descartable de la base).
- Pendiente de decisión de negocio (no es un job todavía): renovar el ciclo de la suscripción SaaS (`inicio_ciclo_actual`, `fin_ciclo_actual`, `escaneos_usados_ciclo_actual`). Hasta entonces `GET /v1/suscripcion` marca `ciclo.vencido: true` cuando el ciclo terminó y no se renovó.
