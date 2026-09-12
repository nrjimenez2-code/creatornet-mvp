# Monthly webhook collection — staging-only candidate

> Integration numbering note (2026-09-07): the unapplied exact-installment sources are now **040–057**. Explicit filenames below use the canonical names; older numbered checkpoint references, test results, and captured hashes retain their historical 022–039 meaning. See [the migration map](exact-installment-migration-map.md) for the current sequence and new local acceptance. Historical results are not approval to install the renamed candidate.

September 6, 2026. **Not enabled, not deployed, not a release approval.** The
owner's stop-before-production instruction remains in force. No hosted settings,
Stripe objects, credentials, public terms or financial records were changed.

## Implemented locally

The canonical Stripe webhook still verifies the signature and acquires its
existing durable event claim before the exact-installment handoff. A persisted
subscription binding, not webhook metadata, selects the agreement. Only
`invoice.created` can reach new monthly payment admission. The event bridge
re-retrieves the invoice and verifies its test-mode customer/subscription.

A new server-only policy limits new HTTP collection to at most ten explicitly
selected staging agreement UUIDs. No wildcard, customer-wide selection, request
header/body override, or implicit enrollment is supported. The existing
`SANDBOX_COLLECT` setting alone still cannot enable monthly HTTP collection.
Production, a live key/event/object, a different Supabase project, and a
different persisted Preview origin cannot pass the existing environment checks.

The collector retains exact-cent fees and final adjustment, saved-card ownership,
current-period eligibility, prior receipt/refund/dispute checks, held subscription
verification and serialized database admission. One durable admission allows
one explicit `invoice.pay` call with an immutable idempotency key and SDK network
retries disabled. An uncertain result is reconciled, not retried as a new charge.

`invoice.paid` and `invoice.payment_succeeded` receive no debit permission and
use receipt-only mode. A stale receipt event cannot configure/finalize an unpaid
invoice, prepare/admit dispatch, or pay it. The existing claim RPC can look up
an admission (and may reserve a private claim when none exists); absence of an
original admission remains retryable review, never invented payment evidence.
Existing recovery observations and receipt accounting remain separate from new
charge permission. Turning off the new HTTP switch does not prevent reconciling
an admitted paid invoice while the existing schema/reconciliation gates remain on.

The existing worker's inspect/prepare modes still cannot pay. No cron job,
public collection endpoint, catch-up debit, automatic failed-payment retry,
Stripe automatic advance, subscription resume, UI change or checkout publication
was added in this step.

## Configuration contract — do not enable from this document

All of the following server acknowledgements must be exactly `true` before a
new monthly HTTP debit is considered:

- `CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY` (new, default off)
- `CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY`
- `CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE`
- `CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT`
- `CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY`
- `CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY`
- `CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY`
- `CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY`
- `CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY`
- `CREATOR_EXACT_INSTALLMENTS_ADMIN_READY`

`CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS` is a comma-separated
list of one to ten distinct lowercase version-4 agreement UUIDs. Whitespace
around entries is allowed. Empty/missing selects nothing; malformed entries,
duplicates or an oversized list fail closed without echoing its contents.
These IDs must be resolved from newly approved app-owned staging fixtures, not
copied from manual Stripe-only experiments. Configuration acknowledgements are
not proof that schema installation or acceptance testing succeeded.

Keep all current environment isolation checks. Never copy test secrets or
staging IDs to Production, remove the live-mode guard, or merge to an
auto-deploying production branch to test this code.

## Verification boundaries and next gates

The new integration tests execute the real Stripe signature verifier, canonical
HTTP handler, handoff, event bridge and collector, using synthetic database and
Stripe API ports. They cover exact cents and final termination, event claim
ordering, duplicate and receipt deliveries, lost responses, failed event
completion, disabled gates, bad allowlists, wrong metadata, live/production
rejection, changed financial evidence, holds and missing persisted bindings.
Existing local PostgreSQL tests independently exercise the SQL admission/hold
contracts; mocks and single-connection PGlite do not prove hosted concurrency.
Final local results: **2227 tests / 98 suites passed** (76 additional tests),
standalone TypeScript, targeted ESLint and optimized synthetic-env build passed.
The build's existing dynamic-cookie diagnostics and unreachable `example.invalid`
sitemap fallback remain; exit status was zero. No `.env` file was read or changed.
See the [expansion checkpoint](installment-pricing-expansion.md) for context.

The subsequent [checkout/link integration](installment-checkout-publication.md)
is now implemented locally behind its own default-off booking allowlist; its
latest full local result is 2335 tests / 99 suites. It remains unaccepted on hosted staging.

Before a hosted acceptance window: review the entire candidate and migration
sequence 022–039, verify staging recovery prerequisites, install only to the
verified staging project, and authorize the precise new fixture IDs/settings.
Exercise the new checkout/link publication integration without changing old
agreements. Verify actual first, intermediate and final invoice fees, exactly
one ledger credit per payment, no extra invoice, duplicate/out-of-order delivery,
lost responses, declines/3DS, optional future-card consent, refunds/stops and
distributed races on that same candidate. Bounded worker recovery remains a
separate integration decision; it is not silently scheduled here.

Prospective policy alignment, visual acceptance, backup/restore readiness and
the [release gate](admin-refund-release-gate.md) remain open. Passing these local
tests alone does not mean CreatorNet is ready to deploy.
