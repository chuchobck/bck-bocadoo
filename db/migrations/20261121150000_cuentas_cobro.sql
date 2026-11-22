-- migrate:up
-- Entrega D, PR 4 (docs/spec-cobros.md F.1, F.4 y F.5): cuentas de cobro. Una cuenta agrupa lo que un pagador debe por
-- una operación (pedido, QR o miembro de mesa); sus líneas son un libro de solo-inserción y sus pagos son filas de
-- transaccion_pago. Ningún código la usa todavía: todo es nuevo o nullable.

DO $$
BEGIN
    IF to_regtype('public.estado_cuenta_cobro_enum') IS NULL THEN
        CREATE TYPE estado_cuenta_cobro_enum AS ENUM ('ABIERTA', 'COBRADA', 'ANULADA');
    END IF;
    IF to_regtype('public.tipo_linea_cobro_enum') IS NULL THEN
        CREATE TYPE tipo_linea_cobro_enum AS ENUM ('ALMUERZO', 'A_LA_CARTA', 'EXTRA', 'BEBIDA', 'OFERTA', 'LIBRE');
    END IF;
    IF to_regtype('public.fuente_cobro_enum') IS NULL THEN
        CREATE TYPE fuente_cobro_enum AS ENUM ('PLAN', 'OFERTA', 'CAJA');
    END IF;
    IF to_regtype('public.pagador_linea_enum') IS NULL THEN
        CREATE TYPE pagador_linea_enum AS ENUM ('PROPIO', 'ANFITRION');
    END IF;
    IF to_regtype('public.motivo_omision_enum') IS NULL THEN
        CREATE TYPE motivo_omision_enum AS ENUM ('PLATO_AGOTADO', 'DUPLICADO', 'LIMITE_SAAS');
    END IF;
END $$;

-- intento_escaneo registra todos los escaneos, también los rechazados (SIN_PLAN, VENCIDO, …): es el origen de la cuenta
-- de un QR sin consumo. La FK compuesta necesita esta clave (la tabla es de solo-inserción; solo se agrega el índice).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.intento_escaneo'::regclass
                    AND conname = 'uq_intento_restaurante') THEN
        ALTER TABLE intento_escaneo ADD CONSTRAINT uq_intento_restaurante UNIQUE (restaurante_id, intento_id);
    END IF;
END $$;

