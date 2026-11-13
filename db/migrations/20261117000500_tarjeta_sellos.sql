-- migrate:up
-- Fase 8: tarjeta de sellos. Cada almuerzo validado (consumo +1) suma un sello si el local tiene la tarjeta activa
-- (cuenta = ALMUERZO). Al llegar a la meta, los sellos se convierten en un premio disponible y la cuenta vuelve a
-- empezar. Un almuerzo devuelto (consumo -1) quita su sello; si ese sello había completado un premio aún no canjeado,
-- se deshace el premio. movimiento_sello es el libro (solo inserción):
--   GANADO +1 · AJUSTE -1 (almuerzo devuelto) · PREMIO_CANJEADO -1 (en ese tipo, `sellos` cuenta premios).

ALTER TABLE movimiento_sello ADD COLUMN clave_idempotencia UUID;
CREATE UNIQUE INDEX uq_movimiento_sello_clave ON movimiento_sello (restaurante_id, clave_idempotencia) WHERE clave_idempotencia IS NOT NULL;
CREATE UNIQUE INDEX uq_movimiento_sello_ganado ON movimiento_sello (consumo_id) WHERE tipo = 'GANADO';

CREATE FUNCTION fn_sellos_por_consumo() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_cfg    tarjeta_sellos_config%ROWTYPE;
    v_card   tarjeta_sellos_cliente%ROWTYPE;
BEGIN
    IF NEW.cantidad = 1 THEN
        SELECT c.* INTO v_cfg FROM tarjeta_sellos_config c
         WHERE c.restaurante_id = NEW.restaurante_id AND c.activa AND c.cuenta = 'ALMUERZO';
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
        INSERT INTO tarjeta_sellos_cliente (restaurante_id, cliente_id) VALUES (NEW.restaurante_id, NEW.cliente_id)
        ON CONFLICT DO NOTHING;
        SELECT t.* INTO v_card FROM tarjeta_sellos_cliente t
         WHERE t.restaurante_id = NEW.restaurante_id AND t.cliente_id = NEW.cliente_id FOR UPDATE;
        INSERT INTO movimiento_sello (restaurante_id, cliente_id, tipo, sellos, consumo_id, motivo)
        VALUES (NEW.restaurante_id, NEW.cliente_id, 'GANADO', 1, NEW.consumo_id, 'Almuerzo validado');
        v_card.sellos := v_card.sellos + 1;
        IF v_card.sellos >= v_cfg.meta THEN
            v_card.sellos := v_card.sellos - v_cfg.meta;
            v_card.premios_disponibles := v_card.premios_disponibles + 1;
        END IF;
    ELSE
        -- Reverso: solo si el almuerzo original ganó un sello.
        IF NOT EXISTS (SELECT 1 FROM movimiento_sello m WHERE m.consumo_id = NEW.revierte_a_consumo_id AND m.tipo = 'GANADO') THEN
            RETURN NULL;
        END IF;
        SELECT t.* INTO v_card FROM tarjeta_sellos_cliente t
         WHERE t.restaurante_id = NEW.restaurante_id AND t.cliente_id = NEW.cliente_id FOR UPDATE;
        IF v_card.sellos > 0 THEN
            v_card.sellos := v_card.sellos - 1;
        ELSIF v_card.premios_disponibles > 0 THEN
            SELECT c.* INTO v_cfg FROM tarjeta_sellos_config c WHERE c.restaurante_id = NEW.restaurante_id;
            v_card.premios_disponibles := v_card.premios_disponibles - 1;
            v_card.sellos := GREATEST(v_cfg.meta - 1, 0);
        ELSE
            RETURN NULL;   -- el premio que completó ya se canjeó: no hay nada que quitar
        END IF;
        INSERT INTO movimiento_sello (restaurante_id, cliente_id, tipo, sellos, consumo_id, motivo)
        VALUES (NEW.restaurante_id, NEW.cliente_id, 'AJUSTE', -1, NEW.consumo_id, 'Almuerzo devuelto al plan');
    END IF;
    UPDATE tarjeta_sellos_cliente t SET sellos = v_card.sellos, premios_disponibles = v_card.premios_disponibles
     WHERE t.restaurante_id = NEW.restaurante_id AND t.cliente_id = NEW.cliente_id;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_sellos_por_consumo AFTER INSERT ON consumo_almuerzo
FOR EACH ROW EXECUTE FUNCTION fn_sellos_por_consumo();

-- migrate:down
DROP TRIGGER trg_sellos_por_consumo ON consumo_almuerzo;
DROP FUNCTION fn_sellos_por_consumo();
DROP INDEX uq_movimiento_sello_ganado;
DROP INDEX uq_movimiento_sello_clave;
ALTER TABLE movimiento_sello DROP COLUMN clave_idempotencia;
