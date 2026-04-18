-- Fix 1: Ensure user_connections has a unique constraint on user_id.
-- If duplicate rows exist (from missing onConflict in previous upserts),
-- this keeps the latest row per user and deduplicates the rest.
ALTER TABLE user_connections DROP CONSTRAINT IF EXISTS user_connections_user_id_key;

DO $$
BEGIN
    -- Delete duplicates keeping the row with the highest id
    DELETE FROM user_connections a
    USING user_connections b
    WHERE a.id < b.id AND a.user_id = b.user_id;
EXCEPTION WHEN OTHERS THEN
    NULL; -- table may not have an id column; skip cleanup
END $$;

ALTER TABLE user_connections ADD CONSTRAINT user_connections_user_id_key UNIQUE (user_id);

-- Fix 2: Relax the orders status check constraint to include all values
-- the ML API may return before our mapping layer is applied. The mapping
-- layer already normalises status on the way in, so this is a safety net.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_status_check
    CHECK (status IN (
        'pending', 'paid', 'shipped', 'delivered', 'cancelled',
        'confirmed', 'payment_required', 'payment_in_process',
        'partially_paid', 'partially_refunded', 'pending_cancel', 'invalid'
    ));
