-- Add published_by_app column to track which products were published via Melidrop app
-- Products published with the app automatically appear in the Updater
-- Synced products from ML don't appear unless manually added by user

ALTER TABLE products
ADD COLUMN published_by_app BOOLEAN DEFAULT FALSE;

-- Create index for filtering products published by app
CREATE INDEX IF NOT EXISTS idx_products_published_by_app
ON products(user_id, published_by_app)
WHERE published_by_app = TRUE;
