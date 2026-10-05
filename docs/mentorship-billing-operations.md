# Monthly mentorship billing operations

Deployment candidate only. These source changes do not enable production billing
or establish hosted acceptance.

## Schedules

The maintenance candidate retains only the four existing search and Google
cron definitions. It does not configure a payment collection or exit-recovery
schedule. The launch proposal is to schedule `/api/memberships/collect` and
`/api/memberships/recover-exits` once per minute after the single-scheduler,
authentication, monitoring and hosted acceptance gates below are satisfied.
Vercel cron runs on production deployments; a Preview deployment alone does
not prove scheduled execution.

Both routes require the existing `CRON_SECRET` bearer credential, at least 32
characters long. Do not put credentials or selectors in the URL. Both reject
caller-selected work and retain the existing readiness gates. Missing readiness
returns 409, authentication misconfiguration returns 503, and an invalid bearer
returns 401. Neither route is a read-only health probe: calling one with valid
configuration can perform provider payment or cancellation operations.

The existing SQL leases and original-operation idempotency remain responsible
for concurrency and duplicate execution safety. Each invocation leases at most
six items and waits for its entire batch. One-minute scheduling is a proposed
launch cadence, not a proved throughput or recovery-time guarantee. Measure due
backlog and oldest due age under the accepted launch workload before widening.

Exit recovery now returns 503 for either retry-required or provider-review-required
outcomes, as well as thrown batch failures. Fully reconciled and empty batches
return 200. A 503 must prompt reconciliation of the original operations; it does
not authorize a fresh charge or overriding a financial hold.

## Retain the existing alert service

Authenticated worker runs now have explicit Sentry check-in instrumentation.
Enable it with `CREATOR_MONTHLY_MENTORSHIPS_MONITORING_READY=true` only after
the following existing-project monitors and their notification routing are verified:

| Monitor slug | Schedule | Suggested check-in margin | Maximum runtime |
|---|---|---|---|
| `creatornet-memberships-collect` | Every minute, UTC | 2 minutes | 2 minutes |
| `creatornet-memberships-recover-exits` | Every minute, UTC | 2 minutes | 2 minutes |

Use a failure threshold of one and recovery threshold of one for initial
acceptance, then measure alert volume before changing routing or thresholds.
The hook does not upsert monitor configuration. It runs only on production;
Preview/local calls cannot mask a missing production job. Unauthorized, disabled
and caller-selected requests emit no healthy check-in. A handled HTTP 503 marks
the run as error, including unresolved exit-review outcomes. A process killed
after starting leaves an unfinished check-in for the external timeout monitor.
Disabled or missing invocations must be detected by the external missed-run
schedule; the application cannot report a run that never started.

Check-ins contain the job slug, outcome and duration, without payment identities,
request bodies or raw provider errors. A bounded SDK flush runs after completion.
Monitoring exceptions cannot dispatch work again, turn an unsuccessful batch
into a success or replace the original response. Verify actual delivery separately:
local mocks prove code behavior, not a configured external monitor.

The candidate adds `/admin/commerce/memberships`, enabled only when
`CREATOR_MONTHLY_MENTORSHIPS_ADMIN_READY=true` and the ledger, worker, lifecycle,
payoff and management schema gates are ready. The page independently requires an
admin before querying, even though the admin layout also authenticates. It uses
the exact server payment context, 25-row cursor pagination and a separate bounded
exit-request read limited to those agreements. It shows saved holds, worker
outcomes, attempt/lease times and original exit-request identities. It does not
expose provider proofs or dispatch payments.

The unapplied `20260921015419_mentorship_billing_backlog.sql` migration adds a
service-only SECURITY INVOKER aggregate. After installation and hosted validation,
`CREATOR_MONTHLY_MENTORSHIPS_BACKLOG_SCHEMA_READY=true` enables totals across all
pages. These use exact payment-context equality and a single database statement
snapshot. Due work excludes holds and active leases according to the existing
worker predicates. Cancellation totals count requests, while the exit worker can
lease only one request per agreement at a time. Oldest renewal due time is the
later of the service boundary and the next-attempt timestamp. Counts for retries,
leases, billing-review holds and financial holds are separate and may overlap.

An unapplied schema displays "not configured". A query/validation failure displays
"could not be loaded" while retaining the page records; neither becomes a zero
backlog. Local SQL tests compare eligibility with the actual leasing functions,
but hosted query latency, workload behavior, oldest-due-age alerting and
original-operation reconciliation controls remain unverified or unfinished.

