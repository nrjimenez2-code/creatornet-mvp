-- 007 — make the two "Stripe onboarding complete" columns agree
--
-- profiles carries both stripe_onboarding_complete (what the app reads to
-- decide if a creator can sell) and onboarding_complete (added later by the
-- Task 8 schema work, meant to be kept in sync). They have drifted: rows exist
-- with onboarding_complete = true while stripe_onboarding_complete = false
-- and charges_enabled = false. The Stripe accounts behind those rows really
-- are unfinished, so stripe_onboarding_complete is the truthful one.
--
-- The code now writes both columns together everywhere. This is the one-time
-- correction of existing rows. Data only; no structure change.
--
-- Inspect first (read-only):
--   SELECT id, username, stripe_account_id, stripe_onboarding_complete,
--          onboarding_complete, charges_enabled, payouts_enabled
--   FROM public.profiles
--   WHERE coalesce(onboarding_complete,false) <> coalesce(stripe_onboarding_complete,false);

BEGIN;

UPDATE public.profiles
SET onboarding_complete = coalesce(stripe_onboarding_complete, false)
WHERE coalesce(onboarding_complete, false) <> coalesce(stripe_onboarding_complete, false);

COMMIT;
