# Video insights: review and rollout

**DB MIGRATION REQUIRED.** Apply `supabase/migrations/20260927054350_video_insights.sql` only to the explicitly approved environment. No application deployment applies this migration automatically.

Creators open their existing video options menu and choose **View insights**. Playback sessions are eligible playback starts, including immediate exits; existing dashboard views and ranking weights stay unchanged. The panel/chart are imported only when opened. Preview videos inside the panel never bind collection and remain paused.

## Gates and environment variables

All four variables default off (unset or any value other than literal `true`). Use server and client pairs together. `NEXT_PUBLIC_` values require a rebuilt application.

| Pair | Variable | Purpose |
| --- | --- | --- |
| Collection | `VIDEO_INSIGHTS_COLLECTION_ENABLED` | Enable session/event endpoints |
| Collection | `NEXT_PUBLIC_VIDEO_INSIGHTS_COLLECTION_ENABLED` | Attach player collection |
| UI | `VIDEO_INSIGHTS_UI_ENABLED` | Enable owner-read endpoint |
| UI | `NEXT_PUBLIC_VIDEO_INSIGHTS_UI_ENABLED` | Show owner menu action |

Start with collection enabled and UI disabled in an approved Staging Preview. Confirm exact totals, actor fencing, media replacement, cleanup, and request/database load before enabling UI. Collection can remain off while UI reads collected history. Production migration, enabling flags, merge/deployment and media-worker changes require separate scoped release approval. This package does not change or deploy the media worker.

`vercel.json` disables Git-triggered deployment for `feat/video-insights` while this package is reviewed and CI runs. After scoped Staging approval and verification of the Preview database binding, remove only that branch entry in a reviewed follow-up commit or use the approved explicit Preview deployment path. Other branches retain their existing default deployment behavior. See [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration).

## Storage and access

The two `public.video_insight_*_v1` tables have RLS enabled and grants revoked from `PUBLIC`, `anon` and `authenticated`. Only backend `service_role` can access them or execute ingestion/read/cleanup RPCs. Public RPCs use `SECURITY INVOKER`; a private trigger removes aggregates when a post is soft-deleted. Foreign keys cascade on hard deletion. Owner reads check ownership in both the route and the database RPC and return only aggregates.

Anonymous playback establishes a random HttpOnly SameSite cookie before counting the first session. Tokens are random 256-bit secrets stored as hashes, scoped to the verified signed-in user or anonymous cookie actor and session ID. Sessions accept events for at most 12 hours. Session-start timestamps are constrained to a 30-second window to allow bounded telemetry dispatch delays. Input is capped at 32 KiB and 512 interval pairs; intervals, sequence, lifetime, video bounds, and cumulative wall time are validated. Client data remains client-reported; these checks constrain telemetry and do not make it fraud-proof. The existing per-instance rate limiter is a speed bump; the database additionally caps new sessions at 600 per actor per hour.

Feed `posts.video_url` is CreatorNet's public sales preview, including posts that sell an attached paid product. It can be measured without buying that product. The watch surface, hidden posts, and removed posts additionally reuse server library purchase eligibility. Creator self-watches are excluded. Insights do not collect the downloadable premium-file link or sign an additional premium URL.

The processor's current public playback descriptor supplies source ETag identity and trusted duration. Unknown duration retains elapsed watch time/session/source metrics without duration metrics. A duration proof appearing later starts a new aggregate geometry rather than changing old buckets. Missing/unsupported processor identity defers session creation and shows unavailable metadata; no browser duration or guessed media identity is trusted. Original URLs, optimized MP4 and shared-player handoffs remain one analytics session during a visit. Each departure ends the session; a 250 ms detach grace preserves synchronous effect/remount handoffs. A different active post ends the prior visit immediately. New visits create new identities. Pauses, seeking, looping, backgrounding and playback-speed changes reset the sample baseline without changing the visit. Navigation/pagehide flush; bfcache return starts a new visit.

