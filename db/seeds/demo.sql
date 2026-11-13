-- =============================================================================
-- BOCADOO · DATOS SEMILLA DE DEMOSTRACIÓN v1 (para bocadoo_schema_v1.sql)
--
-- Qué carga: los 5 restaurantes del prototipo en Quito, su personal, menús,
-- planes y ~7 semanas de operación simulada de "La Cuchara de San Blas"
-- (ventas de planes, almuerzos validados, cobros sueltos, cierres de caja,
-- opiniones, ofertas flash) para que reportes y métricas tengan datos.
--
-- · TODO ES FICTICIO: personas, teléfonos (+593 990 000 0xx) y correos
--   (@demo.bocadoo.test). No usar en producción.
-- · Ejecutar con el rol dueño / bocadoo_servicio (salta RLS), una sola vez,
--   sobre una base que ya tenga bocadoo_schema_v1.sql.
-- · Las fechas son relativas a HOY, así la demo siempre se ve "viva".
-- · No crea contraseñas: los hashes los genera el módulo de auth del backend.
-- · Reproducible: usa setseed(), mismos datos en cada carga limpia.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM restaurante WHERE slug = 'la-cuchara-de-san-blas') THEN
        RAISE EXCEPTION 'Los datos semilla ya están cargados (existe la-cuchara-de-san-blas).';
    END IF;
END $$;

SELECT setseed(0.42);

