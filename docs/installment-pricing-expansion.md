# Installment pricing expansion — implementation in progress

> Integration numbering note (2026-09-07): the unapplied exact-installment sources are now **040–057**. Explicit filenames below use the canonical names; older numbered checkpoint references, test results, and captured hashes retain their historical 022–039 meaning. See [the migration map](exact-installment-migration-map.md) for the current sequence and new local acceptance. Historical results are not approval to install the renamed candidate.

Owner decision September 5, 2026: **expand installment pricing before launch**.
This supersedes the earlier open choice to launch with current restrictions.
No production release, policy publication, live transaction, charge-model
change or modification of existing agreements is authorized by this document.

## Scope

Support ordinary fixed-total installment prices, including totals that do not
divide evenly into cents, without changing the agreed total, silently moving
processing costs onto CreatorNet, or removing fee verification. Keep existing
CreatorNet booking/creator screens and styling. Monthly memberships, minimum
commitments, renewal choices and new paid-call functionality remain separate.

## Latest checkpoint — September 6 exact-cent checkout/link publication

The existing creator-owned booking endpoint now selects the explicitly
allowlisted exact-cent path before the legacy divisibility/percentage checks.
Migration 039 atomically reserves a new owned agreement/payment from actual
booking/product data and freezes the first-payment estimate/version. The service
prepares and seeds the original Checkout, verifies its current provider objects
and immutable request hash, then publishes only through a private RPC that
rechecks ownership, unpaid state, holds and exact bindings. Repeated/lost requests
reuse the original link; old payments and purchases cannot be converted.
The existing dark-theme payment card now labels the first-payment estimate and
any final-cent adjustment without changing its booking controls or request body.
See [checkout implementation and acceptance](installment-checkout-publication.md).

**2335 tests / 99 suites passed** (108 additional tests), standalone TypeScript,
targeted ESLint error checks and an optimized process-only synthetic-env build
passed. New modules/tests are lint-clean; the touched older routes/page retain
33 existing warnings. The build retained the existing dynamic-cookie diagnostics
and intentionally unreachable `example.invalid` sitemap fallback, then exited
zero. No `.env` file was read or changed.

All new gates remain off/unconfigured. No commit, push, hosted migration,
configuration/credential change, Stripe mutation, public policy publication or
production deployment occurred in this checkpoint. Migrations 022–039 remain
local-only. **Not deploy-ready:** full candidate/migration review, hosted staging
first/monthly/final payment and recovery acceptance, concurrency checks, policy
alignment, visual QA and the existing release gate are still required.

## Previous checkpoint — September 6 bounded monthly HTTP collection

The canonical webhook now has a default-off, staging-only monthly collection
path restricted to explicitly selected persisted agreement UUIDs (maximum ten).
Only `invoice.created` can request a new debit, behind all schema, hold, refund,
billing-stop, lifecycle, recovery and admin readiness acknowledgements. Existing
collection flags alone still cannot enable it. Actual invoice/receipt/card/fee
checks and durable once-only dispatch remain mandatory. Receipt events cannot
prepare, finalize or pay an unpaid invoice. Duplicate/lost-response handling
reconciles the original admission. See the
[implementation and configuration contract](installment-monthly-webhook-collection.md).

No new gate was enabled, no fixture was selected, and no hosted configuration,
Stripe object, public policy, credential or production deployment was changed.
Migrations 022–038 remain local-only. The worker remains inspect/prepare only;
no cron, broad collection endpoint or automatic catch-up was added. Checkout/link
publication integration, full hosted staging acceptance, policy alignment,
visual QA and existing release gates remain open. This is **not deploy-ready**.

Verification passed: **2227 tests / 98 suites** (76 additional tests), standalone
TypeScript, targeted ESLint and an optimized local build with process-only
synthetic credentials. The existing dynamic-cookie diagnostics and intentionally
unreachable `example.invalid` sitemap fallback remain; the build exited zero.
No `.env` file was read or changed. Real-signature/HTTP tests use synthetic
database and Stripe ports; this is not hosted concurrency or payment acceptance.
No commit, push, hosted migration or deployment was performed in this checkpoint.

## Previous checkpoint — September 6 optional same-plan future card

The owner approved the recommended separate, optional **unchecked** buyer
checkbox. It is now implemented as a local candidate on the existing recovery
page/API, not a new obligation or a change to the original agreement. The review
shows the remaining original amounts and UTC dates. One-time replacement-card
payment remains available with the option unchecked. See
[future-card implementation and acceptance](installment-future-card-consent.md).

Migration 038 records the exact wording, version, accepted/declined choice,
confirmation identity and remaining schedule separately. Old quotes and old
confirmations cannot acquire future authority. The new decision and current
payment consent are atomic; replay/lost-response handling never adds a payment.
The next new invoice can bind the new card only after the current retry has an
independent admission and a verified, credited receipt. Its recovery hold is
archived in full, in the same transaction as existing renewal readiness checks.
Other holds, refunds, disputes, stops, amount changes and schedule changes still
block collection and roll that archival back. Already-admitted later payments
retain their original card binding for reconciliation after a refund or stop.

Stripe customer and subscription defaults are **not** changed. The existing
manual exact-invoice collector passes the separately authorized card for that
invoice only. There is no resumed Stripe automatic advance, catch-up collection,
balance acceleration, new installment, or change to a different purchase.
`CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY` is an additional default-off gate;
all existing Preview/test-only and collection gates still apply.

Verification passed: **2151 tests / 96 suites** (57 additional tests), standalone
TypeScript, targeted ESLint and an optimized local build using synthetic,
process-only credentials. The build retained the existing dynamic-cookie
diagnostics and intentionally unreachable sitemap fallback, then exited zero.
No `.env` was read or changed. No commit/push, hosted
migration, hosted configuration, Stripe mutation, public policy publication or
production deployment was performed for this change. Migrations 022–038 remain
local-only. This candidate is **not deploy-ready**: full hosted staging payment/
3DS/future-renewal acceptance, collection integration, prospective policy
alignment, visual QA and the existing release gates remain open.

## Previous checkpoint — September 6 buyer payment action and bank verification

**Not deploy-ready.** The new pay-now mode is connected locally to the existing
authenticated buyer controller and dark-theme recovery page. Old record-only
quotes remain permanently record-only; they cannot become charges through a
flag change. Fresh explicit consent consumes the existing once-only admission.
Repeated clicks, lost responses, page loads and refreshes cannot dispatch another
payment. Local results are **2094 tests / 96 suites passing**, TypeScript and
targeted ESLint passing, and an optimized local build passing with synthetic
process-only credentials. No `.env` was read or changed. The existing dynamic
cookie messages and intentionally unreachable sitemap fallback remain.

New migration `055-exact-installment-bank-verification.sql` and
`bankVerification.ts` bind bank verification to the original admitted invoice/PI,
authenticated buyer, exact cents, destination, and original or independently
admitted replacement card. The service-only action reader preserves prior
receipt/refund/dispute, active purchase, booking, period and hold checks. It runs
again after Stripe reads. It cannot admit/pay, replace defaults, release holds,
or rewrite financial evidence. A separate receipt-only mode can reconcile money
already captured after a later stop; it cannot open another bank challenge.

The explicit **Verify $amount with bank** action uses Stripe's official
`handleNextAction`, only for `requires_action` / `use_stripe_sdk` on the original
automatic-confirmation/card PI. `@stripe/stripe-js` is pinned to 9.15.0 and uses
the pure loader, so importing the page does not load Stripe.js. The ephemeral
capability stays out of React state, URLs, storage and application logs. Only an
authenticated, same-origin POST can return it, with private/no-store headers.
GET returns status only. A canceled/failed/successful SDK result is never a
receipt: the server must verify the invoice, captured charge, integer fee,
destination and balance before the page describes payment as verified.

Local coverage includes original-card and replacement-card bank flows; altered
owners/cards/amounts/fees; refund/dispute/default changes; duplicate clicks;
lost responses; malformed results; SDK cancellation/error; private API access;
and 30 new local PostgreSQL bank-context cases. Single-connection PGlite and
mocked Stripe ports do not prove hosted concurrency or end-to-end 3DS completion.
The server cannot revoke a capability already returned if a stop races afterward;
the actual bank-challenge/stop interleaving remains a required staging gate.

### Bounded Stripe Sandbox observation in this checkpoint

With the owner's specific approval, created one isolated no-email/no-phone test
customer `cus_VD9nU2X0tGH5TP`, manual invoice
`in_1UCjUIAPff7wDYc9OgeasgKm`, and invoice item
`ii_1UCjUhAPff7wDYc9bL4XsqCN` for 66633 cents with a configured 10425-cent
application fee and test destination `acct_1UC6hDA7O6tXliwA`. No subscription
or billing schedule was created. Attached Stripe's verification-required fake
card as `pm_1UCjV3APff7wDYc9f6Gb173g`; no default card was changed. Finalized
only this invoice with `auto_advance=false`, then sent exactly one approved
on-session invoice-pay request. Stripe returned
`invoice_payment_intent_requires_action` (request `req_uPANaK44y4AmFl`).

The existing default invoice payment `inpay_1UCjVFAPff7wDYc9qWdg922W` remained
linked to `pi_3UCjVFAPff7wDYc91mQtAjSc`. A subsequent PI read showed
`requires_action`, `next_action.type=use_stripe_sdk`, 66633 cents amount,
zero received/capturable, exact 10425-cent fee, expected test destination/card,
automatic confirmation/capture, and no charge. Final invoice read: open,
66633 cents due/remaining, zero paid, attempted=true, attempt_count=0,
auto_advance=false, next_payment_attempt=null, no paid timestamp. Do not infer
number of API attempts from Stripe's attempt_count. No bank challenge was
completed and no second pay request was sent. This manual fixture has no app
agreement and MUST NOT be adopted into application accounting or counted as
full staging acceptance. The first customer request was definitively rejected
for an unsupported Workbench idempotency parameter; only its corrected request
created the customer.

No commit, push, hosted migration, configuration change, deployment or live
payment occurred. Migrations 022–037 remain local-only; new gates are still off,
including `CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY`. HTTP monthly
collection remains forced off. Browser policy previously blocked the local
visual preview; no bypass was attempted and desktop/mobile visual QA is open.

Remaining gates: scoped recovery-hold resolution and future-card authorization
(current retry consent is for this one invoice, not changing future defaults),
payable-link/monthly collection integration, full new-candidate hosted staging
acceptance, prospective policy/consent alignment, backup/recovery verification,
and a candidate-specific release plan. Stop before production. Do not call these
119 additional local tests completion of those gates.

At that previous checkpoint, the next owner decision requested was a separate explicit buyer authorization to
use the replacement card for the remaining scheduled installments. This is not
yet approved or implemented then. The newer checkpoint above supersedes that
decision status. No future default, original
consent, billing hold, existing purchase or public policy was changed.

