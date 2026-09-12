# Admin refund release gate (PR #125)

> Integration numbering note (2026-09-07): the unapplied exact-installment sources are now **040–057**. Explicit filenames below use the canonical names; older numbered checkpoint references, test results, and captured hashes retain their historical 022–039 meaning. See [the migration map](exact-installment-migration-map.md) for the current sequence and new local acceptance. Historical results are not approval to install the renamed candidate.

Status: **HOLD — no production deployment or database change is authorized by
this document.** The owner requested that work stop before production.

Latest staging checkpoint, September 6: **the approved narrow ACL repair is
complete; 15/15 fresh permission checks PASS**. Required server access remains,
and anonymous/authenticated access is denied on the checked internal objects.
The final full local suite passed **2359 tests / 102 suites** (184 seconds), with
standalone TypeScript and clean targeted lint. Local-only024/026 helper ACLs are
explicit, and the prepared atomic installation package passed late-failure rollback
tests. No feature migration/configuration, push or production change occurred.
The owner confirmed **no verified staging backup yet**, so hosted installation
remains blocked on recovery readiness and separate execution approval. Full
hosted Sandbox acceptance and the remaining release gates are still open. See
the [installation/recovery plan](installment-staging-installation-plan.md) and the evidence and scope in the
[staging compatibility/access review](installment-staging-compatibility-review.md).

Previous staging review, September 6: **verified staging ACL drift**.
Read-only catalog inspection found eight existing 019 financial RPCs executable
by anonymous/authenticated clients and broad client grants on four internal
financial tables. A narrow permissions-only repair is prepared and tested locally,
not yet applied at that earlier checkpoint (now repaired above). All 18 new migrations install and key receipt flows pass against
a catalog-derived in-memory structural baseline; that is not hosted acceptance.
Final local verification is **2348 tests / 101 suites**, standalone TypeScript,
clean targeted lint and diff checks. A read-only live-project comparison passed
all 12 matching financial-permission checks; this specific drift is confined to
staging in the inspected objects. Production was not changed or broadly
recertified by this check. See
[staging compatibility/access review](installment-staging-compatibility-review.md).

Previous local checkpoint, September 6: exact-cent checkout/link publication is
now integrated into the existing creator-owned booking endpoint, behind default-off
staging-only schema/publication gates and a bounded booking allowlist. Migration
039 reserves new immutable agreements and atomically publishes only verified,
seeded unpaid links; old payments/purchases cannot be adopted. The creator UI
retains its layout/controls and distinguishes first-payment fee estimates and
final-cent adjustments. **2335 tests / 99 suites pass**, standalone TypeScript,
targeted lint error checks and an optimized synthetic-env local build pass.
The touched older routes/page retain 33 existing lint warnings; new modules/tests
are clean. No commit, push, hosted migration/configuration, Stripe mutation or
production change occurred. Migrations 022–039 are local-only. Hosted acceptance,
policy alignment, visual QA, recovery readiness and this release gate remain open.
See [checkout acceptance](installment-checkout-publication.md).

