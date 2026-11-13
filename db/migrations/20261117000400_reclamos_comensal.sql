-- migrate:up
-- Fase 8: el comensal reclama por un almuerzo propio ("me descontaron y no almorcé"), hasta 7 días después.

ALTER TABLE reclamo ADD COLUMN clave_idempotencia UUID;

-- Antes bastaba con que cliente_id fuera del comensal: podía reclamar por el almuerzo de otra persona del mismo local
-- (y, si el dueño aceptaba, devolverlo a un plan ajeno) o crear el reclamo ya resuelto. Ahora la base exige lo mismo
-- que la API: almuerzo propio, no revertido, de los últimos 7 días, y el reclamo nace PENDIENTE y sin respuesta.
DROP POLICY comensal_crea ON reclamo;
CREATE POLICY comensal_crea ON reclamo FOR INSERT TO bocadoo_app
    WITH CHECK (
        cliente_id IN (SELECT c.cliente_id FROM cliente_restaurante c WHERE c.usuario_id = app_user_id())
        AND estado = 'PENDIENTE' AND respuesta IS NULL AND resuelto_en IS NULL AND resuelto_por_personal_id IS NULL
        AND EXISTS (SELECT 1 FROM consumo_almuerzo k
                     WHERE k.consumo_id = reclamo.consumo_id AND k.cliente_id = reclamo.cliente_id
                       AND k.restaurante_id = reclamo.restaurante_id AND k.cantidad = 1
                       AND k.creado_en > CURRENT_TIMESTAMP - interval '7 days'
                       AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = k.consumo_id)));

-- migrate:down
DROP POLICY comensal_crea ON reclamo;
CREATE POLICY comensal_crea ON reclamo FOR INSERT TO bocadoo_app
    WITH CHECK (cliente_id IN (SELECT c.cliente_id FROM cliente_restaurante c WHERE c.usuario_id = app_user_id()));
ALTER TABLE reclamo DROP COLUMN clave_idempotencia;
