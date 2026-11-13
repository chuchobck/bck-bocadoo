// Prueba de carga de la caja: validar almuerzos a ritmo constante.
// Objetivo del plan: p95 < 300 ms a 50 validaciones por segundo, sin errores y descontando de verdad.
//
// 1) LOAD_PASSWORD='...' node scripts/load-seed.mjs          (base de PRUEBAS)
// 2) Levanta la API con RATE_LIMIT_MAX alto (todas las peticiones salen de una sola IP).
// 3) docker run --rm -i -v "$PWD/test/load:/load" -e BASE_URL=http://host.docker.internal:3055 -e LOAD_PASSWORD='...' grafana/k6 run /load/validar.k6.js
import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const data = JSON.parse(open('./.data.json'));
const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const RATE = Number(__ENV.RATE || 50);
const DURATION = __ENV.DURATION || '60s';
// Desplaza el primer cliente: permite repetir la prueba sin caer en la regla de doble escaneo (60 s).
const OFFSET = Number(__ENV.OFFSET || 0);

const descontados = new Counter('almuerzos_descontados');

export const options = {
  scenarios: {
    caja: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 50, maxVUs: 200 },
  },
  thresholds: {
    'http_req_duration{endpoint:validar}': ['p(95)<300'],
    'http_req_failed{endpoint:validar}': ['rate<0.001'],
    checks: ['rate>0.999'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  const r = http.post(`${BASE}/v1/auth/login`, JSON.stringify({ identificador: data.correo, password: __ENV.LOAD_PASSWORD }), {
    headers: { 'content-type': 'application/json' },
  });
  if (r.status !== 200) throw new Error(`login falló: ${r.status} ${r.body}`);
  return { token: r.json('accessToken') };
}

// UUID v4 suficiente para claves de idempotencia de la prueba.
const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

export default function (ctx) {
  // Cada iteración usa un cliente distinto: así cada petición descuenta de verdad (no cae en DUPLICADO).
  const cliente = data.clientes[(OFFSET + exec.scenario.iterationInTest) % data.clientes.length];
  const res = http.post(`${BASE}/v1/caja/validar`, JSON.stringify({ clienteId: cliente }), {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.token}`,
      'x-restaurant-id': data.restaurante,
      'idempotency-key': uuid(),
    },
    tags: { endpoint: 'validar' },
  });
  const ok = check(res, {
    'responde 200': (r) => r.status === 200,
    'descontó (OK)': (r) => r.status === 200 && r.json('descontado') === true,
  });
  if (ok) descontados.add(1);
}