On September 21 UTC, Sentry project `creatornet-nextjs` had enabled alert
`2768805`, notifying suggested assignees with recently active members as fallback,
with a 30-minute throttle. Reuse that project and general alert. The selected
project had no listed Cron monitors. General error triggers do not prove missed-run
detection, swallowed per-item failure reporting, inbox delivery or acknowledgement.

Before activating unattended billing, complete all of:

- Verify this candidate's production deployment identity, canonical URL and exact
  Stripe/Supabase context; preserve all payment and policy gates.
- Verify no competing external scheduler exists and verify the existing secret
  without logging it.
- Configure collection and exit-recovery check-ins in the existing monitoring
  service, including missed-run, runtime and unresolved-batch detection. Verify
  monitor allowance/cost before creating provider resources.
- Connect the monitors to an alert that actually reaches `support@creatornet.net`.
  The owner explicitly chose to be the sole responder for launch; no backup
  person is required by the accepted launch plan. Verify the owner's inbox
  access and acknowledgement rather than assuming existing Sentry routing
  reaches this address. A backup can be added when another operator joins.
- Demonstrate success, failure and missed-run alert delivery without issuing a
  real charge as a monitoring test. Record receipt/acknowledgement separately
  from alert trigger history.
- Expose and verify the admin review queue, including oldest due work and
  unresolved provider operations. Recovery must use original provider identities.
- Prove the actual recurring-payment and provider-stop lifecycle on the accepted
  staging candidate before production activation.

### Buyer-owned fixed-total installment worker (unapplied candidate)

The existing `/api/memberships/collect` schedule also composes the buyer-owned
installment worker. It keeps the same authentication, no-selector contract and
Sentry collection check-in; it creates no second scheduler. Each enabled worker
settles its batch before the route responds, including when the other fails.
Memberships retain their separate context and gates. The buyer worker leases at
most two jobs, with 75-second orchestration leases. The route still has a
60-second budget: hosted latency, throughput and timeout recovery must pass
before enabling it. Local tests do not establish this timing acceptance.

`20260921155703_buyer_mentorship_worker.sql` adds private orchestration state,
the service-only `buyer_mentorship_due_work_v1` view, lease/completion RPCs and
`read_buyer_mentorship_work_summary_v1`. It does not change original provider
requests, invoice/payment admission, consent, holds or accounting. Eligibility
uses only the first unpaid period. Previously admitted invoices go directly to
the existing original-payment recovery, including after hold/revocation.
Unadmitted held, missing or overdue periods require review; they cannot become
catch-up debits. Unadmitted revoked work is excluded.

The default-off `CREATOR_MENTORSHIP_INSTALLMENT_WORKER_SCHEMA_READY` and
`CREATOR_MENTORSHIP_INSTALLMENT_WORKER_READY` gates additionally require exact
context, later receipts, reconciliation and recovery readiness. New collection
also requires `CREATOR_MENTORSHIP_INSTALLMENT_WORKER_COLLECTION_READY` and the
existing collection dependency gates. Turning off new collection leaves
original-only recovery available while its own gates remain enabled.

Completion requires the current unexpired token and exact context. Retry/review
backs off 15 minutes; pending payment/invoice waits one minute. The summary
preserves attention during backoff, for expired work leases and for a due backlog
older than five minutes. Review/unknown results are not successful collection.
An empty batch with outstanding attention still returns 503 and an error
check-in. Counts may overlap; the response contains no new buyer/provider IDs.
The candidate `/admin/commerce/buyer-installments` page exposes this queue to an
independently authenticated admin. Commerce and monthly-billing review link to
it only when the separate buyer-review gates are enabled. A reviewed operator
resolution flow, hosted contention tests and actual support-alert delivery remain open.

The unapplied `20260921160843_buyer_mentorship_admin_review.sql` adds a service-only
SECURITY INVOKER read projection. It returns at most 26 rows for 25-row keyset
pagination, plus full-context backlog counts and oldest due time on every page.
Only plans with recorded first receipts/billing state appear. It projects saved
total/payment count and independent service duration, holds, worker times/outcome
and the latest original recovery invoice/number/outcome. It does not return
accepted snapshots, provider evidence, customer/card data or operation bodies.
The application verifies exact context with independent provider/database identity
observations before reading, validates the projection, and never presents a
query failure as an empty queue. This read-only page has no payment controls.

