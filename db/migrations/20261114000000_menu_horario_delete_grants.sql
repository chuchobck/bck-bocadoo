-- migrate:up
-- Horarios y detalle del menú diario son configuración, no libros: el dueño los reemplaza completos.
-- Nada los referencia (sin claves foráneas hacia ellos), así que borrar es seguro. RLS sigue filtrando por tenant.
GRANT DELETE ON restaurante_horario, menu_diario_detalle TO bocadoo_app;

-- migrate:down
REVOKE DELETE ON restaurante_horario, menu_diario_detalle FROM bocadoo_app;
