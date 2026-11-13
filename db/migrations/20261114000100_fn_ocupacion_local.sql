-- migrate:up
-- Ocupación de un local para la vitrina pública. Los consumos y ventas son privados por tenant (RLS), pero
-- la vitrina debe mostrar un nivel agregado: esta función SECURITY DEFINER devuelve SOLO conteos, nunca filas.
-- Personas = consumos netos (cantidad +1/-1) + ventas POS netas de los últimos 25 minutos.
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

-- migrate:down
DROP FUNCTION IF EXISTS fn_ocupacion_local(BIGINT);
