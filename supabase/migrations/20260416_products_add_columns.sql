-- Add currency and description_text to products.
--   currency        — 'USD' for Amazon USA source, 'MXN' for Amazon Mexico source.
--                     Determines whether the updater applies exchange rate.
--   description_text — Full description stored at publish time so the updater
--                      can keep ML descriptions in sync without re-fetching Amazon.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS currency         TEXT NOT NULL DEFAULT 'USD',
    ADD COLUMN IF NOT EXISTS description_text TEXT;
