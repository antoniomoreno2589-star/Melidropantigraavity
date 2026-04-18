-- Add financial columns to orders needed for profit tracking.
-- net_income: amount seller actually receives (after ML commission + shipping).
-- ml_commission: marketplace fee charged by ML on this order.
-- meli_item_id: ML item ID (to cross-reference the products table for Amazon link routing).

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS net_income    NUMERIC,
    ADD COLUMN IF NOT EXISTS ml_commission NUMERIC,
    ADD COLUMN IF NOT EXISTS meli_item_id  TEXT;
