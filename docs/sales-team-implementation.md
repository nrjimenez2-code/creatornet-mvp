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
| `CREATOR_TEAM_RECIPIENT_SCHEMA_READY` | Discover durable recipient setup and capability observations for current and historical payees. |
| `CREATOR_TEAM_RECIPIENT_ONBOARDING_READY` | Admit new recipient/account-link requests, independently of status and verification reads. |
| `CREATOR_TEAM_PAYMENT_SCHEMA_READY` | Discover saved team customer, intent, confirmation, observation and closure records. |
| `CREATOR_TEAM_PAYMENT_COLLECTION_READY` | Admit new buyer payment preparation/confirmation separately from review/consent and recovery. |
| `CREATOR_TEAM_RECEIPT_SCHEMA_READY` | Discover original confirmation/capture provenance and independently verified receipts. |
| `CREATOR_TEAM_RECEIPT_RECORDING_READY` | Admit receipt recording independently of new sales; required before new collection. |
| `CREATOR_TEAM_FULFILLMENT_SCHEMA_READY` | Read shared team purchase/delivery bindings and timed entitlements after new activity stops. |
| `CREATOR_TEAM_FULFILLMENT_READY` | Admit first shared purchase/fee accounting and delivery; required before new collection. |
| `CREATOR_TEAM_EVENT_SCHEMA_READY` | Discover signed event holds and immutable financial observations. Original ownership fencing remains installed even when source flags are disabled. |
| `CREATOR_TEAM_EVENT_RECONCILIATION_READY` | Apply current independently read team payment events; required before new collection. |

All gates default to false. The database also starts with access, new-sale and settlement controls false. Financial configuration starts without approved context, verified pricing, reserve configuration or approved disclosures. A source change or migration must not mark these accepted.

## Current local implementation

October 22 regression continuation: the three failed suites saved at `38b521b`
are resolved locally. Windows CRLF bytes in two candidate SQL migrations did
not match their LF source predicates; both comparisons now normalize line
endings while retaining the original provenance checks. The legacy checkout
test now supplies its Supabase server factory without constructing an imported
singleton before the mock database is initialized. Focused evidence: checkout
17/17, service binding 22/22 (including both line endings and changed-source
rejection), and payment database 323/323 (including both accounting line
endings). The first repair run still failed 44 later accounting assertions;
the follow-up repaired that cause. This is affected-suite evidence, not a new
complete-suite or hosted acceptance result. Original receipts remain preserved.

