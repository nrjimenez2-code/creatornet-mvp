# Video tipping release review

## Candidate

- Branch: `codex/video-tipping-current`, rebased onto `main` commit `4447b63ec7bd389db1b70ec9addbdd3a8e66fff8` (video seek-bar spacing PR #226). Local safety refs `codex/video-tipping-pre-rebase`, `codex/video-tipping-pre-pr225`, and `codex/video-tipping-pre-pr226` retain preceding candidates.
- The transferred Mac work was verified against the handoff SHA-256 manifest before review. The original mentorship checkout and its unrelated files were not changed.
- Local implementation is committed on the isolated branch. No tipping commit has been pushed, no pull request or Preview has been created, and no provider payment has been made.
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

The Vercel project connector currently returns 403 from this Codex account. The signed-in Codex in-app browser can read the project settings: `CREATOR_TIPPING_ENABLED` is absent, and Preview and Production Stripe variables are present. Their values were not revealed. Preview configuration can use that browser or restored connector access. The known sandbox webhook still points to an older mentorship Preview and lacks the two async Checkout events. No webhook or Vercel setting has been changed by this candidate.

The Vercel settings page marks the existing Production `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` entries as Config variables needing attention. The owner should review converting these existing entries to Secret without exposing or copying their values into the review. This is separate from the tipping feature flag.

## Production gate

After sandbox acceptance, review the additive migrations against Production, apply them while the flag is off, deploy the matching app with the flag off, update only the live platform webhook's missing async events, verify the live domain and Connect account behavior, then conduct an internal rollout before broad enablement. Legal wording and operational Stripe configuration need owner review. Production has no tipping schema at this checkpoint.

The staging deployment, hosted migration, Stripe configuration writes, sandbox payment tests, and any production rollout are separate approval steps. This candidate is not yet a production-ready release.
