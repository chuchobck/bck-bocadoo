/** Categorías de la carta fija: platos que se piden sueltos, con precio propio, sin depender del menú del día. */
export const CATEGORIAS_CARTA = ['A_LA_CARTA', 'EXTRA', 'BEBIDA'] as const;

/**
 * SQL: el plato está agotado HOY. `agotado_en` guarda la hora en que se marcó y solo vale durante esa fecha local
 * (zona horaria del local): a medianoche el plato vuelve solo. `p` es el alias de `plato`, `r` el de `restaurante`.
 */
export const platoAgotadoSql = (p: string, r: string) =>
  `(${p}.agotado_en IS NOT NULL AND (${p}.agotado_en AT TIME ZONE ${r}.zona_horaria)::date = (CURRENT_TIMESTAMP AT TIME ZONE ${r}.zona_horaria)::date)`;
