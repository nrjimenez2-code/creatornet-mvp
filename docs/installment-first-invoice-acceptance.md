# Installment first-invoice correction — staging only

> Integration numbering note (2026-09-07): the unapplied exact-installment sources are now **040–057**. Explicit filenames below use the canonical names; older numbered checkpoint references, test results, and captured hashes retain their historical 022–039 meaning. See [the migration map](exact-installment-migration-map.md) for the current sequence and new local acceptance. Historical results are not approval to install the renamed candidate.

Date: September 5, 2026. Branch: `admin-refund-allocation`. Do not merge or promote to production without the owner's separate approval and the existing release gate.

September 6 latest local update: the exact-cent creator link publisher is now
wired behind separate default-off staging/schema/booking-allowlist gates. Its
new migration 039 reserves and publishes only a newly seeded, verified unpaid
plan; the older payment path and UI controls remain. Full local verification:
2335 tests / 99 suites, TypeScript, targeted lint error checks and synthetic-env
optimized build pass. No hosted migration/configuration, payment, commit/push
or deployment occurred. Hosted acceptance remains open; see
[checkout publication](installment-checkout-publication.md).

Later local expansion: the new exact-cent path now includes fresh-purchase and
first-delivery RPCs plus guarded confirmation/webhook handoff. Its HTTP monthly
collection is default-off, now with a separately gated allowlist of at most ten
staging agreements for invoice-created events. No setting has been enabled,
receipt events cannot start a new debit, and no payable URL is published by the
new preparation service. It also includes locally gated dispute/subscription
observers, serialized receipt-linked audit updates, and read-only Stripe recovery
for an already-admitted renewal, admin-only stop controls and bounded unpaid
invoice preparation. A new local setup-only card replacement service and its
authenticated buyer page/API separate saving, reviewing and confirming. A
separately gated setup-URL handoff and migration 034 record exact, expiring buyer
confirmation without retrying a payment or changing the original authorization.
Migration 035 adds local once-only retry admission, a gated on-session
executor, and replacement-authorized receipt reconciliation with a new capture
time bound. The observer can reconcile but cannot start a retry. Migration 036
binds record-only versus pay-now consent and prevents deferred charges from old
confirmations. The new buyer pay-now mode is connected locally. Migration 037
and the owner-scoped bank verification action check the original PI and exact
financial evidence; Stripe.js runs only on a deliberate click, and server
reconciliation is required before any paid claim. Migration 038 now adds local
optional, unchecked same-plan future-card consent with recorded wording and
unchanged amounts/dates, plus scoped recovery-hold archival after credited retry
evidence. Existing defaults and previously claimed invoice authorizations remain
unchanged. Hosted acceptance of this flow and bank verification remain open.
An isolated manual Sandbox invoice reached requires_action after one approved
attempt and remains unpaid; this is API behavior evidence, not app acceptance.
Visual QA was blocked by browser security policy;
no hosted new-flow acceptance is claimed. The prior monthly checkpoint passed
2227 tests / 98 suites; TypeScript, targeted lint and a synthetic-env local build
passed. Migrations 022–039 remain local-only and new flags remain off.
The historical Sandbox results below do not validate
this new implementation. See [current gates](installment-pricing-expansion.md).

## Confirmed failure on the previous Preview

