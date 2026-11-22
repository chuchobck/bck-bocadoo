-- migrate:up
-- Entrega D, PR 4 (docs/spec-cobros.md F.2): snapshot del precio del almuerzo y ofertas en pedidos, recargo por unidad
-- en el detalle y canjes de oferta hechos dentro de una cuenta. Todo nullable o con default: el código de hoy no las
-- escribe ni las lee y sigue funcionando igual. Sin políticas nuevas: caen bajo las de orden_* y canje_oferta_flash.

-- 1) Pedido: P al pedir (INC-06) y la oferta aplicada al almuerzo. total_centavos conserva su significado (por cobrar).
ALTER TABLE orden_cabecera ADD COLUMN IF NOT EXISTS precio_almuerzo_centavos BIGINT;
ALTER TABLE orden_cabecera ADD COLUMN IF NOT EXISTS almuerzo_oferta_flash_id BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orden_cabecera'::regclass
                    AND conname = 'ck_orden_precio_almuerzo') THEN
        ALTER TABLE orden_cabecera ADD CONSTRAINT ck_orden_precio_almuerzo
            CHECK (precio_almuerzo_centavos IS NULL OR precio_almuerzo_centavos >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orden_cabecera'::regclass
                    AND conname = 'fk_orden_almuerzo_oferta') THEN
        ALTER TABLE orden_cabecera ADD CONSTRAINT fk_orden_almuerzo_oferta FOREIGN KEY (restaurante_id, almuerzo_oferta_flash_id)
            REFERENCES oferta_flash(restaurante_id, oferta_flash_id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_orden_almuerzo_oferta ON orden_cabecera (almuerzo_oferta_flash_id)
    WHERE almuerzo_oferta_flash_id IS NOT NULL;

-- 2) Detalle: oferta como ítem y recargo por unidad (las filas viejas quedan en 0).
ALTER TABLE orden_detalle ADD COLUMN IF NOT EXISTS oferta_flash_id BIGINT;
ALTER TABLE orden_detalle ADD COLUMN IF NOT EXISTS recargo_unitario_centavos BIGINT NOT NULL DEFAULT 0;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orden_detalle'::regclass
                    AND conname = 'ck_orden_detalle_recargo_unitario') THEN
        ALTER TABLE orden_detalle ADD CONSTRAINT ck_orden_detalle_recargo_unitario CHECK (recargo_unitario_centavos >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orden_detalle'::regclass
                    AND conname = 'fk_orden_detalle_oferta') THEN
        ALTER TABLE orden_detalle ADD CONSTRAINT fk_orden_detalle_oferta FOREIGN KEY (restaurante_id, oferta_flash_id)
            REFERENCES oferta_flash(restaurante_id, oferta_flash_id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_orden_detalle_oferta ON orden_detalle (oferta_flash_id) WHERE oferta_flash_id IS NOT NULL;

-- 3) Canje dentro de una cuenta: su pago es el de la cuenta, no uno propio.
ALTER TABLE canje_oferta_flash ADD COLUMN IF NOT EXISTS cuenta_cobro_id BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.canje_oferta_flash'::regclass
                    AND conname = 'fk_canje_cuenta_cobro') THEN
        ALTER TABLE canje_oferta_flash ADD CONSTRAINT fk_canje_cuenta_cobro FOREIGN KEY (restaurante_id, cuenta_cobro_id)
            REFERENCES cuenta_cobro(restaurante_id, cuenta_id) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_canje_cuenta_cobro ON canje_oferta_flash (cuenta_cobro_id) WHERE cuenta_cobro_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS idx_canje_cuenta_cobro;
ALTER TABLE canje_oferta_flash DROP CONSTRAINT IF EXISTS fk_canje_cuenta_cobro;
ALTER TABLE canje_oferta_flash DROP COLUMN IF EXISTS cuenta_cobro_id;
DROP INDEX IF EXISTS idx_orden_detalle_oferta;
ALTER TABLE orden_detalle DROP CONSTRAINT IF EXISTS fk_orden_detalle_oferta;
ALTER TABLE orden_detalle DROP CONSTRAINT IF EXISTS ck_orden_detalle_recargo_unitario;
ALTER TABLE orden_detalle DROP COLUMN IF EXISTS recargo_unitario_centavos;
ALTER TABLE orden_detalle DROP COLUMN IF EXISTS oferta_flash_id;
DROP INDEX IF EXISTS idx_orden_almuerzo_oferta;
ALTER TABLE orden_cabecera DROP CONSTRAINT IF EXISTS fk_orden_almuerzo_oferta;
ALTER TABLE orden_cabecera DROP CONSTRAINT IF EXISTS ck_orden_precio_almuerzo;
ALTER TABLE orden_cabecera DROP COLUMN IF EXISTS almuerzo_oferta_flash_id;
ALTER TABLE orden_cabecera DROP COLUMN IF EXISTS precio_almuerzo_centavos;
