import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/** Id numérico interno de un tenant (BIGINT) como texto; nunca llega a SQL sin validar. */
@Injectable()
export class IdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[1-9][0-9]{0,17}$/.test(value)) throw new BadRequestException('Id inválido.');
    return value;
  }
}

/** Fecha AAAA-MM-DD real (rechaza 2026-02-31). */
@Injectable()
export class IsoDatePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!ok) throw new BadRequestException('Fecha inválida: usa AAAA-MM-DD.');
    return value;
  }
}

/** UUID (public_id). */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      throw new BadRequestException('Identificador inválido.');
    return value.toLowerCase();
  }
}

/** Fecha AAAA-MM-DD o la palabra `hoy` (resuelta con la zona horaria del restaurante). */
@Injectable()
export class FechaOHoyPipe implements PipeTransform<string, string> {
  private readonly iso = new IsoDatePipe();
  transform(value: string): string {
    return value === 'hoy' ? value : this.iso.transform(value);
  }
}

/**
 * Cuerpo que no admite campos: sin cuerpo, `null` o `{}`. Cualquier campo → 400 `BAD_REQUEST` con el mismo mensaje que
 * da la whitelist global (`forbidNonWhitelisted`). Hace falta porque un DTO sin propiedades no tiene metadatos y
 * `forbidUnknownValues` lo rechazaría siempre. Se usa con un parámetro de tipo `unknown`, que la ValidationPipe global no
 * valida.
 */
@Injectable()
export class SinCamposPipe implements PipeTransform<unknown, Record<string, never>> {
  transform(value: unknown): Record<string, never> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('El cuerpo debe ser un objeto JSON.');
    const campos = Object.keys(value);
    if (campos.length) throw new BadRequestException(campos.map((c) => `property ${c} should not exist`));
    return {};
  }
}