-- 1) Cabecera. Solo cambia su estado (permiso por columnas + trigger de transiciones).
CREATE TABLE IF NOT EXISTS cuenta_cobro (
    cuenta_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id          UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    restaurante_id     BIGINT NOT NULL REFERENCES restaurante(restaurante_id) ON DELETE RESTRICT,
    -- Origen (exactamente uno): pedido, consumo de QR, intento de escaneo sin consumo (QR de un almuerzo sin plan) o
    -- miembro (pagador) de una mesa.
    orden_id           BIGINT,
    consumo_id         BIGINT,
    intento_id         BIGINT,
    mesa_compartida_id BIGINT,
    miembro_id         BIGINT,
    -- Pagador
    cliente_id         BIGINT,
    usuario_id         BIGINT REFERENCES usuario(usuario_id) ON DELETE RESTRICT,
    nombre_pagador     TEXT NOT NULL CHECK (btrim(nombre_pagador) <> ''),   -- copia al crear
    -- Copias del local al crear
    momento_cobro      momento_cobro_enum NOT NULL,
    para_llevar        BOOLEAN NOT NULL DEFAULT false,
    moneda_codigo      CHAR(3) NOT NULL REFERENCES moneda(moneda_codigo),
    -- Estado (lo único que cambia)
    estado             estado_cuenta_cobro_enum NOT NULL DEFAULT 'ABIERTA',
    cobrada_en         TIMESTAMPTZ,
    anulada_en         TIMESTAMPTZ,
    anulada_por_personal_id BIGINT,
    motivo_anulacion   TEXT CHECK (char_length(motivo_anulacion) BETWEEN 1 AND 200),
    -- Idempotencia y trazabilidad
    clave_idempotencia UUID NOT NULL,
    huella             CHAR(64) NOT NULL CHECK (huella ~ '^[0-9a-f]{64}$'),  -- sha256 de la entrada normalizada
    personal_id        BIGINT NOT NULL,
    fecha_local        DATE NOT NULL,
    creada_en          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cuenta_orden     FOREIGN KEY (restaurante_id, orden_id)
        REFERENCES orden_cabecera(restaurante_id, orden_id) ON DELETE RESTRICT,
    CONSTRAINT fk_cuenta_consumo   FOREIGN KEY (restaurante_id, consumo_id)
        REFERENCES consumo_almuerzo(restaurante_id, consumo_id) ON DELETE RESTRICT,
    CONSTRAINT fk_cuenta_intento   FOREIGN KEY (restaurante_id, intento_id)
        REFERENCES intento_escaneo(restaurante_id, intento_id) ON DELETE RESTRICT,
    CONSTRAINT fk_cuenta_mesa    FOREIGN KEY (restaurante_id, mesa_compartida_id)
        REFERENCES mesa_compartida(restaurante_id, mesa_compartida_id) ON DELETE RESTRICT,
    -- El miembro es de esa mesa y la mesa de ese restaurante (índice uq_miembro_mesa_restaurante).
    CONSTRAINT fk_cuenta_miembro   FOREIGN KEY (miembro_id, mesa_compartida_id, restaurante_id)
        REFERENCES mesa_compartida_miembro(miembro_id, mesa_compartida_id, restaurante_id) ON DELETE RESTRICT,
    CONSTRAINT fk_cuenta_cliente   FOREIGN KEY (restaurante_id, cliente_id)
        REFERENCES cliente_restaurante(restaurante_id, cliente_id) ON DELETE RESTRICT,
    CONSTRAINT fk_cuenta_personal  FOREIGN KEY (restaurante_id, personal_id)
        REFERENCES personal_restaurante(restaurante_id, personal_id) ON DELETE RESTRICT,
    CONSTRAINT fk_cuenta_anulada_por FOREIGN KEY (restaurante_id, anulada_por_personal_id)
        REFERENCES personal_restaurante(restaurante_id, personal_id) ON DELETE RESTRICT,
    CONSTRAINT uq_cuenta_restaurante UNIQUE (restaurante_id, cuenta_id),
    CONSTRAINT uq_cuenta_clave UNIQUE (restaurante_id, clave_idempotencia),
    CONSTRAINT ck_cuenta_origen_unico CHECK (num_nonnulls(orden_id, consumo_id, intento_id, mesa_compartida_id) = 1),
    CONSTRAINT ck_cuenta_mesa_con_miembro CHECK ((mesa_compartida_id IS NULL) = (miembro_id IS NULL)),
    CONSTRAINT ck_cuenta_cobrada CHECK (estado <> 'COBRADA' OR cobrada_en IS NOT NULL),
    CONSTRAINT ck_cuenta_anulada CHECK ((estado = 'ANULADA') = (anulada_en IS NOT NULL)),
    CONSTRAINT ck_cuenta_datos_anulacion CHECK (estado = 'ANULADA' OR (anulada_por_personal_id IS NULL AND motivo_anulacion IS NULL))
);
-- Una cuenta no anulada por origen.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuenta_por_orden ON cuenta_cobro (orden_id)
    WHERE orden_id IS NOT NULL AND estado <> 'ANULADA';
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuenta_por_consumo ON cuenta_cobro (consumo_id)
    WHERE consumo_id IS NOT NULL AND estado <> 'ANULADA';
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuenta_por_intento ON cuenta_cobro (intento_id)
    WHERE intento_id IS NOT NULL AND estado <> 'ANULADA';
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuenta_por_miembro ON cuenta_cobro (mesa_compartida_id, miembro_id)
    WHERE mesa_compartida_id IS NOT NULL AND estado <> 'ANULADA';
