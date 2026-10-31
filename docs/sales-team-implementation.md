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
| `CREATOR_TEAM_LATER_COLLECTION_SCHEMA_READY` | Discover immutable later-period windows and the buyer-owned current-period overview. |
| `CREATOR_TEAM_LATER_COLLECTION_READY` | Admit buyer-invoked collection of the exact next accepted fixed/monthly period. Requires payment, receipt, fulfillment, event and financial readiness; existing accepted debts do not require new-sale access. |
| `CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY` | Discover private exit requests, exact monthly payoff acceptance, payoff Stop and verified coverage completion. Read and Stop remain available independently of new-money readiness. |
| `CREATOR_TEAM_PAYOFF_COLLECTION_READY` | Admit a separately buyer-confirmed one-time payoff of the accepted unpaid monthly minimum. Requires the installed lifecycle, payment, capture, fulfillment, event and financial paths; no new-sale access is required. |
| `CREATOR_TEAM_RECEIPT_SCHEMA_READY` | Discover original confirmation/capture provenance and independently verified receipts. |
| `CREATOR_TEAM_RECEIPT_RECORDING_READY` | Admit receipt recording independently of new sales; required before new collection. |
| `CREATOR_TEAM_FULFILLMENT_SCHEMA_READY` | Read shared team purchase/delivery bindings and timed entitlements after new activity stops. |
| `CREATOR_TEAM_FULFILLMENT_READY` | Admit first shared purchase/fee accounting and delivery; required before new collection. |
| `CREATOR_TEAM_EVENT_SCHEMA_READY` | Discover signed event holds and immutable financial observations. Original ownership fencing remains installed even when source flags are disabled. |
| `CREATOR_TEAM_EVENT_RECONCILIATION_READY` | Apply current independently read team payment events; required before new collection. |
| `CREATOR_TEAM_FINANCIAL_SCHEMA_READY` | Discover private financial inspections, balance traces, retry identities and cost adjustments. |
| `CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY` | Independently reconcile original refund/dispute principal, costs and credits; required before fresh collection. |
| `CREATOR_TEAM_REFUND_REVIEW_READY` | Admit an audited responsibility decision for an existing independently read successful refund. This does not dispatch a refund. |
| `CREATOR_TEAM_BOOKED_OFFER_SCHEMA_READY` | Use separate, audited booking/offer associations and the assignment-scoped offer catalog. New associations also require the default-off database control. |

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

### Independent financial costs and admin inspections — October 22 continuation

The financial reconciliation candidate now encloses every guarded patch in one
transaction. Private immutable inspection requests map retry UUIDs to the same
original check, including after a resumed request completes. A pending check
holds Library access and fresh collection before provider reads. Another
pending check or signed event cannot be cleared by completing this check.
Replaying a completed request returns the current hold, without provider reads.

The reusable financial reader retrieves refund debit/failure-credit and dispute
withdrawal/reinstatement transactions by their independently listed references.
It admits at most 32 distinct references with concurrency four, a 45-second
admission budget and per-request timeouts capped to its remainder. It rereads
list membership, transaction economics, capture identity, decisions and context.
These limits have local fixture coverage, not measured provider acceptance.
Raw customer data, descriptions and dispute evidence are excluded from stored
proof. Incomplete/changed/unknown traces retain their holds.

Original charge processing costs remain separate from signed net auxiliary
fees/credits. Audited refund responsibility allocates original processing cents
using the existing cumulative fee algorithm, plus that refund's actual auxiliary
costs. SQL independently checks identity, integer cents, reference coverage,
principal, credit allocation and source-event binding before accounting. Closed
disputes can now reconcile principal and costs; winning alone is insufficient.
Shared orders/fee ledger, post-commission creator earnings and scoped statements
include auxiliary adjustments without calling legacy earnings credit twice.

The default-off admin view at `/admin/commerce/sales-team` and its same-origin
API require persisted administrator authority and the exact financial context.
They inspect originals and record permanent responsibility for an independently
retrieved, already successful refund. Review retains a hold until a fresh
inspection. They do not dispatch refunds. The existing legacy refund fence
continues to reject team rows.

Local evidence includes 24 PGlite integration cases covering real guarded
installation, shared ledger/earnings/Library accounting, mixed checks, original
request recovery, role isolation, malformed proofs and full transaction rollback
on a failure in the final patch, 32-reference/four-read limits, admission expiry
and mixed-case cumulative allocation ordering. Admin API/UI, balance policy, collection gates,
signed events and existing capture/shared/statement fixtures also passed their
affected checks: 126 distinct cases across 14 suites, using latest applicable
receipts rather than summing repeated runs. Two cases drive the real signature
verifier and canonical HTTP webhook through the new financial path with GET-only
provider mocks, including duplicate delivery and original-read recovery. Full TypeScript passed after explicitly widening the generated
UUID parameter to a validated string; scoped ESLint has zero errors/warnings.
Exact receipts are retained in the continuation chat's `work/financial-*.json`
and typecheck logs. This is local fixture/mock proof. Current full CI/build,
installed hosted compatibility, real browser/provider acceptance and bank payout
remain unverified. Financial/refund-review source and database controls remain
off. No hosted migration, provider write or release activation was performed.

Remaining product work includes the separate-charge refund dispatcher, automated
pending-event/check/capability recovery, later collection and Stop/payoff,
settlement/surplus/bank-payout observations, and actual booking/composer schema
compatibility. Source inspection confirms the canonical post API rejects
`product_id` for a book action while the team sale source requires a booked
post's `product_id`. The canonical path needs a separate, authorized booked-offer
association; the structural shared fixture does not resolve this conflict.

### Canonical Book compatibility — October 22 continuation

The source conflict above is now resolved locally by a separate booking/offer
association. Public posts retain their exclusive Book action and null
`product_id`. Only the creator or an active appointed manager can attach or
remove an owned active USD offer for a sales-call booking. The operation records
immutable revisioned history and audit, uses an original request UUID, and
refuses changes after sale acceptance. A detached/re-attached association changes
the source revision and invalidates an outstanding buyer review even when its
price is unchanged. Existing accepted agreements and delivery bindings stay frozen.

Association does not approve a price or create payment choices. The creator or
manager must separately save the approved offer. The closer's catalog requires
the current assignment and readiness, exposes only associated offers, and
returns only creator-approved options. Multiple products are identified by name
in the checkout selector. Management changes refresh the open offer catalog
without discarding an original saved price-approval request.

Candidate `20261023010604_sales_team_booked_offer_associations.sql` uses guarded
patches for the existing approval/source functions and service-only grants/RLS
for its association history and RPCs. Its source readiness flag and database
control default off. The unchanged legacy source path remains available for
eligible historical posts; the public composer and publishing guards were not
weakened.

Local checks use the actual `guard_published_video_action_v1` source from the
canonical composer migration. A combined Book/product insert is still rejected.
The canonical Book path now passes offer approval, buyer acceptance, independently
constructed capture proof, shared purchase/delivery and Library entitlement in
PGlite. This reuses the existing capture fixture with optional setup hooks;
default fixture behavior is retained and its existing receipt checks also pass.
The first run failed during fixture assignment to a post converted to Buy; the
fixture now publishes a valid canonical Book post before assigning the booking.
Latest applicable local receipts cover 64 distinct cases in eight suites: new
association SQL10/API11/UI3, existing team API9/UI6, sale SQL13, capture SQL9 and
buyer receipt API3. TypeScript and scoped lint pass with zero lint errors/warnings.
Receipts are `work/booked-offers-integration.json`, `booked-offers-final.json`,
`booked-offers-typecheck-final.log` and `booked-offers-lint-final.json` in the
continuation chat. These are structural/guard/mock checks, not complete historical
schema installation, hosted contention, real browser/provider or LIVE acceptance.
A subsequent combined fixture installs the statement, signed-event, financial
and booked-offer candidates together on the shared capture base. Canonical Book,
accepted offer, first receipt, independent GET-only financial inspection and
shared Library entitlement pass together (`work/combined-financial-booked.json`,
10 tests). Combined TypeScript and scoped lint also pass. The full historical
installed-schema and release gates remain outstanding.

### Admin refund requests and original recovery — October 22 continuation

The local candidate `20261023012742_sales_team_admin_refund_dispatch.sql`
and `/api/admin/sales-team/refunds` now add a separate team refund request,
explicit preview/confirmation, one admitted refund POST, and original-only
recovery. The legacy destination-charge admin fence stays in place. No provider
write or hosted installation was executed to verify this candidate.

A persisted current administrator freezes the original receipt, revision, exact
cents, cost bearer, reason, context, request UUID, provider-operation UUID,
request bytes and idempotency key. Reservation holds the receipt before provider
reads. Fresh dispatch requires a complete clean inspection after reservation,
unchanged observation revision, no competing pending event/check, and current
database execution gates including signed-event reconciliation. The POST only
refunds the original separate charge; it includes no automatic transfer or
application-fee reversal parameters. Unstarted requests can be audited as
canceled only while no provider operation exists.

Recovery never admits an unstarted POST. An unknown outcome can bind only after
an independently retrieved real provider event proves the original journal
idempotency key and original provider request ID, plus the owned refund's exact
economics/context. Matching metadata alone cannot establish ownership. Recovery
stores actual event-list/refund GET request IDs and can continue with new-money
dispatch disabled. Known originals are independently retrieved and reconciled;
a failed read first retains a durable financial hold.

Stripe's [refund testing guidance](https://docs.stripe.com/testing#refunds)
documents that an initially successful refund can later fail. Principal
restoration requires a complete independently owned debit/return-credit trace,
once-only consumption of the actual failure credit, and deferred links to the
completed financial check and immutable balance entry. The general monotonic
refund guard remains. A final financial observation is linked into the original
request's immutable history and controls the reported status; event/worker
checks keep their actual provenance instead of impersonating an administrator.
A missing bound original or terminal-state regression cannot clear the hold.

The admin client saves and verifies its actor/receipt/mode-scoped original
request before dispatch, retains it on unknown outcomes, and offers original
recovery while new refunds are held. It has no default cost bearer or reason.
It clears a saved request only for the matching reconciled definitive outcome.
Saved provider status and a Stripe transfer do not confirm bank receipt.

The latest applicable local receipts cover 92 distinct cases across eight suites,
not one consolidated full-suite run: refund SQL/runtime24, admin API14/UI7,
source gates3, existing financial SQL24, real-signature HTTP4, balance policy10
and provider journal6. The new SQL/runtime cases install the complete candidate
on the shared fixture, exercise mocked one-POST/GET-only recovery, enforce the
final-observation and once-only-credit rules, and roll back every schema change
after a failure injected at the final grant. Existing financial cases now install
the refund candidate as well. Exact latest receipts include
`work/refund-dispatch-verified.json`, `refund-dispatch-final-observation.json`
(reuse only its passing financial24/HTTP4), `refund-dispatch-final-scoped.json`
(gates3/balance10/journal6), and `refund-dispatch-safety-initial.json`
(unchanged API14). Earlier failures are preserved and are superseded only by the
specific passing follow-ups. These are local SQL/jsdom/signature/mock checks;
there is no real browser or provider-money acceptance. Full TypeScript exits 0
and scoped ESLint has zero errors/warnings at this checkpoint.

Source gates `CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY` and
`CREATOR_TEAM_REFUND_DISPATCH_READY`, and database control
`refund_dispatch_enabled`, default false. This implements local request,
dispatch and reconciliation seams; it does not establish launch readiness.
Refund available-funds protection, protected global reserves and post-transfer
creator/commission recovery remain unfinished integration work before activation,
along with the other collection, worker, settlement and bank-payout workstream
requirements. Full historical schema, CI/build, browser/provider, authorized
sandbox and separately approved Production/LIVE acceptance remain outstanding.

### Protected cash reservation core — October 22 continuation

Local candidate `20261023024119_sales_team_cash_reservations.sql` adds an
immutable cash reservation before a fresh team-refund provider operation. The
server independently reads the platform's available USD card balance twice,
retains real request IDs and refuses changed, ambiguous or mode-mismatched
balances. Pending and instant balances do not fund a refund. Negative amounts
in another USD source cannot be hidden by selecting only its card component.

A global database lock serializes reservations across creators. Funding protects
all unpaid creator proceeds and commission, taxes, processing/payout reserves,
an explicitly saved global reserve, an explicitly saved refund-cost reserve,
and every unresolved outgoing reservation. A newer known cash shortage cannot
be bypassed with an earlier high balance. Source context, current administrator,
fresh receipt inspection, cash observation, policy revision and the exact
shared-liability adapter digest remain required at admission. No reserve or fee
amount is supplied by default. This first core requires additional free funds
above outstanding shares; allocating a pending refund's own retained shares is
not yet implemented and this is not a completed commercial reserve policy.

Unknown or pending provider outcomes retain the original cash encumbrance
indefinitely. Elapsed time does not release it. Only audited cancellation before
any provider journal exists, or independently reconciled terminal refund proof
with the actual available debit/return entries, releases a reservation. Release
invalidates older balance observations. Recovery remains possible with new-money
controls disabled and retains the original operation/key. An installed-schema
marker permits resolution without requiring cash controls on historical schema
recovery. Transfer, reversal and surplus dispatch remain denied until their own
funding contracts are completed; existing original reconciliation is preserved.

At the committed core checkpoint, the required shared-platform adapter raised
`SHARED_PLATFORM_CASH_COVERAGE_REQUIRED`. Its digest must be pinned by an explicit
reviewed policy, and pinning the refusing implementation does not enable it.
The core tests substitute a clearly synthetic adapter. **Legacy/shared cash
coverage, common legacy outflow admission, use of retained refund shares and
post-transfer same-creator recovery were unfinished at that checkpoint.** The
following continuation adds local coverage and retained funding. Do not call this core
a complete funding implementation or activate it. Source flags
`CREATOR_TEAM_CASH_SCHEMA_READY` and `CREATOR_TEAM_CASH_FUNDING_READY`, plus database
control `cash_reservations_enabled`, default off. Fresh refund readiness requires
the new source gates; original refund recovery retains its earlier discovery
boundary.

Latest local evidence covers 45 distinct cases in three suites: refund SQL/runtime35,
cash readback7 and refund gates3. The final database receipt is
`work/cash-core-final-database.json` (35 pass); the unchanged cash7/gates3 passed
in `cash-core-verified.json`, whose aggregate is FAIL because its isolated
coverage-refusal fixture initially omitted the existing collection execution
gates. That setup was corrected for the final database run. The earlier
`cash-core-initial.json` passed42 before three additional cases. Full TypeScript
passed after a test-only unknown-value typing fix; scoped lint passed with no
errors or warnings. Coverage includes live candidate installation, a late-grant
rollback, retained unknown reservations, once-only original debit resolution,
invalidated old cash reads, missing/changed coverage and immutable private
history. These are PGlite/mock checks, not real provider, hosted contention,
commercial reserve approval, CI/build, browser, sandbox or bank-payout proof.

