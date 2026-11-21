-- migrate:up
-- Un local que nunca indicó sus puestos (puestos_definidos = false) tiene el 20 por defecto, que no sirve de referencia:
-- el CHECK solo compara puestos con mesas_total cuando el dueño ya definió los puestos.
ALTER TABLE restaurante DROP CONSTRAINT IF EXISTS ck_restaurante_puestos_mesas;
ALTER TABLE restaurante
    ADD CONSTRAINT ck_restaurante_puestos_mesas CHECK (mesas_total IS NULL OR NOT puestos_definidos OR puestos >= mesas_total);

-- migrate:down
ALTER TABLE restaurante DROP CONSTRAINT IF EXISTS ck_restaurante_puestos_mesas;
ALTER TABLE restaurante
    ADD CONSTRAINT ck_restaurante_puestos_mesas CHECK (mesas_total IS NULL OR puestos >= mesas_total);
