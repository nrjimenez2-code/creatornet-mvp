# Launch operations and incident response

Keep the site private until the remaining acceptance gates have actual receipts. This
runbook does not schedule monitoring, send notifications, open access or prove capacity.

## Current observations and unverified controls

Sentry client/server/edge instrumentation and request-error capture exist. Console-log
forwarding and default PII are disabled. Worker observability is enabled; media encoding
queue concurrency remains one. These source settings do not prove ingestion, alert
rules, contact routing, retention or alert delivery. Moderation report email failures
are separately tracked and retried through the existing admin flow.

The current launch preparation observed a Vercel team budget of USD200 with alerts at
50%, 75% and 100%; automatic pausing and budget webhooks were off and its status required
owner review as overdue. This is a dated observation, not an approved spend increase or
a hard ceiling. Recheck the current billing window, team, spend and recipient settings.
The owner chooses thresholds and channels. Enabling a team-wide automatic pause can
interrupt unrelated projects, owned purchase recovery and required provider callbacks.
Do not enable it as an implicit incident response.

Supabase Spend Cap is separate, applies only to certain usage items and is not a granular
budget/alert system. R2 request/storage usage and Stream encoding/storage need their own
coverage. No current receipt establishes those alert destinations or limits. Record
baseline usage, billing windows, delayed-meter limitations and the owner's accepted
incremental budget before any provider acceptance or load test.

## Acceptance ledger

Assign a named operations owner and recovery delegate before opening features. Record:

- Active application/Worker revisions, project IDs, release flags, last known safe
  deployment and rollback instructions preserving subsequent unrelated work.
- Error-rate, latency, database resource/connection pressure, failed auth/email admission,
  rejected uploads, pending/failed processing and dead-letter backlog observations.
- Paid purchases missing fulfillment, webhook failures, unmatched provider identities,
  durable admission failures and uncertain financial operations. Inspect their original
  receipt before any retry. Never test alerting by charging or refunding a customer.
- Per-provider spend thresholds, recipients, escalation timing, and actual controlled
  delivery receipts. A configured threshold alone does not prove delivery. Notification
  sends/tests must be explicitly scoped; this document performs none.
- Current backup success/age, object-backup coverage and last isolated restore evidence
  using `docs/disaster-recovery.md`. No fixed RPO/RTO is promised before measurement.

Thresholds must include an explicit minimum sample/window and incident action so a
small traffic burst does not trigger an unsafe automatic rollback. Establish them from
the measured intended release and provider constraints; do not invent passed SLOs.

## Incident sequence

1. Record the onset time, affected surface, release/Worker revisions, original operation
   IDs and scope. Preserve bounded logs and receipts without tokens or customer payloads.
2. Keep or close new feature issuance through existing release controls while preserving
   buyers' owned access and authenticated provider/job endpoints. Assess whether a
   feature gate actually covers the affected path; never disable all recovery blindly.
3. Inspect application, database and provider state before repeating anything uncertain.
   Do not cancel other chats' jobs, roll back their work, rotate credentials, revoke
   sessions, alter provider routing or delete fixtures as an unreviewed shortcut.
4. Choose the smallest forward repair or exact compatible rollback. Retain security
   constraints, original money identities, immutable delivery bindings and processing
   admissions. Database/media restores follow the isolated recovery procedure, not an
   automatic application rollback.
5. Verify the repaired flow and preservation boundaries, record remaining gates and let
   admitted operations settle. The owner decides whether and when to reopen features.

## Capacity checkpoint

The September Window 2 checkpoint is not current-release capacity proof. It retained
100 synthetic Auth users, 95 sessions and 120 hidden fixture posts in staging project
`nwqfofezfzljhxolkycz`, namespace `cn-1cdaae142bc74ee382968977392ca812.invalid`.
The comparison `auth-smoke-20260920032533` made zero workload requests and consumed its
authorization. Original post restoration already completed. Do not replay either action.

Start with a fresh bounded exact-cohort/session/reference readback. If sessions remain,
obtain a provider-supported scoped revocation method; normal admin sign-out needs the
user JWT and the old run did not persist it. A temporary ban does not revoke existing
sessions. Do not create replacement sessions/tokens, delete Auth rows with SQL or weaken
cleanup guards. After independently verified cleanup, fresh source qualification,
resource/cost admission and coordinated authorization are needed before resuming the
failed level. No 250+ step or 10,000-user acceptance follows from a small canary.

The production feed canary workflow is manual, public-only and capped at 50 anonymous
journeys with exact cleanup requirements. It must not be dispatched while the site
remains private, and its seven-day artifacts must be preserved promptly after an
authorized run. It is not a scheduled monitor or a mixed authenticated-user load test.

References: [Vercel spend controls](https://vercel.com/docs/spend-management),
[Supabase costs](https://supabase.com/docs/guides/platform/cost-control),
[Supabase sign-out](https://supabase.com/docs/reference/javascript/auth-signout),
[user-management limits](https://supabase.com/docs/guides/auth/managing-user-data).
