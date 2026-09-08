-- 027-hide-purchase-helper-from-api.sql
-- ✅ APPLIED TO PRODUCTION 2026-09-08 (migration 027_hide_purchase_helper_from_api).
--    Found by the Supabase security linter after 026 shipped, and it was OUR OWN
--    regression from that same day.
--
-- THE LEAK. 026 created public.has_live_purchase_of_post so the reviews RLS policy
-- could check a purchase. Anything in `public` is exposed by PostgREST as
-- /rest/v1/rpc/<name>, the function is SECURITY DEFINER (so it reads
-- public.purchases regardless of the caller's RLS), and every argument is
-- caller-controlled. So any signed-in account could ask "did user X buy post Y
-- from creator Z?" about anybody. Buyer ids are discoverable — the followers API
-- returns them — and post ids are public, so it was reachable, not theoretical.
--
-- PROVEN BEFORE THE FIX: POST to that endpoint as anon returned
--   {"code":"42501","message":"permission denied for function ..."}  HTTP 401
-- while a genuinely nonexistent function returned HTTP 404. The endpoint existed
-- and only the EXECUTE grant stood in front of it — and `authenticated` had it.
--
-- PROVEN AFTER: the same POST returns
--   {"code":"PGRST202", "... no matches were found in the schema cache"}  HTTP 404
-- identical to the nonexistent-function control, while /rpc/get_feed_v3 still
-- returns 200 (so PostgREST itself is fine).
--
-- WHY THIS WORKS. PostgREST only introspects exposed schemas (public,
-- graphql_public). A schema it does not introspect has no RPC surface. RLS policies
-- are unaffected: a policy references the function by OID, and Postgres rewrote the
-- two policy expressions to `private.has_live_purchase_of_post` automatically. The
-- calling role needs EXECUTE on the function plus USAGE on the schema, both granted
-- below. The body already fully qualifies public.purchases / public.posts, so the
-- pinned search_path is not load-bearing after the move.
--
-- Post-apply checks, all asserted on values: helper is in `private` and nothing is
-- left in `public` · exactly one copy · both reviews policies still enforce a
-- purchase and now point at `private` · authenticated keeps EXECUTE + USAGE · anon
-- has neither · still SECURITY DEFINER with a pinned search_path · logic unchanged
-- (returns false with no purchases) · 3 review rows untouched.
--
-- ROLLBACK (puts the leak back — only if a policy genuinely breaks):
--   alter function private.has_live_purchase_of_post(uuid, uuid, uuid) set schema public;

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

alter function public.has_live_purchase_of_post(uuid, uuid, uuid) set schema private;

revoke all on function private.has_live_purchase_of_post(uuid, uuid, uuid) from public;
revoke all on function private.has_live_purchase_of_post(uuid, uuid, uuid) from anon;
grant execute on function private.has_live_purchase_of_post(uuid, uuid, uuid) to authenticated;