New September 5 scope decision: the owner chose to expand installment pricing
before launch. The local exact-cent planner, unpaid held-invoice preparer,
Checkout request builder, agreement/bootstrap persistence, first-receipt
verifier, receipt-linked accounting, held-schedule activation, renewal collector,
fresh purchase/delivery lifecycle, collection-hold/refund admission, refund-event
accounting, approved billing-stop/Checkout cleanup, dispute/subscription observers,
admitted-payment recovery, admin-only stop/review controls, expired-Checkout
observation, bounded invoice discovery/preparation and guarded HTTP handoff are integration
candidates, not an enabled or complete payment path. The earlier monthly checkpoint passed
2227 tests / 98 suites, with TypeScript and targeted lint passing; the latest
synthetic-env optimized build also passed. The isolated classic-mode Sandbox
fixture now has an approved decline followed by one separately approved manual
recovery: the same $666.33 invoice is paid/captured in full, with the original
PI/default invoice-payment link preserved and exact $104.25 synthetic deduction
collected. Its actual charge-processing fee is $19.62; separate Billing costs
were not verified. Automatic collection remains off, and the subscription is
active again but still held with keep_as_draft and no resume time/default card.
Local code was previously corrected to omit two mutually exclusive optional
pay flags after Stripe rejected their combination; stricter regressions failed
before that correction and pass afterward. Its $0 trial invoice has no payments.
The manual recovery used a replacement card without an application agreement,
and its real-time capture predates the fixture's future-clock service period.
New local regressions preserve rejection of both mismatches without credit or
another payment. This is not buyer-authorized app recovery or full-candidate
acceptance; neither original authorization nor receipt-time checks were relaxed. The
base committed candidate is still 6b3d92f. Existing earlier acceptance applies
to that earlier payment implementation, not to any future collection changes.
Re-establish affected staging acceptance on the eventual new candidate before
release. See [Expansion status](installment-pricing-expansion.md).