-- -----------------------------------------------------------------------------
-- 1. Zona que faltaba en el esquema base (el prototipo ubica ahí a Don Vicho)
-- -----------------------------------------------------------------------------
INSERT INTO zona (ciudad_id, nombre, slug, latitud, longitud)
SELECT ciudad_id, 'Villaflora', 'villaflora', -0.2450, -78.5210 FROM ciudad WHERE pais_codigo = 'EC' AND slug = 'quito'
ON CONFLICT (ciudad_id, slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Usuarios: personal de los locales + comensales
-- -----------------------------------------------------------------------------
INSERT INTO usuario (nombre, nombre_usuario, correo, telefono_e164, pais_codigo, acepto_terminos_version, acepto_terminos_en, consiente_analitica)
SELECT v.nombre, v.usr, v.usr || '@demo.bocadoo.test', '+5939900000' || lpad(v.n::TEXT, 2, '0'), 'EC', 'v1', CURRENT_TIMESTAMP - INTERVAL '60 days', true
  FROM (VALUES
    -- personal
    ( 1, 'María Guamán',      'maria.guaman'),
    ( 2, 'Juan Pilataxi',     'juan.pilataxi'),
    ( 3, 'Daniela Andrade',   'daniela.andrade'),
    ( 4, 'Ramón Zambrano',    'ramon.zambrano'),
    ( 5, 'Lucía Paredes',     'lucia.paredes'),
    ( 6, 'Vicente Chicaiza',  'vicente.chicaiza'),
    -- comensales
    (11, 'Carlos Mejía',      'carlos.mejia'),
    (12, 'Andrea Suárez',     'andrea.suarez'),
    (13, 'Diego Proaño',      'diego.proano'),
    (14, 'Valentina Ortiz',   'valentina.ortiz'),
    (15, 'Sebastián Cárdenas','sebastian.cardenas'),
    (16, 'Camila Jaramillo',  'camila.jaramillo'),
    (17, 'Mateo Villacís',    'mateo.villacis'),
    (18, 'Gabriela Endara',   'gabriela.endara'),
    (19, 'Esteban Narváez',   'esteban.narvaez'),
    (20, 'Paula Montalvo',    'paula.montalvo'),
    (21, 'José Tipán',        'jose.tipan'),
    (22, 'Fernanda Cueva',    'fernanda.cueva'),
    (23, 'Kevin Simbaña',     'kevin.simbana'),
    (24, 'Daniela Recalde',   'daniela.recalde')
  ) AS v(n, nombre, usr);

UPDATE usuario u SET zona_preferida_id = z.zona_id
  FROM zona z WHERE z.slug = 'puce' AND u.correo LIKE '%@demo.bocadoo.test' AND u.telefono_e164 >= '+593990000011';

-- -----------------------------------------------------------------------------
-- 3. Restaurantes (datos del prototipo) + horarios + personal + plan SaaS gratuito
-- -----------------------------------------------------------------------------
INSERT INTO restaurante (nombre, slug, descripcion_corta, etiquetas, pais_codigo, ciudad_id, zona_id, moneda_codigo, zona_horaria,
                         direccion, latitud, longitud, telefono_e164, puestos, precio_suelto_centavos, recargo_para_llevar_centavos, estado)
SELECT v.nombre, v.slug, v.descripcion, v.etiquetas, 'EC', c.ciudad_id, z.zona_id, 'USD', c.zona_horaria,
       v.direccion, v.lat, v.lng, v.tel, v.puestos, v.suelto, v.recargo, 'ACTIVO'
  FROM (VALUES
    ('La Cuchara de San Blas', 'la-cuchara-de-san-blas', 'Comida casera tradicional frente a la PUCE', ARRAY['Comida casera','Sazón quiteña','Opción vegetariana'],
     'puce',       'Av. 12 de Octubre N24-110 y La Católica',              -0.2115, -78.4912, '+593990000101', 28, 300, 25),
    ('Verde Limón',            'verde-limon',            'Almuerzos saludables y ensaladas en La Floresta', ARRAY['Saludable','Ensaladas frescas','Céntrico'],
     'floresta',   'Calle Madrid 1159 y Coruña, La Floresta',              -0.2085, -78.4870, '+593990000102', 18, 325, 30),
    ('El Rincón Manabita',     'el-rincon-manabita',     'Especialidad en mariscos y sazón manaba tradicional', ARRAY['Mariscos frescos','Plátano verde','Porción generosa'],
     'mariscal',   'Av. Amazonas N22-48 y Calle Mariscal Foch',            -0.2030, -78.4925, '+593990000103', 24, 350, 25),
    ('Sazón Criolla',          'sazon-criolla',          'Almuerzo ejecutivo universitario junto a la USFQ', ARRAY['Almuerzos ejecutivos','Ambiente universitario','Rápido'],
     'cumbaya',    'Av. Pampite y Vía Interoceánica, edif. Platinum Plaza', -0.1980, -78.4350, '+593990000104', 32, 375, 35),
    ('Don Vicho Almuerzos',    'don-vicho-almuerzos',    'El almuerzo rendidor y económico del sur de Quito', ARRAY['Económico','Sopa criolla'],
     'villaflora', 'Av. Rodrigo de Chávez OE1-24 y 5 de Junio',            -0.2450, -78.5210, '+593990000105', 16, 275, 20)
  ) AS v(nombre, slug, descripcion, etiquetas, zona, direccion, lat, lng, tel, puestos, suelto, recargo)
  JOIN ciudad c ON c.pais_codigo = 'EC' AND c.slug = 'quito'
  JOIN zona z   ON z.ciudad_id = c.ciudad_id AND z.slug = v.zona;

-- Lunes a viernes; La Cuchara y El Rincón Manabita también abren sábado.
INSERT INTO restaurante_horario (restaurante_id, dia_semana, abre, cierra)
SELECT r.restaurante_id, d, v.abre, v.cierra
  FROM (VALUES ('la-cuchara-de-san-blas', TIME '11:30', TIME '15:30', 6),
               ('verde-limon',            TIME '12:00', TIME '15:30', 5),
               ('el-rincon-manabita',     TIME '11:30', TIME '16:00', 6),
               ('sazon-criolla',          TIME '12:00', TIME '16:00', 5),
               ('don-vicho-almuerzos',    TIME '11:00', TIME '14:30', 5)) AS v(slug, abre, cierra, ultimo_dia)
  JOIN restaurante r ON r.slug = v.slug
  CROSS JOIN LATERAL generate_series(1, v.ultimo_dia) AS d;

INSERT INTO personal_restaurante (restaurante_id, usuario_id, rol, nombre_visible)
SELECT r.restaurante_id, u.usuario_id, v.rol::rol_personal_enum, v.visible
  FROM (VALUES ('la-cuchara-de-san-blas', 'maria.guaman',     'DUENO',  'María Guamán'),
               ('la-cuchara-de-san-blas', 'juan.pilataxi',    'CAJERO', 'Juanito (Caja)'),
               ('verde-limon',            'daniela.andrade',  'DUENO',  'Daniela Andrade'),
               ('el-rincon-manabita',     'ramon.zambrano',   'DUENO',  'Ramón Zambrano'),
               ('sazon-criolla',          'lucia.paredes',    'DUENO',  'Lucía Paredes'),
               ('don-vicho-almuerzos',    'vicente.chicaiza', 'DUENO',  'Don Vicho')) AS v(slug, usr, rol, visible)
  JOIN restaurante r ON r.slug = v.slug
  JOIN usuario u     ON u.nombre_usuario = v.usr;

INSERT INTO suscripcion_saas_restaurante (restaurante_id, plan_saas_id, estado, inicio_ciclo_actual, fin_ciclo_actual)
SELECT r.restaurante_id, p.plan_saas_id, 'FREEMIUM', date_trunc('month', CURRENT_DATE)::DATE,
       (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::DATE
  FROM restaurante r CROSS JOIN catalogo_plan_saas p
 WHERE p.codigo = 'FREEMIUM' AND r.slug IN ('la-cuchara-de-san-blas','verde-limon','el-rincon-manabita','sazon-criolla','don-vicho-almuerzos');

INSERT INTO mesa_local (restaurante_id, etiqueta, capacidad)
SELECT r.restaurante_id, 'Mesa ' || n, CASE WHEN n <= 5 THEN 4 ELSE 2 END
  FROM restaurante r CROSS JOIN generate_series(1, 9) AS n WHERE r.slug = 'la-cuchara-de-san-blas';

INSERT INTO tarjeta_sellos_config (restaurante_id, nombre, activa, meta, premio, cuenta)
SELECT restaurante_id, 'Tarjeta de la casa', true, 10, 'Un almuerzo gratis', 'ALMUERZO' FROM restaurante WHERE slug = 'la-cuchara-de-san-blas';

-- -----------------------------------------------------------------------------
-- 4. Catálogo de platos
-- -----------------------------------------------------------------------------
INSERT INTO plato (restaurante_id, categoria, seccion, nombre, descripcion, precio_centavos, etiquetas)
SELECT r.restaurante_id, v.categoria::categoria_plato_enum, v.seccion::seccion_menu_enum, v.nombre, v.descripcion, v.precio, v.etiquetas
  FROM (VALUES
    -- La Cuchara de San Blas: almuerzo
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'SOPA',   'Locro de papa',            'Con queso fresco y aguacate',        NULL, ARRAY['vegetariano']),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'SOPA',   'Sopa de quinua',           'Con verduras de la sierra',          NULL, ARRAY['vegetariano']),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'SOPA',   'Caldo de pollo',           'Con fideo y papa',                   NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'SOPA',   'Crema de zapallo',         NULL,                                 NULL, ARRAY['vegetariano']),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'SOPA',   'Sopa de bolas de verde',   NULL,                                 NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'FUERTE', 'Seco de pollo',            'Con arroz amarillo y maduro',        NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'FUERTE', 'Carne apanada',            'Con arroz, menestra y ensalada',     NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'FUERTE', 'Guatita',                  'Con arroz y aguacate',               NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'FUERTE', 'Pescado frito',            'Con arroz y patacones',              NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'FUERTE', 'Menestra de lenteja con tortilla de huevo', 'Opción vegetariana', NULL, ARRAY['vegetariano']),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'FUERTE', 'Chuleta al jugo',          'Con arroz y ensalada fresca',        NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'JUGO',   'Jugo de tomate de árbol',  NULL,                                 NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'JUGO',   'Jugo de mora',             NULL,                                 NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'JUGO',   'Limonada',                 NULL,                                 NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'POSTRE', 'Gelatina',                 NULL,                                 NULL, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'ALMUERZO', 'POSTRE', 'Durazno en almíbar',       NULL,                                 NULL, ARRAY[]::TEXT[]),
    -- La Cuchara de San Blas: carta, extras y bebidas
    ('la-cuchara-de-san-blas', 'A_LA_CARTA', NULL,   'Churrasco',                'Carne, huevos, arroz, papas y aguacate', 650, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'A_LA_CARTA', NULL,   'Arroz con camarón',        NULL,                                  700, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'EXTRA',  'ADICIONAL', 'Porción de arroz',        NULL,                                  100, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'EXTRA',  'ADICIONAL', 'Huevo frito',             NULL,                                   75, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'EXTRA',  'ADICIONAL', 'Porción de aguacate',     NULL,                                  100, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'BEBIDA', NULL,        'Gaseosa personal',        NULL,                                  100, ARRAY[]::TEXT[]),
    ('la-cuchara-de-san-blas', 'BEBIDA', NULL,        'Agua sin gas',            NULL,                                   75, ARRAY[]::TEXT[]),
    -- Otros locales: lo mínimo para que su ficha y su menú de hoy no salgan vacíos
    ('verde-limon',         'ALMUERZO', 'SOPA',   'Crema de espinaca',           NULL, NULL, ARRAY['vegetariano']),
    ('verde-limon',         'ALMUERZO', 'FUERTE', 'Pollo a la plancha con ensalada', NULL, NULL, ARRAY[]::TEXT[]),
    ('verde-limon',         'ALMUERZO', 'FUERTE', 'Bowl de quinua y vegetales',  NULL, NULL, ARRAY['vegetariano']),
    ('verde-limon',         'ALMUERZO', 'JUGO',   'Jugo verde',                  NULL, NULL, ARRAY[]::TEXT[]),
    ('el-rincon-manabita',  'ALMUERZO', 'SOPA',   'Viche de pescado',            NULL, NULL, ARRAY[]::TEXT[]),
    ('el-rincon-manabita',  'ALMUERZO', 'FUERTE', 'Corvina apanada con patacones', NULL, NULL, ARRAY[]::TEXT[]),
    ('el-rincon-manabita',  'ALMUERZO', 'FUERTE', 'Seco de gallina criolla',     NULL, NULL, ARRAY[]::TEXT[]),
    ('el-rincon-manabita',  'ALMUERZO', 'JUGO',   'Jugo de maracuyá',            NULL, NULL, ARRAY[]::TEXT[]),
    ('sazon-criolla',       'ALMUERZO', 'SOPA',   'Sopa de fideo con queso',     NULL, NULL, ARRAY['vegetariano']),
    ('sazon-criolla',       'ALMUERZO', 'FUERTE', 'Lomo saltado',                NULL, NULL, ARRAY[]::TEXT[]),
    ('sazon-criolla',       'ALMUERZO', 'FUERTE', 'Pollo al horno',              NULL, NULL, ARRAY[]::TEXT[]),
    ('sazon-criolla',       'ALMUERZO', 'JUGO',   'Jugo de naranjilla',          NULL, NULL, ARRAY[]::TEXT[]),
    ('don-vicho-almuerzos', 'ALMUERZO', 'SOPA',   'Sopa de arroz de cebada',     NULL, NULL, ARRAY[]::TEXT[]),
    ('don-vicho-almuerzos', 'ALMUERZO', 'FUERTE', 'Estofado de carne',           NULL, NULL, ARRAY[]::TEXT[]),
    ('don-vicho-almuerzos', 'ALMUERZO', 'JUGO',   'Avena con naranjilla',        NULL, NULL, ARRAY[]::TEXT[])
  ) AS v(slug, categoria, seccion, nombre, descripcion, precio, etiquetas)
  JOIN restaurante r ON r.slug = v.slug;

