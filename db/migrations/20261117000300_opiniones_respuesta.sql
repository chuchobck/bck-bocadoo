-- migrate:up
-- Fase 8: el dueño responde opiniones. Con tenant_total podía cambiar cualquier columna (también las etiquetas o el
-- comentario del comensal); ahora la API solo puede escribir las columnas de la respuesta.
REVOKE UPDATE ON opinion FROM bocadoo_app;
GRANT UPDATE (respuesta_restaurante, respondido_en, respondido_por_personal_id) ON opinion TO bocadoo_app;

-- migrate:down
REVOKE UPDATE (respuesta_restaurante, respondido_en, respondido_por_personal_id) ON opinion FROM bocadoo_app;
GRANT UPDATE ON opinion TO bocadoo_app;
