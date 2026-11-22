-- migrate:up
-- Entrega D, PR 6 (docs/spec-cobros.md D «Miembro que se va», E.7 y H.1 punto 6): quien salió de una mesa
-- (mesa_compartida_miembro.salio_en NOT NULL) queda fuera de ella. Las políticas de la entrega C no miraban salio_en:
-- podía volver a escribir su selección, seguía contando en el cupo y unirse le respondía YA_ERES_MIEMBRO.
-- Ahora:
--   · no lee, no escribe ni borra selección (mesa_compartida_miembro_item: comensal_lee / comensal_escribe / comensal_borra);
--   · no ocupa cupo (fn_mesa_invitacion cuenta solo a los que siguen) y la invitación lo trata como a cualquiera;
--   · puede volver a unirse con las reglas de un invitado nuevo (mesa abierta y sin validar, no vencida, con cupo, local
--     activo): fn_unirse_mesa reactiva su misma fila (uq_mesa_miembro_usuario) con la selección vacía;
--   · fn_salir_mesa toma el mismo candado que PUT …/seleccion y validar mesa (pg_advisory_xact_lock(miembro_id)): una
--     selección que se guarda a la vez que el miembro sale no sobrevive a la salida.
-- Sigue viendo la mesa y la lista de miembros (fn_mis_mesas no cambia): `salir` responde la mesa y queda en «Mis mesas».
-- Sin cambios de GRANT: CREATE OR REPLACE conserva los permisos de cada función; se repiten abajo para dejarlos explícitos.

-- 1) Selección: solo la del miembro que sigue en la mesa (el anfitrión no puede salir, ck_miembro_anfitrion_no_sale).
DROP POLICY IF EXISTS comensal_lee ON mesa_compartida_miembro_item;
DROP POLICY IF EXISTS comensal_escribe ON mesa_compartida_miembro_item;
DROP POLICY IF EXISTS comensal_borra ON mesa_compartida_miembro_item;
CREATE POLICY comensal_lee ON mesa_compartida_miembro_item FOR SELECT TO bocadoo_app
    USING (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id() AND x.salio_en IS NULL)
           OR mesa_compartida_id IN (SELECT m.mesa_compartida_id FROM mesa_compartida m WHERE m.anfitrion_usuario_id = app_user_id()));
CREATE POLICY comensal_escribe ON mesa_compartida_miembro_item FOR INSERT TO bocadoo_app
    WITH CHECK (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id() AND x.salio_en IS NULL)
                AND EXISTS (SELECT 1 FROM mesa_compartida m WHERE m.mesa_compartida_id = mesa_compartida_miembro_item.mesa_compartida_id
                              AND m.estado IN ('ABIERTA', 'EN_CAMINO') AND m.validada_en IS NULL));
CREATE POLICY comensal_borra ON mesa_compartida_miembro_item FOR DELETE TO bocadoo_app
    USING (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id() AND x.salio_en IS NULL)
           AND EXISTS (SELECT 1 FROM mesa_compartida m WHERE m.mesa_compartida_id = mesa_compartida_miembro_item.mesa_compartida_id
                         AND m.estado IN ('ABIERTA', 'EN_CAMINO') AND m.validada_en IS NULL));

