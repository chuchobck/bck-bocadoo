// Tipos de la cotización de cobros (docs/spec-cobros.md, B.2 entrada y B.4 salida). Montos siempre en centavos enteros.

export type Flujo = 'PREORDEN' | 'POS' | 'QR' | 'OFERTA' | 'MESA';
export type ModoMesa = 'CADA_UNO' | 'INVITO_YO';
export type MomentoCobro = 'ANTES_DE_SERVIR' | 'DESPUES_DE_SERVIR';
export type EstadoPlan = 'OK' | 'SIN_PLAN' | 'SIN_SALDO' | 'VENCIDO' | 'DIA_NO_VALIDO' | 'DUPLICADO' | 'LIMITE_SAAS';
export type TipoItem = 'ALMUERZO' | 'A_LA_CARTA' | 'EXTRA' | 'BEBIDA' | 'OFERTA' | 'LIBRE';
export type CategoriaBase = 'ALMUERZO' | 'A_LA_CARTA' | 'EXTRA' | 'BEBIDA';

export type Fuente = 'PLAN' | 'OFERTA' | 'CAJA';
export type Pagador = 'PROPIO' | 'ANFITRION';
export type MotivoOmision = 'PLATO_AGOTADO' | 'DUPLICADO' | 'LIMITE_SAAS';
export type CodigoAviso = 'OFERTA_AGOTADA' | 'OFERTA_EXPIRADA' | 'PLATO_AGOTADO' | 'DUPLICADO' | 'LIMITE_SAAS' | 'PLAN_NO_ALCANZA';

export interface PlanPersona {
  estado: EstadoPlan;
  /** Almuerzos que el plan cubre hoy (0 si `estado` ≠ OK). */
  disponibles: number;
  /**
   * Solo con `estado` OK: qué respondió la base a la primera unidad que ya no se descontó (B.3 paso 5, «esa unidad se
   * reclasifica según ese resultado»). DUPLICADO o LIMITE_SAAS → las unidades restantes quedan omitidas (I-10); sin
   * él (o con otro estado), van a CAJA con aviso PLAN_NO_ALCANZA.
   */
  trasAgotarse?: EstadoPlan;
}

export interface PersonaCobro {
  /** Id estable: miembro_id, cliente_id o "0". */
  ref: string;
  /** Anfitrión 0; el resto por (unido_en, miembro_id). */
  orden: number;
  esAnfitrion: boolean;
  /** Solo MESA (mesa_compartida_miembro.para_llevar). */
  paraLlevar: boolean;
  plan: PlanPersona;
}

export interface ItemCobro {
  /** Id estable de la línea (clave de idempotencia por línea). */
  ref: string;
  personaRef: string;
  tipo: TipoItem;
  /** Entero 1..100. */
  cantidad: number;
  /** Entero ≥ 0, resuelto por el servidor (B.3 paso 2). En ALMUERZO debe ser igual a `precioAlmuerzo`. */
  precioUnitario: number;
  /** Solo flujo POS; en los demás flujos debe ser null. */
  paraLlevar: boolean | null;
  /** Obligatorio si tipo = OFERTA; en un ALMUERZO lo convierte en OFERTA (D4). */
  ofertaId: string | null;
  /** Categoría del plato de la oferta. */
  categoriaBase: CategoriaBase | null;
  /** false = agotado al momento de aplicar (solo MESA, B.3 paso 4). */
  disponible: boolean;
  /** Datos de presentación que se copian tal cual a la línea de salida (B.4). */
  nombre?: string | null;
  platoId?: string | null;
}

export interface EntradaCobro {
  flujo: Flujo;
  /** Solo MESA. */
  modoMesa: ModoMesa | null;
  momentoCobro: MomentoCobro;
  /** P. */
  precioAlmuerzo: number;
  /** R, por unidad. */
  recargoLlevar: number;
  paraLlevarCabecera: boolean;
  /** Una sola fuera de MESA. */
  personas: PersonaCobro[];
  items: ItemCobro[];
}

