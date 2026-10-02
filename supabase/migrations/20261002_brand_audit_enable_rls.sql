-- brand_audit_state stores a live Mercado Libre access token, written by the
-- brand-audit-worker edge function (deployed with verify_jwt=false, so anyone
-- can trigger a token refresh). With RLS off, anyone holding the public anon
-- key (shipped in the web app) could then read that token: on-demand access
-- to the seller account. RLS on with no policies denies anon/authenticated
-- entirely; the worker uses the service role, which bypasses RLS, so it is
-- unaffected. Melidrop itself never reads these tables.
alter table public.brand_audit_state   enable row level security;
alter table public.brand_audit_results enable row level security;
