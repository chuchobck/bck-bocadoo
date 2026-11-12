-- migrate:up
-- =============================================================================
-- BOCADOO · ESQUEMA COMPLETO v1 (PostgreSQL 16)
-- SaaS multi-tenant para planes de almuerzo: núcleo operativo + SaaS B2B +
-- wallet + aislamiento RLS + auditoría + eventos para analítica / IA.
--
-- Convenciones
--   · PK interna BIGINT IDENTITY (<tabla>_id). Lo que sale a la app / QR / URL
--     usa public_id UUID: nunca se exponen ids secuenciales.
--   · Dinero: BIGINT en la unidad mínima de la moneda (centavos) + moneda ISO.
--     Igual que el prototipo (enteros, sin decimales flotantes) y sirve para
--     monedas con 0, 2 o 3 decimales (moneda.decimales).
--   · Tiempo: TIMESTAMPTZ en UTC + fecha_local DATE en la zona horaria del
--     restaurante para todo lo que es "del día" (menú, caja, reportes).
--   · Sin borrado físico: columna activo o estado. Los libros contables
--     (consumos, pagos, wallet, comisiones) son de solo-inserción y se corrigen
--     con un movimiento inverso (revierte_a), nunca con UPDATE/DELETE.
--   · Tenant = restaurante. El backend fija por transacción:
--       SET LOCAL app.current_tenant_id = '<restaurante_id>';   -- dueño/cajero
--       SET LOCAL app.current_user_id   = '<usuario_id>';       -- siempre
--
-- Ejecución: base de datos vacía, con un rol dueño (migraciones). La app debe
-- conectarse con el rol bocadoo_app (sujeto a RLS), NUNCA con el rol dueño.
-- =============================================================================


CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =============================================================================
-- 0. ROLES
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bocadoo_app') THEN
        CREATE ROLE bocadoo_app NOLOGIN;              -- API: sujeto a RLS
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bocadoo_servicio') THEN
        CREATE ROLE bocadoo_servicio NOLOGIN BYPASSRLS; -- auth, cron, facturación, wallet
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Sin permiso para crear roles: créalos desde el panel del proveedor (bocadoo_app, bocadoo_servicio).';
END $$;

-- =============================================================================
-- 1. ENUMS (solo estados cerrados; lo que varía por país va en tablas catálogo)
-- =============================================================================
CREATE TYPE rol_personal_enum          AS ENUM ('DUENO', 'CAJERO');
CREATE TYPE estado_restaurante_enum    AS ENUM ('BORRADOR', 'ACTIVO', 'PAUSADO', 'BAJA');
CREATE TYPE momento_cobro_enum         AS ENUM ('ANTES_DE_SERVIR', 'DESPUES_DE_SERVIR');
CREATE TYPE proveedor_identidad_enum   AS ENUM ('PASSWORD', 'GOOGLE', 'APPLE', 'TELEFONO');
CREATE TYPE categoria_plato_enum       AS ENUM ('ALMUERZO', 'A_LA_CARTA', 'EXTRA', 'BEBIDA');
CREATE TYPE seccion_menu_enum          AS ENUM ('JUGO', 'SOPA', 'FUERTE', 'POSTRE', 'ADICIONAL');
CREATE TYPE tipo_plan_enum             AS ENUM ('SEMANAL', 'QUINCENAL', 'MENSUAL', 'LIBRE');
CREATE TYPE origen_suscripcion_enum    AS ENUM ('VENTA', 'MIGRADA');
CREATE TYPE estado_suscripcion_enum    AS ENUM ('ACTIVA', 'AGOTADA', 'VENCIDA', 'ANULADA');
CREATE TYPE estado_solicitud_plan_enum AS ENUM ('PENDIENTE', 'COBRADA', 'EXPIRADA', 'RECHAZADA');
CREATE TYPE canal_consumo_enum         AS ENUM ('QR', 'MANUAL', 'PREORDEN', 'MESA');
CREATE TYPE resultado_escaneo_enum     AS ENUM ('OK', 'OK_ADVERTENCIA', 'DUPLICADO', 'SIN_PLAN', 'SIN_SALDO',
                                                'VENCIDO', 'DIA_NO_VALIDO', 'OTRO_LOCAL', 'QR_EXPIRADO',
                                                'QR_INVALIDO', 'LIMITE_SAAS');
CREATE TYPE modo_venta_pos_enum        AS ENUM ('DIRECTA', 'PLAN');
CREATE TYPE estado_pago_enum           AS ENUM ('PENDIENTE', 'CONFIRMADO', 'RECHAZADO');
CREATE TYPE tipo_orden_enum            AS ENUM ('AQUI', 'LLEVAR');
CREATE TYPE estado_orden_enum          AS ENUM ('BORRADOR', 'EN_CAMINO', 'CANJEADA', 'SERVIDA', 'EXPIRADA', 'CANCELADA');
CREATE TYPE estado_mesa_enum           AS ENUM ('ABIERTA', 'EN_CAMINO', 'EN_MESA', 'FINALIZADA', 'CANCELADA');
CREATE TYPE modo_mesa_enum             AS ENUM ('CADA_UNO', 'INVITO_YO');
CREATE TYPE cuenta_sello_enum          AS ENUM ('ALMUERZO', 'PLATO');
CREATE TYPE tipo_movimiento_sello_enum AS ENUM ('GANADO', 'PREMIO_CANJEADO', 'AJUSTE');
CREATE TYPE estado_reclamo_enum        AS ENUM ('PENDIENTE', 'DEVUELTO', 'RECHAZADO');
CREATE TYPE tipo_comision_enum         AS ENUM ('OFERTA_FLASH', 'MARKETPLACE');
CREATE TYPE estado_suscripcion_saas_enum AS ENUM ('TRIAL', 'FREEMIUM', 'ACTIVA_PRO', 'MOROSA', 'SUSPENDIDA', 'CANCELADA');
CREATE TYPE estado_factura_saas_enum   AS ENUM ('PENDIENTE', 'PAGADA', 'VENCIDA', 'ANULADA');
CREATE TYPE concepto_factura_saas_enum AS ENUM ('MENSUALIDAD', 'COMISION_OFERTA_FLASH', 'COMISION_MARKETPLACE',
                                                'PAQUETE_ADS_LOCAL', 'AJUSTE');
CREATE TYPE tipo_movimiento_wallet_enum AS ENUM ('RECARGA_USUARIO', 'BONO_PROMOCIONAL', 'PAGO_CONSUMO',
                                                 'REEMBOLSO', 'EXPIRACION_BONO');
CREATE TYPE accion_auditoria_enum      AS ENUM ('CREAR', 'EDITAR', 'DESACTIVAR', 'ELIMINAR');
CREATE TYPE plataforma_enum            AS ENUM ('ANDROID', 'IOS', 'WEB');

-- =============================================================================
-- 2. FUNCIONES BASE
-- =============================================================================
CREATE FUNCTION app_tenant_id() RETURNS BIGINT
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::BIGINT $$;

CREATE FUNCTION app_user_id() RETURNS BIGINT
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::BIGINT $$;

CREATE FUNCTION fn_zona_horaria_valida(p_tz TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$ SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) $$;

CREATE FUNCTION fn_tocar_actualizado_en() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.actualizado_en := CURRENT_TIMESTAMP;
    RETURN NEW;
END $$;

-- Libros contables: solo INSERT. Se corrige con un movimiento inverso.
CREATE FUNCTION fn_solo_insercion() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'La tabla % es de solo-inserción: registra un movimiento inverso en lugar de %',
        TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;

-- =============================================================================
-- 3. GEOGRAFÍA Y CATÁLOGOS GLOBALES (sin tenant)
-- =============================================================================
CREATE TABLE moneda (
    moneda_codigo CHAR(3) PRIMARY KEY CHECK (moneda_codigo ~ '^[A-Z]{3}$'),   -- ISO 4217
    nombre        TEXT NOT NULL,
    simbolo       TEXT NOT NULL,
    decimales     SMALLINT NOT NULL DEFAULT 2 CHECK (decimales BETWEEN 0 AND 4)
);