Read-only October 21 catalog queries inspected the actual Production booking router, columns, constraints, policies and grants. The installed router uses `booking_targets` and increments uses without a booking assignment; it does not establish signed-in closer identity. The hosted service role lacks `SELECT` on `auth.users`; the local test fixture now matches that restriction.

### Shared cash reconciliation and retained refund funding — October 22 continuation

Local candidates `20261023030002_sales_team_shared_cash_coverage.sql` and
`20261023034510_sales_team_shared_cash_reconciliation.sql` capture actual legacy
refund and tip-restoration obligations, fence the existing outgoing legs and
independently resolve already-bound originals. Terminal business status alone
does not release cash. Default-off reconciliation requires an explicitly reviewed
source digest. Checks retain the real administrator or current reconciliation
worker identity. Source changes, unfinished workflows, missing originals,
unowned/duplicate balance references, stale evidence and changed known provider
IDs retain the hold. Completed checks replay without another provider GET.
Cash resolution is once-only and invalidates older cash observations. It changes
neither legacy earnings nor Library entitlements. `sharedCashChecks.ts` accepts
supplied composition and has no global credential/client factory; no automatic
dispatcher is activated by its existence.

Candidate `20261023042321_sales_team_retained_refund_funding.sql` adds default-off
`retained_refund_funding_enabled` and an explicitly reviewed retained-contract
digest. A refund's immutable cash reservation can offset duplicate encumbrance
with only its own still-unpaid creator and commission shares. The offset is
capped by the same sale's projected unpaid-liability reduction, including
cumulative rounding over existing later installments and a conservative upper
bound on still-uncredited actual costs. It does not invent provider fees,
reserves or commission terms. Tax, payout/processing reserves, other creators'
balances and prior unknown outgoing commitments remain protected. No second
retained reservation may consume the same sale's shares while the first remains
unresolved. Creator, sale, closer membership and exact context must agree.

The reservation stores immutable beneficiary floors. As independently reconciled
earnings fall, the duplicate offset shrinks so the original outgoing principal
remains encumbered until actual terminal cash proof resolves it. Already released
shares cannot fund this offset. A changed retained-contract digest removes its
offset conservatively; the shared cash digest also names the retained helpers.
Turning off retained funding stops fresh dispatch from retained reservations
while bound-original recovery remains available through its existing journal.
This does not implement post-transfer clawback or same-creator recovery.

Local evidence is in the continuation chat at
`C:\Users\sandy\Documents\Codex\2026-10-22\goal-use-the-given-handoff-to-4\work`.
The pre-pause shared integration passed76 in six suites; its current shared SQL
scope was refreshed in `retained-outcomes-expanded.json` (PASS51 across retained22
and shared29). The retained tests include the existing dispatcher and independent
financial reconciler, creator/platform responsibility, late refund failure,
lost-response original-event recovery with new-money gates off, one mocked POST,
uneven-installment projection comparisons, tax/reserve protection, source hashes,
service grants and transaction rollback. Later-installment projection fixtures
are structural and do not prove actual later collection. The final retained/core
integration is `retained-funding-final-integrated.json`. Full incremental
TypeScript and scoped lint passed for the current added TypeScript source.

These are PGlite/mock checks on actual candidates plus selected legacy functions
and structural parent tables. Full historical/hosted schema compatibility, actual
provider capabilities/commercial reserve readiness, browser acceptance, complete
current CI/build, separately authorized sandbox acceptance and distinct
Production/LIVE/bank-payout proof remain outstanding. No hosted candidate,
scheduler, external transaction or release was activated by this continuation.

### Bounded automatic original inspection — October 22 continuation

Local candidate `20261023060912_sales_team_automatic_recovery.sql` and
`/api/sales-team/recovery` implement an authenticated inspection seam. The source
flags `CREATOR_TEAM_AUTOMATIC_RECOVERY_SCHEMA_READY` and
`CREATOR_TEAM_AUTOMATIC_RECOVERY_READY`, database control
`automatic_recovery_enabled`, and an explicitly reviewed recovery-contract digest
are independently required. They default off and do not require new-money gates.
No cron entry is registered by this change.

The existing scheduling authenticator refuses missing/short secrets and compares
the complete Bearer authorization securely before client composition. A durable
15-minute slot and 90-second worker lease fence duplicate/overlapping runs. Each
run admits at most three tasks and forty object GETs within a 45-second object
observation budget; context observations retain their own existing timeouts.
Provider writes and network retries are refused. Already admitted GETs drain
before a task result is recorded. Expired/changed context, source hash or worker
authority retains existing holds. Immutable task/run results retain the actual
observer and only bounded codes; raw errors, contact email and provider/customer
descriptions are not copied into task evidence.

The queue handles stale financial checks, durable signed-event handoffs, terminal
shared outflows and bound recipient capability refresh. A stale check's original
initiator remains immutable; a current independent worker proof can atomically
complete it with explicit recovery links and observer columns. A deferred result
link prevents removing a hold without its completed independent proof. Recent
checks remain with their existing reader. Failed proofs roll back all recovery
links/results. Normal admin inspection retains its existing authority/validation.
Unknown shared originals remain held without metadata adoption or a provider POST.
Recipient refresh checks the saved original twice, preserves its account identity
and invalidates cached readiness after failed current verification.

When fulfillment is explicitly ready, the queue also resumes missing Library
delivery from an already verified receipt using the existing idempotent shared
purchase/order contract. Event reconciliation followed by a delivery error is
recorded as requiring review and can resume through this separate delivery task.
Success results require their actual completed domain proof. Review alerts are
deduplicated in the existing private financial-alert table and resolve only after
successful proof; no outbound notification is sent by this implementation.

Latest local receipt `automatic-recovery-delivery.json` passed33 in three suites:
SQL/runtime20, bounded transport6 and endpoint authorization7. Current full
incremental TypeScript and scoped lint passed. Earlier alias, SQL CASE parsing and
test-fixture typing failures remain in their receipts and are superseded only by
the specific passing follow-ups. These fixtures install actual candidates on the
same structural legacy fixture; they do not establish a hosted scheduler run,
full historical schema compatibility, actual provider operation or LIVE proof.

Automatic unknown team-refund journal recovery and no-outbound terminal shared
release still need their own complete provenance paths. Later collection/lifecycle,
same-creator post-transfer recovery, settlement, surplus and confirmed bank payout
also remain unfinished. This inspection seam must not be treated as that complete
financial dispatcher or as authority to activate a scheduler.

Do not repeat the release-controls migration: its reviewed source filename is `20261021010052_controlled_website_releases.sql`, but the existing hosted applied-once receipt is version `20261021020911`. Reconcile that receipt before any proposed migration installation; a filename mismatch is not permission to replay it. Do not repeat old payment operations, consumed provider tests or preserved checkout tests just to reconstruct context. Do not use this branch's code as authority for hosted financial, account, scheduler, migration, deployment or Production/LIVE changes.

### Worker recovery of admitted refund originals — October 23 continuation

The existing F21 candidate `20261023063905_sales_team_worker_refund_recovery.sql`
has now been installed and verified locally. `workerRefunds.ts` supplies actual
run/token/task authority to the existing original-event/key refund recovery.
The public administrator path retains fresh-dispatch authority. The worker path
can only inspect an admitted original or finish an already audited unsent
cancellation; it cannot create a refund or invent a cancellation. It shares
F20's bounded GET-only transport and drain-before-audit behavior.

The sixth task kind is independently default off. Source gates
`CREATOR_TEAM_AUTOMATIC_REFUND_RECOVERY_SCHEMA_READY` and
`CREATOR_TEAM_AUTOMATIC_REFUND_RECOVERY_READY`, plus database control
`automatic_refund_recovery_enabled`, are required in addition to F20 readiness.
The optional fifth queue argument is omitted when refund recovery is disabled,
preserving compatibility with the installed F20 four-argument queue. No scheduler
is registered or activated. New-money-off does not prevent original recovery.

Each phase checks the current context, run, token, lease, exact unfinished task,
admitted journal and reviewed source digest. Live original dispatch leases are
excluded. Financial checks must belong to that exact task, request, receipt and
worker. Direct financial completion also rejects a finished task. Immutable
sidecars retain the actual worker observer separately from original human
approval, even after the approver loses admin access. Original approved cost
responsibility/reason, provider POST bytes, IDs and keys remain unchanged.
Metadata alone cannot establish refund ownership. Terminal success includes the
cash-reservation state, so a reconciled receipt with unavailable cash evidence
still reports held. Failed independent checks roll back stale-check links/results.

Evidence root:
`C:\Users\sandy\Documents\Codex\2026-10-23\goal-use-the-given-handoff-to\work`.
`worker-refund-integrated-initial.json` passed111 across worker refunds19,
automatic recovery20, transport/gates7, endpoint8, admin refund database35 and
retained funding22. After the final completed-task guard,
`worker-refund-authority-final.json` passed the affected19 again. These overlap;
they are not130 distinct tests. Current full incremental TypeScript passed.
Scoped lint passed with zero errors/warnings. Earlier failed receipts are
retained: the first runtime fixture omitted required fulfillment readiness;
the next exposed identifier validation of an unrelated extra fixture field.
The fixture and explicit named identifier validation were corrected without
weakening payment admission or financial proof checks.

All provider transport is mocked and SQL uses PGlite on the existing structural
parent fixtures. This closes the local F21 implementation gap only. No-outbound
terminal shared release, same-creator post-transfer recovery, later collections
and lifecycle, settlement, protected surplus and confirmed bank payouts remain.
Full historical/installed-schema security compatibility, current complete
CI/build/browser checks, actual commercial/provider prerequisites, separately
authorized hosted sandbox acceptance and distinct Production/LIVE/bank evidence
also remain required. No external financial, account, migration, deployment,
environment, scheduler or activation operation occurred in this continuation.

### Guarded sources with no outbound operation — October 23 continuation

Local candidate `20261023174324_sales_team_no_outbound_shared_recovery.sql`
records immutable birth provenance only for sources created while the installed
outgoing cash guards are required and their coverage triggers are active. It
does not backfill older sources. A terminal status, elapsed time, metadata or an
empty provider search cannot create that provenance. An existing admission,
claim, uncertain restoration attempt or known outgoing provider identity excludes
the source from this no-outbound path; existing original-outflow recovery remains.

The independently default-off source flags are
`CREATOR_TEAM_SHARED_UNSENT_RECOVERY_SCHEMA_READY` and
`CREATOR_TEAM_SHARED_UNSENT_RECOVERY_READY`. Database control
`shared_no_outbound_recovery_enabled` and an explicitly reviewed
`no_outbound_contract_sha256` are separately required. Neither gate enables new
money, a scheduler or a provider POST. The bounded worker tries this path only
when explicitly ready, otherwise preserving the existing F18 reader.

A current exact run/token/task/context and matching guarded source digest bind
each immutable check/result/resolution. Legacy sources must be failed and never
claimed, without either outgoing leg/admission. Tip sources must have no admitted
or uncertain restoration and a current lost/prevented/closed-warning condition,
independently read from the original charge and dispute twice. A won dispute with
an originally frozen zero reversal also requires two reads of its fully reversed
original transfer with exact charge/destination linkage. A won dispute with a
positive frozen reversal still requires the actual restoration original.

The liability reader subtracts only that source's current proven commitment and
its configured cost reserve. Changed source/context/contract, a later claim or
admission, new provider identity or later dispute win restores protection. The
source revision invalidates older cash reads, and a later winning restoration
requires a fresh protected-cash admission. Other creators, taxes, team balances
and unrelated commitments remain protected. Resolution invalidates the cash
epoch once. Completed checks replay without GETs; resolved sources leave the
queue. The existing known-outflow resolution and legacy accounting are retained.

Evidence in the same October 23 continuation workspace:
`shared-unsent-integrated-initial.json` passed111 across six suites: no-outbound25,
worker refunds19, retained funding22, shared reconciliation29, endpoint9 and
transport/gates7. F18/F19/F21 fixtures install the complete local chain through
F22 for that integration. After adding the zero-restoration case,
`shared-unsent-zero-restoration.json` passed the affected29; it supersedes the25
and overlaps that integration. Current TypeScript and scoped lint passed, with
their final receipts retained. Failed intermediate receipts remain: a missing
SQL quote was repaired; the synthetic fixture lacked required cash-policy
evidence; and a correct SQL rejection needed a fixture savepoint to avoid an
aborted outer PGlite transaction. No runtime proof guard was removed.

This closes the bounded local path for eligible sources with verified absence
of outgoing admission. Historical or uncertain originals remain held, requiring
their original proof. It does not establish full historical/installed-schema
compatibility or real provider behavior. Same-creator post-transfer recovery,
later collection/lifecycle, settlement, protected surplus and actual bank payout
remain unfinished, followed by the existing commercial, CI/build/browser,
separately authorized sandbox and Production/LIVE acceptance gates.

### Earned-share transfer reservation foundation — October 23 continuation

Local candidate `20261023180144_sales_team_transfer_reservations.sql` freezes
the accepted creator or closer's currently unpaid earned share as an immutable
original transfer request. It binds the original charge, accepted destination,
original intent's transfer group, exact amount, context, worker provenance,
operation ID and idempotency identity. It does not install a transfer dispatcher,
verified accounting completion, scheduler or bank payout implementation.

Independent source gates `CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY` and
`CREATOR_TEAM_TRANSFER_RESERVATIONS_READY`, existing settlement/cash readiness,
and database `transfer_reservations_enabled` are required. Database admission
also requires an explicitly reviewed `transfer_contract_sha256` and explicit
`transfer_cost_reserve_cents`; neither has an operational default. One settlement
worker can claim each 15-minute slot with a 90-second lease, current context,
token and matching named contract digest. Each run admits at most three tasks.

Admission requires an independent current complete financial check, actual
availability, no unresolved refund or financial/dispute hold, current recipient
ownership/transfers/payout readiness, and no unrecovered applicable overpayment.
Closer commission also requires its exact accepted 14–90 day hold to expire.
Removed membership does not erase an accepted closer's earned obligations.
Re-observation under a later actual worker preserves the original worker, POST,
request ID and operation identity while recording the current worker separately.

