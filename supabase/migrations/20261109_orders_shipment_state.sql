-- What Mercado Libre says about each order's shipment, refreshed on every
-- Ventas sync: its status/substatus (manufacturing = still in the listing's
-- stock-availability time; ready_to_print/printed = label available), the
-- latest time to dispatch it (/shipments/{id}/sla) — shipping_deadline used
-- to be a guess of order date + 3 days, days early for listings with
-- preparation time — and, when ML holds the label back (buffered), when it
-- releases it.
alter table public.orders
  add column if not exists shipment_id text,
  add column if not exists shipment_status text,
  add column if not exists shipment_substatus text,
  add column if not exists shipping_deadline_at timestamptz,
  add column if not exists label_available_at timestamptz,
  add column if not exists manufacturing_ends_at timestamptz;
