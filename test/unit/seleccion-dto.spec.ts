import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { platoAgotadoSql, CATEGORIAS_CARTA } from '../../src/menu/carta';
import { SeleccionDto } from '../../src/tables/selection';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const errors = async (body: object) =>
  (await validate(plainToInstance(SeleccionDto, body), { whitelist: true, forbidNonWhitelisted: true })).length;

describe('SeleccionDto (forma del cuerpo de PUT /v1/mis/mesas/{id}/seleccion)', () => {
  it('acepta selección vacía, solo almuerzo, solo extras y ambos', async () => {
    expect(await errors({})).toBe(0);
    expect(await errors({ almuerzo: { platos: [U1] } })).toBe(0);
    expect(await errors({ extras: [{ plato: U1, cantidad: 10 }] })).toBe(0);
    expect(await errors({ almuerzo: { platos: [U1, U2] }, extras: [{ plato: U1, cantidad: 1 }] })).toBe(0);
  });

  it.each([
    ['cantidad 0', { extras: [{ plato: U1, cantidad: 0 }] }],
    ['cantidad 11', { extras: [{ plato: U1, cantidad: 11 }] }],
    ['cantidad decimal', { extras: [{ plato: U1, cantidad: 1.5 }] }],
    ['cantidad negativa', { extras: [{ plato: U1, cantidad: -1 }] }],
    ['cantidad como texto', { extras: [{ plato: U1, cantidad: '2' }] }],
    ['sin cantidad', { extras: [{ plato: U1 }] }],
    ['plato no UUID', { extras: [{ plato: '15', cantidad: 1 }] }],
    [
      'extras repetidos (sin importar mayúsculas)',
      {
        extras: [
          { plato: U1, cantidad: 1 },
          { plato: U1.toUpperCase(), cantidad: 1 },
        ],
      },
    ],
    [
      'más de 10 extras',
      { extras: Array.from({ length: 11 }, (_, i) => ({ plato: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cantidad: 1 })) },
    ],
    ['almuerzo vacío', { almuerzo: { platos: [] } }],
    ['más de 4 platos de almuerzo', { almuerzo: { platos: [U1, U2, 'a', 'b', 'c'] } }],
    ['platos de almuerzo repetidos', { almuerzo: { platos: [U1, U1] } }],
    ['campo de más', { extras: [{ plato: U1, cantidad: 1, precioCentavos: 1 }] }],
    ['campo de más en la raíz', { paraLlevar: true }],
  ])('rechaza: %s', async (_n, body) => {
    expect(await errors(body)).toBeGreaterThan(0);
  });
});

describe('carta fija', () => {
  it('las categorías de carta no incluyen el almuerzo', () => {
    expect([...CATEGORIAS_CARTA]).toEqual(['A_LA_CARTA', 'EXTRA', 'BEBIDA']);
  });
  it('agotado se compara en la fecha local del local, no en la del servidor', () => {
    const sql = platoAgotadoSql('p', 'r');
    expect(sql).toContain('p.agotado_en IS NOT NULL');
    expect(sql).toContain('AT TIME ZONE r.zona_horaria');
    expect(sql.match(/AT TIME ZONE r\.zona_horaria/g)).toHaveLength(2);
  });
});
