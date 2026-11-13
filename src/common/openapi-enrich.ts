import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Completa el documento OpenAPI que genera Nest con lo que es igual en todos los endpoints, para no repetirlo en
 * cada decorador:
 *
 * - el esquema `ProblemDetails` (RFC 9457, igual al que escribe `ProblemFilter`) y su uso en cada respuesta de error;
 * - los errores que cualquier endpoint puede dar (401 si exige token, 429 por el tope general por IP, 500);
 * - ejemplos de cada cuerpo de petición y de cada respuesta, construidos desde el esquema (los `example` que ya trae
 *   cada propiedad mandan; el resto se completa con valores plausibles).
 *
 * Solo documenta: no cambia ninguna ruta ni ningún DTO. Las pruebas de contrato (`test/unit/openapi-contract.spec.ts`)
 * validan que los ejemplos cumplan su propio esquema.
 */

type Json = Record<string, unknown>;
interface Schema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  example?: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  default?: unknown;
  description?: string;
  additionalProperties?: boolean | Schema;
}
interface Operation extends Json {
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  requestBody?: { content?: Record<string, { schema?: Schema; example?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema; example?: unknown }> }>;
}

const UUID = '0b6f3c1e-8c1a-4f0e-9d5a-6f1c2f7a9e10';
const INSTANT = '2026-11-13T17:00:00.000Z';
const DAY = '2026-11-13';

const TITLES: Record<string, string> = {
  '400': 'Bad Request',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not Found',
  '409': 'Conflict',
  '413': 'Payload Too Large',
  '422': 'Unprocessable Entity',
  '429': 'Too Many Requests',
  '500': 'Internal Server Error',
  '503': 'Service Unavailable',
};
const DEFAULT_CODES: Record<string, string> = {
  '400': 'BAD_REQUEST',
  '401': 'UNAUTHORIZED',
  '403': 'FORBIDDEN',
  '404': 'NOT_FOUND',
  '409': 'CONFLICT',
  '413': 'PAYLOAD_TOO_LARGE',
  '422': 'UNPROCESSABLE_ENTITY',
  '429': 'TOO_MANY_REQUESTS',
  '500': 'ERROR_INTERNO',
  '503': 'SERVICE_UNAVAILABLE',
};
const DETAILS: Record<string, string> = {
  '400': 'La solicitud no es válida: revisa los campos enviados.',
  '401': 'Token ausente o inválido.',
  '403': 'No tienes acceso a este restaurante o tu rol no permite esta acción.',
  '404': 'No se encontró lo que pides.',
  '409': 'La operación choca con el estado actual.',
  '422': 'La solicitud es válida pero no se puede cumplir.',
  '429': 'Demasiadas solicitudes. Reintenta cuando indique Retry-After.',
  '500': 'Error interno del servidor.',
  '503': 'Servicio no disponible.',
};
const OK_DESCRIPTION: Record<string, string> = { '200': 'Operación exitosa', '201': 'Creado', '204': 'Sin contenido' };

/** Valor plausible para una propiedad sin `example`, según su nombre y las restricciones de su esquema. */
function scalar(name: string, s: Schema): unknown {
  if (s.enum?.length) return s.enum[0];
  if (s.default !== undefined) return s.default;
  const n = name.toLowerCase();
  if (s.type === 'boolean') return true;
  if (s.type === 'integer' || s.type === 'number') {
    let v = /centavos/.test(n) ? 650 : /porcentaje/.test(n) ? 50 : /cantidad|almuerzos|stock|limit/.test(n) ? 5 : 1;
    if (s.minimum !== undefined) v = Math.max(v, s.minimum);
    if (s.maximum !== undefined) v = Math.min(v, s.maximum);
    return v;
  }
  if (s.type === 'string') {
    if (s.format === 'date-time') return INSTANT;
    if (s.format === 'date') return DAY;
    if (s.format === 'uuid') return UUID;
    let v: string;
    if (n === 'id' || n.endsWith('id') || n === 'cursor' || n === 'nextcursor')
      v = n.includes('cursor') ? 'eyJuIjoiRG9uYSBSb3NhIiwiaSI6IjEifQ' : UUID;
    else if (n === 'correo') v = 'maria@correo.com';
    else if (n === 'password') v = 'una-clave-larga-123';
    else if (n === 'refreshtoken') v = 'b'.repeat(43);
    else if (n === 'accesstoken') v = 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiIuLi4ifQ.firma';
    else if (n === 'identificador') v = 'maria@correo.com';
    else if (n.includes('url')) v = 'https://cdn.ejemplo.com/imagen.png';
    else if (n.includes('telefono')) v = '+593991234567';
    else if (/^(abre|cierra|hora)/.test(n)) v = '12:00';
    else if (/fecha|vence|desde|hasta|^hoy$|dia$/.test(n)) v = DAY;
    else if (/(^|[a-z])en$/.test(name)) v = INSTANT;
    else if (n === 'slug') v = 'dona-rosa';
    else if (n === 'moneda' || n.includes('moneda')) v = 'USD';
    else if (n === 'nombre') v = 'Doña Rosa';
    else if (n.includes('nombre')) v = 'María Guamán';
    else if (n === 'estado') v = 'ACTIVO';
    else v = 'texto';
    if (s.minLength !== undefined && v.length < s.minLength) v = v.padEnd(s.minLength, 'a');
    if (s.maxLength !== undefined && v.length > s.maxLength) v = v.slice(0, s.maxLength);
    return v;
  }
  return null;
}

