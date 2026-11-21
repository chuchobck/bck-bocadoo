import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { reglasDePais } from '../../src/restaurant/country';
import { cedulaValida, rucValido } from '../../src/restaurant/country/ec';
import { ejemploCedulaRuc } from '../../src/restaurant/country/ejemplos';
import { LOG_REDACT } from '../../src/common/log-redact';

// Números inventados con dígito verificador calculado a mano (script aparte), no son de nadie.
describe('Ecuador: teléfono', () => {
  const ec = reglasDePais('EC');
  it.each([
    ['0991234567', '+593991234567'],
    ['0900000000', '+593900000000'],
    ['+593991234567', '+593991234567'], // ya normalizado: GET → PATCH no se rompe
  ])('acepta %s → %s', (raw, e164) => expect(ec.telefono(raw)).toBe(e164));

  it.each([
    '099123456', // 9 dígitos
    '09912345678', // 11 dígitos
    '0891234567', // no empieza por 09
    '0229123456', // fijo
    '991234567',
    '+593 99 123 4567',
    '099-123-4567',
    '+5932991234567',
    '+12025550123',
    '09912345a7',
    '',
  ])('rechaza %j', (raw) => expect(ec.telefono(raw)).toBeNull());
});

describe('Ecuador: cédula', () => {
  it.each(['1700000993', '0100000017', '2400000077', '3000000046', '0900000100'])('acepta %s', (c) => expect(cedulaValida(c)).toBe(true));
  it.each([
    ['1700000994', 'verificador incorrecto'],
    ['2500000070', 'provincia 25'],
    ['0000000000', 'provincia 00'],
    ['3100000000', 'provincia 31'],
    ['1760000000', 'tercer dígito 6'],
    ['1790000001', 'tercer dígito 9'],
    ['170000099', '9 dígitos'],
    ['17000009930', '11 dígitos'],
    ['17000009a3', 'no numérica'],
  ])('rechaza %s (%s)', (c) => expect(cedulaValida(c)).toBe(false));
});

describe('Ecuador: RUC', () => {
  it.each([
    ['1700000993001', 'persona natural'],
    ['0100000017002', 'persona natural, establecimiento 002'],
    ['1790000001001', 'sociedad privada (tercer dígito 9, módulo 11)'],
    ['0990000018001', 'sociedad privada'],
    ['1791234561001', 'sociedad privada'],
    ['1760000070001', 'sociedad pública (tercer dígito 6, módulo 11)'],
    ['0160000190001', 'sociedad pública'],
  ])('acepta %s (%s)', (r) => expect(rucValido(r)).toBe(true));

  it.each([
    ['1700000993000', 'últimos 3 dígitos 000'],
    ['1700000994001', 'natural: verificador mal'],
    ['1790000002001', 'privada: verificador mal'],
    ['1760000080001', 'pública: verificador mal'],
    ['1770000000001', 'tercer dígito 7'],
    ['1780000000001', 'tercer dígito 8'],
    ['2500000070001', 'provincia 25'],
    ['170000099300', '12 dígitos'],
    ['17000009930011', '14 dígitos'],
    ['17000009930a1', 'no numérico'],
  ])('rechaza %s (%s)', (r) => expect(rucValido(r)).toBe(false));

  it('el ejemplo del OpenAPI está generado y pasa el validador', () => {
    expect(rucValido(ejemploCedulaRuc())).toBe(true);
  });
  it('cedulaRuc de reglas EC acepta cédula o RUC', () => {
    const ec = reglasDePais('EC');
    expect(ec.cedulaRuc('1700000993')).toBe(true);
    expect(ec.cedulaRuc('1790000001001')).toBe(true);
    expect(ec.cedulaRuc('1700000994')).toBe(false);
  });
});

describe('Ecuador: coordenadas', () => {
  const ec = reglasDePais('EC');
  it.each([
    [-0.18, -78.47, 'Quito'],
    [-2.17, -79.92, 'Guayaquil'],
    [-0.74, -90.31, 'Galápagos (Santa Cruz)'],
    [-5.0, -80.0, 'sur'],
    [1.4, -78.0, 'norte'],
  ])('dentro: %d, %d (%s)', (lat, lng) => expect(ec.enPais(lat, lng)).toBe(true));
  it.each([
    [40.4, -3.7, 'Madrid'],
    [-12.05, -77.04, 'Lima'],
    [4.6, -74.08, 'Bogotá'],
    [-0.18, 78.47, 'longitud con el signo cambiado'],
    [-0.74, -85.0, 'océano entre continente e islas'],
    [10, -78, 'lat fuera'],
  ])('fuera: %d, %d (%s)', (lat, lng) => expect(ec.enPais(lat, lng)).toBe(false));
});

describe('País sin reglas propias (punto de extensión)', () => {
  const co = reglasDePais('CO');
  it('teléfono E.164 genérico, sin documento fiscal y rangos del planeta', () => {
    expect(co.telefono('+573001234567')).toBe('+573001234567');
    expect(co.telefono('3001234567')).toBeNull();
    expect(co.cedulaRuc('1700000993')).toBe(false);
    expect(co.enPais(4.6, -74.08)).toBe(true);
    expect(co.enPais(95, 0)).toBe(false);
  });
});

describe('Logs: la cédula/RUC se redacta', () => {
  it('a distintas profundidades', () => {
    let out = '';
    const sink = new Writable({
      write(chunk, _e, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const log = pino({ redact: LOG_REDACT }, sink);
    const ruc = ejemploCedulaRuc();
    log.info(
      { cedulaRuc: ruc, req: { body: { cedulaRuc: ruc, restaurante: { cedulaRuc: ruc } } }, data: { restaurante: { cedulaRuc: ruc } } },
      'x',
    );
    expect(out).not.toContain(ruc);
    expect(out).toContain('[Redacted]');
  });
});