CREATE TABLE pais (
    pais_codigo        CHAR(2) PRIMARY KEY CHECK (pais_codigo ~ '^[A-Z]{2}$'), -- ISO 3166-1
    nombre             TEXT NOT NULL,
    moneda_codigo      CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    prefijo_telefonico VARCHAR(6) NOT NULL,
    idioma_defecto     VARCHAR(10) NOT NULL DEFAULT 'es',
    habilitado         BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE ciudad (
    ciudad_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pais_codigo  CHAR(2) NOT NULL REFERENCES pais(pais_codigo),
    nombre       TEXT NOT NULL,
    slug         TEXT NOT NULL,
    zona_horaria TEXT NOT NULL CHECK (fn_zona_horaria_valida(zona_horaria)),
    latitud      NUMERIC(9, 6) CHECK (latitud BETWEEN -90 AND 90),
    longitud     NUMERIC(9, 6) CHECK (longitud BETWEEN -180 AND 180),
    habilitada   BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (pais_codigo, slug)
);

CREATE TABLE zona (
    zona_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ciudad_id   BIGINT NOT NULL REFERENCES ciudad(ciudad_id),
    nombre      TEXT NOT NULL,
    slug        TEXT NOT NULL,
    descripcion TEXT,
    latitud     NUMERIC(9, 6) NOT NULL CHECK (latitud BETWEEN -90 AND 90),
    longitud    NUMERIC(9, 6) NOT NULL CHECK (longitud BETWEEN -180 AND 180),
    activa      BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (ciudad_id, slug)
);

-- Métodos de pago como catálogo (no enum): cambian por país (Deuna solo existe en Ecuador).
CREATE TABLE metodo_pago (
    metodo_pago_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo         VARCHAR(30) NOT NULL,
    nombre         TEXT NOT NULL,
    pais_codigo    CHAR(2) REFERENCES pais(pais_codigo),   -- NULL = disponible en todos los países
    es_efectivo    BOOLEAN NOT NULL DEFAULT false,         -- entra al arqueo de gaveta
    activo         BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX uq_metodo_pago_codigo_pais ON metodo_pago (codigo, COALESCE(pais_codigo, '--'));

-- =============================================================================
-- 4. IDENTIDAD
-- =============================================================================
CREATE TABLE usuario (
    usuario_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    nombre             TEXT NOT NULL CHECK (btrim(nombre) <> ''),
    nombre_usuario     CITEXT UNIQUE,
    correo             CITEXT UNIQUE,
    telefono_e164      VARCHAR(16) UNIQUE CHECK (telefono_e164 ~ '^\+[1-9][0-9]{6,14}$'),
    correo_verificado_en   TIMESTAMPTZ,
    telefono_verificado_en TIMESTAMPTZ,
    pais_codigo        CHAR(2) REFERENCES pais(pais_codigo),
    zona_preferida_id  BIGINT REFERENCES zona(zona_id),
    idioma             VARCHAR(10) NOT NULL DEFAULT 'es',
    foto_url           TEXT,
    -- Consentimientos (LOPDP Ecuador / GDPR): sin ellos sus datos no entran a modelos de IA.
    acepto_terminos_version TEXT,
    acepto_terminos_en      TIMESTAMPTZ,
    consiente_analitica     BOOLEAN NOT NULL DEFAULT false,
    consiente_marketing     BOOLEAN NOT NULL DEFAULT false,
    activo             BOOLEAN NOT NULL DEFAULT true,
    creado_en          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (correo IS NOT NULL OR telefono_e164 IS NOT NULL)
);

-- Credenciales y secretos separados del perfil: solo los lee el rol de servicio.
CREATE TABLE usuario_identidad (
    identidad_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_id     BIGINT NOT NULL REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    proveedor      proveedor_identidad_enum NOT NULL,
    sujeto         TEXT NOT NULL,          -- correo, sub de Google/Apple o teléfono
    password_hash  TEXT,                   -- argon2id; solo con proveedor PASSWORD
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ultimo_acceso_en TIMESTAMPTZ,
    UNIQUE (proveedor, sujeto),
    UNIQUE (usuario_id, proveedor),
    CHECK ((proveedor = 'PASSWORD') = (password_hash IS NOT NULL))
);

-- Secreto del QR rotativo (HMAC cada 30 s, como un TOTP). El prototipo usa un hash
-- de demostración predecible; en producción el código se firma con este secreto.
CREATE TABLE usuario_secreto_qr (
    usuario_id      BIGINT PRIMARY KEY REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    secreto_cifrado BYTEA NOT NULL,        -- cifrado por la app (KMS), nunca en claro
    version         INTEGER NOT NULL DEFAULT 1,
    rotado_en       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dispositivo_usuario (
    dispositivo_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_id     BIGINT NOT NULL REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    plataforma     plataforma_enum NOT NULL,
    token_push     TEXT NOT NULL UNIQUE,
    version_app    TEXT,
    activo         BOOLEAN NOT NULL DEFAULT true,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    visto_en       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_dispositivo_usuario ON dispositivo_usuario (usuario_id) WHERE activo;

-- =============================================================================
-- 5. RESTAURANTE (TENANT)
-- =============================================================================
CREATE TABLE restaurante (
    restaurante_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    nombre           TEXT NOT NULL CHECK (btrim(nombre) <> ''),
    slug             TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    descripcion_corta TEXT,
    etiquetas        TEXT[] NOT NULL DEFAULT '{}',
    pais_codigo      CHAR(2) NOT NULL REFERENCES pais(pais_codigo),
    ciudad_id        BIGINT NOT NULL REFERENCES ciudad(ciudad_id),
    zona_id          BIGINT REFERENCES zona(zona_id),
    moneda_codigo    CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    zona_horaria     TEXT NOT NULL CHECK (fn_zona_horaria_valida(zona_horaria)),
    direccion        TEXT,
    latitud          NUMERIC(9, 6) CHECK (latitud BETWEEN -90 AND 90),
    longitud         NUMERIC(9, 6) CHECK (longitud BETWEEN -180 AND 180),
    telefono_e164    VARCHAR(16) CHECK (telefono_e164 ~ '^\+[1-9][0-9]{6,14}$'),
    logo_url         TEXT,
    puestos          INTEGER NOT NULL DEFAULT 20 CHECK (puestos > 0),
    anotar_mesa      BOOLEAN NOT NULL DEFAULT false,
    momento_cobro    momento_cobro_enum NOT NULL DEFAULT 'ANTES_DE_SERVIR',
    precio_suelto_centavos        BIGINT NOT NULL CHECK (precio_suelto_centavos >= 0),
    recargo_para_llevar_centavos  BIGINT NOT NULL DEFAULT 0 CHECK (recargo_para_llevar_centavos >= 0),
    lleno_manual_hasta TIMESTAMPTZ,       -- interruptor "Local lleno" (expira solo a los 20 min)
    estado           estado_restaurante_enum NOT NULL DEFAULT 'BORRADOR',
    creado_en        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_restaurante_zona   ON restaurante (zona_id) WHERE estado = 'ACTIVO';
CREATE INDEX idx_restaurante_ciudad ON restaurante (ciudad_id) WHERE estado = 'ACTIVO';
CREATE INDEX idx_restaurante_nombre_trgm ON restaurante USING gin (nombre gin_trgm_ops);
CREATE INDEX idx_restaurante_etiquetas   ON restaurante USING gin (etiquetas);

CREATE TABLE restaurante_horario (
    horario_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    dia_semana     SMALLINT NOT NULL CHECK (dia_semana BETWEEN 1 AND 7),   -- ISO: 1 = lunes
    abre           TIME NOT NULL,
    cierra         TIME NOT NULL,
    CHECK (cierra > abre),
    UNIQUE (restaurante_id, dia_semana, abre)
);

CREATE TABLE personal_restaurante (
    personal_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    usuario_id     BIGINT NOT NULL REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    rol            rol_personal_enum NOT NULL,
    nombre_visible TEXT NOT NULL,
    activo         BOOLEAN NOT NULL DEFAULT true,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (restaurante_id, usuario_id),
    UNIQUE (restaurante_id, personal_id)
);
CREATE INDEX idx_personal_usuario ON personal_restaurante (usuario_id) WHERE activo;

-- Mesas físicas del local (para el flujo de aforo/cobro por mesa).
CREATE TABLE mesa_local (
    mesa_local_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    etiqueta       VARCHAR(20) NOT NULL,
    capacidad      SMALLINT NOT NULL CHECK (capacidad > 0),
    activo         BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (restaurante_id, etiqueta),
    UNIQUE (restaurante_id, mesa_local_id)
);

-- Cliente de la libreta del dueño. usuario_id es NULL mientras no tenga la app
-- (cartulina migrada); se enlaza después sin perder su historial.
CREATE TABLE cliente_restaurante (
    cliente_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    usuario_id     BIGINT REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    nombre         TEXT NOT NULL CHECK (btrim(nombre) <> ''),
    telefono_e164  VARCHAR(16) CHECK (telefono_e164 ~ '^\+[1-9][0-9]{6,14}$'),
    correo         CITEXT,
    nota           TEXT,
    activo         BOOLEAN NOT NULL DEFAULT true,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (restaurante_id, cliente_id)
);
CREATE UNIQUE INDEX uq_cliente_restaurante_usuario  ON cliente_restaurante (restaurante_id, usuario_id) WHERE usuario_id IS NOT NULL;
CREATE UNIQUE INDEX uq_cliente_restaurante_telefono ON cliente_restaurante (restaurante_id, telefono_e164) WHERE telefono_e164 IS NOT NULL;
CREATE INDEX idx_cliente_usuario     ON cliente_restaurante (usuario_id) WHERE usuario_id IS NOT NULL;
CREATE INDEX idx_cliente_nombre_trgm ON cliente_restaurante USING gin (nombre gin_trgm_ops);

-- =============================================================================
-- 6. MENÚ
-- =============================================================================
CREATE TABLE plato (
    plato_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    categoria      categoria_plato_enum NOT NULL,
    seccion        seccion_menu_enum,                 -- sección habitual dentro del almuerzo
    nombre         TEXT NOT NULL CHECK (btrim(nombre) <> ''),
    descripcion    TEXT,
    precio_centavos BIGINT CHECK (precio_centavos >= 0),  -- NULL = solo se sirve dentro del almuerzo
    foto_url       TEXT,
    etiquetas      TEXT[] NOT NULL DEFAULT '{}',      -- vegetariano, sin gluten, picante…
    activo         BOOLEAN NOT NULL DEFAULT true,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (restaurante_id, plato_id)
);
CREATE INDEX idx_plato_restaurante ON plato (restaurante_id, categoria) WHERE activo;

CREATE TABLE menu_diario_cabecera (
    menu_diario_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    fecha_local    DATE NOT NULL,
    publicado_en   TIMESTAMPTZ,
    publicado_por_personal_id BIGINT REFERENCES personal_restaurante(personal_id),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (restaurante_id, fecha_local),
    UNIQUE (restaurante_id, menu_diario_id)
);

CREATE TABLE menu_diario_detalle (
    menu_diario_detalle_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    menu_diario_id BIGINT NOT NULL,
    restaurante_id BIGINT NOT NULL,
    plato_id       BIGINT NOT NULL,
    seccion        seccion_menu_enum NOT NULL,
    precio_centavos BIGINT CHECK (precio_centavos >= 0),   -- precio de ese día si difiere del catálogo
    porciones      INTEGER CHECK (porciones >= 0),         -- NULL = sin límite
    agotado        BOOLEAN NOT NULL DEFAULT false,
    agotado_en     TIMESTAMPTZ,                            -- a qué hora se acabó: dato clave para predecir demanda
    orden          SMALLINT NOT NULL DEFAULT 0,
    FOREIGN KEY (restaurante_id, menu_diario_id) REFERENCES menu_diario_cabecera(restaurante_id, menu_diario_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, plato_id)       REFERENCES plato(restaurante_id, plato_id) ON DELETE RESTRICT,
    UNIQUE (menu_diario_id, plato_id),
    CHECK (agotado OR agotado_en IS NULL)
);
CREATE INDEX idx_menu_detalle_plato ON menu_diario_detalle (plato_id);

-- =============================================================================
-- 7. PLANES DE ALMUERZO (lo que el restaurante vende a sus comensales)
-- =============================================================================
CREATE TABLE plantilla_plan (
    plantilla_plan_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    tipo           tipo_plan_enum NOT NULL,
    nombre         TEXT NOT NULL CHECK (btrim(nombre) <> ''),
    almuerzos      INTEGER NOT NULL CHECK (almuerzos > 0),
    precio_centavos BIGINT NOT NULL CHECK (precio_centavos >= 0),
    vigencia_dias  INTEGER NOT NULL CHECK (vigencia_dias > 0),
    cupos          INTEGER CHECK (cupos > 0),                   -- NULL = sin límite
    dias_validos   SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}'    -- ISO: 1 = lunes … 7 = domingo
                   CHECK (dias_validos <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[] AND cardinality(dias_validos) > 0),
    incluye        TEXT[] NOT NULL DEFAULT '{}',
    visible_en_marketplace BOOLEAN NOT NULL DEFAULT false,
    activo         BOOLEAN NOT NULL DEFAULT true,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (restaurante_id, plantilla_plan_id)
);
CREATE INDEX idx_plantilla_plan_restaurante ON plantilla_plan (restaurante_id) WHERE activo;

-- Cada compra es una fila propia: nunca se suman vencimientos (regla del prototipo).
-- Guarda una foto de las condiciones compradas: si el dueño edita la plantilla,
-- lo ya vendido no cambia.
CREATE TABLE suscripcion_plan (
    suscripcion_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    restaurante_id    BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    cliente_id        BIGINT NOT NULL,
    plantilla_plan_id BIGINT,                                  -- NULL en cartulinas migradas sin plantilla
    origen            origen_suscripcion_enum NOT NULL DEFAULT 'VENTA',
    nombre_plan       TEXT NOT NULL,
    almuerzos_totales   INTEGER NOT NULL CHECK (almuerzos_totales > 0),
    almuerzos_restantes INTEGER NOT NULL,
    precio_pagado_centavos   BIGINT NOT NULL CHECK (precio_pagado_centavos >= 0),
    precio_unitario_centavos BIGINT NOT NULL CHECK (precio_unitario_centavos >= 0),  -- valor de cada almuerzo (pasivo)
    moneda_codigo     CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    dias_validos      SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}'
                      CHECK (dias_validos <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[] AND cardinality(dias_validos) > 0),
    comprada_en       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    vence_el          DATE NOT NULL,                           -- último día válido, en hora local del restaurante
    estado            estado_suscripcion_enum NOT NULL DEFAULT 'ACTIVA',
    vendida_por_personal_id BIGINT REFERENCES personal_restaurante(personal_id),
    anotacion         TEXT,
    anulada_en        TIMESTAMPTZ,
    actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, cliente_id)        REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, plantilla_plan_id) REFERENCES plantilla_plan(restaurante_id, plantilla_plan_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, suscripcion_id),
    CHECK (almuerzos_restantes BETWEEN 0 AND almuerzos_totales),
    CHECK (estado <> 'ACTIVA'  OR almuerzos_restantes > 0),
    CHECK (estado <> 'AGOTADA' OR almuerzos_restantes = 0),
    CHECK ((estado = 'ANULADA') = (anulada_en IS NOT NULL))
);
-- FIFO: el consumo descuenta del plan activo que vence primero.
CREATE INDEX idx_suscripcion_fifo ON suscripcion_plan (cliente_id, vence_el, suscripcion_id) WHERE estado = 'ACTIVA';
CREATE INDEX idx_suscripcion_restaurante_estado ON suscripcion_plan (restaurante_id, estado, vence_el);

CREATE TABLE solicitud_plan (
    solicitud_plan_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id    BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    cliente_id        BIGINT NOT NULL,
    plantilla_plan_id BIGINT NOT NULL,
    estado            estado_solicitud_plan_enum NOT NULL DEFAULT 'PENDIENTE',
    suscripcion_id    BIGINT REFERENCES suscripcion_plan(suscripcion_id),
    creada_en         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resuelta_en       TIMESTAMPTZ,
    FOREIGN KEY (restaurante_id, cliente_id)        REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, plantilla_plan_id) REFERENCES plantilla_plan(restaurante_id, plantilla_plan_id) ON DELETE RESTRICT,
    CHECK ((estado = 'COBRADA') = (suscripcion_id IS NOT NULL))
);
CREATE INDEX idx_solicitud_plan_pendiente ON solicitud_plan (restaurante_id, creada_en) WHERE estado = 'PENDIENTE';