Two independent provider balance GETs and current protected liquidity precede
reservation. Unpaid principal remains a protected liability. If its current
unpaid share decreases, extra encumbrance preserves the original pending
principal; the explicit transfer cost reserve is always additional. Retained
refund funding cannot reuse a share promised to a pending transfer, and a pending
retained refund blocks a competing transfer. Other creators, taxes, reserves and
shared commitments remain protected. An audited unsent cancellation requires
complete absence of a provider journal and invalidates old cash reads. Any
admitted/uncertain original remains protected. Completion rows are immutable and
service callers have SELECT only, preventing fabricated accounting completion.
Existing bound-original journal recovery remains available with new-money gates
off. Reversal and withdrawal admission remain fenced.

Evidence in the same continuation workspace: `transfer-reservations-integrated.json`
passed130 across five suites (reservation31, retained funding22, worker refunds19,
shared unsent29 and shared reconciliation29), 49.277s, exit0. Those fixtures install
the complete candidate chain through F23. After adding named liquidity-proof
digest coverage and final-grant rollback, `transfer-reservations-final.json`
passed the affected33; it overlaps the prior130. Full incremental TypeScript and
seven-file scoped lint passed, zero lint errors/warnings. Earlier failed receipts
remain: a PL/pgSQL local variable was disambiguated, a negative fixture tried to
violate an existing NOT NULL constraint, and a positive expectation named the
wrong fixture recipient. No financial proof requirement was weakened.

All provider transport is mocked; actual candidate SQL runs on structural PGlite
parents. The positive matured-commission check uses an explicitly synthetic
historical timestamp fixture and does not establish historical capture/provider
acceptance. These checks do not establish full historical/installed-schema
compatibility, current complete CI/build/browser acceptance, hosted operation,
actual provider eligibility, LIVE execution or bank payment. A read-only connected
account inventory reported CreatorNet in test mode; this is not capability,
balance or financial acceptance evidence. No real financial POST, hosted migration,
deployment, push, merge, scheduler, environment or account mutation occurred.

### Original transfer readback foundation — October 23 continuation

`transferReadback.ts` independently observes an already admitted original. Its
composition contains only context observation and provider GET capability, with
no database authority. The expected context and saved original are frozen before
reads. It validates the actual journal's original worker, exact request, operation
ID, original dispatch time and idempotency identity. Bound originals require the
saved transfer ID and original provider request ID. Uncertain originals require
a complete bounded event list with exactly one `transfer.created` event carrying
that original idempotency key and request ID; metadata alone cannot establish
ownership. A live original dispatch lease cannot be stolen. No POST is retried.

Repeated current reads validate accepted destination, original charge/group,
amount, USD/card/test-or-live context, immutable metadata, destination payment,
absence of reversal, and the exact platform Payments balance debit. The debit
must be available, unreversed, currency-compatible and linked to that transfer;
actual principal, nonnegative supported fees and net impact must reconcile.
Distinct provider request IDs, fixed time/read limits and repeated context checks
are mandatory. Expanded IDs are normalized; descriptions and unrelated private
provider data are excluded. The reversal list's optional legacy total count is
checked when supplied; complete empty membership and zero reversed amount remain
required. Pending, reversed, foreign, changing or incomplete evidence remains held.

This closes only the local independent transfer readback implementation gap.
It does not bind the journal, dispatch a transfer, release accounting, write a
completion, activate a job or establish bank payment. A future consumer must
revalidate the current worker/task/source, original reserved fee allowance and
atomic once-only accounting before using any proof.

`transfer-readback-integrated.json` passed85 across readback52 and actual F23
reservation33,16.301s, exit0. After freezing the expected context and adding fee/
SDK-list guards, `transfer-readback-final.json` passed58; this overlaps the prior85.
Full incremental TypeScript and three-file scoped lint passed. Earlier failures
remain: provider JSON prototypes differed across execution realms, the SDK does
not require a reversal list total_count, and fixture response headers/status were
missing from its declared shape. Canonical immutable JSON comparison and correct
SDK shapes resolved these without weakening original identity or balance proof.
All transport remains mocked. No hosted/provider financial operation occurred.

### Verified original transfer accounting — October 23 continuation

Local candidate `20261023182527_sales_team_transfer_observations.sql` and
`transferObservations.ts` consume readback for an already admitted original.
Database `transfer_observations_enabled` defaults off. Independent source gates
`CREATOR_TEAM_TRANSFER_OBSERVATIONS_SCHEMA_READY` and
`CREATOR_TEAM_TRANSFER_OBSERVATIONS_READY` require cash/reservation schema
readiness but do not require new-transfer or new-buyer admission to stay on.
An observation-only worker can claim a bounded settlement slot for an admitted
original with those new-money controls off. This does not dispatch a transfer or
install a scheduler.

Each begin/completion checks the actual current run/token/context/task, named
reviewed contract, saved original request/journal and exact receipt revision.
Current observer history remains separate from the immutable original worker.
The narrow completion definer validates exact sanitized transfer/debit/fee
shapes and current repeated-read proof. Unknown binding requires the actual
original event request key and request ID. The old binding alias is unavailable
to service callers. Live dispatch leases cannot be stolen. Stale, foreign,
fractional, NULL/missing or extra private fields cannot consume a reservation.
Service callers retain SELECT only on completion, recovery and actual-cost facts;
ordinary roles cannot invoke the definers or read private observation history.

Completion atomically records the original transfer, independently linked actual
fee, released principal and immutable ledger entry, recomputes creator earnings,
syncs shared accounting and invalidates cash observations. Replays do not repeat
GETs or accounting. A late failure rolls back binding, recovery proof, completion,
cost and principal together. Actual costs reduce only the accepted creator's
proceeds; closer commission remains its accepted collected-subtotal share. The
original charge-processing fee and CreatorNet12% remain separate. A creator
overpayment/deficit stays visible and blocks applicable future transfer admission
until same-creator recovery is implemented and independently proven.

Actual transfer costs are also conserved in shared order/fee-ledger accounting,
whether fulfillment occurs before or after the transfer is observed. The guarded
split-constraint edit adds only the new team cost term and retains the existing
legacy branch. Legacy rows must retain zero team transfer cost. Unknown reviewed
arithmetic or a late grant failure aborts the entire migration. A cost above its
original explicit allowance is recorded as the actual fact, opens a dedicated
alert, and holds further new transfers pending review. It is not erased to make
the estimate agree with the provider.

The statement exposes actual transfer costs in creator accounting and retains
`bankPayoutStatus=not_recorded`. This is Stripe transfer accounting only. Actual
dispatch, same-creator post-transfer recovery, later lifecycle/scheduling,
protected surplus, bank observation/alerts and final presentation still remain,
alongside full historical-schema/security, current CI/build/browser, commercial,
separately authorized sandbox and distinct Production/LIVE acceptance.

F25 evidence: `transfer-observations-final.json` passed161 across six suites:
observations29, reservations33, retained funding22, worker refunds19, shared
unsent29 and shared reconciliation29. All install the complete candidate chain
through F25. Full incremental TypeScript and nine-file scoped lint passed with
zero errors/warnings; source/staged whitespace checks passed. Earlier receipts
remain: the expanded suite passed23/24 with no shared fulfillment row; the first
full integration passed155/156 and exposed the missing transfer-cost term in the
shared conservation equation. The corrected27-test scope passed before the final
migration rollback checks. These executions overlap and must not be summed.
No safeguard was removed: the equation and initial fulfillment write now both
include the explicit actual cost while retaining legacy checks. All transport
is mocked and SQL parents remain structural PGlite fixtures; matured commission
uses a synthetic historical timestamp fixture. These are local receipts only.

### Bounded original transfer dispatcher — October 23 continuation

Local candidate `20261023184139_sales_team_transfer_execution.sql` adds a
separate default-off `transfer_execution_enabled` control. Source gate
`teamTransferExecutionReady` requires the existing reservation and observation
readiness plus `CREATOR_TEAM_TRANSFER_EXECUTION_SCHEMA_READY` and
`CREATOR_TEAM_TRANSFER_EXECUTION_READY`. Reserving an earned share does not
authorize a provider write. No endpoint or scheduler is activated here.

`dispatchTeamEarnedTransfer` takes a supplied composition and exact current
run/token/task/request/check identifiers. Its default is observation only. New
dispatch requires explicit caller admission, current accepted context evidence,
fresh protected-cash re-observation, exact worker/task authorization, independent
database execution/observation controls and the reviewed named contract. The
existing provider journal still owns original scope, request, idempotency key and
provider dispatch lease. A private admission records the actual dispatching worker
separately from the immutable original-worker scope. Service callers cannot
directly insert admission/actions; ordinary roles cannot invoke the definer.

The transport allows at most one exact frozen POST and20 object GETs. New object
requests share a65-second budget, with a45-second new-POST admission cutoff,
pinned API version, zero retries and a10-second POST timeout. Context observers
retain their own independent bounds. New dispatch rechecks execution and fresh
cash before the wire call. Outcome-only audit/binding can drain after worker
expiry using its original asserted provider lease and run token; it cannot issue
another POST. An expired provider lease requires independent original recovery.

A direct response can bind the exact transfer identity before its balance debit
is available. It cannot release accounting. F24/F25 repeated available debit and
fee proof remains mandatory. Bound or unknown originals bypass the new-create
path with new-money-off. Unknown writes use the original event/key consumer;
metadata alone never creates a replacement transfer. Completed replay needs no
provider GET. The read model carries current accounting holds, including creator
overpayment and reserve-overrun review, separately from completion of the original
transfer. Bank payout remains unrecorded.

This closes one supplied transfer task's local dispatch path only. Autonomous
queue selection,15-minute scheduling, same-creator post-transfer recovery,
later collection/lifecycle, daily protected surplus, real bank evidence/alerts
and final presentation remain. The full schema/security, CI/build/browser,
commercial, separately authorized sandbox and distinct Production/LIVE gates
still apply. All exercised provider writes in the local fixtures are mocked.

F26 evidence: `transfer-execution-integrated.json` passed241 across eight suites,
135.906s, exit0: execution22, observation29, reservation33, retained22, worker
refund19, shared unsent29, shared reconciliation29 and readback58. The seven SQL
suites install the complete chain through F26; reservation/observation fixtures
now use the actual execution authority when simulating admitted journal originals.
After the immutable declaration lint repair and explicit deferred-FK immediacy
assertion, `transfer-execution-final.json` passed the affected22 again. These
overlap. Full incremental TypeScript and12-file scoped lint passed with zero
errors/warnings. Source/staged whitespace checks passed.

Failed receipts remain. The expanded72/73 run exposed the structural test's outer
transaction remaining aborted after the runtime correctly handled an expired
worker's observer RPC rejection. The fixture now gives each RPC its own savepoint,
matching PostgREST's per-RPC rollback boundary; runtime authority checks stayed
unchanged. A single prefer-const lint error was repaired. The final suite verifies
the original admitted response can bind after worker expiry, pending balance
evidence cannot release accounting, and later original observation with new-money
off issues no replacement POST. Migration failure restores the prior admission
function and leaves no partial execution tables. These are local structural and
mock-provider receipts, not hosted, real provider, CI/build/browser or bank proof.

## F27 — bounded automatic settlement (2026-10-24)

The existing `20261023190044_sales_team_automatic_settlement.sql` candidate now
supplies durable automatic runs, selected plans, financial links, recipient
observations and outcome history. All five sidecars are immutable, have RLS,
deny ordinary-role access and permit service SELECT without direct fact writes.
Named reviewed function definitions and fixed search paths cover the new entry
points and the guarded F13/F23/F26 adaptations. The old reservation alias cannot
be invoked by service callers. A frozen observation-only automatic run cannot
escalate to new transfer authority through selection, reservation or admission.

`runTeamAutomaticSettlement` composes the existing independent financial,
recipient, cash, reservation, dispatch and transfer-accounting contracts. It
permits three durable plans per 15-minute slot and one receipt per run. Two
original-recovery slots take priority before an earned-share lane; least-recent
attempts rotate within lanes. A saved 90-second lease and exact token, context,
plan/check/task identities control active phases. Outcome-only drain preserves
the original audit after expiry without new provider authority. Incomplete or
held selected plans cannot make a run successful; private alerts deduplicate by
receipt and beneficiary.

Current financial proof and saved-recipient readiness are refreshed when stale.
The shared transport allows at most 40 object GETs and three exact transfer POSTs,
with a 65-second new-request budget, a 45-second POST cutoff, 10-second POST
timeout and zero network retries. Expensive refresh and later selection have
earlier read/time cutoffs. Admitted promises drain before plan/run audit. The
authenticated `/api/sales-team/settlement` endpoint checks the existing timing-safe
cron authorization before readiness or composition and returns private/no-store,
sanitized summaries. Its default-off observation gate is independent of new
transfer execution. The 15-minute cadence is prepared only: no scheduler or
feature was activated.

Two measured gaps were repaired. A never-journaled reservation whose derived
unpaid share shrinks can now be selected even at zero and canceled through F23's
complete-journal-absence contract. Its immutable original remains; cancellation
has its own outcome/count and cannot be called a settled transfer. Any journal
appearing before cancellation keeps the original recovery path and protection.
Also, F10 saves a conservative hold at independent verification time, whereas
F23 required exact equality with the provider's payment second plus hold days.
That equality rejected legitimate matured commissions. The new named hold
validator retains the original saved hold, bounds it by accepted 14–90 day terms
and immutable original capture read-start/provenance times, and requires its
actual maturity. It does not reset or shorten the hold.

The compatibility receipt `f27-through-chain-first.json` passed 219 tests across
ten suites in 117.903 seconds. All seven affected SQL suites install through F27:
reservation 33, observation 29, execution 22, retained funding 22, worker refund
19, shared unsent 29 and shared reconciliation 29; automatic settlement had 24,
endpoint 8 and limits 4. Later focused additions cover a separately reviewed,
independently reconciled refund before unsent cancellation, a late financial
completion rollback and rejection of shortened/extended capture-based holds.
Their final receipt and typing/lint outcomes are recorded in the continuation
checkpoint; do not infer their pass from this earlier integrated receipt.

Final `f27-integrated-final.json` passed 223 tests across the same ten suites in
122.702 seconds, exit 0: automatic settlement is now 28 cases; the other nine
counts above are unchanged. The final added case also ensures a low refresh
budget can select cheap shrinking-reservation cleanup without selecting an
unchanged stale reservation for expensive refresh. The separate 27-case refund/
rollback receipt overlaps this result. Full current-tree incremental TypeScript
passed (`f27-final-current-typecheck.log`, exit 0). Fourteen-file scoped ESLint
and the final expanded-test lint both passed with zero errors or warnings.
The initial failures remain recorded: a synthetic immutable-check timestamp
edit was replaced by the disposable clock, aged closer tests exposed the real
hold-anchor mismatch, and the refund fixture was corrected to inspect the refund
before responsibility review. Runtime receipt/review proof was preserved.

