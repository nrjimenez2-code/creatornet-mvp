# Exact-installment staging installation and recovery plan

> Current status, September 8, 2026 UTC: the checksum-pinned 040–057 bundle was
> installed once on original staging and independently verified. All 16 new
> tables are empty; existing metadata/ACL fingerprints are unchanged. **Do not
> rerun the installation.** The historical preparation and approval notes below
> are superseded by the parent workspace report
> `outputs/creatornet-exact-staging-schema-installed-20260908.md` and the latest
> integration checkpoint. No Preview publication, payment enablement or
> production change is authorized by this completed schema-only step.

> Integration numbering note (2026-09-07): the unapplied exact-installment sources are now **040–057**. Explicit filenames below use the canonical names; older numbered checkpoint references, test results, and captured hashes retain their historical 022–039 meaning. See [the migration map](exact-installment-migration-map.md) for the current sequence and new local acceptance. Historical results are not approval to install the renamed candidate.

September 6, 2026. **Preparation only. Not authorization to install, enable,
charge, push, merge or deploy. Production remains out of scope.**

## Verified checkpoint

- Working branch: `admin-refund-allocation`; committed base
  `6b3d92f0f766ea0b09b96bfb737196c6ad176ab5`. The expansion is still local.
- Allowed database target for a separately approved installation:
  **CreatorNet Staging / `nwqfofezfzljhxolkycz`**. Production
  `rvkqxgghqitkwzdsuclz` must not be selected. Supabase's branch label alone
  does not distinguish the two projects.
- The separately approved ACL repair is complete: fresh **15/15 PASS** checks
  preserve server rights and deny client access. See
  `test-support/staging-financial-acl-repair-result-20260906.json`.
- The historical structural snapshot predates installation. It is schema
  evidence, not a backup, nor proof that every prospective object is absent now.
- Migrations 022–039 have passed catalog-derived local compatibility tests but
  have not been installed on hosted staging. No new feature settings are enabled.

Independent bounded source reviews of creator ownership/link publication and
the exact webhook/debit handoff found no additional concrete blocker. They
confirmed ownership before lookup, immutable Stripe request claims, fee/destination
checks before URL publication, receipt-only events exiting before debit admission,
and the single debit path requiring an allowlisted Sandbox agreement and durable
admission with SDK retries disabled. These are source-review findings, **not**
hosted acceptance or certification of the entire candidate. Preserve the documented
schema/reconciliation gates for existing agreements when pausing new issuance.

## 1. Finish prerequisites without changing hosted behavior

Review the complete candidate, current source checksums and explicit new-object
manifest. Recheck actual staging for collisions or partial installation. The
inventory must cover functions such as `read_exact_buyer_recovery` and the
`exact_card_setup` helpers, not merely names matching `exact_installment_%`.
An unexpected object or duplicate is a stop condition, not permission to delete
or overwrite it. Recheck financial permissions after any independent changes.

The individual 022–039 files contain their own BEGIN/COMMIT statements and are
not a replay-safe sequence. Some later migrations rename functions and replace
constraints introduced earlier. Do not concatenate them and blindly retry after
an error; wrapping their unchanged text in another BEGIN does not make them one
transaction. A prepared atomic package must validate the exact source versions,
remove only reviewed outer transaction wrappers, use bounded local timeouts,
and demonstrate rollback on a late failure before it is considered for execution.
Do not alter canonical migrations or weaken constraints to make it install.

### Prepared local package

`test-support/prepare-exact-staging-bundle.cjs` now prepares the candidate as one
transaction without connecting to any database. `--summary` prints its digest and
inventory; `--print` prints SQL for review only. Neither option writes files or
executes an installation. The adjacent `exact-staging-bundle-manifest.json` pins
all 18 ordered source files using SHA-256 after CRLF-to-LF normalization only.
Any source drift requires review, not automatic checksum replacement.

