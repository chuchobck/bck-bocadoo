-- migrate:up
-- Selección completa de cada comensal en una mesa compartida: almuerzo por sección (JUGO, SOPA, FUERTE, POSTRE) y
-- platos con cantidad (carta, bebidas, extras). `seccion` con valor = parte del almuerzo (cantidad 1); NULL = plato
-- suelto con cantidad. Las columnas sopa_plato_id / fuerte_plato_id de mesa_compartida_miembro quedan como están
-- (la API nunca las usó) y no se tocan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_miembro_mesa_restaurante
    ON mesa_compartida_miembro (miembro_id, mesa_compartida_id, restaurante_id);

CREATE TABLE IF NOT EXISTS mesa_compartida_miembro_item (
    item_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    miembro_id         BIGINT NOT NULL,
    mesa_compartida_id BIGINT NOT NULL,
    restaurante_id     BIGINT NOT NULL,
    plato_id           BIGINT NOT NULL,
    seccion            seccion_menu_enum,
    cantidad           INTEGER NOT NULL DEFAULT 1 CHECK (cantidad BETWEEN 1 AND 10),
    creado_en          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- El miembro es de esa mesa y la mesa de ese restaurante; el plato es de ese mismo restaurante (nunca de otro local).
    FOREIGN KEY (miembro_id, mesa_compartida_id, restaurante_id)
        REFERENCES mesa_compartida_miembro (miembro_id, mesa_compartida_id, restaurante_id) ON DELETE RESTRICT,
    FOREIGN KEY (restaurante_id, plato_id) REFERENCES plato (restaurante_id, plato_id) ON DELETE RESTRICT,
    CHECK (seccion IS NULL OR (seccion IN ('JUGO', 'SOPA', 'FUERTE', 'POSTRE') AND cantidad = 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_miembro_item_plato   ON mesa_compartida_miembro_item (miembro_id, plato_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_miembro_item_seccion ON mesa_compartida_miembro_item (miembro_id, seccion) WHERE seccion IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_miembro_item_mesa ON mesa_compartida_miembro_item (mesa_compartida_id);

ALTER TABLE mesa_compartida_miembro_item ENABLE ROW LEVEL SECURITY;
-- Personal del local: solo lee (la caja ve qué pidió cada quien; no lo cambia).
CREATE POLICY personal_lee ON mesa_compartida_miembro_item FOR SELECT TO bocadoo_app
    USING (restaurante_id = app_tenant_id());
-- Comensal: cada quien ve lo suyo y el anfitrión ve lo de toda su mesa.
CREATE POLICY comensal_lee ON mesa_compartida_miembro_item FOR SELECT TO bocadoo_app
    USING (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id())
           OR mesa_compartida_id IN (SELECT m.mesa_compartida_id FROM mesa_compartida m WHERE m.anfitrion_usuario_id = app_user_id()));
-- Solo escribe su propia selección y solo mientras la mesa sigue abierta y sin validar en caja.
CREATE POLICY comensal_escribe ON mesa_compartida_miembro_item FOR INSERT TO bocadoo_app
    WITH CHECK (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id())
                AND EXISTS (SELECT 1 FROM mesa_compartida m WHERE m.mesa_compartida_id = mesa_compartida_miembro_item.mesa_compartida_id
                              AND m.estado IN ('ABIERTA', 'EN_CAMINO') AND m.validada_en IS NULL));
CREATE POLICY comensal_borra ON mesa_compartida_miembro_item FOR DELETE TO bocadoo_app
    USING (miembro_id IN (SELECT x.miembro_id FROM mesa_compartida_miembro x WHERE x.usuario_id = app_user_id())
           AND EXISTS (SELECT 1 FROM mesa_compartida m WHERE m.mesa_compartida_id = mesa_compartida_miembro_item.mesa_compartida_id
                         AND m.estado IN ('ABIERTA', 'EN_CAMINO') AND m.validada_en IS NULL));

GRANT SELECT, INSERT, DELETE ON mesa_compartida_miembro_item TO bocadoo_app;
GRANT ALL ON mesa_compartida_miembro_item TO bocadoo_servicio;

-- migrate:down
DROP TABLE IF EXISTS mesa_compartida_miembro_item;
DROP INDEX IF EXISTS uq_miembro_mesa_restaurante;
