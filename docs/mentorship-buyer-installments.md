# Buyer-selected mentorship installments

Implementation in progress. No checkout activation, hosted migration or payment
acceptance is implied by the creator controls or quote endpoint.

## Implemented candidate contract

`products.installment_options` holds ascending, distinct creator-approved counts
from 2 through 24 for fixed-price mentorships. Empty is the default for every
existing product. The local migration adds no new plan to any existing agreement
and does not change products' existing RLS. A pure SECURITY INVOKER validator and
table constraints enforce shape, eligible product type, absence of monthly-service
terms, maximum total and a minimum of 50 cents per installment.

The creator product API validates choices before provider or product writes and
uses the authenticated creator identity. The composer shows approved counts only
when the API advertises readiness. Monthly service and fixed-total installments
remain distinct; fixed service months are independent of payment count.

New flags (default off):

- `CREATOR_MENTORSHIP_INSTALLMENT_OPTIONS_SCHEMA_READY`: the migration and the
  existing monthly/fixed-service product columns are installed and verified.
- `CREATOR_MENTORSHIP_INSTALLMENT_OFFERS_READY`: creator configuration accepted.
- `CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_READY`: the complete buyer payment
  lifecycle is accepted. Do not set this while the remaining work below is open.

Creator capabilities require all three. The new GET `/api/installments/quote`
also requires purchase policies and configured processing fees. It accepts only
product_id, optional post_id and payment_count, rejects duplicate/extra keys,
authenticates the buyer, reads authoritative product/fee settings, verifies the
post-product relationship and rejects unapproved plans. The response is private
and uncached. No payment or reservation occurs on GET.

The quote uses the existing exact-cent planner. For $100.01 across three payments,
it discloses $33.33, $33.33 and $33.35. Its fingerprint binds buyer, product, post,
price, selected count, service duration, policy and first/renewal fee schedules.
Those fee inputs come from server configuration; client-supplied values are not
accepted. Final collection dates still require an accepted captured-payment
anchor, not the time the quote was viewed.

## Remaining before capability activation

The local reservation migration now stores the accepted buyer/product/post,
context, destination and exact quote with a stable request ID. It binds a
dedicated installment attempt and serializes against full-payment attempts by
buyer/product. Replaying an identical request returns the original acceptance;
it does not grant fresh payment authority. The existing full-payment route
rejects an installment attempt before retrieving or creating a Stripe session.
The fixed-service one-time consent guard remains in effect for full payments.

This reservation has an authenticated creation endpoint and internal customer
and bootstrap adapters. Bootstrap dispatch has local verification; Checkout
publication and actual receipt/lifecycle processing are still unfinished.
The server-only acceptance adapter rebuilds the quote from server product/fee
inputs, checks exact consent and same-origin submission, validates independently
observed payment context, and validates the returned reservation before exposing
its identity. It never returns a Checkout URL or grants provider authority. Its
caller must authenticate the buyer and obtain fresh context evidence; these are
not browser-supplied inputs. `POST /api/installments/reservations` authenticates
the buyer, validates exact request fields and Origin, observes the payment
context, and looks up the owned request before reading the current product/fees.
An unchanged replay returns its saved terms; a changed selection cannot reuse
that request ID. A new request uses the authoritative product/post and server
fees before invoking the durable acceptance adapter. Replies omit internal
attempt/destination identifiers. A lost reply preserves the original request ID
for recovery. The endpoint remains gated by complete checkout readiness and
does not publish payment sessions.
A read-only recovery endpoint retrieves the original accepted quote by request ID
for its signed-in buyer using fresh server payment-context observations. It stays
available when new installment offers are paused, provided the context and
reservation schema remain enabled. Original serialized terms are stored beside
JSONB and validated against the original fingerprint, so recovery does not
regenerate consent from a changed catalog or current fees. It returns no provider
URL or payment authority. The buyer screen still needs to retain and use the
request ID.
It deliberately rejects any prior checkout/purchase for that buyer/product.
Safe abandonment, expiration and switching between payment modes still need
original-provider reconciliation and a defined release transition; the permanent
reservation cannot be enabled as the finished buyer checkout experience.
Its attempt is immutable. Customer, product, subscription, hold and unpublished
Checkout stages have their own durable records. Receipt/lifecycle processing,
provider reconciliation beyond the retry window and safe release remain open.
All installment capabilities remain disabled until the full flow works.

