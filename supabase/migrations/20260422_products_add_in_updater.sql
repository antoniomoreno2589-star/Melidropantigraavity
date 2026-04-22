-- Add in_updater flag to products.
-- Existing products default to FALSE (opt-in model).
-- New products imported via the importer are set TRUE at creation time.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS in_updater BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS products_in_updater_idx
    ON products(user_id, in_updater);
