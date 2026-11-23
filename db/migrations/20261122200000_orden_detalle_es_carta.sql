-- migrate:up
-- Entrega D, PR 7a (carta en pedidos): un renglón de orden_detalle sin sección puede ser un extra del menú del día o un
-- plato de la carta fija (`cartaItems`). Los dos llevan precio y no tienen sección: esta marca los distingue para que
-- `extras` siga igual y `cartaItems` salga aparte. Aditiva: NOT NULL con default false, así todo lo histórico queda como
-- extra (no se reescribe nada). Sin políticas nuevas: cae bajo las de orden_detalle; el GRANT por tabla ya cubre la columna.
ALTER TABLE orden_detalle ADD COLUMN IF NOT EXISTS es_carta BOOLEAN NOT NULL DEFAULT false;

-- migrate:down
ALTER TABLE orden_detalle DROP COLUMN IF EXISTS es_carta;
