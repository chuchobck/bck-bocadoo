-- migrate:up
-- Sesiones de refresh (token opaco rotativo, guardado solo como hash SHA-256) y eventos de seguridad.
-- Ambas tablas son del rol de servicio (módulo de auth): bocadoo_app no las toca.

CREATE TABLE sesion_refresh (
    sesion_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    familia_id        UUID NOT NULL,                       -- todas las rotaciones de un login comparten familia
    usuario_id        BIGINT NOT NULL REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    token_hash        CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    creado_en         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expira_en         TIMESTAMPTZ NOT NULL,
    usado_en          TIMESTAMPTZ,                         -- se llenó al rotar: reutilizarlo = robo probable
    revocado_en       TIMESTAMPTZ,
    motivo_revocacion TEXT CHECK (motivo_revocacion IN ('LOGOUT', 'LOGOUT_TODOS', 'REUSO', 'ADMIN')),
    ip                INET,
    user_agent        TEXT,
    CHECK (expira_en > creado_en),
    CHECK ((revocado_en IS NULL) = (motivo_revocacion IS NULL))
);
CREATE INDEX idx_sesion_refresh_familia ON sesion_refresh (familia_id);
CREATE INDEX idx_sesion_refresh_usuario_activa ON sesion_refresh (usuario_id) WHERE revocado_en IS NULL;

CREATE TABLE evento_seguridad (
    evento_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ocurrido_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tipo        TEXT NOT NULL CHECK (tipo ~ '^[A-Z][A-Z0-9_]*$'),   -- LOGIN_OK, LOGIN_FALLIDO, REFRESH_REUSO...
    usuario_id  BIGINT REFERENCES usuario(usuario_id) ON DELETE RESTRICT,   -- NULL = no identificado
    ip          INET,
    user_agent  TEXT,
    detalle     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_evento_seguridad_usuario ON evento_seguridad (usuario_id, ocurrido_en DESC);
CREATE INDEX idx_evento_seguridad_tipo    ON evento_seguridad (tipo, ocurrido_en DESC);

-- Los eventos son un libro de solo inserción (misma regla que el resto de libros).
CREATE TRIGGER trg_solo_insercion_evento_seguridad BEFORE UPDATE OR DELETE ON evento_seguridad
    FOR EACH ROW EXECUTE FUNCTION fn_solo_insercion();

ALTER TABLE sesion_refresh   ENABLE ROW LEVEL SECURITY;
ALTER TABLE evento_seguridad ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sesion_refresh, evento_seguridad FROM PUBLIC;
REVOKE ALL ON sesion_refresh, evento_seguridad FROM bocadoo_app;
GRANT SELECT, INSERT, UPDATE ON sesion_refresh TO bocadoo_servicio;
GRANT SELECT, INSERT         ON evento_seguridad TO bocadoo_servicio;

-- migrate:down
DROP TABLE IF EXISTS evento_seguridad;
DROP TABLE IF EXISTS sesion_refresh;