### Customer preparation candidate

`20260921021558_buyer_mentorship_customer_operations.sql` is unapplied. Its
SECURITY INVOKER RPCs require the server role and resolve the accepted request's
buyer and exact context. They share the buyer/product lock with reservation and
full-checkout coordination, without granting UPDATE on accepted reservations.
A durable customer operation holds immutable parameters, a random idempotency
key, first dispatch time, lease, and verified customer binding. A busy lease
blocks another dispatch; later retries reuse the exact parameters/key. Automatic
replay stops at 23 hours from the first dispatch, requiring reconciliation rather
than risking reuse of a pruned provider key. See [Stripe's idempotency contract](https://docs.stripe.com/api/idempotent_requests).

The internal customer adapter requires both
`CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY` and
`CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_READY` (default off). It reads the owned
acceptance, validates the claimed operation, repeats provider/database context
observation immediately before creation, disables SDK retries and verifies the
created customer with a fresh retrieval before binding. An existing binding is
retrieved and validated, never replaced. No booking is created and no customer
is relabeled as a creator-issued agreement. No payment method, Checkout session,
subscription, invoice, charge or access grant is created by this stage.

Customer tests cover SQL permissions and sequential claim/retry/bind interleavings,
plus synthetic SDK creation/retrieval. Hosted concurrency, provider idempotent
replay, recovery beyond the automatic replay window and subsequent provider
stages remain acceptance requirements. No endpoint currently calls this adapter.

1. Prove the authenticated acceptance flow and concurrent checkout serialization
   on hosted PostgreSQL and implement
   reconciled abandonment and payment-mode switching.
2. Integrate exact-cent provider bootstrap, original-operation recovery, first
   capture, remaining collections, refunds/disputes and independent access with
   that buyer-owned reservation. The existing context-v2 protocol requires an
   actual creator-owned booking. Do not pass a buyer off as the creator, fabricate
   a calendar booking, adopt a legacy agreement or reopen the closed generic
   installment endpoint as a shortcut.
3. Wire the buyer's full-payment/installment selector, payment breakdown and
   consent into the durable checkout path. Changing the plan must invalidate
   previous consent. Pay-in-full remains available for fixed offers.
4. Verify races, changed/withdrawn offers, interrupted Checkout, duplicate/out-of-
   order events, first/final cent amounts, fee deductions, stop conditions and
   independent service expiry on the exact staging deployment.
5. Implement the accepted US-only launch restriction, resolve the professional
   tax review, and verify creator/buyer screens,
   operations monitoring and release configuration together.

The local PGlite migration fixture verifies actual SQL constraints without
connecting to a hosted database. Route tests use mocked auth/database/provider
adapters; they are not hosted acceptance or proof of a completed purchase flow.

### Durable buyer bootstrap candidate

The unapplied `20260921030153_buyer_mentorship_bootstrap_operations.sql` migration
adds an immutable database-clock anchor and dedicated customer binding, then
separate original operations for `product.create`, `subscription.create`,
`subscription.hold` and `checkout.create`. Service-only SECURITY INVOKER RPCs
share the buyer/product lock. They retain original parameters, API version,
idempotency keys, first-dispatch times and result IDs. Active leases return busy;
aged uncertainty requires review. Dependencies must be durably bound in order.
The server reconstructs and checks the complete request before dispatch; the SQL
layer additionally checks ownership, context, metadata and bound dependencies.
Neither the operation tables nor their bind RPCs represent financial receipts.

`prepareBuyerMentorshipBootstrap` independently reads the owned original
acceptance, verifies the destination and no-card customer, then claims each
operation before dispatch. SDK retries are disabled. Created objects are read
back before binding. Subsequent invocations read existing bindings without
creating replacements. Before Checkout it reobserves context, customer and
subscription, using the existing exact-cent/fee/consent builder against the
actual indefinitely held subscription. The original expiry cannot be extended.

New flags default off:

- `CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_SCHEMA_READY`
- `CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_READY`
- `CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_DISPATCH_READY`

Without the last gate, preparation ends at a verified held subscription. With
it, the internal result remains `checkout_unpublished` and omits the payment URL.
There is no HTTP caller. Do not enable payable-session dispatch until receipt,
lifecycle and payment-side US-only enforcement are ready for staged acceptance.
No bootstrap operation grants access, credits earnings or releases the purchase
lock. No booking or creator impersonation is used.

The temporary webhook boundary now resolves unexpanded dispute charge IDs and
their PaymentIntents through a provider read before other accounting handlers.
It checks relationship identity/mode and looks up related dedicated customers.
Read failures and mismatches release the original event claim for retry. This
is still a rejection boundary, not completed refund/dispute processing.

### First captured-payment inspection

`mentorshipInstallmentReceipt.ts` now reads the owned reservation and all four
bound bootstrap operations, retrieves the original Checkout, PaymentIntent,
Charge, balance transaction, saved PaymentMethod, customer and held subscription,
then reobserves payment context. It shares original Checkout request construction
with bootstrap without fabricating unpaid provider objects after payment.

Its proof requires captured funds, exact first-payment cents and fee allocation,
matching customer/card/provider relationships, actual consent, balance evidence
and a transfer ID. It preserves the captured date for the next payment and uses
the independent fixed-service calendar helper for service expiry, including
durations above 24 months. Missing asynchronous balance evidence requests review
or retry. Refund/dispute state must be reconciled through the unfinished lifecycle
path before an initial clean-payment proof can be returned.

Inspection is read-only, behind the default-off
`CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_INSPECTION_READY` flag and bootstrap schema
gate. It does not persist a receipt, credit the fee ledger, grant access, activate
collection or acknowledge a webhook. Those remain the next integration work.
The US address checks are post-capture evidence, not a substitute for pre-payment
US-only enforcement across Checkout, renewal, payoff and card replacement.

### Later receipt and collection-control continuation

The internal `reconcileBuyerMentorshipInvoice` adapter reuses
`inspectPaidRenewal` and the existing held-invoice identity/amount/fee verifier.
The shared inspector accepts the genuine buyer authorization; no booking is
fabricated and the legacy booking entry points remain restricted. It resolves
the original admission, freshly reads the paid invoice/default invoice payment,
PaymentIntent, captured charge and balance evidence, then records one atomic
buyer receipt, existing fee-ledger entry, creator credit and payment-count
transition. The final residual cents use the existing installment plan helper.
Service expiry remains the independently accepted service end.

Reconciliation contains no prepare/pay/confirm/subscription-write path. It works
with collection disabled and an expired dispatch deadline. A clean capture can
be counted after debit revocation; a refund/dispute still requires the unfinished
financial lifecycle rather than another charge. The signed webhook resolves
the dedicated customer and persisted invoice admission before the first-payment
and legacy handlers. Unsettled money releases the event claim for retry.

The activation runtime reuses its existing card/subscription/capture checks to
release the initial database collection hold once, before the first renewal.
It never removes Stripe `keep_as_draft`. The SQL release materializes the
existing immutable periods. Activation replay cannot clear a later hold or
revoked debit. Debit revocation shares the buyer/product admission lock and
reports unresolved admitted payments rather than promising they were canceled.

POST on the existing saved-reservation endpoint accepts only
`{"action":"revoke_debit"}`. Authenticated ownership, exact origin and context
are required; it preserves the fixed obligation and hides provider identities.
This is not full subscription-stop/payoff/retry/abandonment management.

Additional default-off gates:

- `CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY`
- `CREATOR_MENTORSHIP_INSTALLMENT_RECONCILIATION_READY`
- `CREATOR_MENTORSHIP_INSTALLMENT_LATER_WEBHOOK_READY`
- `CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY`
- `CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_ENABLE_READY`
- `CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_STOP_READY`

Migrations `20260921045709_buyer_mentorship_later_receipts.sql` and
`20260921050829_buyer_mentorship_collection_controls.sql` remain unapplied.
Local SQL/provider-port/signature tests are not hosted acceptance. All six
release workstreams remain open, and Checkout publication remains disabled.

## Credited-payment refund continuation

Signed charge.refunded and refunded charge.updated events resolve the shared
buyer-owned customer/reservation binding before first-payment or legacy routing.
The new observer reuses inspectExactRefundCapture, inspectExactRefundTotals,
confirmAdminRefundWebhookDelivery, record_payment_refund_state and
apply_payment_fee_ledger_refund. It creates no refund or replacement charge.
Original receipt/ledger identity is required. A durable financial hold precedes
provider reads; cumulative reversal is atomic, duplicate-safe and monotonic.
Provider uncertainty retains the hold and original webhook retry.

Default-off gates: CREATOR_MENTORSHIP_INSTALLMENT_REFUND_SCHEMA_READY and
CREATOR_MENTORSHIP_INSTALLMENT_REFUND_EVENTS_READY. Migration
20260921052151_buyer_mentorship_refund_reconciliation.sql remains unapplied.
Refund-before-receipt, disputes, hold restoration, provider cancellation and
transfer/payout reconciliation remain unfinished. Local verification is not
hosted lifecycle acceptance or deployment readiness.

## Refund observed before receipt accounting

The existing first and admitted-later capture inspectors now expose a read-only
refund inspection mode. Ordinary accounting still rejects refunded charges.
The refund observer resolves the original admission or bound first Checkout,
verifies capture plus succeeded refund totals, and calls one transaction that
composes the existing receipt recorder and refund reversal. No gross credit is
visible before its refund adjustment and financial hold commit. Later recovery
also persists a hold before provider refund reads. First recovery creates no
access or activation before the atomic transaction. Missing/uncertain evidence
retains reconciliation rather than creating another provider operation.

Additional default-off gate: CREATOR_MENTORSHIP_INSTALLMENT_REFUND_RECOVERY_READY.
Migration 20260921053445_buyer_mentorship_refund_before_receipt.sql is unapplied.
This supersedes the prior refund-before-receipt gap for confirmed refunds with
original capture evidence. Pending refunds, prior unrelated financial-state
observations, disputes, stale payment events after refunds, hold restoration,
transfer reconciliation and hosted acceptance still require lifecycle work.

## Delayed success events after an observed refund

First and later webhook handlers share a receipt-bound financial handoff before
ordinary credit/activation. A saved refund observation only selects the path;
the existing refund reconciler must verify current original capture/refund totals
and finish accounting before the delayed success event is completed. First
Checkout, PaymentIntent and charge events and later invoice, PaymentIntent and
charge events are covered. No activation or repeated gross credit occurs on this
path. Missing refund observations preserve ordinary handling; mismatched evidence
or provider uncertainty retains event retry. This supersedes the earlier stale-
payment-event gap for observed refunds with an existing original receipt.

## Credited-payment dispute observation

Signed dispute created/updated/closed events resolve the original charge and
buyer-owned customer, then re-read the current dispute and original capture.
The existing installment dispute capture checks and receipt/economics validator
are shared, not duplicated. PostgreSQL persists a financial hold before provider
reads and compares both billing revision and the shared dispute-state snapshot
before applying. It reuses record_payment_dispute_state and mirrors the selected
original payment's ledger audit. Terminal conflicts are recorded for review;
no creator earnings are automatically debited, no debt is waived and no hold is
released, preserving the existing dispute policy.

Default-off gates: CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY and
CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY. Migration
20260921054642_buyer_mentorship_dispute_observation.sql remains unapplied.
Disputes before receipts, delayed payment-success completion after disputes,
provider cancellation, financial-hold resolution, dispute-cost responsibility,
transfer/payout reconciliation and hosted signed acceptance remain unfinished.

## Dispute-before-receipt and delayed-success recovery

The original first/admitted-later capture resolver is now shared by refund and
dispute recovery. Dispute inspection preserves the immutable original capture
proof while ordinary clean-credit inspection continues to reject disputes.
For a receipt not yet recorded, one transaction composes the existing first/later
receipt recorder, durable dispute hold and existing dispute observer. If a competing
worker already created the receipt, keep the hold and retry the normal credited
path with a fresh provider observation basis; do not apply an invented snapshot.
A failed audit rolls back the new receipt and earnings together.

The earlier delayed-refund handler is now a shared financial-event handler.
Delayed success events re-observe previously recorded disputes through their
original event identities and current provider evidence, without activation.
Multiple dispute observations are bounded and deduplicated by dispute identity;
pending/unverifiable observations retain retry. Refund reconciliation still runs
when a refund observation exists too.

New default-off gate: CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_RECOVERY_READY.
Migration 20260921055838_buyer_mentorship_dispute_before_receipt.sql is unapplied.
Existing unrelated financial observations before receipt creation, combined
refunded/disputed uncredited captures, pending refunds, provider stop, financial
hold resolution, dispute costs/transfers/payouts and hosted acceptance remain
unfinished. This is not full lifecycle or deployment readiness.

## Original-payment failure and authentication classification

The shared original-admission reader now feeds both captured-receipt inspection
and unpaid recovery. The existing inspectUnpaidExactRecovery classifier accepts
the genuine buyer authorization without booking identity. Recovery persists a
collection hold before reads, then records action_required, payment_method_required,
payment_pending, terminal_unpaid, paid_accounted or review_required against the
original invoice/PI. Snapshot comparison prevents stale unpaid observations from
replacing receipt accounting or newer recovery state. Paid outcomes require the
existing capture/receipt reconciler. No pay, confirm, cancellation or fresh charge
is issued by this observer. Terminal unpaid does not waive the fixed obligation.

Signed invoice failure/action-required and PaymentIntent failure/action-required
events now route to this gated observer. Collection can invoke it after its one
admitted dispatch. Known refund/dispute evidence is resolved first even for late
failure events. The recovery records are not authorization for another debit.

Default-off gates: CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY and
CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY. Migration
20260921060534_buyer_mentorship_payment_recovery.sql remains unapplied.
Authenticated bank challenge, replacement-card/retry actions, recovery hold
release, buyer management and hosted acceptance remain unfinished.

## Authenticated original-payment bank challenge

The saved-reservation POST now accepts bank_verification and check_payment with
an invoiceId, in addition to the existing revoke_debit action. Authentication,
exact origin, owned reservation and strict body fields precede capability release.
Responses remain private/no-store. check_payment invokes original receipt recovery;
browser assertions of payment success are not accepted.

Bank verification reuses the existing SDK challenge inspector, original-admission
reader, prior-provider-history checks and buyer subscription inspector. It checks
the original card's US billing country and the exact subscription schedule, permits
past_due only for this buyer recovery path, and rereads local billing/recovery state
after provider checks. SQL requires action_required, original unpaid admission,
all prior receipts, no financial hold/refund/dispute and no revoked debit. No secret
is stored/logged and the server never confirms or creates a charge. A stop after
capability release remains part of required hosted race acceptance.

Default-off gates: CREATOR_MENTORSHIP_INSTALLMENT_BANK_SCHEMA_READY and
CREATOR_MENTORSHIP_INSTALLMENT_BANK_READY (plus existing recovery gates).
Migration 20260921061517_buyer_mentorship_bank_verification.sql remains unapplied.
Buyer-screen integration, actual issuer challenge, post-SDK receipt proof, recovery
hold release, replacement cards and hosted acceptance are still outstanding.
