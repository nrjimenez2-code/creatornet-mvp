# Automatic scheduling connections — implementation checkpoint

## Additional user requirement

The user requested Google Calendar as an additional provider on 2026-09-13. Include this in the full completion scope. Implement direct Google Calendar connection with availability, event creation/update/cancellation, calendar-change reconciliation, automatic watch-channel renewal, and the same original-video attribution and Bookings connection controls. Do not mark the goal complete with only Cal.com/Calendly, or label ordinary Calendar sync as a completed direct booking provider. Google Calendar implementation is in progress; see the latest checkpoint. Official API references: https://developers.google.com/workspace/calendar/api/v3/reference and https://developers.google.com/workspace/calendar/api/guides/push .

Continue draft PR #169 on `feat/discover-conversion-ranking`. The existing media processor deployment and three-video production duration backfill are complete; do not repeat them.

## Current work (2026-09-13)

### Recovery before a Google creation attempt

Migration `20260913234159_google_unattempted_booking_recovery.sql` adds a durable mutation-start marker written under the job lease before external mutations. An unavailable or elapsed create time can become a failed, recoverable reservation only when no mutation was started. Prior attempts predating the marker are conservatively backfilled as possibly delivered. Ambiguous remote outcomes remain reserved for reconciliation.

The buyer can reselect a time using the same reservation, source attribution and purchase. Rearming verifies the original identity and all prior jobs, preserves failed-job history, increments the reservation revision and queues a fresh create job. Stale workers cannot begin work on the retired job. Saved reservation links resolve their owner-scoped original intent and recheck current setup or paid eligibility. Failed bookings remain listed with a recovery link and clear wording that the previous requested time was not booked. The original dashboard migration was amended locally; it has never been applied remotely.

Validation: the scheduling selection passed 21 suites / 166 tests, followed by the added dashboard regressions (20 reservation/database tests and 3 dashboard UI tests passed). TypeScript and diff checks passed. No remote migrations, live provider acceptance, push or deployment occurred.

Remaining: recovery/visibility for revoked connections and ambiguous mutations, stale reschedules whose desired time passes without an external version change, representative worker/sync throughput, live OAuth and full payment/scheduling/later-sale acceptance, ranking pilot/calibration, PR review and production rollout. The full goal remains active and incomplete.

### Externally changed reschedule recovery

Added recovery for a pending Google reschedule when authoritative provider reads show a changed event version or deletion. A changed version prevents the stale conditional PATCH from succeeding; the worker restores the actual provider time and marks the superseded job failed. Deletions become canceled bookings. Matching desired times still complete normally, and unverifiable provider responses remain reserved for retry.

Migration `20260913233649_google_reschedule_recovery.sql` commits booking state, original-video attribution and terminal job state under the current worker lease. It verifies attribution ownership and rejects unchanged event versions. The buyer status API exposes a recovery notice; the management page explains the restored state and offers another reschedule when eligible. Starting a fresh operation clears the notice.

Validation: four affected suites passed 44 tests covering processor behavior, local PostgreSQL recovery/rollback/permissions, owner-scoped status and buyer UI. TypeScript passed. No remote migrations, live provider calls, push or deployment occurred.

Remaining: safe recovery for never-created/past or unavailable slots, revoked connections and uncertain remote mutations; full representative sync/worker throughput; live Google/Cal.com/Calendly OAuth and scheduling/payment/later-sale acceptance; ranking pilot/calibration; PR review and production rollout. Do not classify all permanent booking failures as resolved by this change.

### Google sync reliability review

Reconciliation now locks the notification lease through the booking/attribution transaction, checks expiry again before commit, and rejects missing booking revisions. A PostgreSQL trigger test expires the lease during the update and verifies that both reservation changes and scheduling-credit changes roll back. Browser roles cannot invoke the service-only reconciliation functions.

Notification maintenance continues cleanup after a failed renewal or individual channel stop, then reports the run incomplete for retry. The cron route also continues reconciliation after maintenance failure. Focused maintenance and worker tests cover these failure paths.

Validation: the broader scheduling selection passed 21 suites / 149 tests. Two subsequent regression additions passed in the affected suites (14 attribution tests and 7 status/worker tests). TypeScript passed. No remote migration, push, deployment or real provider acceptance occurred.