export interface OpcionesCotizar {
  /** true (por defecto) en los flujos del comensal; false cuando la cotización sale de `aplicar` (B.1). */
  estimada?: boolean;
}

/**
 * Refs de las líneas de salida (B.3 paso 6; los usa la clave por línea de F.3):
 * - Cada unidad cubierta por el plan es su propia línea PLAN, de cantidad 1, con ref `<ref>#<k>` (k = 1, 2, …, en
 *   orden de descuento), aunque la línea de entrada tenga cantidad 1.
 * - Todas las demás líneas (CAJA, incluido el resto no cubierto de un almuerzo, OFERTA y omitidas) conservan el ref de
 *   entrada sin sufijo y su cantidad.
 * Por eso el ref de entrada no puede contener `#`: así los refs de salida son únicos.
 */
export const SEPARADOR_UNIDAD = '#';
export const refUnidadPlan = (ref: string, k: number) => `${ref}${SEPARADOR_UNIDAD}${k}`;

export interface LineaCotizada {
  /** Ver `SEPARADOR_UNIDAD`. */
  ref: string;
  personaRef: string;
  pagadorRef: string;
  tipo: TipoItem;
  nombre: string | null;
  platoId: string | null;
  ofertaId: string | null;
  cantidad: number;
  paraLlevar: boolean;
  precioUnitarioCentavos: number;
  subtotalCentavos: number;
  recargoUnitarioCentavos: number;
  recargoCentavos: number;
  fuente: Fuente;
  pagador: Pagador;
  cubiertoPorPlanCentavos: number;
  porCobrarCentavos: number;
  omitida: MotivoOmision | null;
}

export interface TotalPagador {
  pagadorRef: string;
  subtotal: number;
  recargo: number;
  total: number;
  cubierto: number;
  saldo: number;
}

export interface UnidadPlan {
  personaRef: string;
  pagadorRef: string;
}

export interface Aviso {
  codigo: CodigoAviso;
  /** Ref de la línea de entrada (sin sufijo `#k`). */
  lineaRef: string | null;
}

export interface Cotizacion {
  estimada: boolean;
  lineas: LineaCotizada[];
  porPagador: TotalPagador[];
  subtotalCentavos: number;
  recargoCentavos: number;
  totalCentavos: number;
  cubiertoPorPlanCentavos: number;
  saldoPorCobrarCentavos: number;
  /** Lo que `aplicar` descuenta, una entrada por almuerzo, en orden. */
  unidadesPlan: UnidadPlan[];
  avisos: Aviso[];
}

export type CodigoErrorCotizar =
  | 'ENTRADA_INVALIDA'
  | 'PERSONAS_INVALIDAS'
  | 'MODO_MESA_INVALIDO'
  | 'PERSONA_DESCONOCIDA'
  | 'LINEA_REPETIDA'
  | 'CANTIDAD_INVALIDA'
  | 'PRECIO_INVALIDO'
  | 'PRECIO_ALMUERZO_INCONSISTENTE'
  | 'PARA_LLEVAR_FUERA_DE_POS'
  | 'LIBRE_FUERA_DE_POS'
  | 'DISPONIBLE_FUERA_DE_MESA'
  | 'OFERTA_SIN_ID'
  | 'OFERTA_ID_INESPERADO'
  | 'CATEGORIA_BASE_INVALIDA'
  | 'MONTO_NO_SEGURO'
  | 'ALMUERZO_SIN_PRECIO';

/** Entrada que `cotizar` rechaza. `ALMUERZO_SIN_PRECIO` es de negocio (409, I-12); el resto, errores del llamador. */
export class CotizarError extends Error {
  constructor(
    readonly code: CodigoErrorCotizar,
    detail: string,
    readonly lineaRef: string | null = null,
  ) {
    super(detail);
    this.name = 'CotizarError';
  }
}
