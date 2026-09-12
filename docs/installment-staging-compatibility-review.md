# Staging compatibility and access review — September 6, 2026

> Integration numbering note (2026-09-07): the unapplied exact-installment sources are now **040–057**. Explicit filenames below use the canonical names; older numbered checkpoint references, test results, and captured hashes retain their historical 022–039 meaning. See [the migration map](exact-installment-migration-map.md) for the current sequence and new local acceptance. Historical results are not approval to install the renamed candidate.

Status: **HOLD before hosted payment testing. No production approval.**

## Latest checkpoint — approved staging ACL repair completed

After explicit owner approval, `staging-restore-financial-acls.sql` ran in the
visibly verified **CreatorNet Staging / nwqfofezfzljhxolkycz** project and returned
`Success. No rows returned`. Fresh full-result exports from the independent
read-only check changed from **12 REVIEW / 3 PASS to 15/15 PASS**. Evidence recorded
at 20:35:30 UTC is in
`test-support/staging-financial-acl-repair-result-20260906.json`.

All ten checked functions deny anonymous/authenticated EXECUTE and preserve
server EXECUTE. All five checked tables retain RLS, deny client table/column
privileges and preserve server SELECT/INSERT/UPDATE/DELETE. Only the eight drifted
function signatures and four drifted tables/columns were repaired; the three
already-private objects were independently rechecked, not changed.

Before execution, an independent review prompted one extra transactional guard:
recheck server CRUD after each table revoke and roll back if effective access
depended on a revoked PUBLIC/client grant. All **8 targeted ACL tests passed**,
including that new regression. The previous 2348-test full-suite result below
predates this one additional test; the full suite was not rerun at this checkpoint.

This resolves the **specific staging ACL blocker**, not release readiness. The
repair contains only ACL revocations and checks: no data updates/deletes, function
replacement, RLS-policy change, credential change or new server grant. No hosted
financial RPC or Stripe action was invoked. No feature migrations, configuration
enables, commit/push, production merge/deployment or billing upgrade occurred.

A subsequent local migration review found three internal helpers could inherit
direct `service_role` EXECUTE from permissive database defaults. The new regression
failed before correction. Local-only migrations 024 and 026 now explicitly revoke
that helper access while retaining their public server RPC grants; function bodies
are unchanged. **354 targeted staging/activation/lifecycle tests passed** after
the correction. Those prospective migrations still have not run remotely.
See the [staging installation/recovery plan](installment-staging-installation-plan.md).
The owner confirmed there is no verified staging backup yet; installation remains
blocked on recovery readiness and separately approved execution.

A local deterministic installation-preparation tool now pins the eighteen source
files and checks all planned relations/functions/triggers before its single COMMIT.
Its nine focused tests passed, including late-failure rollback. It only returns or
prints reviewed SQL; no database connection or installation is performed. The
exact inventory, hashes and limits are in the installation plan above.

Final verification after all of these local changes: **2359 tests / 102 suites
passed** (184.061 seconds), standalone TypeScript passed, targeted lint passed
without warnings/errors, and `git diff --check` passed with line-ending notices
only. No new optimized build was claimed for this SQL/test/document checkpoint.

## Verified observations

Read-only SQL catalog queries ran against CreatorNet Staging,
`nwqfofezfzljhxolkycz`. The Supabase dashboard's `main / PRODUCTION` badge names
that project's branch; the selected project was **CreatorNet Staging**, not the
live CreatorNet project. No customer rows or secrets were queried.

The structural export at 19:13:57 UTC contains 429 catalog rows: 267 columns,
65 constraints, 77 indexes, three enums, three existing triggers, three dependency
functions and 11 table states. No `exact_installment_%` tables were present.
The access export at 19:18:11 UTC contains 525 catalog rows. Source exports are
saved in `test-support/staging-installment-catalog-20260906.json` and
`test-support/staging-financial-access-20260906.json`. These are historical
schema/access evidence, **not data backups or current security certifications**.

- `booking_payments.plan_type` and `.status` are enums, not text.
- The payment, post and purchase product FKs reference `products.id`.
- Required closer identity references `auth.users.id`.
- The existing purchase trigger is enabled. The new seed supplies both canonical
  IDs, so it does not depend on that trigger's older alias fallback.
- The existing one-live-payment and buyer/post/product uniqueness protections
  are present and validated.
- All four inspected internal financial tables have RLS enabled. No policies
  were returned for the five audited financial/operation tables.

## Historical pre-repair staging permission blocker