-- -----------------------------------------------------------------------------
-- 5. Plantillas de plan (La Cuchara usa los planes de ejemplo del prototipo)
-- -----------------------------------------------------------------------------
INSERT INTO plantilla_plan (restaurante_id, tipo, nombre, almuerzos, precio_centavos, vigencia_dias, cupos, dias_validos, incluye, visible_en_marketplace)
SELECT r.restaurante_id, v.tipo::tipo_plan_enum, v.nombre, v.almuerzos, v.precio, v.vigencia, v.cupos, v.dias::SMALLINT[], v.incluye, true
  FROM (VALUES
    ('la-cuchara-de-san-blas', 'SEMANAL',   'Plan semanal',           5, 1500,  7, 20,   '{1,2,3,4,5}',   ARRAY['Sopa','Segundo','Jugo']),
    ('la-cuchara-de-san-blas', 'QUINCENAL', 'Plan quincenal',        10, 2800, 15, 20,   '{1,2,3,4,5}',   ARRAY['Sopa','Segundo','Jugo']),
    ('la-cuchara-de-san-blas', 'MENSUAL',   'Plan mensual ejecutivo',20, 5200, 30, 30,   '{1,2,3,4,5,6}', ARRAY['Sopa','Segundo','Jugo','Postre']),
    ('verde-limon',            'MENSUAL',   'Mes saludable',         20, 5800, 30, NULL, '{1,2,3,4,5}',   ARRAY['Entrada','Plato fuerte','Jugo natural']),
    ('verde-limon',            'SEMANAL',   'Semana ligera',          5, 1550,  7, NULL, '{1,2,3,4,5}',   ARRAY['Entrada','Plato fuerte','Jugo natural']),
    ('el-rincon-manabita',     'MENSUAL',   'Mensual manaba',        20, 6200, 30, 15,   '{1,2,3,4,5,6}', ARRAY['Sopa','Segundo','Jugo']),
    ('sazon-criolla',          'QUINCENAL', 'Quincena ejecutiva',    10, 3500, 15, NULL, '{1,2,3,4,5}',   ARRAY['Sopa','Segundo','Jugo','Postre']),
    ('sazon-criolla',          'MENSUAL',   'Mes ejecutivo',         20, 6600, 30, NULL, '{1,2,3,4,5}',   ARRAY['Sopa','Segundo','Jugo','Postre']),
    ('don-vicho-almuerzos',    'MENSUAL',   'Mensual rendidor',      20, 4800, 30, NULL, '{1,2,3,4,5}',   ARRAY['Sopa','Segundo','Jugo'])
  ) AS v(slug, tipo, nombre, almuerzos, precio, vigencia, cupos, dias, incluye)
  JOIN restaurante r ON r.slug = v.slug;

-- -----------------------------------------------------------------------------
-- 6. Clientes de La Cuchara: 14 con app + 2 de cartulina (sin usuario todavía)
-- -----------------------------------------------------------------------------
INSERT INTO cliente_restaurante (restaurante_id, usuario_id, nombre, telefono_e164, correo, creado_en)
SELECT r.restaurante_id, u.usuario_id, u.nombre, u.telefono_e164, u.correo, CURRENT_TIMESTAMP - INTERVAL '55 days'
  FROM restaurante r JOIN usuario u ON u.telefono_e164 BETWEEN '+593990000011' AND '+593990000024'
 WHERE r.slug = 'la-cuchara-de-san-blas'
 ORDER BY u.telefono_e164;

