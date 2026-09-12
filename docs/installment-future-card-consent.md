# Optional same-plan replacement card — local candidate

> Integration numbering note (2026-09-07): the unapplied exact-installment sources are now **040–057**. Explicit filenames below use the canonical names; older numbered checkpoint references, test results, and captured hashes retain their historical 022–039 meaning. See [the migration map](exact-installment-migration-map.md) for the current sequence and new local acceptance. Historical results are not approval to install the renamed candidate.

September 6, 2026. Owner approved the recommended option. **Stop before
production.** This document is implementation evidence, not a release approval,
public policy, or a claim of completed hosted acceptance.

## Buyer behavior

The existing dark/purple recovery screen still separates saving a card,
reviewing an installment and explicitly paying it. A new pay-now review may
offer a second checkbox, unchecked by default. It displays the remaining original
amounts and dates (explicitly UTC). Selecting it does not make a request or
enable Pay without the independent current-payment checkbox.

- Unchecked: one current-invoice attempt only. Remaining collection stays held
  for review; the balance is not waived.
- Checked: authorize that replacement card for the same plan's remaining
  scheduled installments, subject to the current payment and account checks.
- Original total, fixed end, dates and other purchases do not change. No entire
  balance is collected when the buyer checks the box.
- Refresh/new review clears unchecked UI choices. A previously recorded choice
  is displayed as evidence, not as a payment receipt or proof collection ran.

The owner enabling this feature never substitutes for individual buyer consent.
No option appears for the final installment or an old record-only quote.

## Binding and collection safety

Local migration `056-exact-installment-future-card-consent.sql` follows 022–037.
It stores the exact consent wording/version, original confirmation identity,
accepted or declined choice, and remaining period snapshot. Only new reviewed
quotes can offer it. Confirmation is atomic with one-invoice consent; a lost
acknowledgement cannot dispatch a retry on replay. Private helper functions and
evidence tables remain inaccessible to ordinary users; service-role clients
cannot directly insert/update/delete the new evidence or call bypass helpers.

A fresh future invoice claim can use the card only after the separately admitted
retry is verified and credited. The old invoice-recovery hold is archived with
its full row, not erased. Archival and original renewal readiness checks share
one database transaction and agreement lock. Other review holds and financial
failures roll it back. Existing invoice claims and original activation/default
card snapshots are not rewritten. Once a future claim is admitted, later
refunds/stops cannot change its card identity or turn reconciliation into payment.

The app supplies the bound card via invoice `payment_method`; Stripe customer
and subscription defaults stay unchanged. Stripe documents that this parameter
must identify a payment method belonging to that invoice's customer:
[invoice payment API](https://docs.stripe.com/api/invoices/pay).
Existing ownership, Stripe amount/fee/destination, prior receipt/refund/dispute,
held-subscription, current-period and once-only admission checks remain required.
No automatic advance is enabled. HTTP monthly collection remains default-off;
the later [monthly webhook candidate](installment-monthly-webhook-collection.md)
adds a bounded staging agreement allowlist, not production enablement.

## Verification and open gates

Local tests cover optional consent, exact wording, immutable/replayed choices,
old-quote rejection, owner and payload checks, expired or changed reviews,
unpaid/uncredited retries, unchanged agreements/defaults, exact final cents,
hold archival/rollback, later-stop reconciliation, private database privileges,
UI defaults/reset and absence of duplicate or cross-plan payment requests.
See the latest expansion checkpoint for completed test/build results.
Final local verification: **2151 tests / 96 suites passed**, including 57 new
regressions; standalone TypeScript, targeted ESLint and optimized synthetic-env
build passed. No `.env`, hosted configuration, Stripe object or production
deployment was changed in this feature implementation.

Before enabling on hosted staging: review the candidate/schema, retain recovery
backups, apply migrations in order only to verified staging, and enable the new
`CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY` gate alongside existing gates only
for the acceptance window. Keep production flags, secrets and schemas untouched.
Run app-owned Sandbox acceptance for checked and unchecked choices, bank
verification, next/final installments, duplicate/delayed webhooks, concurrent
refund/stop boundaries and unchanged unrelated customer defaults. Local PGlite
uses one connection; mocks do not prove distributed concurrency or bank behavior.
Complete desktop/mobile visual QA and prospective policy review. No production
merge/promotion is authorized until these and the existing release gates pass.
