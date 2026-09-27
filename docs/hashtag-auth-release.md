# Hashtag search and auth coordination release candidate

## Source and boundaries

Started from canonical main `4d5eb09e8fc242daa549e3b084b4f48f64433ba3`, which the authenticated Vercel Dashboard displayed as the current Ready Production source on 2026-09-27 UTC. Public login assets resolve to Supabase `rvkqxgghqitkwzdsuclz`. The existing Preview environment resolves to Staging `nwqfofezfzljhxolkycz`. Publication of this feature branch creates a separate Preview; Production release requires scoped approval after hosted acceptance.

Before final verification, Production advanced to `607a49237aea0ec8060ff8bcfcb459a1429f5843` (the separate mobile bridge fix, PR 237), Ready deployment `9UwKW7on8Xd6adV23YvjvYSFNVAz`. That main source is incorporated into the final candidate and is the refreshed rollback target. The latest read-only audit still found zero noncanonical or duplicate tag arrays: Staging 1,231 posts and Production 50. No backfill or schema migration is planned.

Locked versions are `@supabase/supabase-js` and `@supabase/auth-js` 2.112.3, `@supabase/ssr` 0.7.0, and Next.js 16.3.5. Dependencies and the SDK refresh guard are unchanged.

## Stored tags and query

Read-only audits found `text[]` hashtags in both databases. Staging had 1,222 posts, 1,220 empty arrays, and zero noncanonical or duplicate arrays. Production had 50 posts, 39 empty arrays, and zero noncanonical or duplicate arrays. No backfill is needed for this snapshot. Repeat the aggregate audit before release; if drift introduces noncanonical rows, prepare a reviewed, bounded data backfill before approving release.

`PostComposer` extracts canonical caption tags. The only application path inserting hashtag arrays is `POST /api/posts`, including its free-post product-FK fallback; both now use the same normalization as tag searches: trim, remove one leading `#`, trim, lowercase, drop empty/non-string entries, deduplicate. Existing null/missing-array behavior is preserved.

The hashtag source now uses array `contains`. Caption discovery uses a literal, case-insensitive regex with the parser's tag-end boundary, so `#tradingtips` does not match `trading`. Interest discovery, moderation filters, creator/product enrichment and view counts remain. Each source orders `created_at DESC, id DESC` and fetches `offset + limit + 1` candidates; the deduplicated merge uses that same order. A hashtag query error returns the existing API error response.

Real Staging PostgREST reproduced the old text-array operator failure (`42883`) and accepted array containment (200), returning two existing exact `entrepreneurship` matches and zero `entrepreneur` substring matches. The caption regex also returned 200. These read-only queries are query proof, not complete Preview acceptance.

## Auth reproduction and correction

Controlled local tests used the actual locked SDK with synthetic Auth responses and shared storage. Two refreshing clients returned `AuthRefreshDiscardedError` (409) to the loser while preserving the winning session. Sign-out during a pending refresh left storage empty. Application navigation previously reported `Could not verify your sign-in. Please try again.` after another login replaced its pending refresh, despite the replacement remaining in storage.

React provider tests also demonstrated a delayed seed overwriting a newer sign-out/login event. An independent delayed callback handler response demonstrated cookie restoration after a newer sign-out response.

The actual locked SSR/Auth SDK also reproduced an expired feed request refreshing while sign-out completed. Applying the delayed feed response restored the auth cookie in both the legacy and Discover paths. Token-free baseline timelines are `auth-baseline-feed-refresh.json` and `auth-baseline-discover-refresh.json` in the review outputs. This proves cookie restoration, not acceptance of that session by the hosted Auth provider.

Corrections:

- Ignore late provider seeds and `INITIAL_SESSION` events after newer auth events.
- After a discarded refresh, read current storage; verify the current access token before navigation. Recheck after verification and cookie work. A sign-out cancels navigation, and an old invalid-user response cannot clear a newer login.
- Serialize application cookie synchronization with a shared Web Lock when available. Recheck live auth after entering the queue, omit superseded writes, and repair an already-pending response using current state. The per-tab queue and response repair also run without Web Locks.
- Make auth cookies read-only for feed requests in both paths. SDK identity verification/refresh remains enabled, but the feed response cannot overwrite a newer sign-out or login. Other server-client callers retain cookie synchronization by default. Actual SSR regressions verify both feed outcomes and the unchanged default behavior.
- Device sign-out remains `scope: local`. Transient verification failures do not sign out users. No old refresh credential is retried by application code.

The legacy `/api/auth/callback` route has no current application caller. No behavioral change to it was selected without a reproduced caller.

## Hosted Staging evidence

On 2026-09-27 UTC, exact source `778831214d2799a5212135b8086c747bfc2d21b1` was Ready as deployment `89MCUCnDmL9XS4VCNV4VhVxDkKRV`. Both real Edge tabs used its immutable origin and displayed the compiled Staging browser project. Normal email-code sign-in reached the dashboard, and device-local sign-out cleared both owned tabs. No unrelated session was changed.

Controlled hosted races used normal application APIs and actual Supabase Auth responses:

1. Injected browser expiry metadata caused one real refresh held five seconds. Provider initialization waited, then the feed returned 200 and rendered; browser/server identities matched. The JWT itself was not expired. This is hosted client-expiry evidence; actual expired-JWT SSR races remain controlled local evidence for both feed paths.
2. Two refresh requests started 107ms apart, with responses held five and 2.5 seconds. Both transports returned 200; the SDK discarded the slower result with `AuthRefreshDiscardedError` / 409. Both tabs preserved the winning session and verified navigation. No old refresh credentials were replayed.
3. A fresh normal email-code login replaced the session while the other tab's user verification was pending. That tab detected the change, verified the replacement, synchronized cookies and completed verified navigation. The normal dashboard loaded afterward.
4. One combined exercise overlapped a five-second refresh and a five-second callback response with device-local sign-out. Both tabs received SIGNED_OUT before either delayed response settled. The SDK discarded the late refresh; cookie synchronization repaired the late signed-in response with a signed-out write. Both tabs then had no browser session/server user and refused authenticated navigation. Normal Auth remained at sign-in. This combined run covers the pending-refresh and late-callback conditions, rather than claiming separate isolated runs.

Token-free browser timelines, projected server events, result JSON and screenshots are saved in the continuation chat's outputs under `race-two-tabs-*`, `race-expiry-feed-*`, `race-replacement-*` and `race-signout-*`. The prior outputs retain eight passing hosted hashtag checks using nine dedicated Staging fixtures; do not reinsert them.

All temporary diagnostics, trace headers, delay/expiry controls, reauthentication override and QA page/helper/component were removed after capturing this evidence. The functional corrections and deterministic regressions remain. The final source requires its own TypeScript, relevant Jest, changed-file lint, CI production build and normal Staging smoke checks; passing diagnostic-source CI does not substitute for those gates.

## Production approval and rollback

The release package must pin the final commit, hosted evidence and current Production rollback deployment. No schema migration is planned. Review the final diff, rerun relevant Jest suites, TypeScript, changed-file lint and the production build, then obtain scoped Production deployment approval.

Rollback by restoring the previously recorded Production deployment through Vercel Instant Rollback, or revert only these feature commits on canonical main and deploy the reviewed rollback source. There is no data backfill to reverse in the current package. A rollback returns the old hashtag failure, so document that tradeoff. Do not reset any database or delete existing sessions.

After an approved deployment, verify deployed-source identity, an array-only hashtag match, pagination and the reproduced auth scenarios. Record search 500s and auth coordination/error observations; notify only on meaningful failures or required action.
