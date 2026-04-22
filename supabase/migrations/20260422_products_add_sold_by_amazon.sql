ALTER TABLE products
    ADD COLUMN IF NOT EXISTS sold_by_amazon BOOLEAN;

CREATE INDEX IF NOT EXISTS products_sold_by_amazon_idx
    ON products(user_id, sold_by_amazon);
