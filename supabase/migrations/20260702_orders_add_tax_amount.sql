-- Manual entry for ISR/IVA withholding ML deducts from each payout. The Orders
-- API never exposes this: payments[].taxes_amount is always 0, and the
-- billing/integration endpoint that has the real breakdown is blocked by
-- policy for this app's credentials. User enters it from ML's own app.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount numeric NOT NULL DEFAULT 0;