-- =============================================================================
-- 8. PREÓRDENES Y MESAS COMPARTIDAS
-- =============================================================================
CREATE TABLE mesa_compartida (
    mesa_compartida_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,   -- va en el link/QR de invitación
    restaurante_id     BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    anfitrion_usuario_id BIGINT NOT NULL REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    mesa_local_id      BIGINT,
    hora_llegada       TIMESTAMPTZ NOT NULL,
    modo               modo_mesa_enum NOT NULL DEFAULT 'CADA_UNO',
    estado             estado_mesa_enum NOT NULL DEFAULT 'ABIERTA',
    creada_en          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    avisada_cocina_en  TIMESTAMPTZ,
    validada_en        TIMESTAMPTZ,
    validada_por_personal_id BIGINT REFERENCES personal_restaurante(personal_id),
    FOREIGN KEY (restaurante_id, mesa_local_id) REFERENCES mesa_local(restaurante_id, mesa_local_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, mesa_compartida_id)
);
CREATE INDEX idx_mesa_compartida_abiertas ON mesa_compartida (restaurante_id, hora_llegada) WHERE estado IN ('ABIERTA', 'EN_CAMINO', 'EN_MESA');

CREATE TABLE mesa_compartida_miembro (
    miembro_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mesa_compartida_id BIGINT NOT NULL REFERENCES mesa_compartida(mesa_compartida_id) ON DELETE RESTRICT,
    restaurante_id     BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    usuario_id         BIGINT REFERENCES usuario(usuario_id) ON DELETE RESTRICT,   -- NULL = invitado sin cuenta
    nombre             TEXT NOT NULL,
    es_anfitrion       BOOLEAN NOT NULL DEFAULT false,
    sopa_plato_id      BIGINT REFERENCES plato(plato_id),
    fuerte_plato_id    BIGINT REFERENCES plato(plato_id),
    para_llevar        BOOLEAN NOT NULL DEFAULT false,
    unido_en           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uq_mesa_miembro_usuario   ON mesa_compartida_miembro (mesa_compartida_id, usuario_id) WHERE usuario_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mesa_miembro_anfitrion ON mesa_compartida_miembro (mesa_compartida_id) WHERE es_anfitrion;
CREATE INDEX idx_mesa_miembro_usuario ON mesa_compartida_miembro (usuario_id) WHERE usuario_id IS NOT NULL;

CREATE TABLE orden_cabecera (
    orden_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,     -- contenido del QR del pedido
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    usuario_id     BIGINT NOT NULL REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    cliente_id     BIGINT,
    mesa_compartida_id BIGINT,
    numero_dia     INTEGER NOT NULL CHECK (numero_dia > 0),            -- "Pedido #N" del día
    fecha_local    DATE NOT NULL,
    tipo           tipo_orden_enum NOT NULL DEFAULT 'AQUI',
    subtotal_centavos       BIGINT NOT NULL CHECK (subtotal_centavos >= 0),
    recargo_llevar_centavos BIGINT NOT NULL DEFAULT 0 CHECK (recargo_llevar_centavos >= 0),
    total_centavos BIGINT NOT NULL,
    moneda_codigo  CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    estado         estado_orden_enum NOT NULL DEFAULT 'EN_CAMINO',
    creada_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    vence_en       TIMESTAMPTZ NOT NULL,
    canjeada_en    TIMESTAMPTZ,
    servida_en     TIMESTAMPTZ,
    cancelada_en   TIMESTAMPTZ,
    FOREIGN KEY (restaurante_id, cliente_id)         REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, mesa_compartida_id) REFERENCES mesa_compartida(restaurante_id, mesa_compartida_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, orden_id),
    UNIQUE (restaurante_id, fecha_local, numero_dia),
    CHECK (total_centavos = subtotal_centavos + recargo_llevar_centavos),
    CHECK (vence_en > creada_en)
);
CREATE INDEX idx_orden_pendientes ON orden_cabecera (restaurante_id, creada_en) WHERE estado IN ('EN_CAMINO', 'CANJEADA');
CREATE INDEX idx_orden_usuario    ON orden_cabecera (usuario_id, creada_en DESC);

CREATE TABLE orden_detalle (
    orden_detalle_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    orden_id       BIGINT NOT NULL,
    restaurante_id BIGINT NOT NULL,
    plato_id       BIGINT NOT NULL,
    seccion        seccion_menu_enum,
    nombre_plato   TEXT NOT NULL,                      -- foto del nombre al momento del pedido
    cantidad       INTEGER NOT NULL DEFAULT 1 CHECK (cantidad > 0),
    precio_unitario_centavos BIGINT NOT NULL DEFAULT 0 CHECK (precio_unitario_centavos >= 0),
    FOREIGN KEY (restaurante_id, orden_id) REFERENCES orden_cabecera(restaurante_id, orden_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, plato_id) REFERENCES plato(restaurante_id, plato_id) ON DELETE RESTRICT
);
CREATE INDEX idx_orden_detalle_orden ON orden_detalle (orden_id);
CREATE INDEX idx_orden_detalle_plato ON orden_detalle (plato_id);

-- =============================================================================
-- 9. VENTAS POS, CONSUMOS (VALIDACIONES) Y PAGOS
-- =============================================================================
CREATE TABLE venta_pos_cabecera (
    venta_pos_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    fecha_local    DATE NOT NULL,
    ticket         INTEGER NOT NULL CHECK (ticket > 0),
    modo           modo_venta_pos_enum NOT NULL DEFAULT 'DIRECTA',
    cliente_id     BIGINT,
    mesa_local_id  BIGINT,
    mesa_texto     VARCHAR(20),
    orden_id       BIGINT,
    para_llevar    BOOLEAN NOT NULL DEFAULT false,
    total_centavos BIGINT NOT NULL,                    -- negativo solo en reversos
    moneda_codigo  CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    personal_id    BIGINT NOT NULL,
    clave_idempotencia UUID NOT NULL,
    revierte_a_venta_pos_id BIGINT REFERENCES venta_pos_cabecera(venta_pos_id),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, cliente_id)    REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, mesa_local_id) REFERENCES mesa_local(restaurante_id, mesa_local_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, orden_id)      REFERENCES orden_cabecera(restaurante_id, orden_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, personal_id)   REFERENCES personal_restaurante(restaurante_id, personal_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, venta_pos_id),
    UNIQUE (restaurante_id, fecha_local, ticket),
    UNIQUE (restaurante_id, clave_idempotencia),
    CHECK ((revierte_a_venta_pos_id IS NULL AND total_centavos >= 0) OR (revierte_a_venta_pos_id IS NOT NULL AND total_centavos <= 0))
);
CREATE UNIQUE INDEX uq_venta_pos_un_solo_reverso ON venta_pos_cabecera (revierte_a_venta_pos_id) WHERE revierte_a_venta_pos_id IS NOT NULL;
CREATE INDEX idx_venta_pos_fecha ON venta_pos_cabecera (restaurante_id, creado_en DESC);

