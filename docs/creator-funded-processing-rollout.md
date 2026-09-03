# Creator-funded processing fee rollout

CreatorNet keeps its existing Stripe Connect Express and destination-charge architecture. CreatorNet's platform fee remains exactly 12%; a configured payment-processing deduction is recorded and shown separately. Do not describe the combined deduction as the CreatorNet fee.

On September 3, 2026, CreatorNet's own Stripe Dashboard showed Standard Payments pricing of 2.9% + 30 cents per successful domestic-card charge and Stripe Billing pay-as-you-go pricing of 0.7% of Billing volume. The Dashboard also warns that rates vary by how a customer pays. Reverify these account-specific values before a later schedule change; do not substitute public examples or another Stripe account.

## Production configuration

All values are server-side environment variables:

| Variable | Required value |
| --- | --- |
| `CREATOR_PROCESSING_FEE_ENABLED` | Omit or set to `false` for the legacy 12%-only split. Use the exact string `true` only after verification. |
| `STRIPE_PROCESSING_FEE_BPS` | Verified percentage component in integer basis points; for example, `100` means 1%. No live value is assumed here. |
| `STRIPE_PROCESSING_FEE_FIXED_CENTS` | Verified fixed component in integer minor units for the supported currency. No live value is assumed here. |
| `STRIPE_BILLING_FEE_BPS` | Verified Stripe Billing percentage in integer basis points. It is added only to installment/subscription invoices. |
| `STRIPE_PROCESSING_FEE_SCHEDULE_VERSION` | Stable identifier for this published schedule, such as a date/version chosen by CreatorNet. Do not silently reuse it after changing a rate. |

When enabled, missing, negative, fractional, or out-of-range values fail before a checkout is created. One-time card payments use the Payments percentage plus fixed fee. Installment subscriptions add the Billing percentage and store that combined percentage on the subscription, while the fixed card-processing amount remains applied once per paid invoice. The current configuration models domestic-card pricing; other card types, international payments, currency conversion and later pricing changes can produce a recorded reconciliation variance.

## Required Stripe webhook event

Add `invoice.created` to the existing CreatorNet production webhook endpoint before enabling creator-funded processing. Keep the existing events in place. Installment subscriptions need this event so the fixed plus percentage deduction can be set as an `application_fee_amount` on every invoice before it is paid.

For local dispute accounting, also subscribe the canonical endpoint to `charge.dispute.created`, `charge.dispute.updated`, and `charge.dispute.closed`. These events only record the disputed amount and Stripe status; this release does not debit a creator or decide dispute responsibility.

Do not enable the feature if Stripe cannot deliver `invoice.created` successfully to the deployed webhook. A missing or failed event can leave an installment using only its 12% fallback.

## Migration-first deployment order

1. Back up the production database and record the currently deployed application revision and environment settings.
2. Run the existing test suite, lint, type check, and production build from the release candidate.
3. Before the migration, query `booking_payments` for bookings with more than one row whose status is `pending`, `link_sent`, or `completed`. If any exist, reconcile the related Stripe Checkout Sessions and expire only the confirmed duplicate paths. The migration intentionally refuses to guess which live payment link is safe.

   ```sql
   select booking_id, count(*) as live_payment_paths
   from public.booking_payments
   where status in ('pending', 'link_sent', 'completed')
   group by booking_id
   having count(*) > 1;
   ```

4. Apply `supabase/schema/019-creator-processing-fees.sql` and then `supabase/schema/020-product-checkout-idempotency.sql` **before** deploying application code. Migration 019 adds columns, fee/refund/dispute ledgers, fenced completed-event leases, a one-live-payment-path guard for bookings, and service-role-only accounting functions. It backfills old rows as `platform-only-v1` and does not recompute historical transaction amounts. Migration 020 adds the private coordination row that makes product checkout retries share one stable Stripe idempotency key and one payable Session.
5. Verify the new columns; `payment_fee_ledger`, `payment_refund_state`, `payment_dispute_state`, and `product_checkout_attempts` tables; unique indexes; row-level security; and the eight service-role RPC functions exist. Confirm authenticated and anonymous clients cannot read or write financial/event/checkout-coordination tables.
6. Add `invoice.created` to the Stripe webhook event selection and confirm a signed test event receives a 2xx response.
7. Deploy the application with `CREATOR_PROCESSING_FEE_ENABLED` absent or `false`. This keeps new payments on the legacy 12%-only calculation while the release is checked.
8. Complete the test-mode checklist below using a verified **test** schedule.
9. Enter the verified production basis points, fixed amount, and a new schedule version. Set `CREATOR_PROCESSING_FEE_ENABLED=true`, then redeploy so the server reads the new values.
10. Run one controlled live smoke transaction only if CreatorNet's launch procedure permits it. Verify Stripe, the database ledger, creator earnings, and the creator-facing breakdown agree before broad release.

Never change the fee schedule without a new version. Stripe metadata preserves the split used when a payment or installment plan was created, so later webhooks do not recalculate old transactions using a new rate.

## Refund operations and open policy decision

