-- migrate:up
-- Perfil de negocio del restaurante: campos opcionales (todo nullable o con default) que completa la app tras el registro.
-- Se reutilizan columnas que ya existían: direccion, latitud, longitud, telefono_e164, puestos, precio_suelto_centavos
-- (= precio del almuerzo) y recargo_para_llevar_centavos.

ALTER TABLE restaurante
    ADD COLUMN mesas_total                  INTEGER CHECK (mesas_total BETWEEN 1 AND 200),   -- informativo; no es mesa_local
    ADD COLUMN precio_solo_segundo_centavos BIGINT  CHECK (precio_solo_segundo_centavos > 0),
    ADD COLUMN precio_solo_sopa_centavos    BIGINT  CHECK (precio_solo_sopa_centavos > 0),
    -- puestos es NOT NULL con default 20: esta bandera distingue "el dueño ya lo indicó" del valor por defecto. Las filas
    -- existentes quedan en true (no se les inventan pendientes); el registro la deja en false si no manda puestos.
    ADD COLUMN puestos_definidos            BOOLEAN NOT NULL DEFAULT true,
    ADD CONSTRAINT ck_restaurante_puestos_mesas CHECK (mesas_total IS NULL OR NOT puestos_definidos OR puestos >= mesas_total);
COMMENT ON COLUMN restaurante.mesas_total IS 'Cantidad de mesas del local, solo informativa (las mesas operativas están en mesa_local)';

-- Solo cambia el valor por defecto de filas NUEVAS; las existentes no se tocan.
ALTER TABLE restaurante ALTER COLUMN recargo_para_llevar_centavos SET DEFAULT 25;

-- Cédula/RUC en tabla aparte: restaurante tiene `lectura_publica` (USING true) y trigger de auditoría que copia la fila
-- completa a log_actividad. Aquí solo hay política de tenant y NO hay trigger de auditoría ni lectura pública.
CREATE TABLE restaurante_fiscal (
    restaurante_id BIGINT PRIMARY KEY REFERENCES restaurante(restaurante_id) ON DELETE CASCADE,
    cedula_ruc     VARCHAR(13) CHECK (cedula_ruc ~ '^[0-9]{10}([0-9]{3})?$'),   -- null = borrada (la app no tiene DELETE)
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE restaurante_fiscal IS 'Dato fiscal privado del local: solo su tenant lo ve; nunca en endpoints públicos ni en auditoría';
CREATE TRIGGER trg_tocar_restaurante_fiscal BEFORE UPDATE ON restaurante_fiscal
    FOR EACH ROW EXECUTE FUNCTION fn_tocar_actualizado_en();
ALTER TABLE restaurante_fiscal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_total ON restaurante_fiscal FOR ALL TO bocadoo_app
    USING (restaurante_id = app_tenant_id()) WITH CHECK (restaurante_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE ON restaurante_fiscal TO bocadoo_app;
GRANT ALL ON restaurante_fiscal TO bocadoo_servicio;

-- migrate:down
DROP TABLE restaurante_fiscal;
ALTER TABLE restaurante ALTER COLUMN recargo_para_llevar_centavos SET DEFAULT 0;
ALTER TABLE restaurante
    DROP CONSTRAINT ck_restaurante_puestos_mesas,
    DROP COLUMN puestos_definidos,
    DROP COLUMN precio_solo_sopa_centavos,
    DROP COLUMN precio_solo_segundo_centavos,
    DROP COLUMN mesas_total;
