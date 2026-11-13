-- migrate:up
-- Fase 9: el job mensual corre con bck_servicio, que no es dueño de las tablas particionadas y por eso no podía crear
-- sus particiones ("permission denied for schema public"). La función pasa a SECURITY DEFINER (corre como el dueño de
-- las tablas) y mantiene su lista cerrada de tablas, así que no sirve para crear tablas arbitrarias. Solo el rol de
-- servicio puede ejecutarla.
CREATE OR REPLACE FUNCTION fn_crear_particion_mensual(p_tabla TEXT, p_mes DATE) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_desde DATE := date_trunc('month', p_mes)::DATE;
    v_hasta DATE := (date_trunc('month', p_mes) + INTERVAL '1 month')::DATE;
BEGIN
    IF p_tabla NOT IN ('log_actividad', 'evento_analitica') THEN
        RAISE EXCEPTION 'Tabla no particionada: %', p_tabla;
    END IF;
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                   p_tabla || '_' || to_char(v_desde, 'YYYY_MM'), p_tabla, v_desde, v_hasta);
END $$;
REVOKE EXECUTE ON FUNCTION fn_crear_particion_mensual(TEXT, DATE) FROM PUBLIC, bocadoo_app;
GRANT EXECUTE ON FUNCTION fn_crear_particion_mensual(TEXT, DATE) TO bocadoo_servicio;

-- migrate:down
CREATE OR REPLACE FUNCTION fn_crear_particion_mensual(p_tabla TEXT, p_mes DATE) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_desde DATE := date_trunc('month', p_mes)::DATE;
    v_hasta DATE := (date_trunc('month', p_mes) + INTERVAL '1 month')::DATE;
BEGIN
    IF p_tabla NOT IN ('log_actividad', 'evento_analitica') THEN
        RAISE EXCEPTION 'Tabla no particionada: %', p_tabla;
    END IF;
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                   p_tabla || '_' || to_char(v_desde, 'YYYY_MM'), p_tabla, v_desde, v_hasta);
END $$;
