-- Mercado Libre validations sent from the database with pg_net, and the
-- product each was for: net._http_response keeps only the answer, so this is
-- what matches it back (e.g. which long titles a domain won't accept).
create table if not exists public.ml_validation_requests (
  request_id bigint primary key,
  product_id uuid not null,
  purpose    text not null,
  created_at timestamptz not null default now()
);

alter table public.ml_validation_requests enable row level security;
