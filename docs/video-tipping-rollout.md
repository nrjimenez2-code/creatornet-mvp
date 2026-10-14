# Video tipping rollout

Video tipping is guarded by `CREATOR_TIPPING_ENABLED=true`. Keep it false in
Production until the database migration, webhook configuration, and payment-method
domains are live in the same Stripe mode as the deployment. The Staging review
branch briefly had the flag enabled to verify rendering, then it was set back
to false while webhook coverage is pending. Its only tip fixture is inactive,
and Staging has zero active tip-enabled posts.

Staging schema status (2026-09-24): installed on **CreatorNet Staging**
`nwqfofezfzljhxolkycz` as remote migrations `20260924234559_video_tipping_v1`,
`20260925000108_video_tipping_video_url_eligibility`, and
`20260925000335_video_tipping_notification_fk_indexes`, followed by
`20260925025425_video_tipping_post_flag_server_guard`. The second remote migration corrected
the video test after inspection showed that legacy videos often have
`posts.type='text'`; the final repository migration and schema mirror already
contain the corrected `video_url` rule, notification foreign-key indexes, and
server-only flag guard. The guard is needed because authenticated users already
have UPDATE privilege on `posts`; without it, they could bypass the current
Connect check by directly toggling `tips_enabled`.
Three private tables and six write RPCs
are service-role-only; the staging tables currently have no tip rows. Production
`rvkqxgghqitkwzdsuclz` has **not** received the migration.

The current-main candidate adds `20260925040000_video_tipping_checkout_idempotency.sql`
(mirrored in `schema/061-video-tipping-checkout-idempotency.sql`). It freezes the
complete Checkout create request on the tip row before contacting Stripe, so an
interrupted create is retried with the original parameters and idempotency key.
It also requires `allow_booking` to be explicitly false on tip-only posts;
Staging currently has zero tip-enabled posts, including zero with a null booking
flag (read-only check on 2026-09-24). The same local-only follow-up makes
dispute-status writes atomic with event ordering and allows a reversal or
restoration provider ID to be saved after a newer dispute event arrives.
Provider reconciliation checks for an existing reversal or restoration before
retrying a write.
The follow-up migration was applied to Staging as remote version
`20260925072036_video_tipping_checkout_idempotency`. Staging's four earlier remote migration versions already installed
the final base schema in stages; reconcile that migration history before using a
CLI migration push so the older local base file is not blindly replayed. For
Production, review the current schema and apply the base and follow-up changes
in order while the feature flag remains off.

Stripe Dashboard status (2026-09-24): `www.creatornet.net` is an enabled payment-
method domain in both the live CreatorNet account (`acct_1SGnG1APff7wDYc9`) and
the main CreatorNet test sandbox (`acct_1SGnGAATzkMaGuMy`). The live platform
webhook is active at `https://www.creatornet.net/api/stripe/webhook`; its current
11-event subscription lacks both `checkout.session.async_payment_succeeded` and
`checkout.session.async_payment_failed`. The main sandbox webhook points to an
older mentorship preview deployment and likewise lacks these two events. Do not
change either destination to a new preview URL or enable the feature until the
deployed code, Stripe mode, signing secret, and database project are matched.

Required application configuration:

- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` for the custom Checkout payment element.
- The custom Checkout modal also mounts Express Checkout for eligible Apple Pay,
  Google Pay, and Link options; domain registration is still required.
- Existing platform `STRIPE_SECRET_KEY`, Connect webhook secret, platform webhook
  secret, Supabase service-role credentials, and canonical `NEXT_PUBLIC_SITE_URL`.
- The existing creator-processing schedule variables remain authoritative; tips do
  not define a separate fee schedule.

Subscribe both test and production webhook endpoints to the existing payment/refund/
dispute events plus `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, and `checkout.session.expired`. Register the
test and production CreatorNet HTTPS origins as Stripe payment-method domains. Wallet
availability still depends on Stripe Dashboard settings, browser, and device.

Before enabling broadly:

1. Confirm legacy Express connected accounts support destination-charge liability and
   transfer reversal in the actual platform account.
2. Exercise card, Link, Apple Pay, and Google Pay in supported test environments.
3. Deliver success, failure, expiration, refund, and dispute events through Stripe CLI
   and confirm one tip, ledger row, creator credit, and notification.
4. Run `POST /api/admin/tips/reconcile` as an administrator and resolve every returned
   failure or pending/failed dispute recovery.
5. Start with internal creators, monitoring stuck attempts, paid tips missing credit or
   ledger timestamps, frozen-term mismatches, and failed reversal/restoration rows.

The Stripe connector works for the intended test sandbox on 2026-09-25. Its stable
video-tipping Preview host is registered as test payment-method domain
`pmd_1UJTX8ATzkMaGuMymo6cCI4h`. The single sandbox webhook endpoint remains
on the older mentorship Preview while the test-routing decision is pending.
Sandbox charges,
wallet-device behavior, and legacy Express transfer-reversal compatibility remain
unverified. Do not claim the rollout complete or enable the flag until those
checks and the production schema migration are done.

Local verification passed the complete Jest suite and a production Next.js
webpack build. The default Turbopack build could not start its CSS worker in
this restricted workspace (`Operation not permitted` while binding a port), so
the webpack build is the usable local build result. The connected Vercel app
returned 403 for the existing `nrjimenez2-codes-projects` scope, but the owner
opened the signed-in Vercel Dashboard in the Codex browser. The tipping branch
Preview is Ready at deployment `4iuqoNc79AKXKYLCHJjc4nYTVJEQ`; its Supabase
URL points to Staging, and the exact return origin is scoped only to
`codex/video-tipping-current`. Its feature flag was set back to false after
the signed-out UI check; a new deployment must pick up that setting. The generic Preview
publishable key has a test-mode prefix. The Preview secret and webhook signing
values have not yet been matched to the intended Stripe sandbox account.

The branch-specific `NEXT_PUBLIC_SITE_URL` now names the stable Preview host.
Vercel Authentication protects that host from external requests, even though a
signed-in Vercel member can browse it. A separate temporary automation bypass
was created for Stripe test webhook delivery, then revoked unused while sign-in
and routing decisions remained pending. The sandbox webhook still needs an agreed routing change, matching
branch signing secret, and both async Checkout events before test payments.

Do not change the isolated membership Stripe API version as part of this rollout. The
general server SDK and current typed Stripe.js custom Checkout API are used as-is.