CREATE TABLE venta_pos_detalle (
    venta_pos_detalle_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venta_pos_id   BIGINT NOT NULL,
    restaurante_id BIGINT NOT NULL,
    plato_id       BIGINT,                             -- NULL en "cobro suelto" sin plato
    nombre_item    TEXT NOT NULL,
    es_almuerzo    BOOLEAN NOT NULL DEFAULT false,
    cantidad       INTEGER NOT NULL CHECK (cantidad <> 0),
    precio_unitario_centavos BIGINT NOT NULL CHECK (precio_unitario_centavos >= 0),
    subtotal_centavos BIGINT NOT NULL,
    FOREIGN KEY (restaurante_id, venta_pos_id) REFERENCES venta_pos_cabecera(restaurante_id, venta_pos_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, plato_id)     REFERENCES plato(restaurante_id, plato_id) ON DELETE RESTRICT,
    CHECK (subtotal_centavos = cantidad * precio_unitario_centavos)
);
CREATE INDEX idx_venta_pos_detalle_venta ON venta_pos_detalle (venta_pos_id);
CREATE INDEX idx_venta_pos_detalle_plato ON venta_pos_detalle (plato_id) WHERE plato_id IS NOT NULL;

-- Tabla de hechos central: un almuerzo descontado de un plan.
CREATE TABLE consumo_almuerzo (
    consumo_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    suscripcion_id BIGINT NOT NULL,
    cliente_id     BIGINT NOT NULL,
    personal_id    BIGINT NOT NULL,
    canal          canal_consumo_enum NOT NULL DEFAULT 'QR',
    para_llevar    BOOLEAN NOT NULL DEFAULT false,
    orden_id       BIGINT,
    mesa_compartida_id BIGINT,
    mesa_local_id  BIGINT,
    cantidad       SMALLINT NOT NULL DEFAULT 1 CHECK (cantidad IN (1, -1)),   -- -1 = reverso
    valor_unitario_centavos BIGINT NOT NULL CHECK (valor_unitario_centavos >= 0),
    clave_idempotencia UUID NOT NULL,
    revierte_a_consumo_id BIGINT REFERENCES consumo_almuerzo(consumo_id),
    motivo_reverso TEXT,
    fecha_local    DATE NOT NULL,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, suscripcion_id)     REFERENCES suscripcion_plan(restaurante_id, suscripcion_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, cliente_id)         REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, personal_id)        REFERENCES personal_restaurante(restaurante_id, personal_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, orden_id)           REFERENCES orden_cabecera(restaurante_id, orden_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, mesa_compartida_id) REFERENCES mesa_compartida(restaurante_id, mesa_compartida_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, mesa_local_id)      REFERENCES mesa_local(restaurante_id, mesa_local_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, consumo_id),
    UNIQUE (restaurante_id, clave_idempotencia),
    CHECK ((cantidad = 1) = (revierte_a_consumo_id IS NULL))
);
CREATE UNIQUE INDEX uq_consumo_un_solo_reverso ON consumo_almuerzo (revierte_a_consumo_id) WHERE revierte_a_consumo_id IS NOT NULL;
CREATE INDEX idx_consumo_restaurante_fecha ON consumo_almuerzo (restaurante_id, fecha_local);
CREATE INDEX idx_consumo_restaurante_hora  ON consumo_almuerzo (restaurante_id, creado_en DESC);   -- ocupación (últimos 25 min) y horas pico
CREATE INDEX idx_consumo_cliente           ON consumo_almuerzo (cliente_id, creado_en DESC);
CREATE INDEX idx_consumo_suscripcion       ON consumo_almuerzo (suscripcion_id);

-- Todos los intentos de escaneo, incluidos los rechazados: mide fraude, fricción en caja
-- y oportunidades de venta ("vino sin plan").
CREATE TABLE intento_escaneo (
    intento_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    personal_id    BIGINT REFERENCES personal_restaurante(personal_id),
    cliente_id     BIGINT REFERENCES cliente_restaurante(cliente_id),
    usuario_id     BIGINT REFERENCES usuario(usuario_id),
    canal          canal_consumo_enum NOT NULL,
    resultado      resultado_escaneo_enum NOT NULL,
    consumo_id     BIGINT REFERENCES consumo_almuerzo(consumo_id),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_intento_restaurante ON intento_escaneo (restaurante_id, creado_en DESC);

CREATE TABLE oferta_flash (
    oferta_flash_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    plato_id       BIGINT,
    titulo         TEXT NOT NULL CHECK (btrim(titulo) <> ''),
    descripcion    TEXT,
    precio_centavos          BIGINT NOT NULL CHECK (precio_centavos >= 0),
    precio_original_centavos BIGINT NOT NULL CHECK (precio_original_centavos > 0),
    moneda_codigo  CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    stock_total    INTEGER NOT NULL CHECK (stock_total > 0),
    stock_restante INTEGER NOT NULL,
    inicia_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expira_en      TIMESTAMPTZ NOT NULL,
    activa         BOOLEAN NOT NULL DEFAULT true,
    creada_por_personal_id BIGINT REFERENCES personal_restaurante(personal_id),
    creada_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, plato_id) REFERENCES plato(restaurante_id, plato_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, oferta_flash_id),
    CHECK (stock_restante BETWEEN 0 AND stock_total),
    CHECK (precio_centavos < precio_original_centavos),
    CHECK (expira_en > inicia_en)
);
CREATE INDEX idx_oferta_flash_vigentes ON oferta_flash (restaurante_id, expira_en) WHERE activa;

CREATE TABLE canje_oferta_flash (
    canje_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id  BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    oferta_flash_id BIGINT NOT NULL,
    usuario_id      BIGINT REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    personal_id     BIGINT NOT NULL,
    cantidad        INTEGER NOT NULL DEFAULT 1 CHECK (cantidad > 0),
    monto_centavos  BIGINT NOT NULL CHECK (monto_centavos >= 0),
    clave_idempotencia UUID NOT NULL,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, oferta_flash_id) REFERENCES oferta_flash(restaurante_id, oferta_flash_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, personal_id)     REFERENCES personal_restaurante(restaurante_id, personal_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, canje_id),
    UNIQUE (restaurante_id, clave_idempotencia)
);
CREATE INDEX idx_canje_oferta ON canje_oferta_flash (oferta_flash_id);

-- Todo el dinero que entra al restaurante. Solo-inserción: "deshacer" = fila inversa.
CREATE TABLE transaccion_pago (
    pago_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id      UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    metodo_pago_id BIGINT NOT NULL REFERENCES metodo_pago(metodo_pago_id),
    monto_centavos BIGINT NOT NULL CHECK (monto_centavos <> 0),      -- negativo = reverso
    moneda_codigo  CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    estado         estado_pago_enum NOT NULL DEFAULT 'CONFIRMADO',
    -- origen del cobro (exactamente uno)
    suscripcion_id BIGINT,
    venta_pos_id   BIGINT,
    orden_id       BIGINT,
    canje_oferta_id BIGINT,
    cobrado_por_personal_id BIGINT NOT NULL,
    fecha_local    DATE NOT NULL,
    comprobante_url    TEXT,                                         -- foto de la transferencia
    referencia_externa TEXT,                                         -- id de Deuna / pasarela
    clave_idempotencia UUID NOT NULL,
    revierte_a_pago_id BIGINT REFERENCES transaccion_pago(pago_id),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, suscripcion_id)  REFERENCES suscripcion_plan(restaurante_id, suscripcion_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, venta_pos_id)    REFERENCES venta_pos_cabecera(restaurante_id, venta_pos_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, orden_id)        REFERENCES orden_cabecera(restaurante_id, orden_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, canje_oferta_id) REFERENCES canje_oferta_flash(restaurante_id, canje_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, cobrado_por_personal_id) REFERENCES personal_restaurante(restaurante_id, personal_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, clave_idempotencia),
    CHECK (num_nonnulls(suscripcion_id, venta_pos_id, orden_id, canje_oferta_id) = 1),
    CHECK ((revierte_a_pago_id IS NULL AND monto_centavos > 0) OR (revierte_a_pago_id IS NOT NULL AND monto_centavos < 0))
);
CREATE UNIQUE INDEX uq_pago_un_solo_reverso ON transaccion_pago (revierte_a_pago_id) WHERE revierte_a_pago_id IS NOT NULL;
CREATE UNIQUE INDEX uq_pago_referencia_externa ON transaccion_pago (metodo_pago_id, referencia_externa) WHERE referencia_externa IS NOT NULL AND revierte_a_pago_id IS NULL;
CREATE INDEX idx_pago_restaurante_fecha ON transaccion_pago (restaurante_id, fecha_local, metodo_pago_id);
CREATE INDEX idx_pago_suscripcion ON transaccion_pago (suscripcion_id) WHERE suscripcion_id IS NOT NULL;
CREATE INDEX idx_pago_venta_pos   ON transaccion_pago (venta_pos_id)   WHERE venta_pos_id IS NOT NULL;

CREATE TABLE cierre_caja_cabecera (
    cierre_caja_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    fecha_local    DATE NOT NULL,
    moneda_codigo  CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    efectivo_esperado_centavos BIGINT NOT NULL,
    efectivo_contado_centavos  BIGINT NOT NULL CHECK (efectivo_contado_centavos >= 0),
    diferencia_centavos BIGINT GENERATED ALWAYS AS (efectivo_contado_centavos - efectivo_esperado_centavos) STORED,
    almuerzos_servidos  INTEGER NOT NULL DEFAULT 0 CHECK (almuerzos_servidos >= 0),
    almuerzos_para_llevar INTEGER NOT NULL DEFAULT 0 CHECK (almuerzos_para_llevar >= 0),
    nota           TEXT,
    cerrado_por_personal_id BIGINT NOT NULL,
    cerrado_en     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activo         BOOLEAN NOT NULL DEFAULT true,
    FOREIGN KEY (restaurante_id, cerrado_por_personal_id) REFERENCES personal_restaurante(restaurante_id, personal_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, cierre_caja_id)
);
CREATE UNIQUE INDEX uq_cierre_caja_dia ON cierre_caja_cabecera (restaurante_id, fecha_local) WHERE activo;

CREATE TABLE cierre_caja_detalle (
    cierre_caja_detalle_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cierre_caja_id BIGINT NOT NULL,
    restaurante_id BIGINT NOT NULL,
    metodo_pago_id BIGINT NOT NULL REFERENCES metodo_pago(metodo_pago_id),
    planes_centavos BIGINT NOT NULL DEFAULT 0,
    pos_centavos    BIGINT NOT NULL DEFAULT 0,
    FOREIGN KEY (restaurante_id, cierre_caja_id) REFERENCES cierre_caja_cabecera(restaurante_id, cierre_caja_id) ON DELETE RESTRICT,
    UNIQUE (cierre_caja_id, metodo_pago_id)
);