Next priority: permanent booking failure recovery (the current runner retries indefinitely), followed by representative sync throughput and live OAuth/payment/scheduling acceptance. Ranking calibration/pilot, full performance testing, PR review and production rollout remain incomplete. Existing reconciliation migration was amended because it has never been applied remotely.

### Google calendar reconciliation checkpoint

Added service-only leased reconciliation of persisted Google bookings, authoritative event reads for external moves/deletions, atomic attribution changes and notification generations that retain changes received during a sweep. The worker processes ten bookings per page with five concurrent provider reads and resumes its cursor only after a successful page. Watch maintenance renews connected channels within 24 hours of expiry and retires known or expired channels.

Validation: four selected suites passed 25 tests, including local PostgreSQL attribution/lease/generation checks, notification/worker routes and reconciliation orchestration. TypeScript passed. These changes remain local and undeployed; no remote migrations or live OAuth acceptance ran.

Remaining: maintenance failure/recovery coverage, permanent booking error recovery, final transaction lease review and representative throughput testing (full history scans are a baseline, not proven scalable). Live Google/Cal.com/Calendly OAuth setup, full booking/payment/later-sale acceptance, ranking pilot, PR review and production rollout remain incomplete.

### Google Bookings dashboard checkpoint

Native Google bookings now appear in the Bookings dashboard with separate buyer and creator views, participant display names, local times, pending statuses and requested reschedule times. Buyers reopen the owner-scoped management page; creators can open Google Calendar for their incoming calls. The creator view does not impersonate buyer permissions for native API mutations.

Migration `20260913231348_google_booking_dashboard.sql` adds a service-only participant-scoped listing with immutable creation-time/ID pagination. The authenticated route always supplies the actor from the session and validates role/cursor inputs. Each page returns twenty rows plus a continuation cursor. Account/role changes remount the list so prior participant data is not retained.

Validation: three selected suites passed 24 tests covering real local PostgreSQL ownership/pagination, route authentication/pagination and dashboard UI isolation. TypeScript passed after the final timezone label. No live browser, remote migration or deployment was verified.

Next: implement background Google calendar-change reconciliation, proactive watch renewal and retired/unknown-channel cleanup. Resolve permanent booking failures and ambiguity recovery, then complete concrete provider/database integration, real OAuth accounts and full scheduling/payment/later-sale acceptance. Ranking pilot/calibration, representative performance, PR review and production rollout remain required. The full goal remains active and incomplete.

### Google rescheduling UI checkpoint

The buyer page now exposes a rescheduling picker with weekly navigation, explicit time selection and the saved booking revision. A stale options response cannot be submitted. Closing the picker retains the current booking and refreshes status. Pending rescheduling displays both the current and requested times; the current time is not replaced until the provider-backed reservation becomes confirmed. The status projection includes the requested interval. New reschedule controls are hidden after the original start time.

Validation: the buyer UI and service suites passed 13 tests, including old/new time display and stale-revision rejection. TypeScript passed after the final UI change; the six buyer-page tests also passed on the final code. This remains local implementation; real browser/provider behavior and deployed worker execution are unverified.

Next priority: include native Google bookings in Bookings, then finish background watch reconciliation/renewal/cleanup, concrete service integration and permanent-error recovery. Complete live scheduling/payment/later-sale acceptance, ranking calibration pilot, representative performance, PR review and production rollout. The full goal remains active and incomplete.

### Google rescheduling API checkpoint

Rescheduling now has owner-scoped availability and submission APIs under /api/scheduling/google/reservations/[reservation]/times. Availability reads the current event and rejects external version changes, excludes only the saved event ID, retains other overlapping events through all result pages, and resolves all-day boundaries in the calendar’s timezone (including DST). It preserves the original appointment duration and buffers while using current weekly hours. Purchased calls recheck their paid entitlement. An already accepted matching move returns its current status instead of queueing another operation.

Migration `20260913230334_google_booking_reschedule_admission.sql` rejects changed policies/expired watches and already-started bookings, then delegates to the existing atomic old/new-time reservation lifecycle. The generic processor also refuses new calendar mutations whose target time passed while queued; already-applied remote operations can still be reconciled. Permanent failures and expired operation recovery still need a complete resolution flow, not indefinite retries.

