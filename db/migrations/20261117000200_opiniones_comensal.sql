-- migrate:up
-- Fase 8: "¿Qué tal hoy?". El comensal opina (o descarta la tarjeta) una vez por almuerzo propio, desde 25 minutos
-- después de validarlo y hasta 24 horas después.

ALTER TABLE opinion ADD COLUMN clave_idempotencia UUID;

-- Antes bastaba con que cliente_id fuera del comensal: podía opinar sobre el almuerzo de otra persona del mismo local,
-- fuera de la ventana de tiempo, o escribir de antemano la "respuesta del restaurante". Ahora la base exige lo mismo
-- que la API: almuerzo propio, no revertido, en la ventana, y sin respuesta.
DROP POLICY comensal_crea ON opinion;
CREATE POLICY comensal_crea ON opinion FOR INSERT TO bocadoo_app
    WITH CHECK (
        cliente_id IN (SELECT c.cliente_id FROM cliente_restaurante c WHERE c.usuario_id = app_user_id())
        AND respuesta_restaurante IS NULL AND respondido_en IS NULL AND respondido_por_personal_id IS NULL
        AND EXISTS (SELECT 1 FROM consumo_almuerzo k
                     WHERE k.consumo_id = opinion.consumo_id AND k.cliente_id = opinion.cliente_id
                       AND k.restaurante_id = opinion.restaurante_id AND k.cantidad = 1
                       AND k.creado_en <= CURRENT_TIMESTAMP - interval '25 minutes'
                       AND k.creado_en >  CURRENT_TIMESTAMP - interval '24 hours'
                       AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = k.consumo_id)));

-- migrate:down
DROP POLICY comensal_crea ON opinion;
CREATE POLICY comensal_crea ON opinion FOR INSERT TO bocadoo_app
    WITH CHECK (cliente_id IN (SELECT c.cliente_id FROM cliente_restaurante c WHERE c.usuario_id = app_user_id()));
ALTER TABLE opinion DROP COLUMN clave_idempotencia;