CREATE INDEX IF NOT EXISTS idx_cuenta_dia ON cuenta_cobro (restaurante_id, fecha_local, estado);
CREATE INDEX IF NOT EXISTS idx_cuenta_usuario ON cuenta_cobro (usuario_id, creada_en DESC) WHERE usuario_id IS NOT NULL;

-- Transiciones: ABIERTA → COBRADA, COBRADA → ABIERTA (pago rechazado), ABIERTA|COBRADA → ANULADA (terminal).
-- Además ninguna otra columna cambia (también protege del rol de servicio, que tiene UPDATE completo) y nada se borra.
CREATE OR REPLACE FUNCTION fn_cuenta_cobro_transicion() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'cuenta_cobro no admite DELETE: anula la cuenta' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (to_jsonb(NEW) - 'estado' - 'cobrada_en' - 'anulada_en' - 'anulada_por_personal_id' - 'motivo_anulacion')
       IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'cobrada_en' - 'anulada_en' - 'anulada_por_personal_id' - 'motivo_anulacion') THEN
        RAISE EXCEPTION 'cuenta_cobro: solo cambia su estado' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT ((OLD.estado = 'ABIERTA' AND NEW.estado = 'COBRADA')
         OR (OLD.estado = 'COBRADA' AND NEW.estado = 'ABIERTA')
         OR (OLD.estado <> 'ANULADA' AND NEW.estado = 'ANULADA')) THEN
        RAISE EXCEPTION 'cuenta_cobro: transición de estado inválida (% → %)', OLD.estado, NEW.estado
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cuenta_cobro_transicion ON cuenta_cobro;
CREATE TRIGGER trg_cuenta_cobro_transicion BEFORE UPDATE OR DELETE ON cuenta_cobro
FOR EACH ROW EXECUTE FUNCTION fn_cuenta_cobro_transicion();

