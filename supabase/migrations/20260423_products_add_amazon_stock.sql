-- Add amazon_stock column to track available inventory on Amazon
ALTER TABLE products ADD COLUMN amazon_stock INTEGER DEFAULT NULL;

-- Create index for filtering by stock availability
CREATE INDEX IF NOT EXISTS idx_products_amazon_stock ON products(amazon_stock);
