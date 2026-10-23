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
