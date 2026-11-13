-- migrate:up
-- Fase 8: preórdenes del comensal.

-- 1) El comensal elige platos del menú de hoy: hacia afuera solo public_id, así que el plato necesita uno.
ALTER TABLE plato ADD COLUMN public_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE plato ADD CONSTRAINT uq_plato_public_id UNIQUE (public_id);

-- 2) Idempotency-Key del comensal al crear el pedido: reintentar no crea dos pedidos.
ALTER TABLE orden_cabecera ADD COLUMN clave_idempotencia UUID;
CREATE UNIQUE INDEX uq_orden_usuario_clave ON orden_cabecera (usuario_id, clave_idempotencia) WHERE clave_idempotencia IS NOT NULL;

-- 3) "Pedido #N" del día. El comensal no ve los pedidos de otros (RLS), así que no puede calcular max + 1:
--    esta función lo hace por él y devuelve SOLO el número. El bloqueo consultivo dura hasta el fin de la
--    transacción que inserta el pedido, así dos pedidos simultáneos no toman el mismo número.
CREATE FUNCTION fn_siguiente_numero_orden(p_restaurante_id BIGINT, p_fecha DATE) RETURNS INTEGER
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Se necesita un usuario en la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('orden_numero:' || p_restaurante_id || ':' || p_fecha, 0));
    RETURN COALESCE((SELECT max(o.numero_dia) FROM orden_cabecera o
                      WHERE o.restaurante_id = p_restaurante_id AND o.fecha_local = p_fecha), 0) + 1;
END $$;
REVOKE EXECUTE ON FUNCTION fn_siguiente_numero_orden(BIGINT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_siguiente_numero_orden(BIGINT, DATE) TO bocadoo_app, bocadoo_servicio;

-- 4) Políticas del comensal más estrictas: el pedido nace EN_CAMINO y, si lleva ficha de cliente, es la suya
--    (si no, la caja descontaría el almuerzo de otra persona). Los renglones solo van a un pedido propio EN_CAMINO.
DROP POLICY comensal_crea ON orden_cabecera;
CREATE POLICY comensal_crea ON orden_cabecera FOR INSERT TO bocadoo_app
    WITH CHECK (usuario_id = app_user_id() AND estado = 'EN_CAMINO'
                AND (cliente_id IS NULL
                     OR cliente_id IN (SELECT c.cliente_id FROM cliente_restaurante c WHERE c.usuario_id = app_user_id())));
DROP POLICY comensal_crea ON orden_detalle;
CREATE POLICY comensal_crea ON orden_detalle FOR INSERT TO bocadoo_app
    WITH CHECK (orden_id IN (SELECT o.orden_id FROM orden_cabecera o WHERE o.usuario_id = app_user_id() AND o.estado = 'EN_CAMINO'));

-- migrate:down
DROP POLICY comensal_crea ON orden_detalle;
CREATE POLICY comensal_crea ON orden_detalle FOR INSERT TO bocadoo_app
    WITH CHECK (orden_id IN (SELECT o.orden_id FROM orden_cabecera o WHERE o.usuario_id = app_user_id()));
DROP POLICY comensal_crea ON orden_cabecera;
CREATE POLICY comensal_crea ON orden_cabecera FOR INSERT TO bocadoo_app WITH CHECK (usuario_id = app_user_id());
DROP FUNCTION fn_siguiente_numero_orden(BIGINT, DATE);
DROP INDEX uq_orden_usuario_clave;
ALTER TABLE orden_cabecera DROP COLUMN clave_idempotencia;
ALTER TABLE plato DROP CONSTRAINT uq_plato_public_id;
ALTER TABLE plato DROP COLUMN public_id;
