import { BadRequestException, ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { DatabaseError } from 'pg';

/** Traduce errores de Postgres previsibles a respuestas HTTP claras (en vez de un 500). */
export function mapPgError(err: unknown): HttpException | null {
  if (!(err instanceof DatabaseError)) return null;
  switch (err.code) {
    case '23505':
      return new ConflictException('Ya existe un registro con esos datos.');
    case '23503':
      return new ConflictException('El registro está en uso o referencia algo que no existe.');
    case '23502':
    case '23514':
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
    case '22001':
      return new BadRequestException('Algún dato tiene un valor no permitido.');
    case '42501':
      return new ForbiddenException('No tienes permiso para esa acción.');
    default:
      return null;
  }
}
