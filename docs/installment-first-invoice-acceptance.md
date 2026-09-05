# Installment first-invoice correction — staging only

Date: September 5, 2026. Branch: `admin-refund-allocation`. Do not merge or promote to production without the owner's separate approval and the existing release gate.

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
4. Reconcile/close the earlier failed sandbox subscription separately, preserving evidence. Do not rewrite its 480-cent captured fee as 654 or re-charge that failed fixture implicitly.
5. Review the conservative amount limitations and inventory/resolve pre-fix links before any production rollout. The broader release acceptance checklist remains open.

## Follow-up: link creation must not wait for clipboard permission

The retest saved the new link but left the creation/loading controls busy until reload. Source inspection identified an awaited clipboard write in the success path. New component tests reproduced the stuck state for both full and installment links when the clipboard promise stays pending; this establishes a failure mechanism, not a captured browser-level diagnosis of the original pending request.

Link creation now completes immediately after the successful API response. Existing **Copy latest link**, **Copy**, and **Open** controls remain; copying is an explicit action. The existing status component announces the generated link without falsely claiming it was copied. No payment request, fee calculation, booking workflow, public policy, credentials, or styling changed.

- Both new pending-clipboard regressions failed before the fix and pass after it.
- Explicit copy success, rejection, and unavailable clipboard cases pass; the saved link remains available.
- Full local suite: **691 tests / 59 suites pass**. TypeScript and changed-file ESLint checks pass.
- Optimized build passes with process-scoped fake CI values only, with the same existing dynamic-cookie prerender and example.invalid sitemap fallback messages. No environment files changed.
- Vercel Preview `JCUxK4D1ratQtftJnkZvpu2kisVY` is Ready on exact runtime commit `e9105ac`; GitHub reports 6/6 checks passed and PR125 remains Open. Production remains `b67fe81`.
- Current Preview creator sign-in passed (owner reported Inbox). Rendered inline form preserves the existing dark card/purple controls. Generating on the already-paid fixture correctly returned the paid-booking error and restored enabled controls. Explicit Copy confirmed success with Refresh and Generate still usable. A successful new unpaid link on this exact Preview has not yet been created; do not substitute those error/copy checks for that remaining runtime success-path case.

## Primary references

- [Stripe: subscription fees and two-decimal percentage precision](https://docs.stripe.com/connect/subscriptions)
- [Stripe: synchronous initial invoices do not wait for webhook acknowledgement](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe: subscription invoice lifecycle](https://docs.stripe.com/billing/invoices/subscription)

No database migrations, credentials, environment variables, public legal pages, production settings or production deploys are part of this patch.
