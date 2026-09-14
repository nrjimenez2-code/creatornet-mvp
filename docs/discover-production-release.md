# Discover and scheduling production release

As of September 14, 2026, feature PR [#169](https://github.com/nrjimenez2-code/creatornet-mvp/pull/169) is a draft. Application candidate `27fae591cebe77edd466d7d6cfcca35c28f5195e` passed [full CI](https://github.com/nrjimenez2-code/creatornet-mvp/actions/runs/34897484734) and Preview deployment `4VDDXvyCXFGzLpoNg4a5qSmewWXM`. Later documentation commits do not imply a new application acceptance run. Check the final merged candidate before release.

Production is `57720a9cfcdbbdd8881f73983dd18822fc19a75f`, deployment `dpl_7znyyWxchMTXo9AjdrzNYnUZdQQ5`. This published only the [calendar privacy disclosure and supplied operator details](https://www.creatornet.net/legal/privacy) through PR #170. Discover and scheduling flags remain false. No release migration has been applied to production.

## Gates still open

- Cal.com production OAuth app approval: last verified Pending; staging app Approved.
- Google production app remains Testing. Five implementation scopes, branding links, callback and Calendar API are configured. Domain ownership verification, a real production consent/features demo and public verification remain outstanding. The prepared Search Console ownership step awaits the owner's confirmation; do not infer approval from continuation requests.
- Remaining live recovery cases include provider-side revocation and Google/Calendly natural token expiry. Normal Cal.com/Google disconnect and reconnect passed; automated recovery tests are additional evidence, not replacements for these live cases.
- Complete final code review and check the exact release head. Existing green CI does not prove public provider approval, production configuration or real-user behavior.
- The owner has not yet chosen between launching with provisional commercial weights and waiting for real-user validation. No real participant population is available. The controlled pilot remains disabled.
- Representative multi-user capacity and real ranking calibration are unproven. The bounded workloads below must not be reported as those outcomes.

## Verified acceptance

| Area | Evidence and limit |
| --- | --- |
| Automated checks | Baseline `64ca1e0`: 305 suites / 5,835 tests. Candidate `27fae59`: full CI, typecheck, safeguards and production build passed; do not reuse the baseline test count as its exact count. |
| Provider lifecycle | Genuine create/reschedule/cancel flows for Cal.com, Calendly and Google on staging. |
| Commercial attribution | Later mentorship purchase and refunds credited the original video. A confirmed Calendly call followed by a $40 sandbox installment also credited that video; payment refunded, subscription stopped, appointment canceled. No attendance claim. |
| Recovery | Cal.com UUID webhook handling fixed after a live failure. Normal Cal.com/Google disconnect cleared credentials and disabled hooks/settings; reconnect restored the same account. Cal.com natural expiry at 21:28 UTC renewed its token without reauthorization; the first status check failed generically and a manual retry succeeded. |
| Feed load | 180 anonymous requests without errors/duplicates. Twenty signed-in dashboard loads (one account, up to three concurrent tabs) created 20 actor-owned snapshots with 18 unique posts each. Seventeen timed samples: median 2.58s, maximum 3.42s; three observation-timeout samples verified afterward and excluded from timing. |
| Tracking writes | Actual playback saved one exposure and qualified-view milestone with the correct actor/topic; accepted watch time stayed fixed during a 27-second pause. This is not high-volume telemetry capacity. |
| Database load | Rollback-only staging fixture: 1,000 posts and 165,000 events; three evidence passes took 0.55–0.77s with expected counts and zero residual fixture rows. This is not end-to-end request latency. |
| Migration rehearsal | All 21 migrations passed on isolated production-backup restore `clnnsoovkukgqnqxnpdp`; taxonomy/archive totals, private permissions and existing feed reads checked. Does not prove live application/Auth/Storage rollout. |
| Existing worker | Twelve scheduled search-worker responses returned 200 and an unauthenticated request returned 401 on baseline production `cdf79f2`. This establishes that deployment's cron authentication, not the three new scheduling routes. |

## Ordered migration manifest

The exact ordered filenames and SHA-256 hashes are in [discover-release-migrations.json](discover-release-migrations.json). They are the 21 added SQL files between production `57720a9` and application candidate `27fae59`. Hashes cover committed Git blob bytes (LF), so Windows checkout line endings must not be included when comparing them. Verify hashes against the final candidate before applying any file. Stop on a mismatch or unexpected installed version; do not replay migrations to repair a history mismatch.

Production project is `rvkqxgghqitkwzdsuclz`; staging is `nwqfofezfzljhxolkycz`. A read-only production history check on September 14 at approximately 21:39 UTC found latest version `20260912214520` (`creatornet_search_video_processing_v1`), before this manifest. Recheck immediately before deployment.

Staging's original four migrations use connector versions `20260913022831`, `20260913022840`, `20260913022852`, `20260913022903` instead of local timestamps. Watch-renewal fairness maps local `20260914012650` to staging `20260914014216`. Compare SQL/history when reconciling; do not blindly run a directory-wide migration push against an existing project.

## Release sequence

1. Resolve the open launch/provider gates. Confirm the final PR diff and CI; account for already published privacy changes without reverting them. Record the release commit and the currently serving production deployment.
2. Verify the production project identity, backup/restore point, migration history, manifest hashes and pre-migration taxonomy/archive/learned-score counts. Keep all three flags false. Apply only the manifest files, in listed order, using the supported remote migration mechanism. Each successful migration needs its recorded version; stop at the first error.
3. Compare post-migration row counts, canonical categories, archive preservation and learned-score totals. Verify browser roles cannot read or mutate private ranking/OAuth/booking tables or execute privileged RPCs. Exercise existing feed reads. A successful SQL application alone is insufficient.
4. Deploy the reviewed application while `DISCOVER_V4_ENABLED`, `SCHEDULING_OAUTH_ENABLED` and `GOOGLE_CALENDAR_ENABLED` remain false. Confirm the deployment uses the production Supabase project and `SCHEDULING_OAUTH_ORIGIN=https://www.creatornet.net`. Verify the existing user flows and the published privacy page.
5. Verify each new cron route below rejects requests without the secret and returns its disabled response to authenticated scheduling. Verify actual Vercel cron registration and runtime logs, not only `vercel.json`. Preserve the existing search cron.
6. After the agreed rollout gates pass, enable the intended features through the deployment configuration and redeploy. `SCHEDULING_OAUTH_ENABLED` enables both Cal.com and Calendly when their credentials exist; it is not a per-provider approval switch. `GOOGLE_CALENDAR_ENABLED` independently enables Google. `DISCOVER_V4_ENABLED` enables ranking/telemetry and attribution adapters. Leave `DISCOVER_PILOT_ID` absent until a registered, authorized pilot has participants and a protocol.
7. Verify production onboarding/feed/Following, attribution boundaries, same-account provider setup, consent, booking and recovery behavior with authorized test participants. Observe actual scheduled job, sync and watch-maintenance runs and their durable state. Record failures and cleanup; do not reuse staging results as production proof.

## Runtime configuration

Use production-only provider client credentials and `CALENDLY_WEBHOOK_SIGNING_KEY`. `SCHEDULING_TOKEN_ENCRYPTION_KEY` must be 64 hexadecimal characters (32 bytes); preserve it across deployments while encrypted connections exist. `CRON_SECRET` must be at least 32 characters. Do not export secrets to a report or place them in `NEXT_PUBLIC_*` variables. Sensitive variables absent from local `env run` output are not proof of missing deployment values.

| Route | Schedule | Disabled authenticated response | Runtime |
| --- | --- | --- | --- |
| `/api/search/enrich` | Every 10 minutes | Existing worker behavior | Existing route |
| `/api/scheduling/google/jobs` | Every minute | 200, `processed: 0`, `enabled: false` | Node, maxDuration 240s |
| `/api/scheduling/google/sync` | Every minute | 200, `processed: 0`, `enabled: false` | Node, maxDuration 240s |
| `/api/scheduling/google/maintenance` | Every minute | 200, `enabled: false` | Node, maxDuration 240s |

All three new routes authenticate before checking the feature flag and must return 401 without a valid Bearer secret. Active Pro/Fluid configuration was verified as compatible with the schedule and maximum duration; check the deployed route settings again. Authenticated scheduling-worker errors return 503 for retry and must not be interpreted as successful processing.

## Rollback limits

Turning off Discover suppresses its application ranking/telemetry paths; it does not reverse the taxonomy migration or database ledger triggers. Do not delete attribution history or reverse migrations as a routine feature rollback. Restore from backup only through a separately assessed recovery procedure that accounts for writes since the restore point.

Disabling Google also stops its booking jobs, synchronization and watch maintenance. Existing bookings may therefore stop progressing or reconciling. Inspect pending reservations/jobs and provider events before choosing that containment action; preserve credentials, encryption keys, job history and external booking IDs. An application rollback must remain compatible with the installed schema and existing bookings. The prior privacy-only deployment is a reference point, not proof that it is a safe rollback after schema changes.
