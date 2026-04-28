-- Optimization: Create index for products list queries
-- This improves performance of api.products.list() which orders by last_updated

CREATE INDEX IF NOT EXISTS idx_products_last_updated
ON products(last_updated DESC);

-- Cache strategy: Add comment for developers
COMMENT ON TABLE products IS 'Products table. List queries should use pagination (limit 100) with idx_products_last_updated index. Cache results client-side with 5min TTL.';