The pre-repair snapshot showed all eight financial functions from migration 019 had effective
`EXECUTE` permission for both `anon` and `authenticated`:

- `claim_stripe_event`, `complete_stripe_event`, `release_stripe_event`
- `record_payment_dispute_state`, `record_payment_refund_state`
- `credit_payment_fee_ledger_earnings`
- `apply_purchase_refund_earnings`, `apply_payment_fee_ledger_refund`

They are `SECURITY DEFINER` functions. The two migration-021 admin refund
functions are already private. Four internal tables also have broad client
table privileges: `payment_fee_ledger`, `stripe_events`, `payment_refund_state`,
and `payment_dispute_state`. RLS limits ordinary direct row access, but does not
make the exposed security-definer RPCs safe. No exploit or unauthorized financial
mutation was attempted. This snapshot does not establish when or how the grants
were introduced, nor prove a production issue. Migration 019 in this repository
already explicitly requires server-only access.

A subsequent read-only comparison at approximately 19:33 UTC against the live
project `rvkqxgghqitkwzdsuclz` returned **12/12 server-only results** for those same
eight exact function signatures and four tables (including effective client
column privileges, RLS, and required server permissions). Thus this specific
observed ACL drift is confined to staging in these checks. This narrow comparison
does not recertify all production permissions, data, billing or release readiness.
No production data, grants, function bodies or settings were changed.

Repair: `staging-restore-financial-acls.sql`, **now applied and verified above**. It revokes
only PUBLIC/anon/authenticated privileges on those eight exact function signatures
and those four tables/columns. It requires RLS and existing server permissions,
preserves all function bodies/owners, rows, policies and server grants, fails
atomically if unexpected inherited access remains, and is safe to repeat in the
local permission tests. It does not rerun 019's backfills or grant new access.

Do not treat this repaired permission issue as approval to install or enable the
new feature. If later verification fails, investigate; do not disable RLS or
relax permissions to get tests passing.

## Local compatibility proof and limits

`exact-installment-staging-schema.test.ts` reconstructs the inspected types,
columns/defaults, constraints, indexes and trigger bodies in memory, then applies
all 18 migrations, 022–039. It exercises reservation/replay, pending purchase
seeding, publication, first receipt/fulfillment, monthly/final-cent receipt
accounting and duplicate protection. It also challenges the new migrations with
deliberately permissive local default grants and checks their client restrictions.

This does **not** reproduce all hosted policies, extensions, auth behavior or
concurrent connections. `auth.users`, `orders`, and `offerings` are only FK target
stubs, not full copies. Monthly due times are adjusted only inside the synthetic
memory database; this is not a Stripe test-clock or hosted end-to-end acceptance.

`staging-financial-acl-repair.test.ts` separately tests the repair against the
observed function bodies/signatures and intentionally permissive synthetic ACLs.
It checks client/column access removal, unchanged rows/function bodies/owners,
preserved server access, idempotency, and atomic failure for missing protection
or unexpected inherited permissions. No hosted function is called by these tests.

Final local verification: **2348 tests / 101 suites passed** (207 seconds),
standalone TypeScript passed, targeted lint passed without warnings/errors, and
`git diff --check` passed with only existing line-ending notices. An early new
synthetic monthly fixture reused the same due timestamp for two periods; that
test-only setup was corrected to preserve the real unique constraint, then the
entire suite passed. No application behavior or schema constraint was weakened.
The prior optimized build result remains historical; no application source was
changed by this compatibility/access-review checkpoint.

## Next safe order

1. **Done:** approved narrow staging permission repair and fresh verification
   returned all 15 PASS rows, including the already-private admin RPCs/table.
2. Finish candidate/migration review and the staging recovery/checkpoint plan,
   then obtain the bounded staging installation/configuration approval. Keep
   default-off flags and booking/agreement allowlists until explicitly enabled.
3. Publish the reviewed candidate to Preview and run complete hosted Sandbox
   acceptance: checkout, real webhook order/replay, monthly/final payment,
   decline/recovery, refund/stop races, access and visual checks.
4. Close public-policy/legal facts and operational/recovery gates. Review the
   production implementation separately: current exact-payment adapters reject
   production deliberately; copying Preview flags is not a rollout solution.
5. Present evidence and request production authorization. Do not merge/deploy
   production from a staging pass alone.

The original review made local test/document changes and read-only queries. The
later explicitly approved checkpoint changed only the scoped staging ACLs noted
above. It did not commit/push, install a feature migration, touch Stripe, change
credentials/configuration, upgrade billing or alter production.