- Creator-scoped memberships and recoverable invitation request identities; current verified invitation email is checked through a narrow service-only private helper, without granting the service role broad Auth-table access.
- Owner-only manager appointment/removal, manager management of closers, explicit manager-as-closer configuration, versioned commission terms, separate acceptance and payout-readiness requirements.
- Own-login recipient status, independent capability refresh and Stripe-hosted setup at `/dashboard/closers/payouts` and `/api/sales-team/recipient`. Verified legacy account ownership reuses the original durable creation key. New Accounts v2 creation freezes its own request, fences the legacy creation path, and uses the existing provider journal. Unknown creation results are independently reconciled without another POST; incomplete account-list evidence stays held. Transfer and bank-payout capabilities are separately verified, including nullable unrequested capabilities. Capability observations are retained without banking details. Removed payees with accepted financial obligations retain verification/recovery access while routing remains revoked. Private-release continuations require their own admitted setup or accepted agreement. Account Links have no provider object ID; their separate durable requests retain saved URLs/expiry, and uncertain link results block additional links pending reconciliation.
- Private destination bindings over existing `booking_targets`; transactionally serialized weighted assignments with repeat-request reuse, unavailable-member exclusion, manual reassignment and frozen accepted-sale attribution. Unbound shared calendars grant no access.
- Team APIs and Bookings screens; closer customer data is limited to currently assigned bookings. Invitation membership does not grant platform administration or website tester access.
- Manager/owner forms for explicit pre-acceptance booking assignment, destination enablement/weights, and prospective commission terms. A stale changed revision requires refresh; repeating already-saved identical terms preserves the current revision and acceptance. Only the creator can change manager roles.
- Separate approved sales prices/options for the booked product, with exact-cent fixed-total installments and distinct monthly-service terms. Existing product purchase protocols and prices are not rewritten by these team approvals.
- Buyer-only review/acceptance; current source and permissions are revalidated before acceptance. Review-only choices may be replaced; accepted or unresolved legacy financial paths require recovery. Agreements and audit history are immutable. Departure preserves accepted agreements. Team invitations and drafts retain private-release controls; only the exact immutable buyer-accepted sale can use a saved continuation while the site is hidden.
- Pure cumulative commission/refund calculations, creator-funded processing/reserve splits, exact once-only shared-fee allocation and protected-surplus calculations.
- Independent versioned separate-charge request/receipt validators, current account/project/site context checks and a service-only provider-operation journal. The buyer Payment Element now creates a ConfirmationToken for server US billing/issuer checks and manual confirmation. Per-sale customer, first-obligation intent, confirmation sequence and cancellation requests retain their original parameters and keys. Unknown writes reconcile independently without another POST; incomplete lists stay held. Bank authentication requires server reconfirmation of the original verified card. Sign-in/cookie and identity handoff checks run before new buyer activity; only the buyer receives an action client secret, which is not persisted in browser storage.
- Stop is saved before cancellation/reconciliation and fences fresh dispatch. A terminal canceled/unpaid original or proof that no intent was dispatched can close the original purchase admission and allow a new approved review. Unknown or captured funds cannot close unpaid. Original agreements and audit history remain immutable, while only the unpaid booking's active attribution lock is released. Paid plans can also stop future automatic debits while retaining existing paid access and contractual-balance review. Fresh independently read states prevent late responses from regressing terminal outcomes. New source and database collection gates remain false.
- Buyer API recovery independently reads the original intent, charge and actual balance transaction, then rereads intent/charge before recording a receipt against the original bound confirmation. Captured US billing/issuer evidence remains separate from mutable current payment-method data. Unknown asynchronous processing costs remain explicit reserves. Known refunded principal is immediately excluded from commission, while incomplete refund responsibility/dispute evidence stays held. The saved commission hold starts no earlier than independent capture verification and is preserved through later cost recovery.
- Acceptance freezes delivery in the existing shared snapshot contract. It reuses an eligible published revision, or freezes legacy links and existing owned private assets without moving media or changing the public product pointer. Receipt fulfillment atomically links one shared purchase, orders, fee ledger and Library delivery. Team ledger splits explicitly separate commission, actual processing costs, reserves and deficits. Exact legacy constraint definitions are checked before adding the team branch; the old expressions remain intact for legacy rows. Five old earnings/refund helpers retain their implementations behind team guards. Team accounting books only its own post-commission aggregate delta, avoiding a second ordinary earnings credit. Team shared history cannot be deleted through cleanup rights.
- Shared Library/video entitlement readers enforce ownership, financial holds and saved service/payment bounds. Team purchases keep `access_granted=false`, so disabling the reader cannot grant permanent access. Private snapshots survive subsequent price, link and public revision changes. UI distinguishes captured/pending receipt, verified/pending delivery, financial review and a fulfilled Library purchase; SDK success does not grant access.
- Shared buyer/product admission uses the existing payment foundation's lock. Team agreement acceptance and legacy checkout creation cannot claim the same active purchase. Existing legacy rows require their original recovery path; they are not converted into team sales.
- A shared booking-source transaction creates or adopts a current unpaid lead, preserves aliases from verified completion/attribution, and reuses its assignment across repeated requests. Enrolled creators' calendar redirects cannot fall through to an unbound legacy destination. Booking setup/completion records lead attribution; scheduling confirmation remains separate.
- Scoped commission statements retain removed closers' own financial history, with no customer/provider identity or creator-accounting disclosure. Active managers/owners see creator-side accounting. Keyset pagination preserves whole-relationship totals as integer-cent strings. Transfers and reversals are shown separately; bank-payout evidence is explicitly unrecorded until its provider integration is implemented. This read path remains available under private-release controls and disabled new activity, with verified identity and database ownership checks.

## Work still required

Connect automated account capability events/current worker verification; verify calendar confirmation against assigned destinations and expose its verified state; complete refund/dispute balance-cost and responsibility review/recovery, separate-charge admin refunds, fixed-total/monthly later-payment, cancellation and payoff behavior; implement actual shared-cost reconciliation, settlement claims, reserve-protected withdrawals, bank-payout status and alerts; complete the earnings/accounting views. Signed team event routing, current bounded independent financial observations, first-payment collection, receipt recovery, shared Library fulfillment and safely unpaid replacement are locally implemented. Actual Stripe account/payment availability, hosted onboarding and browser/provider acceptance remain unverified. Full installed-schema compatibility and booked-offer admission against the current exclusive video-action/booking model still require verification.

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
- October 22 recipient continuation: 10 distinct affected suites / 112 tests pass across scoped runs (15 recipient SQL, 15 recipient policy, 12 provider adapter, 10 recipient API, 7 recipient UI, 6 existing team UI, 1 statement UI, 23 release policy, 8 release server, 15 release proxy). The latest hardening checks cover changed account pins, future verification timestamps and failed cookie/identity handoff before onboarding. Cached readiness also checks the current full saved setup context. An initial integration run had 6 provider-adapter failures from a host-realm `structuredClone` fixture; parsed RPC JSON corrected the fixture without changing identity validation. Initial typechecks also exposed mock signature/narrow return-type errors, corrected in the test fixture. Recipient-source scoped lint passed with zero errors/warnings. Regression-repair lint passed with zero errors and 34 existing warnings in the large payment database suite.

