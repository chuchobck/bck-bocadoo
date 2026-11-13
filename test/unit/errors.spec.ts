import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BusinessError, conflict, problemCode } from '../../src/common/errors';

describe('códigos de error estables', () => {
  it('un BusinessError lleva su código y su mensaje', () => {
    const e = conflict('YA_EXISTE', 'Ya existe.');
    expect(e).toBeInstanceOf(BusinessError);
    expect(e.getStatus()).toBe(409);
    expect(problemCode(409, e.getResponse())).toBe('YA_EXISTE');
  });
  it('sin código propio se usa el nombre del estado HTTP', () => {
    const e = new NotFoundException('x');
    expect(problemCode(404, e.getResponse())).toBe('NOT_FOUND');
    expect(problemCode(400, 'texto')).toBe('BAD_REQUEST');
  });
});
