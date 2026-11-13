-- migrate:up
-- Fase 9: ofertas flash. Cada canje sale con public_id (nunca el id interno), la publicación admite Idempotency-Key
-- y la API solo puede cambiar el estado y el stock de una oferta ya publicada (no su precio ni su vigencia).
ALTER TABLE canje_oferta_flash ADD COLUMN public_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE canje_oferta_flash ADD CONSTRAINT canje_oferta_flash_public_id_key UNIQUE (public_id);

ALTER TABLE oferta_flash ADD COLUMN clave_idempotencia UUID;
ALTER TABLE oferta_flash ADD CONSTRAINT oferta_flash_clave_idempotencia_key UNIQUE (restaurante_id, clave_idempotencia);

REVOKE UPDATE ON oferta_flash FROM bocadoo_app;
GRANT UPDATE (activa, stock_restante) ON oferta_flash TO bocadoo_app;

-- migrate:down
GRANT UPDATE ON oferta_flash TO bocadoo_app;
ALTER TABLE oferta_flash DROP CONSTRAINT oferta_flash_clave_idempotencia_key;
ALTER TABLE oferta_flash DROP COLUMN clave_idempotencia;
ALTER TABLE canje_oferta_flash DROP CONSTRAINT canje_oferta_flash_public_id_key;
ALTER TABLE canje_oferta_flash DROP COLUMN public_id;
