-- migrate:up
-- Entrega D, PR 4 (docs/spec-cobros.md F.2, E.6, E.7 y H.1): salir de una mesa, ofertas en la selección y el plan del
-- pagador para la cotización del comensal. Columnas nullable: el código de hoy no las usa y sigue igual.

-- 1) Columnas.
ALTER TABLE mesa_compartida_miembro ADD COLUMN IF NOT EXISTS salio_en TIMESTAMPTZ;
ALTER TABLE mesa_compartida_miembro ADD COLUMN IF NOT EXISTS almuerzo_oferta_flash_id BIGINT;
ALTER TABLE mesa_compartida_miembro_item ADD COLUMN IF NOT EXISTS oferta_flash_id BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.mesa_compartida_miembro'::regclass
                    AND conname = 'ck_miembro_anfitrion_no_sale') THEN
        ALTER TABLE mesa_compartida_miembro ADD CONSTRAINT ck_miembro_anfitrion_no_sale
            CHECK (NOT (es_anfitrion AND salio_en IS NOT NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.mesa_compartida_miembro'::regclass
                    AND conname = 'fk_miembro_almuerzo_oferta') THEN
        ALTER TABLE mesa_compartida_miembro ADD CONSTRAINT fk_miembro_almuerzo_oferta
            FOREIGN KEY (restaurante_id, almuerzo_oferta_flash_id)
            REFERENCES oferta_flash(restaurante_id, oferta_flash_id) ON DELETE RESTRICT;
    END IF;
    -- La oferta siempre va con su plato (plato_id NOT NULL se mantiene).
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.mesa_compartida_miembro_item'::regclass
                    AND conname = 'fk_miembro_item_oferta') THEN
        ALTER TABLE mesa_compartida_miembro_item ADD CONSTRAINT fk_miembro_item_oferta
            FOREIGN KEY (restaurante_id, oferta_flash_id)
            REFERENCES oferta_flash(restaurante_id, oferta_flash_id) ON DELETE RESTRICT;
    END IF;
END $$;

-- 2) Salir de la mesa (E.7). SECURITY DEFINER como fn_unirse_mesa: así no se abre UPDATE sobre mesa_compartida_miembro
--    al comensal. Con la mesa bloqueada valida: es miembro, no es anfitrión, la mesa sigue abierta y sin validar. Marca
--    salio_en y borra su selección. Devuelve SALIO, YA_SALIO (repetir no cambia nada), NO_ENCONTRADA (mesa inexistente
--    o no es miembro: no se distingue), ANFITRION_NO_PUEDE_SALIR o MESA_CERRADA.
CREATE OR REPLACE FUNCTION fn_salir_mesa(p_mesa UUID) RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_usuario BIGINT := public.app_user_id();
    v_mesa    public.mesa_compartida%ROWTYPE;
    v_miembro public.mesa_compartida_miembro%ROWTYPE;
BEGIN
    IF v_usuario IS NULL THEN
        RAISE EXCEPTION 'Se necesita un usuario en la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT m.* INTO v_mesa FROM public.mesa_compartida m WHERE m.public_id = p_mesa FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'NO_ENCONTRADA';
    END IF;
    SELECT x.* INTO v_miembro FROM public.mesa_compartida_miembro x
     WHERE x.mesa_compartida_id = v_mesa.mesa_compartida_id AND x.usuario_id = v_usuario FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'NO_ENCONTRADA';
    END IF;
    IF v_miembro.es_anfitrion THEN
        RETURN 'ANFITRION_NO_PUEDE_SALIR';
    END IF;
    IF v_miembro.salio_en IS NOT NULL THEN
        RETURN 'YA_SALIO';
    END IF;
    IF v_mesa.estado NOT IN ('ABIERTA', 'EN_CAMINO') OR v_mesa.validada_en IS NOT NULL THEN
        RETURN 'MESA_CERRADA';
    END IF;
    DELETE FROM public.mesa_compartida_miembro_item i WHERE i.miembro_id = v_miembro.miembro_id;
    UPDATE public.mesa_compartida_miembro x SET salio_en = CURRENT_TIMESTAMP WHERE x.miembro_id = v_miembro.miembro_id;
    RETURN 'SALIO';
