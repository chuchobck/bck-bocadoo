-- migrate:up
-- Entrega D, PR 7b (docs/spec-cobros.md E.8, G-33): oferta flash en el almuerzo de un miembro de la mesa. La columna
-- mesa_compartida_miembro.almuerzo_oferta_flash_id ya existe (20261121150200), pero el comensal no tiene política UPDATE
-- sobre mesa_compartida_miembro y no se le abre: la escribe esta función SECURITY DEFINER, como fn_salir_mesa. No cambia
-- ningún GRANT de tabla ni ninguna política RLS; solo agrega una función con EXECUTE para bocadoo_app.
--
-- Solo el propio miembro (usuario de la sesión), que no haya salido, con la mesa abierta y sin validar; la oferta debe
-- ser del mismo local (null = quitarla). La vigencia y el stock de la oferta NO se miran aquí: los valida la API al elegir
-- y el stock se toma al canjear en caja (I-7).
CREATE OR REPLACE FUNCTION fn_fijar_oferta_almuerzo(p_miembro BIGINT, p_oferta UUID) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_usuario BIGINT := public.app_user_id();
    v_miembro public.mesa_compartida_miembro%ROWTYPE;
    v_oferta  BIGINT;
BEGIN
    IF v_usuario IS NULL THEN
        RAISE EXCEPTION 'Se necesita un usuario en la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT x.* INTO v_miembro FROM public.mesa_compartida_miembro x
     WHERE x.miembro_id = p_miembro AND x.usuario_id = v_usuario FOR UPDATE;
    IF NOT FOUND OR v_miembro.salio_en IS NOT NULL THEN
        RAISE EXCEPTION 'No eres un miembro activo de esa mesa' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.mesa_compartida m
                    WHERE m.mesa_compartida_id = v_miembro.mesa_compartida_id
                      AND m.estado IN ('ABIERTA', 'EN_CAMINO') AND m.validada_en IS NULL) THEN
        RAISE EXCEPTION 'La mesa ya no admite cambios' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_oferta IS NOT NULL THEN
        SELECT o.oferta_flash_id INTO v_oferta FROM public.oferta_flash o
         WHERE o.public_id = p_oferta AND o.restaurante_id = v_miembro.restaurante_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Oferta no encontrada en este local' USING ERRCODE = 'no_data_found';
        END IF;
    END IF;
    UPDATE public.mesa_compartida_miembro x SET almuerzo_oferta_flash_id = v_oferta WHERE x.miembro_id = p_miembro;
END $$;
REVOKE ALL ON FUNCTION fn_fijar_oferta_almuerzo(BIGINT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_fijar_oferta_almuerzo(BIGINT, UUID) TO bocadoo_app;

-- migrate:down
DROP FUNCTION IF EXISTS fn_fijar_oferta_almuerzo(BIGINT, UUID);