Validation: four selected suites passed 56 tests covering provider availability, PostgreSQL reservations, buyer service and processor decisions. TypeScript passed after the final passed-time guard. Official event-list behavior was checked at https://developers.google.com/workspace/calendar/api/v3/reference/events/list . No live provider, browser or deployment was tested.

Next: connect these rescheduling APIs to the buyer UI and include native Google bookings in the Bookings list; then complete background calendar-change reconciliation, renewals and retired/unknown channel cleanup. Remaining acceptance includes concrete service/route integration, ambiguous/permanent failures, live account configuration and calendar/payment workflows, ranking pilot, representative performance, PR review and production rollout. Keep the full goal active.

### Google buyer page and recurring worker checkpoint

The native /scheduling/book/[connection] page now loads authenticated availability, accepts an explicit time selection, submits the stable booking intent and polls an owner-scoped reservation endpoint. The saved URL includes the reservation ID so reopening a confirmed booking does not repeat Stripe/setup checks or depend on the source video remaining public. Sign-in uses the existing /auth return-path mechanism. The UI distinguishes pending requests from Google-confirmed bookings and supports an explicit cancellation confirmation; cancellation queues the existing durable operation and retains pending status until provider confirmation. Status reads never release credentials, provider event IDs or another buyer’s booking.

Connected Google settings now supply a selectable native event URL in the composer. A CRON_SECRET-protected, default-off Google worker route processes a bounded batch of up to four jobs. vercel.json schedules it every minute; no deployment has occurred. Verify the target plan’s frequency support, configured secret, actual duration/throughput and live cron execution during rollout. Preview verification must explicitly invoke the authenticated worker because Vercel’s recurring schedule runs in production. Reference: https://vercel.com/docs/cron-jobs/manage-cron-jobs .

Validation: four selected suites passed 21 tests covering buyer booking/status/cancellation UI, ownership, worker authentication/batch bounds, admission service and existing connection UI. TypeScript passed after the final UI tests. No real browser visual review, live Google event or deployed worker was verified.

Next priority: implement buyer rescheduling (including availability that excludes its own event), expose native bookings in the Bookings list, and implement background Google watch change reconciliation/renewal/retired-channel cleanup. Complete concrete service integration tests, timeout/permanent-error recovery, live OAuth accounts and full booking/purchase/later-sale acceptance, controlled ranking pilot, representative performance, PR review and production rollout. The goal remains active and incomplete.

### Google buyer admission checkpoint

The native booking URL recognizer now binds CreatorNet’s Google booking route to the configured origin. Verified sales-call setup attribution survives that redirect, including when Google is enabled separately from Discover ranking. Paid-call redirects carry a purchase ID only for this native route. The buyer access service validates the connected creator, signed-in buyer, original post and verified setup intent, or the existing paid-call capture/access checks and original purchase post. Paid-call intent creation does not emit a setup or scheduling milestone.

The new Google booking API can return available times and submit a reservation. Availability combines current Google busy intervals and one JSON aggregate of local occupied ranges. Admission passes its calendar/policy snapshot to migration `20260913225146_google_booking_admission.sql`, which rejects changed settings/expired watches, prevents duplicate purchased sessions and allows a never-attempted expired hold to be retried. Reservation IDs are stable per verified intent. Accepted retries do not enqueue a second operation. Before new paid calendar mutations, the worker rechecks purchase entitlement; it still reconciles an already-completed remote operation first.

Validation: six selected suites passed 64 tests across access, availability/admission, local PostgreSQL reservations, attribution URLs, existing paid-call access and processor logic. TypeScript passed after the final service tests. These are local/mock tests, not a live payment/calendar acceptance run. No migration or application deployment occurred.

Next: implement the buyer calendar page at /scheduling/book/[connection], reservation status/management endpoints and reschedule/cancel UI; expose the finished Google URL in the composer; connect the durable job worker and background watch synchronization/renewal/retired-channel cleanup. The new API queues work but no recurring worker is wired yet. Still verify concrete service integration, paid revocation/permanent-error recovery, browser draft retention, real providers, full commercial flows, ranking pilot, performance, PR review and production rollout. The goal remains active and incomplete.

### Google connection and calendar setup checkpoint