-- 2) Líneas: libro de solo-inserción. Reversar = línea inversa enlazada (cantidad negativa), un solo reverso por línea.
CREATE TABLE IF NOT EXISTS cuenta_cobro_linea (
    linea_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cuenta_id          BIGINT NOT NULL,
    restaurante_id     BIGINT NOT NULL,
    ref                TEXT NOT NULL CHECK (btrim(ref) <> ''),          -- ref de la línea de la cotización
    persona_ref        TEXT NOT NULL CHECK (btrim(persona_ref) <> ''),
    tipo               tipo_linea_cobro_enum NOT NULL,
    fuente             fuente_cobro_enum NOT NULL,
    pagador            pagador_linea_enum NOT NULL DEFAULT 'PROPIO',
    omitida            motivo_omision_enum,
    plato_id           BIGINT,
    oferta_flash_id    BIGINT,
    canje_oferta_id    BIGINT,
    consumo_id         BIGINT,
    nombre             TEXT NOT NULL CHECK (btrim(nombre) <> ''),       -- copia al crear
    cantidad           INTEGER NOT NULL CHECK (cantidad <> 0),           -- negativa = reverso
    precio_unitario_centavos  BIGINT NOT NULL CHECK (precio_unitario_centavos >= 0),
    recargo_unitario_centavos BIGINT NOT NULL DEFAULT 0 CHECK (recargo_unitario_centavos >= 0),
    subtotal_centavos  BIGINT NOT NULL,
    recargo_centavos   BIGINT NOT NULL,
    cubierto_centavos  BIGINT NOT NULL,
    clave_idempotencia UUID NOT NULL,
    revierte_a_linea_id BIGINT,
    creada_en          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_linea_cuenta  FOREIGN KEY (restaurante_id, cuenta_id)
        REFERENCES cuenta_cobro(restaurante_id, cuenta_id) ON DELETE RESTRICT,
    CONSTRAINT fk_linea_plato   FOREIGN KEY (restaurante_id, plato_id)
        REFERENCES plato(restaurante_id, plato_id) ON DELETE RESTRICT,
    CONSTRAINT fk_linea_oferta  FOREIGN KEY (restaurante_id, oferta_flash_id)
        REFERENCES oferta_flash(restaurante_id, oferta_flash_id) ON DELETE RESTRICT,
    CONSTRAINT fk_linea_canje   FOREIGN KEY (restaurante_id, canje_oferta_id)
        REFERENCES canje_oferta_flash(restaurante_id, canje_id) ON DELETE RESTRICT,
    CONSTRAINT fk_linea_consumo FOREIGN KEY (restaurante_id, consumo_id)
        REFERENCES consumo_almuerzo(restaurante_id, consumo_id) ON DELETE RESTRICT,
    CONSTRAINT uq_linea_cuenta UNIQUE (cuenta_id, linea_id),
    -- El reverso es de una línea de la misma cuenta.
    CONSTRAINT fk_linea_revierte FOREIGN KEY (cuenta_id, revierte_a_linea_id)
        REFERENCES cuenta_cobro_linea(cuenta_id, linea_id) ON DELETE RESTRICT,
    CONSTRAINT uq_linea_clave UNIQUE (restaurante_id, clave_idempotencia),
    -- Montos (spec F.1 corregida): solo cuando la línea se cobra. Una omitida conserva cantidad y precio (informativos)
    -- y sus montos son 0.
    CONSTRAINT ck_linea_montos CHECK (
        omitida IS NOT NULL
        OR (subtotal_centavos = cantidad * precio_unitario_centavos
            AND recargo_centavos = cantidad * recargo_unitario_centavos
            AND cubierto_centavos = CASE WHEN fuente = 'PLAN' THEN subtotal_centavos ELSE 0 END)),
    CONSTRAINT ck_linea_omitida CHECK (
        omitida IS NULL
        OR (fuente = 'CAJA' AND subtotal_centavos = 0 AND recargo_centavos = 0 AND cubierto_centavos = 0)),
    -- Cada unidad del plan es su propia línea con su consumo.
    CONSTRAINT ck_linea_plan CHECK (fuente <> 'PLAN' OR (tipo = 'ALMUERZO' AND consumo_id IS NOT NULL AND abs(cantidad) = 1)),
    CONSTRAINT ck_linea_oferta CHECK (fuente <> 'OFERTA' OR oferta_flash_id IS NOT NULL),
    CONSTRAINT ck_linea_reverso CHECK ((cantidad > 0) = (revierte_a_linea_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_linea_un_solo_reverso ON cuenta_cobro_linea (revierte_a_linea_id)
    WHERE revierte_a_linea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_linea_cuenta  ON cuenta_cobro_linea (cuenta_id);
CREATE INDEX IF NOT EXISTS idx_linea_plato   ON cuenta_cobro_linea (plato_id) WHERE plato_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_linea_consumo ON cuenta_cobro_linea (consumo_id) WHERE consumo_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_solo_insercion_cuenta_cobro_linea ON cuenta_cobro_linea;
CREATE TRIGGER trg_solo_insercion_cuenta_cobro_linea BEFORE UPDATE OR DELETE ON cuenta_cobro_linea
FOR EACH ROW EXECUTE FUNCTION fn_solo_insercion();

-- 3) Pagos de una cuenta. La CHECK de origen único de la baseline no tiene nombre: se busca por su definición (falla
--    si no está exactamente una) y se reemplaza por una con nombre que incluye cuenta_cobro_id. Las filas existentes
--    la cumplen (cuenta_cobro_id es NULL en todas).
ALTER TABLE transaccion_pago ADD COLUMN IF NOT EXISTS cuenta_cobro_id BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transaccion_pago'::regclass
                    AND conname = 'fk_pago_cuenta_cobro') THEN
        ALTER TABLE transaccion_pago ADD CONSTRAINT fk_pago_cuenta_cobro FOREIGN KEY (restaurante_id, cuenta_cobro_id)
            REFERENCES cuenta_cobro(restaurante_id, cuenta_id) ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
DECLARE
    v_nombres TEXT[];
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transaccion_pago'::regclass
                AND conname = 'ck_pago_origen_unico') THEN
        RETURN;   -- ya reemplazada
    END IF;
    SELECT array_agg(c.conname ORDER BY c.conname) INTO v_nombres
      FROM pg_constraint c
     WHERE c.conrelid = 'public.transaccion_pago'::regclass AND c.contype = 'c'
       AND regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g')
           = 'CHECK((num_nonnulls(suscripcion_id,venta_pos_id,orden_id,canje_oferta_id)=1))';
    IF coalesce(cardinality(v_nombres), 0) <> 1 THEN
        RAISE EXCEPTION 'transaccion_pago: se esperaba exactamente una CHECK "num_nonnulls(suscripcion_id, venta_pos_id, orden_id, canje_oferta_id) = 1" y hay %: %',
            coalesce(cardinality(v_nombres), 0), coalesce(array_to_string(v_nombres, ', '), 'ninguna');
    END IF;
    RAISE NOTICE 'transaccion_pago: se reemplaza la CHECK de origen único "%"', v_nombres[1];
    EXECUTE format('ALTER TABLE public.transaccion_pago DROP CONSTRAINT %I', v_nombres[1]);
    ALTER TABLE transaccion_pago ADD CONSTRAINT ck_pago_origen_unico
        CHECK (num_nonnulls(suscripcion_id, venta_pos_id, orden_id, canje_oferta_id, cuenta_cobro_id) = 1);
