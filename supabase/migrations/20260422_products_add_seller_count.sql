ALTER TABLE products
    ADD COLUMN IF NOT EXISTS amazon_seller_count INT;

CREATE INDEX IF NOT EXISTS products_seller_count_idx
    ON products(user_id, amazon_seller_count);