A disposable in-memory database clock now allows coherent maturation and
abandoned-check tests while preserving immutable receipt/check history and real
migration bytes. Its clock functions are installed before fixture schemas and
never affect a host, hosted database or provider clock. Reservation and observation
fixtures reuse it instead of rewriting payment/hold timestamps. Other temporal
selection fixtures remain explicitly structural and are never dispatched.
F20 recovers an abandoned F27 financial check using its own new proof. Late
source/grant failures roll the migration back, including wrappers and privileges.

All exercised provider transport is mocked and the parents remain structural
PGlite fixtures. Full installed/historical schema compatibility, current complete
CI/full-suite/build/browser gates, actual commercial/provider prerequisites,
separately authorized hosted sandbox and distinct Production/LIVE acceptance
remain. Post-transfer recovery within the same creator relationship, later
collection/lifecycle, daily protected surplus, bank evidence/alerts and final
presentation are still separate unfinished outcomes. Transfer completion still
does not establish bank payout. No hosted migration, push, PR, deployment,
environment/provider mutation or activation occurred for F27.

## F28 — original transfer-reversal readback (2026-10-24)

`transferReversalReadback.ts` adds a supplied GET-only reader for an already-bound
original reversal of a completed team transfer. Its frozen projection validates
both original journals, deterministic operation identity/key, exact request bytes,
accepted creator/sale/receipt/beneficiary, original destination/charge/group and
context. It rejects unbound or unknown reversals before transport; metadata does
not select or adopt an original. It makes six bounded GETs, comparing the original
transfer, exact reversal and actual Payments-balance return twice with six distinct
request IDs, a 25-second observation budget, bounded request timeouts, pinned API
version and zero retries. Reversal chronology cannot precede its transfer.

Actual returned principal, fee details and net are retained, including a fee
larger than principal. No fee or reporting-category default is invented. The
source type must be `transfer_refund`, the balance movement must belong to the
exact reversal, and funds must be available. Actual reporting classification is
carried to the future consumer rather than used here to grant accounting credit.
The inline transfer reversal list is not treated as complete provenance; a known
original is retrieved directly. Expanded IDs are normalized and private provider
descriptions are omitted.

This is the independent reader only. It reserves nothing, issues no POST, binds
no original, reduces no debt, releases no accounting and establishes no bank
payout. A future narrow SQL consumer must enforce actual current worker/token/
task/source/context/revision authority, original balance ownership, cumulative
principal limits, actual creator-borne costs, shared accounting and atomic,
once-only outcomes. New reversal admission/dispatch and original unknown-event
recovery are still unfinished. Do not use this projection as proof of those gates.

`f28-readback-chronology-final.json` passed 121 tests in two suites, 2.151 seconds,
exit 0: 63 new reversal-reader cases and the existing 58 transfer-reader cases.
Full current-tree incremental TypeScript passed after the SDK fixture was given
its required response headers/status fields (`f28-readback-typecheck-final.log`,
exit 0); scoped final two-file lint passed without errors/warnings. Earlier
overlapping passes and the fixture-only typing failure are retained. Provider
transport is mocked. F28 has no migration, endpoint, scheduler or activation.

