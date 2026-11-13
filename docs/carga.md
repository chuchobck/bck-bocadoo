# Prueba de carga de la caja

Objetivo del plan: **validar un almuerzo con p95 < 300 ms a 50 validaciones por segundo**.

## Resultado (2026-11-13, Postgres 16 local en Docker, API en modo producción, una instancia)

| Escenario                 | Peticiones | p95       | Mediana | Errores | Almuerzos descontados |
| ------------------------- | ---------- | --------- | ------- | ------- | --------------------- |
| 50/s durante 60 s         | 3002       | **23 ms** | 15 ms   | 0       | 3001                  |
| 100/s durante 10 s (pico) | 1002       | **42 ms** | 16 ms   | 0       | 1001                  |

Después de la carga los libros cuadran: consumos netos = almuerzos descontados de los planes = intentos OK registrados; ningún saldo negativo ni clave de idempotencia repetida.

Cada petición usa un cliente distinto y una `Idempotency-Key` nueva, así que **descuenta de verdad** (pasa por la función atómica, FIFO, auditoría y registro de intento).

## Cómo repetirla

Solo contra una base de **pruebas** (crea miles de filas).

```bash
LOAD_PASSWORD='una-clave-de-10+' node scripts/load-seed.mjs 4000        # restaurante con 4000 clientes con plan
# API con el límite de peticiones alto (toda la carga sale de una sola IP):
RATE_LIMIT_MAX=100000000 AUTH_RATE_LIMIT_MAX=1000 PORT=3055 node dist/main.js
BASE_URL=http://127.0.0.1:3055 LOAD_PASSWORD='...' k6 run test/load/validar.k6.js
```

Variables: `RATE` (por segundo, 50), `DURATION` (60s), `OFFSET` (primer cliente; cámbialo al repetir antes de 60 s para no caer en la regla de doble escaneo).

## Lo aprendido

- **No correr k6 dentro de Docker Desktop contra un Postgres también en Docker.** El proxy de red de Docker Desktop se satura: la API atiende de a una petición, aparecen `timeout exceeded when trying to connect` y el p95 sube a 9 s. Con k6 nativo, mismo código y misma base: p95 de 23 ms. Era el entorno, no la API.
- El login tiene límite de 5 por cuenta cada 15 minutos: al repetir la prueba varias veces hay que subir `AUTH_RATE_LIMIT_MAX` en el servidor de pruebas.

## Pendiente

- **Medir contra Neon** (latencia a us-east-2 y pooler). Requiere una rama de Neon de prueba: la carga escribe miles de filas y no debe correrse sobre los datos de la demo.
- El rate limit es en memoria y por IP: detrás de un proxy hay que confirmar que `trustProxy` entrega la IP real del cliente.
