-- migrate:up
-- Entrega D, PR 5b: la referencia externa de un pago (id del depósito o de Deuna) es única POR RESTAURANTE.
-- El índice de la baseline (baseline:698) era global, (metodo_pago_id, referencia_externa): un local recibía 409
-- REFERENCIA_PAGO_REPETIDA por una referencia que había usado OTRO local, y eso le revelaba que existía.
--
-- Se reemplaza por (restaurante_id, metodo_pago_id, referencia_externa) con el MISMO predicado parcial y el MISMO
-- nombre (el código traduce el 23505 por el nombre: src/checkout/pos.ts, src/sales/sales.ts, src/cobro/aplicar.ts).
-- Se conserva metodo_pago_id: la unicidad dentro de un local no se endurece (una misma referencia en TRANSFERENCIA y en
-- DEUNA sigue permitida, como hoy), así ninguna fila existente puede chocar con el índice nuevo.
-- Un índice no tiene GRANT ni política propia: los permisos y el RLS de transaccion_pago no cambian.
DO $$
DECLARE
    v_def TEXT;
BEGIN
    SELECT regexp_replace(indexdef, '\s+', '', 'g') INTO v_def
      FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_pago_referencia_externa';
    IF v_def = 'CREATEUNIQUEINDEXuq_pago_referencia_externaONpublic.transaccion_pagoUSINGbtree(restaurante_id,metodo_pago_id,referencia_externa)WHERE((referencia_externaISNOTNULL)AND(revierte_a_pago_idISNULL))' THEN
        RETURN;   -- ya reemplazado
    END IF;
    IF v_def IS DISTINCT FROM 'CREATEUNIQUEINDEXuq_pago_referencia_externaONpublic.transaccion_pagoUSINGbtree(metodo_pago_id,referencia_externa)WHERE((referencia_externaISNOTNULL)AND(revierte_a_pago_idISNULL))' THEN
        RAISE EXCEPTION 'uq_pago_referencia_externa no tiene la definición esperada de la baseline: %', coalesce(v_def, 'no existe');
    END IF;
    DROP INDEX public.uq_pago_referencia_externa;
    CREATE UNIQUE INDEX uq_pago_referencia_externa ON public.transaccion_pago (restaurante_id, metodo_pago_id, referencia_externa)
        WHERE referencia_externa IS NOT NULL AND revierte_a_pago_id IS NULL;
END $$;

-- migrate:down
-- Vuelve el índice global de la baseline. Falla (23505) si para entonces dos locales usaron la misma referencia con el
-- mismo método: es lo que el índice por restaurante permite y el global no.
DROP INDEX IF EXISTS public.uq_pago_referencia_externa;
CREATE UNIQUE INDEX uq_pago_referencia_externa ON public.transaccion_pago (metodo_pago_id, referencia_externa)
    WHERE referencia_externa IS NOT NULL AND revierte_a_pago_id IS NULL;
