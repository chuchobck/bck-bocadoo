import { HttpException, HttpStatus, applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

/**
 * Error de negocio con un código estable (`code` en el problem+json). El cliente decide por el código, nunca por el
 * texto de `detail`, que puede cambiar.
 */
export class BusinessError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    detail: string,
    /** Campos extra del problem+json (RFC 9457, «extension members»), p. ej. el saldo nuevo de `SALDO_CAMBIO`. */
    readonly extensiones?: Record<string, unknown>,
  ) {
    super({ code, message: detail }, status);
  }
}

export const notFound = (code: string, detail: string) => new BusinessError(HttpStatus.NOT_FOUND, code, detail);
export const conflict = (code: string, detail: string, extensiones?: Record<string, unknown>) =>
  new BusinessError(HttpStatus.CONFLICT, code, detail, extensiones);
export const badRequest = (code: string, detail: string) => new BusinessError(HttpStatus.BAD_REQUEST, code, detail);
export const forbidden = (code: string, detail: string) => new BusinessError(HttpStatus.FORBIDDEN, code, detail);
export const unprocessable = (code: string, detail: string) => new BusinessError(HttpStatus.UNPROCESSABLE_ENTITY, code, detail);

/** Código de un error sin código propio: el nombre del estado HTTP (NOT_FOUND, BAD_REQUEST…), también estable. */
export function problemCode(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'code' in body && typeof (body as { code: unknown }).code === 'string')
    return (body as { code: string }).code;
  return HttpStatus[status] ?? 'ERROR';
}

/** Documenta en Swagger los errores de negocio posibles de un endpoint: `{ 409: ['YA_EXISTE', …] }`. */
export const ApiProblems = (byStatus: Partial<Record<400 | 403 | 404 | 409 | 422 | 429 | 503, string[]>>) =>
  applyDecorators(
    ...Object.entries(byStatus).map(([status, codes]) =>
      ApiResponse({
        status: Number(status),
        description: `application/problem+json con \`code\`: ${codes!.map((c) => `\`${c}\``).join(', ')}`,
      }),
    ),
  );
