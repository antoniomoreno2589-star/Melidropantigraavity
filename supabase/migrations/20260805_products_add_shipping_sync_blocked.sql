ALTER TABLE products
    ADD COLUMN IF NOT EXISTS shipping_sync_blocked BOOLEAN NOT NULL DEFAULT false;
