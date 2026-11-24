// Ids opacos de los miembros de una mesa compartida (PR 9). Hacia afuera un miembro nunca sale con su `miembro_id`: sale
// con `ref` = base64url(HMAC-SHA256(subclave, "mesa-ref:v1|" + mesaId + "|" + miembroId)) truncado a 22 caracteres, con
// subclave = HMAC-SHA256(claveBase, "bocadoo:ref:v1") y claveBase = QR_SECRET_KEY (ver RefsMesaService). Determinista y
// sin tabla: el mismo miembro tiene el mismo ref en toda respuesta (comensal, anfitrión, caja, cuentas) y entre llamadas.
//
// Solo se usa al serializar las respuestas (frontera de serialización): la cotización pura (src/billing) y el cobro
// trabajan siempre con el `miembro_id` interno.

import { createHmac } from 'node:crypto';

const ETIQUETA_SUBCLAVE = 'bocadoo:ref:v1';
const DOMINIO_REF = 'mesa-ref:v1|';
/** 22 caracteres base64url = 132 bits. */
export const LARGO_REF = 22;

/** subclave = HMAC-SHA256(claveBase, "bocadoo:ref:v1"): separa este uso de cualquier otro de la misma llave. */
export const subclaveRefs = (claveBase: Buffer): Buffer => createHmac('sha256', claveBase).update(ETIQUETA_SUBCLAVE).digest();

/** El ref opaco de un miembro de una mesa (ambos ids internos, como texto). */
export const calcularRef = (subclave: Buffer, mesaId: string, miembroId: string): string =>
  createHmac('sha256', subclave).update(`${DOMINIO_REF}${mesaId}|${miembroId}`).digest('base64url').slice(0, LARGO_REF);

let subclave: Buffer | null = null;

/** La configura RefsMesaService al arrancar la app. */
export function configurarRefsMesa(claveBase: Buffer): void {
  subclave = subclaveRefs(claveBase);
}

/** Ref opaco del miembro. Sin configurar falla (nunca devuelve el id real). */
export function refMiembro(mesaId: string, miembroId: string): string {
  if (!subclave) throw new Error('Refs de mesa sin configurar: falta RefsMesaService.');
  return calcularRef(subclave, String(mesaId), String(miembroId));
}

/** Ref de línea o de aviso de una mesa: `57:almuerzo#1` → `<ref>:almuerzo#1`. Un ref sin prefijo numérico no cambia. */
export function opacarRefLinea(ref: string, mesaId: string): string {
  const m = /^(\d+)(:.*)$/s.exec(ref);
  return m ? refMiembro(mesaId, m[1]!) + m[2]! : ref;
}

interface CotizacionConRefs {
  lineas: { ref: string; personaRef: string; pagadorRef: string }[];
  porPagador: { pagadorRef: string }[];
  avisos: { lineaRef: string | null }[];
}

export const opacarAvisos = <A extends { lineaRef: string | null }>(avisos: A[], mesaId: string): A[] =>
  avisos.map((a) => ({ ...a, lineaRef: a.lineaRef === null ? null : opacarRefLinea(a.lineaRef, mesaId) }));

/**
 * Una cotización de mesa (o de una cuenta de mesa) para la respuesta: `personaRef`, `pagadorRef`, el prefijo de
 * `lineas[].ref` y de `avisos[].lineaRef` pasan del `miembro_id` al ref opaco. Montos y demás campos no cambian.
 */
export function opacarCotizacionMesa<T extends CotizacionConRefs>(c: T, mesaId: string): T {
  const ref = (miembroId: string) => refMiembro(mesaId, miembroId);
  return {
    ...c,
    lineas: c.lineas.map((l) => ({
      ...l,
      ref: opacarRefLinea(l.ref, mesaId),
      personaRef: ref(l.personaRef),
      pagadorRef: ref(l.pagadorRef),
    })),
    porPagador: c.porPagador.map((t) => ({ ...t, pagadorRef: ref(t.pagadorRef) })),
    avisos: opacarAvisos(c.avisos, mesaId),
  };
}
