-- Result of scanning each ASIN's offers on one Amazon marketplace: how many
-- sellers it has, and whether its only seller is someone other than Amazon.
-- Also the work queue for the amazon-offer-scan edge function: a row with
-- scanned_at IS NULL is still pending.
create table if not exists public.asin_offer_scan (
  user_id                  uuid not null,
  asin                     text not null,
  marketplace_id           text not null,
  scanned_at               timestamptz,
  item_status              int,      -- Amazon's per-ASIN status code (200, 404, ...)
  offer_count              int,      -- Summary.TotalOfferCount (condition New)
  seller_ids               text[] not null default '{}',
  buybox_seller_id         text,
  sold_by_amazon           boolean,
  single_non_amazon_seller boolean,
  primary key (user_id, asin, marketplace_id)
);

create index if not exists asin_offer_scan_pending
  on public.asin_offer_scan (user_id, marketplace_id, asin)
  where scanned_at is null;

-- Written only by the edge function (service role); owners can read theirs.
alter table public.asin_offer_scan enable row level security;
drop policy if exists "Users can view own ASIN offer scans" on public.asin_offer_scan;
create policy "Users can view own ASIN offer scans" on public.asin_offer_scan
  for select using (auth.uid() = user_id);

-- Private values edge functions need but that must never reach the browser
-- (e.g. the shared secret amazon-offer-scan checks on every call). RLS on with
-- no policies: only the service role can read it. Values are set directly in
-- the database, never committed.
create table if not exists public.edge_function_config (
  name  text primary key,
  value text not null
);
alter table public.edge_function_config enable row level security;
