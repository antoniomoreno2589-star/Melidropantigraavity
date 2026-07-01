-- Reflect returns (devoluciones) against profit: when ML charges the seller the
-- return shipping, store it here so it can be subtracted from the order's profit.
-- Both are auto-detected during order sync from the ML post-purchase claims API
-- (return shipment receiver.cost where the seller is the receiver). The user can
-- still override return_shipping_cost manually for cases ML hasn't finalized.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_shipping_cost numeric NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS has_return boolean NOT NULL DEFAULT false;