Latest local additions seed a new purchase without adopting old ones, reserve
its exact Stripe binding, attach first-payment delivery without counting the
whole balance as paid, and wire a read-only success-page branch and canonical
webhook handoff. A new default-off HTTP gate can select at most ten explicitly
allowlisted staging agreements for `invoice.created` collection, with all
schema/cancellation/refund/recovery readiness guards required. Receipt events
cannot start a debit. No new configuration has been enabled; see the
[monthly collection contract](installment-monthly-webhook-collection.md).
Failure/SCA/uncertain outcomes
remain held, not automatically retried. **The new hosted application collector
has not been enabled or exercised.** The isolated API tests above are separate.
Migrations 022–039 remain unapplied to hosted staging. New-module lint is clean;
the earlier monthly checkpoint's touched HTTP routes retained 28 existing any-type warnings, no errors.
Migration 027 and the local refund processor now serialize future invoice
admission against persistent review holds. Already-admitted/uncredited payments
block refund processing until reconciled. Matching uses immutable receipt/ledger
IDs, not the purchase's latest PI. An internal cancellation review hold is not
a completed Stripe cancellation, access change or debt waiver. All new flags
remain unconfigured. Hosted cancellation/refund/concurrency acceptance is open.
Migration 028 and the separately gated exact refund-event handler now inspect
actual Stripe refund states, apply receipt-linked cumulative accounting once,
and confirm matching admin-operation delivery afterward. First-charge refunds
do not revoke the whole plan or overwrite its latest-payment fields. Pending,
failed and inconsistent evidence stays on a durable review hold, with no new
financial mutation. Required staging event subscriptions/acceptance remain open.
Migration 029 and the internal, separately gated billing-stop adapter now record
an administrator-approved collection stop, expire an unpaid Checkout, verify
subscription cancellation without proration/final billing, and preserve original
financial/access evidence. In-flight/uncertain payments block completion. New
activation is fenced by the hold; prior admitted activation can reconcile before
cleanup. The explicit admin action is now implemented locally; hosted
subscription-event and complete UI acceptance remain open.
This is not a new public cancellation policy, debt waiver or deployed feature.
Migration 030 and the separately gated lifecycle observers now fence future
collection on disputes or changed subscriptions, record current receipt-linked
audit evidence, and reject stale observation/activation/stop races. Exact receipt
replay uses a serialized audit mirror; no creator debit, refund, access revocation,
count change, hold release or automatic debt waiver occurs. Existing production
dispute handling is unchanged. New event subscriptions and actual hosted
acceptance remain unverified. A recorded review is not a resolved incident.
Migration 031 adds per-invoice recovery holds and observations for original
admitted renewals. The observer distinguishes current action-required, declined,
pending and terminal evidence and reconciles a lost successful response through
the original once-only receipt path, without another pay call. Verified already
voided/canceled zero-money evidence can unblock separately approved stop/refund
processing; it does not waive the balance or release a hold. The original
dispatch remains consumed. Migration 033 and the new separately gated local
card-setup service now reserve versioned buyer consent, prepare unpublished
setup-only Checkout, and verify a saved customer-owned replacement card.
This does not change the original authorization, pay the invoice or unhold
collection. Migration 034 and the authenticated buyer page/API now add local
owner-only review, a separately gated setup-URL handoff, exact five-minute payment
reviews and explicit, once-only recorded consent. The dark-theme staging screen
does not describe saved consent as a completed payment. No actual hosted setup
or new route/UI was exercised; browser security policy blocked the local visual
preview, so desktop/mobile visual acceptance remains open. Migration 035 now adds
local permanent once-only retry admission, a gated on-session executor, and
independently authorized replacement-card receipt reconciliation. Pre-admission
refund/stop/dispute checks remain strict; lost acknowledgements cannot reopen an
attempt. The webhook observer can account for an admitted replacement card but
cannot charge it. Migration 036 binds record-only/pay-now intent permanently to
the reviewed quote; both server parsing and SQL reject record-only dispatch.
The buyer's pay-now button/mode is now wired locally, preserving old record-only
consent. Migration 037 and the owner-scoped bank action now check original/retry
admission, exact Stripe evidence and current financial holds before returning an
ephemeral original-PI capability. Stripe.js opens only on an explicit buyer click;
server receipt verification is still required afterward. Local tests cover these
paths; no hosted new-flow bank challenge has completed. New flags remain off.
The owner-approved optional same-plan future-card checkbox and scoped recovery
hold resolution are now implemented locally in migration 038 and the existing
buyer page/controller. The accepted/declined choice, exact wording and remaining
schedule are recorded independently. New invoice claims bind the replacement
card without changing customer/subscription defaults or existing claims. The
matching recovery hold is archived only after credited retry evidence and the
original renewal safety checks; other holds cannot be cleared. A later refund
or stop cannot rewrite an admitted invoice's card or create another debit.
The new future-card gate remains off. Full hosted acceptance, visual QA,
collection integration and policy alignment remain open. No old record-only
confirmation can become chargeable through a later flag change.
One separately approved manual Sandbox SCA fixture was created in the latest
checkpoint: invoice `in_1UCjUIAPff7wDYc9OgeasgKm`, original PI
`pi_3UCjVFAPff7wDYc91mQtAjSc`. Its single approved on-session attempt requires
bank verification; a final read shows zero paid, open, no automatic collection
or next attempt. It has no app agreement and is not application acceptance.
Do not confuse it with the earlier paid manual fixture described above.
No Stripe mutation occurs
in the recovery observer. The setup service's only permitted Stripe mutation is
creation of setup-mode Checkout; its new buyer route and all gates remain off.
Payable-link publication, complete cancellation/refund/dispute lifecycle and
recovery integration, and fresh full staging acceptance remain release
blockers. Do not enable flags or publish a payable link based solely on these
unit/local database results.

Two earlier owner-approved no-card Sandbox fixtures verify pre-payment integer fee
configuration: $333 at 15.69% produced 5225 cents; $33.34 at 16.50% produced
550 cents, each with the intended test destination. Both invoices were finalized
with automatic collection disabled and remain unpaid. These are isolated
schedule-created invoice checks, not collected Checkout or recurring-payment
acceptance. A pure exhaustive counterexample for $1,999 / 3 confirms that
percentage rounding cannot represent every exact deduction. Runtime checkout,
existing fee guards and production remain unchanged; the collection design
and full new-candidate acceptance remain open.