The local Turbopack build started October 22 at 15:49:50 Phoenix remained in compilation without a result. The user explicitly authorized stopping only that build; PID 4676 was revalidated by creation time, parent and command and stopped, with no child workers present. Its log is preserved. This interrupted build supplies no pass/failure or diagnosed cause.

Webpack follow-up first failed with EPERM creating a generated types directory. Direct creation of the exact directory succeeded; the cause remains unestablished. After confirming the failed build and worker exited, a run outside the filesystem sandbox compiled in 56 seconds, then exposed a missing declaration for the existing JavaScript `mentorship-original-monthly-identity` route. A matching declaration describes only its existing exports; the runtime JavaScript remains byte-identical (SHA256 `711C8099D63E4E873E44B20F20B8835307CA81D989E46310F05BC99429DC9C28`). The existing preview-maintenance and original-monthly-completion safeguards pass 141/141. This does not change their original approval or dispatch boundaries.

After that declaration fix, full TypeScript and declaration lint passed. The local webpack production build at `c2e45fad3cf814f5d1c2bd49d91a57cfc3041811` completed with exit 0 using only fake CI credentials: compilation 57 seconds, TypeScript 24.1 seconds, static generation and build traces completed. The log retains cookie-dependent dashboard `DYNAMIC_SERVER_USAGE` notices; these routes were emitted dynamically. This is local webpack evidence; the default Turbopack/hosted CI gate and browser/provider acceptance remain outstanding.

- October 22 collection continuation: 7 distinct affected suites / 89 tests pass across the latest applicable receipts: collection SQL 13, provider/database adapter 9, API 16, UI 7, existing sale SQL 13, release policy 23 and release server 8. These cover original-only uncertain-operation recovery, SCA reconfirmation, Stop/dispatch fencing, terminal-state read races, conclusive-unpaid replacement, source gates, scoped recipient admission and browser confirmation identity. Initial runs exposed a SQL CASE-expression parse error, a cross-realm context fixture, an incorrect repeated offer fixture, and a missing test filename. Follow-up exposed an intentionally unproven recipient fixture and an unexpected generic continuation fallback; the fixture was corrected and unknown team descendants now fail closed. All failed/partial receipts remain preserved. Raw Stripe response typing and a synchronous React effect state update were also corrected. Full TypeScript and scoped ESLint pass, with zero lint errors/warnings.

PGlite uses synthetic users and minimal structural fixtures. Its Promise-based repeat requests verify durable deduplication but do not establish multiple hosted PostgreSQL session contention. No hosted team migration, provider mutation, purchase, transfer, refund, payout, deployment or LIVE acceptance has occurred. Full CI/default Turbopack, hosted schema/security validation, browser verification and separately authorized sandbox/Production acceptance remain outstanding.

October 22 capture/fulfillment continuation: latest applicable receipts cover 12 distinct affected suites / 125 passing tests: capture policy16, capture SQL9, independent readback5, shared fulfillment12, entitlement reader6, full buyer API flow3; existing collection API16/UI8/adapter9, private delivery17, membership access routes20 and Library creator access4. The full API fixture drives GET-only provider recovery through real PGlite receipt, commission, shared accounting and Library entitlement while new sales are disabled. Full TypeScript and scoped lint pass with zero lint errors/warnings. Initial failures exposed an ambiguous SQL alias, missing fixture types, a clean-versus-financial fixture mismatch, and a journal transaction-start timestamp that could precede its token inside a long transaction. New operations now default to actual admission time; existing operation timestamps/identities are untouched. A new long-transaction check preserves that invariant. A later ambiguous receipt-proof variable was also corrected. Failed/diagnostic receipts remain saved. These structural tests reuse the real shared ledger constraints and delivery functions, but do not establish full historical composer/CTA or hosted schema compatibility. The previous webpack pass at `c2e45fa` predates these runtime changes; there is no new current-revision full build or CI result.