The package removes only the reviewed outer BEGIN/final COMMIT wrappers, preserves
each source body, adds a five-second lock timeout and 60-second statement timeout,
and checks prospective collisions before DDL. Assertions before the single COMMIT
check 57 new relations (**16 tables / 41 indexes**), 60 exact function signatures,
their intended security-definer and direct server permissions, client denial,
three triggers and the additive legacy marker/constraint. New tables must be empty.
The UTC month helper remains SECURITY INVOKER; it is not silently promoted.

Nine focused local tests passed, including full installation on the catalog-derived
baseline, all planned relation/function-name collisions, row/array/legacy-object
collisions, repeat-install refusal and a deliberately induced late ACL failure
that rolls back schema changes while preserving synthetic legacy rows. These are
single-process PGlite tests, not a hosted restore or concurrency proof.

Reviewed package SHA-256:
`a09d9bc0239f07d1f170dbf1b5f433e71235779e3d0b6c4fbaf9d882b5a6335d`.
Manifest SHA-256:
`5c88a072ce21520041336c646d23b467bb1c21ac4280bb0ffdad79743791e16c`.
Output is 237,680 UTF-8 bytes. Recheck these against the final reviewed candidate
before any separate installation approval. **This package has not run remotely.**

Final local regression check after preparation: **2359 tests / 102 suites passed**
in 184.061 seconds. Standalone TypeScript and targeted ESLint passed; the diff check
reported only line-ending notices. These results do not close the recovery or
hosted acceptance gates below.

## 2. Preserve staging evidence before installation

The existing staging environment contains earlier payment/auth/media acceptance
evidence; it is not disposable. No verified recovery set or restore drill is
currently recorded. The owner explicitly confirmed on September 6 that there is
**no verified staging backup yet**. The earlier owner-only recovery preparation is
`outputs/creatornet-recovery-preflight-2026-09-05.md` in the parent workspace.
Production backup readiness remains a separate release gate and does not authorize
copying production data into staging.

Before exporting staging data, resolve the restricted encrypted destination,
retention/access owner, approved existing connection method and isolated restore
target. Keep credentials and exported rows outside Git, chat, public storage and
general-purpose Downloads. Do not reset a password or create a key as an implicit
setup step. A fresh PATH check on September 6 did not resolve `supabase`, `pg_dump`,
`pg_restore`, `psql`, `docker`, `rclone` or `aws`; this is not proof that no copy is
installed anywhere. No tool installation or credential access occurred.

Later September 6 update (21:36 UTC): the owner approved local recovery-tool
preparation. Portable PostgreSQL 17.11 clients and age v1.3.2 are now prepared
outside this repo at `C:/Users/sandy/CreatorNet-Recovery`; offline version checks
and synthetic archive-encryption tests passed. Its `vault` subfolder is
owner/SYSTEM-only; archive contents, not the directory itself, are encrypted.
No database connection/export, actual restore or source-credential access
occurred. The synthetic-only DPAPI-protected test identity is not a real backup
key. Secure staging access, actual key retention, server-version compatibility
and an isolated compatible restore target remain unresolved. See the appended
checkpoint in the parent workspace's recovery-preflight report before repeating
any setup. The existing older exports and acceptance evidence were preserved.

