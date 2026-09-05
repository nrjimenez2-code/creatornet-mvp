# Admin refund release gate (PR #125)

Status: **HOLD — no production deployment or database change is authorized by
this document.** The owner requested that work stop before production.

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
  These close the raw unsigned-file checks, not signed-link expiry or the
  authenticated application endpoint matrix.
- Direct browser navigation to the application link issuer is blocked by the
  browser client. A separate signed-out network probe returned HTTP 302. Neither
  response proves the application returned its expected 401/402/403 denial.
  Do not weaken Preview protection or export browser cookies to make this pass.
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
  real first-delivery out-of-order and zero-dollar invoice evidence is still open.
- Supported installment amounts remain deliberately limited: equal whole-cent
  installments must sum to the total and the creator fee must be exactly
  representable by Stripe's two-decimal percentage field. For the tested
  schedule, $120/3 works; $100/3 and $999/3 are rejected. Owner acceptance of
  this limitation is required; unrestricted pricing is not completed here.
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

## The rollout-order conflict and safe proposed sequence

Migration `021-admin-refund-operations.sql` says to install its objects before
the matching application serves requests. The existing schema-check workflow
requires migrations after merging, while the production branch can auto-deploy.
Merging and then racing the deployment with a manual migration is not safe.

Use an explicitly approved staged-production window:

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
