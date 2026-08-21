-- Stores Mercado Libre's own verbatim reason (e.g. "shipping.handling_time is
-- not modifiable.") for the last time shipping_sync_blocked was set, so the
-- app can show the real cause instead of a generic "ML rejected it" message.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS shipping_block_reason TEXT;
