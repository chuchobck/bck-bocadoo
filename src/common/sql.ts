// Fragmentos SQL compartidos que dependen del contexto de la sesión (app_tenant_id(), app_user_id()).

/** personal_id de quien hace la petición en el restaurante de la sesión (null si no es personal activo). */
export const PERSONAL_ACTUAL = `(SELECT personal_id FROM personal_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = app_user_id() AND activo)`;

/** Fecha local de hoy del restaurante de la sesión. */
export const HOY_TENANT = `(SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date FROM restaurante WHERE restaurante_id = app_tenant_id())`;
