-- migrate:up
-- fn_descontar_almuerzo mira primero el plan del cliente y después el límite SaaS del local (entrega D, PR 6c).
-- Antes, un local suspendido o en su tope respondía LIMITE_SAAS también a quien no tenía plan, y la caja omitía su
-- almuerzo (I-10) en vez de cobrarlo a precio suelto. El límite SaaS frena el descuento de un plan, no el cobro de un
-- almuerzo suelto. Todo lo demás es idéntico (20261116000000_descontar_almuerzo_mesa.sql): misma firma, mismas
-- columnas de salida, mismo contador de escaneos (solo sube al descontar). CREATE OR REPLACE conserva el dueño, los
-- GRANT (bocadoo_app, bocadoo_servicio), SECURITY DEFINER y el search_path.
-- Candados: el de la ficha (cliente_restaurante) sigue primero; luego el plan y, solo si hay plan, la fila SaaS del
-- local. Quien no tiene plan ya no bloquea la fila SaaS.
CREATE OR REPLACE FUNCTION fn_descontar_almuerzo(
    p_restaurante_id BIGINT,
    p_cliente_id     BIGINT,
    p_personal_id    BIGINT,
    p_clave_idempotencia UUID,
    p_canal          canal_consumo_enum DEFAULT 'QR',
    p_para_llevar    BOOLEAN DEFAULT false,
    p_orden_id       BIGINT DEFAULT NULL,
    p_mesa_compartida_id BIGINT DEFAULT NULL,
    p_mesa_local_id  BIGINT DEFAULT NULL,
    p_omitir_duplicado BOOLEAN DEFAULT false   -- mesa "invito yo": el anfitrión paga varios almuerzos seguidos
) RETURNS TABLE (resultado resultado_escaneo_enum, consumo_id BIGINT, suscripcion_id BIGINT,
                 almuerzos_restantes_total INTEGER, dias_para_vencer INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tz        TEXT;
    v_hoy       DATE;
    v_sus       suscripcion_plan%ROWTYPE;
    v_saas      suscripcion_saas_restaurante%ROWTYPE;
    v_limite    INTEGER;
    v_consumo   BIGINT;
    v_resultado resultado_escaneo_enum;
    v_total     INTEGER := 0;
    v_dias      INTEGER;
    v_usuario   BIGINT;
BEGIN
    -- La función corre con privilegios del dueño (salta RLS): valida ella misma el tenant.
    -- Sin tenant en la sesión (p. ej. un comensal) no se puede descontar nada.
    IF app_tenant_id() IS DISTINCT FROM p_restaurante_id THEN
        RAISE EXCEPTION 'Restaurante fuera del tenant de la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT r.zona_horaria INTO v_tz FROM restaurante r WHERE r.restaurante_id = p_restaurante_id;
    IF v_tz IS NULL THEN
        RAISE EXCEPTION 'Restaurante % no existe', p_restaurante_id;
    END IF;
    v_hoy := (CURRENT_TIMESTAMP AT TIME ZONE v_tz)::DATE;

    -- Serializa las validaciones del mismo cliente (dos cajas escaneando a la vez).
    SELECT c.usuario_id INTO v_usuario FROM cliente_restaurante c
     WHERE c.restaurante_id = p_restaurante_id AND c.cliente_id = p_cliente_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cliente % no pertenece al restaurante %', p_cliente_id, p_restaurante_id;
    END IF;

    -- 1) Reintento de la misma petición (red inestable): misma respuesta, sin descontar otra vez.
    SELECT c.consumo_id, c.suscripcion_id INTO v_consumo, v_sus.suscripcion_id
      FROM consumo_almuerzo c
     WHERE c.restaurante_id = p_restaurante_id AND c.clave_idempotencia = p_clave_idempotencia;
    IF FOUND THEN
        v_resultado := 'OK';
    -- 2) Doble escaneo del mismo comensal en menos de 60 s.
    ELSIF NOT p_omitir_duplicado AND EXISTS (SELECT 1 FROM consumo_almuerzo c
                   WHERE c.restaurante_id = p_restaurante_id AND c.cliente_id = p_cliente_id
                     AND c.cantidad = 1 AND c.creado_en > CURRENT_TIMESTAMP - INTERVAL '60 seconds'
                     AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = c.consumo_id)) THEN
        v_resultado := 'DUPLICADO';
    ELSE
        -- 3) FIFO: el plan vigente que vence primero y vale hoy. Va antes que el límite SaaS (PR 6c): quien no tiene
        --    un plan que descontar hoy recibe la razón real (SIN_PLAN, SIN_SALDO, VENCIDO, DIA_NO_VALIDO) y la caja le
        --    cobra el almuerzo suelto; el límite solo frena el descuento de un plan.
        SELECT s.* INTO v_sus FROM suscripcion_plan s
         WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id
           AND s.estado = 'ACTIVA' AND s.vence_el >= v_hoy
           AND EXTRACT(ISODOW FROM v_hoy)::SMALLINT = ANY (s.dias_validos)
         ORDER BY s.vence_el, s.suscripcion_id
         LIMIT 1 FOR UPDATE;

        IF NOT FOUND THEN
            v_resultado := CASE
                WHEN EXISTS (SELECT 1 FROM suscripcion_plan s WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id
                                AND s.estado = 'ACTIVA' AND s.vence_el >= v_hoy) THEN 'DIA_NO_VALIDO'
                WHEN EXISTS (SELECT 1 FROM suscripcion_plan s WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id
                                AND s.almuerzos_restantes > 0 AND s.estado IN ('ACTIVA', 'VENCIDA') AND s.vence_el < v_hoy) THEN 'VENCIDO'
                WHEN EXISTS (SELECT 1 FROM suscripcion_plan s WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id) THEN 'SIN_SALDO'
                ELSE 'SIN_PLAN' END::resultado_escaneo_enum;
        ELSE
            -- 4) Límite del plan SaaS del restaurante (tier gratuito): solo si hay un plan que descontar.
            SELECT s.* INTO v_saas FROM suscripcion_saas_restaurante s
             WHERE s.restaurante_id = p_restaurante_id AND s.vigente FOR UPDATE;
            IF FOUND THEN
                SELECT p.limite_escaneos_mes INTO v_limite FROM catalogo_plan_saas p WHERE p.plan_saas_id = v_saas.plan_saas_id;
            END IF;

            IF (v_saas.suscripcion_saas_id IS NOT NULL AND v_saas.estado = 'SUSPENDIDA')
               OR (v_limite IS NOT NULL AND v_saas.escaneos_usados_ciclo_actual >= v_limite) THEN
                v_resultado := 'LIMITE_SAAS';
                v_sus := NULL;   -- como antes: LIMITE_SAAS no devuelve plan
            ELSE
                UPDATE suscripcion_plan s
                   SET almuerzos_restantes = s.almuerzos_restantes - 1,
                       estado = CASE WHEN s.almuerzos_restantes - 1 = 0 THEN 'AGOTADA' ELSE s.estado END
                 WHERE s.suscripcion_id = v_sus.suscripcion_id;

                INSERT INTO consumo_almuerzo (restaurante_id, suscripcion_id, cliente_id, personal_id, canal, para_llevar,
                                              orden_id, mesa_compartida_id, mesa_local_id, valor_unitario_centavos,
                                              clave_idempotencia, fecha_local)
                VALUES (p_restaurante_id, v_sus.suscripcion_id, p_cliente_id, p_personal_id, p_canal, p_para_llevar,
                        p_orden_id, p_mesa_compartida_id, p_mesa_local_id, v_sus.precio_unitario_centavos,
                        p_clave_idempotencia, v_hoy)
                RETURNING consumo_almuerzo.consumo_id INTO v_consumo;

                IF v_saas.suscripcion_saas_id IS NOT NULL THEN
                    UPDATE suscripcion_saas_restaurante s
                       SET escaneos_usados_ciclo_actual = s.escaneos_usados_ciclo_actual + 1
                     WHERE s.suscripcion_saas_id = v_saas.suscripcion_saas_id;
                END IF;
                v_resultado := 'OK';
            END IF;
        END IF;
    END IF;

    -- Saldo total vigente del cliente después de la operación.
    SELECT COALESCE(SUM(s.almuerzos_restantes), 0)::INTEGER INTO v_total FROM suscripcion_plan s
     WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id
       AND s.estado = 'ACTIVA' AND s.vence_el >= v_hoy;

    IF v_resultado = 'OK' AND v_sus.vence_el IS NOT NULL THEN
        v_dias := v_sus.vence_el - v_hoy;
        IF v_total = 0 OR v_dias <= 3 THEN
            v_resultado := 'OK_ADVERTENCIA';
        END IF;
    END IF;

    INSERT INTO intento_escaneo (restaurante_id, personal_id, cliente_id, usuario_id, canal, resultado, consumo_id)
    VALUES (p_restaurante_id, p_personal_id, p_cliente_id, v_usuario, p_canal, v_resultado,
            CASE WHEN v_resultado IN ('OK', 'OK_ADVERTENCIA') THEN v_consumo END);

    RETURN QUERY SELECT v_resultado, v_consumo, v_sus.suscripcion_id, v_total, v_dias;
