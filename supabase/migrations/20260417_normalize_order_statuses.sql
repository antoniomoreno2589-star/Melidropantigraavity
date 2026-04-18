-- Normalize ALL existing order rows to the 5-value canonical set before
-- (re-)applying the check constraint. The previous migration may have failed
-- to ADD CONSTRAINT if rows contained values like 'ready_to_ship' that were
-- not in its list. This migration cleans data first, then locks the constraint.

UPDATE orders SET status = 'shipped'
    WHERE status IN ('ready_to_ship', 'me2', 'in_transit', 'almost_there', 'shipped');

UPDATE orders SET status = 'paid'
    WHERE status IN ('confirmed', 'payment_in_process', 'payment_required',
                     'partially_paid', 'processing', 'payment_pending');

UPDATE orders SET status = 'cancelled'
    WHERE status IN ('pending_cancel', 'partially_refunded', 'invalid', 'cancelled');

UPDATE orders SET status = 'pending'
    WHERE status NOT IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled');

-- Drop any existing constraint (extended or original) then add the clean one.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_status_check
    CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled'));
