-- migrate:up
-- Hora de llegada opcional del pedido del comensal (POST /v1/mis/pedidos, `horaLlegada`): la app ya la envía.
-- Aditiva: nullable, sin default ni backfill; los pedidos de antes y los que no la mandan quedan en NULL. La API valida
-- la ventana (5 min atrás a 12 h adelante, como las mesas). Sin políticas nuevas: cae bajo las de orden_cabecera, y el
-- GRANT por tabla de bocadoo_app ya cubre la columna.
ALTER TABLE orden_cabecera ADD COLUMN IF NOT EXISTS hora_llegada TIMESTAMPTZ;

-- migrate:down
ALTER TABLE orden_cabecera DROP COLUMN IF EXISTS hora_llegada;
