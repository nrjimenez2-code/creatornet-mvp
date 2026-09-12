# Exact-installment canonical migration map — 2026-09-07

This is an isolated, local integration change, not deployment or database-execution
approval. Only the eighteen **unapplied** exact-installment sources move from
022–039 to **040–057**. Their suffixes, executable SQL, database object names,
dependency order, feature gates, and financial behavior remain unchanged. Twelve
SQL comment lines in nine sources update dependency numbers.

Historical 019/020/021 and Landon's 024 review / 025 feed filenames remain unchanged.
Pending feed 023 is **not selected** for this integration. Review RLS 026 is a
separate security change, not part of the eighteen-source exact bundle.

## Canonical filenames

Every suffix in this table is prefixed by the number and a hyphen, under
`supabase/schema/`. The former numbers identify historical checkpoint evidence;
they are not alternate executable copies to retain in this directory.

| Former | Canonical | Unchanged suffix |
|---|---|---|
| 022 | 040 | exact-installment-agreements.sql |
| 023 | 041 | exact-installment-receipt-credit.sql |
| 024 | 042 | exact-installment-activation.sql |
| 025 | 043 | exact-installment-invoice-claims.sql |
| 026 | 044 | exact-installment-purchase-lifecycle.sql |
| 027 | 045 | exact-installment-collection-holds.sql |
| 028 | 046 | exact-installment-refund-events.sql |
| 029 | 047 | exact-installment-billing-stops.sql |
| 030 | 048 | exact-installment-lifecycle-events.sql |
| 031 | 049 | exact-installment-payment-recovery.sql |
| 032 | 050 | exact-installment-stop-request-identity.sql |
| 033 | 051 | exact-installment-card-setup.sql |
| 034 | 052 | exact-installment-payment-confirmation.sql |
| 035 | 053 | exact-installment-retry-admission.sql |
| 036 | 054 | exact-installment-payment-intent-version.sql |
| 037 | 055 | exact-installment-bank-verification.sql |
| 038 | 056 | exact-installment-future-card-consent.sql |
| 039 | 057 | exact-installment-checkout-publication.sql |

The reviewed historical financial prerequisites, including refund operations 021,
must exist before exact 040–057. Do not replay those prerequisites just because
this candidate uses new filenames. Numbering is not hosted applied-state evidence.

Do not execute the entire schema directory in numeric order. Reviews require 024's
schema before the per-offer application, then the separately reviewed RLS change.
If pending feed 023 is selected later, its function replacement must follow feed
025, despite its lower number. Those changes require their own acceptance.

## Current local bundle identity

`test-support/exact-staging-bundle-manifest.json` remains the explicit ordered
eighteen-source inventory with SHA-256 of UTF-8 after CRLF-to-LF normalization only.
The catalog-derived test installer now consumes that same order and rejects missing,
extra, duplicate, renamed, and obsolete exact source files. Unrelated migrations
are not included in the exact bundle.

- Package SHA-256: `76693f3efd01473225caa66bfcfd39da00766ce95cc491609f38f40a6f5b6be8`.
- Manifest SHA-256 (builder's JSON serialization): `bc5df8697caaa8ee4a5e3bda76baab636f32cbecbb250dda65055713bde54271`.
- Output: 237,692 UTF-8 bytes; 18 sources; 57 new relations (16 tables / 41 indexes);
  60 exact function signatures. The object inventories and deployment gates are unchanged.

Reproduce the identity locally with
`node test-support/prepare-exact-staging-bundle.cjs --summary`; this does not connect
to a database or execute SQL. These values supersede the old package identity for
current-candidate review only. The old hashes, dates, and test results retained in
the checkpoint documents continue to describe the pre-remap candidate.

## Local verification

Before updating checksums, all eighteen original normalized source hashes matched
the historical pinned manifest. Comparison of each old/new source found identical
line counts and no changed non-comment SQL lines. Only twelve full-line dependency
comments changed, across nine files; the remaining nine source hashes are unchanged.

Focused local acceptance passed: **421 tests / 5 suites**, in 148.593 seconds:

- `exact-installment-database.test.ts`
- `exact-installment-credit-database.test.ts`
- `exact-installment-lifecycle-database.test.ts`
- `exact-installment-staging-schema.test.ts`
- `exact-staging-bundle.test.ts`

This includes canonical manifest discovery, stale/missing/extra-source rejection,
the complete catalog-derived exact schema, receipt/credit/lifecycle cases, and
the bundle's late-failure transaction rollback checks. The cache was isolated at
`.test-cache/exact-migration-remap`; dependencies were not changed. All 36 original
source/reference/document files fingerprinted before this work remained byte-identical
afterward. The original checkout was not edited.

These are local, in-memory PGlite checks, not hosted recovery or concurrent-worker
acceptance. Full integrated regression/typecheck and separately approved hosted
gates remain outside this remap's result.

No hosted schema installation, feature enablement, Stripe call, production change,
commit, or push is authorized or performed by this remap.
