/** Rutas que pino redacta en los logs. La cédula/RUC del local es un dato privado. */
export const LOG_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
  // Cédula/RUC a cualquier profundidad razonable (p. ej. req.body.restaurante.cedulaRuc).
  'cedulaRuc',
  '*.cedulaRuc',
  '*.*.cedulaRuc',
  '*.*.*.cedulaRuc',
];