END $$;
REVOKE ALL ON FUNCTION fn_salir_mesa(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_salir_mesa(UUID) TO bocadoo_app;

-- 3) Almuerzos disponibles HOY del plan del pagador de un miembro (H.1, completa miembros[].cotizacion de E.6). El
--    comensal solo lee su propio plan por RLS; esta función le da a un miembro de la mesa SOLO ese entero, nada más del
--    plan ni del cliente. Pagador: en INVITO_YO el anfitrión; en CADA_UNO el propio miembro.
--    Quién pregunta (app_user_id()) debe ser miembro de la mesa y no haber salido. El anfitrión puede preguntar por
--    cualquier miembro; un invitado solo por sí mismo (misma visibilidad que la selección, E.6). Devuelve NULL si no
--    puede preguntar o si el miembro no es de esa mesa (o salió); 0 si el pagador no tiene plan que valga hoy.
--    La condición es la de fn_descontar_almuerzo (20261116000000_descontar_almuerzo_mesa.sql, paso 4): ACTIVA,
--    vence_el >= hoy y hoy en dias_validos, con hoy en la zona horaria del local.
CREATE OR REPLACE FUNCTION fn_plan_pagador_mesa(p_mesa_compartida_id BIGINT, p_miembro_id BIGINT) RETURNS INTEGER
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_usuario     BIGINT := public.app_user_id();
    v_mesa        public.mesa_compartida%ROWTYPE;
    v_yo          public.mesa_compartida_miembro%ROWTYPE;
    v_objetivo    public.mesa_compartida_miembro%ROWTYPE;
    v_pagador     BIGINT;
    v_hoy         DATE;
    v_disponibles INTEGER;
BEGIN
    IF v_usuario IS NULL THEN
        RAISE EXCEPTION 'Se necesita un usuario en la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT m.* INTO v_mesa FROM public.mesa_compartida m WHERE m.mesa_compartida_id = p_mesa_compartida_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT x.* INTO v_yo FROM public.mesa_compartida_miembro x
     WHERE x.mesa_compartida_id = v_mesa.mesa_compartida_id AND x.usuario_id = v_usuario AND x.salio_en IS NULL;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT x.* INTO v_objetivo FROM public.mesa_compartida_miembro x
     WHERE x.miembro_id = p_miembro_id AND x.mesa_compartida_id = v_mesa.mesa_compartida_id AND x.salio_en IS NULL;
    IF NOT FOUND OR (NOT v_yo.es_anfitrion AND v_objetivo.miembro_id <> v_yo.miembro_id) THEN
        RETURN NULL;
    END IF;

    v_pagador := CASE WHEN v_mesa.modo = 'INVITO_YO' THEN v_mesa.anfitrion_usuario_id ELSE v_objetivo.usuario_id END;
    SELECT (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::DATE INTO v_hoy
      FROM public.restaurante r WHERE r.restaurante_id = v_mesa.restaurante_id;
    SELECT COALESCE(sum(s.almuerzos_restantes), 0)::INTEGER INTO v_disponibles
      FROM public.cliente_restaurante c
      JOIN public.suscripcion_plan s ON s.restaurante_id = c.restaurante_id AND s.cliente_id = c.cliente_id
     WHERE c.restaurante_id = v_mesa.restaurante_id AND c.usuario_id = v_pagador AND c.activo
       AND s.estado = 'ACTIVA' AND s.vence_el >= v_hoy
       AND EXTRACT(ISODOW FROM v_hoy)::SMALLINT = ANY (s.dias_validos);
    RETURN v_disponibles;   -- 0 también si el pagador no tiene cuenta (usuario_id NULL) o ficha en el local
END $$;
REVOKE ALL ON FUNCTION fn_plan_pagador_mesa(BIGINT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_plan_pagador_mesa(BIGINT, BIGINT) TO bocadoo_app;

-- migrate:down
DROP FUNCTION IF EXISTS fn_plan_pagador_mesa(BIGINT, BIGINT);
DROP FUNCTION IF EXISTS fn_salir_mesa(UUID);
ALTER TABLE mesa_compartida_miembro_item DROP CONSTRAINT IF EXISTS fk_miembro_item_oferta;
ALTER TABLE mesa_compartida_miembro DROP CONSTRAINT IF EXISTS fk_miembro_almuerzo_oferta;
ALTER TABLE mesa_compartida_miembro DROP CONSTRAINT IF EXISTS ck_miembro_anfitrion_no_sale;
ALTER TABLE mesa_compartida_miembro_item DROP COLUMN IF EXISTS oferta_flash_id;
ALTER TABLE mesa_compartida_miembro DROP COLUMN IF EXISTS almuerzo_oferta_flash_id;
ALTER TABLE mesa_compartida_miembro DROP COLUMN IF EXISTS salio_en;
