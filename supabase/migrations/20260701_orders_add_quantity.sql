-- Track how many units each order contains so the real Amazon cost can be
-- multiplied by the number of pieces to buy. Defaults to 1 for existing rows;
-- the next ML order sync backfills the true quantity.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
