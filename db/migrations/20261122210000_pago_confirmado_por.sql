-- migrate:up
-- Auditoría de seguridad, PR «cajero confirma pagos»: queda registrado QUIÉN dejó un pago en CONFIRMADO.
-- El cajero conserva `pagoConfirmado` (decisión del dueño), pero con referencia obligatoria en transferencia/Deuna (regla
-- de la API, src/common/pago-confirmado.ts) y con su usuario y rol guardados, para que el cierre separe lo confirmado
-- por el cajero de lo confirmado por el dueño.
--
-- - Tres columnas nullable: los pagos que ya existen quedan con NULL («sin registro») y nada se rellena.
-- - Las llena la API desde la sesión (app_user_id() y el rol de personal_restaurante), nunca desde el body: al insertar
--   un pago que nace CONFIRMADO (efectivo incluido) o al confirmar uno PENDIENTE. Los reversos (filas negativas) quedan
--   con NULL: el cierre los atribuye a quien confirmó el pago original.
-- - El trigger de solo-cambio-de-estado (baseline:1172) se reemplaza para admitir estas tres columnas en el mismo
--   UPDATE que confirma; el CHECK impide fijarlas en un pago que no queda CONFIRMADO.
-- - GRANT y RLS no cambian: bocadoo_app ya tiene SELECT/INSERT/UPDATE de toda la tabla (sin GRANT por columna) y las
--   políticas (tenant_total, comensal_lee_pagos_cuenta) son por fila. CREATE OR REPLACE conserva dueño y EXECUTE.
ALTER TABLE transaccion_pago ADD COLUMN IF NOT EXISTS confirmado_por_usuario_id BIGINT;
ALTER TABLE transaccion_pago ADD COLUMN IF NOT EXISTS confirmado_por_rol rol_personal_enum;
ALTER TABLE transaccion_pago ADD COLUMN IF NOT EXISTS confirmado_en TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transaccion_pago'::regclass
                    AND conname = 'fk_pago_confirmado_por_usuario') THEN
        ALTER TABLE transaccion_pago ADD CONSTRAINT fk_pago_confirmado_por_usuario
            FOREIGN KEY (confirmado_por_usuario_id) REFERENCES usuario(usuario_id) ON DELETE RESTRICT;
    END IF;
    -- Las tres juntas, y solo en un pago CONFIRMADO.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.transaccion_pago'::regclass
                    AND conname = 'ck_pago_confirmado_por') THEN
        ALTER TABLE transaccion_pago ADD CONSTRAINT ck_pago_confirmado_por CHECK (
            num_nonnulls(confirmado_por_usuario_id, confirmado_por_rol, confirmado_en) IN (0, 3)
            AND (confirmado_por_rol IS NULL OR estado = 'CONFIRMADO'));
    END IF;
END $$;

CREATE OR REPLACE FUNCTION fn_pago_solo_cambia_estado() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'transaccion_pago no admite DELETE: registra un pago inverso' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.estado <> 'PENDIENTE'
       OR (to_jsonb(NEW) - 'estado' - 'referencia_externa' - 'comprobante_url'
                         - 'confirmado_por_usuario_id' - 'confirmado_por_rol' - 'confirmado_en')
          IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'referencia_externa' - 'comprobante_url'
                                          - 'confirmado_por_usuario_id' - 'confirmado_por_rol' - 'confirmado_en') THEN
        RAISE EXCEPTION 'transaccion_pago: solo se puede confirmar o rechazar un pago PENDIENTE' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END $$;

-- migrate:down
-- Vuelve la función de la baseline y quita las columnas (se pierde quién confirmó cada pago).
CREATE OR REPLACE FUNCTION fn_pago_solo_cambia_estado() RETURNS TRIGGER
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
ALTER TABLE transaccion_pago DROP CONSTRAINT IF EXISTS ck_pago_confirmado_por;
ALTER TABLE transaccion_pago DROP CONSTRAINT IF EXISTS fk_pago_confirmado_por_usuario;
ALTER TABLE transaccion_pago DROP COLUMN IF EXISTS confirmado_en;
ALTER TABLE transaccion_pago DROP COLUMN IF EXISTS confirmado_por_rol;
ALTER TABLE transaccion_pago DROP COLUMN IF EXISTS confirmado_por_usuario_id;