INSERT INTO cliente_restaurante (restaurante_id, nombre, telefono_e164, nota, creado_en)
SELECT r.restaurante_id, v.nombre, v.tel, 'Migrado desde cartulina', CURRENT_TIMESTAMP - INTERVAL '10 days'
  FROM restaurante r, (VALUES ('Sr. Olmedo (cartulina)', '+593990000031'), ('Rosita Caiza (cartulina)', '+593990000032')) AS v(nombre, tel)
 WHERE r.slug = 'la-cuchara-de-san-blas';

-- Carlos Mejía (el comensal demo) también es cliente de Verde Limón, sin plan: caso "MORADO" del escáner.
INSERT INTO cliente_restaurante (restaurante_id, usuario_id, nombre, telefono_e164, correo)
SELECT r.restaurante_id, u.usuario_id, u.nombre, u.telefono_e164, u.correo
  FROM restaurante r, usuario u WHERE r.slug = 'verde-limon' AND u.nombre_usuario = 'carlos.mejia';

-- -----------------------------------------------------------------------------
-- 7. Historia simulada de La Cuchara de San Blas (últimos 50 días)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_rid     BIGINT;
    v_tz      TEXT;
    v_hoy     DATE;
    v_ahora   TIMESTAMPTZ := CURRENT_TIMESTAMP;
    v_duena   BIGINT;
    v_cajero  BIGINT;
    v_met     BIGINT[];          -- [efectivo, transferencia, deuna]
    v_met_id  BIGINT;
    v_cli     RECORD;
    v_plan    RECORD;
    v_i       INTEGER := 0;
    v_ronda   INTEGER;
    v_compra  DATE;
    v_vence   DATE;
    v_sus     BIGINT;
    v_rest    INTEGER;
    v_d       DATE;
    v_ts      TIMESTAMPTZ;
    v_staff   BIGINT;
    v_prob    NUMERIC;
    v_menu    BIGINT;
    v_dia_n   INTEGER := 0;
    v_ticket  INTEGER;
    v_venta   BIGINT;
    v_n       INTEGER;
    v_llevar  BOOLEAN;
    v_total   BIGINT;
    v_comp_ts TIMESTAMPTZ;