Supabase recommends off-site exports for Free projects; database backups exclude
Storage object bytes. Treat database, authentication/configuration and uploaded
media coverage separately. The owner's upgrade deferral remains unchanged.
[Supabase backup documentation](https://supabase.com/docs/guides/platform/backups)
and [backup/restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
were checked September 6. Their example password reset is not authorization to
reset CreatorNet credentials.

Record snapshot time, coverage/exclusions, versions, checksums and aggregate
counts without customer rows or secrets in the manifest. Verify restoration only
into the separately approved isolated destination with live billing, email,
webhooks and jobs inactive. Never restore over production or the current evidence
staging project. An atomic migration rollback test is useful but is **not** a
database/media recovery backup or a hosted restore drill.

## 3. Separately approved schema-only staging window

Keep all new issuance/collection gates disabled and both booking/agreement
allowlists empty. Confirm no competing migration or payment-test run. Verify the
project header and URL immediately before execution; SQL alone must not be
represented as proof of hosted project identity.

Run only the reviewed package matching the recorded source checksums. Require
an unambiguous transaction outcome and independent post-install object, column,
constraint, trigger, RLS and effective-privilege verification. If a timeout,
disconnect or unexpected result occurs, inspect catalog state first: do not
assume rollback, press Run repeatedly, or use CASCADE/blanket grants to proceed.
No fixture creation, Stripe action, secret change or feature enablement belongs
to this schema-only window. Leave gates off when verification is incomplete.

## 4. Candidate Preview and bounded hosted acceptance

Only after the preceding evidence and separate approval, publish the reviewed
candidate to Preview, not an auto-deploying production branch. Record its exact
commit/deployment URL and test-mode webhook destination. Do not test an old
deployment and attribute the result to the new candidate.

For issuance, the current code requires the known staging Supabase URL,
`VERCEL_ENV=preview`, a Stripe test key, a matching trusted HTTPS Preview origin,
all required readiness gates and a bounded booking allowlist. Monthly collection
has a different agreement allowlist and debit gate; permission to publish a test
Checkout link does not independently authorize a monthly debit. See
[checkout publication](installment-checkout-publication.md) and
[monthly collection](installment-monthly-webhook-collection.md).

Test new app-owned fixtures end to end: first/intermediate/final payments, exact
fees and last-cent total, one receipt/credit per payment, termination without an
extra charge, event duplication/order/loss, failed payment/3DS and recovery,
optional future-card choice, refunds/stops/disputes and concurrent requests.
Verify unauthorized access denial, creator/buyer UI and existing auth/resource
flows on the same candidate. Preserve earlier manual Stripe fixtures separately;
they are not acceptance for the app-owned flow.

## Pause and recovery boundaries

- Before any new agreement: keep issuance/collection off; investigate schema
  or deployment errors without deleting prior staging evidence.
- After agreements exist: disable new issuance and monthly dispatch, but retain
  the installed schema and reconciliation-aware code/gates. Do not roll back to
  legacy-only code that cannot identify those agreements.
- Previously published Stripe Checkout URLs remain usable when an app publication
  switch is disabled. Use the separately approved stop/expiry workflow when they
  must close. Do not claim a configuration toggle canceled a subscription.
- Reconcile uncertain/admitted charges from Stripe and immutable receipt evidence;
  do not submit another debit to discover what happened. Preserve refunds, holds,
  credits and audit history. Database restore cannot undo a Stripe transaction.

## Remaining production gates

No staging result alone authorizes production. Current exact-payment adapters
deliberately reject production: changing environments requires a separate reviewed
implementation/configuration decision, not copying test flags. Production recovery,
hosted acceptance, visual QA and owner authorization remain necessary.

Policy sources also remain unresolved: `app/legal/delivery/page.tsx` currently
promises end-of-month cancellation with no further charges, whereas the proposed
fixed-total plan requires different prospective wording and consent. The terms
source still asks for verified legal-entity, mailing-address and governing-law
details. Do not invent those facts or retroactively change existing buyer promises.
No policy or application UI was changed by this preparation.

## September 7 update — selected staging restore exercised

This updates the earlier recovery checkpoint; it does not authorize installation.
After owner approval and private password submission, Supabase restored the
`2026-09-07T10:23:35Z` physical backup of original staging
`nwqfofezfzljhxolkycz` into the separate recovery project
`cbqwdqfhpltkulpcqtlg` (CreatorNet Staging Recovery 2026-09-07).

Actual read-only source/clone checks matched the reviewed isolation inventory,
nine public-schema fingerprint categories, 13 selected table counts and 12
relationship counts. The clone passed all 15 private financial ACL checks without
repairing grants. Two auth users without profiles matched in both observations;
no cause is asserted. Four existing Advisor view findings remain separate.

See the parent workspace report
`outputs/creatornet-staging-restore-verification-20260907.md` for exact evidence
and limits. These checks exercise a selected database recovery path, not all
media/configuration recovery or production readiness. The original staging
database and application code were unchanged. The recovery copy remains a billed,
separate project; cleanup requires exact-target confirmation.

Before proceeding, recheck the candidate package and current staging collisions,
then obtain separate schema-only installation approval. Migrations 022-039 have
still not been installed remotely by this recovery workflow. Issuance and monthly
collection must remain disabled; no production deployment is authorized.

## September 7 follow-up — reconcile Landon's code before installation

The new owner-supplied action list and fresh Git inspection supersede the
immediate-next-install sequence above. Main is now `17a6778`, with 11 commits
after our common base; our branch retains 21 distinct commits plus uncommitted
exact-payment work. Preserve both sets before preparing a combined candidate.

Incoming/pending migration prefixes 023–026 collide with exact-payment filenames,
and the proposed refund 021-to-027 rename would add another collision and obscure
dependencies. Pending feed migration 023 depends on feed migration 025 despite
numeric order. Pending review-RLS migration 026 also needs security corrections
and tests before use. Do not execute by numeric prefix or wildcard, rename only
filenames, or assume Git presence proves hosted installation.

See the parent workspace
`outputs/creatornet-landon-reconciliation-20260907.md` for exact commits, six UI
overlaps, full migration identities, review/refund compatibility findings and
the revised sequence. The previous exact bundle summary still passes locally,
but does not establish compatibility with this combined work. Any approved
inventory changes require coordinated manifest and discovery updates and new
verification. No SQL installation, application edit or deployment was performed
by this reconciliation; keep issuance and collection disabled.

## September 7 hosted catalog follow-up — stop before installation

The combined candidate is now isolated in `work/landon-integration-20260907`;
exact migrations are canonically 040–057 and locally tested. Read-only original
staging observation `2026-09-08T05:48:46.107016Z` found no prospective exact
relation/function/trigger/type/legacy collisions and all required legacy RPCs.

However, this staging target is still before review prerequisite 024 (no post_id,
old creator-level uniqueness), and clients have broad effective privileges on
purchases/reviews and EXECUTE on both legacy rating RPCs. These objects were
outside the previous 15/15 private financial ACL check. Do not reapply that old
repair, infer production state, or try 026 against this unmet preflight.

Preserve existing rows and the completed recovery evidence. Inspect the narrow
remaining metadata/function definitions; prepare and test explicit prerequisite
changes, then obtain separate exact-target approval before any hosted execution.
The full findings and boundaries are in the parent workspace's
`outputs/creatornet-staging-integration-preflight-20260907.md` and condensed JSON.
No schema, permissions, collection gate, payment or production deployment changed
during this read-only inspection.

## September 7 targeted prerequisites prepared — still await hosted approval

The narrow catalog follow-up has now been completed read-only, and the isolated
candidate contains purchase/rating ACL prerequisites plus a separately prepared
atomic 024→026 review package. Final seven-suite prerequisite/API regression run
passed 115/115 cases; nonincremental TypeScript and targeted lint passed. No
application source or exact-payment bundle changed in this step.

See `staging-review-installation-approval.md` for exact target, file hashes,
transaction boundaries and required explicit approval. Rating ACL installation
intentionally retires direct client use of the legacy rating RPC; older NULL-post
reviews remain readable/deletable but are not automatically converted. Do not
describe all three artifacts as one atomic migration or claim this audits all
legacy profile_reviews access. No hosted prerequisite or exact schema is installed
yet. Keep issuance/collection disabled and production untouched.
