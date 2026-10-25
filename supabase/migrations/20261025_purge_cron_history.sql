-- pg_cron logs every run in cron.job_run_details and never prunes it.
-- Confirmed live: it had grown to 151 MB of 513 (amazon-ml-updater ran every
-- 2 minutes), past the free plan's 500 MB database limit. Keep three days.
-- 09:17 UTC is 03:17 in Mexico City. Scheduling under an existing name
-- replaces that job, so this can be re-run.
select cron.schedule(
  'purge-cron-history',
  '17 9 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '3 days'$$
);
