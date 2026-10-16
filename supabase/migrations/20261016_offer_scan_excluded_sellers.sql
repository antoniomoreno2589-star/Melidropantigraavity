-- Sellers the owner has reviewed and doesn't want in the single-seller export
-- (e.g. big resellers that sit on thousands of listings, which aren't the
-- brand owners the export is meant to surface). The scan results themselves
-- stay factual; amazon-offer-scan's export just leaves these sellers out.
create table if not exists public.offer_scan_excluded_sellers (
  user_id    uuid not null,
  seller_id  text not null,
  note       text,
  created_at timestamptz not null default now(),
  primary key (user_id, seller_id)
);

alter table public.offer_scan_excluded_sellers enable row level security;
drop policy if exists "Users can view own excluded sellers" on public.offer_scan_excluded_sellers;
create policy "Users can view own excluded sellers" on public.offer_scan_excluded_sellers
  for select using (auth.uid() = user_id);