## Hosted catalog evidence and no-repeat boundaries

October 22 signed-event continuation adds the local candidate
`20261023000533_sales_team_payment_events.sql`. The canonical webhook routes
bound team intents/charges before every legacy payment/refund/dispute adapter,
including duplicate refund-confirmation repair. Signature, destination/mode and
the shared durable event claim still run first. Metadata can fence a payment
for review; it cannot grant ownership or supply accounting terms. Only an
uninstalled locator function permits unmarked legacy fallback. Database errors
and owned/marked objects fail closed. Installed saved ownership continues to
fence the legacy path with application flags disabled.

New deliveries persist an immutable event locator and pending hold before any
provider inspection. Pending events close Library access and fresh payment
dispatch. Failed reads, a worker loss or disabled application gates leave the
hold durable. Current lifecycle recovery only reads an already bound original;
it does not create customers/intents or reconfirm a debit. Captured events
independently inspect the original capture, bounded paginated refund/dispute
lists and repeated list membership/current charge reads. Original charge fees
replace estimates only after verified readback. Event observations and shared
accounting commit together, and a later retry can resume pending shared
fulfillment without another receipt or payment.

Confirmed refunded principal immediately reduces commission even if the
bounded refund list is incomplete. Missing responsibility decisions, pending
refunds, unmatched dispute identities, incomplete lists and ambiguous partial
refund/dispute overlap remain held. Another pending event cannot be cleared by
one completed delivery. Dispute balance adjustments and related costs still
require their dedicated reconciliation; a won dispute alone does not release
that financial review. The refund-review table is a private immutable seam;
the admin review and separate-charge refund dispatcher are still incomplete.
Legacy admin preview/create/retry explicitly refuse team ledger rows before
provider calls, instead of using destination-charge transfer/application-fee
operations. New team collection requires the independent event gate in source
and the database. All new controls default false. No hosted migration or
provider mutation is implied by this source implementation.

Provider API references: [list refunds](https://docs.stripe.com/api/refunds/list),
[list disputes](https://docs.stripe.com/api/disputes/list), and
[marketplace refunds/disputes](https://docs.stripe.com/connect/marketplace/tasks/refunds-disputes).
The installed Stripe SDK declarations confirm the charge filters and cursor
pagination. The original charge's processing cost is kept distinct from
dispute/refund balance adjustments and later shared settlement costs.

Latest applicable local signed-event receipts cover 23 distinct suites / 455
passing tests across scoped runs: signed team HTTP/database16, locator7,
financial policy7, capture readback5, buyer receipt API3, collection9/API16,
legacy webhook342 across eleven suites, legacy admin refund API3/workflow10/
app12, installment refund coordination19 and monthly coordination6. Full
TypeScript passed; scoped lint has zero errors and 23 existing `any` warnings
in the canonical webhook. This is not a consolidated full-suite or CI pass.
Initial runs failed on SQL parentheses, a Request/NextRequest test type, a mock
error constructor/overload, and a fixture failure that incorrectly shared a
PostgreSQL transaction across a simulated failed HTTP request. A recovery run
also named a nonexistent adapter test; its two real suites passed, but that
run was not green. The broad webhook run initially failed 24 assertions in two
legacy fixtures: catch-all reservation responses also answered the new locator,
and write-denial assertions treated its exact read-only RPC as a write. Fixtures
now return no team owner only for that named lookup and continue checking every
other operation. The two corrected legacy suites plus latest team signed suite
pass125, including signature order, private history, lost-read durable holds,
concurrent pending deliveries, pre-receipt holds and post-accounting delivery
recovery. Failed/partial receipts are preserved. No new build, hosted schema,
browser, real provider mutation or acceptance result is claimed.

Read-only October 21 catalog queries inspected the actual Production booking router, columns, constraints, policies and grants. The installed router uses `booking_targets` and increments uses without a booking assignment; it does not establish signed-in closer identity. The hosted service role lacks `SELECT` on `auth.users`; the local test fixture now matches that restriction.

Do not repeat the release-controls migration: its reviewed source filename is `20261021010052_controlled_website_releases.sql`, but the existing hosted applied-once receipt is version `20261021020911`. Reconcile that receipt before any proposed migration installation; a filename mismatch is not permission to replay it. Do not repeat old payment operations, consumed provider tests or preserved checkout tests just to reconstruct context. Do not use this branch's code as authority for hosted financial, account, scheduler, migration, deployment or Production/LIVE changes.