All remain off: `CREATOR_MENTORSHIP_INSTALLMENT_ADMIN_READY`,
`CREATOR_MENTORSHIP_INSTALLMENT_ADMIN_SCHEMA_READY`, plus required exact-context,
worker-schema and recovery-schema gates. Admin read access does not require
enabling the worker or new collection. Local SQL, authorization/render tests and
synthetic browser pagination passed; hosted admin auth/RLS/PostgREST acceptance
and actual operator handling are still required.

Read-only provider refresh on September 21: production remained at base
`4bd9cf8a06021ae05d0eb150bc2848e0d2d56794`, deployment
`2vrFcBenpDAVQzzwLMbgBnwXbsBW`. Vercel listed only the existing three Google
schedules and search enrichment; neither candidate billing schedule was deployed.
Sentry still showed the existing error monitor and no Cron monitors. Alert
2768805 still notified suggested assignees/recently active members, not a verified
support-address route. No provider settings were changed.

### Paid original recovery ordering

`recoverBuyerMentorshipPayment` now independently reads the original invoice
before opening held recovery. For a paid invoice, the existing capture verifier
and atomic receipt accounting run first; only then is recovery status recorded.
The counted-period protection in migration
`20260921082333_buyer_mentorship_future_collection_release.sql` prevents that
status recording from inserting a new hold. Previously, beginning recovery
first held even a successful ordinary later collection and could strand the
next agreed payment. Duplicate paid recovery keeps the original receipt.

Unpaid invoices still enter held recovery before PaymentIntent classification.
An unavailable invoice read or failed accounting response acknowledges neither
payment nor a new recovery state; the worker retains retry/review visibility.
This change never clears an existing hold, revocation or financial control.
It does not yet implement continuation after an earlier failed/SCA original-card
payment created a recovery hold and then succeeded. That requires an exact,
receipt-backed hold-resolution path; silently clearing an arbitrary hold or
reusing replacement-card consent for the original card is not permitted.

## Retained policies and open tax facts

The owner explicitly directed retaining existing policies on September 20.
Do not revise minimum terms, cancellation/payoff consent, refund eligibility,
12% platform fees or processing-fee responsibility as part of scheduling work.

Live Stripe Tax settings were active, with an Arizona head-office location, but
the platform's complete tax registration list was empty. Current mentorship
contracts explicitly assume no tax. The owner selected US buyers only for launch;
enforcement still needs implementation and provider acceptance. Existing
registrations outside Stripe, liable entity and product classification remain
to be resolved.
Do not treat an empty registration list as tax exemption or silently activate
automatic tax without coordinated payment/accounting/refund support.

### Receipt-backed original-card recovery continuation

Migration `20260921164832_buyer_mentorship_recovery_hold_owner.sql` records
ownership only when original recovery creates a previously absent hold. It
replaces the existing begin function in place, without exposing a legacy alias.
An explicit hold write advances a separate generation, including reasserting the
same timestamp. Old releases cannot clear a new operational hold.

`mentorshipInstallmentSameCard.ts` reuses the provider/capture/history/calendar
verification shared with replacement-card continuation. SQL requires a credited
original capture, the exact invoice card and existing authority covering every
remaining period, clean financial history, no debit stop, and an unclaimed future
schedule. This never changes cards, consent, subscription defaults or provider
collection state, and makes no charge call. The final paid installment needs no
collection release. Lost replies can acknowledge only the exact saved release;
subsequent state changes refuse replay. Receipt accounting survives release errors.

Paid recovery and later signed-event handoff compose this with the existing
replacement-card path. The worker now retains counted held originals before the
next due date and can revisit a failed original recovery after an external release
so that durable worker attention is cleared only through successful original work.

Keep all new gates OFF pending scoped hosted acceptance:
`CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_SCHEMA_READY`,
`CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RECOVERY_READY`,
`CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RELEASE_READY`.
Existing exact-context, receipt/reconciliation, retry-schema and invoice-card
requirements still apply. Prior future-card authorization requires its existing
schema gate. Recovery-only permits exact release acknowledgment but does not
admit a fresh release while the release gate is off. This migration is unapplied.

### US-only precharge implementation decision, September 21