BEGIN
    SELECT restaurante_id, zona_horaria INTO v_rid, v_tz FROM restaurante WHERE slug = 'la-cuchara-de-san-blas';
    v_hoy := (v_ahora AT TIME ZONE v_tz)::DATE;
    SELECT personal_id INTO v_duena  FROM personal_restaurante WHERE restaurante_id = v_rid AND rol = 'DUENO';
    SELECT personal_id INTO v_cajero FROM personal_restaurante WHERE restaurante_id = v_rid AND rol = 'CAJERO';
    v_met := ARRAY[(SELECT metodo_pago_id FROM metodo_pago WHERE codigo = 'EFECTIVO'),
                   (SELECT metodo_pago_id FROM metodo_pago WHERE codigo = 'TRANSFERENCIA'),
                   (SELECT metodo_pago_id FROM metodo_pago WHERE codigo = 'DEUNA')];

    -- 7.1 Menú del día de cada día hábil (L-S): 2 sopas, 3 fuertes, 1 jugo, 1 postre, rotando el catálogo.
    FOR v_d IN SELECT g::DATE FROM generate_series(v_hoy - 50, v_hoy, INTERVAL '1 day') g WHERE EXTRACT(ISODOW FROM g) <= 6
    LOOP
        v_dia_n := v_dia_n + 1;
        INSERT INTO menu_diario_cabecera (restaurante_id, fecha_local, publicado_en, publicado_por_personal_id, creado_en)
        VALUES (v_rid, v_d, (v_d + TIME '10:40') AT TIME ZONE v_tz, v_duena, (v_d + TIME '10:30') AT TIME ZONE v_tz)
        RETURNING menu_diario_id INTO v_menu;

        INSERT INTO menu_diario_detalle (menu_diario_id, restaurante_id, plato_id, seccion, porciones, orden)
        SELECT v_menu, v_rid, x.plato_id, x.seccion, CASE x.seccion WHEN 'FUERTE' THEN 25 WHEN 'SOPA' THEN 40 END, x.pos
          FROM (SELECT p.plato_id, p.seccion,
                       ((row_number() OVER (PARTITION BY p.seccion ORDER BY p.plato_id) - 1 + v_dia_n)
                         % count(*) OVER (PARTITION BY p.seccion))::INTEGER AS pos
                  FROM plato p WHERE p.restaurante_id = v_rid AND p.categoria = 'ALMUERZO') x
         WHERE x.pos < CASE x.seccion WHEN 'SOPA' THEN 2 WHEN 'FUERTE' THEN 3 ELSE 1 END;

        -- En 1 de cada 3 días pasados el primer plato fuerte se agota antes del cierre.
        IF v_d < v_hoy AND v_dia_n % 3 = 0 THEN
            UPDATE menu_diario_detalle
               SET agotado = true, agotado_en = (v_d + TIME '13:20' + random() * INTERVAL '50 minutes') AT TIME ZONE v_tz
             WHERE menu_diario_id = v_menu AND seccion = 'FUERTE' AND orden = 0;
        END IF;
    END LOOP;

    -- 7.2 Planes vendidos y almuerzos consumidos, cliente por cliente.
    --     Ronda 1: plan mensual comprado hace ~48 días (ya vencido o agotado).
    --     Ronda 2: plan vigente, comprado en los últimos 18 días. Algunos clientes no renovaron.
    FOR v_cli IN SELECT cliente_id, usuario_id FROM cliente_restaurante
                  WHERE restaurante_id = v_rid AND usuario_id IS NOT NULL ORDER BY cliente_id
    LOOP
        v_i := v_i + 1;
        v_prob := 0.60 + (v_i % 4) * 0.10;                 -- cada cliente tiene su propia constancia (60–90 %)
        FOR v_ronda IN 1..2 LOOP
            CONTINUE WHEN v_ronda = 2 AND v_i % 6 = 0;     -- clientes que no renovaron (seguimiento)
            CONTINUE WHEN v_ronda = 1 AND v_i % 5 = 0;     -- clientes nuevos de este mes

            IF v_ronda = 1 THEN
                SELECT * INTO v_plan FROM plantilla_plan WHERE restaurante_id = v_rid AND tipo = 'MENSUAL';
                v_compra := v_hoy - 48 + (v_i % 5);
            ELSE
                SELECT * INTO v_plan FROM plantilla_plan WHERE restaurante_id = v_rid
                   AND tipo = (ARRAY['MENSUAL','MENSUAL','QUINCENAL','MENSUAL','SEMANAL'])[1 + v_i % 5]::tipo_plan_enum;
                v_compra := v_hoy - CASE v_plan.tipo WHEN 'SEMANAL' THEN 2 + v_i % 3
                                                     WHEN 'QUINCENAL' THEN 3 + v_i % 9
                                                     ELSE 2 + (v_i * 3) % 12 END;   -- siempre después de que venció el plan anterior
            END IF;
            -- La compra cae en día hábil.
            WHILE EXTRACT(ISODOW FROM v_compra) > 5 LOOP v_compra := v_compra + 1; END LOOP;
            v_vence := v_compra + v_plan.vigencia_dias - 1;
            v_ts    := (v_compra + TIME '12:05' + random() * INTERVAL '90 minutes') AT TIME ZONE v_tz;
            v_comp_ts := v_ts;
            v_staff := CASE WHEN random() < 0.7 THEN v_cajero ELSE v_duena END;
            v_met_id := v_met[CASE WHEN random() < 0.50 THEN 1 WHEN random() < 0.55 THEN 2 ELSE 3 END];

            INSERT INTO suscripcion_plan (restaurante_id, cliente_id, plantilla_plan_id, origen, nombre_plan, almuerzos_totales,
                                          almuerzos_restantes, precio_pagado_centavos, precio_unitario_centavos, moneda_codigo,
                                          dias_validos, comprada_en, vence_el, vendida_por_personal_id)
            VALUES (v_rid, v_cli.cliente_id, v_plan.plantilla_plan_id, 'VENTA', v_plan.nombre, v_plan.almuerzos,
                    v_plan.almuerzos, v_plan.precio_centavos, v_plan.precio_centavos / v_plan.almuerzos, 'USD',
                    v_plan.dias_validos, v_ts, v_vence, v_staff)
            RETURNING suscripcion_id INTO v_sus;

            INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, suscripcion_id,
                                          cobrado_por_personal_id, fecha_local, referencia_externa, clave_idempotencia, creado_en)
            VALUES (v_rid, v_met_id, v_plan.precio_centavos, 'USD', v_sus, v_staff, v_compra,
                    CASE WHEN v_met_id <> v_met[1] THEN 'DEMO-' || v_sus END, gen_random_uuid(), v_ts);

            -- Un almuerzo por día válido, según la constancia del cliente, hasta agotar o vencer.
            v_rest := v_plan.almuerzos;
            FOR v_d IN SELECT g::DATE FROM generate_series(v_compra, LEAST(v_vence, v_hoy), INTERVAL '1 day') g
            LOOP
                EXIT WHEN v_rest = 0;
                CONTINUE WHEN NOT (EXTRACT(ISODOW FROM v_d)::SMALLINT = ANY (v_plan.dias_validos));
                CONTINUE WHEN random() > v_prob * CASE WHEN EXTRACT(ISODOW FROM v_d) = 6 THEN 0.3 ELSE 1 END;
                -- Hora pico alrededor de las 13:00 (suma de dos uniformes = campana).
                v_ts := (v_d + TIME '12:00' + (random() + random()) * INTERVAL '75 minutes') AT TIME ZONE v_tz;
                CONTINUE WHEN v_ts > v_ahora OR v_ts < v_comp_ts;   -- ni en el futuro ni antes de haber comprado el plan
                v_llevar := random() < 0.12;
                INSERT INTO consumo_almuerzo (restaurante_id, suscripcion_id, cliente_id, personal_id, canal, para_llevar,
                                              valor_unitario_centavos, clave_idempotencia, fecha_local, creado_en)
                VALUES (v_rid, v_sus, v_cli.cliente_id, CASE WHEN random() < 0.8 THEN v_cajero ELSE v_duena END,
                        CASE WHEN random() < 0.93 THEN 'QR' ELSE 'MANUAL' END::canal_consumo_enum, v_llevar,
                        v_plan.precio_centavos / v_plan.almuerzos, gen_random_uuid(), v_d, v_ts);
                v_rest := v_rest - 1;
            END LOOP;

            UPDATE suscripcion_plan
               SET almuerzos_restantes = v_rest,
                   estado = CASE WHEN v_rest = 0 THEN 'AGOTADA' WHEN v_vence < v_hoy THEN 'VENCIDA' ELSE 'ACTIVA' END::estado_suscripcion_enum
             WHERE suscripcion_id = v_sus;
        END LOOP;
    END LOOP;

    -- 7.3 Cartulinas migradas: saldo que traían en papel, sin pago registrado en la app.
    INSERT INTO suscripcion_plan (restaurante_id, cliente_id, origen, nombre_plan, almuerzos_totales, almuerzos_restantes,
                                  precio_pagado_centavos, precio_unitario_centavos, moneda_codigo, dias_validos,
                                  comprada_en, vence_el, vendida_por_personal_id, anotacion)
    SELECT v_rid, c.cliente_id, 'MIGRADA', 'Cartulina migrada', 20, 7 + (c.cliente_id % 5), 0, 260, 'USD', '{1,2,3,4,5,6}',
           v_ahora - INTERVAL '10 days', v_hoy + 12, v_duena, 'Saldo según cartulina física'
      FROM cliente_restaurante c WHERE c.restaurante_id = v_rid AND c.usuario_id IS NULL;

    -- 7.4 Cobros sueltos en el POS (comensales sin plan): 3 a 9 por día hábil.
    FOR v_d IN SELECT g::DATE FROM generate_series(v_hoy - 50, v_hoy, INTERVAL '1 day') g WHERE EXTRACT(ISODOW FROM g) <= 6
    LOOP
        v_ticket := 0;
        FOR v_n IN 1..(CASE WHEN EXTRACT(ISODOW FROM v_d) = 6 THEN 2 ELSE 3 END + floor(random() * 7)::INTEGER) LOOP
            v_ts := (v_d + TIME '11:50' + (random() + random()) * INTERVAL '90 minutes') AT TIME ZONE v_tz;
            CONTINUE WHEN v_ts > v_ahora;
            v_ticket := v_ticket + 1;
            v_llevar := random() < 0.2;
            v_total  := 300 + CASE WHEN v_llevar THEN 25 ELSE 0 END;
            v_staff  := CASE WHEN random() < 0.8 THEN v_cajero ELSE v_duena END;

            INSERT INTO venta_pos_cabecera (restaurante_id, fecha_local, ticket, modo, para_llevar, total_centavos, moneda_codigo,
                                            personal_id, clave_idempotencia, creado_en)
            VALUES (v_rid, v_d, v_ticket, 'DIRECTA', v_llevar, v_total, 'USD', v_staff, gen_random_uuid(), v_ts)
            RETURNING venta_pos_id INTO v_venta;

            INSERT INTO venta_pos_detalle (venta_pos_id, restaurante_id, nombre_item, es_almuerzo, cantidad, precio_unitario_centavos, subtotal_centavos)
            VALUES (v_venta, v_rid, 'Almuerzo suelto', true, 1, 300, 300);
            IF v_llevar THEN
                INSERT INTO venta_pos_detalle (venta_pos_id, restaurante_id, nombre_item, es_almuerzo, cantidad, precio_unitario_centavos, subtotal_centavos)
                VALUES (v_venta, v_rid, 'Recargo para llevar', false, 1, 25, 25);
            END IF;

            INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, venta_pos_id,
                                          cobrado_por_personal_id, fecha_local, clave_idempotencia, creado_en)
            VALUES (v_rid, v_met[CASE WHEN random() < 0.65 THEN 1 WHEN random() < 0.5 THEN 2 ELSE 3 END], v_total, 'USD',
                    v_venta, v_staff, v_d, gen_random_uuid(), v_ts);
        END LOOP;
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 8. Derivados de la historia (La Cuchara de San Blas)
-- -----------------------------------------------------------------------------
-- Cada validación exitosa quedó registrada como intento de escaneo.
INSERT INTO intento_escaneo (restaurante_id, personal_id, cliente_id, usuario_id, canal, resultado, consumo_id, creado_en)
SELECT c.restaurante_id, c.personal_id, c.cliente_id, cl.usuario_id, c.canal, 'OK', c.consumo_id, c.creado_en
  FROM consumo_almuerzo c JOIN cliente_restaurante cl ON cl.cliente_id = c.cliente_id;

