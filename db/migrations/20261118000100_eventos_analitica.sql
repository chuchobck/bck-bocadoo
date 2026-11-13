-- migrate:up
-- Fase 9: ingesta de eventos de producto en lotes.
--  · evento_lote: una fila por lote recibido (usuario + Idempotency-Key). Reintentar un lote no duplica eventos, y la
--    misma tabla sirve para limitar la tasa por usuario entre instancias de la API.
--  · fn_consiente_analitica(): el comensal no puede leer su columna de consentimiento con bck_api (permiso por
--    columnas), así que esta función SECURITY DEFINER devuelve solo SU consentimiento, nunca el de otro usuario.
CREATE TABLE evento_lote (
    usuario_id         BIGINT NOT NULL REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    clave_idempotencia UUID NOT NULL,
    eventos            INTEGER NOT NULL CHECK (eventos BETWEEN 1 AND 50),
    anonimizado        BOOLEAN NOT NULL,
    creado_en          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (usuario_id, clave_idempotencia)
);
CREATE INDEX idx_evento_lote_tasa ON evento_lote (usuario_id, creado_en DESC);

ALTER TABLE evento_lote ENABLE ROW LEVEL SECURITY;
CREATE POLICY propio ON evento_lote FOR ALL TO bocadoo_app
    USING (usuario_id = app_user_id()) WITH CHECK (usuario_id = app_user_id());
GRANT SELECT, INSERT ON evento_lote TO bocadoo_app;
GRANT ALL ON evento_lote TO bocadoo_servicio;

CREATE FUNCTION fn_consiente_analitica() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT COALESCE((SELECT u.consiente_analitica FROM usuario u WHERE u.usuario_id = app_user_id()), false) $$;
REVOKE EXECUTE ON FUNCTION fn_consiente_analitica() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_consiente_analitica() TO bocadoo_app, bocadoo_servicio;

-- migrate:down
DROP FUNCTION IF EXISTS fn_consiente_analitica();
DROP TABLE IF EXISTS evento_lote;