A subsequent isolated no-card, frozen-clock Sandbox fixture now proves exact
integer fee configuration on held subscription-cycle invoices: 66633 cents and
the final adjusted 66634 cents both produced an actual PaymentIntent fee of
10425 cents for the test creator destination. Collection remained off, zero was
paid, and no payment was attempted. Stripe rejected editing a subscription
line's amount; adding one labeled residual-cent line to the final invoice
succeeded. Tests cover adjustment identity and duplicate/retry safety. These
are NOT collected Checkout, transfer, ledger, access or complete lifecycle
acceptance. Immutable agreement/bootstrap claims and first-receipt identity are
now implemented and tested locally. Migration 023 adds atomic receipt/count/ledger
credit and purchase binding, using the existing cumulative refund reversal RPC.
The first-payment adapter verifies captured payment/balance evidence and reuses
existing dispute audit mirroring. Its 71 new local tests cover refund-before/after
credit, duplicate/reordered receipts, failed linkage and closed-purchase protection.
Migration 024 and its adapter now add local, held first-paid activation with
immutable renewal/end dates, private N-1 expected periods, lost-response retries,
stale-worker fencing and refund/dispute/cancellation-state checks. Collection is
never resumed. The 70 new tests are local only; no actual Stripe activation is
accepted yet. Period/invoice binding, activation acceptance,
route/webhook/fulfillment/refund integration, collection/recovery/SCA and staging
acceptance remain required. Migrations 022–024
have been executed only against synthetic prerequisites in an isolated in-memory
test database, not the full hosted schema chain, staging or production.
No commit, push, deployment, hosted migration or production change for this expansion
has been performed. Full fixture IDs and limitations are in the expansion note.

The older production sequence below covers migration 021 and the earlier refund
candidate only. It is **not** a complete release sequence for the new expansion:
022–024 prerequisites, full hosted staging acceptance and a reviewed migration/app
ordering plan must be added before release approval. The new preparation flag
remains unset and no new route publishes its Checkout URL.

This is the release sequence for the existing admin refund allocation work,
not a new billing-model or cancellation-policy release. Keep the existing
CreatorNet UI and the already-deployed creator-funded processing schedule.

## Evidence required before requesting release approval

- Record the exact candidate commit, passing CI/checks and Ready Preview.
- Confirm Preview uses the separate staging Supabase project, Stripe test
  credentials, test webhook destination and staging media. Never copy Preview
  credentials, test accounts, fixtures or storage URLs into Production.
- Run a real staging one-time checkout; partial and full refunds with both
  allocation responsibilities; duplicate delivery; failed/expired checkout;
  and the supported booking installment path, including a later invoice.
- Check both ledger and Stripe balances/objects. A green HTTP response alone
  does not establish fulfillment, earnings or access correctness.
- Check the refunded buyer's Library, direct watch/access page, and both
  premium URL-issuing endpoints; check unsigned private-storage access
  separately. A browser-blocked probe is **not** an application denial.
- Identify whether out-of-order evidence is a duplicate replay or a first
  delivery before payment linkage. Do not present mocked regression tests
  as a completed Stripe staging scenario.
- Obtain any missing first-time/returning Apple/Google acceptance evidence;
  retain the already-completed email tests. Never revoke a working identity,
  relax auth protection or substitute a sender-dashboard link for a recipient
  sign-in just to complete a test.
- Resolve published cancellation wording with the owner before changing it.
  The current delivery page promises email cancellation at the end of the
  billing month. The proposed fixed-total mentorship obligations, monthly
  minimum terms and renewal choices are a separate approved implementation.
- Review current Supabase usage, expected launch capacity and recovery cover.
  Do not infer an outage from the grace-period banner or change billing without
  owner approval. A schema-only export is not a data/storage backup.

## September 5 acceptance checkpoint (not release approval)

- First-time Apple was subsequently reported successful at approximately 17:19
  Phoenix: the owner relayed a friend's Apple signup, username/interests setup,
  feed landing, refresh and correct Profile access. This is the owner's report
  of the friend's test, not an agent-observed session or database/provider
  verification. The friend performed the signup independently; no account
  inspection, reset, unlinking or credential handling was performed by the
  agent. All four planned first-time/returning Apple/Google cases now have
  recorded completion within their stated scopes. This supersedes the older
  pending social-auth references below, not the separate policy/recovery/release
  gates or the unconfirmed reason for the earlier Trueflow setup prompt.