API shape was checked against Stripe's [reversal object](https://docs.stripe.com/api/transfer_reversals/object),
[creation contract](https://docs.stripe.com/api/transfer_reversals/create) and
[balance transaction types](https://docs.stripe.com/reports/balance-transaction-types).
Documentation reads are not real provider acceptance. Full current integrated
release gates and all remaining F27 checkpoint obligations still apply.

## F29 — account bound original reversal returns (2026-10-24)

The local `20261024210829_sales_team_transfer_reversal_observations.sql` candidate
adds independently default-off known-original observation and the supplied
`transferReversalObservations.ts` bridge. A dedicated immutable run marker binds
an actual settlement worker/token/context to observation-only authority, using
the existing 15-minute slot and 90-second lease. A run accepts at most three exact
durable check/task/operation identities. A completed replay reads current holds
without provider GETs. Outcome-only finish can drain after expiry, but unfinished
or held selected work cannot make the worker successful. No automatic selector,
endpoint, provider POST or scheduler is added.

The SQL source reader requires an already-bound original reversal journal and a
completed original transfer, exact request bytes/key/deterministic operation,
original worker provenance, original accepted creator/sale/receipt/beneficiary/
destination and approved context. New money being off or loss of the original
human's admin role does not substitute that person for the actual observing
worker. The new run cannot reserve a transfer or acquire another provider POST
kind through current or older aliases. F23 already denies generic reversal and
withdrawal admission; that denial remains. New reversal reservation/admission/
dispatch still needs a separate narrow implementation and explicit default-off
authority before any external activation.

The consumer revalidates exact current worker/check/task/context, reviewed named
source digest and receipt revision. It requires six distinct fresh GET request
IDs and the F28 normalized transfer/reversal/available-balance proof. The transfer
identity must match its immutable F25 completion; the reversal and actual balance
return must match the original bound journal, amount, metadata and chronology.
Every available return is capped cumulatively by the original transferred
principal and updates only that accepted creator or closer balance. A real return
never becomes a bank-payout statement.

Completion, returned principal, actual creator-borne fees, financial ledger,
shared accounting and cash epoch are atomic and once-only. Actual reversal fees
extend F25's existing cost reader, so recomputation and Library accounting retain
them without changing saved commission, the separate CreatorNet 12%, original
processing costs or the legacy accounting branch. Supported actual fees may
exceed returned principal; their negative net is retained. The explicit nullable
reversal-cost reserve has no commercial default. Missing or exceeded reserve
records the actual cost and holds further transfers for review. A known return
reduces debt only by its actual net effect; unrecovered debt remains held.

Unaccounted additional provider reversal principal is not credited. It opens a
deduplicated private hold that survives unrelated financial recomputation; new
transfer shares remain unavailable until actual original evidence resolves it.
The balance-owner check covers F25 transfer facts, F13 auxiliary entries, F18
shared entries and original charge balances on receipts. Symmetric triggers on
those exact owning tables use a per-balance transaction lock so a recorded return
cannot later be adopted by another owner. No broad catalog scan or historical
ownership backfill is used. The four new sidecars have RLS, immutable history,
service SELECT and no ordinary-role or direct service fact-write authority.

`f29-observer-ownership-repair.json` passed 50 SQL-backed cases, 61.807 seconds,
exit 0. The initial 12-case pass overlaps this. The expanded 41/43 receipt exposed
the missing receipt-level original-charge ownership check; the receipt check and
symmetric trigger were added. Its other failure was an empty auxiliary-entry
fixture, corrected to perform an actual attempted claim. The fixture creates a
structural already-admitted bound reversal journal, not new reversal admission
proof. Current full-tree incremental TypeScript and 11-file scoped lint passed
after correcting the intentionally invalid test payload's narrow TypeScript type.
Final compatibility and any later focused receipts are recorded in the current
continuation checkpoint; these earlier passes do not establish that result.

All provider transport is mocked and SQL parents remain structural PGlite
fixtures. Coherent closer maturity uses the disposable database clock. Actual
hosted schema/security, real provider contention/acceptance, complete current
CI/full-suite/build/browser, approved commercial prerequisites, distinct hosted
sandbox and Production/LIVE scope and confirmed bank acceptance remain open.
No migration was installed hosted and no external financial or release operation
was performed for F29.

Final authority review added three measured late-expiry regressions. All three
failed before repair: a check could be admitted, or transfer/reversal accounting
could complete, after a fixture trigger expired its actual worker authority.
F29 now rechecks authority after lock acquisition, after task admission and before
returning final accounting. A guarded F25 consumer update also rechecks after its
financial lock and before final completion, because the new owner trigger can
wait inside that consumer. The original journal and outcome-only dispatch-binding
contract are retained. `f29-late-authority-after.json` passes the three targeted
cases; it is not an unfiltered run of the two suites. The final integrated receipt
supersedes the earlier 394/395-case revisions for these changed consumers.

The owner guard and extended cost-reader definitions are covered by the explicit
transfer/shared/retained/recovery source-review lists. A source-tamper case checks
all four digests change and the admitted observer loses active authority. The
late-rollback fixture now waits until shared fee accounting changed before
raising its final cash-epoch failure. Indexes support cumulative principal,
receipt costs and bound original lookup. Final receipts and exact source hashes
are in the current checkpoint; none is full installed-schema or real-contention
acceptance.

F29 final authority revision: `f29-integrated-authority-final.json` passed 398
tests across 13 suites in 155.086 seconds, exit 0: reversal observation 53,
reversal reader 63, transfer reader 58, automatic settlement 28, endpoint 8,
limits 4, reservation 33, transfer observation 30, execution 22, retained 22,
worker refund 19, shared unsent 29 and shared reconciliation 29. All affected
existing SQL chains install through F29. Full current-tree incremental TypeScript
passed (`f29-authority-typecheck-final.log`, exit 0); final 11-file ESLint has zero
errors/warnings (`f29-authority-lint-final.json`). These supersede the narrower and
overlapping F29 passes above. Hosted/provider, complete CI/build/browser, actual
contention and bank acceptance remain unproved.

### F30: default-off original transfer recovery reservations

`20261024213841_sales_team_transfer_recovery_reservations.sql` adds the reservation
foundation for post-transfer recovery. It has its own default-off database gate
and two explicit runtime schema/readiness flags. The actual settlement worker
retains the existing 15-minute slot and 90-second lease. Its immutable claim
records whether new reservations are permitted; an observation-only run cannot
upgrade that authority. Existing F29 observation markers still refuse generic
provider admission and new transfers. This migration enables no provider POST,
scheduler or automatic execution.

The database derives recovery from current independently verified debt within the
same accepted creator, receipt and beneficiary, capped by the original completed
transfer's unreturned principal. Pending original reservations consume that
capacity. Accepted recipient IDs, request bytes, API version, deterministic
operation/key, original worker, amount and approved fee allowance are frozen.
There is no caller-selected amount or fee default. Other creator relationships
and a creator deficit beyond released principal do not supply recovery capacity.
Historical departure does not replace the accepted closer or original recipient.

`reserveTeamTransferRecovery` composes supplied dependencies and actual-worker
RPCs. A cold source uses the existing exact F27 financial validator, linked to
the admitted F30 task, without impersonating a human admin. Two bounded GETs
then re-read the completed original transfer. Only F29-accounted reversed
principal may already be present; an unexplained aggregate creates a durable
review hold, with no new reservation or debt credit. Repeated platform balance
GETs use the existing F23 proof and current shared protection/epoch. The saved
fee allowance is encumbered once; future returned principal never becomes cash
available for spending. Transfer/observation tasks share a three-task limit.

Immutable sidecars use RLS and service SELECT-only grants. Only the checked
definers write them. Active authority is rechecked after locks and at the end
of mutations; late expiry rolls back task/root/request/cancellation admission.
Fresh immutable root proof can serve a same-worker retry, but cannot outlive its
25-second window or receipt revision. A new run preserves a pending original's
identity, worker, amount, bytes and fee allowance. Complete journal absence and
fresh verified shrinking debt are required to cancel a never-dispatched original.
Any unknown, expired or bound journal prevents replacement/cancellation.

F29 independently accounts actual returned principal and creator-borne fees.
An F30 journal must match its saved request, amount, worker and transfer, and
must not be canceled, before F29 admits even an original observation check.
For an F30 original it compares cost to the saved allowance, including after a
policy edit, and only its once-only completion releases that reservation. The
extended encumbrance implementation and its saved predecessor are named in all
four relevant reviewed contract digests. Candidate dependency/late-grant failure
rolls back the whole migration. Unfinished reservations finish as review_required,
never a bank payout.

F30's structural already-bound journal fixtures exercise F29 consumption and
saved-cost behavior; they do not prove admission or dispatch of a new reversal.
The next required work is narrowly gated current-worker original reversal
admission/dispatch, followed by original unknown event/key recovery and bounded
autonomous integration. Fixed/monthly collection, full Stop/cancel/payoff and
lifecycle work, protected daily surplus, actual bank observations/alerts, final
UI, complete current CI/build/browser and installed historical/security
compatibility remain open, as do separately authorized hosted/provider and
Production/LIVE acceptance. No hosted installation or external operation ran.

F30 final integration (`f30-integrated-original-final.json`) passed456 tests in14
suites in169.77s, exit0, including46 new database cases and75 reversal-reader cases.
Nine existing main SQL chains and the new F30 chain install through this candidate.
The final original-link review first measured all3 mismatch regressions failing,
then passing with the exact frozen-request guard; those filtered receipts each
skip43 unrelated F30 cases. The full456-case pass supersedes the earlier453-case
revision. Current full-tree incremental TypeScript and scoped14-file ESLint pass;
the only subsequent test edit removes an unused erased type import. These local
checks do not replace the complete CI/full-suite fallback or external acceptance.

### F31: default-off original transfer recovery execution

`20261024215948_sales_team_transfer_recovery_execution.sql` and
`dispatchTeamTransferRecovery` admit one frozen F30 reversal through supplied
clients and an actual execution worker. The database control defaults false;
`CREATOR_TEAM_TRANSFER_RECOVERY_EXECUTION_SCHEMA_READY` and
`CREATOR_TEAM_TRANSFER_RECOVERY_EXECUTION_READY` are additional source gates.
The claim freezes execution permission on a new worker. Observation-only and
reservation-only workers cannot acquire dispatch permission later.

The dispatcher preserves the original request bytes, operation/key, API version,
accepted recipient, amount, creator, receipt and original reservation worker.
Cold financial proof uses F30's existing worker-linked validator. Independent
original-transfer and protected-cash reads precede claim; distinct fresh reads
after claim precede a single-use assertion. Current debt, receipt revision,
shared protection and cash epoch must still match. Future returned principal
never supplies dispatch cash. Only verified shrinking debt with complete journal
absence permits unsent cancellation.

The supplied dispatcher allows at most 40 GETs and one POST, with a 65-second
observation budget, 45-second POST cutoff, 10-second POST timeout, pinned API and
zero transport retries. Direct response and independent GET identities must
match, with distinct provider request IDs. Missing balance details can bind an
original identity but cannot release principal. F29's repeated available-return
proof owns atomic once-only principal/cost accounting and saved-fee release.
An overrun records actual creator cost against the original saved allowance and
retains a review hold, even if mutable policy later increases the allowance.

Seven immutable RLS sidecars retain runs, reads, roots, rechecks, admissions,
actions and consumed assertions. Service callers have SELECT only; checked
definers own writes. The private root clone reuses the installed F30 validator
with checked replacement counts and is not executable by service callers.
Each task allows two dispatch rechecks. Generic claim, assert, unknown and bind
bodies, including older aliases, enforce the exact admitted operation and sealed
outcomes. Authority is checked after locks and mutations; expiry rolls back
admission, journal and assertion writes. Named definitions extend all four
relevant reviewed contract digests; failed dependencies or late grants roll back
the migration completely.

Only bind/unknown outcome ports can drain an already asserted original after
worker expiry or context drift. They require the original run token, admission,
consumed assertion and a 90-second assertion age; ordinary binding also retains
its existing provider lease requirement. This grants no new provider request
or accounting authority. Bound originals remain observable with new-money gates
off. An unbound unknown/expired original remains protected without a replacement
or repeated POST. Independent original event/key recovery is the next required
implementation; this dispatcher does not yet recover that lost identity.

The Sales Team 8 continuation verified all 14 inherited dirty-file hashes against
the Sales Team 7 handoff before editing. Current full-tree incremental TypeScript
passed (`f31-current-typecheck.log`, exit 0), and scoped 13-file ESLint passed with
zero errors/warnings (`f31-current-lint.json`). Receipts are in the continuation
workspace's `work/` directory. The current integration
`f31-integrated-current.json` passed 507 tests across all 15 affected suites in
303.122 seconds, exit 0. All ten changed predecessor fixture chains install
through F31. The inherited 51-case lifecycle proof and earlier failures remain
preserved; the new integration establishes current affected compatibility.
Local CI selector safeguards passed 11 tests, sandbox safeguards passed 141,
and media-worker safeguards passed 20 (`f31-ci-selector.log`,
`f31-ci-sandbox.log`, `f31-ci-media-worker.log`). These checks do not establish
the complete CI/full-suite fallback or build/browser acceptance.
The staged whitespace gate caught trailing blank lines in the inherited new
test and SQL draft. Only those trailing newlines were normalized;
`f31-eof-normalization.json` records both hashes and identical emitted test
JavaScript. SQL before the trailing newlines is byte-identical. The 507-test
receipt therefore retains its executable scope without an unchanged rerun.

No F31 route, autonomous orchestration or scheduler is installed. Later
collection, full Stop/cancel/payoff/lifecycle, protected daily surplus, bank
observations/alerts, final UI, complete current CI/build/browser and actual
installed/historical/security compatibility remain required. Disposable PGlite
and mocked Stripe evidence is separate from hosted/provider sandbox and
Production/LIVE/confirmed-bank acceptance. No hosted migration, provider financial
operation, application setting, deployment or activation occurred.

### F32: original unknown reversal event readback

`recoverTeamUnknownTransferReversal` is a supplied GET-only proof reader. It
accepts an exact frozen unknown journal or an expired original dispatch lease;
an active dispatch lease, absent original, changed bytes/key/worker/context or
incomplete parent transfer cannot start provider reads. It changes no journal,
database control, accounting fact or bank status.

Discovery scans at most three pages of 100 `transfer.reversed` events. The scan
must finish and contain exactly one event with the original idempotency key and
original provider request ID. Platform account/context, mode, chronology and
event API version are checked. The exact selected event is then independently
retrieved with a distinct GET request ID and matching normalized event identity.
The saved request API remains pinned; the event's actual render version is
carried as evidence rather than replaced with that request version.

The event's complete inline reversal snapshot must identify one exact original
reversal. Duplicate IDs, inconsistent counts/aggregate, foreign transfer/amount/
currency/refund lineage and ambiguous or paginated snapshots remain held. A
matching metadata map alone never chooses an original. No fallback lists,
replacement operation or repeated POST are introduced for incomplete evidence.
Actual pinned-provider snapshot behavior remains an external acceptance gate.

Six independent GETs repeat the accepted transfer, exact reversal and available
Payments-balance return. The return identity must match the original event;
initially null event balance/refund details may become the verified actual IDs.
The immutable parent identity must match while a later larger reversed aggregate
is retained for the accounting consumer's existing review hold. Actual fees/net
are carried without commercial defaults or private descriptions.

Unknown discovery allows at most ten GETs and 45 seconds total. Its six-read
return proof retains its own 25-second window, checks before/after every GET,
and bounds each timeout by the time remaining in both windows. Provider retries
remain zero. Original POST and all observed GET request IDs are distinct.
The existing bound-original reader uses the same return validators and retains
its six-GET/25-second limit.

This foundation does not bind an unknown original or release its reservation.
The next required change is a current-worker checked database consumer that
records original event/key proof and binds/accounts atomically through F29,
followed by bounded autonomous integration. Remaining full-goal and external
acceptance gates described above still apply.

`f32-reader-integrated-current.json` passed 306 tests across four suites in
150.002 seconds, exit 0: reversal readback 144, original transfer readback 58,
reversal SQL consumer 53 and recovery execution 51. Current full-tree incremental
TypeScript passed (`f32-reader-typecheck-accepted.log`), and scoped two-file ESLint
has zero errors/warnings (`f32-reader-lint-accepted.json`). The earlier fixture
index-signature type errors were repaired with a type annotation. Two focused
timing regressions first measured extra GETs after expiry and an overlong timeout,
then passed in the final integration after both bounds were tightened. Earlier
190/104/305 and filtered receipts are preserved and overlap; they are not additional
distinct tests. All provider responses are mocked, and the SQL consumers use
disposable PGlite. This evidence does not establish the unfinished unknown
binding/accounting consumer, full CI/build/browser or external acceptance.

### F33: checked original reversal event recovery

Local candidate `20261025184802_sales_team_transfer_reversal_recovery.sql` and
`recoverTeamOriginalTransferReversal` consume the F32 proof under an actual current
F29 observation worker. The new `transfer_reversal_recovery_enabled` database
control defaults false. Source readiness requires the recovery schema/readiness
flags and predecessor schemas, including the F31 execution schema, while new-money
execution/reservation readiness can remain off. This creates no provider POST,
new reservation, recipient change, scheduler or activation.

An unknown original must retain its exact F30 request, scope, accepted parent,
creator, amount, API/key and original reservation worker. Its original F31 actual
admission and consumed dispatch assertion must still match the sealed provider
lease. Unasserted journals and live dispatch leases cannot be adopted. A later
observation-only worker uses its own current token while preserving that original
dispatch provenance. Departure or a changed mutable recipient does not replace
the accepted transfer.

The checked begin port admits an existing F29 check before provider reads. It
retains the combined F30/F29 three-task bound, receipt revision, original task
identity and current worker checks after locks/writes. The composition then uses
the GET-only F32 unknown reader, or the existing F29 reader for a bound original.
Missing/ambiguous event proof leaves the exact unknown operation and fee
encumbrance held. There is no replacement or repeated POST.

Completion checks original event/request/key, event/current identities, account,
mode, actual render version, chronology, distinct provider request IDs and both
freshness windows. One immutable RLS/service-SELECT-only sidecar retains the exact
recovery proof. A narrow exception in the actual generic binding body permits
only that current proof's reconciled original identity. Older aliases and
non-reconciled adoption remain fenced. Explicit named definitions extend the
four existing reviewed contract digests; dependency and grant changes are
transactional.

Binding, proof, F29 principal/cost accounting, shared synchronization and saved
fee release happen in one database transaction. A deferred reference from proof
to F29 completion prevents committing a recovery proof without accounting.
Failure or late authority loss rolls back the operation binding and all financial
facts. F29 retains actual creator-borne costs, the original saved fee allowance
after policy edits, balance ownership, unexplained-aggregate holds and once-only
ledger/cash-epoch behavior. Replay returns completed history without another
provider request. Bound-check delegation also rechecks the recovery control after
admission.

This local consumer still needs bounded autonomous queue/endpoint integration.
Full current CI/build/browser, installed/historical/security compatibility and
separately scoped provider/hosted/Production/confirmed-bank acceptance remain
required alongside the remaining collection, lifecycle, surplus and UI work.

`f33-integrated-current.json` passed 626 tests across all 15 affected suites in
518.797 seconds, exit 0. Eleven SQL fixture chains install through F33. The
execution/lifecycle suite now has 101 cases, including 50 added recovery cases;
the final four cover the combined task cap, pending-to-available retry under a
later worker, initially null event details and sealed generic aliases. Current
full-tree incremental TypeScript passed (`f33-current-typecheck.log`), and scoped
13-file ESLint has zero errors/warnings (`f33-current-lint.json`). All 14
executable/test/SQL input hashes were captured before the run and verified again
before the local checkpoint.

The initial 55-pass/6-failure run exposed ambiguous SQL JSON subtraction; explicit
grouping repaired it. A focused delegated-bound-check regression measured provider
reads after a recovery-control change; the post-admission recheck now rolls back
that check before reads. Its before-fix receipt has 1 failed/61 skipped; the later
11-pass/51-skipped run is focused proof only. The expanded 97-case pass and earlier
receipts remain preserved; the 626-case integration supersedes overlapping runs.
Provider transports are mocked, and SQL uses disposable structural PGlite parents
and selected real legacy definitions. These checks establish neither complete
CI/full-suite fallback/build/browser nor installed/provider/Production/bank proof.

### F34 — combined automatic transfer and recovery settlement (local candidate)

`20261025191826_sales_team_combined_settlement.sql` adds the independently
default-off `automatic_transfer_recovery_enabled` control. A newly claimed worker
freezes separate earned-transfer, new-recovery-reservation and recovery-dispatch
permissions in an immutable sidecar. It reuses F30 and F27 claims under the same
claim lock, 15-minute slot exclusion, reviewed contract and 90-second lease.
Existing F27, reservation-only and execution workers cannot upgrade their authority.
The candidate is not installed, scheduled or activated.

The combined selector reuses F27 plans with a `recovery` kind and an immutable
link to the accepted transfer and original reversal operation. It admits the
existing F30 task or F29/F33 original check before returning the plan. Derived
debt, accepted beneficiary, original worker, amount, request, idempotency key,
API version and saved cost allowance continue to come from F30/F31. Unknown or
bound originals can be observed with new-money gates off; no replacement POST
is introduced. Two original/recovery slots retain priority, while the third can
advance an earned share. Receipt uniqueness and least-recent recovery attempts
prevent repeated selection of the same receipt within a run.

One durable three-task count covers F27 plans, F23 transfer tasks, F30 recovery
tasks and F29 reversal checks. Matching admissions count once. Transfer checks
cannot borrow a recovery task identity, and recovery/check ports reject transfer
task identities and mismatched plan subjects. Exact selected earned plans retain
the narrow F29 observation-only exception needed by the mixed worker; generic
admission still validates the frozen F26 request and all original cash/source
checks. Disabling either automatic control blocks new selected recovery phases.
Already admitted original `unknown`/`bind` outcomes retain their drain path.

The checked finish records actual completion, cancellation or a persistent review
hold and audits unfinished recovery tasks/checks. An assertion of success cannot
replace independent accounting. New sidecars use RLS, immutable-history triggers
and service SELECT-only access; the old finish alias is revoked. Named combined
authority definitions and guarded existing ports extend all four reviewed
transfer/shared/retained/recovery digests. Late claim or selection expiry rolls
back the newly inserted markers, admissions and plans together. Dependency or
late-grant failure rolls back the whole migration.

`runTeamAutomaticSettlement` preserves the existing default behavior and adds an
explicit combined mode that composes F30 reservation, F31 dispatch and F33
observation. Both lanes share three plans, forty GETs, three POSTs, a 65-second
observation budget and 45-second POST cutoff, with admitted requests drained
before outcomes. Recovery GETs retain any shorter supplied timeout. Only the
active earned plan can POST a transfer, and only the active recovery plan with
separate admission can POST its original reversal. The existing authenticated,
private/no-store endpoint selects combined mode only after its new schema and
source readiness checks pass; dispatch readiness remains independent. It retains
`maxDuration=120` and registers no scheduler.

Full later fixed/monthly collection, Stop/cancel/payoff lifecycle, protected
daily surplus, actual bank observation/alerts and final UI remain incomplete.
Required current complete CI/full-suite fallback/build/browser, installed and
historical-schema/security compatibility, approved commercial/provider inputs,
separately scoped hosted/provider acceptance, distinct authorized Production/LIVE
activation and confirmed-bank evidence remain separate gates. A provider transfer,
reversal or available balance does not establish a bank payout.

`f34-integrated-current.json` passed all 666 tests across the 15 affected suites
in 434.122 seconds, exit 0. Eleven SQL fixture chains install through F34. The
automatic-settlement suite now has 55 cases, endpoint 10 and transport limits 15.
Full-tree incremental TypeScript passed (`f34-current-typecheck.log`); scoped
16-file ESLint has zero errors/warnings (`f34-current-lint.json`), and staged
whitespace passed. Nineteen executable/test/SQL input hashes were captured before
the integration run and verified unchanged afterward. The only subsequent edit
before checkpoint was documentation of these results.

The task-identity regression first measured admission of an unrelated transfer
check using a recovery plan's task ID. The current source rejects that cross-kind
reuse. Two automatic-control regressions first measured a reservation and POST
after disabling automatic recovery; current phase checks deny both before any
provider request. Expiry after the original POST preserves its binding and audits
review-required, while a later observation-only worker accounts the same return
without another POST. Failed runs, fixture corrections and focused receipts are
preserved; focused/skipped runs do not replace the final integration. Provider
transports remain mocked and databases remain disposable structural PGlite.

### F35 — explicit buyer-invoked later collection (local candidate)

The preserved `20261025195351_sales_team_later_collection.sql` candidate adds an
independent default-off `later_collection_enabled` control. Next-period admission
derives the amount from the immutable accepted fixed schedule or monthly
commitment/renewal terms. Calendar boundaries retain the original UTC day/time,
clamping the day only within a shorter month. The anchor is rebound to the first
verified receipt and its capture provenance; saved customer ownership is rebound
to the original bound customer operation. Contiguous paid capture history must
match runtime coverage. Runtime fields alone cannot create schedule authority.

Each new obligation receives one immutable 24-hour collection window with private
RLS and service SELECT-only access. Admission repeats the accepted amount, due
date, ownership, context and original capture anchor. Stop, cancellation, financial
holds, pending signed events/checks, unresolved receipt reviews/disputes or missing
shared fulfillment block later money. Existing receipt, fulfillment, event and
financial controls remain required. New-sale access and current closer membership
are deliberately unnecessary for accepted obligations. Late control loss rolls
back the new obligation and window together; dispatch assertions recheck actual
authority after the provider claim.

Explicit period intent/confirmation ports reuse the original manual token flow
and exact provider journal. First-period readers, confirmations, cancellation
selection and generic admission keep selecting period one when later attempts
coexist. A confirmation request cannot borrow a different period's identity.
Named authority extends all four reviewed financial contract digests. Dependency
or late-grant failure rolls back the entire migration, including old definitions
and grants. Original unknown/bound outcomes retain their read/bind drain after
expiry or new-money disable; an uncertain POST is never repeated.

The buyer API and payment screen expose the read-only owned overview and an
explicit action to prepare the next due period. Readiness remains separate from
first checkout and new-sale admission. Browser requests, persisted confirmation
identity, bank-action refreshes, Stop and independent capture retain the exact
later obligation. Verified captures reuse existing shared Library fulfillment,
fee accounting, cumulative commissions and saved holds. A canceled later payment
preserves the earlier paid purchase and displays remaining-balance review.

F35 is an on-session collection implementation. It does not implement automatic
off-session collection, renew an expired original window, replace an uncertain
intent, or complete monthly cancellation/payoff and method-recovery lifecycle.
These remain required, together with protected daily surplus, actual bank
observations/alerts and the final creator/closer presentation. No scheduler,
hosted installation, provider mutation, deployment or activation occurred.

Initial resume TypeScript and three-file ESLint passed. The first repaired
admission run passed 10 cases and exposed one deferred-trigger fault in the
unfulfilled-fixture setup; that setup was corrected. A 19-case lifecycle run then
passed, followed by 69 cases across later collection/API/UI. A focused 21-case
authority run passed, including actual dispatch rechecks, explicit originals,
named digests and transactional rollback. These runs overlap and retain skipped
cases; they are not a combined total or a substitute for integration. Current
full-tree TypeScript and 20-file ESLint pass. Selector 11, sandbox 141 and media 20
safeguards pass. The final F35 integration result is recorded at its checkpoint.

`f35-integrated-a.json` completed all 837 tests in 27 suites in 707.625 seconds:
836 passed and the original capture-hold assertion failed. The failure was the
test's `Date.parse(Date)` conversion losing milliseconds; the saved SQL hold was
not shortened. The test now preserves the Date value and also asserts the full
fourteen-day interval directly in SQL. Its current nine-case capture suite passed
in 12.275 seconds (`f35-capture-hold-a.json`). The other 26 suites/828 cases passed
against unchanged executable/SQL/test inputs from the integration snapshot.
Together these scoped receipts cover all 837 cases; this is not a single green
27-suite run or complete CI. The corrected capture test has separate clean lint
and current TypeScript evidence. No test, hold or financial safeguard was removed.

### F36 — renewal Stop and separately confirmed minimum payoff (local candidate)

The CLI-generated `20261026185425_sales_team_payment_lifecycle.sql` distinguishes
renewal Stop from debit revocation. A saved renewal Stop prevents collection
beyond the accepted monthly minimum while preserving still-due minimum payments.
It also survives first-payment initialization when recorded before any capture.
Debit revocation retains the existing immediate Stop fence. Private immutable exit
requests preserve the buyer, accepted agreement fingerprint and exact action.

The owned exit quote derives covered months, remaining minimum, exact one-time
amount and UTC paid-through/minimum boundaries from current verified capture
history. Pending original activity, events/checks, missing shared fulfillment,
refund/loss/dispute/review holds, expired service terms or amounts exceeding the
provider limit require review. A quote is read-only; neither card setup nor a
failed/abandoned payoff creates paid months. Financial debt and debit permission
remain separate under the accepted purchase policy.

A new payoff needs separate explicit buyer consent to the current quote
fingerprint and an independently enabled payoff control. Accepted terms, original
recipient/customer, context and the full original sale remain fixed. The payoff
has its own obligation, immutable acceptance and window, while conclusively
unpaid ordinary obligations are stopped without deleting their history. An
uncertain ordinary intent must be reconciled and independently canceled before
payoff acceptance. Ordinary periods remain unique; payoff identity does not
repurpose an original period's financial operation.

The payoff reuses the existing manual intent/token/confirmation/capture protocol
with `monthly_payoff` authority and no future-use setup. Its own Stop record
distinguishes cancellation of that explicit one-time payment from prior global
automatic-debit revocation. Dispatch rechecks its exact accepted payoff and
window; cancellation needs the payoff-specific Stop. Unknown/bound results retain
their original-only drain after expiry or collection disable.

A checked capture wrapper retains existing capture checks and seals its raw
predecessor alias. Full clean verified payoff records one immutable completion,
advances coverage to the exact accepted minimum, stops renewal, and syncs the
existing shared purchase. Actual captured money under financial review remains
accounted without granting extra minimum coverage. Shared receipt/fee/commission
and entitlement implementations remain authoritative; the original paid purchase
is preserved. All four reviewed digests bind the named lifecycle definitions.
New lifecycle records have RLS, immutable-history triggers and service SELECT-only
access. Migration failures restore old definitions, grants, aliases and ordinary
period uniqueness transactionally.

The buyer plan screen reads the quote, exposes distinct renewal/debit Stop
actions, requires a separate payoff checkbox and leaves payment details to the
existing confirmation screen. The owned same-origin API rejects caller-selected
amounts, months, dates and customer/actor identities. Original payoff viewing and
payment recovery remain distinct from fresh payoff admission. Ordinary later
readiness cannot authorize a saved payoff. React review covers stable hook order,
abort/unmount handling, renewed session identity, explicit consent, accessible
controls/statuses and type-only server imports.

Twelve initial focused cases passed after correcting the view's treatment of the
global Stop; another twelve authority/rollback cases passed. API/UI coverage
passed 54 cases across four suites before the added payoff-readiness regression.
These are overlapping focused receipts. The current integrated/static result is
recorded at the F36 checkpoint. The candidate remains uninstalled and default off.

Automatic off-session collection, saved method authority/recovery, renewal of
expired or safely canceled original collection/payoff attempts, protected daily
surplus, bank observations/alerts and final creator/closer views remain required.
No uncertain original is replaced or silently extended by this candidate. Full
installed/historical/security/contention and complete CI/build/browser acceptance,
actual approved provider/commercial prerequisites and separately authorized
external sandbox, Production/LIVE activation and confirmed BANK evidence remain
outstanding. No scheduler, external financial mutation or release occurred.

`f36-integrated-a.json` passed all 879 tests in 29 suites, no skips, in 697.768
seconds, exit 0. The later/lifecycle SQL suite has 77 cases and eleven existing
financial chains install through F36. Full-tree incremental TypeScript passed
(`f36-current-typecheck.log`), and 21-file ESLint has zero errors/warnings
(`f36-current-lint.json`). Selector 11, sandbox 141 and media 20 safeguards pass.
The executable/SQL/test input hashes captured before the run remained unchanged;
only this documentation followed. These are disposable structural PGlite/mocked
provider checks, not complete CI, installed/historical schema, real contention,
browser/provider or hosted acceptance.

### F37 — explicit manual retry after conclusive original closure (local candidate)

The CLI-generated `20261026193046_sales_team_expired_collection_retry.sql` adds
independently default-off manual retry authority. It never extends an original
window or changes an original request, operation, idempotency key or provider
identity. A new owned quote derives the exact accepted unpaid period, amount,
customer, capture anchor, coverage and context. The buyer must explicitly accept
its current fingerprint. Global automatic-debit Stop remains saved throughout.

A prior payment must be conclusively never journaled or independently canceled
and unpaid, with every original confirmation/cancellation journal reconciled.
Processing, captured or unknown activity blocks replacement. Frozen closure
proof retains the original attempt, terminal provider journal and observed state;
subsequent reads may refresh the canceled state without rewriting that proof.
Fresh operations on replaced ancestors are denied. Each retry requires its own
Stop before another retry, even if its intent was never dispatched. Single-child
lineage and active-period uniqueness prevent competing attempts. Replayed
acceptance returns its exact saved obligation and rejects identity changes.

Manual regular payments can continue the accepted fixed or monthly schedule
while debit permission remains stopped. A new never-prepared due period has no
parent but cannot bypass an existing original. Monthly authority ends at its
original service boundary; a one-time minimum-payoff retry retains the original
payoff acceptance and minimum end. An existing payoff prevents ordinary debt
from being collected alongside it. Each new window lasts at most 24 hours and
never extends a service boundary. A bounded retry count requires review after
24 attempts in the same period. Historical agreements are not backfilled.

Dispatch repeats financial controls, current coverage/customer/terms, original
closure, review/receipt/event/check guards, per-attempt Stop and window expiry.
Late control loss rolls back the new obligation, authority and window together.
Already dispatched unknown/bound outcomes keep their original-only read/bind
recovery after expiry or new-money disable. An uncertain cancellation drains its
existing journal even if an independent read already shows the intent canceled;
it does not issue another cancellation POST.

The three new private history tables have RLS, immutable records and service
SELECT-only access. Named definitions extend all four financial digests, and
the raw predecessor payoff-acceptance alias is sealed. Dependency or final-grant
failure restores tables, indexes, foreign keys, definitions, aliases and grants
transactionally. Existing shared capture, Library, commission and financial
recovery implementations remain authoritative.

The same-origin owned API rejects caller-selected amounts, dates, kinds and
actors. Retry and payoff readiness are separate. The buyer screen reads a quote
without creating money, requires an explicit checkbox, refreshes session identity
before preparing and then uses the existing manual confirmation screen. A lost
preparation acknowledgement is recovered by viewing the current original.
Server-attested replacement clears only an older closed browser confirmation;
the current retry's own uncertain confirmation remains preserved and blocks
another card submission. React review covers hooks, unmount/abort handling,
explicit consent, accessible controls and type-only server imports.

The final executable input hashes and integrated/static results are recorded at
the F37 checkpoint. This candidate is local, uninstalled and default off. It does
not implement automatic off-session collection or reusable saved-method consent.
Those, method/SCA recovery, protected daily surplus, bank observations/alerts and
final creator/closer views remain required. Full installed/historical/security/
contention and complete CI/build/browser gates, actual approved provider and
commercial prerequisites, separately authorized external sandbox and distinct
Production/LIVE activation with confirmed BANK evidence remain outstanding.

### F38 — written saved-card consent and verified ownership (local candidate)

The CLI-generated `20261027021620_sales_team_saved_method_authority.sql`
adds independently default-off `saved_method_enabled` plus source schema and
readiness gates. It records a buyer's new, explicit written agreement for the
exact accepted sale and current obligation before its card confirmation. The
server derives the purpose, fixed cents or monthly amount/minimum/renewal terms,
original UTC monthly schedule and Stop/cancellation disclosure. Browser input
contains only acceptance and the current quote fingerprint; customer, payment
identity, amounts, due dates, accepted terms and token proof stay server-owned.
No historical agreement is enrolled or backfilled.

The immutable consent binds the owned buyer, obligation, terms/context, original
token preview proof and confirmation request ID. Confirmation insertion and
post-claim provider dispatch enforce the saved consent when enabled. A changed
quote, Stop or lost control prevents fresh dispatch, including reconfirmation;
bound/unknown originals keep their existing read/reconciliation path with new
money off. Exact acknowledgement replay retains its original authority.

After independent capture and shared fulfillment, `savedMethod.ts` uses GET-only
reads of the original intent, its used token and exact attached PaymentMethod.
It checks the original customer and mode/context, US billing, the token preview's
card fingerprint and expiry, fresh request IDs and unchanged owning source. The
immutable saved-method record references the exact receipt, consent and bound
confirmation. This reader never attaches, changes, confirms or charges a card.
Current mutable card data does not gate captured-money accounting. A failed card
proof leaves the verified Library payment intact and reports separate review.

The owned buyer screen shows an unchecked saved-card permission checkbox and
the actual accepted amounts. A changed quote clears acceptance; renewed session
identity, busy/pending guards and persisted exact request/token/consent identity
prevent another submission after an uncertain acknowledgement. Retry/lifecycle
responses preserve the same requirement for regular manual payments. A new
quote under saved global debit Stop permits manual use only; Stop is never
cleared. Recording method evidence alone cannot authorize an automatic payment.

Both new history tables have RLS, service SELECT-only access and immutable
triggers. All four reviewed financial digests bind the named changed authority.
Dependency and final-grant failures restore tables, control, aliases, definitions
and grants transactionally. Twelve established financial/later-collection SQL
chains now include F38; earlier candidates and legacy paths are preserved.

The current receipts and exact source hashes are recorded at the F38 checkpoint.
This candidate remains local, uninstalled and default off. It implements the
written-consent/checked-card prerequisite; accepted automatic/off-session
charging and method/SCA recovery still need their separate implementation.
Protected daily surplus, independent bank observations/alerts, final views,
installed/historical/security/contention and complete CI/full-suite/build/browser
acceptance remain required. Approved actual commercial/provider inputs, scoped
external sandbox acceptance and distinct Production/LIVE activation/confirmed
BANK evidence remain separate gates. No hosted query, provider operation,
deployment, scheduler registration or activation occurred in this stage.

F38 current integrated receipt: 976/976 tests in 32 suites, no skips, 552.097 seconds, exit 0. All 152 captured executable/test/SQL hashes matched after completion. Full-tree incremental TypeScript passed; 24 changed/new TS/TSX/test files passed lint with zero errors/warnings. Selector 11, sandbox 141 and media 20 safeguards passed. These checks use disposable structural PGlite parents and mocked provider transport; they do not replace complete CI/full-suite/build/browser, installed/historical schema, real contention or external acceptance.

### F39 — accepted automatic collection and same-intent card recovery (local candidate)

The existing CLI-generated `20261027024721_sales_team_automatic_collection.sql`
adds independently default-off automatic collection authority. A due regular
period is derived from contiguous verified payments, accepted terms, the original
UTC anchor and the latest paid card's checked written consent. It cannot adopt
an existing manual obligation, backfill consent, bypass a payoff, clear saved
debit Stop or collect after accepted renewal Stop ends the minimum. Closer
departure does not erase accepted obligations. The immutable collection window
lasts at most 24 hours and monthly windows end at their service boundary.

An authenticated, private/no-store collection endpoint runs one 15-minute slot
with a 90-second lease and at most three durable tasks. Frozen admission keeps
original observation separate from fresh debit. The worker caps payment-object
transport at 40 GETs and three POSTs, with a 65-second observation budget,
45-second POST cutoff and 25-second fresh-phase cutoff. Independently timed
current-context probes retain their existing limits. RPC builders receive a
five-second abort signal when supported; ordinary table builders retain the
existing client behavior. Admitted in-flight object reads drain before outcomes
are recorded. No scheduler is registered or enabled by this candidate.

Fresh debit checks the exact attached customer/card, US billing, fingerprint and
expiry, then creates an unconfirmed intent and explicitly confirms the saved
method off session. The original core journal freezes the originating worker
identity, request and key. A lost confirmation response permits only independent
original-event reconciliation: at most three complete event-list pages, followed
by exact event retrieval, must bind the request key/ID, intent, context, timing,
shape and coherent event type/status. Empty, incomplete or ambiguous evidence
remains unknown. A database trigger prevents binding that bypasses this proof.

Authentication-required declines and bank/SCA action return the buyer to the
same intent using explicit on-session confirmation. A conclusively unpaid or
never-journaled original can explicitly hand over to manual card recovery without
changing its intent, customer, request identities or window. An uncertain,
processing or captured original cannot be bypassed. A newly entered card needs
new written consent and independent saved-method verification before future
automatic use. The old ConfirmationToken is never treated as consumed by an
automatic intent. Captured-money observation uses immutable accepted authority
even if the current card has changed or fresh-debit controls are off.

Capture and receipt inspection explicitly recognize the saved confirmation kinds
and reuse the existing shared Library, cumulative commission, hold, refund,
dispute, cash and recovery owners. Seven private immutable history tables have
RLS and service SELECT-only access. Named functions and trigger ACLs extend all
four financial digests; the raw predecessor capture writer is sealed. Dependency
and final-grant failures are tested for transactional restoration. Thirteen
existing financial/later/saved-method fixture chains now install this candidate.

The continuation first reproduced a SQL parser failure in the final event-status
condition and test-fixture TypeScript errors. Parenthesizing the CASE expression
and correcting fixture types resolved those failures. Current focused proof is
102 tests across five suites, plus 15 separate worker transport/limit tests.
Provider transport is mocked and SQL runs against disposable structural PGlite
parents. Whole-tree TypeScript and changed-file lint are recorded separately.
The current 35-suite integration passed 1,027/1,027 tests with no skips in
798.280 seconds, exit 0; all 163 captured executable/test/SQL input hashes matched
after completion. The separate worker-limit suite passed 15/15 in 1.835 seconds.
Full-tree incremental TypeScript passed, and all 30 changed/new TypeScript files
passed lint with zero errors/warnings. Exact sources and receipts are recorded in
the Sales Team 11 F39 checkpoint. The focused 102-test run overlaps integration
and must not be added to its count. The inherited selector, sandbox and media
safeguard implementations remain unchanged; complete current CI is still required.

This remains a local, uninstalled, default-off candidate. Protected daily surplus,
independent bank observations/alerts, final views, actual installed/historical/
shared/security compatibility, real multi-session contention, complete current
CI/full-suite fallback/build/browser and approved commercial/provider inputs
remain required. Separately approved hosted/provider sandbox acceptance and
distinct Production/LIVE activation with confirmed BANK evidence remain open.
No external account query, migration, payment, deployment or activation occurred.

### F40 — protected daily surplus reservations (local candidate)

The CLI-generated `20261027232440_sales_team_protected_daily_surplus.sql`
adds an independently default-off reservation gate and an unapproved, empty
surplus policy. The policy requires an exact context and bank destination,
explicit minimum/maximum, cost reserve, prerequisite review, evidence and current
contract digest. No bank destination, reserve amount or provider configuration is
chosen by this candidate. Its schema/readiness flags are separate from fresh
collection permission and payout execution.

One UTC daily slot freezes a short lease, context, contract and `allow_new`.
Original unresolved requests take priority and retain their originating worker,
request, key, bank, principal and cost identities. New reservations use the
existing platform cash lock, receipt-based team/shared liability calculation, safety
reserve, all outstanding encumbrances and the lowest current matching-epoch cash
observation. Two independent identical USD/card balance GETs precede admission.
The database derives the exact remaining cents and applies the reviewed minimum
and maximum; the caller cannot supply an amount or bank destination. Policy
changes, stale cash, control loss, lease/context mismatch and unsupported cents
prevent new reservation.

The frozen request specifies a standard USD/card payout to that approved bank,
with exact owned request/operation metadata. `surplusReservations.ts` validates
those bytes and performs only balance GETs and named database admission. It
cannot call the Payouts API, complete a journal, release a reservation or confirm
bank receipt. The core withdrawal journal remains denied. Principal plus cost
stays encumbered after lease expiry, new-money disable and the next day's
original-only run. A later independent debit/return consumer is required before
the new service-SELECT-only resolution history can be written.

Five new policy/history tables have RLS and service SELECT-only access. Run,
request, task and resolution histories are immutable. Named helper/function ACLs
include the replacement cash wrappers. All four existing financial digests bind
the added cash authority; the surplus contract also binds their complete current
digests so inherited liability changes cannot silently authorize withdrawal.
Dependency and final-grant failures restore tables, cash columns, aliases,
definitions and permissions transactionally. Fourteen existing main financial,
saved-method, later-payment and automatic-collection fixtures now install F40;
their isolated historical rollback scopes remain unchanged.

Current focused proof is 43 tests in two suites, using disposable structural
PGlite parents and mocked balance transport. Full-tree incremental TypeScript
passes, and all 18 changed/new TypeScript files pass lint with no warnings/errors.
The current 38-suite integration passed 1,085/1,085 tests with no skips in
1,219.404 seconds, exit 0. All 168 captured executable/test/SQL input hashes
matched after completion. Exact sources and receipts are saved in the Sales
Team 11 F40 local checkpoint. Earlier numeric-input assertions
were corrected to recognize rejection by the existing canonical integer guard.
No guard was weakened. The initial fixture gate omission was also corrected.

F40 implements reservations only. Independently verified payout prerequisites,
actual payout execution/debit/return recovery, bank observations/alerts and final
presentation still need their owning implementations. No application HTTP route
or scheduler is registered or activated here. Real bank/provider/commercial inputs, actual
installed/historical/shared/security compatibility, real multi-session contention,
complete current CI/full-suite fallback/build/browser, separately approved sandbox
and distinct Production/LIVE/confirmed-bank acceptance remain required.

Before payout execution, the next owner must also demonstrate protection for a
provider confirmation that may have captured money while its verified/shared
receipt is still missing. The inherited cash total derives its team balances
from recorded receipts; that total alone is not proof of complete unsettled
collection coverage. Reproduce that case and reserve its potential principal or
hold new surplus until conclusive original reconciliation. F40 cannot dispatch
a payout and does not claim this execution gate is complete.

### F41 — original surplus execution and independent money observations (local candidate)

The CLI-generated `20261028000209_sales_team_surplus_execution.sql` keeps
execution independently default off. Its source readiness/schema flags are
separate from F40 reservation permission. No application route, scheduler,
provider setting, bank approval or external account connection is installed.

Before withdrawal, the cash owner now protects a confirmation's full potential
principal while its independently verified receipt is missing. Bound and unknown
originals remain covered; only the canonical conclusive unpaid closure or the
verified receipt owner can remove that potential amount. Receipt arrival replaces
it with the existing recorded liabilities, without counting both. The source
revision changes with the original evidence and invalidates an older cash basis.
The local regression reproduced the previously missing 3,333 cents before the fix.

`surplusExecution.ts` accepts one actual reserved task and uses the existing
provider journal through a narrow named port. A fresh approved bank/manual-payout
settings proof and two matching available USD/card balance GETs precede claim.
Independent destination/cash reads repeat after claim. Assertion and the final
dispatch check require the current task/lease, frozen new-money capability,
unchanged policy/context, current financial contract and sufficient protected
cash including the request's own principal/cost reservation. A table trigger
also fences withdrawal identity and outcome binding through old journal wrappers.
No generic withdrawal or new destination can be manufactured by the adapter.

At most one frozen standard payout POST can be attempted, with the original
operation/key/worker/bank/amount metadata. API pin and zero retries are enforced.
The adapter admits at most 24 payment-object GETs, one POST, a 45-second POST
cutoff and 65-second overall transport window; inherited context/evidence probes
retain their separate existing bounds. Admitted requests drain before return.
Original response binding can finish after its provider lease expires without
obtaining fresh dispatch authority. A missing/uncertain response never authorizes
a second POST. Unknown creation remains reserved for the subsequent original-event
recovery owner; this stage does not adopt metadata-only matches or claim recovery
from an empty event list. Cancellation requires true journal absence under both
the platform-cash and original journal locks and advances the cash epoch.

`surplusPayoutReadback.ts` reads the exact bound original payout, its referenced
payments-balance debit and any failure/cancellation return, then rereads the
payout. Currency, original principal, source, destination, manual standard method,
mode, metadata, timestamps, transaction types, reporting categories, no conversion,
net/actual fee details and distinct request IDs must agree. Bank details are not
stored: eligibility stores an owned ID and fingerprint hash, and trace references
are hashed. Current bank eligibility never gates money that already moved.

`surplusObservations.ts` remains usable after the worker finishes and all
new-money switches are off. The SQL consumer derives completeness and disposition
again from the proof. Available debit/return entries are immutable and globally
unique within the payout ledger, and existing team financial transaction ownership
is checked. A late failed return appends a separate entry without rewriting the
first resolution or posting money twice. Each newly recognized monetary fact or
reservation release advances the existing cash epoch, so an earlier high balance
cannot become spendable. Pending or missing return evidence retains an unresolved
reservation. Actual fee excess is recorded and creates an alert that holds new
surplus; a fee credit requiring review is also explicit.

Six new histories have RLS and service SELECT-only table access. Named private
and public function ACLs, immutable histories, all five financial/surplus digests,
and transactional dependency/final-grant rollback are covered. Fifteen existing
main financial fixture chains now install F41; isolated historical rollback
parents remain unchanged. Focused local checks passed 87 tests in three suites
using disposable PGlite parents and mocked transports. Broader current integration
and final static receipts must be recorded at the local checkpoint.

Every provider observation still reports `bankConfirmed=false`. The historical
F41 recommendation was reviewed bank statements for first LIVE acceptance. The
user superseded that recommendation on 2026-10-29: automatic bank confirmation
plus exception review is required for launch, with Stripe Financial Connections
evaluated first (see F45). No actual bank connection has been provisioned.
Stripe's `payout.paid` can be followed by `payout.failed`; neither supplies actual
bank receipt proof.

Original unknown-create event recovery, narrow signed-payout webhook ingress,
bounded daily orchestration and beneficiary bank observations/alerts still need
their owning continuation. Final presentation, actual installed/historical/shared
security compatibility, real multi-session contention, complete current CI/full
suite/build/browser, approved commercial/provider inputs, separately authorized
external sandbox and distinct Production/LIVE/confirmed-BANK acceptance remain.

## F42: exact original surplus event recovery (local candidate)

`20261028222238_sales_team_surplus_recovery.sql` adds original-only recovery;
`surplusRecoveryReadback.ts` discovers at most three 100-event pages in a fixed
creation-time interval, with exact pagination and a complete final page. Exactly
one original idempotency-key match must survive independent retrieval of its
exact event ID on both sides of the existing payout/debit/return reader. The
original request ID, supported event API version, platform context, mode,
immutable payout amount/bank/metadata/created/debit identity must agree. The
current payout may legitimately have progressed since its creation snapshot.
The reader allows nine GETs and 60 seconds, zero POSTs/retries, and drains
admitted requests. Empty, ambiguous, incomplete or older-than-30-day discovery
remains held; no event list proves an unsent payout. Unsupported event schemas
remain held. Stripe's documented event retention does not establish universal
historical recoverability.

`surplusRecovery.ts` uses service-only named admission/completion functions.
The database requires the actual original dispatch journal/action, rechecks the
complete discovery and exact event/request/key proof, then binds through the
existing guarded journal and consumes money through the F41 validator in one
transaction. A money-validation failure rolls the outcome binding back. Pending
money can bind identity while preserving the reservation. Distinct overlapping
recoveries cannot own the same event or book its money twice. New-money controls,
current bank eligibility and a running worker lease do not authorize or erase
original outcomes. Every result retains `bankConfirmed=false`.

The two new histories have RLS, immutable rows, service SELECT-only table grants,
and named function ACLs. All five financial/surplus digests include both recovery
functions. Sixteen main financial fixture chains include F42; isolated historical
rollback parents remain unchanged. Current focused, integrated and static check
results are recorded in the Sales Team 12 checkpoint, not implied by this source.

This remains a local candidate with fake transports and disposable SQL fixtures.
Signed surplus ingress, daily orchestration, beneficiary bank observations and
final views remain separate owners. No scheduler, provider setting, bank approval,
new-money activation or external rollout is installed by this migration.

## F43: signed original surplus ingress (local candidate)

`surplusWebhook.ts` runs before payment classification in both the newly claimed
and completed-duplicate branches of the canonical webhook. Real signature and
mode/source guards still precede the shared claim. Organization-scoped payout
events are rejected before claiming. Metadata only locates or fences an original;
the durable dispatched surplus request and provider journal own the payout.
Saved payout bindings also route when payload metadata is absent. Missing schema,
changed ownership, stale tokens and suspicious marked objects never fall through
to legacy payment effects. Non-payout traffic avoids surplus database lookup.

`20261028224405_sales_team_signed_surplus_events.sql` requires the shared token
claim functions/table at installation. Event admission locks and verifies the
actual `stripe:<eventId>` claim row, including type, status, token and freshness.
A null token is accepted only for an already completed shared delivery. Immutable
event admission advances the cash epoch once. A completed shared delivery without
a surplus result must still reconcile the original before acknowledgment.

Only F41 bound-original observations or F42 independent creation-event recovery
supply money proof. Completion requires a check admitted after event admission,
current complete independent money, the exact payout/context and
`bankConfirmed=false`. A failed/canceled event requires an independently read
return. Pending or unavailable money leaves the event durable and unacknowledged.
There is no webhook POST, replacement payout, unsent inference or bank-receipt
claim. The added handler uses a 45-second admission window, up to nine payout/event
GETs, zero retries, bounded RPCs and a 30-second admission allowance for each
existing context probe. Admitted work is awaited; exhausted budgets remain held.
The shared claim/completion prelude retains its existing owner and limits.

Unresolved signed events hold fresh surplus and extend the existing claim,
prepare and finish predicates even after the original immutable debit resolution.
A late failure therefore selects the original next UTC daily slot. Its eventual
return appends the existing money leg without rewriting the original resolution.
Another event's result cannot clear this hold. Histories have RLS, service
SELECT-only access, named function ACLs, immutable rows and five financial digest
owners. Dependency, shared-claim, predicate and final-grant failures roll back
installation transactionally.

The signed tests use Stripe's real signature verifier with synthetic payloads,
actual shared SQL claim functions over a structural base table, and mocked
provider transport. Seventeen current main financial fixture chains now include
F43; isolated historical rollback parents remain unchanged. Exact checks and
source hashes belong to the Sales Team 13 checkpoint. These fixtures do not prove
actual installed/historical/shared security compatibility or real multi-session
PostgreSQL contention. Complete current CI/full-suite/build/browser and external
provider/BANK gates remain separate. Daily orchestration, beneficiary bank
observations/alerts and final views still require their owning implementation.

## F44: bounded daily surplus application (local candidate)

`GET /api/sales-team/surplus` uses the existing constant-time cron bearer check
before composing provider access. `CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY`
defaults off and requires the F43 schema chain. Fresh payout authority still
requires the existing reservation and execution switches plus database controls;
the daily schema switch alone only permits recovery of existing originals.
Responses are private/no-store. No scheduler is registered or activated here.

`dailySurplus.ts` claims one existing UTC daily slot and one original task with
the inherited 90-second lease. F40 owns protected cash and reservation identity;
F41 alone dispatches a genuinely new reserved payout. The outer adapter permits
at most one exact-original POST before 25 seconds, 32 payment-object GETs,
60 regular RPCs and a 65-second admission window. Provider transport uses the
fixed API pin, zero retries and at most ten seconds; RPCs use at most five seconds.
Existing independent context/evidence probes require 30 seconds remaining when
admitted. Already-started transport drains normally. Up to three owned event
claim releases and the original worker finish use bounded cleanup RPCs. The route
retains a 120-second ceiling; database lease expiry still fences new operations.

An original with a journal can only use F41 observation or F42 exact creation-event
recovery, even when new payout authority is enabled. Only an original whose journal
is absent can use F41's guarded unsent cancellation. Unknown or incomplete outcomes
stay reserved. A late signed event after an immutable debit resolution still
selects that original and prevents a fresh payout.

`20261029171329_sales_team_daily_surplus.sql` adds one service-only pending-event
reader, restricted to the current worker lease/context and exact assigned request.
It returns at most three immutable F43 admissions. The application acquires their
actual shared Stripe claims, retaining null tokens only for completed duplicates,
then reuses the stored admission and fresh independent original money proof.
Busy/reclaimed claims retain their owner and hold. Extra pending events keep the
run in review. No signed payload or bank receipt is invented. Every outcome still
says `bankConfirmed=false`.

The reader uses a fixed search path and is included in all five financial contract
digests. Eighteen existing main financial fixture chains include F44; isolated
historical rollback parents remain unchanged. Dependency, digest and late-grant
installation failures roll back. The
local fixture checks use structural shared-schema bases and mocked transport;
they do not establish installed historical compatibility, multi-session PostgreSQL
contention, hosted/provider acceptance or bank receipt. Exact checks and source
hashes belong to the Sales Team 13 checkpoint. Beneficiary bank observations/alerts,
final views, complete CI/build/browser and separately approved external gates remain.

## F45: beneficiary payout and bank connection readers (local candidates)

`beneficiaryPayoutReadback.ts` starts from a service-resolved original transfer
request and its immutable F27 completion. It independently rereads that transfer
and platform debit, fences retained request IDs, and reads the candidate payout
in the original connected account. Only standard automatic USD bank payouts with
completed reconciliation qualify. Two complete payout-filtered balance lists
(at most three pages of 100 each) must agree, include exactly one original
destination-payment credit, and sum to the payout. Independent credit, payout
debit and optional return reads must agree with those identities. Manual,
instant, incomplete, changing or ambiguous observations remain unresolved.
The read admits at most 15 payment-object GETs within a checked 65-second window,
uses zero retries, and reserves 30 seconds before its own context probes.

`bankConnectionReadback.ts` reads the exact Financial Connections account twice
under the saved connected-account scope. Account holder, mode, permission set,
subscription and refresh observations must agree. It distinguishes disconnected,
reconnect required, unsupported account, missing permission/subscription,
missing/pending/failed refresh, stale and ready states. The 36-hour freshness
threshold is an engineering candidate, not an approved live service promise.
Refresh time is `lastAttemptedAt`; a failed attempt is not a successful sync.
Two GETs use a checked 45-second window with a full 30-second allowance reserved
before each context probe. Platform-owned bank connections are outside this reader.

Both readers retain the existing Stripe API pin, use at most ten-second provider
timeouts and await admitted work. Their minimized output excludes bank numbers,
last four digits, institution/owner names, descriptions, trace text and unrelated
payout members. They perform no provider write, release no accounting and always
return `bankConfirmed=false`. A healthy connection does not prove that it is the
payout destination or that a deposit arrived.

These unused service-layer candidates have no route, schema migration, durable
admission/acceptance owner or activation switch. They do not implement consent,
destination mapping, transaction ingestion/matching, reconnect/revocation,
authorized reviewed exceptions or alerts. Those owners and final scoped views
remain required for the selected automatic-bank-confirmation launch. Matching
only on last four digits, amount or date is insufficient. Exact provider/account
compatibility, destination linkage and stable deposit references remain external
acceptance gates; original banks/accounts must be preserved.

Sales Team 13's readback-d receipt covers 166 passing mock-provider tests at its
recorded bytes. The only later runtime-source edit was a TypeScript assertion
through `unknown`; Sales Team 14's typecheck-c and lint-c close that static gap.
Exact source/evidence hashes belong to the Sales Team 14 checkpoint. These checks
do not establish hosted/provider capability, installed shared-schema security,
complete current CI/build/browser acceptance, Production behavior or BANK receipt.

## F46: durable beneficiary payout observations (local candidate)

`20261029182136_sales_team_beneficiary_payout_observations.sql` adds a disabled
observation policy and immutable check, observation and provider-read histories.
The service-only admission resolves an existing completed F27 transfer and its
original provider journal. A client-supplied original or beneficiary is never
accepted. One 90-second check lease can own a transfer at a time. Reusing a check
ID returns consumed without revealing its token; a lost admission must expire
before a new attempt. Completion requires the exact token/context, unchanged
original source, current policy/contract, and fresh proof read after admission.

The SQL consumer validates the minimized F45 shape, original identities and
amount, automatic payout, exact destination-payment credit/debit/return, bounded
membership summary and distinct provider request IDs. Retained original reads,
POST IDs and IDs consumed by another observation cannot be reused. A duplicate
completion is idempotent only for byte-equivalent JSON evidence. Late failures
append observations; previous evidence is immutable. A previously associated
payout or external bank cannot silently be replaced. Known transfer reversals
prevent fresh unreversed evidence and require the remaining exception owner.

This owner does not move money or change existing accounting, financial digests,
recipient identities, payout schedules or statement status. New-money controls
may remain off. Its separate contract digest includes its function bodies/ACLs
and the existing transfer contract. Both admission and completion require a
matching explicitly configured policy. Authority is checked again after inserts,
so loss of authority rolls back the observation and consumed request IDs.

RLS is enabled on all four new tables. Anonymous/authenticated roles have no
access; service has SELECT-only table access and two named definer entry points
with fixed search paths. Private helpers have no service execution grants.
No user route, scheduler or bank-confirmed projection is added. The default-off
`CREATOR_TEAM_BENEFICIARY_PAYOUT_SCHEMA_READY` requires the F44 schema chain.
`beneficiaryPayoutObservations.ts` resolves originals through admission, freezes
its composition references, bounds RPCs to five seconds, reserves context-probe
allowances, and awaits transport within an 85-second checked post-admission
window. It has no retry or provider POST path and always returns bankConfirmed=false.

Sales Team 14 records 59 passing structural SQL/mock-provider cases, including
permission denial, forged/replayed/stale evidence, lost authority, immutable late
failure history and transactional installation rollback. Two native PostgreSQL
17.11 cases use three independent sessions each and observe actual lock waits
for admission and duplicate completion. The native run clones the preserved
F44 structural template and installs this migration only in new test databases.
Exact receipts/source hashes and static results belong to its checkpoint.
Installed historical/shared-schema compatibility, full current CI/build/browser,
provider sandbox, Production/LIVE and real BANK acceptance remain separate gates.

Consent/provenance, exact external-bank-to-Financial-Connections mapping, bank
health persistence, transaction ingestion/matching, reconnect/revocation,
authorized exception review, alerts and final views remain required. Provider
configuration and identifier inspection is evidence for capability evaluation,
not permission to change accounts or proof that a bank deposit arrived.

## F47: scoped statement payout observations (local candidate)

`20261029233544_sales_team_payout_statements.sql` adds the service-only, fixed-search-path
SECURITY INVOKER `read_sales_team_payout_statement_v1`. It first calls the existing
statement owner for actor authorization, accessible receipt pagination, cumulative
commission totals and all later accounting fields. Its existing function and financial
contract bodies/ACLs are preserved. Owners and active appointed managers retain creator
scope. Closers, including removed members, see only their own closer originals under
the already-authorized receipt, sale and creator. Historical reads need no new-money
control enabled.

Each visible receipt adds up to 20 latest completed transfer observations, with an
explicit overflow indicator. The projection includes only beneficiary role, that
transfer's amount/time, original reversal total, latest recorded payout status/time,
and bankConfirmed=false. It exposes no provider IDs, bank details, payout batch amount,
other members, raw evidence or lease. It reads immutable F27/F29/F46 owners without
provider calls or financial writes. The statement read time is distinct from each
provider observation time; refreshing this screen does not check Stripe or the bank.
Paid, failed, missing, historical and reversed evidence never becomes confirmed BANK.

The statements route selects this projection only when the complete beneficiary
schema chain and `CREATOR_TEAM_PAYOUT_STATEMENTS_SCHEMA_READY === "true"` are present.
Otherwise it keeps the existing statement RPC. New controls remain default off.
Consent, exact bank mapping/deposit association, bank-health persistence, authorized
exception/alert owners and actual bank acceptance remain separate required work.
Local structural/mock checks do not establish installed/shared, hosted/provider,
Production/LIVE or BANK acceptance. The final CI full-suite fallback still applies.

## F48: cumulative purchase earnings range (local candidate)

The hosted catalog receipt observed purchases.amount_cents and
purchases.earnings_credited_cents as integer, whereas the structural fixture uses
bigint. A normal accepted integer-price purchase and its duplicate fulfillment
were compatible. Cumulative creator earnings have a different range: an accepted
99,999,999-cent auto-renewing monthly contract produced a synthetic observed net
of 75,099,969 cents for its first capture. Repeating that net 29 times projects
2,177,899,101 cents, above the signed integer limit. Native PostgreSQL rejects that
projection when converting it to the integer purchase field (SQLSTATE22003).
This was a column-domain counterexample, not ingestion of 29 elapsed renewals or a
claim that the full accounting synchronization ran over 29 original receipts.

20261031195130_sales_team_purchase_earnings_range.sql widens only cumulative
purchases.earnings_credited_cents from plain integer to bigint, preserving values;
an existing bigint is a no-op. Single-purchase amount_cents remains unchanged.
The migration requires the existing shared-accounting and F47 statement owners,
rejects missing/generated/identity/unreviewed column types, and uses a five-second
lock timeout and 60-second statement timeout. Dependency or lock failure rolls
back. It changes no routine, accepted terms, financial identity, permission,
feature control, accounting balance, provider object or money operation.

Sales Team 16 recorded eight PGlite schema tests and six native PostgreSQL17.11
migration checks, including sentinel values, retained function/security inventory,
already-bigint behavior, unsupported type, missing parent, dependent-view rollback
and an observed real lock wait that times out at five seconds. Six further native
assertion groups preserve old once-only credit/reversal behavior and prove that
five retained legacy entry points still reject team purchases/ledgers before a
legacy integer conversion; all test-local financial mutations roll back.
The underlying template is structural, with actual F46/F47 local migrations.
Schema-only unit fixtures use named parent stubs to test presence gates only.

Actual hosted constraints are available only as prior catalog digests, not their
expressions; installed/history/dependency equivalence is unverified. Widening an
actual integer column may rewrite its table and needs a bounded installation plan,
approved target history/security compatibility and separate hosted authorization.
These local checks do not establish that operational lock duration, provider,
Production/LIVE or BANK acceptance. The required complete final CI fallback and
other financial journey gates remain in force.


## F49: immutable BANK exception review history (local candidate)

20261031201235_sales_team_bank_exception_reviews.sql adds default-off review
policy and append-only acknowledgement/escalation history for a completed original
transfer. The state snapshot reuses its existing beneficiary, immutable F46 payout
observation and reversal history. Missing observations, provider payout statuses
(including paid), and later reversals all leave the exception outstanding with
bankConfirmed=false. A review never releases accounting, confirms BANK, closes or
hides the exception, changes provider objects, or dispatches an alert/recheck.
This is one component of the required automatic confirmation and exception flow.

The service-only record function acquires the retained creator authorization lock,
requires the current owner or appointed active manager, and validates an exact
current state digest. A review ID is immutable and idempotent only for its original
actor/action/request/state. Permission and policy authority are checked again after
insert; loss of either rolls back. Even exact replay requires current authority.
Changing observations or reversals leaves older reviews visible but no longer
applicable to the current state. Snapshot timestamps use canonical UTC independent
of connection timezone. Read history reuses the existing statement scope: owners
and active managers have creator scope; removed closers retain only their own
original financial history. History has bounded cursor pagination and exposes no
provider/bank identifiers, raw evidence, lease, buyer details or reviewer user IDs.
RLS is on, users have no direct grants, service has SELECT-only table access and
two named fixed-search-path definer entry points. Financial contract owners and
retained routine bodies/ACLs are not changed.

GET/POST /api/sales-team/bank-review uses the retained verified-user authority.
Only that verified user supplies the SQL actor; a caller-supplied actor is rejected.
GET requires the complete retained schema chain plus
CREATOR_TEAM_BANK_REVIEW_SCHEMA_READY=true. POST additionally requires
CREATOR_TEAM_BANK_REVIEW_READY=true, same origin and a bounded exact-field JSON
intent. Historical review does not require new-sales admission. Database write
policy also remains disabled until its exact current review contract is explicitly
configured. No route/control was enabled by this local source change.

Sales Team 16 records 19 structural SQL cases, 23 API admission cases and six native
PostgreSQL17.11 cases across nine sessions/eight contenders. Native tests observe
actual advisory waits, once-only duplicate reviews, changed-intent rejection,
committed manager removal, MVCC observation visibility, cross-session UTC/Phoenix/
Tokyo digest equality, service privileges and unchanged retained financial rows.
An explicit timezone regression failed on the first draft and passes after UTC
canonicalization. Structural fixture triggers initially omitted public schema
qualification; those fixture failures are preserved separately. Native servers
completed smart shutdown with exit0, and the root suite inputs were unchanged.

The SQL base is structural, not actual installed/historical/shared-schema proof.
Final user views and queue discovery, consent/provenance, exact bank and posted-
deposit association, durable bank health/refresh/revocation, scoped alert delivery
and complete reviewed exception resolution remain required. No manual confirmation
fallback is added. Current complete CI/build/browser, separately approved hosted/
provider sandbox, distinct LIVE rollout/activation and actual BANK acceptance remain
separate gates. Source/evidence hashes belong to the Sales Team 16 checkpoint.