-- 2) Invitación: quien salió no cuenta en `personas` (cupo) ni es YA_ERES_MIEMBRO. Mismas columnas y orden de motivos.
CREATE OR REPLACE FUNCTION fn_mesa_invitacion(p_mesa UUID)
RETURNS TABLE (restaurante_public_id UUID, restaurante_nombre TEXT, restaurante_slug TEXT, anfitrion_nombre TEXT,
               hora_llegada TIMESTAMPTZ, modo modo_mesa_enum, estado estado_mesa_enum, personas INTEGER, capacidad INTEGER,
               motivo TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Se necesita un usuario en la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
    SELECT r.public_id, r.nombre, r.slug, u.nombre, m.hora_llegada, m.modo, m.estado, n.personas, cap.capacidad,
           CASE
               WHEN EXISTS (SELECT 1 FROM public.mesa_compartida_miembro x WHERE x.mesa_compartida_id = m.mesa_compartida_id
                              AND x.usuario_id = public.app_user_id() AND x.salio_en IS NULL) THEN 'YA_ERES_MIEMBRO'
               WHEN r.estado <> 'ACTIVO' THEN 'RESTAURANTE_NO_DISPONIBLE'
               WHEN m.estado NOT IN ('ABIERTA', 'EN_CAMINO') OR m.validada_en IS NOT NULL THEN 'MESA_CERRADA'
               WHEN m.hora_llegada < CURRENT_TIMESTAMP - interval '1 hour' THEN 'MESA_VENCIDA'
               WHEN n.personas >= cap.capacidad THEN 'MESA_LLENA'
           END
      FROM public.mesa_compartida m
      JOIN public.restaurante r ON r.restaurante_id = m.restaurante_id
      JOIN public.usuario u ON u.usuario_id = m.anfitrion_usuario_id
      CROSS JOIN LATERAL (SELECT count(*)::int AS personas FROM public.mesa_compartida_miembro x
                           WHERE x.mesa_compartida_id = m.mesa_compartida_id AND x.salio_en IS NULL) n
      CROSS JOIN LATERAL (SELECT COALESCE((SELECT l.capacidad::int FROM public.mesa_local l
                                            WHERE l.restaurante_id = m.restaurante_id AND l.mesa_local_id = m.mesa_local_id), 12)
                                 AS capacidad) cap
     WHERE m.public_id = p_mesa;
END $$;
REVOKE ALL ON FUNCTION fn_mesa_invitacion(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mesa_invitacion(UUID) TO bocadoo_app, bocadoo_servicio;

-- 3) Unirse: con la mesa bloqueada y las mismas validaciones; quien salió vuelve con su misma fila (salio_en = NULL,
--    su paraLlevar de ahora y el nombre actual), sin selección: se borró al salir.
CREATE OR REPLACE FUNCTION fn_unirse_mesa(p_mesa UUID, p_para_llevar BOOLEAN DEFAULT false) RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_mesa    public.mesa_compartida%ROWTYPE;
    v_motivo  TEXT;
    v_miembro BIGINT;
BEGIN
    IF public.app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Se necesita un usuario en la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT m.* INTO v_mesa FROM public.mesa_compartida m WHERE m.public_id = p_mesa FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'NO_ENCONTRADA';
    END IF;
    SELECT i.motivo INTO v_motivo FROM public.fn_mesa_invitacion(p_mesa) i;
    IF v_motivo IS NOT NULL THEN
        RETURN v_motivo;
    END IF;
    SELECT x.miembro_id INTO v_miembro FROM public.mesa_compartida_miembro x
     WHERE x.mesa_compartida_id = v_mesa.mesa_compartida_id AND x.usuario_id = public.app_user_id() AND x.salio_en IS NOT NULL
       FOR UPDATE;
    IF FOUND THEN
        UPDATE public.mesa_compartida_miembro x
           SET salio_en = NULL, para_llevar = COALESCE(p_para_llevar, false), nombre = u.nombre
          FROM public.usuario u
         WHERE x.miembro_id = v_miembro AND u.usuario_id = public.app_user_id() AND u.activo;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Usuario inactivo' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN 'UNIDO';
    END IF;
    INSERT INTO public.mesa_compartida_miembro (mesa_compartida_id, restaurante_id, usuario_id, nombre, es_anfitrion, para_llevar)
    SELECT v_mesa.mesa_compartida_id, v_mesa.restaurante_id, u.usuario_id, u.nombre, false, COALESCE(p_para_llevar, false)
      FROM public.usuario u WHERE u.usuario_id = public.app_user_id() AND u.activo;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Usuario inactivo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN 'UNIDO';
END $$;
REVOKE ALL ON FUNCTION fn_unirse_mesa(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_unirse_mesa(UUID, BOOLEAN) TO bocadoo_app, bocadoo_servicio;

-- 4) Salir: igual que en 20261121150200, más el candado del miembro antes de borrar su selección.
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
    -- Mismo candado que PUT …/seleccion (src/tables/selection.ts) y validar mesa: una selección a medio guardar termina
    -- antes de que se borre, y una que empieza después ya no pasa la política (salio_en marcado).
    PERFORM pg_advisory_xact_lock(v_miembro.miembro_id);
    DELETE FROM public.mesa_compartida_miembro_item i WHERE i.miembro_id = v_miembro.miembro_id;
    UPDATE public.mesa_compartida_miembro x SET salio_en = CURRENT_TIMESTAMP WHERE x.miembro_id = v_miembro.miembro_id;
    RETURN 'SALIO';
END $$;
REVOKE ALL ON FUNCTION fn_salir_mesa(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_salir_mesa(UUID) TO bocadoo_app;

-- migrate:down
-- Vuelve a las definiciones de 20261121150200 (fn_salir_mesa), 20261117000100 (invitación y unirse) y 20261121140100
-- (políticas de la selección). Un miembro reactivado conserva salio_en = NULL: sigue en la mesa.
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

CREATE OR REPLACE FUNCTION fn_unirse_mesa(p_mesa UUID, p_para_llevar BOOLEAN DEFAULT false) RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_mesa   mesa_compartida%ROWTYPE;
    v_motivo TEXT;
BEGIN
    IF app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Se necesita un usuario en la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT m.* INTO v_mesa FROM mesa_compartida m WHERE m.public_id = p_mesa FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'NO_ENCONTRADA';
    END IF;
    SELECT i.motivo INTO v_motivo FROM fn_mesa_invitacion(p_mesa) i;
    IF v_motivo IS NOT NULL THEN
        RETURN v_motivo;
    END IF;
    INSERT INTO mesa_compartida_miembro (mesa_compartida_id, restaurante_id, usuario_id, nombre, es_anfitrion, para_llevar)
    SELECT v_mesa.mesa_compartida_id, v_mesa.restaurante_id, u.usuario_id, u.nombre, false, COALESCE(p_para_llevar, false)
      FROM usuario u WHERE u.usuario_id = app_user_id() AND u.activo;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Usuario inactivo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN 'UNIDO';
END $$;
REVOKE ALL ON FUNCTION fn_unirse_mesa(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_unirse_mesa(UUID, BOOLEAN) TO bocadoo_app, bocadoo_servicio;

CREATE OR REPLACE FUNCTION fn_mesa_invitacion(p_mesa UUID)
RETURNS TABLE (restaurante_public_id UUID, restaurante_nombre TEXT, restaurante_slug TEXT, anfitrion_nombre TEXT,
               hora_llegada TIMESTAMPTZ, modo modo_mesa_enum, estado estado_mesa_enum, personas INTEGER, capacidad INTEGER,
               motivo TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Se necesita un usuario en la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
    SELECT r.public_id, r.nombre, r.slug, u.nombre, m.hora_llegada, m.modo, m.estado, n.personas, cap.capacidad,
           CASE
               WHEN EXISTS (SELECT 1 FROM mesa_compartida_miembro x WHERE x.mesa_compartida_id = m.mesa_compartida_id
                              AND x.usuario_id = app_user_id()) THEN 'YA_ERES_MIEMBRO'
               WHEN r.estado <> 'ACTIVO' THEN 'RESTAURANTE_NO_DISPONIBLE'
               WHEN m.estado NOT IN ('ABIERTA', 'EN_CAMINO') OR m.validada_en IS NOT NULL THEN 'MESA_CERRADA'
               WHEN m.hora_llegada < CURRENT_TIMESTAMP - interval '1 hour' THEN 'MESA_VENCIDA'
               WHEN n.personas >= cap.capacidad THEN 'MESA_LLENA'
           END
      FROM mesa_compartida m
      JOIN restaurante r ON r.restaurante_id = m.restaurante_id
      JOIN usuario u ON u.usuario_id = m.anfitrion_usuario_id
      CROSS JOIN LATERAL (SELECT count(*)::int AS personas FROM mesa_compartida_miembro x
                           WHERE x.mesa_compartida_id = m.mesa_compartida_id) n
      CROSS JOIN LATERAL (SELECT COALESCE((SELECT l.capacidad::int FROM mesa_local l
                                            WHERE l.restaurante_id = m.restaurante_id AND l.mesa_local_id = m.mesa_local_id), 12)
                                 AS capacidad) cap
     WHERE m.public_id = p_mesa;
END $$;
REVOKE ALL ON FUNCTION fn_mesa_invitacion(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mesa_invitacion(UUID) TO bocadoo_app, bocadoo_servicio;

DROP POLICY IF EXISTS comensal_lee ON mesa_compartida_miembro_item;
DROP POLICY IF EXISTS comensal_escribe ON mesa_compartida_miembro_item;
DROP POLICY IF EXISTS comensal_borra ON mesa_compartida_miembro_item;
CREATE POLICY comensal_lee ON mesa_compartida_miembro_item FOR SELECT TO bocadoo_app
    USING (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id())
           OR mesa_compartida_id IN (SELECT m.mesa_compartida_id FROM mesa_compartida m WHERE m.anfitrion_usuario_id = app_user_id()));
CREATE POLICY comensal_escribe ON mesa_compartida_miembro_item FOR INSERT TO bocadoo_app
    WITH CHECK (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id())
                AND EXISTS (SELECT 1 FROM mesa_compartida m WHERE m.mesa_compartida_id = mesa_compartida_miembro_item.mesa_compartida_id
                              AND m.estado IN ('ABIERTA', 'EN_CAMINO') AND m.validada_en IS NULL));
CREATE POLICY comensal_borra ON mesa_compartida_miembro_item FOR DELETE TO bocadoo_app
    USING (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id())
           AND EXISTS (SELECT 1 FROM mesa_compartida m WHERE m.mesa_compartida_id = mesa_compartida_miembro_item.mesa_compartida_id
                         AND m.estado IN ('ABIERTA', 'EN_CAMINO') AND m.validada_en IS NULL));
