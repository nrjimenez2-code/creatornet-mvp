# Video tipping release review

## Candidate

- Branch: `codex/video-tipping-current`, rebased onto `main` commit `4447b63ec7bd389db1b70ec9addbdd3a8e66fff8` (video seek-bar spacing PR #226). Local safety refs `codex/video-tipping-pre-rebase`, `codex/video-tipping-pre-pr225`, and `codex/video-tipping-pre-pr226` retain preceding candidates.
- The transferred Mac work was verified against the handoff SHA-256 manifest before review. The original mentorship checkout and its unrelated files were not changed.
- Local implementation is committed and pushed on the isolated branch. Draft PR #227 is open at `https://github.com/nrjimenez2-code/creatornet-mvp/pull/227`. Vercel built a Ready Preview from commit `47958b5975fe95eb538d4753e46eec171ac65b1b`. No provider payment has been made.
- `CREATOR_TIPPING_ENABLED` must remain off in Production while the steps below are completed.

## Local verification

- The complete Jest suite passed on the candidate based on PR #225: 349 suites and 6,220 tests. The subsequent PR #226 change adjusts only CSS spacing in `VideoCard` and `VideoSeekBar`. After rebasing onto PR #226, the affected seek-bar, creator UI, tip modal, feed mapping, and admin reconciliation suites passed (5 suites, 38 tests). The complete suite has not been repeated after this CSS-only rebase.
- TypeScript `tsc --noEmit` and changed-file lint passed after PR #226. The admin reconciliation route returns an error if its dispute-recovery lookup fails, instead of reporting zero failures.
- The Next.js 16.3.5 webpack production build passed on the PR #226 candidate with placeholder configuration and `CREATOR_TIPPING_ENABLED=false`. This is a local build, not a hosted payment test.
- Repository-wide ESLint: 61 errors and 295 warnings. The errors found in
  changed files are existing dashboard/feed/video hook patterns outside this
  branch's modified lines; other errors are in existing tests and scripts.
  No new tipping module produced an ESLint error. The repository-wide lint
  command does not currently pass.
- Staging read-only check: zero tip-enabled posts and zero tip-enabled posts with a null booking flag.
- Dispute recovery now records event status and provider progress monotonically,
  rereads reversal/restoration objects before provider writes, and can repair a
  provider write whose database response was lost. The admin route includes
  pending recoveries as well as failed ones.
- A Staging profile maps to a sandbox Express account with charges and payouts
  enabled. Stripe reports `controller.losses.payments=application` for that
  account. Its two existing posts are not eligible free videos, so acceptance
  needs an eligible test video. A successful destination charge and transfer
  reversal have not yet been observed for this candidate.
- Staging has one eligible free video under another locally marked ready
  creator, but the intended CreatorNet sandbox cannot retrieve that creator's
  connected account. Do not use that video as a payment fixture until the
  Preview's Stripe account mapping is verified.

The local database tests cover the base tipping schema and the follow-up migration. They do not prove hosted transaction concurrency, Stripe settlement, or wallet availability.

## Staging Preview sequence

1. Confirm the current GitHub `main` and review this branch's exact diff. Push a review branch and create a draft pull request; Git integration may create a Preview deployment.
2. Reconcile Staging's four already-applied tipping migration versions with the source migration history. Apply only the new follow-up migration after reviewing it against current Staging. Do not replay the original local timestamp blindly.
3. Verify the new Preview uses Staging Supabase, the intended Stripe **test** account, matching test publishable/secret/webhook signing values, and an exact HTTPS return origin. Scope `CREATOR_TIPPING_ENABLED=true` to that Preview branch only.
4. Register that exact Preview host as a test payment-method domain. Match the test platform webhook endpoint to the Preview, retain existing subscriptions, and add both asynchronous Checkout events.
5. Complete sandbox acceptance for card, eligible wallets, async outcomes, duplicate/out-of-order webhooks, refunds, disputes, moderation races, Earnings, sent-tip history, notifications, and admin reconciliation. Record provider IDs and observed financial totals without copying secrets into the review.

Staging has the follow-up migration recorded as `20260925072036:video_tipping_checkout_idempotency`; the new `stripe_checkout_params` column, two constraints, and service-role-only function signatures are present. It still has zero tip rows. The Preview's public Supabase URL matches Staging. The stable branch URL loads for a signed-in Vercel member, but an external unauthenticated POST returns Vercel's `Protected deployment` response.

The Vercel project connector currently returns 403 from this Codex account. Through the signed-in in-app browser, `NEXT_PUBLIC_SITE_URL` was set to `https://creatornet-mvp-git-codex-video-0e051c-nrjimenez2-codes-projects.vercel.app` only for `codex/video-tipping-current`. Deployment `4iuqoNc79AKXKYLCHJjc4nYTVJEQ` is Ready from commit `c46f094`. The branch-only `CREATOR_TIPPING_ENABLED` was briefly true for signed-out UI verification, then set back to `false` while webhook setup is pending; a new deployment is required for that change to take effect. The existing generic Preview publishable key has a `pk_test_` prefix. Preview Stripe secret and webhook signing values were not revealed or matched to the intended sandbox account yet.

An inactive Staging fixture post `5842d226-e9c6-4399-8531-90e076a3be1c` uses an eligible free video under the sandbox-connected creator. During a brief activation, the Preview displayed `Tip Creator` and sent a signed-out viewer to sign-in with a return link. The post is inactive again; there are zero active tip-enabled posts. No Checkout session was started. The Supabase security advisor reported only the expected RLS-without-policy informational notices for the service-role-only tip tables.

Stripe test payment-method domain `pmd_1UJTX8ATzkMaGuMymo6cCI4h` is enabled for the stable branch host. A separate temporary Vercel automation bypass was created for hosted test delivery, then revoked unused when Stripe sign-in and webhook routing remained pending. The two pre-existing bypasses were untouched. The sandbox has only one enabled webhook endpoint, `we_1TLKzLATzkMaGuMyA8RIIYiT`, still pointed at the mentorship sandbox Preview and lacking both async Checkout events. Since overlapping destinations share an event claim, a second endpoint for the same events could let the older handler claim a tip event first. The webhook has not been changed. No sandbox tip, refund, or dispute has been run.

The Vercel settings page marks the existing Production `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` entries as Config variables needing attention. The owner should review converting these existing entries to Secret without exposing or copying their values into the review. This is separate from the tipping feature flag.

## Production gate

Read-only preflight on 2026-09-25: GitHub `main` remains
`4447b63ec7bd389db1b70ec9addbdd3a8e66fff8`; this review branch is at
`43521d2d4f046d64583ea3a2c0cdc93825876263`. Production Supabase
`rvkqxgghqitkwzdsuclz` has no tipping tables, `posts.tips_enabled` column,
tipping functions, or tipping migration versions. The post and fee-ledger
columns required by the base migration exist. Its current
`discover_inventory_batch_v1(uuid[])` function differs from Staging only by
the tip-flag field that the base migration adds. This is a compatibility
inventory, not authorization to run Production DDL.

The live Stripe platform webhook `we_1U7MxjAPff7wDYc9b3W6fcw8` remains enabled
at `https://www.creatornet.net/api/stripe/webhook` with 11 existing events; it
lacks both asynchronous Checkout events. The separate live connected-account
endpoint `we_1UEasbAPff7wDYc9aICVRDaV` subscribes to `account.updated` and
must remain distinct. Live payment-method domain `www.creatornet.net` is
registered and enabled as `pmd_1UJP1yAPff7wDYc9OAbfpfSA`. No live webhook,
domain, charge, deployment, flag, or database setting was changed.

After sandbox acceptance, review the additive migrations against Production, apply them while the flag is off, deploy the matching app with the flag off, update only the live platform webhook's missing async events, verify the live domain and Connect account behavior, then conduct an internal rollout before broad enablement. Legal wording and operational Stripe configuration need owner review. Production has no tipping schema at this checkpoint.

The staging-only deployment, follow-up migration, test payment domain, webhook configuration, and sandbox acceptance were authorized. Production rollout requires a separate reviewed package and approval. This candidate is not yet a production-ready release.
