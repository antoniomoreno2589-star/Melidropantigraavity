-- Track money ML gave back to the buyer (full/partial refund from a return,
-- mediation, or cancellation). Auto-detected during order sync from
-- payments[].transaction_amount_refunded on the order detail. Subtracted from
-- net_income so profit reflects that the seller never actually kept that money.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount numeric NOT NULL DEFAULT 0;
