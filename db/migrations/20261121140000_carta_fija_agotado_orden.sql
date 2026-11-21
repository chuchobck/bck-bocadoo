-- migrate:up
-- Carta fija (A_LA_CARTA, EXTRA, BEBIDA): agotado por plato y orden de aparición.
-- `agotado_en` es la hora en que se marcó agotado. El plato cuenta como agotado solo durante la fecha local (zona del
-- local) en que se marcó: a medianoche vuelve solo, sin job. Quitar la marca = NULL.
ALTER TABLE plato ADD COLUMN IF NOT EXISTS agotado_en TIMESTAMPTZ;
ALTER TABLE plato ADD COLUMN IF NOT EXISTS orden SMALLINT NOT NULL DEFAULT 0;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_plato_orden') THEN
        ALTER TABLE plato ADD CONSTRAINT ck_plato_orden CHECK (orden BETWEEN 0 AND 1000);
    END IF;
END $$;

-- migrate:down
ALTER TABLE plato DROP CONSTRAINT IF EXISTS ck_plato_orden;
ALTER TABLE plato DROP COLUMN IF EXISTS orden;
ALTER TABLE plato DROP COLUMN IF EXISTS agotado_en;
