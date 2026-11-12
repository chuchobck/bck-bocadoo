import { AsyncLocalStorage } from 'node:async_hooks';

/** Datos del request actual. Los llena la capa de seguridad (fase 4) tras validar el JWT. */
export interface RequestContext {
  requestId: string;
  /** Usuario autenticado (usuario_id interno). */
  userId?: string;
  /** Restaurante activo (restaurante_id interno): el tenant de RLS. */
  tenantId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  /** Ejecuta fn con un contexto propio; cada request concurrente ve el suyo. */
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run({ ...ctx }, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  /** Completa el contexto del request en curso (p. ej. el guard al validar el token). */
  set(patch: Partial<Omit<RequestContext, 'requestId'>>): void {
    const ctx = storage.getStore();
    if (ctx) Object.assign(ctx, patch);
  },
};