- New Google signup subsequently passed as owner-provided evidence using an
  owner-nominated unused Google identity: signup/setup reached the feed, then
  the requested refresh and Profile check retained the new profile without
  repeated setup. Account novelty and provider selection rely on the explicit
  owner-assisted test context; the agent did not independently audit this new
  account's creation timestamp or provider session. Together with the returning
  Google and returning Apple cases, this leaves first-time Apple as the missing
  scoped social-auth case. No existing identity was reset or unlinked, and no
  runtime code or production configuration changed for the check.
- Returning Google retest subsequently completed at approximately 16:50
  Phoenix as owner-provided evidence: after CreatorNet sign-out and Continue
  with Google, the same account returned directly to the feed without username
  or interest setup and remained signed in after one refresh. A narrowly
  approved read-only lookup had verified an existing Google-linked live account
  and a currently populated profile; the owner confirmed its username was
  selected during setup earlier that day. This passes the retested returning
  case after completed setup, not first-time Google signup or proof that an
  older profile was preserved. The earlier setup prompt's cause remains
  unconfirmed. Do not repeat the passing case without a relevant reason.
  First-time Apple and Google evidence remains separate; no profile repair,
  provider change or production deployment was performed.
- Returning Apple acceptance subsequently completed at approximately 16:32
  Phoenix: the owner reported success after the requested Apple sign-in, and
  browser inspection independently verified the live dashboard, the existing
  owner profile and the same profile after full reload. Provider attribution is
  owner-reported; no credential dialog or token/provider claim was inspected.
  This closes the scoped returning-user landing/profile/persistence check, not
  first-time Apple signup or the then-remaining Google acceptance. No account
  settings, sign-out, code or production configuration changed for this check.
- The fresh supported three-payment installment plan completed exactly three
  $40 invoices and stopped at its paid-through boundary. A duplicate successful
  invoice event returned 200 without another credit or installment count.
- The owner-run unpaid product Checkout expiration delivered
  `checkout.session.expired` successfully to staging. Independent reconciliation
  showed order canceled, purchase failed/access false, no PaymentIntent and zero
  ledger credits. Buyer Checkout no longer offered payment; Watch returned to
  the feed. This is not the separate booking-link creation success case.
- An unauthenticated network GET for a known synthetic staging premium object
  via the public-object route returned HTTP 400 with a JSON `NoSuchBucket`
  error (payload statusCode 404), not file bytes. The authenticated-object route
  without credentials returned HTTP 400 requiring authorization. Read-only
  staging SQL independently confirmed the existing `premium` bucket is private.
  These close the raw unsigned-file checks, not the entire application endpoint
  matrix.
- The existing Watch page's `fromProfile=1` route exercised the GET link issuer
  using the independently verified staging buyer session. Vercel logs for the
  exact Preview recorded HTTP 402 for both the unpaid synthetic booking offer
  and the fully refunded synthetic course; neither page received a download
  link. These are server-observed unpaid/refunded GET denials, not merely UI
  redirects. POST `/api/premium/access` denial evidence was subsequently supplied
  by the owner-run check below; the separate owner-run signed-out cases also
  subsequently passed. An earlier unsigned network probe returned HTTP 302,
  which was not accepted as proof of application HTTP 401. Preview protection
  was not weakened and browser cookies were not exported to complete the cases.
- A previously issued link to the successful synthetic installment-retest file
  was probed after its recorded one-hour expiration. Staging Storage logged GET
  400 at 13:28:39 Phoenix. A fresh link issued to the same entitled buyer for
  the same file logged GET 200 at 13:40:34 and played the two-second test video
  without an error. This closes the observed expired-link versus fresh-link
  check. It does not prove immediate revocation of already issued links after
  a refund, or deletion of copies a buyer already downloaded. Signed URLs and
  tokens are deliberately excluded from the evidence documents.
