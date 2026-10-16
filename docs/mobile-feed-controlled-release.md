# Complete mobile feed release - October 15, 2026

The owner authorized completing and taking LIVE the full original feed upgrade, including all prepared feed improvements, after focused code/release review and required automated gates pass with no unresolved code, security, data-integrity or deployment blocker. This supersedes the earlier opt-in-only release sequence below. Remaining manual iPhone Safari/Instagram acceptance, warmed-transition cohorts, physical performance measurements, resource profiling and TikTok comparisons are **owner-waived and unverified, not passed**. No new manual testing cycle is requested; historical failures and traces stay preserved.

The release integrates all of PR #248 with current main, preserving main's full-height Discover/Following layout, persistent navigation, profile behavior, exclusive Buy/Book/Tip actions, private delivery and composer loading safeguards. It includes prepared-source transfer, strict recent-return identity/deadlines, terminal Retry protection, preparation buffer/ownership checks, source-pinned recovery and instant saved/reranked profile-return positioning. PR #242's fixes are already included through ancestry and do not need a separate merge.

Supported mobile Discover and Following use `prepared-preload-audio` by default without query parameters, including Safari and Instagram's link browser. A paused neighbor prepares only after qualified main motion; adoption requires the same connected element/source/content/snapshot/target and actual frame/buffer readiness. The departing source retires before selected playback. There is one active source and at most one preparation source. Browsers without video-frame callbacks retain conventional playback rather than reaching the prepared startup watchdog. Desktop keeps its existing playback and ignores mobile selectors.

`feedTransfer=0` or `feedBridge=0` explicitly disables the controller for the page session. `feedBridge=1` selects the earlier bridge comparison; an explicit `feedTransfer` takes precedence. Selection persists through same-page navigation; a fresh supported mobile page uses the release default. Diagnostics remain opt-in with `feedDebug=1`; `feedReadout=0` keeps capture/export while disabling live polling. Preview labs, source/retirement/rate experiments and HLS trials are not normal-feed defaults and retain their existing gates.

No new Worker release, provider configuration, media operation, database migration, payment operation, credential change or ranking rewrite is included. Existing delivery resolution, source-version and verified-timeline fallback safeguards remain intact.

Required automated gates remain exact-revision CI, full-suite fallback, typecheck, selector/media safeguards and Production build. Reuse evidence only for unchanged source and scope; inherited lint findings must remain explicit. Recheck main, PR head and checks immediately before merge, then use the existing Git-connected main Production workflow once. Do not promote a staging Preview into Production or dispatch a duplicate deployment. Verify the canonical full release SHA, required routes, served feed bundles, default mobile selection, explicit opt-out and desktop isolation. Browser evidence does not establish waived physical-phone acceptance.

The pre-release main reference is `9bd6a26e20e95dd8a3a5fa0371b2a8d644c503a2`, with Ready Git-connected Production deployment `creatornet-ag9b0uzhh-nrjimenez2-codes-projects.vercel.app`. Confirm its canonical aliases and deployment ID before merge and preserve them in the release receipt. For session rollback use `feedTransfer=0`; a source revert or Production restoration must preserve unrelated newer work. Do not recreate consumed provider operations, follows, acquisitions or migrations.

## Historical September 26 checkpoint

The remainder records the prior checkpoint. Its opt-in defaults, held release authority and old rollback reference are superseded by the October 15 scope above.

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