Google is now a supported OAuth start/callback and Bookings connection option. Authorization saves encrypted tokens under a lease and continues in the separate window to owned-calendar selection, conflict calendars, weekly hours, timezone, call duration, lead time, horizon and buffers. The creator explicitly saves these settings. The new setup RPC atomically marks the connection ready only with an active notification channel and current lease. Google notifications validate the stored channel token/resource and request authoritative reconciliation; headers never award attribution. Stale connection reads recheck calendar ownership and renew an expiring watch under the same connection lease. Account switches clear the prior setup form.

Migration `20260913224148_google_calendar_setup.sql` also serializes disconnect with booking admission: outstanding mutations prevent disconnect, held times are invalidated, and no new creation/reschedule/cancel can be dispatched after disconnect starts. Remote known watches are stopped and local credentials cleared. Unknown watch creations after a timeout still need background expiry/reconciliation handling; retired channels still need routine cleanup.

Validation: eight selected suites passed 66 tests across database setup/reservations/attribution, OAuth routes, notification/settings routes, setup/composer UI and Google adapters/processor. TypeScript passed after the final service refactor. No browser visual verification or live Google authorization was performed. The full Google connection service still needs database/provider integration tests, including ambiguous watch creation, token-refresh races and reconnect/disconnect recovery.

Next priority is the buyer booking flow: Google intentionally has no selectable post booking URL yet because that destination does not exist. Implement authenticated slots/reserve/reschedule/cancel routes and screens, verify source/purchase ownership, and expose the finished URL through the composer. Connect the durable worker and complete background watch reconciliation/renewal/retired-channel cleanup. Then perform live provider acceptance, full commercial flows, ranking pilot, performance, PR review and rollout. All new migrations and app changes remain local; do not label the full goal complete.

### Google attribution transaction checkpoint

Migration `20260913223807_google_booking_attribution.sql` adds Google to the verified scheduling provider set, binds each non-null attribution to one reservation, rejects mismatched buyer/creator/original-video identities, and completes reservations, Discover scheduling/cancellation signals and jobs in one transaction. An attribution failure rolls back completion so retry remains possible. Live lease checks guard completion, including after attribution reconciliation.

Eight local PostgreSQL tests cover no credit at setup/queue time, confirmation idempotency, source/identity rejection, rollback, reschedule/cancellation, duplicate attribution, browser role restrictions, later mentorship attribution and repair after a delayed confirmation. The selected three database suites passed 31 tests; the changed attribution suite is rerun after the final lease guards. This is local database evidence, not a live Google or Stripe end-to-end test. No remote migration or deployment occurred.

Next: wire Google OAuth start/callback and safe connection status, calendar/availability setup and watch provisioning, then authenticated buyer admission and booking/reschedule/cancel screens. Run concrete worker integration tests and connect a protected recurring worker, watch reconciliation and renewal. Cal.com/Calendly live account setup remains unverified. Complete commercial acceptance, ranking pilot, representative performance, PR review and production rollout before closing the goal.

### Google booking processor checkpoint

The local processor and concrete database/Google runner now reconcile deterministic event IDs before retrying, guard operation revisions and live leases, recheck external availability with the reservation’s saved buffers, use conditional rescheduling, and retain occupied reservations after uncertain failures. Token refresh is serialized and encrypted. Deleted-event tombstones are accepted only for a recorded event ID.

Validation: 28 focused processor/adapter tests pass, including duplicate recovery, external edits, attribution mismatch, cancellation failure, tombstones and overlapping-event pagination. The concrete database runner still needs integration tests. No cron endpoint or schedule is connected, Google OAuth/UI and buyer admission routes remain unwired, and job completion does not yet update Discover attribution (the existing SQL provider whitelist excludes Google). Implement atomic attribution/outbox handling before enabling this path. Watch reconciliation/renewal and live acceptance remain required. Nothing was deployed.

### Google reservation lifecycle checkpoint

CLI-generated migration `20260913222716_google_calendar_reservations.sql` now allows Google in connection/OAuth-state database constraints and adds private Google settings, notification watches, reservations and durable operation jobs. Service-only SQL functions reserve times under a connection-scoped transaction lock, enqueue creation once, reserve old/new times during rescheduling, retain times during cancellation, claim jobs with leases and finalize only the current leased revision. Never-attempted holds can expire; ambiguous external creation does not release its reservation. Original video and attribution identifiers remain on the reservation.