The owner selected server-controlled confirmation and billing-address validation,
not a paid Radar upgrade. New checkout must validate Stripe-observed billing
country before server-authorized confirmation, fail closed for missing/non-US
country, and test wallets/saved cards/retries and issuer-authentication flows.
Reuse existing ownership, money, consent, accounting and recovery helpers.
Preserve every already-saved hosted request and key; never rewrite an uncertain
historical operation into a new charge. Address collection alone remains
insufficient. This decision does not resolve supported tax treatment or authorize
production billing activation.
# Partial original-subscription abandonment

Migration `20260921171012_buyer_mentorship_partial_subscription_stop.sql` extends the existing abandonment hold/proof/release path to an original bound subscription for which no `checkout.create` operation was ever admitted. An unbound Checkout operation is uncertainty, not absence. An active pause lease also refuses this path. An expired uncertain pause retains its exact original operation and may qualify because it cannot create a charge or restore a canceled subscription.

The internal executor requires `CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_SCHEMA_READY=true` and `CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_READY=true`, in addition to existing abandonment gates. Both remain disabled pending hosted acceptance. It rechecks owner/context, exact preparation snapshot, durable hold and absence of receipts; cancels only the original bound subscription through the existing durable cancellation admission; and independently verifies canceled state and invoice history. It does not invent or expire a Checkout Session. A subscription not yet paused is eligible only during its original future trial, with no saved default payment source and no unexpected customer billing state. Unheld active/near-expiry trials require review.

The `buyer-partial-subscription-stop-v1` proof records `sessionId: null`, `checkoutStatus: not_created`, the exact preparation snapshot and terminal cancellation timestamp. Existing atomic archive/release remains responsible for retiring the active selection. Capture/activation, stale or changed proof, missing ownership, and uncertain creates refuse release. A lost cancellation reply is recovered by reading the original subscription; no replacement object, key, consent, charge, refund, invoice void, or earnings/access write is authorized.

Local fixtures are not hosted concurrent-transaction or Stripe acceptance evidence. All six release workstreams remain open.
# Server-controlled US confirmation candidate

`lib/serverPaymentConfirmation.ts` provides a shared internal component for full payments and first installments. It constructs an unconfirmed manual PaymentIntent, preserves existing fee calculations and source metadata, checks exact intent identity/economics, inspects a Stripe-retrieved ConfirmationToken's US billing address, and dispatches one separately admitted confirmation phase. SCA completion requires a new durable phase and the original verified US payment method. Automatic-confirmation intents are refused. Observation/recovery remains separate from receipt accounting; no result grants access or credits earnings. Token evidence stores a preview hash and selected IDs/times, never the address or client secret. After-expiry read recovery cannot dispatch.

Migration `20260921173504_server_payment_protocol.sql` adds immutable, service-only protocol selections. Full payment selection creates the existing attempt and pin atomically; a preexisting full attempt is never adopted. Installment selection retains its exact acceptance and refuses any prior Checkout admission, receipt, activation, stop or release. New triggers serialize against existing hosted dispatch and refuse legacy mutation/abandonment of a selected manual flow. No existing columns or historical archive snapshots are changed.

These components have no public caller yet. Durable intent creation/binding and confirmation now have database functions and internal adapters, with installment source composition as described below. Full-payment source and receipt composition, manual terminal-stop/release and Payment Element UI remain to be integrated before publication. Same-intent failed-card replacement is implemented internally as described below. The create request omits `payment_method_types`, disables dynamic method discovery for the existing supported card contract, and requires the retrieved intent to prove card-only/manual settings. Pinned-version real provider acceptance is still required; local fixtures do not prove Stripe compatibility. The available Stripe connector operation search currently exposes only GET operations for PaymentIntents, so no provider create/confirm test was performed.

The server restriction uses billing-country eligibility; it is not independent proof of buyer residency. Existing hosted/uncertain requests and all readiness gates remain unchanged. Later invoice bank-authentication paths also require review before US-only readiness can be claimed.

Migration `20260921175109_server_payment_intent_operations.sql` adds service-only original intent operations and stops. Narrow functions validate the saved full consent/order/fees or the installment's accepted terms/customer/bound held subscription, then freeze the exact unconfirmed manual request, key and first dispatch time. A short lease serializes retries. An unknown operation older than 23 hours or beyond its acceptance window requires reconciliation; no replacement key is issued. A stop prevents further admission, but allows binding and reading the original provider reply. It never proves cancellation or permits selection release. Binding refuses prior payment activity and mismatched provider identity/economics. Existing fee calculations remain the source of truth, with database agreement tested against their generated requests.

