# Zero-dollar invoice ordering — staging acceptance

Date: September 5, 2026. Marker: `CNQA-ZERO-ORDER-20260905`.

Status: **PASS for this isolated seeded webhook integration test. Production remains HOLD.**

Candidate: `6b3d92f0f766ea0b09b96bfb737196c6ad176ab5`, branch `admin-refund-allocation`. No runtime/UI code change, commit, push, merge, production migration, deployment, credential change or billing upgrade was performed for this test. The previously recorded 700-test/59-suite and CI results were not rerun here.

## Authorization and scope

The owner approved one new isolated synthetic staging fixture, a Stripe Sandbox subscription with a 100%-discounted first invoice, delaying the matching purchase until the actual invoice event arrived, and replaying that event. The owner then explicitly approved unscheduling/finalizing only that $0 test invoice.

Database target was independently identified as **CreatorNet Staging / nwqfofezfzljhxolkycz**. Stripe showed **Sandbox / acct_1SGnG1APff7wDYc9**. Delivery used the existing canonical staging webhook; its configuration and query credential were not changed or copied into this record. Production and all previous payment/refund acceptance fixtures remained untouched.

This is not ordinary Checkout acceptance or proof that the product UI supports coupons. Only new synthetic product/post/booking/payment records and a later new non-entitled purchase were seeded. No Stripe event, PaymentIntent, charge, Checkout Session, ledger credit or entitlement was fabricated.

## Exact resources

| Resource | Identifier |
| --- | --- |
| Hidden/inactive product | `52d857ae-995f-42ef-87c1-8164cef1f62b` |
| Hidden/inactive post | `e7832f82-b1b3-42c5-8173-af09d23eaaa9` |
| Booking | `8126e0dd-9df5-42e4-8915-5aa3bc1a1bdd` |
| Booking payment | `8e0cb1e5-74a6-4e44-8f2b-56a9a1c480bd` |
| Later purchase | `de4105f1-b6fa-475e-b8aa-e56061e6dc2f` |
| Resulting ledger row | `b00c3716-dbcf-4cb5-8202-9f244502a67c` |
| Existing QA buyer | `6dbdbb33-23f4-4a2c-8961-a2ac873c80e4` |
| Existing QA creator | `bae54745-d0e3-403c-a71b-da595a959665` |
| Existing creator Sandbox Connect account | `acct_1UC6hDA7O6tXliwA` |
| New synthetic Stripe customer, no email/card | `cus_VCs6EliHfKFo1H` |
| New coupon, 100% once / maximum one redemption | `CNQA-ZERO-ORDER-20260905` |
| New recurring price, $40/month USD | `price_1UCSMnAPff7wDYc9ZqftlXi6` |
| Subscription | `sub_1UCSVEAPff7wDYc9NAPqddI8` |
| One-period schedule, end behavior cancel | `sub_sched_1UCSVEAPff7wDYc9Dt3ySMUo` |
| Paid $0 invoice, number U5P09BDK-0001 | `in_1UCSVEAPff7wDYc9FVpGsbM4` |
| Actual invoice.created event | `evt_1UCSVFAPff7wDYc9lztMhBCi` |
| Actual invoice.payment_succeeded event | `evt_1UCSfkAPff7wDYc9fm5VWewK` |

Offer title: **QA STAGING 20260905 — Zero invoice ordering**. The subscription retained the existing booking route's linkage and nominal fee metadata: 4000 gross / 480 platform / 174 configured processing / 654 total deduction / 3346 creator net cents; fee version `stripe-standard-us-2026-09-03+billing-70bps`. The discounted invoice, not the nominal subscription metadata, was reconciled to zero.

## Observed sequence

All display times below are Phoenix time on September 5, 2026.

