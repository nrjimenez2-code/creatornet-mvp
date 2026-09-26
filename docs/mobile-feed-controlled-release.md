# Mobile feed controlled release

The owner asked on September 26, 2026 to defer physical-phone testing and continue preparing a live release. The recommended initial release keeps the controller opt-in. This is a change to the release sequence; it does not establish the original phone-performance acceptance gates or complete the overall smoothness goal.

## Scope and visitor behavior

Ship the candidate from PR 232 using the existing `main` Production workflow. On a fresh mobile page, the controller defaults off. `?feedBridge=1` explicitly enables it for that page session, including in-app profile return. `?feedBridge=0` disables it; a fresh page without the parameter also defaults off. Desktop does not enable the controller. No provider setting or environment variable is needed for this rollout.

The opt-in URL is available to anyone who opens it; it is not an authenticated allowlist or a percentage rollout. Normal playback also includes the candidate's source/seek ownership guards and diagnostic hooks, so controller-off playback must not be described as an untouched baseline.

After an approved Production deployment, the experimental entry point is `https://www.creatornet.net/dashboard?feedBridge=1`. Add `&feedDebug=1` for local diagnostic capture. These URLs must not be described as containing this candidate before its deployed commit has been verified.

The capture panel now retains entered context when hidden. Export creates a downloadable JSON snapshot before attempting native sharing. Rejected or cancelled sharing leaves a visible **Download JSON** link and retains the trace. Unsupported sharing also offers that explicit link. The UI distinguishes a requested download from a confirmed saved file. Replacing an export, resetting a run, or unmounting releases its blob URL.

## Review and release sequence

1. Identify the final candidate commit, its exact diff, passing CI, and Ready Preview. Preserve the separate diagnostics-only baseline in PR 233; do not merge both branches.
2. Review known gaps and obtain scoped approval to merge PR 232 and allow its `main` Production deployment with the controller remaining opt-in. Deferring phone tests is not itself approval to deploy or enable the controller for everyone.
3. Immediately before merge, recheck the current `main` head, PR head/checks, and active Production commit. Reconcile any intervening work instead of overwriting it.
4. Merge through the existing repository workflow. Verify that the resulting Production deployment built from `main` with the Production environment. Do not promote a Preview artifact built against the staging catalog into Production.
5. Verify the actual deployed merge commit and canonical domain. Check ordinary mobile and desktop playback, then the explicit experimental link and diagnostic export. Review runtime errors from the new deployment. Authenticated Following and physical iPhone results remain separate evidence requirements.
6. Preserve rollout findings and failures. Keep the controller opt-in while completing `mobile-feed-phone-acceptance.md`. A later decision to enable it for all mobile visitors requires a new review of the device, sound, scrolling, quality, and resource results, plus scoped approval.

No ranking/schema rewrite, hosted migration, payment operation, media import/transcode, catalog edit, or provider configuration change is included in this release.

## Known gaps

- No physical iPhone Safari or Instagram traces/recordings, matched TikTok comparison, 100-transition cohorts, or 300-transition resource profile are available. Warmed p95, visible/audio continuity, settled quality, and device costs remain unverified.
- Current candidate Previews show synthetic staging clips. Representative motion clips and authenticated Following coverage are still needed.
- The verified rendition-timeline mapping list is empty. In the opt-in controller, an error at a nonzero position can hold at Error/Retry when equivalence is unverified. Source-to-Stream associations do not prove timeline equivalence. The controller-off recovery path does not use this restriction.
- Earlier automated desktop exports failed at sharing/download. The explicit fallback has local regression coverage; browser verification of the final Preview must confirm an actual downloaded JSON before claiming export works there. Safari and Instagram native sharing remain unverified.
- Earlier local full-suite attempts timed out and a local Turbopack build failed on the existing dependency junction. Retain those results separately from exact-commit hosted CI.

## Rollback

For one experimental session, open a fresh page with `feedBridge=0` and preserve captures before closing the prior page. This disables the controller, not every shared code change.

For a release regression, use the recorded last approved Production deployment and verify the restored canonical-domain commit. At release preparation, the active Production deployment was `dpl_HWu5vk64K8ynT6LUpYoevEoQfDQw`, host `creatornet-1x6kyl6oa-nrjimenez2-codes-projects.vercel.app`, commit `ae307e09e29919fbbf11fe2856ee60d98cdbfee5`. Recheck that target before an approved release; preserve unrelated newer work if it changes.