This migration is unapplied. Local PGlite tests cover both purchase types, stop/retry/stale-worker recovery, immutable keys, foreign ownership/context, provider mismatches and role restrictions. They use structural fixtures and do not demonstrate hosted concurrency or real Stripe acceptance. Database JSON validation alone is not provider evidence.

`lib/serverPaymentIntent.ts` now composes those RPCs with the provider. It requires `CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY=true`; creation also requires `CREATOR_SERVER_PAYMENT_INTENT_READY=true`. Both remain OFF. Bound original reads remain possible with creation disabled and after expiry. Each create uses the durably saved request/key and explicit pinned API, timeout and zero SDK retries. It independently retrieves and inspects the original before binding only selected fields; no client secret/address is returned or stored. Lost replies preserve uncertainty; neither an unknown create nor an expired operation receives a replacement key. This shared adapter requires an internally derived contract and a real provider-source preflight callback.

`lib/mentorshipServerPayment.ts` supplies the installment composition from the authenticated buyer/request, saved acceptance and original customer/product/subscription/hold. Fresh provider reads use the existing held-subscription validator and creator destination eligibility. `prepareBuyerMentorshipBootstrap` accepts an internal `serverControlledFirstPayment` option which requires the new gates, durably pins the exclusive protocol before subscription preparation, and returns after the verified hold even if legacy hosted dispatch is enabled. Existing hosted attempts cannot be adopted. Original bound intent recovery skips new preparation. No public route calls this runtime; exposing it still requires confirmation, receipt and terminal recovery integration plus real provider acceptance.

Migration `20260921181924_server_payment_confirmation_operations.sql` adds service-only confirmation phases and append-only observation records. The initial phase owns exactly one original US token proof and request. A bank-authentication successor requires a recorded challenge, the same original intent/card and the current predecessor; it receives a distinct immutable operation ID/key. Unknown retries rotate only the lease, retaining the original operation/request/key/time. Expired uncertainty requires reconciliation. Stops/receipts prevent dispatch but preserve original reads and terminal observations. Stale workers and superseded phases cannot record over the current phase, and a recorded terminal outcome cannot regress. These observations never count money or grant access.

`lib/serverPaymentConfirmationStore.ts` implements the concrete RPC store and internal `runServerPaymentConfirmation` orchestration. It requires `CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY=true` plus the intent schema gate; dispatch also requires `CREATOR_SERVER_PAYMENT_CONFIRMATION_READY=true`. All remain OFF. It independently retrieves token/intent evidence, preserves original retries, and composes the existing server confirmation executor with fresh provider-source and SQL dispatch checks. Every confirmation-provider read/write explicitly pins API `2025-10-29.clover`, a 10s timeout and zero SDK retries. Payload projection excludes client secrets, addresses and raw provider errors. Read-only original observation remains available when confirmation dispatch is disabled.

`confirmBuyerMentorshipServerPayment` loads the buyer's bound original contract and composes this store/executor with the same provider-source checks used in preparation. It cannot manufacture a missing intent or re-run bootstrap. The authentication-capability endpoint is described below; no public manual payment preparation/confirmation route exists yet. Used-token expiry/preview behavior and manual/token/provider-version compatibility still need actual Stripe proof. Local SQL/runtime tests cover original and authentication phases, uncertainty, stop/lease/predecessor races and ownership/state rejection, not actual concurrent hosted transactions or end-to-end buyer acceptance.

The first-installment manual receipt source now reuses the existing capture inspector, transactional accounting writer, signed first-payment event path and entitlement reader. It requires the immutable manual selection, original bound intent and current succeeded confirmation observation, then independently retrieves the charge, balance transaction, payment method, customer and held subscription. It never manufactures a Checkout Session: manual receipts and ledger rows have a null session identity. Existing quote, fee, transfer, service-calendar and financial-state checks remain shared with hosted receipts.

Migration `20260921184216_buyer_manual_first_receipt.sql` extends the existing writer's source admission and permits the truthful null session in the shared entitlement comparison. It also prevents starting or retrying activation and releasing collection after a manual stop. A stop holds already-enabled collection; late capture, original in-flight activation completion and refund accounting remain recordable. This does not cancel an already admitted provider operation, waive debt or authorize releasing the selection. Terminal cancellation/release remains unfinished.

