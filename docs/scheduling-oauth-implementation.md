# Automatic scheduling connections — implementation checkpoint

## Additional user requirement

The user requested Google Calendar as an additional provider on 2026-09-13. Include this in the full completion scope. Implement direct Google Calendar connection with availability, event creation/update/cancellation, calendar-change reconciliation, automatic watch-channel renewal, and the same original-video attribution and Bookings connection controls. Do not mark the goal complete with only Cal.com/Calendly, or label ordinary Calendar sync as a completed direct booking provider. Google Calendar work is not implemented yet. Official API references: https://developers.google.com/workspace/calendar/api/v3/reference and https://developers.google.com/workspace/calendar/api/guides/push .

Continue draft PR #169 on `feat/discover-conversion-ranking`. The existing media processor deployment and three-video production duration backfill are complete; do not repeat them.

## Current work (2026-09-13)

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
