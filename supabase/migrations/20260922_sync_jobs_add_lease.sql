-- amazon-ml-updater is invoked by a cron every 2 minutes (to continue large
-- catalogs batch by batch) as well as manually. Nothing stopped a second
-- invocation from picking up a 'running' job another invocation was still
-- processing — confirmed live: both wrote to the same listings milliseconds
-- apart and Mercado Libre rejected the collisions with 409 Conflict.
-- locked_until is a short lease: an invocation only processes a job it
-- claimed, and releases the lease when its batch ends. 'epoch' means free —
-- kept NOT NULL so claiming is a plain `locked_until < now` comparison.
alter table public.sync_jobs
  add column if not exists locked_until timestamptz;
update public.sync_jobs set locked_until = 'epoch' where locked_until is null;
alter table public.sync_jobs alter column locked_until set default 'epoch';
alter table public.sync_jobs alter column locked_until set not null;

-- At most one running job per user, so two invocations can't each start
-- their own job for the same account at the same moment either.
create unique index if not exists sync_jobs_one_running_per_user
  on public.sync_jobs (user_id)
  where status = 'running';