Ten real local PostgreSQL tests pass for idempotent requests, ownership, overlapping times, expired versus attempted holds, disconnect admission, private permissions, reschedule/cancel occupancy and stale-worker exclusion. These are not a multi-session production concurrency benchmark. Neither this migration nor the earlier connection migration is applied remotely.

Next: implement the Google job processor, wire Google OAuth/config/status UI and the creator availability form, and add the buyer booking/reschedule/cancel routes/screens with verified source/purchase checks. Enforce availability against both current Google data and these reservation rows. SQL expects the authenticated route to verify buyer/source/purchase ownership and the creator's full availability policy before reserving. Background watch reconciliation/renewal and live provider acceptance are still missing. The Google adapter and availability engine from the preceding checkpoint are available for these integrations.

### Google Calendar adapter checkpoint

`lib/googleCalendarProvider.ts` now implements Google OAuth offline/PKCE authorization, permission validation, refresh-token retention, verified account lookup, calendar listing, fail-closed free/busy reads, deterministic event IDs, attributed event creation, conditional rescheduling/cancellation, watch creation/removal/notification validation, and paginated incremental synchronization reads including cancellation tombstones. `lib/bookingAvailability.ts` implements creator-defined weekly availability, duration/steps, lead time/horizon, buffers and busy/reservation exclusions using actual UTC instants with timezone/DST handling.

Google is not yet wired into the database/provider union, OAuth routes, Bookings controls, creator availability editor or buyer booking pages. No Google connection is live. Remaining work includes a persisted reservation/outbox lifecycle with double-booking protection and idempotent recovery, Google watch renewal/reconciliation jobs, permissions/credential setup and real acceptance. Sync notification validation is only a signal to fetch authoritative events; it must never directly award booking credit. Commit a nextSyncToken only after the entire corresponding change set has been reconciled. A Google 410 sync error requires a full reconciliation, not treating bookings as absent.

Validation: the Google adapter and availability suites passed 22 tests; TypeScript passed. These are adapter tests with mocked HTTP responses and pure availability tests, not evidence of Google production interoperability. Existing Cal.com/Calendly code was not changed in this checkpoint.

### Second checkpoint

The composer now mounts `SchedulingConnections` when creating or attaching a one-off call and when adding a sales-call booking option. It opens a separate authorization window, retains the mounted draft (including selected File objects), rechecks on return, and reuses saved event selections. The same component adds Bookings status/manage/reconnect/disconnect controls. It clears stale status after failed reads and hides prior-account state on an account switch.

Authenticated start/callback/status/disconnect routes and `lib/schedulingConnections.ts` are implemented locally. OAuth state is hashed, creator/provider scoped, cookie bound, encrypted where needed, expiring, and consumed once. Stored credential refresh is protected by a database lease. Webhook provisioning reconciles subscriptions using the exact connection callback URL; event types are loaded through the provider account. The scheduling receiver now resolves persisted connections and requests retries while a connection is being restored. Calendly string event references are hydrated through its authenticated API and checked against the connected account.

These changes have not been deployed and the migration remains local only. External OAuth apps are still unconfigured/unverified. Google Calendar is not implemented. Do not treat the source implementation as full acceptance evidence.

Validation for this checkpoint: eight selected suites / 47 tests passed, including five new route tests and five UI tests. TypeScript passed during implementation and is rerun before committing. Tests do not yet cover the complete connection service against a real provider or all ambiguous failure/lease-recovery paths. Browser visual verification, event pagination beyond database response limits, lease timing/concurrent reads, webhook secret rotation, reconnect/disconnect recovery, provider event deletion/reschedule chains, paid-call attribution, and real scheduling acceptance still need review and testing. The remaining original ranking pilot, commercial/performance tests and production rollout remain required.

The earlier foundation-only description below is historical; use the second checkpoint above for current wiring status and the next-work list as an acceptance checklist, not a claim that every listed file is absent.

The first-time composer connection flow is in progress. `lib/schedulingProvider.ts` implements provider authorization URLs, code exchange, refresh-token exchange, authenticated account reads, webhook creation, and webhook removal. `lib/schedulingSecrets.ts` implements AES-256-GCM encryption with creator/provider/purpose context binding. Neither module is wired into the application yet.