-- =============================================================================
-- 10. FIDELIZACIÓN, OPINIONES Y RECLAMOS
-- =============================================================================
CREATE TABLE tarjeta_sellos_config (
    restaurante_id BIGINT PRIMARY KEY REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    nombre         TEXT,
    activa         BOOLEAN NOT NULL DEFAULT false,
    meta           INTEGER NOT NULL CHECK (meta > 0),
    premio         TEXT NOT NULL,
    cuenta         cuenta_sello_enum NOT NULL DEFAULT 'ALMUERZO',
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tarjeta_sellos_cliente (
    restaurante_id BIGINT NOT NULL,
    cliente_id     BIGINT NOT NULL,
    sellos         INTEGER NOT NULL DEFAULT 0 CHECK (sellos >= 0),
    premios_disponibles INTEGER NOT NULL DEFAULT 0 CHECK (premios_disponibles >= 0),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (restaurante_id, cliente_id),
    FOREIGN KEY (restaurante_id, cliente_id) REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT
);

CREATE TABLE movimiento_sello (
    movimiento_sello_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL,
    cliente_id     BIGINT NOT NULL,
    tipo           tipo_movimiento_sello_enum NOT NULL,
    sellos         INTEGER NOT NULL CHECK (sellos <> 0),
    consumo_id     BIGINT REFERENCES consumo_almuerzo(consumo_id),
    venta_pos_id   BIGINT REFERENCES venta_pos_cabecera(venta_pos_id),
    motivo         TEXT,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, cliente_id) REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT
);
CREATE INDEX idx_movimiento_sello_cliente ON movimiento_sello (restaurante_id, cliente_id, creado_en DESC);

-- "¿Qué tal hoy?": una tarjeta por almuerzo validado, 25 min después, caduca a las 24 h.
CREATE TABLE opinion (
    opinion_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL,
    consumo_id     BIGINT NOT NULL,
    cliente_id     BIGINT NOT NULL,
    etiquetas      TEXT[] NOT NULL DEFAULT '{}',
    comentario_privado TEXT,
    descartada     BOOLEAN NOT NULL DEFAULT false,     -- la cerró sin responder
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    respuesta_restaurante TEXT,
    respondido_en  TIMESTAMPTZ,
    respondido_por_personal_id BIGINT REFERENCES personal_restaurante(personal_id),
    FOREIGN KEY (restaurante_id, consumo_id) REFERENCES consumo_almuerzo(restaurante_id, consumo_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, cliente_id) REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT,
    UNIQUE (consumo_id),
    CHECK ((respuesta_restaurante IS NULL) = (respondido_en IS NULL))
);
CREATE INDEX idx_opinion_restaurante ON opinion (restaurante_id, creado_en DESC) WHERE NOT descartada;
CREATE INDEX idx_opinion_etiquetas   ON opinion USING gin (etiquetas);

CREATE TABLE reclamo (
    reclamo_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL,
    consumo_id     BIGINT NOT NULL,
    cliente_id     BIGINT NOT NULL,
    mensaje        TEXT NOT NULL CHECK (btrim(mensaje) <> ''),
    estado         estado_reclamo_enum NOT NULL DEFAULT 'PENDIENTE',
    respuesta      TEXT,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resuelto_en    TIMESTAMPTZ,
    resuelto_por_personal_id BIGINT REFERENCES personal_restaurante(personal_id),
    FOREIGN KEY (restaurante_id, consumo_id) REFERENCES consumo_almuerzo(restaurante_id, consumo_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, cliente_id) REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT,
    CHECK ((estado = 'PENDIENTE') = (resuelto_en IS NULL))
);
CREATE UNIQUE INDEX uq_reclamo_abierto ON reclamo (consumo_id) WHERE estado = 'PENDIENTE';
CREATE INDEX idx_reclamo_restaurante ON reclamo (restaurante_id, estado, creado_en DESC);

-- =============================================================================
-- 11. CAPA SAAS B2B: lo que Bocadoo le cobra al restaurante
-- =============================================================================
CREATE TABLE catalogo_plan_saas (
    plan_saas_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo         VARCHAR(20) NOT NULL UNIQUE,
    nombre         TEXT NOT NULL,
    limite_escaneos_mes INTEGER CHECK (limite_escaneos_mes > 0),          -- NULL = ilimitado
    permite_mesa_grupal        BOOLEAN NOT NULL DEFAULT false,
    permite_reportes_avanzados BOOLEAN NOT NULL DEFAULT false,
    tasa_comision_oferta_flash NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (tasa_comision_oferta_flash BETWEEN 0 AND 100),
    tasa_comision_marketplace  NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (tasa_comision_marketplace BETWEEN 0 AND 100),
    activo         BOOLEAN NOT NULL DEFAULT true,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON COLUMN catalogo_plan_saas.tasa_comision_oferta_flash IS
    'Porcentaje sobre ofertas canjeadas. 0 = modelo solo-suscripción. Se deja configurable por plan porque el modelo de ingresos aún no está cerrado (landing: 5–10 %; prototipo: 7 %).';

-- El precio depende de la moneda/país: un mismo plan no cuesta lo mismo en Quito que en Madrid.
CREATE TABLE plan_saas_precio (
    plan_saas_precio_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plan_saas_id   BIGINT NOT NULL REFERENCES catalogo_plan_saas(plan_saas_id) ON DELETE RESTRICT,
    pais_codigo    CHAR(2) NOT NULL REFERENCES pais(pais_codigo),
    moneda_codigo  CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    precio_mensual_centavos BIGINT NOT NULL CHECK (precio_mensual_centavos >= 0),
    vigente_desde  DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta  DATE,
    CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde),
    UNIQUE (plan_saas_id, pais_codigo, vigente_desde)
);

CREATE TABLE suscripcion_saas_restaurante (
    suscripcion_saas_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    plan_saas_id   BIGINT NOT NULL REFERENCES catalogo_plan_saas(plan_saas_id) ON DELETE RESTRICT,
    estado         estado_suscripcion_saas_enum NOT NULL DEFAULT 'FREEMIUM',
    escaneos_usados_ciclo_actual INTEGER NOT NULL DEFAULT 0 CHECK (escaneos_usados_ciclo_actual >= 0),
    inicio_ciclo_actual DATE NOT NULL DEFAULT CURRENT_DATE,
    fin_ciclo_actual    DATE NOT NULL,
    proximo_cobro  DATE,                                                  -- NULL en planes gratuitos
    vigente        BOOLEAN NOT NULL DEFAULT true,                         -- false = fila histórica
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (restaurante_id, suscripcion_saas_id),
    CHECK (fin_ciclo_actual > inicio_ciclo_actual)
);
-- Una sola suscripción vigente por restaurante, conservando el historial de cambios de plan.
CREATE UNIQUE INDEX uq_suscripcion_saas_vigente ON suscripcion_saas_restaurante (restaurante_id) WHERE vigente;

-- Comisiones devengadas (solo-inserción). Se facturan agrupadas en factura_saas_detalle.
CREATE TABLE libro_comision_bocadoo (
    comision_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    tipo           tipo_comision_enum NOT NULL,
    canje_oferta_id BIGINT,
    suscripcion_id  BIGINT,
    monto_venta_centavos BIGINT NOT NULL CHECK (monto_venta_centavos >= 0),
    tasa_porcentaje      NUMERIC(5, 2) NOT NULL CHECK (tasa_porcentaje BETWEEN 0 AND 100),
    comision_centavos    BIGINT NOT NULL CHECK (comision_centavos >= 0),
    moneda_codigo  CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, canje_oferta_id) REFERENCES canje_oferta_flash(restaurante_id, canje_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, suscripcion_id)  REFERENCES suscripcion_plan(restaurante_id, suscripcion_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, comision_id),
    CHECK (num_nonnulls(canje_oferta_id, suscripcion_id) = 1),
    CHECK (comision_centavos <= monto_venta_centavos)
);
CREATE UNIQUE INDEX uq_comision_canje       ON libro_comision_bocadoo (canje_oferta_id) WHERE canje_oferta_id IS NOT NULL;
CREATE UNIQUE INDEX uq_comision_suscripcion ON libro_comision_bocadoo (suscripcion_id)  WHERE suscripcion_id IS NOT NULL;
CREATE INDEX idx_comision_restaurante ON libro_comision_bocadoo (restaurante_id, creado_en DESC);

CREATE TABLE factura_saas_cabecera (
    factura_saas_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurante_id  BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    suscripcion_saas_id BIGINT NOT NULL,
    numero_comprobante  VARCHAR(30) NOT NULL UNIQUE,
    periodo_desde   DATE NOT NULL,
    periodo_hasta   DATE NOT NULL,
    fecha_emision   DATE NOT NULL DEFAULT CURRENT_DATE,
    fecha_vencimiento DATE NOT NULL,
    moneda_codigo   CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    subtotal_centavos  BIGINT NOT NULL CHECK (subtotal_centavos >= 0),
    impuestos_centavos BIGINT NOT NULL DEFAULT 0 CHECK (impuestos_centavos >= 0),
    total_centavos  BIGINT NOT NULL,
    estado          estado_factura_saas_enum NOT NULL DEFAULT 'PENDIENTE',
    metodo_pago_id  BIGINT REFERENCES metodo_pago(metodo_pago_id),
    referencia_pago TEXT,
    pagada_en       TIMESTAMPTZ,
    creada_en       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurante_id, suscripcion_saas_id) REFERENCES suscripcion_saas_restaurante(restaurante_id, suscripcion_saas_id) ON DELETE RESTRICT,
    UNIQUE (restaurante_id, factura_saas_id),
    CHECK (total_centavos = subtotal_centavos + impuestos_centavos),
    CHECK (periodo_hasta >= periodo_desde),
    CHECK (fecha_vencimiento >= fecha_emision),
    CHECK ((estado = 'PAGADA') = (pagada_en IS NOT NULL))
);
CREATE INDEX idx_factura_saas_restaurante_estado ON factura_saas_cabecera (restaurante_id, estado);

CREATE TABLE factura_saas_detalle (
    factura_saas_detalle_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    factura_saas_id BIGINT NOT NULL,
    restaurante_id  BIGINT NOT NULL,
    concepto        concepto_factura_saas_enum NOT NULL,
    descripcion     TEXT NOT NULL,
    cantidad        INTEGER NOT NULL DEFAULT 1 CHECK (cantidad > 0),
    precio_unitario_centavos BIGINT NOT NULL,                    -- puede ser negativo solo en AJUSTE
    subtotal_linea_centavos  BIGINT NOT NULL,
    comision_origen_id BIGINT,
    FOREIGN KEY (restaurante_id, factura_saas_id)    REFERENCES factura_saas_cabecera(restaurante_id, factura_saas_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, comision_origen_id) REFERENCES libro_comision_bocadoo(restaurante_id, comision_id) ON DELETE RESTRICT,
    CHECK (subtotal_linea_centavos = cantidad * precio_unitario_centavos),
    CHECK (precio_unitario_centavos >= 0 OR concepto = 'AJUSTE')
);
CREATE INDEX idx_factura_saas_detalle_factura ON factura_saas_detalle (factura_saas_id);
-- Una comisión no puede facturarse dos veces.
CREATE UNIQUE INDEX uq_factura_detalle_comision ON factura_saas_detalle (comision_origen_id) WHERE comision_origen_id IS NOT NULL;

