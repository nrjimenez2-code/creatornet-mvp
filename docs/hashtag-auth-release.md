# Hashtag search and auth coordination candidate

## Source and boundaries

Started from canonical main `4d5eb09e8fc242daa549e3b084b4f48f64433ba3`, which the authenticated Vercel Dashboard displayed as the current Ready Production source on 2026-09-27 UTC. Public login assets resolve to Supabase `rvkqxgghqitkwzdsuclz`. The existing Preview environment resolves to Staging `nwqfofezfzljhxolkycz`. Publication of this feature branch creates a separate Preview; Production release requires scoped approval after hosted acceptance.

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

The legacy `/api/auth/callback` route has no current application caller. It is instrumented for staging observation; no behavioral change to it was selected without a reproduced caller.

## Temporary diagnostics

Open a staging page with `?authTrace=1` to enable this tab's token-free console traces. Records include operation IDs, random tab IDs, timestamps, events, session presence and statuses. Callback/feed requests carry only trace IDs. Preview requests with these IDs enable matching server traces; Production server tracing stays off unless `AUTH_DIAGNOSTICS=1` is explicitly configured. Never configure that flag for Production during this work.

Tracing covers singleton auth, refresh/user fetches, provider initialization/events, feed loads, navigation, cookie writes, and both callback routes. No sessions, tokens, provider messages, emails or user IDs are logged. Remove the temporary tracing after hosted diagnosis and rerun affected gates on the final release commit.

Controlled-delay parameters are available only when the public Supabase URL is the exact Staging project: `authRefreshDelayMs`, `authVerifyDelayMs`, and `authCallbackDelayMs`, capped at five seconds. Callback delay applies only to Preview requests with trace IDs. `authExpireOnce=<unique-case-marker>` alters only the current QA session's client expiry metadata once per tab/marker; it leaves credentials unchanged and lets the actual SDK/provider perform the refresh. Label this as injected client expiry evidence, rather than actual JWT expiry evidence. These temporary controls must be removed with the diagnostics before Production approval.

## Candidate local checks

On 2026-09-27 UTC, 19 selected Jest suites passed (128 tests), `tsc --noEmit` passed, changed-file lint passed with zero errors and 30 warnings, and the production build exited zero using fake CI credentials. The build printed expected dynamic-render notices and an `example.invalid` sitemap-fetch warning. These are local gates; hosted acceptance is still pending. Timestamp merge regression includes microseconds, and temporary staging controls have Production pass-through coverage.

## Hosted acceptance required

Record the exact feature commit and Ready Preview deployment. Confirm its public bundle resolves to Staging before signing in or inserting fixtures. Use dedicated, free fixtures with a unique tag, equal timestamps, array-only matches, caption/interest overlaps, empty arrays, and hidden/removed rows. Save fixture IDs and exact cleanup instructions; do not modify existing posts or reuse other workstreams' sessions.

Use two real browser tabs and controlled response delays to record:

1. An expiring session while feed loading is pending.
2. Both tabs refreshing the same session; the discarded result preserves the winner.
3. Sign-out during refresh; browser storage, server cookies and navigation remain signed out after all responses settle.
4. Login replacing a pending session; navigation verifies the replacement.
5. A callback response arriving late; sign-out still wins.

Also check the email-code flow and device-local sign-out. Local/synthetic tests and a Ready Preview do not satisfy this list.

## Production approval and rollback

The release package must pin the final commit, hosted evidence and current Production rollback deployment. No schema migration is planned. Review the final diff, rerun relevant Jest suites, TypeScript, changed-file lint and the production build, then obtain scoped Production deployment approval.

Rollback by restoring the previously recorded Production deployment through Vercel Instant Rollback, or revert only these feature commits on canonical main and deploy the reviewed rollback source. There is no data backfill to reverse in the current package. A rollback returns the old hashtag failure, so document that tradeoff. Do not reset any database or delete existing sessions.

After an approved deployment, verify deployed-source identity, an array-only hashtag match, pagination and the reproduced auth scenarios. Record search 500s and auth coordination/error observations; notify only on meaningful failures or required action.
