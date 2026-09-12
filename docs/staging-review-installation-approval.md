# Staging review prerequisites — proposed execution scope

> Execution update (2026-09-08 UTC): the user subsequently approved this exact
> three-item scope. All three units are installed and independently checked on
> original staging `nwqfofezfzljhxolkycz`; do not replay them. See workspace report
> `outputs/creatornet-staging-prerequisites-installed-20260908.md`. The proposal
> below is retained as the scope/version record. It grants no further authority
> for 040–057, payment enablement, Preview publication or production.

Preparation only. This document is **not execution approval**. No production
deployment, production query, payment, credential or billing change is included.

## Exact target and artifacts

Only CreatorNet Staging, project `nwqfofezfzljhxolkycz`. Do not use the recovery
copy `cbqwdqfhpltkulpcqtlg` or production `rvkqxgghqitkwzdsuclz`. Verify the
project name AND ID in the dashboard at execution time; the branch badge alone
does not identify the correct environment.

1. `docs/staging-purchases-readonly-acl-prerequisite.sql`: 13,011 bytes,
   SHA-256 `d481d20f44ad445fb54ae7fa180a984759a701802163420779216213b0d966f4`.
   Remove only client non-read purchase privileges. Preserve reads, policies,
   triggers, structure, rows and server rights. Stop on unreviewed grants/roles.
2. `docs/staging-rating-acl-prerequisite.sql`: 6,357 bytes,
   SHA-256 `6b9b1bb9c6811f37b2732fa0e8ef57956f46cb5f12db90f9c06a2c80561fd4a7`.
   Remove PUBLIC/anon/authenticated EXECUTE from the two exact rating RPCs.
   **This intentionally retires authenticated direct calls to the old
   set_profile_rating method** and makes update_profile_rating server-only.
   Existing bodies, owner, service execution, timestamp trigger and data stay.
   The current per-offer API uses the server updater; external old-client usage
   and profile_reviews direct-table permissions are not certified by this step.
3. The output of `test-support/prepare-review-prerequisites.cjs --print`:
   22,958 bytes, SHA-256
   `e89d9958edccc34ba8eb4b6c65a16aa0dc8eb42af4519a9f0eeb4434ccbcbc9b`.
   It combines exactly 024 and corrected 026 in one transaction. Adds per-offer
   review association/uniqueness and purchase/identity write protections. It
   does not invent a post association for old reviews: their NULL association
   is retained, they remain readable and owner-deletable, but are not editable
   or silently converted into new per-offer reviews. No old review is deleted.

The purchase prerequisite, rating prerequisite, and review package are three
separate transactions. **Only 024 plus 026 are atomic together.** If a later
transaction fails, earlier successful permission restrictions intentionally
remain. Never reopen purchase/rating writes as a speculative rollback.

## Required execution sequence after explicit approval

Final local evidence: 115/115 tests in seven suites passed (301.325 seconds),
including the actual three-artifact sequence with the captured rating bodies.
Nonincremental TypeScript and targeted lint passed. Independent code reviews
found no blocker within this scope. These are local synthetic results, not hosted
installation or application acceptance. Test JSON is in the candidate's ignored
`.test-cache/staging-prerequisites-final.json`.

- Reconfirm staging target, recovery evidence, artifact hashes and unchanged
  observed baseline. Reuse the completed recovery exercise; do not restore again.
  Keep exact-payment issuance and collection disabled. Do not expose new flows
  using a Preview whose code does not match the reviewed candidate.
- Run each complete artifact in the order above, independently checking its
  result before proceeding. Verify the entire editor contents after paste;
  do not run selected fragments, add COMMITs, suppress assertions or change roles
  to force a pass. Stop after an error or uncertain outcome and inspect read-only.
- Reuse the metadata audit/detail queries for an independent post-install
  comparison: target-specific client denial, preserved server/SELECT access,
  exact rating definitions, untouched timestamp trigger, post_id/FK/unique
  review state and restrictive policies/helpers. Compare approved aggregate
  pre/post counts if collected; an SQL success alone is not data-preservation
  or end-to-end acceptance evidence.
- Verify current per-offer review, moderation, library/watch and checkout flows
  on the matching isolated Preview. Local synthetic tests do not replace these
  hosted checks. No real card, customer payment or production session is needed.

## Still outside this approval

The exact-payment schema 040–057 and payment/collection enablement are separate;
so are source product-alias follow-up, hosted end-to-end payment acceptance,
production implementation/configuration/recovery, policy/business facts and
the final deployment decision. This package is not a claim that launch is ready.
The original source checkout and existing recovery copy must remain preserved.