Required manual receipt gates are `CREATOR_SERVER_PAYMENT_RECEIPT_SCHEMA_READY`, `CREATOR_SERVER_PAYMENT_RECEIPT_INSPECTION_READY` and, for accounting, `CREATOR_SERVER_PAYMENT_RECEIPT_READY`, together with the existing source/confirmation/receipt gates. All remain OFF. No migration has been applied externally. These local tests are not Stripe compatibility, concurrent hosted-race or deployment-readiness proof.

## Manual first-payment card replacement and terminal observation

Migration `20260921190318_server_payment_card_replacement.sql` admits a replacement only after an independently retrieved original failed charge has been recorded for the exact current predecessor. It requires a fresh, unused US ConfirmationToken created after that failure observation, original accepted terms/window, exact owner/context/source and no stop. The new phase has its own immutable request/key on the same PaymentIntent. An unknown replacement retains that phase/key; the unchanged previous charge is not proof that the replacement failed. `CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY` and `CREATOR_SERVER_PAYMENT_REPLACEMENT_READY` remain OFF.

Repeated replacement follows the same exact-predecessor rule. A replacement challenge returns through the existing bank-authentication phase and rechecks the replacement method; stop prevents reconfirmation. Failure without an independently proved charge remains review-required and cannot authorize replacement. This conservative rejection is not complete handling of every provider decline/authentication lifecycle.

Cancellation observation independently validates the bound original intent, even when its current token was not consumed. It records neither token success nor a paid receipt and does not authorize archive/release, waive debt, or permit switching. A canceled phase cannot be reconfirmed. Provider confirmation-limit behavior is documented at https://docs.stripe.com/api/payment_intents/confirm ; exact pinned-version behavior remains unproven on the intended account.

Consumed-token recovery accepts null provider expiry only for a token linked to the same original intent and matching its saved, originally validated token proof. Unused null-expiry tokens and changed previews remain refused. Actual token preview/expiry behavior, wallets, saved cards and SCA require provider acceptance. No public manual checkout or Payment/Address Element UI is present yet; the gated authentication endpoint below only serves an already admitted original challenge. All six release workstreams remain open.

## Original manual bank-authentication capability

Unapplied migration `20260921200823_server_payment_authentication_capability.sql` adds a service-only SECURITY INVOKER assertion using the existing buyer/product lock and source/contract checks. It requires the exact current confirmation operation, matching persisted challenge no older than 30 seconds, original bound intent, completed dispatch lease, accepted unexpired source, no stop, no receipt and no changed terms. Anonymous/authenticated database roles cannot call it. It neither admits a confirmation nor changes accounting.

`getServerPaymentAuthentication` independently refreshes the original observation and reads the manual intent again, checks its unchanged SDK challenge, revalidates original provider source, and runs the final SQL assertion before returning the client secret. The secret is not persisted or included in RPC payloads. `authenticateBuyerMentorshipServerPayment` composes the genuine buyer/request source; it never creates missing preparation. A stop after capability issuance still prevents the subsequent server confirmation. Actual provider manual/SCA behavior remains an acceptance requirement.

POST `/api/installments/reservations/[requestId]/payment-authentication` authenticates the buyer, requires the approved site origin and JSON containing only `operationId`, and returns an explicit private/no-store projection with no-referrer. It accepts no buyer, intent, amount, token or consent overrides. Malformed, foreign, stopped and superseded requests expose no secret. Its separate `CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY` gate remains OFF. The capability also requires `CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY` and `CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY`, plus original intent/confirmation schema and confirmation readiness; all remain OFF. There is no public initial manual checkout/confirmation flow or Payment/Address Element UI yet. This endpoint does not prove end-to-end browser or provider acceptance.

## Original manual intent cancellation (not selection release)

Unapplied migration `20260921201913_server_payment_intent_cancellation.sql` adds the missing durable original-intent cancellation request/lease/key and immutable terminal proof. It reuses `request_server_payment_stop_v1` and the existing buyer/product source lock. No confirmation, receipt, ledger or billing engine is duplicated. New intent-cancellation records are private; service_role can only SELECT tables and call the narrow mutation functions.

`lib/serverPaymentStop.ts` reuses manual-intent inspection and the shared uncaptured failed-charge validator used by decline recovery. After persisting a stop it cancels only the exact bound original in requires_payment_method, requires_confirmation or requires_action, with the pinned API, zero SDK retries and a saved requested_by_customer cancellation request/key. Unknown cancel replies retain that same request/key and wait for the lease. After 23 hours no dispatch replay is authorized; independently observed terminal state remains readable. Processing/success/capturable money requires financial reconciliation, not cancellation or refund. A payment winning the race leaves the stop intact and no unpaid proof.