1. A guarded transaction inserted exactly one new product, hidden post, booking and pending booking payment, with **zero purchases and zero ledger rows**. Existing financial records were not repaired or reused.
2. At 15:56 the new subscription produced a draft invoice: $40 subtotal, $40 discount, $0 total, no tax. Its actual `invoice.created` event returned HTTP 200 to staging at 15:56:08. The application recalculated the invoice's configured fees to zero. Its event claim completed at `2026-09-05T22:56:08.58837+00:00`.
3. The invoice was originally scheduled for automatic collection at 16:56. After owner approval, its delay was removed. The manual **Finalize and charge** interface demanded a card and returned **Your card number is incomplete**; no card was entered or saved. Instead, only this invoice was switched to **Request payment / Send invoice**, then **Review invoice → Finalize only**. No email, receipt or invoice link was sent. The subscription retained **Charge default payment method**.
4. Stripe's finalize request returned 200 at 16:06:55. Invoice activity explicitly said it was finalized and **automatically marked paid because amount due was $0.00**. It was not manually marked paid out of band. Stripe emitted the genuine `invoice.payment_succeeded` event above at 16:06:58.
5. Before the purchase existed, delivery returned **500**; the automatic retry at 16:07:14 also returned **500**. Stripe's response was `{"ok":false,"error":"handler error"}`. Independent Vercel logs recorded **invoice in_1UCSVEAPff7wDYc9FVpGsbM4 arrived before its purchase row** at `2026-09-05T23:06:56.278Z` and `2026-09-05T23:07:13.141Z`. These were expected retryable failures, not successful fulfillment.
6. Read-only staging reconciliation still found **zero purchases, zero ledgers and zero retained payment-event claims**. The booking payment stayed pending. The existing creator earnings balance remained **10038 cents**. Event claims use `stripe:<event-id>`; querying an unprefixed ID is not valid evidence of a missing claim.
7. A second guarded transaction inserted only the new matching purchase: **processing**, **paid_count=0**, **target_months=3**, **access_granted=false**, real subscription ID, no PaymentIntent or Session ID, zero amounts. It did not write a ledger, earnings, granted entitlement or event completion.
8. Manual resend of the original event returned **200 / Recovered** at 16:11:20 with `{"ok":true}`. Read-only database results showed one paid/credited invoice ledger, **paid_count=1**, **status=active**, **access_granted=true**, completed booking/payment and a completed event claim. All configured invoice monetary amounts were zero. Creator earnings stayed **10038 cents**.
9. One more resend returned **200** at 16:13:00 with `{"ok":true,"duplicate":true}`. Independent database reconciliation again found exactly the same single ledger, **paid_count=1**, unchanged earnings and unchanged credit/completion timestamps. There was no second credit or count.

## Final reconciliation

- One invoice ledger: `b00c3716-dbcf-4cb5-8202-9f244502a67c`; status paid.
- Gross, platform fee, configured processing fee, total creator deduction and creator net: **0 cents each**.
- Stripe PaymentIntent, charge and balance-transaction references: **NULL**. No charge was invented for a free invoice.
- `actual_stripe_fee_cents` and `processing_fee_variance_cents`: **NULL**, not measured numeric zero. Do not convert absent fee evidence into a claim that all Stripe service costs were independently measured.
- Ledger credit timestamp remained `2026-09-05T23:11:19.963601+00:00` after duplicate delivery.
- Completed event claim: `stripe:evt_1UCSfkAPff7wDYc9fm5VWewK`; timestamp remained `2026-09-05T23:11:20.152572+00:00`.
- Purchase: active, one of three counted installments, access flag true, amount/fees/net zero, no PaymentIntent or Checkout Session ID.
- Booking payment: completed, installment amount and configured fees/net zero, real subscription ID attached, no PaymentIntent/actual-fee value. Booking: completed.
- Existing creator total earnings remained **10038 cents before and after both successful replays**.

## Boundaries and safe disposition

The synthetic product has no premium media, Discord invite or Whop listing. Its `fulfillment_url` remained NULL. Source inspection confirms `attachFulfillmentIfEmpty` only attaches Discord/Whop links and does not use the inert staging `deliver_url`. This test proves the entitlement flag and ledger/count reconciliation, **not file playback or fulfillment-link delivery**. The separate seven-case premium-access acceptance remains the evidence for media access.

The fixture used `plan_months=3` to check one count, but its actual Stripe schedule was deliberately bounded to **one monthly iteration**. Final Stripe inspection showed **Active / Cancels October 5, 2026 at 15:56 / No further invoice**, with the subscription's charge-default-method setting and original metadata intact. No clock was advanced for this fixture. It is not a second three-month completion test and does not need an immediate cancellation or evidence deletion.

The card-free **Finalize only** route closes genuine zero-dollar subscription invoice and first-delivery-before-purchase reconciliation. It does not independently prove automatic-charge zero-dollar Checkout behavior, all event permutations, UI discounts, unrestricted installment pricing, live-money behavior or new mentorship terms.

The owner production hold remains binding. Social-auth coverage, owner pricing/policy decisions, verified database plus media recovery and the separately approved production release sequence remain governed by [the release gate](admin-refund-release-gate.md). Supabase upgrade remains deferred. No merge or rollout approval is implied by this pass.