END $$;
CREATE INDEX IF NOT EXISTS idx_pago_cuenta_cobro ON transaccion_pago (cuenta_cobro_id) WHERE cuenta_cobro_id IS NOT NULL;

-- 4) Saldo derivado (nunca guardado): por cobrar de las líneas menos los pagos no rechazados (con signo).
--    security_invoker: quien consulta ve solo lo que RLS le deja ver de las tres tablas.
CREATE OR REPLACE VIEW v_cuenta_saldo WITH (security_invoker = true) AS
SELECT c.cuenta_id, c.restaurante_id, c.estado,
       l.por_cobrar_centavos,
       p.pagado_centavos,
       l.por_cobrar_centavos - p.pagado_centavos AS saldo_centavos
  FROM cuenta_cobro c
 CROSS JOIN LATERAL (SELECT COALESCE(sum(x.subtotal_centavos - x.cubierto_centavos + x.recargo_centavos), 0)::BIGINT AS por_cobrar_centavos
                       FROM cuenta_cobro_linea x WHERE x.cuenta_id = c.cuenta_id) l
 CROSS JOIN LATERAL (SELECT COALESCE(sum(t.monto_centavos), 0)::BIGINT AS pagado_centavos
                       FROM transaccion_pago t WHERE t.cuenta_cobro_id = c.cuenta_id AND t.estado <> 'RECHAZADO') p;

-- 5) RLS (F.5): el personal todo lo de su local; el comensal solo lee lo suyo y nunca escribe; el rol de servicio
--    (BYPASSRLS) todo.
ALTER TABLE cuenta_cobro ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuenta_cobro_linea ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_total ON cuenta_cobro;
CREATE POLICY tenant_total ON cuenta_cobro FOR ALL TO bocadoo_app
    USING (restaurante_id = app_tenant_id()) WITH CHECK (restaurante_id = app_tenant_id());
DROP POLICY IF EXISTS comensal_lee ON cuenta_cobro;
CREATE POLICY comensal_lee ON cuenta_cobro FOR SELECT TO bocadoo_app
    USING (usuario_id = app_user_id());
