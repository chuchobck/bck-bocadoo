-- migrate:up
-- Estado manual "Concurrido" (nivel intermedio entre Libre y Lleno). Igual que "Local lleno", expira solo a los 20 min.
ALTER TABLE restaurante ADD COLUMN concurrido_manual_hasta TIMESTAMPTZ;
COMMENT ON COLUMN restaurante.concurrido_manual_hasta IS 'Interruptor manual "Concurrido" (expira solo a los 20 min); excluyente con lleno_manual_hasta';

-- Cambia el tipo de retorno (columna nueva al final), por eso hay que recrearla. Sigue devolviendo solo conteos y banderas.
DROP FUNCTION fn_ocupacion_local(BIGINT);
CREATE FUNCTION fn_ocupacion_local(p_restaurante_id BIGINT)
RETURNS TABLE (personas INTEGER, puestos INTEGER, lleno_manual BOOLEAN, concurrido_manual BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT GREATEST(0,
               COALESCE((SELECT sum(c.cantidad) FROM consumo_almuerzo c
                          WHERE c.restaurante_id = r.restaurante_id AND c.creado_en > CURRENT_TIMESTAMP - interval '25 minutes'), 0)
             + COALESCE((SELECT sum(CASE WHEN v.total_centavos > 0 THEN 1 ELSE -1 END) FROM venta_pos_cabecera v
                          WHERE v.restaurante_id = r.restaurante_id AND v.creado_en > CURRENT_TIMESTAMP - interval '25 minutes'), 0))::INTEGER,
           r.puestos,
           COALESCE(r.lleno_manual_hasta > CURRENT_TIMESTAMP, false),
           COALESCE(r.concurrido_manual_hasta > CURRENT_TIMESTAMP, false)
      FROM restaurante r
     WHERE r.restaurante_id = p_restaurante_id AND r.estado = 'ACTIVO'
$$;
REVOKE EXECUTE ON FUNCTION fn_ocupacion_local(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_ocupacion_local(BIGINT) TO bocadoo_app, bocadoo_servicio;

-- migrate:down
DROP FUNCTION fn_ocupacion_local(BIGINT);
CREATE FUNCTION fn_ocupacion_local(p_restaurante_id BIGINT)
RETURNS TABLE (personas INTEGER, puestos INTEGER, lleno_manual BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT GREATEST(0,
               COALESCE((SELECT sum(c.cantidad) FROM consumo_almuerzo c
                          WHERE c.restaurante_id = r.restaurante_id AND c.creado_en > CURRENT_TIMESTAMP - interval '25 minutes'), 0)
             + COALESCE((SELECT sum(CASE WHEN v.total_centavos > 0 THEN 1 ELSE -1 END) FROM venta_pos_cabecera v
                          WHERE v.restaurante_id = r.restaurante_id AND v.creado_en > CURRENT_TIMESTAMP - interval '25 minutes'), 0))::INTEGER,
           r.puestos,
           COALESCE(r.lleno_manual_hasta > CURRENT_TIMESTAMP, false)
      FROM restaurante r
     WHERE r.restaurante_id = p_restaurante_id AND r.estado = 'ACTIVO'
$$;
REVOKE EXECUTE ON FUNCTION fn_ocupacion_local(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_ocupacion_local(BIGINT) TO bocadoo_app, bocadoo_servicio;
ALTER TABLE restaurante DROP COLUMN concurrido_manual_hasta;