The $120 / three $40 sandbox plan collected only 480 cents of application fee on its first $40 payment. CreatorNet's saved test schedule required 654 cents (480 platform + 174 configured processing/Billing deduction). The attempt to change the invoice after checkout failed with `Non-draft invoices can't be updated`. Separately, checkout metadata omitted `post_id`; the purchase trigger could not derive it from the product row ID, so purchase confirmation never completed.

## Correction

- Derive the first subscription application-fee percentage from the exact server-calculated deduction before creating Checkout. The $40 test case is 16.35%, not 12%. The platform fee remains 12%; the rest is the existing configured processing deduction, not extra platform revenue.
- Carry the verified booking post ID in session, subscription and full-payment PaymentIntent metadata. Do not accept a post ID supplied by the requesting browser.
- Read the current invoice before updating a renewal draft. For finalized invoices, verify the actual PaymentIntent fee and connected-account destination instead of attempting to change paid financial history. A mismatch still fails and requires reconciliation.
- Reject reuse of older installment links without the new setup marker and correct booking/post linkage. This does **not** expire URLs already shared or fix active subscriptions.
- State the number of monthly payments, amount and total in the Checkout product description. Existing booking UI, authentication, destination-charge model, refund policy, access rules and installment completion RPC are retained.

## Deliberate limitations — release decision required

Stripe's subscription Checkout field accepts a percentage with at most two decimal places; it does not expose a fixed integer application fee for the initial invoice. This patch conservatively permits only a fee percentage that represents the agreed cents exactly, with no assumed fractional-cent rounding. It also requires equal installments to add up exactly to the product price.

- $120 / 3 = $40: supported with this test schedule.
- $100 / 3: rejected before any payment row or Checkout creation because equal whole-cent payments do not sum to $100.
- $999 / 3 = $333: rejected with this test schedule because its exact creator deduction is not representable at Stripe's percentage precision.

The UI returns an explicit explanation and suggests another plan length or full payment. This is a safety gate, **not** a claim that arbitrary-priced installment plans are finished. Broader amount support requires a reviewed exact-amount architecture or verified rounding rules and an explicit policy for any variance. Do not market unrestricted installments or remove the gate merely to make a test pass.

## Verification completed locally

- New behavioral regressions failed against the previous implementation for first-payment fee, precision/total guards and finalized-invoice handling.
- Full suite: 686 tests, 59 suites, all passed.
- TypeScript and changed-file ESLint error checks passed.
- Optimized build exited 0 using process-only fake CI credentials; no `.env` files changed. Existing dynamic-cookie prerender messages and the intentionally unreachable `example.invalid` sitemap fallback were present.
- Includes route-to-webhook post linkage, full-payment linkage, first and changed draft invoice fees, correct/wrong finalized fees, stale events, update/finalization race, wrong destination, zero-dollar invoices and old/new link reuse.

## Still required before release

1. **First-payment retest passed on c22060f**, September 5: a fresh $120/three-$40 plan collected the expected 654-cent application fee, granted buyer access, opened and played the private synthetic file, and recorded one paid ledger row with 3346-cent creator net and a credited timestamp. Read-only staging SQL confirmed `paid_count=1`, `target_months=3`. Both `invoice.created` and `invoice.payment_succeeded` returned 200 to the staging webhook. Stripe's observed card fee was 146 cents; the configured deduction was 174 cents, with 28-cent variance. Separate Billing charges were not independently verified. This is first-payment evidence only, not completion of the whole plan.
2. **Second installment passed on c22060f** using Stripe's approved sandbox simulation to October 6. Stripe shows invoice 2 Paid/$40 and application fee 654 cents. Staging SQL confirms `paid_count=2`, `target_months=3`, active access, and two distinct credited invoice ledger rows. Totals in cents: gross 8000, platform 960, processing 348, creator 6692.
3. **Third installment and stop-after-three passed** on the current canonical e9105ac Preview, whose only runtime difference is the clipboard UI fix below. The owner separately approved November 6 and December 6 advances for the one isolated Sandbox customer. The third invoice is Paid/$40 with actual application fee 654 cents. Read-only staging reconciliation shows `paid_count=3`, `target_months=3`, `status=complete`, access true, and exactly three distinct credited invoice ledgers. Totals in cents: gross 12000, platform 1440, configured processing 522, creator 10038. Stripe scheduled cancellation automatically, then actually ended the plan at its December 5 period boundary. At simulated December 6 it is Canceled with only the three original paid invoices; no fourth invoice or repeated credit appeared. A fresh buyer Watch load retained the download. No manual cancellation or financial database edit was used. This verifies the normal fixed-count cycle, not unrestricted prices, first-time out-of-order delivery, duplicate replay, or live-money behavior.
4. **Earlier failed fixture disposition completed**, September 5 at 13:32 Phoenix: with the owner's specific approval, only `sub_1UCLlKAPff7wDYc9LaYXiEBi` was canceled immediately with No refund. Its original paid $40 invoice and incorrect 480-cent fee remain preserved. This is cleanup of that failed fixture, not a retroactive acceptance pass. The successful retest was not changed.
5. Review the conservative amount limitations and inventory/resolve pre-fix links before any production rollout. The broader release acceptance checklist remains open.

## Follow-up: link creation must not wait for clipboard permission

The retest saved the new link but left the creation/loading controls busy until reload. Source inspection identified an awaited clipboard write in the success path. New component tests reproduced the stuck state for both full and installment links when the clipboard promise stays pending; this establishes a failure mechanism, not a captured browser-level diagnosis of the original pending request.

Link creation now completes immediately after the successful API response. Existing **Copy latest link**, **Copy**, and **Open** controls remain; copying is an explicit action. The existing status component announces the generated link without falsely claiming it was copied. No payment request, fee calculation, booking workflow, public policy, credentials, or styling changed.

- Both new pending-clipboard regressions failed before the fix and pass after it.
- Explicit copy success, rejection, and unavailable clipboard cases pass; the saved link remains available.
- Full local suite: **691 tests / 59 suites pass**. TypeScript and changed-file ESLint checks pass.
- Optimized build passes with process-scoped fake CI values only, with the same existing dynamic-cookie prerender and example.invalid sitemap fallback messages. No environment files changed.
- Vercel Preview `JCUxK4D1ratQtftJnkZvpu2kisVY` is Ready on exact runtime commit `e9105ac`; GitHub reports 6/6 checks passed and PR125 remains Open. Production remains `b67fe81`.
- Current Preview creator sign-in passed (owner reported Inbox). Rendered inline form preserves the existing dark card/purple controls. Generating on the already-paid fixture correctly returned the paid-booking error and restored enabled controls. Explicit Copy confirmed success with Refresh and Generate still usable.
- **New unpaid link success subsequently passed** on runtime `e9105ac`, September 5: the separately created synthetic booking offer `5531d8bf-07c7-4371-8a36-7e9675f6f699` generated one $120 full-payment link, cleared its loading state, restored enabled controls and exposed Copy latest link / Open. Stripe Sandbox Checkout independently displayed the correct offer and $120. Scoped staging reconciliation found a booked booking, a full/link_sent payment row, no purchase or entitlement, and no ledger credit. The payment Checkout was not submitted. This is the successful unpaid full-link creation path, not a new paid booking or an independent clipboard round-trip test.

## Later acceptance checkpoint — September 5

The candidate is now `6b3d92f0f766ea0b09b96bfb737196c6ad176ab5`, with the previously observed 700 tests / 59 suites, six successful GitHub checks, and Ready Preview `ByCx8LbeGRuSRQnmD9oHVCzxn3RL`. Changes after `e9105ac` were regression tests and documentation, not runtime/UI changes. Those are historical verification results; no test suite is claimed to have been rerun for this documentation correction.

The owner-run premium-access matrix subsequently passed all seven scoped cases: paid GET; unpaid/refunded GET and POST denials; and signed-out GET/POST denials. See `admin-refund-release-gate.md` for the evidence boundaries.

With separate owner approval, the isolated **CNQA-ZERO-ORDER-20260905** seeded webhook integration test subsequently passed. Its real $0 `invoice.payment_succeeded` arrived before the new purchase and failed with the independently logged missing-purchase error. After inserting only a new non-entitled purchase, replay produced one zero-amount ledger, one installment count and an active entitlement flag. A further replay returned `duplicate:true` without another count or earnings credit. See [the complete evidence and limitations](staging-zero-invoice-ordering-acceptance.md).

This was a card-free, invoice-only **Finalize only** path, not normal Checkout discount acceptance. Actual Stripe fee/variance fields remain NULL, not measured zero. The fixture has no premium media or Discord/Whop fulfillment link; media acceptance remains separate. Its one-period Stripe schedule shows no further invoice and cancellation October 5; it is not another full three-payment test. Existing financial evidence was preserved. PR125 remains on hold; no merge or production deployment is authorized. Supabase upgrade remains deferred by the owner.

## Primary references

- [Stripe: subscription fees and two-decimal percentage precision](https://docs.stripe.com/connect/subscriptions)
- [Stripe: synchronous initial invoices do not wait for webhook acknowledgement](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe: subscription invoice lifecycle](https://docs.stripe.com/billing/invoices/subscription)

No database migrations, credentials, environment variables, public legal pages, production settings or production deploys are part of this patch.