DROP POLICY IF EXISTS tenant_total ON cuenta_cobro_linea;
CREATE POLICY tenant_total ON cuenta_cobro_linea FOR ALL TO bocadoo_app
    USING (restaurante_id = app_tenant_id()) WITH CHECK (restaurante_id = app_tenant_id());
DROP POLICY IF EXISTS comensal_lee ON cuenta_cobro_linea;
CREATE POLICY comensal_lee ON cuenta_cobro_linea FOR SELECT TO bocadoo_app
    USING (cuenta_id IN (SELECT c.cuenta_id FROM cuenta_cobro c WHERE c.usuario_id = app_user_id()));
-- El pagador lee los pagos de SUS cuentas (para «te falta pagar X» con pagos parciales); nunca pagos sin cuenta (planes,
-- POS, ofertas) ni de cuentas ajenas. Solo SELECT: escribir sigue siendo del personal (tenant_total).
DROP POLICY IF EXISTS comensal_lee_pagos_cuenta ON transaccion_pago;
CREATE POLICY comensal_lee_pagos_cuenta ON transaccion_pago FOR SELECT TO bocadoo_app
    USING (cuenta_cobro_id IN (SELECT c.cuenta_id FROM cuenta_cobro c WHERE c.usuario_id = app_user_id()));

-- Permisos: la cabecera solo cambia su estado (patrón de 20261118000000_ofertas_flash.sql); las líneas, solo INSERT.
REVOKE ALL ON cuenta_cobro, cuenta_cobro_linea, v_cuenta_saldo FROM PUBLIC;
GRANT SELECT, INSERT ON cuenta_cobro TO bocadoo_app;
GRANT UPDATE (estado, cobrada_en, anulada_en, anulada_por_personal_id, motivo_anulacion) ON cuenta_cobro TO bocadoo_app;
GRANT SELECT, INSERT ON cuenta_cobro_linea TO bocadoo_app;
GRANT SELECT ON v_cuenta_saldo TO bocadoo_app;
GRANT ALL ON cuenta_cobro, cuenta_cobro_linea TO bocadoo_servicio;
GRANT SELECT ON v_cuenta_saldo TO bocadoo_servicio;

-- migrate:down
DROP VIEW IF EXISTS v_cuenta_saldo;
DROP POLICY IF EXISTS comensal_lee_pagos_cuenta ON transaccion_pago;
DROP INDEX IF EXISTS idx_pago_cuenta_cobro;
-- Vuelve la CHECK de la baseline (sin nombre: Postgres le da el mismo nombre automático). Falla si ya hay pagos de
-- cuentas, que no caben en la CHECK vieja.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transaccion_pago'::regclass
                AND conname = 'ck_pago_origen_unico') THEN
        ALTER TABLE transaccion_pago DROP CONSTRAINT ck_pago_origen_unico;
        ALTER TABLE transaccion_pago ADD CHECK (num_nonnulls(suscripcion_id, venta_pos_id, orden_id, canje_oferta_id) = 1);
    END IF;
END $$;
ALTER TABLE transaccion_pago DROP CONSTRAINT IF EXISTS fk_pago_cuenta_cobro;
ALTER TABLE transaccion_pago DROP COLUMN IF EXISTS cuenta_cobro_id;
DROP TABLE IF EXISTS cuenta_cobro_linea;
DROP TABLE IF EXISTS cuenta_cobro;
DROP FUNCTION IF EXISTS fn_cuenta_cobro_transicion();
ALTER TABLE intento_escaneo DROP CONSTRAINT IF EXISTS uq_intento_restaurante;
DROP TYPE IF EXISTS motivo_omision_enum;
DROP TYPE IF EXISTS pagador_linea_enum;
DROP TYPE IF EXISTS fuente_cobro_enum;
DROP TYPE IF EXISTS tipo_linea_cobro_enum;
DROP TYPE IF EXISTS estado_cuenta_cobro_enum;