-- =============================================================================
-- 12. WALLET "BOCADOO CASH"
-- OJO LEGAL: guardar dinero de usuarios es actividad regulada (dinero electrónico)
-- en casi todos los países. La estructura queda lista, pero no se activa en
-- producción sin un socio regulado (banco / pasarela) por país.
-- =============================================================================
CREATE TABLE billetera_comensal (
    billetera_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_id     BIGINT NOT NULL REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    moneda_codigo  CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    saldo_real_centavos BIGINT NOT NULL DEFAULT 0 CHECK (saldo_real_centavos >= 0),   -- dinero recargado (reembolsable)
    saldo_bono_centavos BIGINT NOT NULL DEFAULT 0 CHECK (saldo_bono_centavos >= 0),   -- bono promocional (no reembolsable)
    saldo_total_centavos BIGINT GENERATED ALWAYS AS (saldo_real_centavos + saldo_bono_centavos) STORED,
    activa         BOOLEAN NOT NULL DEFAULT true,
    creada_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizada_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (usuario_id, moneda_codigo)                           -- una billetera por moneda: nunca se mezclan divisas
);

-- Libro mayor de la wallet. El saldo de billetera_comensal SOLO cambia a través de
-- inserciones aquí (trigger), así que saldo y movimientos no pueden descuadrarse.
CREATE TABLE billetera_movimiento (
    movimiento_billetera_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    billetera_id   BIGINT NOT NULL REFERENCES billetera_comensal(billetera_id) ON DELETE RESTRICT,
    tipo_movimiento tipo_movimiento_wallet_enum NOT NULL,
    monto_real_centavos BIGINT NOT NULL DEFAULT 0,               -- con signo: + entra, − sale
    monto_bono_centavos BIGINT NOT NULL DEFAULT 0,
    saldo_real_despues_centavos BIGINT NOT NULL,                 -- los llena el trigger
    saldo_bono_despues_centavos BIGINT NOT NULL,
    restaurante_id BIGINT REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,   -- NULL en recargas
    metodo_pago_id BIGINT REFERENCES metodo_pago(metodo_pago_id),
    pago_id        BIGINT REFERENCES transaccion_pago(pago_id) ON DELETE RESTRICT,     -- cobro que generó en el restaurante
    movimiento_origen_id BIGINT REFERENCES billetera_movimiento(movimiento_billetera_id),  -- reembolso de…
    referencia_externa TEXT,
    clave_idempotencia UUID NOT NULL,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (billetera_id, clave_idempotencia),
    CHECK (monto_real_centavos <> 0 OR monto_bono_centavos <> 0),
    CHECK (CASE tipo_movimiento
             WHEN 'RECARGA_USUARIO'  THEN monto_real_centavos > 0 AND monto_bono_centavos = 0 AND metodo_pago_id IS NOT NULL
             WHEN 'BONO_PROMOCIONAL' THEN monto_bono_centavos > 0 AND monto_real_centavos = 0
             WHEN 'PAGO_CONSUMO'     THEN monto_real_centavos <= 0 AND monto_bono_centavos <= 0 AND restaurante_id IS NOT NULL
             WHEN 'REEMBOLSO'        THEN monto_real_centavos >= 0 AND monto_bono_centavos >= 0 AND movimiento_origen_id IS NOT NULL
             WHEN 'EXPIRACION_BONO'  THEN monto_bono_centavos < 0 AND monto_real_centavos = 0
           END)
);
CREATE INDEX idx_billetera_movimiento_fecha ON billetera_movimiento (billetera_id, creado_en DESC);
CREATE INDEX idx_billetera_movimiento_restaurante ON billetera_movimiento (restaurante_id, creado_en DESC) WHERE restaurante_id IS NOT NULL;
CREATE UNIQUE INDEX uq_billetera_referencia_externa ON billetera_movimiento (metodo_pago_id, referencia_externa) WHERE referencia_externa IS NOT NULL;

CREATE FUNCTION fn_aplicar_movimiento_billetera() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- El UPDATE bloquea la fila de la billetera: dos pagos simultáneos se serializan
    -- y el CHECK (saldo >= 0) rechaza el que deje el saldo en negativo.
    UPDATE billetera_comensal
       SET saldo_real_centavos = saldo_real_centavos + NEW.monto_real_centavos,
           saldo_bono_centavos = saldo_bono_centavos + NEW.monto_bono_centavos,
           actualizada_en      = CURRENT_TIMESTAMP
     WHERE billetera_id = NEW.billetera_id AND activa
    RETURNING saldo_real_centavos, saldo_bono_centavos
         INTO NEW.saldo_real_despues_centavos, NEW.saldo_bono_despues_centavos;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Billetera % inexistente o inactiva', NEW.billetera_id;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_billetera_aplicar_movimiento
BEFORE INSERT ON billetera_movimiento
FOR EACH ROW EXECUTE FUNCTION fn_aplicar_movimiento_billetera();

