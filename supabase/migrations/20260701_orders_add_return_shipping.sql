-- Reflect returns (devoluciones) against profit: when ML charges the seller the
-- return shipping, store it here so it can be subtracted from the order's profit.
-- has_return is auto-detected from the ML claims API during order sync;
-- return_shipping_cost is entered by the user (visible in their ML billing).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_shipping_cost numeric NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS has_return boolean NOT NULL DEFAULT false;