function build(name: string, s: Schema | undefined, schemas: Record<string, Schema>, seen: string[]): unknown {
  if (!s) return null;
  if (s.$ref) {
    const key = s.$ref.replace('#/components/schemas/', '');
    if (seen.includes(key)) return null; // esquema recursivo: se corta
    return build(name, schemas[key], schemas, [...seen, key]);
  }
  if (s.example !== undefined) return s.example;
  const parts = s.allOf ?? s.oneOf ?? s.anyOf;
  if (parts?.length) return build(name, parts[0], schemas, seen);
  if (s.type === 'array') return [build(name, s.items, schemas, seen)];
  if (s.properties) {
    const out: Json = {};
    for (const [k, v] of Object.entries(s.properties)) out[k] = build(k, v, schemas, seen);
    return out;
  }
  if (s.type === 'object') return {};
  return scalar(name, s);
}

const problemExample = (status: string, code: string, detail?: string) => ({
  type: 'about:blank',
  title: TITLES[status] ?? 'Error',
  status: Number(status),
  code,
  detail: detail ?? DETAILS[status] ?? 'Error.',
  instance: '/v1/ejemplo',
  requestId: UUID,
});

/** Primer código estable que menciona una descripción escrita con `ApiProblems` ("… con `code`: `A`, `B`"). */
const firstCode = (description?: string): string | undefined => /`code`:\s*`([A-Z0-9_]+)`/.exec(description ?? '')?.[1];

/**
 * Nest declara `string` como tipo de los elementos de un arreglo cuando el DTO no lo indica (`number[]` sin `type`).
 * Si el `example` demuestra otra cosa, se corrige el tipo de los elementos con lo que muestra el ejemplo.
 */
function fixArrayItems(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(fixArrayItems);
  if (!node || typeof node !== 'object') return;
  const s = node as Schema;
  if (s.type === 'array' && s.items?.type === 'string' && Array.isArray(s.example) && s.example.length) {
    const sample = s.example[0] as unknown;
    if (typeof sample === 'number') s.items = { type: s.example.every(Number.isInteger) ? 'integer' : 'number' };
    else if (sample && typeof sample === 'object') s.items = { type: 'object' };
  }
  Object.values(node).forEach(fixArrayItems);
}

export function enrichDocument(doc: OpenAPIObject): OpenAPIObject {
  fixArrayItems(doc.components?.schemas);
  const schemas = (doc.components?.schemas ?? {}) as unknown as Record<string, Schema>;
  doc.components = { ...doc.components, schemas: doc.components?.schemas ?? {} };
  (doc.components.schemas as Record<string, unknown>)['ProblemDetails'] = {
    type: 'object',
    description: 'Error según RFC 9457 (`application/problem+json`). El cliente decide por `code`, nunca por el texto de `detail`.',
    required: ['type', 'title', 'status', 'code', 'detail'],
    properties: {
      type: { type: 'string', example: 'about:blank' },
      title: { type: 'string', example: 'Conflict' },
      status: { type: 'integer', example: 409 },
      code: { type: 'string', example: 'CONFLICT', description: 'Código estable; sin código propio es el nombre del estado HTTP' },
      detail: { type: 'string', example: 'La operación choca con el estado actual.' },
      instance: { type: 'string', example: '/v1/ofertas', description: 'Ruta de la petición' },
      requestId: { type: 'string', example: UUID, description: 'Identificador para buscar la petición en el log' },
    },
  };
  const problemSchema = { $ref: '#/components/schemas/ProblemDetails' };

  for (const item of Object.values(doc.paths) as Record<string, Operation>[]) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const responses = (op.responses ??= {});
      const standard: string[] = ['429', '500'];
      if (op.security?.length) standard.unshift('401');
      const params = op.parameters ?? [];
      if (op.requestBody || params.some((p) => p.in === 'query' || p.in === 'path')) standard.unshift('400');
      if (params.some((p) => p.name.toLowerCase() === 'x-restaurant-id')) standard.push('403');
      for (const status of standard)
        responses[status] ??= { description: `${TITLES[status]}: application/problem+json con \`code\`: \`${DEFAULT_CODES[status]}\`` };
      if (!op.security?.length) delete responses['401'];

      for (const [status, res] of Object.entries(responses)) {
        if (/^2/.test(status)) {
          res.description ||= OK_DESCRIPTION[status] ?? 'Operación exitosa';
          const media = res.content?.['application/json'];
          if (media?.schema && media.example === undefined) media.example = build('', media.schema, schemas, []);
          continue;
        }
        if (Number(status) < 400) continue;
        res.content = {
          'application/problem+json': {
            schema: problemSchema,
            example: problemExample(status, firstCode(res.description) ?? DEFAULT_CODES[status] ?? 'ERROR'),
          },
        };
      }
      const body = op.requestBody?.content?.['application/json'];
      if (body?.schema && body.example === undefined) body.example = build('', body.schema, schemas, []);
    }
  }
  return doc;
}
