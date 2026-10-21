# Closing teams, approved checkout and commissions

This is a new implementation of the October 21 closing-team plan. Its full acceptance goal remains booking → assigned closer → buyer-approved payment → verified receipt → commission → confirmed bank payout.

## Source and isolation

- Started from current main `85bbcf50b84a9c5ba935d1e2c778b6a1ac0d9048` in the isolated `codex/closing-teams-20261021` worktree.
- Reviewed payment candidate `a69b8ff9a48cc4abf7a5df08c1589f2fb1c95743` was integrated locally in merge `a00aa470f8858d0a0311b25ccc78dbe44862b909`. The integration retains current main's premium delivery guards, composer loading/Retry behavior and deterministic booking clock tests.
- Existing release-controls and dirty payment checkouts are preserved. Reviewed release-control source `02c0ead076e20fbba52351bd46ab5c7469aa58cb` is integrated locally for private-access verification. This does not publish, merge their GitHub pull requests or activate their outstanding releases.
- Automatic Vercel Git deployment is disabled for this branch. The inherited root deployment configuration is an old payment candidate profile, not an approved team-sales deployment package.

## Default-off gates and installation

**DB MIGRATION REQUIRED.** All new migrations are local candidates. Their hosted applicability, exact order, preservation baseline and security checks require a separate reviewed installation. The payment candidate's unapplied dependencies and hosted acceptance remain prerequisites.

| Gate | Purpose |
| --- | --- |
| `CREATOR_SALES_TEAM_SCHEMA_READY` | Discover installed membership, invitation and assignment schema. Keep installed-schema discovery available for existing obligations. |
| `CREATOR_SALES_TEAM_READY` | Admit new team administration/routing operations. |
| `CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY` | Discover installed offer approvals and sale agreements. |
| `CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY` | Discover installed financial ledger and statement read model, including historical obligations while new activity is disabled. |
| `CREATOR_TEAM_SALES_CHECKOUT_READY` | Admit new team-sale review and acceptance, also requiring the existing purchase-policy/legal gates. |
| `CREATOR_TEAM_SETTLEMENT_READY` | Separate settlement admission control; not enabled by team access or checkout. |

All gates default to false. The database also starts with access, new-sale and settlement controls false. Financial configuration starts without approved context, verified pricing, reserve configuration or approved disclosures. A source change or migration must not mark these accepted.

## Current local implementation

- Creator-scoped memberships and recoverable invitation request identities; current verified invitation email is checked through a narrow service-only private helper, without granting the service role broad Auth-table access.
- Owner-only manager appointment/removal, manager management of closers, explicit manager-as-closer configuration, versioned commission terms, separate acceptance and payout-readiness requirements.
- Private destination bindings over existing `booking_targets`; transactionally serialized weighted assignments with repeat-request reuse, unavailable-member exclusion, manual reassignment and frozen accepted-sale attribution. Unbound shared calendars grant no access.
- Team APIs and Bookings screens; closer customer data is limited to currently assigned bookings. Invitation membership does not grant platform administration or website tester access.
- Manager/owner forms for explicit pre-acceptance booking assignment, destination enablement/weights, and prospective commission terms. A stale changed revision requires refresh; repeating already-saved identical terms preserves the current revision and acceptance. Only the creator can change manager roles.
- Separate approved sales prices/options for the booked product, with exact-cent fixed-total installments and distinct monthly-service terms. Existing product purchase protocols and prices are not rewritten by these team approvals.
- Buyer-only review/acceptance; current source and permissions are revalidated before acceptance. Review-only choices may be replaced; accepted or unresolved legacy financial paths require recovery. Agreements and audit history are immutable. Departure preserves accepted agreements. Team invitations and drafts retain private-release controls; only the exact immutable buyer-accepted sale can use a saved continuation while the site is hidden.
- Pure cumulative commission/refund calculations, creator-funded processing/reserve splits, exact once-only shared-fee allocation and protected-surplus calculations.
- Independent versioned separate-charge request/receipt validators, current account/project/site context checks and a service-only provider-operation journal. Unknown operations are reconciled without another POST. These are local execution seams; no payment dispatcher is connected yet.
- Receipt-driven cumulative commission/creator liabilities, saved holds, explicit refund responsibility, processing-cost credits, dispute freezes and conservative combined-loss accounting. Duplicate and stale observations do not repeat ledger entries. Provider observation and fulfillment handlers are still required.
- Shared buyer/product admission uses the existing payment foundation's lock. Team agreement acceptance and legacy checkout creation cannot claim the same active purchase. Existing legacy rows require their original recovery path; they are not converted into team sales.
- A shared booking-source transaction creates or adopts a current unpaid lead, preserves aliases from verified completion/attribution, and reuses its assignment across repeated requests. Enrolled creators' calendar redirects cannot fall through to an unbound legacy destination. Booking setup/completion records lead attribution; scheduling confirmation remains separate.
- Scoped commission statements retain removed closers' own financial history, with no customer/provider identity or creator-accounting disclosure. Active managers/owners see creator-side accounting. Keyset pagination preserves whole-relationship totals as integer-cent strings. Transfers and reversals are shown separately; bank-payout evidence is explicitly unrecorded until its provider integration is implemented. This read path remains available under private-release controls and disabled new activity, with verified identity and database ownership checks.

