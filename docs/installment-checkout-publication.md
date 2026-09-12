# Exact-cent checkout links — local staging candidate

> Integration numbering note (2026-09-07): the unapplied exact-installment sources are now **040–057**. Explicit filenames below use the canonical names; older numbered checkpoint references, test results, and captured hashes retain their historical 022–039 meaning. See [the migration map](exact-installment-migration-map.md) for the current sequence and new local acceptance. Historical results are not approval to install the renamed candidate.

September 6, 2026. **Not enabled or deployed; not a production approval.**
The subsequent [staging compatibility/access review](installment-staging-compatibility-review.md)
found existing financial ACL drift. The targeted staging-only repair has since
been approved, applied and independently verified: **15/15 checks PASS**. Hosted
acceptance still awaits candidate/migration review, staging recovery readiness
and bounded installation/configuration approval; no feature has been enabled.
This extends the existing creator-owned booking payment-link endpoint and the
existing dark-theme payment cards. It does not add a new booking step, change
older links or subscriptions, send email, collect money, or publish public terms.

## What changed

The existing authenticated endpoint verifies creator ownership first, then
dispatches an explicitly selected staging booking to the exact-cent service
before the legacy equal-installment and fee-percentage restrictions. With all
new flags off, the endpoint uses the existing path without reading new tables.
Unknown/unselected bookings and full payments retain the old behavior. Known
exact reservations cannot fall through to legacy creation during a feature pause
while the schema/reconciliation gates remain enabled.

Migration 039 reserves the new payment and immutable agreement in one database
transaction. Buyer, creator, post, active product, current USD price and connected
destination come from the owned booking, not browser amounts or metadata. The
server supplies the configured card and recurring fee schedules. Any existing
payment or purchase prevents conversion into this new path. A repeat with the
same terms reuses the original reservation; changed terms require review.
One agreement per booking and the existing one-live-payment constraint fence
duplicate reservations. The prospective version marker and first-payment fee
estimate cannot be rewritten or added to an older payment row.

The existing durable bootstrap prepares its isolated held subscription and
first-payment Checkout. The pending purchase must be seeded before any payable
URL is returned. The new publisher independently re-reads the current subscription,
customer, Checkout, private completed-request hash and (when allocated) unpaid
PaymentIntent. It checks exact cents, destination, card-only consent, discounts,
tax/adaptive-pricing exclusion, origin, expiration and the original Checkout URL.
An open Session may have a null PaymentIntent; the private completed-request hash
then verifies the submitted fee configuration, not a collected fee. Stripe's
[Session retrieval example](https://docs.stripe.com/api/checkout/sessions/retrieve)
documents that nullable state. Actual payment always requires the separate
receipt/charge/fee verification path.

A service-only publication RPC rechecks local ownership, immutable identities,
unpaid state, current product/destination and absence of holds, stops or receipts
under the agreement lock before saving/returning the URL. A lost response resumes
the original binding rather than creating another Checkout. Expired, changed or
uncertain links remain review-required; this version intentionally does not
generate replacement agreements for the same booking. Error responses do not
return raw provider/database details. Success responses use only the existing
public payment fields plus the additive collection-version marker, with
private/no-store and no-referrer headers.

The creator card retains the existing controls and layout. New exact plans show
the payment count, original total and any last-payment cent adjustment. The
saved booking fee fields are labeled **First payment fee estimate**, including
after payment, because actual receipt accounting is stored separately and later
payments use the frozen recurring schedule. Old cards keep their existing labels.

## Configuration contract — do not enable from this document

Only the known CreatorNet Staging Supabase project, a trusted HTTPS Vercel Preview
origin and a Stripe test key can pass the environment checks. The processing-fee
feature must be explicitly enabled with complete configured card/Billing rates.
No rates were read from or changed in a hosted account in this checkpoint.

`CREATOR_EXACT_INSTALLMENTS_CHECKOUT_SCHEMA_READY` acknowledges migration 039
and enables its additive marker in the booking-list response.
`CREATOR_EXACT_INSTALLMENTS_CHECKOUT_PUBLISH_READY` separately permits publication.
`CREATOR_EXACT_INSTALLMENTS_CHECKOUT_BOOKING_IDS` selects at most ten distinct
booking UUIDs; no wildcard or automatic enrollment is accepted. Both new gates
and the existing schema, Sandbox preparation, stop coordination, refund-event,
billing-stop, lifecycle, recovery and admin gates must be exactly `true`.

The booking allowlist does **not** authorize a monthly debit. After reserving a
new app-owned test agreement, separately verify and approve its ID for the
[monthly webhook collection allowlist](installment-monthly-webhook-collection.md)
and its readiness gates before the controlled renewal test. Never insert manual
Stripe-only experiments into app-owned acceptance or broadly enable collection.

To pause issuance, disable publication/remove the booking from its list. Keep
the installed schema/reconciliation flags enabled for persisted agreements; do
not turn off every exact-plan flag or roll back to code unaware of those bindings.
Previously shared Checkout URLs are not invalidated by a publication-flag change.
Use the separately approved exact-plan stop/expiry flow when those must close;
do not delete records, rewrite receipts or silently cancel customer agreements.

## Acceptance boundaries

Final local result: **2335 tests / 99 suites passed**, including 108 additional
cases in this checkpoint. Standalone TypeScript and the optimized local build
passed with synthetic process-only configuration and disabled exact-plan gates.
New modules/tests are lint-clean; targeted checks reported no errors and 33
existing warnings in the touched legacy routes/page. The existing dynamic-cookie
diagnostics and intentionally unreachable `example.invalid` sitemap fallback
remain; build exit status was zero. No `.env` file was read or changed.
No commit/push, hosted migration, configuration/credential change, Stripe mutation
or production deployment occurred. Migration 039 and the preceding 022–038 are
local-only, and no booking/agreement was added to a hosted allowlist.

Local tests exercise reservation/publication SQL on in-memory PostgreSQL, the
actual creator HTTP handler/service with synthetic ports, authenticated ownership,
same-origin/strict body checks, defaults-off compatibility, stale/changed provider
objects, exact fee validation, lost-response/reuse, private RPC privileges and
existing UI DOM interactions. Single-connection PGlite and mocks do not prove
hosted multi-worker races, email delivery, real browser rendering or payments.

Before hosted acceptance, review the complete 022–039 migration sequence and
candidate diff, check the target schema/constraints and staging restore plan,
and approve a bounded fixture/configuration window. The new unique index must
be preflighted for duplicate booking agreements; do not delete duplicates to
force installation. Install only to verified staging, then test a newly created
booking from link generation through actual first, intermediate and final
Sandbox payments on that same candidate. Verify ledger fees/credits, cents,
access, no extra invoice, duplicates, out-of-order/lost events, failure/3DS,
replacement/future-card choices, refunds/stops and concurrent requests. Confirm
the correct webhook subscriptions and existing authentication/resource flows.

Policy alignment, visual QA, staging backup/restore readiness and the existing
[release gate](admin-refund-release-gate.md) remain open. Prior manual Stripe
experiments and earlier candidate acceptance do not validate this implementation.
No production merge, deployment or flag/credential change is authorized here.