-- Y algunos rechazados: llegó con el plan agotado o vencido, o un doble escaneo.
INSERT INTO intento_escaneo (restaurante_id, personal_id, cliente_id, usuario_id, canal, resultado, creado_en)
SELECT s.restaurante_id, s.vendida_por_personal_id, s.cliente_id, cl.usuario_id, 'QR',
       CASE s.estado WHEN 'AGOTADA' THEN 'SIN_SALDO' ELSE 'VENCIDO' END::resultado_escaneo_enum,
       ((s.vence_el + 1 + TIME '12:40') AT TIME ZONE r.zona_horaria)
  FROM suscripcion_plan s
  JOIN cliente_restaurante cl ON cl.cliente_id = s.cliente_id
  JOIN restaurante r ON r.restaurante_id = s.restaurante_id
 WHERE s.estado IN ('AGOTADA', 'VENCIDA') AND s.suscripcion_id % 2 = 0
   AND ((s.vence_el + 1 + TIME '12:40') AT TIME ZONE r.zona_horaria) < CURRENT_TIMESTAMP;

INSERT INTO intento_escaneo (restaurante_id, personal_id, cliente_id, usuario_id, canal, resultado, creado_en)
SELECT c.restaurante_id, c.personal_id, c.cliente_id, cl.usuario_id, 'QR', 'DUPLICADO', c.creado_en + INTERVAL '12 seconds'
  FROM consumo_almuerzo c JOIN cliente_restaurante cl ON cl.cliente_id = c.cliente_id
 WHERE c.consumo_id % 23 = 0;

-- Opiniones "¿Qué tal hoy?": ~40 % de los almuerzos, unos 25–60 min después. Mayoría positivas.
INSERT INTO opinion (restaurante_id, consumo_id, cliente_id, etiquetas, comentario_privado, descartada, creado_en)
SELECT c.restaurante_id, c.consumo_id, c.cliente_id,
       CASE WHEN c.consumo_id % 11 = 0 THEN ARRAY['Poca porción']
            WHEN c.consumo_id % 17 = 0 THEN ARRAY['Demoró mucho']
            WHEN c.consumo_id % 13 = 0 THEN '{}'::TEXT[]
            WHEN c.consumo_id % 3 = 0  THEN ARRAY['Buena sazón', 'Buena porción']
            WHEN c.consumo_id % 3 = 1  THEN ARRAY['Buena sazón', 'Atención rápida']
            ELSE ARRAY['Buena sazón', 'Buena porción', 'Atención rápida'] END,
       CASE WHEN c.consumo_id % 11 = 0 THEN 'Hoy el segundo vino con menos arroz que de costumbre.'
            WHEN c.consumo_id % 17 = 0 THEN 'Esperé casi 20 minutos por la sopa.' END,
       c.consumo_id % 13 = 0,
       c.creado_en + INTERVAL '25 minutes' + random() * INTERVAL '35 minutes'
  FROM consumo_almuerzo c
 WHERE random() < 0.40 AND c.creado_en < CURRENT_TIMESTAMP - INTERVAL '1 hour';

-- La dueña respondió las quejas antiguas; las de los últimos 3 días siguen sin responder.
UPDATE opinion o
   SET respuesta_restaurante = 'Gracias por avisarnos, ya lo conversamos en cocina. ¡Te esperamos!',
       respondido_en = o.creado_en + INTERVAL '3 hours',
       respondido_por_personal_id = (SELECT personal_id FROM personal_restaurante p WHERE p.restaurante_id = o.restaurante_id AND p.rol = 'DUENO')
 WHERE o.comentario_privado IS NOT NULL AND o.creado_en < CURRENT_TIMESTAMP - INTERVAL '3 days';

-- Un reclamo pendiente sobre el almuerzo más reciente de Carlos Mejía.
INSERT INTO reclamo (restaurante_id, consumo_id, cliente_id, mensaje)
SELECT c.restaurante_id, c.consumo_id, c.cliente_id, 'Me descontaron el almuerzo pero no alcancé a comer, ya no había segundo.'
  FROM consumo_almuerzo c
  JOIN cliente_restaurante cl ON cl.cliente_id = c.cliente_id
  JOIN usuario u ON u.usuario_id = cl.usuario_id AND u.nombre_usuario = 'carlos.mejia'
 ORDER BY c.creado_en DESC LIMIT 1;

-- Sellos: los suma la base sola (trigger trg_sellos_por_consumo, migración 20261117000500) al insertar cada
-- consumo: un sello por almuerzo y, cada 10, un premio disponible. Por eso aquí ya no se insertan.

