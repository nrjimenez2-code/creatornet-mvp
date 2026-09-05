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

1. Verify the exact new Preview commit and run a **fresh** sandbox fixture through buyer Checkout, successful webhooks, purchase/access grant, fee ledger and creator earnings. Local mocks are not Stripe end-to-end evidence.
2. Verify later installments, exactly-once progress and stop-after-three with real sandbox events. Keep the broader release acceptance checklist open.
3. Reconcile/close the earlier failed sandbox subscription separately, preserving evidence. Do not rewrite its 480-cent captured fee as 654 or re-charge that failed fixture implicitly.
4. Review the conservative amount limitations and inventory/resolve pre-fix links before any production rollout.

## Primary references

- [Stripe: subscription fees and two-decimal percentage precision](https://docs.stripe.com/connect/subscriptions)
- [Stripe: synchronous initial invoices do not wait for webhook acknowledgement](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe: subscription invoice lifecycle](https://docs.stripe.com/billing/invoices/subscription)

No database migrations, credentials, environment variables, public legal pages, production settings or production deploys are part of this patch.