## Work still required

Complete durable recipient onboarding/reuse and current capability verification; verify calendar confirmation against assigned destinations and expose its verified state; implement the versioned separate-charge payment admission/confirmation and recovery path without loosening destination-charge validators; implement safely closed unpaid option replacement; connect verified receipts to shared fulfillment and accounting; implement provider financial observations, refund/dispute recovery, actual cost reconciliation, settlement claims, reserve-protected withdrawals, bank-payout status and alerts; complete the earnings/accounting views.

The new distribution protocol must preserve the payment candidate's pre-charge billing/card checks, current authorization/Stop checks, original operation identities, independent provider receipts and immutable saved request bytes. A default hosted Checkout capture must not bypass those gates.

## Verification and evidence limits

Recorded local checks so far (source-only evidence; not provider acceptance):

- Payment integration: 8 affected Jest suites, 272 tests; full TypeScript check passed.
- Initial team access/API/accounting plus existing booking-destination UI: 4 suites, 32 tests.
- Sale agreements and access migration: 2 suites, 20 tests.
- Sale/API and existing payment-link regressions after the team-protocol boundary: 4 suites, 127 tests.
- Scoped lint and TypeScript checks passed at intermediate revisions; rerun for subsequent changes.
- Consolidated foundation: 22 suites, 407 tests passed; receipt/privacy follow-up is covered by the later receipt database run.
- Booking routing, context and receipt follow-up: six suites passed (39 tests). The free-booking mock lacked the new asynchronous redirect helper; after correcting the mock, free-booking plus new authorization/redirect tests passed in two suites (18 tests). This covers eight distinct suites and 57 tests across those runs, not additional independent repetitions of the foundation tests.
- Current scoped ESLint reported zero errors and warnings; full TypeScript check passed after correcting a synthetic session fixture's type assertion.
- Private-release integration and team continuation/access tests: 14 suites, 109 tests passed. Scoped lint had zero errors/warnings and the full TypeScript check passed. This is local source evidence; the existing hosted owner-session acceptance is still unresolved.
- Manager-control change: access/UI/API passed in 3 suites/24 tests. After additional targeted assertions and updating the reviewed-revision fixture, UI/API/sale/booking-source checks passed in 4 suites/33 tests; these runs cover 5 distinct suites/46 tests. Full TypeScript and scoped lint passed.
- Statement/access/accounting/journal/receipt/release-policy change: 7 suites/65 tests passed. This includes historical access after departure, cross-creator denial, private financial-table/RPC denial, scoped manager accounting, cursor ownership, full-relationship totals, integer precision, recipient/dispute holds and an expired dispatch lease with a null reconciliation flag. Full TypeScript and scoped lint passed.

PGlite uses synthetic users and minimal structural fixtures. Its Promise-based repeat requests verify durable deduplication but do not establish multiple hosted PostgreSQL session contention. No hosted team migration, provider mutation, purchase, transfer, refund, payout, deployment or LIVE acceptance has occurred. Full CI, full build/schema/security validation, browser verification and separately authorized sandbox/Production acceptance remain outstanding.

## Hosted catalog evidence and no-repeat boundaries

Read-only October 21 catalog queries inspected the actual Production booking router, columns, constraints, policies and grants. The installed router uses `booking_targets` and increments uses without a booking assignment; it does not establish signed-in closer identity. The hosted service role lacks `SELECT` on `auth.users`; the local test fixture now matches that restriction.

Do not repeat the release-controls migration: its reviewed source filename is `20261021010052_controlled_website_releases.sql`, but the existing hosted applied-once receipt is version `20261021020911`. Reconcile that receipt before any proposed migration installation; a filename mismatch is not permission to replay it. Do not repeat old payment operations, consumed provider tests or preserved checkout tests just to reconstruct context. Do not use this branch's code as authority for hosted financial, account, scheduler, migration, deployment or Production/LIVE changes.
