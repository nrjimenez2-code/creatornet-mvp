# Atomic review prerequisites — local design, 2026-09-08

No hosted execution is authorized by this artifact. The original migration bytes,
historical 024 identity, corrected 026, application code, and exact-payment manifest
are unchanged. This is a separate local preparation helper and fixture/test suite.

## Recommended boundary

1. Review and separately authorize the purchase ACL prerequisite in
   `staging-purchases-readonly-acl-prerequisite.sql`, plus any rating-RPC prerequisite
   warranted by inspection of the actual hosted function bodies. The review package
   does not change purchases permissions or either legacy rating function.
2. After those prerequisites are satisfied, apply **024 then corrected 026 in one
   bounded transaction**, not two independent pastes/commits. A late 026 privilege
   assertion must roll back 024's new column/index/FK and removed old uniqueness too.
3. Independently verify staging behavior and obtain any further app/deployment
   approval. Keep the exact-payment schema package and enablement gates separate.

The ACL prerequisite is a separate transaction. If it succeeds and the later
review package fails, purchase permissions intentionally remain closed while review
schema/permissions/data return to their prior state. Do not reopen purchase writes
as a speculative rollback. Hosted project identity and recovery readiness cannot
be proved by this helper.

## Preparation helper

`test-support/prepare-review-prerequisites.cjs` only reads local sources and returns
or prints SQL. `--summary` reports its identity; `--print` prints the review design.
It contains no database/network client and executes no SQL.

The helper pins exactly two source names, order, and normalized SHA-256 hashes. It
removes only their two reviewed outer BEGIN/COMMIT tokens; all other normalized
source bytes, including function bodies and historical comments, are preserved.
Additional executable transaction controls or source/checksum drift fail closed.
The resulting package has one BEGIN/COMMIT, five-second lock and 30-second statement
timeouts, and a strict pre-024 shape/collision preflight. Corrected 026's own type,
FK/index, purchase-ACL, role, original-policy, collision, and final effective-ACL
assertions remain intact. Reapplication or a partial/unknown review schema is refused.

- 024 normalized SHA-256: `768c8175815eb38a00bfd04b0910296b97a49156e740238a501af680e1a00d5a`.
- 026 normalized SHA-256: `719d59961d9474d4be199ff6c27ccdbd01f9b3a980c8d6c2f2d3099f10191c83`.
- Combined package SHA-256: `e89d9958edccc34ba8eb4b6c65a16aa0dc8eb42af4519a9f0eeb4434ccbcbc9b`.
- Combined package: 22,958 UTF-8 bytes, two sources.

## Test model and limitations

`test-support/review-pre024-fixture.ts` uses the captured September 6 financial/content
catalog (including the 44-column purchases table), then reproduces the September 8
review observation: seven pre-024 columns, old reviewer/creator uniqueness, RLS,
the four original policies and broad effective client grants. All inserted users,
products, purchases and legacy reviews are synthetic.

The later `staging-rating-catalog-20260908.json` observation supplies the actual
timestamp trigger and rating-recompute routine definitions. The fixture verifies
their raw MD5 fingerprints and executes those two definitions verbatim; neither is
rewritten by the review package. Defaults, auth.uid and the representative purchase
SELECT policy remain synthetic substitutes, not full hosted-schema reproduction.
Tests check that existing routines/trigger identities survive and the admin operation
sequence (service read/delete/actual rating recompute/audit) remains possible. Actual
admin authentication, live privilege provenance and the separate legacy
`profile_reviews` system require their own review; these tests do not certify them.

The new package tests cover legacy NULL-row preservation, per-post uniqueness,
post-delete cascade, unchanged-identity API updates, caller/creator/purchase/self
fences, retarget denial, direct privilege denial, public reads, owner deletion,
service moderation, untouched purchases, source preservation, reapplication refusal,
and rollback of both migrations after late inherited-privilege failures. They also
exercise the separately prepared purchase ACL artifact before the review transaction.
One integrated case installs all three captured rating routine definitions with the
two RPCs' observed five-grantee ACL, then applies the actual purchase ACL artifact,
actual rating ACL artifact, and review package in that order. It checks client RPC
and purchase-write denial, eligible authenticated reviews, the service six-field
insert/update/delete/recompute/audit sequence, and unchanged legacy rows and routine
bodies. Its minimal synthetic `profile_reviews` table exists only to support the
captured definition; no external legacy caller or hosted direct-table ACL is certified.

Local verification: all 20 package cases passed in 172.1 seconds; the full
nonincremental TypeScript check and targeted lint for the helper, fixture and test
also passed. The after-suite check confirmed both original migration files remained
byte-identical. The raw file SHA-256 values remain
`b03162117693fc6c29c026b9b2fc331a1d29e1a33de1129170f78af405f21079`
(024, original line endings) and
`719d59961d9474d4be199ff6c27ccdbd01f9b3a980c8d6c2f2d3099f10191c83` (026).
These are local synthetic tests, not hosted deployment verification. No browser,
hosted database, payment, production, git staging, commit or push action is part
of this preparation.