The code records cumulative partial/full refunds and keeps the refund attribution for CreatorNet's 12% fee, the published processing deduction, creator earnings, and any cent-level proportional-allocation residual separate. For recurring payments, the ledger reverses only earnings it previously credited. For one-time payments, the purchase earnings RPC owns the balance reversal and the ledger mirrors the result for reporting, preventing a double debit. Disputes are recorded for audit only; they do not alter creator earnings, access, or installment progress in this release.

CreatorNet's current public policy does not clearly say whether the creator or CreatorNet bears a Stripe processing cost that Stripe does not return after a refund. This release therefore does **not** create an extra creator debit or silently retain CreatorNet's 12% on a fully refunded sale. The business/legal owner must approve that treatment before it is automated.

No refund-creation endpoint was added by this change. Until a reviewed refund workflow exists, anyone issuing a destination-charge refund in Stripe must verify the intended `reverse_transfer` and application-fee refund settings for that refund. The incoming `charge.refunded` webhook records Stripe's cumulative refunded gross; it cannot change options that were omitted when the refund was created.

## Test-mode checklist

- [ ] With the feature disabled, a $100 test purchase still records a $12 platform fee, $0 processing deduction, and $88 creator net.
- [ ] Enabling the feature without each required configuration value rejects checkout before Stripe creates a session.
- [ ] With a deliberately chosen test schedule, verify the platform fee, processing deduction, combined application fee, and creator net are correct in integer cents.
- [ ] Complete a one-time product/course checkout and a full booking payment.
- [ ] Create an installment plan. Confirm `invoice.created` receives a 2xx response and the first invoice has the expected `application_fee_amount` and destination.
- [ ] Generate/pay a later installment invoice and confirm the same schedule version and per-invoice calculation are applied.
- [ ] Create a fully discounted or credit-covered $0 installment invoice. Confirm it advances the plan exactly once without a PaymentIntent, Charge, or processing deduction.
- [ ] Retry the same webhook event and confirm there is one ledger entry and one earnings credit.
- [ ] Exercise failed and expired payments; neither may credit creator earnings.
- [ ] Exercise full and partial refunds. Verify cumulative retries do not reverse earnings twice and the recorded refund never exceeds gross.
- [ ] Deliver a refund event before its related success event in test mode. Confirm the durable refund state is reapplied after payment linkage and does not restore refunded access or earnings.
- [ ] For each refund test, verify Stripe's connected-account transfer reversal and application-fee refund match the approved refund policy; these are refund-creation options, not webhook options.
- [ ] Confirm an older transaction with no new fee metadata still renders and reconciles as the historical 12%-only split.
- [ ] Confirm the customer cannot alter price or fee values in a request; all calculations must use server-owned values.
- [ ] Compare the final Stripe balance-transaction fee with the stored actual fee and variance. A variance is audit data and must not automatically debit the creator.
- [ ] Confirm a deliberately mismatched paid installment is rejected by reconciliation rather than recorded with a fictional configured deduction.
- [ ] Send dispute-created/updated/closed test events. Confirm amount/status are recorded, older out-of-order states cannot overwrite newer ones, and creator earnings do not change.
- [ ] Confirm a prior paid/refunded purchase is rejected before a new Checkout Session is created. Retry the same pending product checkout sequentially and concurrently; every successful response must return the same open Session/idempotency key. Expire it, retry, and confirm exactly one replacement Session is exposed while any race-losing Session is expired.
- [ ] Confirm subscription Checkout browser confirmation never rewrites `active` or `complete` back to `paid`, and that paid installment access appears in the Library.
- [ ] Confirm pending, failed, and fully refunded purchase rows cannot reveal fulfillment links through `/access`, `/library`, or `/watch`.
- [ ] Generate the same booking payment link twice and confirm the existing URL is reused. Issue two simultaneous requests and confirm both resolve to one `booking_payments` row and one Stripe Checkout Session/idempotency key. Confirm a completed booking cannot generate another link.
- [ ] Confirm creator-facing wording and values show: gross sale, CreatorNet platform fee (12%), payment processing, and net earnings.
- [ ] Confirm application logs contain no secret keys or sensitive payment data.

## Rollback

1. Set `CREATOR_PROCESSING_FEE_ENABLED=false` (or remove it) and redeploy. This immediately returns **new** one-time payments and newly created plans to the legacy 12%-only split.
2. Do not reverse migrations 019 or 020 during an incident. They are additive, preserve historical records, and can remain unused while the application is rolled back.
3. Keep `invoice.created` subscribed; with no enabled-plan metadata the handler is a no-op. Removing the event is not necessary for an application rollback.
4. Identify installment subscriptions created while the feature was enabled. Their Stripe metadata intentionally preserves the accepted fee schedule, so the global flag alone does not rewrite their future invoices. Decide whether to honor that schedule or handle those subscriptions through an explicitly reviewed operational change; do not silently edit completed financial records.
5. Reconcile all payments created between enablement and rollback using Stripe PaymentIntent, Charge, Invoice, and Balance Transaction IDs. Preserve the ledger even if the code release is reverted.
6. If a bad rate was used, stop new checkout first, document the affected schedule version and transaction IDs, and have the business/legal owner approve creator remediation before adjusting balances.

## Release evidence to retain

Keep the migration result, deployed commit, environment-variable names (never secret values), Stripe webhook event list, test/build output, test-mode transaction IDs, enabled schedule version, enablement time, and rollback owner in the launch record.