- The fresh synthetic booking on runtime `e9105ac` completed Stripe Sandbox
  card setup and returned to staging. Its creator generated one unpaid $120
  full-payment link: the loading state cleared, generation controls re-enabled,
  and the UI offered Copy latest link / Open. Checkout independently displayed
  Sandbox, the exact offer and $120. Read-only reconciliation found one booked
  booking, a full/link_sent payment row, no PaymentIntent/subscription, zero
  purchases/entitlements and zero ledger/credited rows. The Pay button was not
  submitted. This closes the new unpaid full-link success case, not a new paid
  booking or a zero-dollar subscription-invoice test.
- Nine handler regressions cover invoice-before-purchase retry and completion,
  duplicate handling, late expiration preserving terminal/replacement records,
  and expiration write failures requiring retry. Local verification passed
  **700 tests / 59 suites**, TypeScript, changed-test ESLint error checks and
  diff whitespace checks. Stripe/database dependencies in these tests are mocks;
  the separate real first-delivery/zero-dollar evidence subsequently passed as
  described below. The mocked tests alone do not establish that result.
- With explicit owner approval, **CNQA-ZERO-ORDER-20260905** produced a genuine
  paid $0 Sandbox subscription invoice before its new purchase existed. Initial
  deliveries returned 500 with the independently logged missing-purchase reason;
  no purchase, ledger or completed payment-event claim existed. After seeding
  only the new non-entitled purchase, replay returned 200 and produced one
  credited zero-amount ledger, paid_count=1 and access_granted=true. A second
  replay returned duplicate:true; the ledger/count, timestamps and creator
  balance were unchanged. No previous financial evidence was repaired.
  [Full evidence and scope](staging-zero-invoice-ordering-acceptance.md).
  This is seeded webhook integration, not normal Checkout discount acceptance:
  invoice-only Finalize only automatically marked the $0 invoice paid, with no
  card, out-of-band payment or email. Actual Stripe fee/variance values are NULL,
  not measured zero; the fixture has no premium media/fulfillment link. Its
  one-period schedule shows no further invoice and cancellation October 5.
  These two scoped edge cases are closed; other release gates remain open.
- Supported installment amounts remain deliberately limited: equal whole-cent
  installments must sum to the total and the creator fee must be exactly
  representable by Stripe's two-decimal percentage field. For the tested
  schedule, $120/3 works; $100/3 and $999/3 are rejected. The owner subsequently
  chose expansion rather than accepting this launch limitation. Expanded
  collection is not completed here and this gate remains open.
- With specific owner approval, only the old failed Sandbox installment
  subscription was canceled immediately with No refund. Stripe shows Canceled
  at 13:32 Phoenix and retains its original paid $40 invoice. This closes the
  old fixture's disposition decision, not its original failed fulfillment or
  fee acceptance. The successful retest and all live subscriptions were left
  untouched; no financial database records were manually repaired or deleted.
- Organization usage is still on Free. The September 5 snapshot shows storage
  0.693/1 GB, database 0.13/0.5 GB, egress 0.036/5 GB, cached egress 0.023/5 GB,
  10/50,000 MAU and 6/200 peak Realtime connections. The expired grace banner
  is not itself an outage. This low-traffic snapshot is not a launch load test
  or proof of sufficient future capacity. Billing and recovery decisions remain
  approval-gated.