-- -----------------------------------------------------------------------------
-- 9. Lo que está pasando "ahora" (para las pantallas en vivo)
-- -----------------------------------------------------------------------------
-- Menú de hoy en los otros 4 locales.
WITH m AS (
    INSERT INTO menu_diario_cabecera (restaurante_id, fecha_local, publicado_en)
    SELECT r.restaurante_id, (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::DATE, CURRENT_TIMESTAMP - INTERVAL '2 hours'
      FROM restaurante r WHERE r.slug IN ('verde-limon', 'el-rincon-manabita', 'sazon-criolla', 'don-vicho-almuerzos')
    RETURNING menu_diario_id, restaurante_id)
INSERT INTO menu_diario_detalle (menu_diario_id, restaurante_id, plato_id, seccion)
SELECT m.menu_diario_id, m.restaurante_id, p.plato_id, p.seccion
  FROM m JOIN plato p ON p.restaurante_id = m.restaurante_id AND p.categoria = 'ALMUERZO';

-- Oferta flash activa (90 min) + una de ayer que se canjeó casi completa.
INSERT INTO oferta_flash (restaurante_id, plato_id, titulo, descripcion, precio_centavos, precio_original_centavos, moneda_codigo,
                          stock_total, stock_restante, inicia_en, expira_en, activa, creada_por_personal_id, creada_en)
SELECT r.restaurante_id, p.plato_id, v.titulo, v.descripcion, v.precio, v.original, 'USD', v.stock, v.restante,
       CURRENT_TIMESTAMP - v.hace, CURRENT_TIMESTAMP - v.hace + INTERVAL '2 hours', v.activa, pr.personal_id, CURRENT_TIMESTAMP - v.hace
  FROM (VALUES ('Churrasco a mitad de tarde', 'Últimos churrascos del día',  450, 650, 8, 5, INTERVAL '30 minutes', true),
               ('Churrasco 2x cuadra',        'Oferta de ayer por cierre',   480, 650, 6, 1, INTERVAL '26 hours',   false)
       ) AS v(titulo, descripcion, precio, original, stock, restante, hace, activa)
  JOIN restaurante r ON r.slug = 'la-cuchara-de-san-blas'
  JOIN plato p ON p.restaurante_id = r.restaurante_id AND p.nombre = 'Churrasco'
  JOIN personal_restaurante pr ON pr.restaurante_id = r.restaurante_id AND pr.rol = 'DUENO';

WITH canjes AS (
    INSERT INTO canje_oferta_flash (restaurante_id, oferta_flash_id, usuario_id, personal_id, monto_centavos, clave_idempotencia, creado_en)
    SELECT o.restaurante_id, o.oferta_flash_id, cl.usuario_id, pr.personal_id, o.precio_centavos, gen_random_uuid(),
           o.inicia_en + n * INTERVAL '8 minutes'
      FROM oferta_flash o
      JOIN personal_restaurante pr ON pr.restaurante_id = o.restaurante_id AND pr.rol = 'CAJERO'
      CROSS JOIN generate_series(1, 8) AS n
      JOIN LATERAL (SELECT c.usuario_id FROM cliente_restaurante c
                     WHERE c.restaurante_id = o.restaurante_id AND c.usuario_id IS NOT NULL
                     ORDER BY c.cliente_id OFFSET n - 1 LIMIT 1) cl ON true
     WHERE n <= o.stock_total - o.stock_restante
    RETURNING restaurante_id, canje_id, personal_id, monto_centavos, creado_en)
INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, canje_oferta_id,
                              cobrado_por_personal_id, fecha_local, clave_idempotencia, creado_en)
SELECT c.restaurante_id, (SELECT metodo_pago_id FROM metodo_pago WHERE codigo = 'EFECTIVO'), c.monto_centavos, 'USD', c.canje_id,
       c.personal_id, (c.creado_en AT TIME ZONE r.zona_horaria)::DATE, gen_random_uuid(), c.creado_en
  FROM canjes c JOIN restaurante r ON r.restaurante_id = c.restaurante_id;

-- Cierres de caja de cada día pasado con movimiento. Regla del prototipo: efectivo esperado =
-- lo cobrado HOY en efectivo (planes + POS). 1 de cada 9 días no cuadra por poco.
INSERT INTO cierre_caja_cabecera (restaurante_id, fecha_local, moneda_codigo, efectivo_esperado_centavos, efectivo_contado_centavos,
                                  almuerzos_servidos, almuerzos_para_llevar, nota, cerrado_por_personal_id, cerrado_en)
