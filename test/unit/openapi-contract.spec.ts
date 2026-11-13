import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

/**
 * Pruebas de contrato sobre docs/openapi.json (la fuente que consume el frontend). No necesitan base de datos:
 * revisan que el documento sea coherente y que cada ejemplo cumpla su propio esquema.
 */
interface Media {
  schema?: unknown;
  example?: unknown;
}
interface Op {
  summary?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  requestBody?: { content: Record<string, Media> };
  responses: Record<string, { description?: string; content?: Record<string, Media> }>;
}
const doc = JSON.parse(readFileSync('docs/openapi.json', 'utf8')) as {
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, unknown> };
};
const ops = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ id: `${method.toUpperCase()} ${path}`, op })),
);

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'spec', components: doc.components });
const validate = (schema: unknown, value: unknown) => {
  const s = JSON.parse(JSON.stringify(schema).replaceAll('#/components/schemas/', 'spec#/components/schemas/'));
  const fn = ajv.compile(s);
  return fn(value) ? [] : fn.errors!.map((e) => `${e.instancePath || '/'} ${e.message}`);
};

describe('contrato OpenAPI', () => {
  it('tiene operaciones', () => expect(ops.length).toBeGreaterThan(100));

  it.each(ops)('$id: resumen, etiqueta y respuesta de éxito', ({ op }) => {
    expect(op.summary?.length).toBeGreaterThan(5);
    expect(op.tags).toHaveLength(1);
    expect(Object.keys(op.responses).some((s) => s.startsWith('2'))).toBe(true);
  });

  it.each(ops)('$id: errores documentados como problem+json', ({ op }) => {
    const errors = Object.entries(op.responses).filter(([s]) => Number(s) >= 400);
    expect(errors.length).toBeGreaterThan(0);
    for (const [, r] of errors)
      expect(r.content?.['application/problem+json']?.schema).toEqual({ $ref: '#/components/schemas/ProblemDetails' });
    expect(op.responses['429']).toBeDefined();
    expect(op.responses['500']).toBeDefined();
    if (op.security?.length) expect(op.responses['401']).toBeDefined();
  });

  it.each(ops)('$id: los endpoints del personal documentan 403 y x-restaurant-id', ({ op }) => {
    const staff = op.parameters?.some((p) => p.name.toLowerCase() === 'x-restaurant-id');
    if (staff) expect(op.responses['403']).toBeDefined();
  });

  it.each(ops)('$id: ejemplos válidos contra su esquema', ({ op }) => {
    const found: string[] = [];
    const check = (where: string, media?: Media) => {
      if (!media?.schema) return;
      expect(media.example, `${where} sin ejemplo`).toBeDefined();
      for (const e of validate(media.schema, media.example)) found.push(`${where}: ${e}`);
    };
    for (const m of Object.values(op.requestBody?.content ?? {})) check('petición', m);
    for (const [s, r] of Object.entries(op.responses)) for (const m of Object.values(r.content ?? {})) check(`respuesta ${s}`, m);
    expect(found).toEqual([]);
  });

  it.each(ops)('$id: el grupo por rol coincide con sus encabezados y su seguridad', ({ op }) => {
    const staff = op.parameters?.some((p) => p.name.toLowerCase() === 'x-restaurant-id') ?? false;
    const grupo = op.tags![0];
    expect(['Público', 'Comensal', 'Caja', 'Dueño']).toContain(grupo);
    expect(staff).toBe(grupo === 'Caja' || grupo === 'Dueño');
    expect(Boolean(op.security?.length)).toBe(grupo !== 'Público');
  });

  it('no hay esquemas sin usar con nombres duplicados de ofertas y pedidos', () => {
    expect(doc.components.schemas['CanjeResponse']).toBeUndefined();
    expect(doc.components.schemas['OfertaCanjeResponse']).toBeDefined();
    expect(doc.components.schemas['PedidoCanjeResponse']).toBeDefined();
  });
});
