-- migrate:up
-- Fase 8: mesas compartidas creadas por el comensal y unirse por link (el link lleva el public_id de la mesa).

-- 1) Idempotency-Key del anfitrión al crear la mesa.
ALTER TABLE mesa_compartida ADD COLUMN clave_idempotencia UUID;
CREATE UNIQUE INDEX uq_mesa_anfitrion_clave ON mesa_compartida (anfitrion_usuario_id, clave_idempotencia) WHERE clave_idempotencia IS NOT NULL;

-- 2) Un miembro siempre es del mismo restaurante que su mesa. NOT VALID: no revisa filas viejas, sí todas las nuevas.
ALTER TABLE mesa_compartida_miembro ADD CONSTRAINT fk_miembro_mesa_mismo_restaurante
    FOREIGN KEY (restaurante_id, mesa_compartida_id) REFERENCES mesa_compartida(restaurante_id, mesa_compartida_id) NOT VALID;

-- 3) Mesas donde el usuario de la sesión es anfitrión o miembro. SECURITY DEFINER para que las políticas de las dos
--    tablas puedan usarla sin referirse una a la otra (eso sería recursión infinita de RLS).
CREATE FUNCTION fn_mis_mesas() RETURNS SETOF BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT m.mesa_compartida_id FROM mesa_compartida m WHERE m.anfitrion_usuario_id = app_user_id()
    UNION
    SELECT x.mesa_compartida_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id()
$$;
REVOKE EXECUTE ON FUNCTION fn_mis_mesas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mis_mesas() TO bocadoo_app, bocadoo_servicio;

-- 4) Políticas del comensal. Antes: el anfitrión podía cambiar todo de su mesa (también validada_en) y cualquiera podía
--    insertarse como miembro de cualquier mesa conociendo su id interno. Ahora:
--    · el anfitrión crea su mesa ABIERTA y sin validar, la ve, y solo puede marcarla EN_CAMINO o CANCELADA antes de la caja;
--    · anfitrión y miembros ven la mesa y a todos sus miembros (nombres);
--    · el anfitrión se agrega a sí mismo como anfitrión de su mesa; los demás entran SOLO con fn_unirse_mesa.
DROP POLICY anfitrion_total ON mesa_compartida;
DROP POLICY miembro_lee_mesa ON mesa_compartida;
CREATE POLICY comensal_lee ON mesa_compartida FOR SELECT TO bocadoo_app
    USING (anfitrion_usuario_id = app_user_id() OR mesa_compartida_id IN (SELECT fn_mis_mesas()));
CREATE POLICY anfitrion_crea ON mesa_compartida FOR INSERT TO bocadoo_app
    WITH CHECK (anfitrion_usuario_id = app_user_id() AND estado = 'ABIERTA'
                AND validada_en IS NULL AND validada_por_personal_id IS NULL AND avisada_cocina_en IS NULL);
CREATE POLICY anfitrion_cancela ON mesa_compartida FOR UPDATE TO bocadoo_app
    USING (anfitrion_usuario_id = app_user_id() AND estado IN ('ABIERTA', 'EN_CAMINO') AND validada_en IS NULL)
    WITH CHECK (anfitrion_usuario_id = app_user_id() AND estado IN ('ABIERTA', 'EN_CAMINO', 'CANCELADA') AND validada_en IS NULL);

DROP POLICY miembro_propio ON mesa_compartida_miembro;
CREATE POLICY comensal_lee ON mesa_compartida_miembro FOR SELECT TO bocadoo_app
    USING (usuario_id = app_user_id() OR mesa_compartida_id IN (SELECT fn_mis_mesas()));
CREATE POLICY anfitrion_se_agrega ON mesa_compartida_miembro FOR INSERT TO bocadoo_app
    WITH CHECK (usuario_id = app_user_id() AND es_anfitrion
                AND mesa_compartida_id IN (SELECT m.mesa_compartida_id FROM mesa_compartida m WHERE m.anfitrion_usuario_id = app_user_id()));

-- 5) Vista previa de una invitación: quien aún no es miembro no puede ver la mesa (RLS), así que esta función
--    devuelve solo lo necesario para decidir (sin ids internos ni datos de contacto) y si puede unirse.
--    motivo: NULL (puede), MESA_CERRADA, MESA_VENCIDA (pasó 1 h de la hora de llegada), MESA_LLENA,
--    RESTAURANTE_NO_DISPONIBLE, YA_ERES_MIEMBRO.
CREATE FUNCTION fn_mesa_invitacion(p_mesa UUID)
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
REVOKE EXECUTE ON FUNCTION fn_mesa_invitacion(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_mesa_invitacion(UUID) TO bocadoo_app, bocadoo_servicio;

-- 6) Unirse por link: vuelve a validar con la mesa bloqueada (dos invitados a la vez no pasan del cupo) e inserta al
--    usuario de la sesión. Devuelve UNIDO, YA_ERES_MIEMBRO, NO_ENCONTRADA o el motivo por el que no puede.
CREATE FUNCTION fn_unirse_mesa(p_mesa UUID, p_para_llevar BOOLEAN DEFAULT false) RETURNS TEXT
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
REVOKE EXECUTE ON FUNCTION fn_unirse_mesa(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_unirse_mesa(UUID, BOOLEAN) TO bocadoo_app, bocadoo_servicio;

-- migrate:down
DROP FUNCTION fn_unirse_mesa(UUID, BOOLEAN);
DROP FUNCTION fn_mesa_invitacion(UUID);
DROP POLICY anfitrion_se_agrega ON mesa_compartida_miembro;
DROP POLICY comensal_lee ON mesa_compartida_miembro;
CREATE POLICY miembro_propio ON mesa_compartida_miembro FOR ALL TO bocadoo_app
    USING (usuario_id = app_user_id()) WITH CHECK (usuario_id = app_user_id());
DROP POLICY anfitrion_cancela ON mesa_compartida;
DROP POLICY anfitrion_crea ON mesa_compartida;
DROP POLICY comensal_lee ON mesa_compartida;
CREATE POLICY anfitrion_total ON mesa_compartida FOR ALL TO bocadoo_app
    USING (anfitrion_usuario_id = app_user_id()) WITH CHECK (anfitrion_usuario_id = app_user_id());
CREATE POLICY miembro_lee_mesa ON mesa_compartida FOR SELECT TO bocadoo_app
    USING (mesa_compartida_id IN (SELECT m.mesa_compartida_id FROM mesa_compartida_miembro m WHERE m.usuario_id = app_user_id()));
DROP FUNCTION fn_mis_mesas();
ALTER TABLE mesa_compartida_miembro DROP CONSTRAINT fk_miembro_mesa_mismo_restaurante;
DROP INDEX uq_mesa_anfitrion_clave;
ALTER TABLE mesa_compartida DROP COLUMN clave_idempotencia;
