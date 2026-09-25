# Video tipping release review

## Candidate

- Branch: `codex/video-tipping-current`, rebased onto `main` commit `83ab7df6125752a3a92b10c5cbe8e55b9b78374e` (video timeline PR #224). A local safety ref `codex/video-tipping-pre-rebase` retains the preceding candidate.
- The transferred Mac work was verified against the handoff SHA-256 manifest before review. The original mentorship checkout and its unrelated files were not changed.
- Local implementation is committed on the isolated branch. No tipping commit has been pushed, no pull request or Preview has been created, and no provider payment has been made.
- `CREATOR_TIPPING_ENABLED` must remain off in Production while the steps below are completed.

## Local verification

- TypeScript `tsc --noEmit`: passed.
- Full Jest suite after the dispute-race repair, before the rebase onto video timeline PR #224: 348 suites, 6,215 tests passed.
- After that rebase, video timeline, creator UI, tip modal, and feed mapping suites passed: 4 suites, 34 tests. TypeScript `tsc --noEmit` and the Next.js webpack production build passed on the rebased candidate. The full suite has not been rerun after the rebase.
- Focused database, dispute, and admin reconciliation suites: 3 suites,
  15 tests passed. TypeScript and focused lint passed on the changed modules.
- Focused tipping and API-error suites: 7 suites, 52 tests passed after the error-sanitization fix. The last checkout retry change then passed all 22 checkout tests on its own.
- Focused lint of the changed Checkout and modal modules: passed.
- Repository-wide ESLint: 61 errors and 295 warnings. The errors found in
  changed files are existing dashboard/feed/video hook patterns outside this
  branch's modified lines; other errors are in existing tests and scripts.
  No new tipping module produced an ESLint error. The repository-wide lint
  command does not currently pass.
- Next.js 16.3.5 production build with webpack: passed after the rebase
  using placeholder configuration and `CREATOR_TIPPING_ENABLED=false`.
  Existing dynamic-route warnings and the placeholder sitemap lookup did not
  fail the build.
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

The Vercel project connector currently returns 403 from this Codex account; a signed-in Edge tab also timed out during a read-only inspection. Preview configuration needs restored project access or an owner-assisted handoff. The known sandbox webhook still points to an older mentorship Preview and lacks the two async Checkout events. No webhook or Vercel setting has been changed by this candidate.

## Production gate

After sandbox acceptance, review the additive migrations against Production, apply them while the flag is off, deploy the matching app with the flag off, update only the live platform webhook's missing async events, verify the live domain and Connect account behavior, then conduct an internal rollout before broad enablement. Legal wording and operational Stripe configuration need owner review. Production has no tipping schema at this checkpoint.

The staging deployment, hosted migration, Stripe configuration writes, sandbox payment tests, and any production rollout are separate approval steps. This candidate is not yet a production-ready release.