- The production project's read-only Database Backups page explicitly states
  that Free does not include project backups. No scheduled backup/restore test
  or alternate complete recovery set has been verified. Do not begin production
  migration until an owner-approved recovery approach is in place. Database
  backups also exclude Storage object bytes; media recovery needs separate cover
  ([Supabase backup scope](https://supabase.com/docs/guides/platform/backups)).
- The owner explicitly deferred the Supabase upgrade and directed safe staging
  work to continue. The last reviewed quote was $25 today / estimated $35/month
  for the two-project setup, with no payment method saved. No upgrade or spend-cap
  change occurred. The upgrade is not a prerequisite for the remaining access
  check; verified database and separate media recovery remain production gates.
  Recheck the quote and obtain specific approval before any later purchase.
- The owner ran the reviewed local checker in Edge on the canonical staging
  /profile page showing qa_buyer_20260904. The supplied screenshot records five
  PASS results at 2026-09-05T22:06:45.315Z: paid GET 200; unpaid/refunded GET 402;
  unpaid/refunded POST /api/premium/access 403. The checker validates application
  JSON, no URL on denial, and the expected synthetic staging file on the positive
  control. Its nine mocked self-tests had separately passed. This closes these
  authenticated cases; it is owner-provided browser evidence, not a new
  independent server-log review or proof of signed-out behavior. No runtime/UI
  code, financial records, security settings or production deployment changed.
- The owner then ran the separate signed-out checker in Edge InPrivate, with
  normal authorized Vercel Preview access but on CreatorNet's sign-in screen.
  The supplied screenshot records GET /api/watch/<synthetic-paid-post> and POST
  /api/premium/access both PASS at 2026-09-05T22:22:33.577Z. Each returned the
  expected application JSON 401 with no URL (GET Unauthorized; POST success
  false / Not authenticated). Twelve mocked checker self-tests had separately
  passed. These two signed-out cases are now complete, alongside the five
  authenticated cases. This is owner-provided browser evidence, not a new
  server-log review; other release requirements and the production hold remain.

## The rollout-order conflict and safe proposed sequence

### Read-only prerequisite review completed September 5

The production catalog was inspected without executing a migration or calling
any money-moving function. The eight migration-019 functions have the expected
argument/return types, one overload each, SECURITY DEFINER with
`search_path=public`, no effective anon/authenticated EXECUTE, and service-role
EXECUTE. Their bodies match the reviewed migration after removing comments and
formatting; four initial textual mismatches were inspected and were not
executable-logic differences. This comparison is not a transaction/concurrency
test or proof that every possible database object matches the repository.

The 27 inspected columns referenced by 021 are present with the reviewed types,
including the five `admin_actions` fields. The six foreign-key target tables
have validated `PRIMARY KEY (id)` constraints. Nine inspected payment/event/
checkout uniqueness indexes are valid and match their expected keys and
predicates. The five migration-019/020 private financial/coordination tables
have RLS enabled, no effective anon/authenticated table **or column** privileges,
and service-role SELECT/INSERT/UPDATE/DELETE.

Production still has no `refund_operations` table or create/claim refund
operation functions. Staging has both 021 functions with matching signatures,
return types and formatting-normalized bodies, the expected one-overload and
server-only execution restrictions, plus server-only table/column access and
enabled RLS on `refund_operations`. No schema, permission or financial-row
changes were made during these checks. Recheck these prerequisites at the
eventual approved release window; the backup and release holds remain.

### Proposed sequence — still not executed

Migration `021-admin-refund-operations.sql` says to install its objects before
the matching application serves requests. The existing schema-check workflow
requires migrations after merging, while the production branch can auto-deploy.
Merging and then racing the deployment with a manual migration is not safe.

The numbered outline below predates the expanded-installment implementation;
its **021-only migration step is not a complete rollout plan for 022–029**.
Do not execute it for the expanded candidate as written. Before any production
window, finish and accept the new path in staging, compare all actual migration
prerequisites/roles/triggers, and replace this outline with the reviewed exact
migration sequence and candidate-specific configuration/rollback plan. The
current exact adapters are deliberately Sandbox/Preview-only and HTTP collection
is default-off and bounded to selected staging agreements; production enablement needs an explicit reviewed implementation,
not copied staging keys, disabled guards, or an environment-flag shortcut.

Historical 021-only outline for an explicitly approved staged-production window:

1. Obtain owner approval for the production window, the migration, the exact
   candidate and the temporary Vercel domain-assignment setting change. Record
   the current Production deployment/commit and nonsecret environment inventory.
   Verify a usable backup/recovery procedure before any database write.
2. In the canonical Vercel project's Production environment, disable
   **Auto-assign Custom Production Domains** and verify the setting. This is a
   future approval-gated step, **not something this branch has configured**.
   Confirm the existing deployment continues serving `www.creatornet.net`.
3. Merge only the reviewed candidate. Wait for its **Production-environment**
   build to be Ready but staged, not Current. Do not promote the test-configured
   Preview artifact or copy its environment settings.
4. Recheck the production project identity and exact prerequisite definitions:
   migrations 019/020, `admin_actions`, and the tables/columns referenced by 021.
   Table existence alone is not a full schema comparison. Apply only 021 from
   the reviewed merged commit in its transaction, before the new deployment
   serves traffic. Do not blindly replay historical migrations.
5. Verify `refund_operations`, its constraints/indexes, enabled RLS, and the
   exact `create_refund_operation` / `claim_refund_operation` signatures.
   Anonymous/authenticated clients must lack table and function access;
   service-role access stays server-only. If the transaction fails, do not
   promote. Record the error, leave the currently serving app in place and
   investigate rather than patching the database ad hoc.
6. Verify production configuration and the staged build with read-only checks.
   It uses real production services: test cards, fixture creation, refunds,
   admin role changes and synthetic webhook events are **not** safe smoke tests
   there. Keep the already-approved fee schedule and canonical webhook intact.
7. Obtain the final release go-ahead, then promote that staged Production
   deployment. Verify sign-in, existing legitimate content, creator onboarding
   and administrative reads. A real payment/refund requires its own explicit
   authorization and limits. Monitor application/webhook errors and reconciliation.
8. Confirm the desired post-release domain-assignment setting with the owner;
   restore it only if approved. Record all changes and the release outcome.

Vercel documents staged production builds and manual promotion in
[Promoting Deployments](https://vercel.com/docs/deployments/promoting-a-deployment).
Verify the actual project controls at release time; if this control is not
available, stop and approve another deployment gate before merging.

## Rollback and financial-state preservation

- Keep the prior Current Production deployment available for rollback. An app
  rollback does not undo Stripe refunds, invoices, email sends or database writes.
- Retain 019/020/021 tables, audit records, event IDs and operation IDs. Do not
  drop the financial tables, reset their contents, or issue compensating live
  transactions automatically.
- If the future expanded path has created agreements, retain 022–029 evidence
  and collection holds too. A legacy application rollback cannot safely process
  those agreements by itself. Preserve version-aware quarantine/reconciliation;
  do not blindly turn off every schema flag or resume held Stripe subscriptions.
- If refunds are interrupted, stop initiating new refunds and reconcile each
  stored operation against Stripe. Retry using its existing idempotency state;
  never create a fresh refund simply because a response timed out.
- Do not toggle the creator-processing fee feature as a generic rollback step.
  That changes new-payment economics and does not rewrite existing plan metadata.
- Do not use the old relaxed-RLS/env-copying instructions in
  `supabase-test-db.md` as launch instructions. Acceptance testing must preserve
  the intended security controls and environment isolation.

## Evidence boundaries

Private bucket configuration and server entitlement checks prevent new
unauthorized links. They do not revoke copies already downloaded; a previously
issued signed URL remains a separate expiry-window test. The current handlers
issue one-hour URLs. Do not claim immediate revocation of every previously
issued link without measuring that behavior.

Stripe does not guarantee event order. Event-ID idempotency and reconciliation
must remain intact; see [Stripe webhook event ordering](https://docs.stripe.com/webhooks#event-ordering).