-- =============================================================================
-- 13. LEADS, AUDITORÍA Y EVENTOS (particionados por mes: crecen sin límite)
-- =============================================================================
CREATE TABLE lead_landing (
    lead_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre         TEXT NOT NULL,
    nombre_restaurante TEXT NOT NULL,
    whatsapp       TEXT NOT NULL,
    origen         TEXT NOT NULL DEFAULT 'landing',
    utm            JSONB NOT NULL DEFAULT '{}',
    contactado_en  TIMESTAMPTZ,
    restaurante_id BIGINT REFERENCES restaurante(restaurante_id),      -- si se convirtió en cliente
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE log_actividad (
    log_id         BIGINT GENERATED ALWAYS AS IDENTITY,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ejecutado_por_usuario_id BIGINT,                   -- NULL = proceso del sistema (no se inventa un usuario)
    tenant_restaurante_id    BIGINT,
    accion         accion_auditoria_enum NOT NULL,
    entidad_afectada    TEXT NOT NULL,
    entidad_registro_id BIGINT,
    detalle_payload     JSONB NOT NULL,
    PRIMARY KEY (log_id, creado_en)
) PARTITION BY RANGE (creado_en);
CREATE INDEX idx_log_actividad_tenant  ON log_actividad (tenant_restaurante_id, creado_en DESC);
CREATE INDEX idx_log_actividad_entidad ON log_actividad (entidad_afectada, entidad_registro_id);

-- Eventos de producto: la materia prima para analítica e IA (qué miró, qué buscó,
-- qué oferta vio y no canjeó, desde dónde). Lo transaccional ya vive en sus tablas.
CREATE TABLE evento_analitica (
    evento_id      BIGINT GENERATED ALWAYS AS IDENTITY,
    ocurrido_en    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tipo           TEXT NOT NULL CHECK (tipo ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),  -- ej. menu.visto, oferta.impresion
    usuario_id     BIGINT,
    restaurante_id BIGINT,
    sesion_id      UUID,
    plataforma     plataforma_enum,
    version_app    TEXT,
    pais_codigo    CHAR(2),
    ciudad_id      BIGINT,
    zona_id        BIGINT,
    propiedades    JSONB NOT NULL DEFAULT '{}',
    recibido_en    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (evento_id, ocurrido_en)
) PARTITION BY RANGE (ocurrido_en);
CREATE INDEX idx_evento_tipo        ON evento_analitica (tipo, ocurrido_en DESC);
CREATE INDEX idx_evento_restaurante ON evento_analitica (restaurante_id, ocurrido_en DESC) WHERE restaurante_id IS NOT NULL;
CREATE INDEX idx_evento_usuario     ON evento_analitica (usuario_id, ocurrido_en DESC) WHERE usuario_id IS NOT NULL;
CREATE INDEX idx_evento_propiedades ON evento_analitica USING gin (propiedades jsonb_path_ops);

CREATE TABLE log_actividad_default    PARTITION OF log_actividad DEFAULT;
CREATE TABLE evento_analitica_default PARTITION OF evento_analitica DEFAULT;

-- Crea la partición del mes de p_mes. Programar una vez al mes (pg_cron o cron del backend).
CREATE FUNCTION fn_crear_particion_mensual(p_tabla TEXT, p_mes DATE) RETURNS VOID
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

DO $$
DECLARE i INT;
BEGIN
    FOR i IN 0..3 LOOP
        PERFORM fn_crear_particion_mensual('log_actividad',    (CURRENT_DATE + make_interval(months => i))::DATE);
        PERFORM fn_crear_particion_mensual('evento_analitica', (CURRENT_DATE + make_interval(months => i))::DATE);
    END LOOP;
END $$;

-- =============================================================================
-- 14. AUDITORÍA UNIVERSAL (JSONB antes/después)
-- =============================================================================
CREATE FUNCTION fn_registrar_auditoria_universal() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fila     JSONB;
    v_accion   accion_auditoria_enum;
    v_payload  JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_accion  := 'CREAR';
        v_fila    := to_jsonb(NEW);
        v_payload := jsonb_build_object('despues', v_fila);
    ELSIF TG_OP = 'UPDATE' THEN
        v_fila := to_jsonb(NEW);
        IF to_jsonb(OLD) = v_fila THEN
            RETURN NULL;                                   -- UPDATE sin cambios: no ensucia el log
        END IF;
        -- Funciona en tablas con y sin columna "activo".
        IF (to_jsonb(OLD) ->> 'activo') = 'true' AND (v_fila ->> 'activo') = 'false' THEN
            v_accion := 'DESACTIVAR';
        ELSE
            v_accion := 'EDITAR';
        END IF;
        v_payload := jsonb_build_object('antes', to_jsonb(OLD), 'despues', v_fila);
    ELSE
        v_accion  := 'ELIMINAR';
        v_fila    := to_jsonb(OLD);
        v_payload := jsonb_build_object('antes', v_fila);
    END IF;

    INSERT INTO log_actividad (ejecutado_por_usuario_id, tenant_restaurante_id, accion,
                               entidad_afectada, entidad_registro_id, detalle_payload)
    VALUES (app_user_id(),
            COALESCE(app_tenant_id(), (v_fila ->> 'restaurante_id')::BIGINT),
            v_accion, TG_TABLE_NAME, (v_fila ->> TG_ARGV[0])::BIGINT, v_payload);
    RETURN NULL;   -- trigger AFTER: el valor de retorno se ignora
END $$;

-- Se audita lo que mueve dinero, saldo o configuración. Los libros de solo-inserción
-- (consumos, wallet, comisiones) ya son su propio registro: auditarlos sería duplicar.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('restaurante', 'restaurante_id'),
        ('personal_restaurante', 'personal_id'),
        ('plantilla_plan', 'plantilla_plan_id'),
        ('suscripcion_plan', 'suscripcion_id'),
        ('transaccion_pago', 'pago_id'),
        ('cierre_caja_cabecera', 'cierre_caja_id'),
        ('oferta_flash', 'oferta_flash_id'),
        ('reclamo', 'reclamo_id'),
        ('suscripcion_saas_restaurante', 'suscripcion_saas_id'),
        ('factura_saas_cabecera', 'factura_saas_id')
    ) AS t(tabla, pk)
    LOOP
        EXECUTE format('CREATE TRIGGER trg_auditoria_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I
                        FOR EACH ROW EXECUTE FUNCTION fn_registrar_auditoria_universal(%2$L)', r.tabla, r.pk);
    END LOOP;
END $$;

-- actualizado_en automático
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['usuario', 'restaurante', 'cliente_restaurante', 'plato', 'plantilla_plan',
                             'suscripcion_plan', 'tarjeta_sellos_config', 'tarjeta_sellos_cliente',
                             'suscripcion_saas_restaurante']
    LOOP
        EXECUTE format('CREATE TRIGGER trg_tocar_%1$s BEFORE UPDATE ON %1$I
                        FOR EACH ROW EXECUTE FUNCTION fn_tocar_actualizado_en()', t);
    END LOOP;
END $$;

-- Libros de solo-inserción
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['consumo_almuerzo', 'transaccion_pago', 'venta_pos_cabecera', 'venta_pos_detalle',
                             'billetera_movimiento', 'libro_comision_bocadoo', 'movimiento_sello',
                             'canje_oferta_flash', 'intento_escaneo', 'log_actividad']
    LOOP
        EXECUTE format('CREATE TRIGGER trg_solo_insercion_%1$s BEFORE UPDATE OR DELETE ON %1$I
                        FOR EACH ROW EXECUTE FUNCTION fn_solo_insercion()', t);
    END LOOP;
END $$;
-- transaccion_pago admite un único cambio: confirmar/rechazar un pago PENDIENTE (Deuna, transferencia).
DROP TRIGGER trg_solo_insercion_transaccion_pago ON transaccion_pago;
CREATE FUNCTION fn_pago_solo_cambia_estado() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'transaccion_pago no admite DELETE: registra un pago inverso' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.estado <> 'PENDIENTE'
       OR (to_jsonb(NEW) - 'estado' - 'referencia_externa' - 'comprobante_url')
          IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'referencia_externa' - 'comprobante_url') THEN
        RAISE EXCEPTION 'transaccion_pago: solo se puede confirmar o rechazar un pago PENDIENTE' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_pago_solo_cambia_estado BEFORE UPDATE OR DELETE ON transaccion_pago
FOR EACH ROW EXECUTE FUNCTION fn_pago_solo_cambia_estado();

-- =============================================================================
-- 15. OPERACIÓN CENTRAL: DESCONTAR UN ALMUERZO (atómica, FIFO, idempotente)
-- Reglas tomadas del dominio del prototipo (plans.ts / redemption.ts):
--   · descuenta del plan activo que vence primero; nunca suma vencimientos
--   · mismo cliente validado hace < 60 s  -> DUPLICADO (no descuenta)
--   · misma clave de idempotencia          -> devuelve el consumo ya creado
--   · último almuerzo o vence en <= 3 días -> OK_ADVERTENCIA (ofrecer renovar)
-- =============================================================================
CREATE FUNCTION fn_descontar_almuerzo(
    p_restaurante_id BIGINT,
    p_cliente_id     BIGINT,
    p_personal_id    BIGINT,
    p_clave_idempotencia UUID,
    p_canal          canal_consumo_enum DEFAULT 'QR',
    p_para_llevar    BOOLEAN DEFAULT false,
    p_orden_id       BIGINT DEFAULT NULL,
    p_mesa_compartida_id BIGINT DEFAULT NULL
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
    ELSIF EXISTS (SELECT 1 FROM consumo_almuerzo c
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
                                              orden_id, mesa_compartida_id, valor_unitario_centavos,
                                              clave_idempotencia, fecha_local)
                VALUES (p_restaurante_id, v_sus.suscripcion_id, p_cliente_id, p_personal_id, p_canal, p_para_llevar,
                        p_orden_id, p_mesa_compartida_id, v_sus.precio_unitario_centavos,
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

-- "Deshacer" (búfer de 10 s en caja) y devoluciones por reclamo: devuelve el almuerzo al plan.
CREATE FUNCTION fn_revertir_consumo(
    p_restaurante_id BIGINT,
    p_consumo_id     BIGINT,
    p_personal_id    BIGINT,
    p_motivo         TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_c       consumo_almuerzo%ROWTYPE;
    v_tz      TEXT;
    v_hoy     DATE;
    v_reverso BIGINT;
BEGIN
    IF app_tenant_id() IS DISTINCT FROM p_restaurante_id THEN
        RAISE EXCEPTION 'Restaurante fuera del tenant de la sesión' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT c.* INTO v_c FROM consumo_almuerzo c
     WHERE c.restaurante_id = p_restaurante_id AND c.consumo_id = p_consumo_id AND c.cantidad = 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Consumo % no existe en el restaurante %', p_consumo_id, p_restaurante_id;
    END IF;

    SELECT r.zona_horaria INTO v_tz FROM restaurante r WHERE r.restaurante_id = p_restaurante_id;
    v_hoy := (CURRENT_TIMESTAMP AT TIME ZONE v_tz)::DATE;

    -- El índice único uq_consumo_un_solo_reverso impide revertir dos veces.
    INSERT INTO consumo_almuerzo (restaurante_id, suscripcion_id, cliente_id, personal_id, canal, para_llevar,
                                  cantidad, valor_unitario_centavos, clave_idempotencia,
                                  revierte_a_consumo_id, motivo_reverso, fecha_local)
    VALUES (p_restaurante_id, v_c.suscripcion_id, v_c.cliente_id, p_personal_id, v_c.canal, v_c.para_llevar,
            -1, v_c.valor_unitario_centavos, gen_random_uuid(), v_c.consumo_id, p_motivo, v_hoy)
    RETURNING consumo_id INTO v_reverso;

    UPDATE suscripcion_plan s
       SET almuerzos_restantes = s.almuerzos_restantes + 1,
           estado = CASE WHEN s.estado = 'AGOTADA' AND s.vence_el >= v_hoy THEN 'ACTIVA'
                         WHEN s.estado = 'AGOTADA' THEN 'VENCIDA'
                         ELSE s.estado END
     WHERE s.suscripcion_id = v_c.suscripcion_id;

    RETURN v_reverso;
END $$;

-- Tarea diaria (cron con rol bocadoo_servicio): marca planes vencidos según la hora local de cada restaurante.
CREATE FUNCTION fn_vencer_suscripciones() RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE v_n INTEGER;
BEGIN
    UPDATE suscripcion_plan s
       SET estado = 'VENCIDA'
      FROM restaurante r
     WHERE r.restaurante_id = s.restaurante_id
       AND s.estado = 'ACTIVA'
       AND s.vence_el < (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::DATE;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;

-- =============================================================================
-- 16. VISTAS DE NEGOCIO (security_invoker: respetan el RLS de quien consulta)
-- =============================================================================
-- "Almuerzos que debes": pasivo del restaurante con sus comensales.
CREATE VIEW vw_pasivo_almuerzos WITH (security_invoker = true) AS
SELECT s.restaurante_id,
       s.moneda_codigo,
       COUNT(DISTINCT s.cliente_id)                                   AS clientes_con_saldo,
       SUM(s.almuerzos_restantes)                                     AS almuerzos_pendientes,
       SUM(s.almuerzos_restantes * s.precio_unitario_centavos)        AS pasivo_centavos
  FROM suscripcion_plan s
 WHERE s.estado = 'ACTIVA'
 GROUP BY s.restaurante_id, s.moneda_codigo;

-- Almuerzos servidos por día y hora local (horas pico, base de pronóstico de demanda).
CREATE VIEW vw_consumo_por_hora WITH (security_invoker = true) AS
SELECT c.restaurante_id,
       c.fecha_local,
       EXTRACT(ISODOW FROM c.fecha_local)::SMALLINT                              AS dia_semana,
       EXTRACT(HOUR FROM c.creado_en AT TIME ZONE r.zona_horaria)::SMALLINT      AS hora_local,
       SUM(c.cantidad)                                                            AS almuerzos,
       SUM(c.cantidad) FILTER (WHERE c.para_llevar)                               AS para_llevar
  FROM consumo_almuerzo c
  JOIN restaurante r ON r.restaurante_id = c.restaurante_id
 GROUP BY 1, 2, 3, 4;

-- =============================================================================
-- 17. AISLAMIENTO MULTI-TENANT (RLS)
-- Tres clases de tabla:
--   A) privada del tenant           -> solo el restaurante de la sesión
--   B) vitrina (marketplace)        -> cualquiera lee, solo el tenant escribe
--   C) del tenant + su comensal     -> el tenant todo; el comensal lee lo suyo
-- Lo que no tiene política para bocadoo_app solo lo toca bocadoo_servicio
-- (alta de restaurantes, login, facturación SaaS, wallet, cron).
-- =============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    -- A + B + C: política base del tenant
    FOREACH t IN ARRAY ARRAY[
        'restaurante', 'restaurante_horario', 'personal_restaurante', 'mesa_local', 'cliente_restaurante',
        'plato', 'menu_diario_cabecera', 'menu_diario_detalle', 'plantilla_plan', 'suscripcion_plan',
        'solicitud_plan', 'mesa_compartida', 'mesa_compartida_miembro', 'orden_cabecera', 'orden_detalle',
        'venta_pos_cabecera', 'venta_pos_detalle', 'consumo_almuerzo', 'intento_escaneo', 'oferta_flash',
        'canje_oferta_flash', 'transaccion_pago', 'cierre_caja_cabecera', 'cierre_caja_detalle',
        'tarjeta_sellos_config', 'tarjeta_sellos_cliente', 'movimiento_sello', 'opinion', 'reclamo']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY tenant_total ON %I FOR ALL TO bocadoo_app
                        USING (restaurante_id = app_tenant_id()) WITH CHECK (restaurante_id = app_tenant_id())', t);
    END LOOP;

    -- B: lectura pública de la vitrina
    FOREACH t IN ARRAY ARRAY['restaurante', 'restaurante_horario', 'mesa_local', 'plato', 'menu_diario_cabecera',
                             'menu_diario_detalle', 'plantilla_plan', 'oferta_flash', 'tarjeta_sellos_config']
    LOOP
        EXECUTE format('CREATE POLICY lectura_publica ON %I FOR SELECT TO bocadoo_app USING (true)', t);
    END LOOP;

    -- C: el comensal lee lo suyo (tablas con cliente_id)
    FOREACH t IN ARRAY ARRAY['suscripcion_plan', 'solicitud_plan', 'consumo_almuerzo', 'tarjeta_sellos_cliente',
                             'movimiento_sello', 'opinion', 'reclamo']
    LOOP
        EXECUTE format('CREATE POLICY comensal_lee ON %I FOR SELECT TO bocadoo_app
                        USING (cliente_id IN (SELECT c.cliente_id FROM cliente_restaurante c WHERE c.usuario_id = app_user_id()))', t);
    END LOOP;

    -- C: el comensal crea solicitudes de plan, opiniones y reclamos a su nombre
    FOREACH t IN ARRAY ARRAY['solicitud_plan', 'opinion', 'reclamo']
    LOOP
        EXECUTE format('CREATE POLICY comensal_crea ON %I FOR INSERT TO bocadoo_app
                        WITH CHECK (cliente_id IN (SELECT c.cliente_id FROM cliente_restaurante c WHERE c.usuario_id = app_user_id()))', t);
    END LOOP;

    -- Tablas sin restaurante_id o reservadas al rol de servicio
    FOREACH t IN ARRAY ARRAY['usuario_identidad', 'usuario_secreto_qr', 'dispositivo_usuario',
                             'suscripcion_saas_restaurante', 'libro_comision_bocadoo', 'factura_saas_cabecera',
                             'factura_saas_detalle', 'billetera_comensal', 'billetera_movimiento',
                             'lead_landing', 'log_actividad', 'evento_analitica']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;

-- Comensal: su ficha de cliente y su fila de personal (para saber en qué locales trabaja)
CREATE POLICY propio_usuario ON cliente_restaurante  FOR SELECT TO bocadoo_app USING (usuario_id = app_user_id());
CREATE POLICY propio_usuario ON personal_restaurante FOR SELECT TO bocadoo_app USING (usuario_id = app_user_id());

-- Comensal: sus preórdenes
CREATE POLICY comensal_lee  ON orden_cabecera FOR SELECT TO bocadoo_app USING (usuario_id = app_user_id());
CREATE POLICY comensal_crea ON orden_cabecera FOR INSERT TO bocadoo_app WITH CHECK (usuario_id = app_user_id());
CREATE POLICY comensal_cancela ON orden_cabecera FOR UPDATE TO bocadoo_app
    USING (usuario_id = app_user_id() AND estado = 'EN_CAMINO')
    WITH CHECK (usuario_id = app_user_id() AND estado = 'CANCELADA');
CREATE POLICY comensal_lee  ON orden_detalle FOR SELECT TO bocadoo_app
    USING (orden_id IN (SELECT o.orden_id FROM orden_cabecera o WHERE o.usuario_id = app_user_id()));
CREATE POLICY comensal_crea ON orden_detalle FOR INSERT TO bocadoo_app
    WITH CHECK (orden_id IN (SELECT o.orden_id FROM orden_cabecera o WHERE o.usuario_id = app_user_id()));

-- Comensal: mesas compartidas donde es anfitrión o miembro. Unirse por link se hace
-- con el rol de servicio (el invitado aún no es miembro y no puede ver la mesa).
CREATE POLICY anfitrion_total ON mesa_compartida FOR ALL TO bocadoo_app
    USING (anfitrion_usuario_id = app_user_id()) WITH CHECK (anfitrion_usuario_id = app_user_id());
CREATE POLICY miembro_propio ON mesa_compartida_miembro FOR ALL TO bocadoo_app
    USING (usuario_id = app_user_id()) WITH CHECK (usuario_id = app_user_id());
CREATE POLICY miembro_lee_mesa ON mesa_compartida FOR SELECT TO bocadoo_app
    USING (mesa_compartida_id IN (SELECT m.mesa_compartida_id FROM mesa_compartida_miembro m WHERE m.usuario_id = app_user_id()));

CREATE POLICY comensal_lee ON canje_oferta_flash FOR SELECT TO bocadoo_app USING (usuario_id = app_user_id());

-- Datos propios del usuario
CREATE POLICY propio ON dispositivo_usuario FOR ALL    TO bocadoo_app USING (usuario_id = app_user_id()) WITH CHECK (usuario_id = app_user_id());
CREATE POLICY propio ON billetera_comensal  FOR SELECT TO bocadoo_app USING (usuario_id = app_user_id());
CREATE POLICY propio ON billetera_movimiento FOR SELECT TO bocadoo_app
    USING (billetera_id IN (SELECT b.billetera_id FROM billetera_comensal b WHERE b.usuario_id = app_user_id()));

-- El restaurante ve (no edita) su suscripción SaaS, sus comisiones, sus facturas y su auditoría
CREATE POLICY tenant_lee ON suscripcion_saas_restaurante FOR SELECT TO bocadoo_app USING (restaurante_id = app_tenant_id());
CREATE POLICY tenant_lee ON libro_comision_bocadoo       FOR SELECT TO bocadoo_app USING (restaurante_id = app_tenant_id());
CREATE POLICY tenant_lee ON factura_saas_cabecera        FOR SELECT TO bocadoo_app USING (restaurante_id = app_tenant_id());
CREATE POLICY tenant_lee ON factura_saas_detalle         FOR SELECT TO bocadoo_app USING (restaurante_id = app_tenant_id());
CREATE POLICY tenant_lee ON log_actividad                FOR SELECT TO bocadoo_app USING (tenant_restaurante_id = app_tenant_id());

-- Solo escritura desde la app (nadie lee por la API): leads y eventos
CREATE POLICY solo_insertar ON lead_landing     FOR INSERT TO bocadoo_app WITH CHECK (restaurante_id IS NULL AND contactado_en IS NULL);
CREATE POLICY solo_insertar ON evento_analitica FOR INSERT TO bocadoo_app WITH CHECK (usuario_id IS NULL OR usuario_id = app_user_id());

-- =============================================================================
-- 18. PERMISOS
-- =============================================================================
GRANT USAGE ON SCHEMA public TO bocadoo_app, bocadoo_servicio;
GRANT ALL ON ALL TABLES IN SCHEMA public TO bocadoo_servicio;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bocadoo_app, bocadoo_servicio;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO bocadoo_app, bocadoo_servicio;
REVOKE EXECUTE ON FUNCTION fn_vencer_suscripciones(), fn_crear_particion_mensual(TEXT, DATE) FROM PUBLIC, bocadoo_app;

-- Sin DELETE para la app: todo es baja lógica o movimiento inverso. RLS decide las filas.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO bocadoo_app;
-- Catálogos globales: solo lectura.
REVOKE INSERT, UPDATE ON moneda, pais, ciudad, zona, metodo_pago, catalogo_plan_saas, plan_saas_precio FROM bocadoo_app;
-- Credenciales y secretos del QR: solo el rol de servicio (módulo de auth).
REVOKE ALL ON usuario_identidad, usuario_secreto_qr FROM bocadoo_app;
-- Perfil de usuario: la app no puede leer ni cambiar perfiles a mansalva.
REVOKE ALL ON usuario FROM bocadoo_app;
GRANT SELECT (usuario_id, public_id, nombre, nombre_usuario, foto_url, idioma, pais_codigo, zona_preferida_id, activo) ON usuario TO bocadoo_app;
ALTER TABLE usuario ENABLE ROW LEVEL SECURITY;
CREATE POLICY lectura_perfil_minimo ON usuario FOR SELECT TO bocadoo_app USING (true);
CREATE POLICY propio_edita ON usuario FOR UPDATE TO bocadoo_app USING (usuario_id = app_user_id()) WITH CHECK (usuario_id = app_user_id());
GRANT UPDATE (nombre, nombre_usuario, foto_url, idioma, zona_preferida_id, consiente_analitica, consiente_marketing) ON usuario TO bocadoo_app;

-- =============================================================================
-- 19. DATOS SEMILLA: arranque en Quito
-- =============================================================================
INSERT INTO moneda (moneda_codigo, nombre, simbolo, decimales) VALUES ('USD', 'Dólar estadounidense', '$', 2);

INSERT INTO pais (pais_codigo, nombre, moneda_codigo, prefijo_telefonico, idioma_defecto, habilitado)
VALUES ('EC', 'Ecuador', 'USD', '+593', 'es', true);

INSERT INTO ciudad (pais_codigo, nombre, slug, zona_horaria, latitud, longitud, habilitada) VALUES
    ('EC', 'Quito',     'quito',     'America/Guayaquil', -0.180653, -78.467834, true),
    ('EC', 'Guayaquil', 'guayaquil', 'America/Guayaquil', -2.189413, -79.889067, false),
    ('EC', 'Cuenca',    'cuenca',    'America/Guayaquil', -2.900129, -79.005896, false);

-- Zonas y coordenadas tomadas del prototipo (donde-comer/data/zones.ts).
INSERT INTO zona (ciudad_id, nombre, slug, latitud, longitud)
SELECT c.ciudad_id, z.nombre, z.slug, z.lat, z.lng
  FROM ciudad c,
       (VALUES ('Frente a la PUCE',       'puce',      -0.2115, -78.4912),
               ('La Floresta',            'floresta',  -0.2085, -78.4870),
               ('La Mariscal',            'mariscal',  -0.2030, -78.4925),
               ('Centro Histórico',       'centro',    -0.2200, -78.5080),
               ('Cumbayá / USFQ',         'cumbaya',   -0.1980, -78.4350),
               ('Iñaquito / La Carolina', 'inaquito',  -0.1800, -78.4840),
               ('EPN / Salesiana',        'epn',       -0.2120, -78.4890)) AS z(nombre, slug, lat, lng)
 WHERE c.slug = 'quito' AND c.pais_codigo = 'EC';

INSERT INTO metodo_pago (codigo, nombre, pais_codigo, es_efectivo) VALUES
    ('EFECTIVO',      'Efectivo',      NULL, true),
    ('TRANSFERENCIA', 'Transferencia', NULL, false),
    ('DEUNA',         'Deuna',         'EC', false),
    ('BOCADOO_CASH',  'Bocadoo Cash',  NULL, false);

-- Solo el plan gratuito: los precios y límites de los planes de pago son decisión de negocio pendiente.
INSERT INTO catalogo_plan_saas (codigo, nombre) VALUES ('FREEMIUM', 'Gratis');
INSERT INTO plan_saas_precio (plan_saas_id, pais_codigo, moneda_codigo, precio_mensual_centavos)
SELECT plan_saas_id, 'EC', 'USD', 0 FROM catalogo_plan_saas WHERE codigo = 'FREEMIUM';


-- migrate:down
-- Sin reversa: la línea base se recrea en una base nueva.