## Metrics

Watch seconds include repeat playback at the actual rate. Unique coverage is an interval union, so seeks earn no skipped coverage and rewatches cannot add duplicate timeline coverage. Per-session unique seconds and per-bucket fractions contribute deltas to locked aggregates. Newer sequence numbers merge cumulative coverage; retries and older updates contribute nothing twice. One-second buckets are used up to 300 seconds, with the final partial bucket divided by its own width. Longer videos have 300 equal-width buckets. The graph plots measured linear segments and permits rises. Completion is at least 90% unique coverage. Opening retention requires the full first three seconds or the complete shorter duration.

Detailed sessions expire after 30 days. The migration registers a daily 03:17 UTC cleanup if `pg_cron` is already installed. It does not install an extension. If absent, collection rollout is blocked until an existing approved daily scheduler calls `public.cleanup_video_insight_sessions_v1()`. Cleanup only deletes session rows; aggregates persist. Reported history covers collected sessions for the current verified media/duration version; historical retention cannot be reconstructed.

## Staging validation package

1. Review the exact commit, migration and environment target. Record the actual database project's reference before any SQL write. Keep collection/UI off during installation. Run the migration in one transaction; inspect RLS, grants, function permissions and the post-removal trigger; run Supabase database advisors against the approved target.
2. Check that session-detail tables and all insight RPCs reject `anon`/`authenticated`; owner-read rejects a different creator; invalid tokens and cross-actor attempts fail. Verify public previews and paid/watch eligibility, including an expired/refunded/disputed purchase using existing fixtures. Do not create a charge.
3. Enable collection on a Staging-only application build. Use known media fixtures and non-owner viewers: immediate exit, full opening, seeks, loops, speeds, pause/stall, hidden tab, swipes, shared-player changes and remounts. Compare exact SQL aggregate values with expected elapsed seconds, unique intervals and source counts. Repeat a cumulative payload and deliver old sequences after new ones. Replace a fixture source and verify the histories separate.
4. Confirm a cleanup schedule exists and run cleanup against a disposable Staging session older than 30 days; verify its aggregate persists. Soft-delete only a disposable post owned by the fixture account; verify history is removed and existing purchase/media behavior stays intact.
5. Measure collection request frequency, p95 route latency, processor metadata latency, database lock waits and RPC cost at the approved load. No new paid infrastructure is required by this implementation. Metadata is checked per event so same-URL replacement cannot silently mix current histories.
6. Enable UI only after the accuracy/load gate. On desktop, physical iPhone Safari and the Instagram in-app browser, verify the owner menu, full-height sheet/desktop dialog, loading/retry/empty/duration states, touch and keyboard timeline, paused preview, focus trap and trigger restoration. The underlying player must remain paused even if autoplay retries fire, and resume only if it was playing and the same video remains active. Verify delete/report/not-interested actions and paid watch playback. Device emulation does not satisfy physical acceptance.

## Rollback

Disable both collection variables and both UI variables, rebuild any application that had enabled public flags, and deploy only under the relevant environment approval. This disables routes/collection and removes the owner menu. Preserve analytics tables and aggregates for recovery; disabling flags is the preferred rollback.

For an explicitly approved destructive schema rollback, first export needed analytics, then unschedule only `video-insight-session-cleanup-v1` (if installed), drop the `purge_deleted_video_insights_v1` trigger on `public.posts`, drop the four public insight RPCs and private insight union/purge functions, then drop the sessions table followed by the aggregates table. Do not drop the `private` schema or modify any existing feed/payment tables. This permanently removes insights history and requires a separate approval.

## Evidence limitations

Local unit/DOM tests and isolated PGlite SQL fixtures verify the contracts; they do not prove hosted schema compatibility, Production accuracy, physical-device playback or capacity. Browser QA fixtures, if used, are labeled synthetic. Hosted/device/load gates must be recorded before release acceptance.