The CLI-generated migration `20260913220917_scheduling_oauth_connections.sql` adds server-only connections, single-use OAuth attempts, and verified event types. Connections cannot have status `connected` without credentials and a webhook. Active provider accounts cannot be shared across CreatorNet identities. RLS is enabled and public/browser roles have no table privileges. The migration has been executed in disposable local PostgreSQL tests only; it is not applied to staging or production.

Validation: provider and encryption tests plus the existing scheduling signature suite passed (22 tests). Four local PostgreSQL tests passed for browser-role denial, readiness constraints, unique account ownership and creator-bound one-time state consumption. TypeScript checking passed before the database test was added; rerun when wiring routes/components.

## Next implementation work

1. Wire the first-time prompt into `components/PostComposer.tsx` for paid one-off calls and mentorship/course sales calls. Preserve every draft field and selected media file. A separate authorization window can leave the composer mounted and retain its File objects; provide an accessible return path and handle blocked popups/cancel/retry without clearing the composer. If using same-tab navigation, persist File/Blob assets in IndexedDB and verify the write commits before navigating.
2. Add authenticated start/callback/status routes. Validate same-origin mutations, creator identity and one-time expiring state. Save encrypted rotating tokens and use a database lease to prevent concurrent refresh-token reuse. Return only a safe status projection to clients. Do not label connected until webhook provisioning and account/event-type ownership are verified.
3. Provision webhooks behind the scenes with reconciliation after ambiguous network/database outcomes. Reconnect must replace/reconcile an existing subscription instead of leaking duplicate webhooks. Disconnect must remove provider webhooks and encrypted tokens, stop future callback credit, preserve existing historical attribution, and permit retry if provider cleanup fails.
4. Fetch all supported active event types through OAuth with pagination. Select verified booking URLs for future posts. Reconcile existing pasted links and routed destinations without trusting arbitrary URLs as proof of account ownership.
5. Replace/extend the environment-only connection lookup in `app/api/scheduling/[connection]/route.ts`. The current route accepts a single configured event type and has not yet been adapted for persisted connections, provider account ownership, real Calendly event-resource hydration or reschedule chains.
6. Add Bookings status/manage/reconnect/disconnect UI in `app/dashboard/closers/page.tsx`. Stripe setup remains separate from actual confirmed scheduling.
7. Verify genuine provider create/reschedule/cancel callbacks, paid calls, purchases, sales-call-to-later-mentorship attribution, refunds and reconnection. Complete the controlled Discover pilot, representative traffic/performance tests, PR review and production rollout only with actual evidence. No completion or rollout is claimed here.

## Provider configuration prerequisites

The user was unsure that OAuth applications existed and explicitly approved inspecting both developer dashboards. Both opened at login screens; user sign-in was requested. No credentials have been read or created.

Cal.com requires an approved OAuth client; current endpoint is `/auth/oauth2/authorize` and token endpoint is `https://api.cal.com/v2/auth/oauth2/token`. Register a stable callback for each deployment environment and request only the required profile, event type, webhook and booking read scopes.

Calendly confidential clients use Basic authentication at the token endpoint. OAuth webhook signatures use the application's Calendly-issued signing key, not a per-creator `signing_key` override. Confirm webhook availability on the intended test account/plan through actual API response. Refresh tokens require serialized rotation.

Use a dedicated `SCHEDULING_TOKEN_ENCRYPTION_KEY` (64 hex characters / 32 random bytes) stored in deployment secrets. Do not reuse the Supabase service-role key or put any credentials in `NEXT_PUBLIC_` variables. The application client IDs, secrets, webhook signing key, fixed OAuth origin/callback configuration, provider feature gates and connection management endpoints still need wiring.

Primary references checked:

- https://cal.com/docs/api-reference/v2/oauth
- https://cal.com/docs/api-reference/v2/webhooks/create-a-webhook
- https://developer.calendly.com/api-docs/calendly-o-auth/o-auth/post-oauth-refresh-token
- https://developer.calendly.com/docs/authentication/scopes
- https://developer.calendly.com/api-docs/calendly-api/webhooks/create-webhook-subscription
- https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures

Full goal remains unchanged and incomplete. The user says “COMPLETE 1-8” but supplied seven numbered entries; do not silently invent an eighth requirement or drop any supplied entry.