Primary references: [Stripe handleNextAction](https://docs.stripe.com/js/payment_intents/handle_next_action),
[official Stripe.js loader](https://github.com/stripe/stripe-js),
[invoice pay](https://docs.stripe.com/api/invoices/pay),
[Stripe test cards](https://docs.stripe.com/testing?testing-method=payment-methods).

## Earlier checkpoint — September 6 local retry admission and receipt accounting

**Not deploy-ready.** Migrations `053-exact-installment-retry-admission.sql` and
`054-exact-installment-payment-intent-version.sql`, `paymentRetryStore.ts` and
`paymentRetry.ts` implement the next local backend
candidate. No commit, push, hosted migration, deployment, environment change,
new Stripe object or real payment was made. Read-only browser inspection showed
the existing staging buyer profile still signed in as `qa_buyer_20260904`.

- A confirmed, unexpired quote and verified saved card can consume one permanent
  retry admission for the original invoice/PI. No reset or reusable lease exists.
  Public roles cannot use it; the service role cannot directly insert/update/delete
  admission records. A lost admission acknowledgement never permits a pay call.
- Admission retains all 027 prior receipt, ledger, refund/dispute mirror,
  purchase, booking and activation checks. Only that exact invoice's recovery
  hold is compatible with this explicit retry. Additional holds/stops block it.
  No hold is removed, even transiently; ordinary renewal still rejects every hold.
- The server re-verifies customer-owned card setup, the original unpaid invoice,
  default PI, exact amount/fee/destination, previous Stripe payments and their
  refund/dispute state, and the unchanged held subscription/defaults. Only this
  explicit retry path additionally accepts `past_due` with the verified future
  end date; normal renewal/activation retain their strict default.
- One fresh admission permits one original-invoice `pay` call with the saved
  replacement card, `off_session:false`, stable idempotency key and zero SDK
  retries. Timeout, decline, SCA and repeated requests only reconcile afterward.
  **This executor is not yet connected to the buyer HTTP confirmation action.**
- Replacement-card receipt reconciliation requires its independent admission,
  the immutable original claim, exact invoice/PI/card/fee/destination/balance,
  and capture no earlier than the new admission. Existing once-only accounting
  remains in force. Captured money can reconcile after a later stop without
  restarting billing, replacing defaults, changing access or waiving debt.
- Gated webhook recovery recognizes an independently admitted replacement card
  but cannot admit/pay. With the schema flag off it never queries the new table.
  Its optimistic database basis now includes retry admission, so an earlier
  observation cannot overwrite a new attempt's recovery state.
- Original authorizations and the earlier manual Sandbox fixture remain intact.
  The manual fixture still fails app-authorization/time checks; no history was
  rewritten to turn an isolated API test into application acceptance.
- Migration 036 permanently separates `single-invoice-retry-v1` (record only)
  from `single-invoice-pay-now-v1`. Review and confirmation must match the saved
  version. The executor and SQL admission accept only pay-now; old confirmations
  cannot become deferred charges after a flag change. The old three-argument
  quote RPC remains strictly record-only. Both migrations are unapplied candidates.

Verification: **1975 tests / 93 suites pass**, including 62 new synthetic
retry/receipt/webhook cases and 43 local PostgreSQL admission/interleaving cases.
TypeScript, targeted ESLint and the optimized local build pass. The build used
process-only synthetic credentials, with the existing dynamic-cookie messages
and intentionally unreachable `example.invalid` sitemap fallback. No `.env`
file was read/changed. Single-connection PGlite and mock Stripe ports do not
prove hosted concurrency or actual bank-challenge behavior.

`CREATOR_EXACT_INSTALLMENTS_RETRY_READY` and
`CREATOR_EXACT_INSTALLMENTS_SANDBOX_BUYER_RETRY` remain unconfigured/off.
Migrations 022–036 are local-only. Buyer UI still explicitly records confirmation
only; the HTTP monthly-collection boundary still forces collection off.

Remaining implementation and acceptance gates:

1. Connect the pay-now mode to a fresh explicit buyer action and matching UI
   wording before wiring the executor. Database version binding is implemented;
   old record-only confirmations remain permanently ineligible for collection.
2. Complete owner-only bank/SCA handling of an already admitted payment, with
   ephemeral secrets, no automatic new attempt, and verified reconciliation.
3. Finish scoped hold resolution. Current retry consent does not authorize
   replacing the future subscription default or resuming automatic collection.
4. Accept the eventual candidate in isolated hosted staging: full fixed-count
   cycle, exact fees/final cent, buyer retry/SCA, refund/stop/dispute races,
   duplicate/out-of-order events and desktop/mobile UI. Earlier local preview
   access was blocked by browser policy; no bypass was attempted and visual QA
   remains unverified. Historical hosted tests do not validate this new code.
5. Reconcile the complete release checklist and stop before production approval.

## Earlier checkpoint — September 6 local buyer recovery and confirmation

**Not deploy-ready.** The authenticated buyer route and dark-theme recovery
screen are implemented locally at `/payments/recovery/[agreementId]`, with
`/api/installments/recovery`, `buyerRecovery.ts` and migration
`052-exact-installment-payment-confirmation.sql`. No commit, push, deployment,
hosted migration, environment change or Stripe request was made in this checkpoint.

- The page and API fail closed outside the exact staging environment and new
  explicit feature gates. Verified Supabase identity, immutable agreement
  ownership, same-origin POSTs, strict action/consent payloads and private
  no-store responses protect the boundary. Buyer IDs, amounts, card/customer
  IDs and arbitrary URLs cannot be supplied in a request body.
- The screen separates card saving, server-derived amount review and explicit
  payment confirmation. It preserves the existing black/white/purple customer
  styling. A return URL never proves success, and checking a card cannot charge
  it. Mounting or refreshing the page sends no payment or consent mutation.
- Setup-only handoff has its own gate and verifies the original held invoice,
  buyer/customer, bound setup-mode session, trusted return route and Stripe host
  before returning its URL. The setup return target is now the recovery page;
  the earlier unpublished `/library?card_setup=...` proposal is superseded.
- Migration 034 derives the exact invoice amount/fee and immutable original
  authorization, binds the verified replacement card, and gives each review
  at most five minutes. Confirmation rechecks eligibility under the agreement
  lock. A unique confirmed-invoice index rejects competing stale tabs; an exact
  replay returns saved consent, not new dispatch permission. Public database
  roles have no table/RPC access, and service-role direct writes are revoked.
- Card saving and confirmation preserve the original activation, invoice claim,
  access, fees and holds. **This version only records confirmation. It does not
  execute the replacement-card payment or restart collection.** The staging
  screen states this explicitly. Recorded consent is not a payment receipt;
  only saved `paid_accounted` evidence displays verified payment completion.
- Pending payments, bank verification, stops, disputes, expired reviews and
  uncertain responses cannot turn into automatic retries. Double clicks are
  blocked; a successful read-only refresh reveals any saved confirmation.

Verification: **1870 tests / 92 suites pass**, including buyer service/API/UI
checks, setup-URL validation and local PostgreSQL confirmation tests. TypeScript
and targeted ESLint pass. The optimized build with process-only synthetic CI
values passed during this checkpoint; it retained the existing dynamic-cookie
prerender messages and intentionally unreachable `example.invalid` sitemap
fallback. No `.env` files were read or changed.

An offline preview generator renders the actual component with synthetic data
and the actual app CSS: `test-support/preview-payment-recovery.mjs`. Browser
security policy blocked opening the local preview, so **desktop/mobile visual
QA is not verified**; no alternate browser or policy workaround was attempted.
Local component tests are not a substitute for hosted UI/Stripe acceptance.

Still required: durable once-only replacement-payment dispatch, bank/SCA payment
completion, replacement-authorized receipt reconciliation and scoped hold
resolution, followed by full new-candidate staging and release-gate acceptance.
A collector must revalidate current state and authorization lifetime; it must
not blindly process saved confirmations later. The HTTP monthly-collection
boundary still forces collection off. Migrations 022–034 remain local-only.
New `BUYER_RECOVERY_READY`, `CARD_SETUP_PUBLISH_READY` and
`PAYMENT_CONFIRMATION_READY` flags (all with the `CREATOR_EXACT_INSTALLMENTS_`
prefix) remain unconfigured, as do the earlier new-flow flags. Stop before
production; no public policy wording or existing purchase agreement changed.

## Earlier checkpoint — September 6 local replacement-card setup

**Not deploy-ready.** Implemented the card-saving backend candidate in
`lib/installments/cardRecovery.ts` with local migration
`051-exact-installment-card-setup.sql`. This checkpoint made no Stripe request,
hosted database/configuration change, commit, push or deployment. Existing
Stripe fixtures and all production settings remain untouched.

The new step is deliberately **save card, not retry payment**:

- A service-only reservation records the buyer, original invoice/PI,
  immutable authorization snapshot and `replacement-card-setup-v1` consent
  version. A future authenticated buyer route must display the exact versioned
  consent text and require explicit acceptance before calling it; a webhook or
  background worker must not create buyer consent.
- The database derives the binding from the existing admitted invoice. It
  rejects other buyers, non-declined/paid invoices, expired periods and additional
  stop/refund/dispute holds. Stale tabs cannot allocate a second setup for the
  same invoice. The one-hour setup window never renews on retries.
- The server rechecks the held subscription, original unpaid invoice/default
  payment link/PI, amount, integer fee, destination and original card. It can
  create only card-only, hosted **setup-mode** Checkout, using a stable request
  key and `maxNetworkRetries=0`. Known sessions are retrieved, not recreated;
  uncertain creation cannot restart outside the conservative creation window.
- Verification retrieves the bound Checkout, successful SetupIntent and the
  saved customer-owned card. A return URL, pending authentication, mismatched
  metadata/customer, live object, or stale stop/payment is not accepted as proof.
  Only setup evidence is saved. Original authorization, defaults, claim,
  collection holds, access and ledger are unchanged. The result explicitly says
  `card_saved_payment_not_attempted`.
- No client secret, hosted payment URL, card number or raw provider/error
  payload is stored or returned. The preparation result remains
  `prepared_unpublished`: there is no route import, public setup link or enabled
  customer-facing flow. The `/library?card_setup=...` return target is a prepared
  contract only; its dedicated return handling is not yet implemented.

The setup-mode and successful-SetupIntent contracts follow Stripe's
[save-without-payment guidance](https://docs.stripe.com/payments/save-and-reuse?platform=web&ui=elements)
and [Setup Intents lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle?payment-setup-intent=setupintent).
They have **not** been verified against an actual hosted setup in this candidate.
Saving may require bank authentication; it is not a successful installment or
permission to restart automatic collection. The broader monthly-payment terms
remain separate and unpublished.

Verification: **1793 tests / 89 suites pass**, including 42 new setup service
tests and 18 local PostgreSQL cases. TypeScript and targeted ESLint pass.
The local database suite found a reserved SQL column-name error during
development; it was corrected to `authorization_snapshot` before the full
passing run. Migration 033 was executed only in isolated in-memory PGlite.
These ordered race tests are not proof of hosted multi-worker concurrency.
No new optimized build was run in this checkpoint.

Remaining: authenticated buyer UI/return handling in the existing style,
separate payment-confirmation/append-only retry authorization, SCA completion,
exact original-invoice collection, receipt reconciliation and appropriately
scoped hold resolution. Do not update `activation_snapshot` to adopt a new card:
the existing invoice claim derives its original authorization from that snapshot.
Any future replacement needs versioned authorization without rewriting past
claims. Then run fresh full-candidate staging acceptance. New flags remain off;
migrations 022–033 remain unapplied to hosted staging. Stop before production.

## Earlier checkpoint — September 6 isolated Sandbox recovery

**Not deploy-ready.** The owner separately approved attaching Stripe's fake
working Visa and making one payment attempt against the same held $666.33
Sandbox invoice. That manual recovery succeeded. This verifies Stripe API
behavior, not the candidate's buyer-authorized recovery flow. No app agreement,
purchase, ledger, migration, feature flag, default card, collection resume,
production setting or deployment was changed in this checkpoint.

Verified through Stripe Sandbox using API version `2025-10-29.clover`:

- Attached `pm_card_visa` only to the isolated `cus_VD0sZwdcE6C5cM`; returned
  `pm_1UCdvhAPff7wDYc97uqN8pLY`, test mode/card type, null billing identity.
  Submitted `invoices.pay` once with that method and `off_session=true`,
  omitting the mutually exclusive optional flags corrected previously.
- Same invoice `in_1UCayrAPff7wDYc9YxpheVvg` is now **paid**: 66633 cents due
  and paid, zero remaining/overpaid, `auto_advance=false`, no next payment
  attempt, `livemode=false`. Its default invoice-payment list has exactly one
  entry (`has_more=false`), the original `inpay_1UCb0uAPff7wDYc98o3in6A3`, now
  paid for 66633 cents and still linked to `pi_3UCb0uAPff7wDYc92i1dqfwR`.
- Original PI is succeeded, received 66633 cents, zero capturable, no last
  payment error/next action, exact application fee 10425 cents, the new test
  method, and the same test creator destination `acct_1UC6hDA7O6tXliwA`.
- Successful charge `ch_3UCb0uAPff7wDYc92Pgyeuix` captured 66633 cents, paid
  and succeeded, zero refunded, test mode, with the original PI/customer and
  the replacement test method. Its application fee
  `fee_1UCdwhA7O6tXliwAMa11NkEr` independently returns amount 10425 cents,
  USD, zero refunded and the correct connected account. The fee object's
  `originating_transaction` matches this successful platform charge; its
  connected-account `charge` is a separate `py_` object.
- Charge balance transaction `txn_3UCb0uAPff7wDYc92xM6fbOT` has gross 66633
  cents, Stripe processing fee 1962 cents and net 64671 cents, with this charge
  as source. That balance transaction is pending. Its net is **not** the
  creator's final payout. The 10425-cent application fee is the configured
  synthetic platform-plus-processing deduction, not all platform revenue;
  separate Billing charges were not verified here.
- Subscription `sub_1UCarvAPff7wDYc9CV5HHhIH` is active again, while
  `pause_collection.behavior=keep_as_draft`, `resumes_at=null`,
  `default_payment_method=null` and `ended_at=null` remain. Recovery did not
  enable future automatic collection. No refund, extra invoice, replacement PI,
  clock advance or automatic retry was submitted in this checkpoint.

The invoice's `attempt_count` remains 1 after the earlier declined attempt and
this subsequent manual success. It is **not a total manual-attempt counter**:
Stripe documents that after the first attempt, only automatic retries increment
it. The recorded requests and separate failed/successful charges establish what
happened; do not use this counter to authorize another debit.
[Stripe invoice attempt_count](https://docs.stripe.com/api/invoices/object?api-version=2025-10-29.clover).
The earlier failed charge/event evidence remains recorded below; it was not
deleted or changed by the application.

Two boundaries prevent calling this a full application acceptance pass:

1. The isolated fixture has no matching CreatorNet agreement, and the paid PI
   used a replacement method. Existing original-card authorization must not be
   rewritten to adopt it. Buyer consent, versioned replacement authorization,
   once-only dispatch and hold resolution still need implementation/testing.
2. The test clock's invoice line starts at `1788853798`, whereas this manual
   charge was created at `1788692951`. The actual API capture timestamp is
   earlier than the future service period. This fixture cannot satisfy the
   candidate's existing receipt-time validation. Preserve that predicate;
   use a separately reviewed time-consistent application acceptance fixture.

Added local regressions for both boundaries: neither a paid replacement card
nor a pre-period capture can grant credit, resolve the recovery hold, or submit
another payment. These tests preserve existing behavior; no runtime guard or UI
was changed. Verification for this checkpoint: **1733 tests / 88 suites pass**;
134 targeted recovery/renewal/lifecycle tests pass; TypeScript and targeted
ESLint pass. No new build, commit, push, hosted migration or deployment was run.

Next: buyer-authorized new-card/SCA recovery integration and complete fresh
candidate Checkout/database/webhook/renewal/refund/dispute/replay/concurrency
acceptance. Do not retry this already-paid invoice. Stop before production.

## Earlier checkpoint — September 6 isolated Sandbox decline

**Not deploy-ready.** The owner approved attaching Stripe's synthetic
decline-after-attaching card to the existing isolated customer and attempting
its $666.33 invoice once. The actual payment attempt declined. No second payment
attempt, successful collection, subscription resume, production change, hosted
application migration or deployment was performed.

Verified through Stripe Sandbox, using `2025-10-29.clover` for API requests:

- Attached only `pm_card_chargeCustomerFail` to `cus_VD0sZwdcE6C5cM`; Stripe
  returned `pm_1UCdfFAPff7wDYc92M81hg6D`, `livemode=false`, card type, and null
  billing contact/address details. No customer or subscription default was set.
- The first pay request included both optional `forgive=false` and
  `paid_out_of_band=false`. Stripe rejected that combination with
  `invalid_request_error` / `multi_exclusive_parameters`. A fresh invoice read
  proved `attempt_count=0`, `attempted=false`, and zero paid before correcting
  the request. This was a rejected API request, not a card attempt. The corrected
  request supplied only the exact attached method and `off_session=true`.
- `in_1UCayrAPff7wDYc9YxpheVvg` is still open: 66633 cents due/remaining, zero
  paid, `attempt_count=1`, `attempted=true`, `auto_advance=false`, and no next
  payment attempt. Stripe returned `card_declined` / `generic_decline`.
- Original `pi_3UCb0uAPff7wDYc92i1dqfwR` remains bound to that invoice through
  the same sole default `inpay_1UCb0uAPff7wDYc98o3in6A3` (open, no paid amount,
  66633 requested, no additional list entries). PI status is
  `requires_payment_method`; `payment_method` is now null, received/capturable
  amounts are zero, and no next action or cancellation is present. Its amount
  remains 66633 and exact configured application fee remains 10425 cents, with
  the original test destination `acct_1UC6hDA7O6tXliwA` and no transfer-amount
  override. This is still a configured synthetic deduction, not collected fees.
- Its failed charge `ch_3UCb0uAPff7wDYc92fo2bwuU` references the exact customer,
  original PI and newly attached test method. It is failed, unpaid, uncaptured,
  with zero captured/refunded amounts, null balance transaction and null
  application-fee object. No funds were captured.
- `sub_1UCarvAPff7wDYc9CV5HHhIH` moved from active to `past_due`, while
  `pause_collection.behavior=keep_as_draft`, no resume time, default method null,
  save-default off and `ended_at=null` remain. Do not mistake a decline for
  completed cancellation, forgiven debt or a permanently unpaid terminal invoice.
- Actual event `evt_1UCdgXAPff7wDYc9VgMii66a` is `invoice.payment_failed`, created
  `1788691949`, `livemode=false`, and matches this invoice/customer/subscription
  with one attempt and zero paid. Its snapshot API version is
  `2025-09-30.clover`, distinct from the retrieval request version. The event's
  `pending_webhooks=0` is not evidence of this new candidate's fulfillment or
  recovery handler acceptance. No event was resent.

Found and corrected a matching **local candidate defect**: `renewal.ts` also
sent both `forgive=false` and `paid_out_of_band=false`. The synthetic Stripe port
now rejects that observed invalid combination before recording an attempt.
With the old source, both regular/final renewal acceptance tests failed as
`reconciliation_required`. The corrected source omits both optional parameters;
their [documented defaults are false](https://docs.stripe.com/api/invoices/pay?api-version=2025-10-29.clover).
The request retains the authorized method, off-session setting, stable original
invoice idempotency key and `maxNetworkRetries=0`. The two tests then passed.
No existing amount, fee, admission, recovery or production gate was weakened.

Local regressions also model the observed cleared-card/failed-charge shape and
verify repeated recovery observations never submit a payment or grant credit.
A separate regression proves that the attempted invoice cannot be prepared
again even if the subscription later becomes active.
This remains isolated API evidence plus local tests, not a hosted application
recovery pass. No client secret, payment URL or raw error payload is recorded.

Verification after the request correction: **1731 tests / 88 suites pass**;
132 targeted recovery/renewal/lifecycle tests pass; TypeScript, targeted ESLint
and `git diff --check` pass. The stricter request-contract regressions were
observed failing before the source correction and passing afterward. No new
build, commit, push, merge, migration or deployment was performed.

Next: buyer-authorized recovery and card-authentication testing, then complete
new-candidate Checkout/database/webhook/replay/refund/concurrency acceptance.
Any new test card attachment or payment attempt needs its own action-time
approval. Keep this original failed invoice held; do not blindly retry it,
change an existing agreement's saved card authorization, or enable collection.

Proposed next isolated API test at that checkpoint (subsequently approved and
completed in the latest checkpoint above):
attach Stripe's `pm_card_visa` success fixture to only `cus_VD0sZwdcE6C5cM`, then
make one explicitly approved payment attempt against the same
`in_1UCayrAPff7wDYc9YxpheVvg`, preserving 66633 cents due, the exact 10425-cent
configured deduction, destination and collection hold. Do not change defaults
or create another invoice. Inspect the original invoice-payment/PI binding,
successful charge and fee evidence read-only afterward. This tests provider
behavior only; implementing buyer-authorized card replacement requires a
separate persisted authorization and cannot weaken the current original-card
checks in `renewal.ts`/`paymentRecovery.ts`.

## Earlier checkpoint — September 6 unpaid classic renewal preparation

**Not deploy-ready.** After explicit owner approval, advanced only
`clock_1UCaqMAPff7wDYc9BFSEnou2` to `1788853798` and waited for Stripe to return
`ready`. The existing isolated no-card classic subscription generated one draft
renewal invoice. Configured its integer fee and finalized **only that invoice**
with automatic collection disabled. No `pay`, card attachment, payment
confirmation, subscription resume or production mutation was performed.

Verified in Stripe Sandbox with API version `2025-10-29.clover`:

- Renewal invoice `in_1UCayrAPff7wDYc9YxpheVvg`, number `KUGRMFOD-0002`: total,
  subtotal and amount remaining 66633 cents; amount paid zero; `open`,
  `auto_advance=false`, `attempt_count=0`, `attempted=false`, no scheduled next
  payment or automatic finalization. No discounts, tax, balance or credits.
- One non-prorated monthly line `il_1UDJn0APff7wDYc9cH4OF5gT`, subscription item
  `si_VD0t4LKXLmPMex`, has service period `[1788853798,1791445798)`. Invoice header
  period instead describes the prior trial `[1788680998,1788853798)`; collection
  must continue using the verified line period, as the candidate already does.
- Exactly one default invoice-payment record
  `inpay_1UCb0uAPff7wDYc98o3in6A3`: open, `amount_requested=66633`,
  `amount_paid=null`, linked to `pi_3UCb0uAPff7wDYc92i1dqfwR`.
- A read-only lookup of that PI confirmed `livemode=false`, `amount=66633`,
  `application_fee_amount=10425`, card-only configuration, the original dummy
  customer, and destination `acct_1UC6hDA7O6tXliwA` with no explicit transfer
  amount override. Its status is `requires_payment_method`, `payment_method` and
  `latest_charge` are null, amount received/capturable both zero. The exact fee
  is the **synthetic test schedule** (12% platform plus 360bps +30c processing),
  not a claim about every actual Stripe transaction's costs. Fee was configured,
  not collected. Client secret and payment links are not stored in this document.
- Re-retrieved subscription remains active/classic, `keep_as_draft` with no
  resume time, no default card, `ended_at=null` and the original fixed end
  `1794124198`. The historical scheduled-cancellation marker is unchanged.

Added local regressions for the actual header/line period distinction and
omitted transfer amount. No payment predicate was relaxed. This remains an
API-only preparation proof: no application agreement, purchase, hosted
migration, runtime flag, checkout, ledger or webhook integration was exercised.
Failed-card/SCA, buyer-authorized recovery and the complete new-candidate staging
cycle remain open; stop before production.

Verification for this checkpoint: **1728 tests / 88 suites pass**; TypeScript,
targeted ESLint and `git diff --check` pass. No new build, commit, push or
deployment was performed. The two added regressions exercise existing checks;
they do not enable collection.

At that checkpoint, the next proposed action (subsequently approved and completed
in the latest checkpoint above) was to attach Stripe's
published `pm_card_chargeCustomerFail` fixture to only `cus_VD0sZwdcE6C5cM`,
then attempt payment exactly once on `in_1UCayrAPff7wDYc9YxpheVvg`, keeping
automatic collection and the subscription's collection hold unchanged. Stripe
documents that this synthetic method attaches successfully but payment fails:
[Stripe decline-after-attaching test data](https://docs.stripe.com/testing?testing-method=payment-methods#declined-payments).
Confirm at action time before attaching or attempting payment. Do not retry an
uncertain response, replace the invoice/PI, use real payment data, or treat an
API-only decline as application recovery acceptance.

## Earlier checkpoint — September 6 isolated classic-mode fixture

**Not deploy-ready.** The owner approved creating one isolated no-card Stripe
Sandbox subscription. Created only new synthetic Stripe objects; no application
account, Supabase row/migration, Vercel configuration, card, payment submission,
commit, push, merge or deployment was performed in this checkpoint. Existing
Sandbox evidence and production were not modified. New feature gates remain off.

Observed through Stripe's authenticated Sandbox dashboard using API version
`2025-10-29.clover`:

| Object | Isolated test ID |
| --- | --- |
| Frozen clock | `clock_1UCaqMAPff7wDYc9BFSEnou2` |
| No-card customer | `cus_VD0sZwdcE6C5cM` |
| Synthetic product | `prod_VD0st7huHukmE5` |
| Subscription | `sub_1UCarvAPff7wDYc9CV5HHhIH` |
| $0 trial bootstrap invoice | `in_1UCarvAPff7wDYc9rrORuaLV` |

- Clock remains at `1788680998` (2026-09-06 07:49:58 UTC); no clock advance was
  requested. Customer email, phone, source and default payment method are null,
  balance is zero, and `livemode=false`.
- Subscription is `classic`, `trialing`, with a two-day trial ending at
  `1788853798`, matching its billing anchor, and fixed `cancel_at=1794124198`.
  Stripe returned `canceled_at=1788680998`, `cancel_at_period_end=false` and
  `ended_at=null`. This confirms the scheduled-end correction for the actual
  classic bootstrap configuration, not only the old flexible-mode example.
- Collection was explicitly held with `keep_as_draft`, no resume time. It has
  one monthly item requested at 66633 cents, card-only configuration, no saved
  default card, no application-fee percentage, and the existing test destination
  `acct_1UC6hDA7O6tXliwA`. No collection or payment-confirmation call was made.
- Stripe automatically marked the zero-dollar trial invoice paid because its
  amount due was zero. Dashboard shows total/amount paid/remaining all $0.00 and
  **No payments yet**. This is not the first installment, a fee collection,
  fulfillment or recovery pass. The fixture uses only `cnqa_fixture` metadata,
  not a fabricated application agreement or purchase identity.
- Added a regression for the observed lifecycle fields. No fee or recovery
  predicate was weakened based on untested behavior.

Verification for this checkpoint: **1726 tests / 88 suites pass**; TypeScript,
targeted ESLint and `git diff --check` pass. Only the observed-shape regression,
an explanatory source comment and evidence documents changed. The prior
optimized build result is recorded below; no new build/deployment was performed.

Still pending: advance only this isolated clock, prepare its original renewal
invoice with collection off, then action-time-approved fake-card failure/SCA and
buyer-authorized recovery. Do not treat this API-only fixture as full candidate
Checkout/database/webhook acceptance. All release gates listed below remain.

## Earlier checkpoint — September 6 admin controls and bounded invoice preparation

**Not deploy-ready.** Local suite: **1725 tests / 88 suites pass**. TypeScript,
targeted ESLint, and the synthetic-env optimized build pass. Build output still
contains the pre-existing dynamic-cookie prerender diagnostics and the expected
unreachable synthetic sitemap fallback; exit status is 0. No `.env` files were
edited, and no hosted migration, payment, commit, push, merge or deployment was
performed in this checkpoint. Base commit remains `6b3d92f`.

New local work:

- `/admin/commerce/installments` reuses CreatorNet's existing admin components
  and lavender styling. Verified admin-only GET provides a bounded, redacted
  review list; POST requires the exact plan, an unchecked explicit confirmation,
  the original request identity, and a verified admin actor. Cross-origin,
  production and unconfigured requests are refused. Lost responses require a
  refresh; a 202/review result is never presented as a completed stop. No refund,
  access change, payment retry or debt waiver is available from this screen.
- Migration **032** enforces one original cancellation-review request per plan
  under the existing agreement lock. It preserves same-request retries and
  actor checks; it does not erase duplicate historical evidence. Apply only
  after reviewing any conflicting existing holds. All **022–032 remain local**.
  `CREATOR_EXACT_INSTALLMENTS_ADMIN_READY` stays off until this schema and the
  original stop/recovery gates are accepted in staging.
- The expired-Checkout observer re-retrieves the actual bound session and, if
  present, its original PaymentIntent. It records an expired/unsettled review
  hold without canceling a subscription, charging, refunding or changing access.
  An old expiration event cannot turn a currently completed/open Checkout into
  an abandoned one. Separate approved admin cleanup is still necessary.
- `invoiceDiscovery.ts` finds only the earliest uncounted agreed period, checks
  every bounded subscription-invoice page and refuses ambiguous, unbound,
  overdue or duplicate invoices. It never invents an invoice or skips a missed
  installment. An already-admitted invoice remains reconciliation, not a new
  attempt. Discovery itself is read-only and is not payment permission.
- `invoiceWorker.ts` adds private ten-plan keyset batches. Inspect mode is
  read-only; explicitly gated prepare mode can configure an unpaid invoice or
  reconcile its original admitted receipt through the existing checks. It
  **hard-forces collection off**, even when a caller's collection env is true.
  Provider/DB errors halt at the original item and return a safe continuation,
  not raw errors or payment URLs. No public endpoint, cron or automatic charge
  job is enabled. `DISCOVERY_READY` and `WORKER_READY` also remain unconfigured.
- Read-only reinspection of Sandbox subscription
  `sub_1UCUlbAPff7wDYc96hYf8iPC` confirmed it is `active`, with `ended_at=null`,
  `cancel_at_period_end=false`, a future `cancel_at`, and a non-null `canceled_at`
  marking the scheduling request. The old local activation/collection/observer
  predicates wrongly required that marker to be null. `scheduledEnd.ts` now
  accepts that marker only alongside an active/trialing status, the exact saved
  future end, no actual ending, and a valid historical request time. Changed
  end dates, early termination and future/invalid markers remain blocked.
  This read-only proof used the earlier flexible-mode fixture; new classic-mode
  end-to-end activation still requires its own acceptance.
- A loopback-only static fixture renders the actual review component and built
  CSS with synthetic data. Desktop and 390px content-width inspection showed
  readable cards and no clipping. This is not hosted/mobile-device acceptance;
  actual confirmation behavior is covered separately by DOM tests.

Still required: buyer verification/new-card recovery and explicitly authorized
retry/hold resolution; payable-link integration and new terms consent; accepted
collection/worker enablement; reviewed staging migration/event setup and a full
new-candidate Checkout/renewal/final-cent/failure/recovery/refund/dispute/access/
replay/concurrency cycle. Existing Sandbox acceptance predates this candidate.
Policy matching, verified owner/legal details, database/media recovery proof
and separate production approval remain release gates. Do not merge or enable
production based on local test counts.

Next external action: isolate a new no-card Sandbox subscription for recovery
and classic-mode lifecycle proof, then simulate failed-card/SCA and recovery
with Stripe test data. Computer-use action-time confirmation is required before
creating the test subscription or submitting simulated payment actions. No new
recovery fixture or test transaction was created in this checkpoint.

## Earlier checkpoint — local admitted-payment recovery

September 5 follow-up: added `lib/installments/paymentRecovery.ts` and migration
`049-exact-installment-payment-recovery.sql`. This is an internal, separately
gated **Sandbox candidate**, not a released payment-recovery UI or new charge
retry policy. No remote Stripe/Supabase changes, hosted migration, commit, push,
merge or deployment occurred. The existing UI and production path are unchanged.

- Recovery requires the original **already-admitted** renewal invoice and PI.
  It cannot adopt a prepared invoice, replace a PI, reset the dispatch claim or
  create another payment attempt. It records a durable per-invoice hold before
  Stripe reads, including while new preparation/collection is paused.
- Current invoice/default-payment/PI evidence distinguishes customer action,
  missing payment method, processing/capture, terminal unpaid and review cases.
  Immutable total/fee/destination/card/period checks remain. Delayed event status
  is not treated as current truth. No provider error text, hosted payment URL,
  client secret or card details are persisted in recovery observations.
- If the original payment actually succeeded after a timeout or lost response,
  a read-only Stripe reconciliation path verifies the invoice, captured card,
  integer fee, destination and balance before using the existing once-only
  receipt/accounting functions. It never calls prepare/admit/pay or restores
  collection. It handles the final residual cent and preserves refund/dispute
  safeguards. After credit, the observer rereads its changed local basis.
- Stale revisions and receipt-state changes cannot overwrite a newer result.
  A recorded failure/SCA status is actionable evidence, not successful payment.
  A terminal result cannot silently reopen. All review holds remain in place;
  paid recovery does not automatically authorize the next monthly charge.
- Only an **already voided invoice plus its original canceled PI**, no received
  or capturable funds, valid terminal timestamps and no conflicting last charge
  is recorded as terminal unpaid. A decline, timeout, open invoice or merely
  uncollectible invoice is insufficient. The observer itself never voids an
  invoice, cancels a PI/subscription, changes cards, refunds or submits payment.
- Terminal evidence can unblock a separately administrator-approved billing
  stop or refund after the existing identity/claim/receipt checks. It does not
  itself perform either action. The original dispatch stays consumed and the
  mentorship balance, paid count, access and debt obligation are not waived.
  Pending/unknown/capturable payments and uncredited receipts remain blockers.
- Canonical routing connects `invoice.payment_failed`,
  `invoice.payment_action_required`, `invoice.voided` and
  `invoice.marked_uncollectible` to this observer. Paid events use it only when a
  recovery record already exists; normal paid invoices keep their usual path.
  Unready known exact events fail closed; untagged legacy events stay unchanged.
  `CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY=true` requires the stop-coordination
  gate and reviewed **022–031** schema. No new flag/schema is enabled remotely.
  HTTP monthly collection is still hard-disabled.

Validation: **1625 tests / 81 suites pass**, 73 additional cases since the prior
checkpoint. TypeScript, targeted lint and the synthetic-env optimized build
pass. The database tests run actual SQL with synthetic local prerequisites and
ordered interleavings, not full hosted-schema or concurrent-worker acceptance.

Remaining: customer-facing verification/payment-method recovery with explicit
retry authorization, approved hold resolution, first-Checkout expiry and
public/admin stop wiring, payable-link publication and due-invoice discovery.
Then review/install 022–031 in isolated staging, verify event subscriptions,
and run a fresh complete Checkout/monthly/final-cent/refund/dispute/access/
replay/concurrency/recovery cycle. Policy matching, database/media recovery
proof, reviewed production enablement and owner approval remain release gates.
No existing staging result establishes acceptance of this new local candidate.

External behavior checked against Stripe's [PaymentIntent states](https://docs.stripe.com/api/payment_intents/object),
[invoice voiding](https://docs.stripe.com/api/invoices/void) and
[subscription webhook events](https://docs.stripe.com/billing/subscriptions/webhooks).

## Previous checkpoint — local dispute and subscription-event observers

September 5 follow-up: added `lib/installments/lifecycleEvents.ts`, migration
`048-exact-installment-lifecycle-events.sql`, and canonical webhook routing for
exact disputes and subscription lifecycle events. This is **local, uncommitted,
disabled candidate code**, not a hosted or production feature. No remote SQL,
Stripe mutation, credential change, commit, push, merge or deployment occurred.
The existing UI and published policy remain unchanged.

- Dispute created/updated/closed/funds-withdrawn/funds-reinstated events resolve
  the private receipt or admitted-invoice PI, then retrieve actual test Dispute,
  PaymentIntent, Charge and original balance evidence. Nullable dispute PI is
  linked through the actual charge. An exact first PI whose receipt is not yet
  bound is retried, not routed into legacy one-time accounting.
- A durable dispute hold fences new collection before slower evidence reads.
  Audit uses the original credited installment ledger, not a purchase's latest
  PI. Disputed amounts need not equal the gross charge. Existing audit-only
  responsibility remains: no creator debit, customer refund, access revocation,
  paid-count change or debt waiver is performed by these observers.
- Observation revisions and the saved activation/billing-stop basis are captured
  before Stripe reads, then compared under the agreement lock. Stale concurrent
  observations require a fresh retrieve. Conflicting terminal dispute decisions
  record review without silently reopening or reversing the earlier decision.
  Neither successful/resolved events nor retries automatically release a hold.
- Exact receipt replay now uses the same serialized dispute-audit RPC as the
  event handler instead of the legacy read-then-PATCH mirror. Another newer,
  resolved dispute cannot hide an unresolved dispute on the same payment.
  Only audit columns are mirrored; the legacy production helper is unchanged.
- Subscription created/updated/deleted/paused/resumed events retrieve current
  state and compare the saved customer, held schedule, price, dates, payment
  method and fees. Expected bootstrap/activation updates are acknowledged without
  adding a hold. Changed settings or unexpected cancellation persist a review
  hold; already-completed approved stops and fully paid scheduled endings have
  explicit observations. No observer updates Stripe or treats an event as money
  received. A review acknowledgement means a durable audit/hold, not resolution.
- Private observation storage is RLS-enabled, service-readable only, with writes
  through narrow service-only RPCs. The new lifecycle flag and all earlier
  migrations are unconfigured/unapplied remotely. Install and review **022–030**
  together before invoking this candidate; receipt audit now requires 030.
  `CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY=true` also requires the
  existing stop-coordination gate. HTTP monthly collection remains hard-disabled.

Validation: **1552 tests / 80 suites pass**, 92 additional cases since the prior
checkpoint. TypeScript, targeted lint and the optimized synthetic-env build
pass. Database coverage runs actual local SQL with synthetic prerequisites and
ordered interleavings; it is not hosted full-schema or concurrent-worker proof.

Remaining: terminal failed/SCA/unknown-charge recovery and explicit authorized
hold resolution; public/admin approved-stop and first-Checkout expiry routing;
payable-link publication and due-invoice discovery. Then review/install 022–030
in isolated staging, verify event subscriptions, and run fresh complete first
Checkout → all monthly payments → final cent/end → refund/access/dispute/replay/
concurrency/recovery acceptance. Policy matching, backup/media recovery proof,
reviewed production enablement and owner approval remain separate release gates.
Do not enable collection or publish a payable URL based on local tests alone.

External behavior checked against Stripe's [dispute object](https://docs.stripe.com/api/disputes/object)
and [webhook ordering/duplicate guidance](https://docs.stripe.com/webhooks).

## Previous checkpoint — local approved billing stop and Checkout cleanup

September 5 follow-up: added `lib/installments/billingStop.ts` and migration
`047-exact-installment-billing-stops.sql`. This is an **internal, separately gated
Sandbox candidate**, not a published cancellation endpoint, policy change or
production rollout. No remote Stripe/Supabase operation, commit, push, hosted
configuration change or deployment occurred. The existing UI remains unchanged.

- A verified administrator's explicit billing-stop request first records a
  durable review hold. Claims serialize with the existing agreement lock and
  reject changed request/actor identities. New activation and renewal admissions
  cannot proceed after the hold. An activation admitted before it may reconcile
  its saved operation; the billing stop waits until that work finishes.
- Unresolved dispatches and uncredited receipts block cleanup even after their
  leases expire. Already-admitted payments must use the original receipt and
  accounting path. There is no fresh charge retry or automatic release of a hold.
- The adapter verifies the actual isolated customer, subscription and Checkout.
  It refuses shared customers, other subscriptions/invoices, pending invoice
  items or changed subscription holds. An open unpaid first Checkout is expired;
  the resulting Session/PI must establish that it is no longer payable. If a
  purchase wins that race, its first receipt must be accounted before continuing.
- Cancellation uses `invoice_now:false` and `prorate:false`. The adapter checks
  actual canceled/ended state afterward, including after a lost API response.
  Invoice pagination verifies every returned invoice; positive paid invoices
  must be accounted against their own receipt, and open invoice payments with
  processing/SCA/capture/uncertain state require review. No direct Checkout PI
  cancellation, refund, invoice void, payment, card attachment or amount edit occurs.
- Successful completion records **future collection stopped**, not contract/debt
  forgiveness or a fully paid mentorship. Existing purchase access, balance/count,
  earnings, booking and agreement status remain unchanged. Unpaid invoices and
  evidence are retained; manual invoice collection remains a separate authorized
  action. This does not replace prospective policy decisions or public UX wiring.
- Both `CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY=true` and the new
  `CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY=true` are required. Neither the
  new flag nor migration is configured/applied remotely. The adapter is not yet
  imported by a public route. HTTP monthly collection stays hard-disabled.

Validation: **1460 tests / 79 suites pass**, 78 additional cases since the previous
checkpoint. TypeScript, targeted lint and the optimized build pass. The build
used process-only synthetic CI values, with candidate flags off. Database tests
exercise the actual local SQL with synthetic prerequisites and ordered
interleavings; they are not hosted full-schema or concurrent-worker acceptance.

Remaining: dedicated dispute/subscription event handlers; terminal failed/SCA/
unknown-charge recovery and explicit hold-resolution workflows; public/admin
integration of the approved-stop flow; payable-link publication and invoice
discovery. Review/install 022–029 in isolated staging and run a fresh complete
Checkout → monthly payments → final cent/end → refund/access/replay/concurrency/
recovery acceptance cycle. Policy matching, backup/media recovery proof, reviewed
production enablement and owner approval remain separate deployment gates.

External behavior checked against Stripe's [subscription cancellation API](https://docs.stripe.com/api/subscriptions/cancel),
[Checkout expiry API](https://docs.stripe.com/api/checkout/sessions/expire) and
[PaymentIntent cancellation restrictions](https://docs.stripe.com/api/payment_intents/cancel).

## Previous checkpoint — local refund-event accounting and review holds

September 5 follow-up: the canonical webhook's exact handoff now connects
`charge.refunded`, `refund.created`, `refund.updated` and `refund.failed` to
`lib/installments/refundEvent.ts`. This is **local, disabled candidate code**,
not configured or accepted against hosted Stripe/Supabase. No commit, push,
deployment, actual refund, policy/UI change or remote setting change occurred.

- Migration `046-exact-installment-refund-events.sql` adds event-linked private
  review holds and narrow refund-accounting RPCs. It checks the credited receipt
  and ledger identity and reuses the existing cumulative reversal arithmetic.
  It does not change purchase access, paid count, delivery, booking status or
  agreement status. A first-charge refund is still one installment, even after
  the purchase's latest PI changes; closed agreements can receive late refunds.
- The handler retrieves the PaymentIntent, Charge and original balance evidence
  and checks immutable amount/fee/destination/linkage. It persists a review hold
  before paginating actual Refund objects. Successful refund amounts must equal
  the current charge's refund total. Pending, requires-action, failed-only,
  canceled-only, inconsistent and unavailable evidence stays in reconciliation.
- Replays cannot reverse earnings twice. A previously larger local reversal
  remains held if a refund subsequently fails: no automatic earnings restoration
  or customer recollection. The existing exact admin-refund delivery marker is
  confirmed only after accounting. Stripe operations here are reads/listing only.
- Creation can be paused while refund accounting remains enabled. Both
  `CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY` and
  `CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY` require staging acknowledgement
  after installing/reviewing the migrations. Neither is configured remotely.
  Keep schema/version quarantine active for already-created exact agreements.

Validation: **1382 tests / 78 suites pass**, 70 additional cases since the prior
checkpoint. TypeScript, targeted lint and the optimized build pass; the build
used process-only synthetic CI values with all candidate flags off. Tests cover
real PostgreSQL RPCs against synthetic prerequisites, ordered/repeated/first
refunds, pending/failed states, paginated evidence, errors, private permissions
and handoff during a preparation pause. These are **not** hosted, full-schema,
Stripe end-to-end or concurrent-worker acceptance. SQL 022–028 is still local.

Remaining: dispute/subscription lifecycle handlers; failed/SCA/unknown-charge
recovery and review-hold resolution; verified cancellation and first-Checkout
cleanup; payable-link publication and invoice discovery. Configure/verify the
required refund events in staging and accept the fresh end-to-end/concurrency
matrix. HTTP collection remains hard-disabled. Policy matching, backup/media
recovery proof, reviewed production enablement/migrations and owner approval
remain separate gates.

Status/replay design follows Stripe's [refund guidance](https://docs.stripe.com/refunds),
[Refund reference](https://docs.stripe.com/api/refunds/object) and
[webhook guidance](https://docs.stripe.com/webhooks). A completed notification
does not mean a refund can never subsequently fail.

## Previous checkpoint — local collection holds and admin-refund coordination

September 5 follow-up: added migration `045-exact-installment-collection-holds.sql`
and the staging-only adapter `lib/installments/collectionHold.ts`. The existing
admin refund processor calls coordination after claiming its durable operation
and **before** any customer or application-fee refund request, including retries.
No commit, push, hosted migration, Stripe call, environment change, policy/UI edit
or deployment was performed for this checkpoint.

- A private durable hold and invoice admission lock the same agreement row.
  All previous 025 readiness checks remain in the same function identity. A hold
  blocks new preparation/dispatch; it does not pretend to recall a charge already
  admitted. Receipt recording/atomic accounting may still reconcile late success.
- Refund matching uses immutable receipt/ledger identities, including a first
  payment with no invoice ID after the purchase's latest PaymentIntent changes.
  Actor, processor token/lease and receipt ownership must match. An unresolved
  dispatch or a paid receipt not yet credited returns `reconciliation_required`
  while retaining the hold. The refund processor then makes no Stripe calls.
- Neither an expired dispatch lease nor a later failed refund releases a hold.
  A review/terminal-state recovery path is still required; there is intentionally
  no automatic unhold RPC. Once an admitted success has been fully reconciled,
  the existing refund retry can proceed using its original idempotency keys.
- The internal cancellation adapter only records an administrator-verified
  **review hold**. It is not a completed customer cancellation or debt waiver,
  does not change access, and does not expire an open first Checkout. No new
  cancellation endpoint, policy promise or Stripe cancellation was added.
- `CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY=true` is required after
  staging installation/review of 027. It is NOT configured anywhere yet. An
  enabled candidate without this acknowledgement fails closed on refund
  processing. With all candidate flags off, the legacy refund path does not
  query new tables. Keep `SCHEMA_READY` on once exact bindings exist, even when
  preparation/collection are paused; disabling every flag is not a safe rollback
  for a database containing new exact agreements.

Validation: **1312 tests / 77 suites pass**, including 43 additional cases and
ordered database interleavings. TypeScript and lint of all files changed in this
checkpoint pass, as does the optimized Next build with process-only synthetic
CI values and all new flags off. Tests use synthetic local fixtures; they are not hosted
multi-connection race, Stripe cancellation/refund, or new-flow acceptance.
SQL 022–027 remains unapplied to hosted staging. The HTTP collector is still
hard-disabled. Existing cancellation promises and production stay unchanged.

Remaining: complete dedicated refund/dispute/subscription handlers, terminal
failed/SCA/unknown-charge reconciliation and hold resolution, verified Stripe
cancellation/first-Checkout cleanup, creator-owned payable-link publication and
invoice discovery. Then review/install the complete staging schema and run fresh
end-to-end and concurrent-worker acceptance. Do not enable collection because
this local admission guard passed. Before production also close policy matching,
database/media recovery proof, migration/deploy ordering and final owner approval.
The final production configuration/enablement path also needs review after staging
acceptance: today's adapters intentionally accept only the isolated Preview and
Sandbox, and the HTTP boundary still forces collection off. Do not remove those
guards or copy staging credentials as a rollout shortcut.

## Previous checkpoint — local purchase lifecycle and HTTP handoff

September 5 follow-up: purchase seeding, first-payment delivery and HTTP handoff
are now connected **in the local working tree**. Nothing was committed, pushed,
deployed, or changed in Stripe or a hosted database. Existing UI/style, published
policies, legacy fee restrictions and payable-link creation remain unchanged.

- Migration `044-exact-installment-purchase-lifecycle.sql` inserts a fresh pending
  purchase from the private agreement, with the actual product row ID and booking
  post linkage. It checks creator/buyer/product identities and refuses to adopt
  any earlier buyer/post or buyer/product purchase. Seed retries reuse the one
  persisted purchase. It reserves the matching Checkout/subscription IDs without
  publishing a URL, granting access, creating a ledger or marking the booking paid.
- Its booking trigger rejects a conflicting Stripe binding or changed immutable
  terms for an exact agreement. It does not rewrite legacy rows. This is not yet
  a hosted multi-worker proof: competing link creation and an already in-flight
  remote Stripe creation remain explicit acceptance/reconciliation cases.
- After verified first-receipt credit, a narrow service-only fulfillment RPC
  attaches creator-supplied Discord/Whop delivery or leaves native video access
  with the existing player. It completes the sales booking, not the installment
  balance: the purchase remains active at 1/N. It does not set `first_access_at`
  merely because a resource was attached, overwrite existing delivery, or repeat
  earnings credit. Known closed/conflicting/refund/dispute state stops delivery.
- `prepareExactPurchaseSandbox` joins bootstrap/binding and the new seed step.
  A lost seed response resumes the saved agreement without another subscription.
  It still returns identifiers only, **not a customer-usable Checkout URL**.
- The canonical webhook now calls `routeHandoff.ts` after signature verification
  and durable event claim. Exact handled events bypass the legacy switch. Busy,
  unpaid, unknown or reconciliation outcomes throw; the route releases the claim
  and returns a retryable error rather than recording a completed payment.
- **Monthly collection is forced OFF at this HTTP boundary**, even if the
  collection flag is true. This explicit code stop stays until cancellation/
  refund admission and recovery are implemented and accepted. First receipt
  accounting and held activation are still Sandbox/Preview-gated. Known exact
  refund/dispute/subscription lifecycle events wait for their dedicated handlers;
  they are not silently treated as legacy one-time payments.
- `/api/confirm-purchase` now checks the exact version/binding before its old
  `mode=payment` full-purchase path. The new branch is read-only, verifies buyer
  and purchase identities, waits for first delivery, and preserves actual paid
  count/status. The response uses the existing success-page contract and styles.
  Turning preparation off does not disable binding quarantine while
  `CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY=true`. Without the installed-schema
  flag, untagged legacy traffic does not query any new table; tagged exact traffic
  fails closed. No flags have been configured remotely.

Validation: **1269 tests / 76 suites pass** (106 more than the previous checkpoint).
This includes real handler invocations with mocked network services and 37 new
in-memory PostgreSQL lifecycle tests with relevant unique/FK/nonnull constraints.
These are not deployed staging or multi-connection concurrency acceptance. SQL
022–026 remains unapplied to hosted staging. TypeScript and the optimized Next
build pass; the build used process-only synthetic CI values and all new flags
off. No environment file was written. New-module lint is clean; touched
legacy routes have 28 pre-existing `no-explicit-any` warnings and zero lint errors.

Remaining before enabling/publishing the new payment path:

1. Coordinate cancellation/admin-refund admission with in-flight invoice dispatch,
   including first-payment refunds without an invoice ID, and complete the dedicated
   lifecycle handlers. Do not remove the HTTP collection stop based on rechecks alone.
2. Finish creator-owned new-link reservation/publication, expiry/abandonment cleanup,
   explicit recurring-invoice discovery, and declined/SCA/uncertain-payment recovery.
   Preserve existing purchase/account and policy promises. No new URL should be
   published until these collection/recovery paths are accepted.
3. Review/install 022–026 in staging, compare actual prerequisites/triggers/roles,
   and run the full fresh Checkout → first receipt → every monthly installment →
   final-cent/termination → refund/access/replay/concurrency/recovery matrix.
4. Review the candidate and Preview results. **Stop before production.** Existing
   historical acceptance is not approval of this changed implementation.

## Previous checkpoint — local renewal collector and event bridge, not enabled

September 5 follow-up: added the renewal collection/accounting candidate and a
Checkout/invoice event handoff on top of the existing activation work. These
modules are still **not imported by an enabled app route**. No Stripe request,
hosted SQL, environment change, commit, push, deployment or production mutation
was performed in this step. The current Buy/Book UI is unchanged.

- `043-exact-installment-invoice-claims.sql` binds exactly one Stripe invoice to
  an expected installment period. Its service-only RPCs derive the fee, amount,
  saved-card ID, customer and dates from the immutable agreement/activation.
  They reject premature/expired periods, skipped credits, another invoice for
  the same period, invalid ownership and known refund/dispute/closed states.
  Preparation claims use leases and the conservative 20-hour ambiguity limit.
  The final dispatch admission rechecks local eligibility.
- `renewal.ts` prepares the actual default invoice PaymentIntent's exact fee,
  rechecks prior captured Stripe charges for refunds/disputes, verifies the
  saved card and customer balance, rechecks the invoice, then admits **one**
  off-session invoice pay request. It never resumes the subscription globally.
  SDK retries are disabled for this pay call. A lost response is retrieved;
  declines, SCA, incomplete/uncertain payment and even a lost admission response
  require reconciliation rather than another debit. This is safety behavior,
  **not a completed customer recovery experience**.
- Paid renewal reconciliation validates the invoice, default invoice-payment
  link, captured card charge, actual PI fee/destination and balance transaction
  before recording a receipt and invoking the existing exact accounting RPC.
  Known refunds are mirrored before credit. Receipt replay cannot credit twice.
  The agreement completes only after all N distinct receipts are credited and
  their sum matches the fixed total; Stripe's fixed end remains unchanged.
- `eventBridge.ts` resolves persisted session/subscription/intent identities.
  Bound Checkout completion goes through exact first-receipt credit and held
  activation, not the old one-time earnings routine. Renewals go through the
  new collector. A zero bootstrap is not counted as an installment. Untagged
  known invoice PIs remain separate from legacy accounting. Unknown tagged
  events fail closed; expiry/abandonment cleanup is explicitly not implemented.
  The bridge assumes an event already verified and claimed by the canonical
  webhook handler; it is not itself an authenticated public endpoint.

New flags exist only as code checks; none was configured in Vercel:

- `CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT=true` is additionally required to
  admit a pay call; otherwise the candidate stops at a verified unpaid invoice.
- After schema/route installation, `CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY`
  must remain true during a preparation/collection pause so known untagged
  events are quarantined, not silently routed through legacy payment code.
  This flag is not authorization to charge. Existing Preview/test-key/staging
  project/trusted-origin and per-object `livemode=false` gates remain required.

Validation: **1163 tests / 72 suites pass**, TypeScript passes, targeted lint has
zero errors/warnings, optimized Next build passes with synthetic CI variables
and all new flags off, and tracked/new-file whitespace checks pass. This adds
111 tests over the previous checkpoint (20 database, 41 renewal, 25 adapter,
25 event bridge). SQL runs in isolated in-memory Postgres with a minimal
prerequisite schema; Stripe ports are synthetic. This is **not** real Sandbox
collection, a complete hosted schema migration, multi-connection concurrency
acceptance, GitHub CI, or a deployed end-to-end checkout test.

Remaining before enabling/publishing Checkout:

1. Seed a new correctly bound pending purchase and reserve/publish the booking
   link without competing with existing legacy/full-payment requests; wire
   existing fulfillment and booking completion without adopting old purchases.
2. Coordinate cancellation/admin-refund admission with invoice dispatch and
   define recovery for in-flight/uncertain outcomes. A database admission and
   Stripe pay are not one atomic transaction; rechecks alone do not establish
   full race protection against a later dashboard/API change. No claim of such
   protection is made by these local tests.
3. Connect the bridge to the canonical signature/event-claim handler and all
   confirmation paths. `busy`/`reconciliation_required` cannot be marked as a
   completed payment or allowed to fall through into legacy accounting. Add
   expiry, failed-payment/SCA recovery and recurring-invoice discovery; do not
   assume the paused subscription's upcoming-invoice notifications suffice.
4. Review/apply 022–025 to staging, verify the complete schema/roles/triggers,
   then run fresh hosted checkout, monthly invoice, final-cent, fee/transfer,
   ledger/refund/access, replay/order, cancellation and recovery acceptance.
   Only after those checks should a reviewed PR/Preview rollout be considered.
   **Stop before production.**

Stripe references checked for this implementation:
[Pay an invoice](https://docs.stripe.com/api/invoices/pay) and
[Pause collection / keep drafts](https://docs.stripe.com/billing/subscriptions/pause-payment).

## Previous checkpoint — local held-schedule activation, not enabled

September 5 follow-up: added a first-paid schedule activation candidate on top of
the receipt/accounting work. No enabled route imports it. No remote Stripe call,
hosted migration, setting/credential change, commit, push or deployment occurred.
The current consumer UI, Buy/Book routes and production payment flow are untouched.

- `lib/installments/activation.ts` verifies the captured first payment and the
  same reusable card attached to the bound Checkout customer. It durably claims
  activation before configuring the existing subscription's first renewal and
  fixed end. It keeps `keep_as_draft` indefinitely; no pay, confirm, resume,
  second-subscription creation or customer-wide payment-default change occurs.
  The module verifies actual returned Stripe dates/settings and re-reads them
  before completing local activation. Unexpected positive/bootstrap invoices,
  credits, changed subscription items, ownership, fees, tax or billing mode stop
  the operation instead of being silently overwritten.
- Migration `042-exact-installment-activation.sql` adds service-only activation
  claims and exactly N-1 expected remaining periods. It derives dates/amounts
  from the immutable agreement and counted receipt, not HTTP input. Its checks
  require the linked active purchase and known eligible booking/payment states.
  Existing refunds, unresolved disputes, pending admin refunds and closed or
  unknown states stop activation for reconciliation. Completion rechecks state.
  A lease fences stale workers; changed card/item parameters cannot replace a
  prior claim; ambiguous attempts older than 20 hours require review.
- A retry inspects an already-configured subscription and does not move billing
  dates from retry time. Expected period rows are **not** paid receipts and
  **not authorization to collect**. A later collection path must independently
  serialize invoice binding and cancellation/refund state before each charge.

Calendar contract for this prospective implementation: first renewal is one
calendar month after captured payment, then remaining periods use that renewal's
UTC anchor. For example, January 31 -> February 28 -> March 28. This follows the
classic subscription anchor reset used here; it does not pretend the subsequent
anchor remains January 31. New bootstrap creation explicitly selects classic
billing mode and rejects flexible mode. The actual API update must return the
expected anchor or activation stops. [Stripe billing-cycle behavior](https://docs.stripe.com/billing/subscriptions/billing-cycle),
[subscription updates](https://docs.stripe.com/api/subscriptions/update),
[held draft invoices](https://docs.stripe.com/billing/subscriptions/pause-payment).

Validation: **1052 tests / 69 suites pass**, including 70 additions in this
follow-up (24 real-SQL activation/calendar/permission cases and 46 TypeScript
adapter/evidence cases). TypeScript, targeted lint and an optimized local build
pass. Build service values were process-only fake CI values; the feature stayed
disabled and no environment file changed. Real SQL testing caught a reserved
column-name syntax error before it could reach any hosted database; it is fixed.

Limits: the database tests use a local in-memory PostgreSQL instance with
synthetic prerequisite tables, not the full hosted schema/migration chain or
simultaneous multi-connection execution. API tests use local doubles, not fresh
Stripe acceptance. Actual activation/anchor/card selection, leap/month-end dates,
webhook timing and final termination still need isolated Sandbox verification.
Migration 024 requires 019, 021, 022 and 023 plus a reviewed staging rollout.
No new payment link may be enabled until the remaining collection, recovery,
fulfillment and route integration is complete and accepted end to end.

## Earlier checkpoint — local receipt-linked accounting, not enabled

September 5 follow-up: implemented first-payment accounting on top of the
agreement/bootstrap foundation, without enabling the payment flow or editing
the existing routes/UI. These are local, uncommitted integration candidates.
No Stripe object, hosted database, configuration, deployment or production data
was changed in this follow-up.

- `supabase/schema/041-exact-installment-receipt-credit.sql` adds a private
  purchase binding and atomic receipt/ledger credit RPC. It derives fees from
  immutable agreement terms, validates existing ledger identity/economics,
  increments the payment count once and credits only the remaining creator net.
  The first Checkout payment has no invoice ID and never uses the old one-time
  purchase credit or the existing invoice-only credit RPC. A legacy already-paid
  purchase/ledger cannot be silently adopted. Closed purchases cannot be restored
  by a late first credit. Repeated receipts do not reactivate access or recount.
- Refund arithmetic remains owned by the **unchanged existing**
  `apply_payment_fee_ledger_refund` RPC. Known refunds are reconciled before first
  credit and on already-counted retries. The local test reproduced and fixed a
  retry edge case where newly recorded refund evidence otherwise went unapplied.
  This retains existing per-installment refund semantics, not a new cancellation
  policy: refunding one charge is not automatically canceling the whole agreement.
- `lib/installments/receiptCredit.ts` verifies the successful Checkout, captured
  charge and actual balance transaction before persisting evidence, binding the
  prepared purchase and invoking the atomic credit. Existing cumulative refund
  persistence and audit-only dispute mirroring are reused. Failure/retry paths
  do not create another payment. Its result exposes only a credit boolean and
  payment number, not Stripe objects, secrets or customer/card details.
- `firstReceipt.ts` now shares its read-only payment verification with the new
  accounting adapter. The original receipt-only entry point still cannot credit
  earnings, activate billing or grant access.

At that checkpoint, **982 tests / 68 suites passed**, including 71 additional tests in that
follow-up (29 real-SQL accounting tests and 42 adapter/evidence tests). TypeScript,
targeted lint and the optimized local build pass. The build used process-only
fake CI service values with preparation disabled; no environment file was edited.
Tracked/new-file whitespace checks also pass. The SQL harness executes the original refund RPC body
with migrations 022/023 against a minimal, synthetic prerequisite model in local
in-memory PostgreSQL. It proves neither the entire hosted migration chain nor
concurrent multi-connection behavior. Renewal receipts in those SQL tests are
explicit synthetic future-state fixtures, **not implemented monthly collection**.

The new credit path is not imported by enabled application routes. Creating and
linking a new pending purchase, booking/fulfillment completion, monthly activation,
period authorization, version-aware webhook dispatch, collection/recovery and
full staging acceptance remain necessary. Migration 023 has not been applied to
hosted staging or production; it requires review after 019 and 022. Do not publish
a new Checkout URL or treat a local credit test as completed buyer fulfillment.

## Earlier checkpoint — local agreement/bootstrap integration, not enabled

September 5, 2026 follow-up: added local persistence and adapters for a new
prospective exact-cents plan. **No enabled application route imports these
modules. No Checkout was created by this new code, and no hosted migration,
configuration change, commit, push or deployment was performed.**

- `supabase/schema/040-exact-installment-agreements.sql`: private agreement,
  bootstrap-operation and receipt tables; locked service-only RPCs. Validates
  creator/booking/buyer/product/price/destination linkage, immutable fee terms,
  replay identity, leases and single first-receipt identity. No legacy payment
  rows are converted. Client table/RPC access is denied, and service-role direct
  writes are denied in favor of these narrow RPCs. An uncertain Stripe operation
  older than 20 hours moves the agreement to `review_required`, not a new create.
- `lib/installments/agreementStore.ts`: Supabase adapter with explicit singular
  composite-row handling, validated scalar claim/receipt responses and generic
  errors that do not expose raw database context. A regression reproduced the
  missing singular-row request before the fix.
- `lib/installments/checkoutPreparation.ts`: Sandbox-only integration candidate.
  Durably claims each customer/product/subscription/hold/Checkout operation before
  issuing the corresponding Stripe request. Completed operations retrieve their
  existing Stripe objects; ambiguous retries keep identical parameters and keys.
  Rechecks the no-card bootstrap customer and indefinite draft hold before
  Checkout, then binds IDs without returning or publishing a payable URL. Requires
  a separate explicitly enabled Preview-only flag, Stripe test credentials, the
  existing staging project and matching trusted Preview origin. **The flag was
  not set in any environment.** No pay/resume/confirm/card-attachment operation is
  implemented here. Temporary trial dates are bootstrap dates, not the final
  buyer's schedule; activation must bind the actual first paid date later.
- `lib/installments/firstReceipt.ts`: retrieves and verifies the actual bound
  paid Checkout, succeeded PaymentIntent and captured card charge before recording
  one immutable first-payment receipt. Checks exact gross, fee, destination,
  currency, customer and plan identity. **It does not activate the plan, credit
  earnings, increment paid_count or grant access.** A historical receipt is not
  a refund/dispute clearance or an authorization to fulfill.

At that checkpoint, **911 tests / 66 suites passed** with the normal `npm test` command;
TypeScript and targeted new/changed-file ESLint pass. The optimized local build
also exits 0 using process-only fake CI service values with the new preparation
flag disabled; no environment file was edited. Tracked-file diff and new-file
whitespace checks pass. These are not new GitHub CI or deployed build results.
The 104 new tests in this
checkpoint include 31 real-SQL tests in an in-memory PostgreSQL engine, 20 tests
using the real Supabase request builder with a local fake fetch, and 53 behavioral
tests for preparation/receipt verification. They cover permissions, immutable
terms, lease fencing, duplicate/lost-response retries, stale-operation review,
exact first-payment identity and failure guards. They are not remote Stripe or
Supabase acceptance, nor simultaneous multi-connection database proof.

`@electric-sql/pglite` 0.5.8 is pinned as a **dev dependency** only; one package
was installed with install scripts disabled. Its isolated test environment loads
the local in-memory engine using Node's native module context so the existing
test command needs no experimental VM flags. No external database connection,
credentials, network downloader or persistent database is used by these tests.
The existing unrelated PostHog/Node engine warning was not resolved by updating
application dependencies or the runtime.

Implementation references: [Stripe idempotency key lifetime](https://docs.stripe.com/api/idempotent_requests),
[PostgREST scalar versus table-valued function responses](https://postgrest.org/en/stable/references/api/functions.html),
[Supabase RPC singular results](https://supabase.com/docs/reference/javascript/rpc),
[PGlite in-memory PostgreSQL](https://pglite.dev/docs/).

## Earlier checkpoint — held-invoice proof passed, integration still open

September 5, 2026: the exact-integer fee and final-cent adjustment now have
bounded Stripe Sandbox evidence. This supersedes the earlier **proof pending**
status below, not the Checkout, collection, ledger or release requirements.

Local additions (uncommitted and not imported by enabled routes):

- `lib/installments/heldInvoice.ts`: configures and verifies an unpaid, held
  subscription-cycle invoice. It uses integer application fees, validates the
  actual default invoice PaymentIntent and destination, rejects live mode,
  unexpected lines/periods/taxes/credits/prior attempts and non-card methods,
  and never pays or enables automatic collection. The caller still needs a
  durable, trusted agreement/period claim; that integration is not implemented.
- `lib/installments/checkoutContract.ts`: builds a proposed hosted Checkout
  first-payment request, with an integer fee, off-session card-use disclosure,
  all installment amounts, fixed total and no automatic renewal. It requires
  a held test subscription and a trusted Preview origin. This is a pure request
  builder, **not a created Checkout session or an enabled payment route**.
- The planner can take a separate first-payment fee snapshot so a one-time
  Checkout first payment does not automatically use the recurring Billing rate.
  This is tested with synthetic schedules, not asserted as universal pricing.

At that earlier checkpoint the full local suite passed **807 tests / 62 suites**. TypeScript and
targeted new-file ESLint pass. These checks are local, not GitHub CI or deployed
acceptance. A test-only TypeScript union error in the Checkout disclosure
assertions was corrected by explicitly requiring the object form of the field.

### Isolated held-invoice Sandbox evidence

After explicit owner approval, created test clock
`clock_1UCUkvAPff7wDYc9Pq5C80rN`, no-email/no-card customer
`cus_VCuaKy3FKRPuU7`, and subscription
`sub_1UCUlbAPff7wDYc96hYf8iPC`, labeled
`CNQA-HELD-EXACT-CENTS-20260905`. API version: `2025-10-29.clover`.
The existing test product was reused without editing it; the fixture has its
own recurring price. No app purchase, ledger, fulfillment or customer records
were seeded. Metadata is QA-only, not a fabricated booking payment.

Before advancing the clock, the subscription was confirmed with
`pause_collection.behavior=keep_as_draft`, no resumption date and no application
fee percentage. The clock was advanced two hours beyond each relevant invoice
boundary. The positive invoices remained draft, `auto_advance=false`, with no
scheduled finalization, no payment attempts and zero paid before configuration.
The bootstrap zero-dollar trial invoice is NOT an installment or fulfillment
acceptance result. The temporary Stripe trial is test/bootstrap machinery, not
a proposed free-trial offer to buyers.

| Bounded check | Invoice | Actual default PaymentIntent | Amount / exact application fee |
| --- | --- | --- | --- |
| Held monthly invoice | `in_1UCUmlAPff7wDYc9wzMIg6dq` | `pi_3UCUqoAPff7wDYc90ByAw3Pk` | 66633 / 10425 cents |
| Final-cent invoice | `in_1UCUxsAPff7wDYc9N8eNiv0u` | `pi_3UCVD1APff7wDYc90oOUJAAV` | 66634 / 10425 cents |

Both invoices were finalized with `auto_advance=false`, returned open/unpaid,
`attempted=false`, `attempt_count=0`, no next attempt and zero amount paid.
Both actual PaymentIntents returned `livemode=false`, `amount_received=0`,
`status=requires_payment_method`, `payment_method=null`, `latest_charge=null`,
the exact fee above and destination `acct_1UC6hDA7O6tXliwA`.
Client secrets were withheld from output and are not stored here.

The first fixture used Stripe's default available methods; no method was used.
The final invoice and PaymentIntent were restricted to `card` only, matching
the new local validator. Therefore the first fixture is exact-fee evidence,
not acceptance of the complete card-only adapter or payment collection.

**Important API finding:** Stripe rejected changing the base subscription
line's amount via `invoices.update_lines` with
`invalid_parameter_for_subscription_typed_line_item`
(request `req_VhsFxVxCyoeZ2X`). No amount changed from that rejected request.
The implementation now adds the residual only to the final invoice using
`invoices.addLines`, not by modifying the recurring price or base line.

The approved final adjustment added exactly one cent as
`Final installment balance adjustment`, line `il_1UNlOgAPff7wDYc9tB5YMtpJ`,
with `discountable=false`, `installment_adjustment=final-cent-v1`,
`parent.type=invoice_item_details`, `proration=false` and no subscription on
that adjustment's parent. The base 66633-cent line remained unchanged.
Both line periods are 1791336002–1794014402. Two lines, no taxes, discounts or
credits, subtotal/total/due 66634 cents. Invoice payment
`inpay_1UCVD1APff7wDYc9udidEM9A` is the sole default linkage to the final PI.
Local tests cover Stripe's adjustment-first ordering, replay after finalization,
retry after the cent succeeds but fee configuration fails, wrong/duplicate
adjustments and scheduled/prior collection attempts.

Final read-only subscription inspection confirmed the indefinite draft hold,
card-only settings, no default payment method/source, test mode, and fixed
`cancel_at=1794014402`. The earlier positive invoice was not edited. The clock
was left frozen after the final test; no further advance or payment was made.
No collection, application-fee object, Stripe processing cost, creator transfer,
refund, buyer access or app webhook/ledger correctness was established by these
unpaid fixtures. Do not label them end-to-end installment acceptance.

### Next implementation boundary

The agreement/bootstrap/first-receipt, accounting and held activation foundations above are implemented
locally; the following integration is still required before any customer link:

1. Durable **period** authorization and invoice binding using the new expected
   period rows, plus abandonment/expiry cleanup. Held schedule activation is now
   a local candidate, but still needs actual Stripe acceptance. Do not mistake
   the temporary no-card trial for buyer terms or period rows for payment consent.
2. Connect the new atomic receipt credit to a safely seeded purchase and existing
   booking/fulfillment state. Complete refund/cancellation reconciliation and
   later-invoice receipt verification. Existing recurring credit expects an
   invoice ID; the new first Checkout payment has none. Do not route it through
   the old one-time fulfillment path or run both old/new credit handlers.
3. Version-aware route/webhook/reconciliation integration and a concurrency-safe
   booking-payment reservation. A private agreement alone does not stop an old
   route from concurrently issuing a legacy link for that same payment row.
   Keep legacy `exact-percent-v1`, full payment and existing buyer promises intact.
4. Explicit collection with exact fee verification before payment, additional
   authentication/failed-payment recovery, and exact final termination. Never
   resume blanket automatic collection or add a customer card during bootstrap.
5. Review/apply 022–024 only in the authorized staging project, verify the full hosted
   schema/RLS/RPC representation, deploy the complete isolated candidate, and
   obtain fresh end-to-end Stripe/ledger/refund/access/UI acceptance. The existing
   creator screens and Buy/Book flow must remain consistent with current styling.

No route guard may be removed on the strength of unpaid invoice results or local
tests alone. No migration is applied automatically by adding SQL files to this repo.

## Earlier checkpoint — pure calculation foundation

`lib/installmentPlan.ts` plans 2–24 payments, retaining the existing 50-cent
minimum for each charge. All but the final amount use the floor in cents; the
final amount includes the residual cents. The full schedule must be displayed
before buyer consent. This is an implementation proposal for cent allocation,
not an already accepted contract for an existing buyer.

- $100 / 3: $33.33, $33.33, $33.34, totaling exactly $100.
- $999 / 3: three $333 payments, totaling exactly $999.
- $5,000 / 5 and $6,000 / 6 retain the requested $1,000 monthly amounts.

Fees use the existing server-supplied immutable schedule and per-charge integer
calculation. No API call, environment lookup, transfer, invoice or financial
row mutation occurs in the planner. It is not imported by payment routes or UI
yet. Existing `exact-percent-v1` guards and live behavior remain unchanged.

31 new local tests cover totals, residuals, bounds, existing fee calculations,
legacy processing-disabled behavior, immutability and representative remainder
combinations. A test explicitly confirms that planning $999/3 does NOT make its
Stripe percentage acceptable: under the synthetic 360-bps +30-cent schedule,
the exact creator deduction is 5,225 cents on a 33,300-cent charge, which the
existing percentage guard still rejects. These are not Stripe acceptance tests.

## Earlier collection investigation (historical evidence)

Stripe subscriptions expose application_fee_percent with limited precision;
individual invoices support integer application_fee_amount. The present source
also verifies actual finalized fees and refuses to invent successful ledger
reconciliation. Do not remove that protection to make a price appear supported.
[Stripe Connect subscriptions](https://docs.stripe.com/connect/subscriptions)

Stripe documents that a schedule-created automatic-collection first invoice
starts draft, unlike direct subscription creation, but ordinarily auto-finalizes
about one hour later. That interval alone is not a durable fail-closed control.
[Subscription schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules)

The next bounded proof must establish exact-cent fee/destination configuration
BEFORE any first or later charge can be collected, including delayed/failed
handlers. Do not assume a finalized invoice PaymentIntent can be edited, that
a callback wins a race, or that a percentage rounding rule gives the agreed
fee for every amount. No collection architecture has been declared verified.

Sandbox preparation, September 5: after explicit owner confirmation, created
only dummy customer `cus_VCtxYkWdSeJJjS`, named `CNQA-EXACT-CENTS-20260905`,
in account `acct_1SGnG1APff7wDYc9`. Stripe returned `livemode: false`,
`email: null`, `default_source: null` and no default payment method. No real
contact details, card or production association were submitted.

Read-only `invoices.create_preview` requests returned $333 USD, unpaid and
non-payable preview objects. The result did NOT expose application_fee_amount,
so these requests do NOT verify fee rounding or collection. One request
explicitly specified API version `2025-10-29.clover`, matching the installed
Stripe SDK's default; the fee field was still absent. Do not interpret an
absent fee as zero or a passing fee check. Preview IDs and their embedded
simulated subscription IDs are not persisted financial test fixtures.
[Stripe invoice previews](https://docs.stripe.com/api/invoices/create_preview)

The owner approved submitting the one-period $333 no-card/no-email Sandbox
schedule. Its `send_invoice` mode was rejected by Stripe with
`invoice_customer_missing_required_email` (request `req_woAYF7wXhHORes`).
A customer-scoped schedule list then returned `data: []`, `has_more: false`.
This is a synthetic fixture configuration error, not evidence of a CreatorNet
payment-route regression. Do not repeat the invalid send-invoice request.

The revised automatic-collection request was initially blocked by the browser
safety reviewer because it differed from the approved send-invoice mode. The
owner then explicitly approved the revised request before submission. It created
`sub_sched_1UCUMiAPff7wDYc91PoisQJQ` and
`sub_1UCUMiAPff7wDYc9eJh5I1nx`: same dummy customer, one monthly phase,
`end_behavior=cancel`, $333 USD and test destination
`acct_1UC6hDA7O6tXliwA`, with `application_fee_percent=15.69`.
The returned schedule is test mode and ends at Unix timestamp 1791248124.
No email, card, default source or payment method was added.

Its invoice `in_1UCUMiAPff7wDYc9ZYxHDu5N` initially returned draft,
33300 cents due, zero paid. With a second explicit owner approval, finalized
only that invoice using `auto_advance=false`. Stripe returned `status=open`,
`auto_advance=false`, `amount_paid=0`, `attempted=false`,
`next_payment_attempt=null` and `paid_at=null`. This does not authorize a
later payment, attaching a card, or re-enabling collection.

Read-only invoice-payment lookup found
`inpay_1UCUOZAPff7wDYc9voTsBZH4`, linked to
`pi_3UCUOZAPff7wDYc92JxcnGtf`. The actual PaymentIntent returned:

- `livemode=false`, `amount=33300`, `amount_received=0`;
- `application_fee_amount=5225`, the exact expected deduction for this fixture;
- `transfer_data.destination=acct_1UC6hDA7O6tXliwA`;
- `status=requires_payment_method`, `payment_method=null`, `latest_charge=null`.

The payment client secret was withheld from recorded output. This verifies
pre-payment fee configuration for ONE schedule-created $333 invoice: 15.69%
produced 5225 integer cents, despite the fractional mathematical result of
5224.77 cents. It does not prove a universal rounding rule, Checkout subscription
behavior, collection/transfer success, later invoices, or arbitrary-price
support. No application-fee object or collected Stripe processing cost exists
for this unpaid test. Do not mark the whole installment acceptance complete.

With separate explicit owner approval, the $33.34 final-cent test used the same
no-card/no-email customer and destination. Created
`sub_sched_1UCUTJAPff7wDYc9HnHdRcTM` /
`sub_1UCUTJAPff7wDYc9WbqPrbBr`, one monthly phase, cancel at end
(Unix timestamp 1791248533), `application_fee_percent=16.50`.
Finalized only `in_1UCUTJAPff7wDYc9zmeE5l33` with `auto_advance=false`.
Its returned state is open, zero paid, not attempted, and no next payment
attempt. Read-only lookup returned invoice payment
`inpay_1UCUU7APff7wDYc9w9fhegUU` and PaymentIntent
`pi_3UCUU6APff7wDYc92ZDQd0bL`, with `amount=3334`,
`application_fee_amount=550`, the expected test destination, test mode,
`status=requires_payment_method`, `amount_received=0`, `latest_charge=null`
and no payment method. No collected payment, fee or transfer was produced.
This is the second bounded pre-payment configuration proof: 550.11 fractional
cents became 550 cents. It is not a three-payment Checkout acceptance test.

### Why percentage rounding alone cannot finish this feature

Under the explicit synthetic 360-bps +30-cent schedule, $1,999 / 3 plans
66633, 66633 and 66634 cents, with an exact configured deduction of 10425
cents per payment. Even assuming nearest-cent rounding, none of Stripe's
allowed two-decimal percentage values yields that deduction. On 66633 cents,
15.64% rounds to 10421 cents and 15.65% rounds to 10428 cents. A new pure test
exhausts all 10001 percentage values on all three payments and verifies no
match. This is a mathematical counterexample, not another Stripe transaction.

Do not generalize the two passing Sandbox amounts into a universal rounding
fix or silently over-deduct on higher-ticket offers. An exact-integer collection
design is still required for these unsupported amounts. Stripe's invoice-create
API supports `auto_advance=false` at creation and integer application fees
([Create an invoice](https://docs.stripe.com/api/invoices/create));
that is a candidate building block, not proof of a complete recurring-payment
or buyer-consent architecture. Any new collector must have durable scheduling,
idempotency, additional-authentication handling, exact termination, recovery
and compatibility with existing subscriptions before integration. Preserve the
current guard until that design and its acceptance tests are complete.

Local validation after the September 5 fixture checks: 31 planner tests pass;
the complete suite passes 731 tests across 60 suites. TypeScript, targeted
planner/test ESLint and tracked-file `git diff --check` pass. The test changes
and evidence notes remain uncommitted; this is not a new GitHub CI result or
deployed candidate. No runtime payment or UI module was modified in this step.

Preserve buyer confirmation of first and future payment amounts/frequency,
idempotent plan/invoice creation, fixed final termination, charge/ledger linkage,
refund access rules, and legacy purchases. Any proposed change from hosted
Checkout or from the current charge model needs explicit review of user
experience, consent, reconciliation and compatibility before adopting it.

## Required acceptance after integration

- Ordinary values including $999/3, $100/3 and a higher-value uneven total.
- Exact total and disclosed final adjustment, fees and creator net for EVERY
  invoice, including invoice one; no extra final charge or silent over-deduction.
- Abandoned/incomplete setup, additional authentication, failed payment, retry,
  concurrent link requests, duplicate/out-of-order event deliveries and handler
  delay/failure without collecting an unconfigured fee.
- One ledger entry/count per paid installment; existing refund allocation,
  partial/full refund, entitlement and admin authorization behavior preserved.
- Legacy already-issued links/plans are not rewritten; new plan versions are
  distinguished in immutable metadata and database records where needed.
- Existing Buy/Book/closer UI patterns retained, complete schedule disclosed,
  errors readable, loading states reset, and page style unchanged.

## Separate policy and recovery requirements

The current delivery source still promises cancellation by email at month end
with no further charges. Changing that to a fixed-total balance obligation
requires prospective terms, matching behavior and recorded consent; broader
price support alone does not change this policy. The terms source also has
unfilled legal-entity, mailing-address and governing-law/venue details. Obtain
verified owner/legal information rather than inventing it. Existing buyer
promises must not be retroactively overwritten.

Recovery preparation is in the private owner workspace; no database/media
backup or restore is verified. Supabase upgrade remains deferred.

CURRENT STATUS: planner, Sandbox-only unpaid invoice preparer, Checkout request builder,
agreement/bootstrap persistence, first-receipt verification, receipt-linked
atomic accounting, held schedule activation, renewal collection candidate,
fresh purchase/delivery lifecycle, guarded HTTP handoff, bounded monthly HTTP
collection, authenticated recovery/future-card consent and creator checkout/link
publication implemented locally;
exact integer fee and final-cent invoice configuration proven only in the earlier
isolated unpaid Sandbox fixtures. Hosted activation/purchase/fulfillment acceptance,
cancellation/refund coordination, full new-flow Stripe acceptance, visual/policy
alignment and release are NOT complete on hosted staging.
No commit, push, hosted migration, deployment or live data change has been performed
for this expansion. Migrations 022–039 were executed only inside isolated local tests.