SELECT d.restaurante_id, d.fecha_local, 'USD', d.efectivo,
       d.efectivo + CASE WHEN d.n % 9 = 0 THEN -150 WHEN d.n % 14 = 0 THEN 50 ELSE 0 END,
       COALESCE(a.servidos, 0), COALESCE(a.llevar, 0),
       CASE WHEN d.n % 9 = 0 THEN 'Faltó un almuerzo suelto y medio; revisar vueltos.' END,
       (SELECT personal_id FROM personal_restaurante p WHERE p.restaurante_id = d.restaurante_id AND p.rol = 'DUENO'),
       ((d.fecha_local + TIME '15:45') AT TIME ZONE r.zona_horaria)
  FROM (SELECT p.restaurante_id, p.fecha_local,
               COALESCE(SUM(p.monto_centavos) FILTER (WHERE m.es_efectivo), 0) AS efectivo,
               row_number() OVER (ORDER BY p.fecha_local) AS n
          FROM transaccion_pago p JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
         GROUP BY p.restaurante_id, p.fecha_local) d
  JOIN restaurante r ON r.restaurante_id = d.restaurante_id
  LEFT JOIN (SELECT restaurante_id, fecha_local, COUNT(*) AS servidos, COUNT(*) FILTER (WHERE para_llevar) AS llevar
               FROM consumo_almuerzo GROUP BY 1, 2) a ON a.restaurante_id = d.restaurante_id AND a.fecha_local = d.fecha_local
 WHERE d.fecha_local < (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::DATE;

INSERT INTO cierre_caja_detalle (cierre_caja_id, restaurante_id, metodo_pago_id, planes_centavos, pos_centavos)
SELECT cc.cierre_caja_id, cc.restaurante_id, p.metodo_pago_id,
       COALESCE(SUM(p.monto_centavos) FILTER (WHERE p.suscripcion_id IS NOT NULL), 0),
       COALESCE(SUM(p.monto_centavos) FILTER (WHERE p.venta_pos_id IS NOT NULL), 0)
  FROM cierre_caja_cabecera cc
  JOIN transaccion_pago p ON p.restaurante_id = cc.restaurante_id AND p.fecha_local = cc.fecha_local
 GROUP BY cc.cierre_caja_id, cc.restaurante_id, p.metodo_pago_id;

-- Preorden "en camino" de Carlos Mejía (QR válido 30 min) y solicitud de plan pendiente de Paula.
WITH o AS (
    INSERT INTO orden_cabecera (restaurante_id, usuario_id, cliente_id, numero_dia, fecha_local, tipo, subtotal_centavos,
                                recargo_llevar_centavos, total_centavos, moneda_codigo, estado, creada_en, vence_en)
    SELECT c.restaurante_id, c.usuario_id, c.cliente_id, 1, (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::DATE, 'AQUI',
           0, 0, 0, 'USD', 'EN_CAMINO', CURRENT_TIMESTAMP - INTERVAL '4 minutes', CURRENT_TIMESTAMP + INTERVAL '26 minutes'
      FROM cliente_restaurante c
      JOIN restaurante r ON r.restaurante_id = c.restaurante_id AND r.slug = 'la-cuchara-de-san-blas'
      JOIN usuario u ON u.usuario_id = c.usuario_id AND u.nombre_usuario = 'carlos.mejia'
    RETURNING orden_id, restaurante_id)
INSERT INTO orden_detalle (orden_id, restaurante_id, plato_id, seccion, nombre_plato)
SELECT o.orden_id, o.restaurante_id, p.plato_id, p.seccion, p.nombre
  FROM o JOIN plato p ON p.restaurante_id = o.restaurante_id AND p.nombre IN ('Locro de papa', 'Seco de pollo');

INSERT INTO solicitud_plan (restaurante_id, cliente_id, plantilla_plan_id, creada_en)
SELECT c.restaurante_id, c.cliente_id, pl.plantilla_plan_id, CURRENT_TIMESTAMP - INTERVAL '40 minutes'
  FROM cliente_restaurante c
  JOIN usuario u ON u.usuario_id = c.usuario_id AND u.nombre_usuario = 'paula.montalvo'
  JOIN restaurante r ON r.restaurante_id = c.restaurante_id AND r.slug = 'la-cuchara-de-san-blas'
  JOIN plantilla_plan pl ON pl.restaurante_id = r.restaurante_id AND pl.tipo = 'MENSUAL';

-- El contador de escaneos del ciclo SaaS refleja lo validado este mes.
UPDATE suscripcion_saas_restaurante s
   SET escaneos_usados_ciclo_actual = (SELECT COUNT(*) FROM consumo_almuerzo c
                                        WHERE c.restaurante_id = s.restaurante_id AND c.fecha_local >= s.inicio_ciclo_actual)
 WHERE s.vigente;

-- -----------------------------------------------------------------------------
-- 10. Leads de la landing y eventos de producto
-- -----------------------------------------------------------------------------
INSERT INTO lead_landing (nombre, nombre_restaurante, whatsapp, utm, creado_en) VALUES
    ('Marco Quishpe',   'El Sabor de la Abuela', '+593990000041', '{"utm_source":"entrevista"}', CURRENT_TIMESTAMP - INTERVAL '6 days'),
    ('Elena Toapanta',  'Rincón Universitario',  '+593990000042', '{"utm_source":"instagram"}',  CURRENT_TIMESTAMP - INTERVAL '3 days'),
    ('Patricio Lema',   'La Olla de Barro',      '+593990000043', '{}',                          CURRENT_TIMESTAMP - INTERVAL '20 hours');

-- Navegación de los comensales en los últimos 14 días: vieron el menú, buscaron, vieron la oferta.
INSERT INTO evento_analitica (ocurrido_en, tipo, usuario_id, restaurante_id, sesion_id, plataforma, version_app, pais_codigo, ciudad_id, zona_id, propiedades)
SELECT CURRENT_TIMESTAMP - (random() * INTERVAL '14 days'),
       e.tipo, cl.usuario_id,
       CASE WHEN e.tipo = 'busqueda.realizada' THEN NULL ELSE r.restaurante_id END,
       gen_random_uuid(),
       (ARRAY['ANDROID','ANDROID','IOS','WEB'])[1 + floor(random() * 4)::INTEGER]::plataforma_enum,
       '1.0.0', 'EC', r.ciudad_id, r.zona_id,
       CASE e.tipo WHEN 'busqueda.realizada' THEN jsonb_build_object('texto', (ARRAY['seco de pollo','vegetariano','almuerzo barato','mariscos'])[1 + floor(random() * 4)::INTEGER])
                   WHEN 'oferta.impresion'   THEN jsonb_build_object('posicion', 1 + floor(random() * 3)::INTEGER)
                   ELSE '{}'::JSONB END
  FROM cliente_restaurante cl
  JOIN restaurante r ON r.restaurante_id = cl.restaurante_id AND r.slug = 'la-cuchara-de-san-blas'
  CROSS JOIN generate_series(1, 12) AS n
  CROSS JOIN LATERAL (SELECT (ARRAY['menu.visto','menu.visto','menu.visto','pase.abierto','pase.abierto',
                                    'restaurante.ficha_vista','busqueda.realizada','oferta.impresion'])
                             [1 + floor(random() * 8 + n * 0)::INTEGER] AS tipo) e
 WHERE cl.usuario_id IS NOT NULL;

COMMIT;

-- Resumen de lo cargado
SELECT 'restaurantes' AS dato, COUNT(*)::TEXT AS valor FROM restaurante
UNION ALL SELECT 'usuarios',            COUNT(*)::TEXT FROM usuario
UNION ALL SELECT 'clientes',            COUNT(*)::TEXT FROM cliente_restaurante
UNION ALL SELECT 'planes vendidos',     COUNT(*)::TEXT FROM suscripcion_plan
UNION ALL SELECT 'planes activos',      COUNT(*)::TEXT FROM suscripcion_plan WHERE estado = 'ACTIVA'
UNION ALL SELECT 'almuerzos validados', COUNT(*)::TEXT FROM consumo_almuerzo
UNION ALL SELECT 'ventas sueltas POS',  COUNT(*)::TEXT FROM venta_pos_cabecera
UNION ALL SELECT 'pagos',               COUNT(*)::TEXT FROM transaccion_pago
UNION ALL SELECT 'cierres de caja',     COUNT(*)::TEXT FROM cierre_caja_cabecera
UNION ALL SELECT 'opiniones',           COUNT(*)::TEXT FROM opinion
UNION ALL SELECT 'eventos analítica',   COUNT(*)::TEXT FROM evento_analitica;