END $$;

-- migrate:down
-- El cuerpo de 20261116000000_descontar_almuerzo_mesa.sql (límite SaaS antes que el plan).
CREATE OR REPLACE FUNCTION fn_descontar_almuerzo(
    p_restaurante_id BIGINT,
    p_cliente_id     BIGINT,
    p_personal_id    BIGINT,
    p_clave_idempotencia UUID,
    p_canal          canal_consumo_enum DEFAULT 'QR',
    p_para_llevar    BOOLEAN DEFAULT false,
    p_orden_id       BIGINT DEFAULT NULL,
    p_mesa_compartida_id BIGINT DEFAULT NULL,
    p_mesa_local_id  BIGINT DEFAULT NULL,
    p_omitir_duplicado BOOLEAN DEFAULT false   -- mesa "invito yo": el anfitrión paga varios almuerzos seguidos
) RETURNS TABLE (resultado resultado_escaneo_enum, consumo_id BIGINT, suscripcion_id BIGINT,
                 almuerzos_restantes_total INTEGER, dias_para_vencer INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tz        TEXT;
    v_hoy       DATE;
    v_sus       suscripcion_plan%ROWTYPE;
    v_saas      suscripcion_saas_restaurante%ROWTYPE;
    v_limite    INTEGER;
    v_consumo   BIGINT;
    v_resultado resultado_escaneo_enum;
    v_total     INTEGER := 0;
    v_dias      INTEGER;
    v_usuario   BIGINT;
BEGIN
    -- La función corre con privilegios del dueño (salta RLS): valida ella misma el tenant.
    -- Sin tenant en la sesión (p. ej. un comensal) no se puede descontar nada.
    IF app_tenant_id() IS DISTINCT FROM p_restaurante_id THEN
        RAISE EXCEPTION 'Restaurante fuera del tenant de la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT r.zona_horaria INTO v_tz FROM restaurante r WHERE r.restaurante_id = p_restaurante_id;
    IF v_tz IS NULL THEN
        RAISE EXCEPTION 'Restaurante % no existe', p_restaurante_id;
    END IF;
    v_hoy := (CURRENT_TIMESTAMP AT TIME ZONE v_tz)::DATE;

    -- Serializa las validaciones del mismo cliente (dos cajas escaneando a la vez).
    SELECT c.usuario_id INTO v_usuario FROM cliente_restaurante c
     WHERE c.restaurante_id = p_restaurante_id AND c.cliente_id = p_cliente_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cliente % no pertenece al restaurante %', p_cliente_id, p_restaurante_id;
    END IF;

    -- 1) Reintento de la misma petición (red inestable): misma respuesta, sin descontar otra vez.
    SELECT c.consumo_id, c.suscripcion_id INTO v_consumo, v_sus.suscripcion_id
      FROM consumo_almuerzo c
     WHERE c.restaurante_id = p_restaurante_id AND c.clave_idempotencia = p_clave_idempotencia;
    IF FOUND THEN
        v_resultado := 'OK';
    -- 2) Doble escaneo del mismo comensal en menos de 60 s.
    ELSIF NOT p_omitir_duplicado AND EXISTS (SELECT 1 FROM consumo_almuerzo c
                   WHERE c.restaurante_id = p_restaurante_id AND c.cliente_id = p_cliente_id
                     AND c.cantidad = 1 AND c.creado_en > CURRENT_TIMESTAMP - INTERVAL '60 seconds'
                     AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = c.consumo_id)) THEN
        v_resultado := 'DUPLICADO';
    ELSE
        -- 3) Límite del plan SaaS del restaurante (tier gratuito).
        SELECT s.* INTO v_saas FROM suscripcion_saas_restaurante s
         WHERE s.restaurante_id = p_restaurante_id AND s.vigente FOR UPDATE;
        IF FOUND THEN
            SELECT p.limite_escaneos_mes INTO v_limite FROM catalogo_plan_saas p WHERE p.plan_saas_id = v_saas.plan_saas_id;
        END IF;

        IF v_saas.suscripcion_saas_id IS NOT NULL AND v_saas.estado = 'SUSPENDIDA' THEN
            v_resultado := 'LIMITE_SAAS';
        ELSIF v_limite IS NOT NULL AND v_saas.escaneos_usados_ciclo_actual >= v_limite THEN
            v_resultado := 'LIMITE_SAAS';
        ELSE
            -- 4) FIFO: el plan vigente que vence primero y vale hoy.
            SELECT s.* INTO v_sus FROM suscripcion_plan s
             WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id
               AND s.estado = 'ACTIVA' AND s.vence_el >= v_hoy
               AND EXTRACT(ISODOW FROM v_hoy)::SMALLINT = ANY (s.dias_validos)
             ORDER BY s.vence_el, s.suscripcion_id
             LIMIT 1 FOR UPDATE;

            IF NOT FOUND THEN
                v_resultado := CASE
                    WHEN EXISTS (SELECT 1 FROM suscripcion_plan s WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id
                                    AND s.estado = 'ACTIVA' AND s.vence_el >= v_hoy) THEN 'DIA_NO_VALIDO'
                    WHEN EXISTS (SELECT 1 FROM suscripcion_plan s WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id
                                    AND s.almuerzos_restantes > 0 AND s.estado IN ('ACTIVA', 'VENCIDA') AND s.vence_el < v_hoy) THEN 'VENCIDO'
                    WHEN EXISTS (SELECT 1 FROM suscripcion_plan s WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id) THEN 'SIN_SALDO'
                    ELSE 'SIN_PLAN' END::resultado_escaneo_enum;
            ELSE
                UPDATE suscripcion_plan s
                   SET almuerzos_restantes = s.almuerzos_restantes - 1,
                       estado = CASE WHEN s.almuerzos_restantes - 1 = 0 THEN 'AGOTADA' ELSE s.estado END
                 WHERE s.suscripcion_id = v_sus.suscripcion_id;

                INSERT INTO consumo_almuerzo (restaurante_id, suscripcion_id, cliente_id, personal_id, canal, para_llevar,
                                              orden_id, mesa_compartida_id, mesa_local_id, valor_unitario_centavos,
                                              clave_idempotencia, fecha_local)
                VALUES (p_restaurante_id, v_sus.suscripcion_id, p_cliente_id, p_personal_id, p_canal, p_para_llevar,
                        p_orden_id, p_mesa_compartida_id, p_mesa_local_id, v_sus.precio_unitario_centavos,
                        p_clave_idempotencia, v_hoy)
                RETURNING consumo_almuerzo.consumo_id INTO v_consumo;

                IF v_saas.suscripcion_saas_id IS NOT NULL THEN
                    UPDATE suscripcion_saas_restaurante s
                       SET escaneos_usados_ciclo_actual = s.escaneos_usados_ciclo_actual + 1
                     WHERE s.suscripcion_saas_id = v_saas.suscripcion_saas_id;
                END IF;
                v_resultado := 'OK';
            END IF;
        END IF;
    END IF;

    -- Saldo total vigente del cliente después de la operación.
    SELECT COALESCE(SUM(s.almuerzos_restantes), 0)::INTEGER INTO v_total FROM suscripcion_plan s
     WHERE s.restaurante_id = p_restaurante_id AND s.cliente_id = p_cliente_id
       AND s.estado = 'ACTIVA' AND s.vence_el >= v_hoy;

    IF v_resultado = 'OK' AND v_sus.vence_el IS NOT NULL THEN
        v_dias := v_sus.vence_el - v_hoy;
        IF v_total = 0 OR v_dias <= 3 THEN
            v_resultado := 'OK_ADVERTENCIA';
        END IF;
    END IF;

    INSERT INTO intento_escaneo (restaurante_id, personal_id, cliente_id, usuario_id, canal, resultado, consumo_id)
    VALUES (p_restaurante_id, p_personal_id, p_cliente_id, v_usuario, p_canal, v_resultado,
            CASE WHEN v_resultado IN ('OK', 'OK_ADVERTENCIA') THEN v_consumo END);

    RETURN QUERY SELECT v_resultado, v_consumo, v_sus.suscripcion_id, v_total, v_dias;
END $$;
