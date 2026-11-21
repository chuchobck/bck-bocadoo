import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { datosPendientes, enmascararCedulaRuc, validarPerfil, type PerfilEstado } from '../../src/restaurant/profile';

const guardado = { puestos: 40, mesas: null as number | null };
const ok = (dto: object, g = guardado) => validarPerfil('EC', dto, g);
const bad = (dto: object, g = guardado) => expect(() => validarPerfil('EC', dto, g)).toThrow(BadRequestException);

describe('validarPerfil', () => {
  it('sin campos nuevos no valida nada (clientes anteriores)', () => {
    expect(ok({})).toEqual({});
    expect(ok({ puestos: 30 })).toEqual({});
  });
  it('normaliza el teléfono a E.164 y permite null', () => {
    expect(ok({ telefono: '0991234567' })).toEqual({ telefono: '+593991234567' });
    expect(ok({ telefono: null })).toEqual({ telefono: null });
    bad({ telefono: '022345678' });
  });
  it('cédula/RUC: válidos pasan, inválidos 400, null borra', () => {
    ok({ cedulaRuc: '1700000993' });
    ok({ cedulaRuc: '1790000001001' });
    ok({ cedulaRuc: null });
    bad({ cedulaRuc: '1700000994' });
    expect(() => validarPerfil('CO', { cedulaRuc: '1700000993' }, guardado)).toThrow(/país/);
  });
  it('coordenadas dentro de Ecuador (con Galápagos); una sola se valida por eje', () => {
    ok({ latitud: -0.18, longitud: -78.47 });
    ok({ latitud: -0.74, longitud: -90.31 });
    ok({ latitud: null, longitud: null });
    bad({ latitud: 40.4, longitud: -3.7 });
    bad({ latitud: 40.4 });
    bad({ longitud: 10 });
    ok({ latitud: -0.18 });
  });
  it('puestos ≥ mesas: ambos en el cuerpo', () => {
    ok({ puestos: 50, mesas: 50 });
    bad({ puestos: 10, mesas: 11 });
  });
  it('puestos ≥ mesas: uno solo se compara con lo guardado', () => {
    ok({ mesas: 40 });
    bad({ mesas: 41 });
    bad({ puestos: 9 }, { puestos: 40, mesas: 10 });
    ok({ puestos: 10 }, { puestos: 40, mesas: 10 });
    ok({ mesas: null, puestos: 5 }, { puestos: 40, mesas: 10 });
  });
  it('precioAlmuerzoCentavos y su alias precioSueltoCentavos deben coincidir', () => {
    ok({ precioAlmuerzoCentavos: 300, precioSueltoCentavos: 300 });
    bad({ precioAlmuerzoCentavos: 300, precioSueltoCentavos: 350 });
  });
});

describe('enmascararCedulaRuc', () => {
  it('deja solo los últimos 4 dígitos', () => {
    expect(enmascararCedulaRuc('1700000993001')).toBe('*********3001');
    expect(enmascararCedulaRuc('1700000993')).toBe('******0993');
    expect(enmascararCedulaRuc(null)).toBeNull();
  });
});

describe('datosPendientes', () => {
  const completo: PerfilEstado = {
    cedula_ruc: '1700000993',
    telefono_e164: '+593991234567',
    direccion: 'Av. X',
    latitud: '-0.2',
    longitud: '-78.4',
    mesas_total: 10,
    puestos_definidos: true,
    precio_suelto_centavos: '300',
  };
  it('completo → sin pendientes', () => expect(datosPendientes(completo)).toEqual([]));
  it('recién registrado → todo pendiente, en el orden del contrato', () => {
    expect(
      datosPendientes({
        cedula_ruc: null,
        telefono_e164: null,
        direccion: null,
        latitud: null,
        longitud: null,
        mesas_total: null,
        puestos_definidos: false,
        precio_suelto_centavos: '0',
      }),
    ).toEqual(['cedulaRuc', 'telefono', 'direccion', 'coordenadas', 'mesas', 'puestos', 'precioAlmuerzo']);
  });
  it('coordenadas incompletas siguen pendientes', () => {
    expect(datosPendientes({ ...completo, longitud: null })).toEqual(['coordenadas']);
  });
});
