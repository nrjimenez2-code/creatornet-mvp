# CreatorNet video tipping — handoff (2026-09-24 Arizona / 2026-09-25 UTC)

## What the next Codex account should do first

Continue the **video tipping implementation**, not a new design exercise. Read the
user's original 13-section implementation plan and this report, then inspect the
dirty working tree before editing. The local implementation is substantial but
**not deployed or production-ready**. Keep `CREATOR_TIPPING_ENABLED` off in
Production. First isolate and review this work on a new branch based on current
`origin/main` without discarding any local or user changes; then obtain a
matching Preview deployment and run real Stripe sandbox acceptance.

Repository: `/Users/piperpoole/Documents/Codex/creatornet-mvp`.
Current branch: `codex/video-reporting`, HEAD `8f05140` ("Mount video option
dialogs after hydration"). Vercel Production displayed `main` commit `666c519`
("Add video reporting and admin moderation queue (#223)") on 2026-09-24.
**Do not push the tipping work to `codex/video-reporting` or assume the local
branch is current with Production.** The working tree has many uncommitted
tipping edits and new files. Untracked `docs/marketing/`, `output/`,
`scripts/marketing/`, and `tmp/` are unrelated user material; preserve them.
No commit, PR, push, or application deployment was created for tipping.

## Product decisions and architecture

Signed-in non-owners may send repeat $5–$500 USD tips (presets $5/$10/$20) on
free, tip-only videos. A tip never unlocks access, carries no public amount or
count and no free-text message, and cannot be combined with any paid CTA.
Creators can enable/disable tips when posting and later. CreatorNet keeps a
12% platform fee; optional creator-funded processing deduction remains
separate in accounting. Reuse existing Stripe Express Connect destination
charges, Checkout, fee ledger, refund machinery, payout schedule, webhook
leases, and earnings. Tips never use `purchases` or `orders`. Paid tips appear
in private Earnings, sender history, a deduplicated creator bell inbox, and
admin commerce. Tip disputes reverse the destination transfer, with one
compensating transfer if won; existing commerce dispute behavior is unchanged.

## Implemented locally

- Schema: `supabase/migrations/20260924120000_video_tipping.sql`, exact mirror
  `supabase/schema/060-video-tipping.sql`. Adds `posts.tips_enabled` with a
  tip-only constraint and a **server-role-only flag-change trigger**, private
  `tips`, `notifications`, `tip_dispute_recoveries`, `payment_fee_ledger.tip_id`,
  indexes, RLS/grants, and atomic attempt/bind/finalize/refund/dispute RPCs.
  Existing videos often have `posts.type='text'` despite a real `video_url`,
  so eligibility intentionally checks nonempty `video_url`, not `type='video'`.
  The trigger is essential: staging grants authenticated users UPDATE on
  `posts`, so the constraint alone would allow bypassing the Connect check.
- Server: `lib/tips.ts`, `lib/tipCheckout.ts`, `lib/tipEvents.ts`,
  `lib/tipDisputes.ts`, `lib/tipCursor.ts`; checkout/status/history, creator
  toggle, notifications/read, and bounded admin reconcile routes under
  `app/api/`. Checkout freezes fees/terms, verifies eligibility and current
  Connect readiness, uses a persisted request key plus Stripe idempotency,
  custom-mode Checkout with destination/application fee/metadata, dynamic
  payment methods, a 31-minute expiration (margin over Stripe's 30-minute
  minimum), and a return URL to the same post. New Preview branches without
  `NEXT_PUBLIC_SITE_URL` use the trusted Vercel `VERCEL_URL` fallback.
- Webhook/accounting: early tip classifier in
  `app/api/stripe/webhook/route.ts`, success/async/failure/expiration/PI paths,
  strict reread of Stripe payment identities and amounts before atomic credit,
  refund and dispute reconciliation, actual Stripe fee variance, moderation
  expiry of open Sessions, and tip classification for generic admin refunds.
- UI: composer and existing-video toggles; feed/profile propagation and private
  Tip action; lazy `components/TipModal.tsx` with Payment and Express Checkout
  Elements for card/eligible wallets; login and redirect return; Earnings,
  `/payments` sent-tip history, admin commerce, and notification bell/inbox.
  A late fix in `FeedList.tsx` hydrates a linked video outside the first feed
  page through the existing public video endpoint. `VideoCard.tsx` can reopen
  an existing tip status even if tips were disabled during redirect.
- Legal/disclosures were updated in `app/legal/*`. Operational checklist is
  `docs/video-tipping-rollout.md`.
- Tests: `__tests__/tips-{database,checkout,events,reconcile,disputes}.test.ts`.
  `@stripe/stripe-js` is currently `9.15.0`; the server SDK and isolated
  membership API version were not changed.

## Verified results and limits

- Full Jest run completed **347 suites / 6,207 tests passing** before the very
  latest redirect/UI and Checkout-origin changes. After those changes, a
  targeted run of seven tipping/feed/search suites completed **56 tests
  passing**. TypeScript `tsc --noEmit` and focused new-code lint have passed;
  rerun type-check/build for the final candidate.
- A Next.js 16.3.5 **webpack production build passed** (with existing Sentry
  instrumentation and dynamic-route warnings) before the latest redirect/UI
  edits. Default Turbopack build failed only because this restricted workspace
  could not bind a worker port (`Operation not permitted`), not on a source
  compile error. Use `next build --webpack` here if needed.
- Direct ESLint on entire `components/FeedList.tsx` and `VideoCard.tsx` reports
  **13 existing React-hooks errors** outside the newly changed blocks (for
  example refs written during render at FeedList lines 57/114); these are
  baseline component issues, not yet cleaned up. Do not claim the complete
  lint suite passes. `git diff --check` passes, and the migration/schema mirror
  compares byte-for-byte.
- The bundled Node executable used here is
  `/Users/piperpoole/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.
  Dependencies are already in `node_modules`. Jest ran as
  `NODE_PATH=node_modules/.pnpm/node_modules <node> node_modules/jest/bin/jest.js --runInBand --no-coverage`;
  TypeScript as `<node> node_modules/typescript/bin/tsc --noEmit`.
  The successful build used `<node> node_modules/next/dist/bin/next build --webpack`
  with placeholder public Supabase/Stripe environment values; no real credentials
  were read into the workspace.
- Staging Supabase migration installed and verified on project **CreatorNet
  Staging `nwqfofezfzljhxolkycz`**. Connector-generated migration versions:
  `20260924234559_video_tipping_v1`,
  `20260925000108_video_tipping_video_url_eligibility`,
  `20260925000335_video_tipping_notification_fk_indexes`,
  `20260925025425_video_tipping_post_flag_server_guard`. New financial tables
  are RLS-protected/service-role-only; zero tip rows existed at verification.
  The final source migration already includes all corrective changes. Do not
  blindly replay its local timestamp on staging. **Production Supabase
  `rvkqxgghqitkwzdsuclz` has NOT received tipping schema.** Existing columns
  and Discover function compatibility were inspected read-only earlier.
- Stripe Dashboard in the Codex in-app browser is signed into live CreatorNet
  account `acct_1SGnG1APff7wDYc9` and test account "CreatorNet sandbox"
  `acct_1SGnGAATzkMaGuMy`. `www.creatornet.net` was registered and verified
  **enabled as a payment-method domain in both modes**. Live platform webhook
  `we_1U7MxjAPff7wDYc9b3W6fcw8` is active at
  `https://www.creatornet.net/api/stripe/webhook`, with 11 existing events.
  It lacks `checkout.session.async_payment_succeeded` and
  `checkout.session.async_payment_failed`. Live Connect destination
  `we_1UEasbAPff7wDYc9aICVRDaV` listens to `account.updated` only (expected).
  Main sandbox webhook `we_1TLKzLATzkMaGuMyA8RIIYiT` points to an **older
  mentorship Preview deployment**, has 26 events but lacks the two async
  Checkout events, and had 4 failed of 12 recent deliveries when inspected.
  These subscriptions were deliberately **not edited** while tipping code is
  undeployed. No charge, refund, reversal, wallet, or webhook acceptance test
  was run against Stripe. The Stripe connector returned `UNAUTHORIZED`; the
  signed-in browser worked.
- Vercel signed-in browser tab opened at
  `https://vercel.com/nrjimenez2-codes-projects/creatornet-mvp`, project ID
  `prj_lfRTdoQU0BrsSnJajvLTcSCvjrAA`, team ID
  `team_XnmQuYar6rBtKo5e1apgauky`. Production is ready at
  `www.creatornet.net`, but it is the old build. Environment-variable **names
  and scopes only** were inspected (no secret values revealed): separate
  Preview/Production Stripe keys and webhook secrets exist; Preview Supabase
  credentials exist; `NEXT_PUBLIC_SITE_URL`/`NEXT_PUBLIC_BASE_URL` Preview
  values are scoped to older branch `admin-refund-allocation`, not a new
  tipping branch; `CREATOR_TIPPING_ENABLED` is absent (therefore off).
  Vercel connector still returned 403 for the team even after the user said
  it was reconnected, but the browser session provided read access. No new
  Preview host is known or registered as a Stripe payment-method domain.

## Remaining work, in order

1. **Safely isolate the candidate.** Inspect `git diff`, untracked files, and
   current `origin/main`; put only tipping edits on a new `codex/` branch or
   worktree based on fresh main. Preserve unrelated user files. Do not update
   the existing `codex/video-reporting` PR/branch with this feature.
2. **Final local review.** Rerun `tsc`, targeted tests, full Jest, `next build
   --webpack`, and migration test. Review the last changes to feed deep-link
   hydration, status reopen, `VERCEL_URL` origin, post flag guard, expiration,
   and session pagination. Complete remaining UI/accessibility and financial
   concurrency tests; distinguish pre-existing lint debt from new errors.
3. **Deploy only to a matched staging Preview** with staging Supabase and the
   intended Stripe test account, a test-mode publishable/secret/webhook-secret
   set, an exact HTTPS Preview return origin, and a branch-scoped
   `CREATOR_TIPPING_ENABLED=true`. Register that exact Preview hostname as a
   Stripe test payment-method domain. Verify which Stripe account's webhook
   secret Preview actually uses; do not assume the mentorship sandbox endpoint
   is the right one. Add the two async Checkout events to the matching test
   platform endpoint and retain all existing subscriptions.
4. **Real sandbox acceptance:** create eligible creator/viewer fixtures, verify
   Express Connect readiness/destination-charge liability, complete card,
   Link/Apple Pay/Google Pay on supported domains/devices, async success and
   failure, duplicate/out-of-order events, refund partial/full, dispute
   reversal/lost/won restoration, disable/moderation races, history/Earnings/
   bell/admin reconciliation. No real money should be moved for a rehearsal.
5. After staging acceptance, review migration against current Production,
   apply the additive schema there, deploy/promote the matching app with flag
   still off, add the two missing async events to the live **platform** webhook,
   recheck domain/secret/mode, perform internal rollout, monitor failures, and
   only then enable broadly. Legal and production Stripe configuration still
   need operational sign-off.

Critical guardrails: financial data must stay private, no browser writes to
tip/ledger tables, no self-tips or mixed paid posts, never mark paid from client
evidence, do not reuse `purchases`/`orders`, and do not change commerce dispute
policy or membership Stripe API version. Do not reveal Stripe/Vercel secrets or
assume that the other Codex account inherits this task's connector tokens;
verify its own project/mode/scope before any remote write.