Terminal inspection independently reads all pages of original charge history, requires only uncaptured/unpaid failed charges, and checks the latest charge is represented. Paid/refunded/disputed/transferred history, malformed/incomplete pagination and unavailable evidence refuse proof. The original intent is read again after history inspection. The proof stores IDs, zero-money state and timestamps, no client secrets or raw provider text. Repeated terminal observations cannot rewrite its financial identity/history.

`stopBuyerMentorshipServerPayment` composes the existing genuine buyer/request source. A missing or unbound intent persists the stop and returns reconciliation_required without creating missing bootstrap steps. Bound cancellation preserves accepted contract and keys. It has no public caller yet.

`CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY` and `CREATOR_SERVER_PAYMENT_CANCELLATION_READY` remain OFF. The result is always releaseAllowed:false. Safe purchase switching still needs original held-subscription cancellation, complete financial inspection, durable archive and atomic selection release; an intent-cancellation proof alone is insufficient. Actual pinned-provider behavior and all-six release acceptance remain unverified.

## Manual first-installment subscription stop and selection release

Unapplied migration `20260923002943_buyer_manual_payment_release.sql` joins the original persisted manual stop and canceled zero-money intent proof to the existing exact subscription preparation. It extends the existing abandonment proof and attempt deletion guards; the existing archive and atomic release function remain the only installment release mechanism. Legacy proof versions cannot release a manual selection. Missing/unbound intent, missing stop, changed source, receipt, activation, purchase or stale subscription evidence remains locked. Original payment, confirmation, cancellation and stop records are retained.

`stopBuyerMentorshipUnpaidCheckout` now branches on the immutable original protocol. For manual installments it first cancels/independently inspects the original intent, records the existing abandonment hold, and reuses the existing complete customer/subscription/invoice history inspection and durable subscription cancellation. It independently checks the manual intent again after subscription cancellation and only then records the combined terminal proof and invokes the existing atomic release. It uses a truthful null Checkout identity plus a separate manual intent proof. Lost release-response recovery reads the original archived result without touching a new selection or repeating provider writes. An uncertain payment is never replaced or charged again.

The existing authenticated `abandon_unpaid` action delegates protocol-specific hold ordering to this executor. `CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_SCHEMA_READY` and `CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_READY`, all existing abandonment/request/release gates and the manual intent/cancellation gates remain OFF. This covers a bound manual first installment and its original held subscription; missing/unbound operations still need original reconciliation, and full-payment manual release/composition remains unfinished. Local PostgreSQL and provider-fixture tests do not establish hosted concurrency, real Stripe terminal behavior, browser acceptance or deployment readiness. All six workstreams remain open.

## Frozen full-payment manual source

Unapplied migration `20260923005519_full_server_payment_source.sql` freezes the accepted full-payment contract before any manual intent admission. It uses the existing original order/consent/money validator and buyer/product lock, retains the exact fee schedule, destination, consent metadata, accepted time and expiry, and requires that snapshot for full manual dispatch. The private table permits service-role reads only; narrow save/read functions enforce ownership/context and reject changes. It does not adopt an already admitted intent lacking the snapshot or infer prices from an unknown provider outcome. Installment admission is unchanged.

`lib/fullServerPayment.ts` composes the existing manual intent, confirmation/replacement, bank-authentication and cancellation adapters for an already pinned full-payment selection with its existing accepted consent and order. Initial source derivation takes an explicit trusted processing schedule; recovery always uses the immutable stored contract, including after expiry or source-creation gate rollback. It never rebuilds a missing order or reads current pricing to replace an uncertain operation. Original observations survive financial-state changes; new dispatch independently rechecks the original order/consent/source and destination eligibility. Full cancellation persists a stop even for missing/unbound preparation and remains releaseAllowed:false.

The order comparison is shared with the existing Checkout creation/recovery attachment paths through `lib/productCheckoutOrder.ts`; money calculation and ledger engines are unchanged. `CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY` and `CREATOR_FULL_SERVER_PAYMENT_SOURCE_READY` remain OFF. No public initial full-manual selection route, paid receipt/accounting integration or full-manual terminal archive/release is published yet. Those and the Payment/Address Element flow must be completed before enabling this source in a release. This is local implementation evidence, not provider acceptance or deployment readiness.
