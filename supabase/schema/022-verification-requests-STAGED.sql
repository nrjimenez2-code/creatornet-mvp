-- 022 — blue "Authenticity" verification: request table + profile timestamp
--
-- ⚠️  STAGED — NOT APPLIED. Run in the Supabase SQL editor right after the
--     app half (PR feat/blue-authenticity-verification) is merged. Take a
--     backup first. Until this runs, /api/verification and
--     /api/admin/verification answer 500 because the table does not exist;
--     everything else on the site is unaffected.
--
-- What this adds:
--   * public.verification_requests — one row per "prove this is your account"
--     request. The creator gets a one-time code (CN-XXXX-XXXX), puts it in
--     their Instagram/TikTok bio, and an admin checks it and approves/rejects.
--     Approved requests can later be revoked.
--   * profiles.authenticity_verified_at — the ONE column the public badge
--     reads. Set on approve, cleared on revoke. Kept on profiles so the
--     creator page needs no extra query.
--
-- Access model matches the lockdown convention from 009/010/012: RLS on with
-- ZERO policies, all grants revoked from anon/authenticated. Every read and
-- write goes through service-role server routes that verify the caller
-- themselves. The new profiles column is NOT in the column grant list from
-- 009, so a browser client cannot set it (verified in CHECK below).
--
-- Everything is additive and idempotent (IF NOT EXISTS / duplicate_object
-- guards), so re-running this file is safe.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Request table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.verification_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('instagram', 'tiktok')),
  handle      text NOT NULL,
  code        text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'code_issued'
              CHECK (status IN ('code_issued', 'approved', 'rejected', 'revoked')),
  reason      text,
  decided_by  uuid REFERENCES public.profiles(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.verification_requests IS
  'Blue authenticity check requests. Server-only: RLS on, no policies, service role does every read/write.';

-- The admin queue reads "pending first, newest first"; the creator route
-- reads "my newest request". One index each.
CREATE INDEX IF NOT EXISTS verification_requests_status_created_idx
  ON public.verification_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS verification_requests_creator_created_idx
  ON public.verification_requests (creator_id, created_at DESC);

ALTER TABLE public.verification_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.verification_requests FROM PUBLIC;
REVOKE ALL ON public.verification_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verification_requests TO service_role;
-- No client policy on purpose: RLS-on with zero policies = deny-by-default.

-- ---------------------------------------------------------------------------
-- 2. The badge column
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS authenticity_verified_at timestamptz;

COMMENT ON COLUMN public.profiles.authenticity_verified_at IS
  'Set by /api/admin/verification on approve, cleared on revoke. Drives the blue AuthenticityBadge.';

COMMIT;

-- ---------------------------------------------------------------------------
-- CHECK IT WORKED (read-only)
-- ---------------------------------------------------------------------------
--   SELECT
--     (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.verification_requests'::regclass)
--       AS rls_on,                                                                     -- true
--     (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='verification_requests')
--       AS policy_count,                                                               -- 0
--     has_table_privilege('authenticated','public.verification_requests','SELECT')     -- false
--       AS client_reads_requests,
--     has_table_privilege('anon','public.verification_requests','SELECT')              -- false
--       AS anon_reads_requests,
--     has_table_privilege('service_role','public.verification_requests','INSERT')      -- true
--       AS server_writes_requests,
--     has_column_privilege('authenticated','public.profiles','authenticity_verified_at','UPDATE')
--       AS client_can_self_verify,                                                     -- false
--     (SELECT count(*) FROM public.verification_requests) AS request_count;            -- 0 on first run

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Safe at any time; pending/approved request history is lost and every blue
-- badge disappears (the app renders nothing when the column is missing only
-- if the creator-page select is also reverted — roll back the app PR too).
--   BEGIN;
--   DROP TABLE IF EXISTS public.verification_requests;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS authenticity_verified_at;
--   COMMIT;
