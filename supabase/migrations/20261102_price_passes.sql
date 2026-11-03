-- Progress of a one-time "apply my margin rules" pass over a user's listings
-- (amazon-ml-updater with { pricePass: true, userId }): it only ever raises a
-- price to what the rules give for today's Amazon cost. Inserting a row starts
-- a pass; each invocation takes the next batch after last_id under the lease.
create table if not exists public.price_passes (
  user_id uuid primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_id uuid,
  processed int not null default 0,
  raised int not null default 0,
  kept int not null default 0,
  no_amazon int not null default 0,
  -- Amazon didn't answer for it this time (throttled): left as it was.
  unanswered int not null default 0,
  origin_fixed int not null default 0,
  errors int not null default 0,
  locked_until timestamptz not null default 'epoch'
);
alter table public.price_passes add column if not exists unanswered int not null default 0;
alter table public.price_passes enable row level security;
