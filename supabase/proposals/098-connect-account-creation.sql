-- Prepared only: install before deploying the first-onboarding retry repair.
-- Existing linked accounts bypass this table. No existing profile/account is changed.
-- Keep unresolved attempts: deleting one can allow duplicate provider creation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.stripe_connect_account_creations (
  creator_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  stripe_account_id text UNIQUE CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$')
);
ALTER TABLE public.stripe_connect_account_creations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_connect_account_creations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.stripe_connect_account_creations TO service_role;
GRANT INSERT (creator_id, email) ON public.stripe_connect_account_creations TO service_role;
GRANT UPDATE (stripe_account_id) ON public.stripe_connect_account_creations TO service_role;
COMMIT;

-- Do not drop this table or reset attempts on application rollback. Retain it for
-- reconciliation of provider requests whose response/link write was interrupted.
