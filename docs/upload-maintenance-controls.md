# Upload admission and maintenance controls — local installation review

Prepared November 4, 2026. Repository `nrjimenez2-code/creatornet-mvp`, detached local worktree at `9abccd86dc16611bb0046cef439d09f3a5e85329` plus the separately recorded upload patch. This document describes local implementation and conditional future operations. Hosted installation, deployment, provider changes, restore and LIVE activation require their own exact approved scope. No command in this document has been run against a hosted project.

## Current evidence and execution stop

The versioned SQL unit is `supabase/upload_tracking_v1.sql`, outside CLI migrations. It is an installation draft exercised in disposable PostgreSQL with `test-support/upload-tracking-storage.sql`. That fixture simulates Storage operation context; it is not the Supabase Storage service. Applying the SQL creates restrictive policies immediately. The file is deliberately not an idempotent upgrade script: a second application fails, and its transaction must roll back. Never reapply it to repair an unknown partial state.

The operator packet is not execution-ready until every preflight item below has its own receipt and unresolved provider-specific steps have been written and reviewed. In particular, this implementation does not supply a proved pre-cutover freeze for every legacy direct-upload capability, or prove that all old capabilities finished. There is no authorized hosted connection or generic restore-ready command here.

## Scope and data retained

Public video and generated thumbnails use the existing R2 signer. Private premium files and avatars use actor-authenticated Supabase signed uploads; the inspector uses the service client only for exact-object metadata. The service client must never replace actor signing. Existing permissive Storage entitlements remain necessary.

`POST /api/upload/admit` and the legacy `POST /api/upload/presign` reserve a unique attempt before signing, then publish its authorization decision before returning a capability. Gate closure, reservation and publication serialize on the singleton control row. Publication requires the reservation generation to remain current. Signing itself holds no database lock; ambiguous or failed signing/publication leaves an unresolved attempt and withholds the capability from the handler. A repeated attempt ID does not sign again. A fresh upload retry uses a new attempt/key within that upload operation.

`POST /api/upload/[attemptId]/complete` accepts only a client outcome. The authenticated server obtains metadata for the exact owned object; it rejects browser-supplied identity, key, bucket, size or provider metadata. `GET` returns owner-scoped status. Both are no-store, authenticated, rate-limited continuations and remain available while admission is closed.

The journal records attempt/operation/owner IDs, provider/bucket/key, expected type/size, admission generation, state, timestamps, nominal expiry, client outcome and conservative observations. Signed URLs/tokens stay in memory and the HTTP response. Never add them to journal rows, logs, traces, exports, browser persistence or the retry cache. Exported attempt data is private operational data and requires controlled handling.

The browser retains only non-secret reconciliation metadata keyed by Blob and owner/purpose. A successful PUT followed by failed verification retries verification of that same attempt. Composer retains its generated thumbnail for the same source video; the crop dialog retains its prepared PNG for unchanged crop identity. Changing video/crop creates new work subject to admission. Reloading or closing the page loses this transient retry association; the durable attempt remains unresolved for operator reconciliation. There is no claim of cross-reload retry recovery.

## Required preflight before any hosted installation

1. Establish actual client, server, media and project bindings from precise authorized evidence. The intended rehearsal target remains the existing same project `hmtbtzxpkaxmwqkuhlrd`; local source and Preview metadata do not prove runtime bindings. Match the exact reviewed source/SQL/config hashes, deployed revision and target before proceeding. Preserve original financial/provider identities.
2. Obtain the supported provider answer for startup inhibition or non-executing inspection and finish the separately approved recovery plan. The approved design allows temporary Auth/internal-service interruption after admitted protected work positively finishes. Selected point, preservation/custom-role recovery, data-loss bounds, numeric full-service RTO, failed-restore/reopening rules and measured recovery still need concrete evidence and approval.
3. Inventory existing policies, custom/inherited roles, bucket settings/limits, helper availability, exact Storage request operation names and actual signed-upload roles through an approved read-only preflight. Verify `storage.allow_only_operation`, `auth.uid()` behavior and the existing owner predicates. Custom or provider roles outside `anon`/`authenticated` require explicit analysis; do not assume this policy covers them.
4. Prove real-service actor signing and exact signed-upload continuation on both `premium` and `avatars`, including pause and pause/reopen. Check new object and attempted overwrite behavior, RLS `USING` and `WITH CHECK`, exact bucket/key/owner, rejected ordinary/unknown operations, and unchanged other-bucket entitlement. A local fixture cannot establish this. A signed route with missing actor identity must fail closed rather than trigger an admin-signing workaround.
5. Define and obtain approval for the exact legacy-admission freeze and cutover sequence. It must prevent fresh legacy signing/admission while the original legacy cohort positively finishes. Include old R2 presigns, direct Supabase uploads/signers, retained browser clients, in-flight provider writes and relevant background/media writers. A holding page, process flag or this new journal alone cannot prove that freeze. The supported provider mechanism and its confirmation receipt remain unresolved; do not invent a switch or strand legacy direct uploads with early restrictive-policy cutover.
6. Positively finish the known legacy/protected cohort, including required object ownership/metadata, post/profile/other downstream publication and original-provider reconciliation. Preserve failures/ambiguities for explicit recovery. No empty new journal, timeout, browser abort/success, URL age/expiry or HEAD observation proves old-work completion or provider-write quiescence.
7. Complete required full CI/build and final review on the exact release source. Maintain `scripts/ci-tests.cjs` full-suite fallback for backend/behavior/unknown changes. Local checks do not replace hosted, device or Production acceptance. Do not push or create a PR merely to trigger CI while the no-deploy instruction applies.
8. Present the matched installation plan, maintenance impact, legacy completion receipts, preserved-data/recovery plan, concrete failure actions and remaining loss/RTO risks for owner approval. Authorization for local tests or a support answer is insufficient.

## Conditional installation sequence after those gates and exact approval

1. Confirm target identity and hashes again within approved bounds. Keep legacy admission frozen using the separately proven method; keep already admitted completion and downstream publication available. Do not alter unrelated app gates or cancel financial obligations.
2. Verify old upload work positively finished before applying the restrictive policy unit. If a legacy attempt or writer is uncertain, stop before installation and continue permitted completion/reconciliation.
3. Apply the reviewed installation unit once in the approved target/transaction with its default `paused=true`. Record the transaction outcome, source hash and default generation. Do not run CLI migration generation or upgrade the CLI implicitly; the installation draft is not a generated migration.
4. Verify the single control row, service-only journal/RPC privileges, restrictive INSERT and UPDATE policies alongside unchanged permissive policies, and the helper's private schema, empty search path and minimal execution grant. Confirm UPDATE has both `USING` and `WITH CHECK`. On an installation error, confirm transaction rollback; do not guess at cleanup or drop policies/tables.
5. Install the matched reviewed application under the separately approved release procedure. Admission remains closed until actual application/provider rejection and continuation tests pass. Old direct-upload clients may now receive a maintenance/error response; communicate the cutover and refresh requirement within approved scope.
6. Execute the approved hosted acceptance cases for both Supabase buckets and R2. Reconcile every test attempt to the correct original evidence. Record actual responses without tokens, authorization headers, cookies or signing secrets. Keep incomplete work unresolved.
7. Open admission only after a separate affirmative decision and a current-generation compare-and-set. Finish any required original mentorship/recovery/financial gates before separately authorized Production/LIVE activation. Opening upload admission is not launch acceptance.

## Operator interface after an approved installation

There is no public operator endpoint or browser operator UI. Use an already approved server-side service context with `SupabaseUploadTrackingStore`, or the equivalent approved SQL session below. Do not obtain credentials from `.env`, credential stores, cookies or support instructions. The snippets are templates for a future authorized session; `:expected_generation` must be deliberately bound to the generation in a reviewed current snapshot.

Read the snapshot:

```sql
select public.upload_maintenance_snapshot_v1();
```

Close admission using compare-and-set:

```sql
select public.set_upload_admission_v1(
  true, :expected_generation, 'approved_maintenance'
);
```

Record the returned `paused`, `generation`, `reason`, `updated_at` and subsequent snapshot. On `upload_control_conflict`, stop and reconcile the other operator's change; never automatically retry with a fresh generation. A successful transition increments generation. Repeating an already-current state does not increment it or rewrite its reason. Failure of the RPC/readback is an unknown control outcome, not proof that admission closed; keep the uncertainty explicit and use only approved containment/recovery actions.

The optional server process flag `UPLOAD_ADMISSION_PAUSED=1` adds an admission denial. The durable database gate remains primary, and the flag neither controls independent Storage signing nor proves a provider freeze. Changing it is a separately scoped environment action.

Enumerate all retained attempts, including beyond the first 100 shown in the snapshot:

```sql
select public.list_upload_attempts_v1(null, null, 100);
-- For each non-null nextCursor, pass BOTH exact returned values:
select public.list_upload_attempts_v1(
  :after_admitted_at, :after_id, 100
);
```

The response has `attempts` and `nextCursor` (`admittedAt`, `id`), or null when complete. Page size is 1–100. Preserve the timestamp string's timezone and microseconds; do not round-trip through JavaScript `Date`. Never advance by a timestamp alone. The `(admitted_at,id)` index supports deterministic keyset traversal across tied timestamps. Record every attempt ID once and reconcile the complete set with the snapshot/cohort. Close admission first and wait for its successful transaction; reservation locking serializes earlier admissions with that closure. Do not mutate journal order keys. Pagination is not a transaction-wide snapshot: observations can change between pages, and privileged writers require separate coordination. New rows admitted after reopening require a new enumeration.

In server code the corresponding class methods are `maintenanceSnapshot()`, `setAdmission(paused, expectedGeneration, reason)` and `listAttempts(cursor, limit)`. Instantiate only within the existing approved server-side service boundary. There is no client mutation fallback.

For a known owned attempt, use the authenticated completion/status route or the existing runtime reconciliation path with the original owner. Never substitute a browser-supplied key or identity. Preserve first observation and sticky object mismatch; a later matching HEAD does not erase an earlier mismatch. An aborted/failed client report preserves uncertainty. Provider metadata errors, missing/zero/invalid metadata and unavailable inspection must remain unresolved. Reconcile downstream post/profile completion separately; this journal does not record a finished business cohort.

Reopening uses a new explicit compare-and-set after its review:

```sql
select public.set_upload_admission_v1(
  false, :expected_generation, 'approved_reopen'
);
```

Closing/reopening invalidates old signing publication generations. Previously admitted signed continuations remain eligible for the exact key while paused, subject to the existing provider entitlement and actual signed-route behavior. An authorization publication committed before closure may reach a browser afterward. Do not promise immediate network response suppression or revocation of existing R2/Supabase capabilities. Supabase owners can sign a capability family for an admitted key while the signing gate is open; nominal expiry is not a complete token inventory or a reliable last-write deadline.

## Conservative restore and failure rules

The snapshot intentionally reports `safeToRestore=false`, `providerQuiescenceProven=false`, `legacyUploadCoverage='unknown'`, and counts every attempt as unresolved for provider quiescence, including `object_observed`. These are evidence limits. Do not change them to obtain a green maintenance status.

Gate closure does not stop writes already admitted at a provider. Signed-capability expiry, a quiet interval, an empty journal, observed metadata, successful UI, abort, retry exhaustion or a temporarily unreachable object does not establish a safe restore point. The module provides no deletion/cleanup/TTL and no all-writer drain certificate.

On an application/provider/journal mismatch, keep new admission closed through the approved mechanism, preserve the original objects and all unresolved records, and keep permitted completion/reconciliation available where possible. Do not delete objects, reset rows, swap signing identities, relax policies, replay original financial operations or run automatic rollback that reopens legacy admission. A code rollback with restrictive policies still installed can strand old direct clients; a policy rollback can allow untracked writes. Either needs a matched separately approved recovery procedure.

No restore may start until the concrete selected-point/preservation/custom-role/loss/RTO/failure-reopening procedure and its execution risks have been approved. Continue from the approved revised recovery design in the inherited handoff; do not reintroduce its superseded universal all-writer frozen-baseline claim. None of this accepts the six original hosted mentorship groups or resolves ADOR/Glendale licensing.

## Local evidence map

The continuation checkpoint records exact hashes and commands. New component tests exercise real Composer and crop/profile wiring with mocked HTTP/Storage, including successful PUT followed by verification failure or downstream write failure and then admission pause. Direct adapter tests verify actor-versus-inspector separation, exact object requests, absence-versus-provider-error handling and unchanged microsecond cursor forwarding. The native runner exercises the installation SQL unchanged with real PostgreSQL roles and observed row-lock races, plus bounded pagination across more than 100 attempts. None of these tests invokes a hosted provider.

Official references checked November 4, 2026: [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Storage helper functions](https://supabase.com/docs/guides/storage/schema/helper-functions), and [Supabase changelog](https://supabase.com/changelog). Documentation is not proof that the intended hosted target has the same helper version, role/operation context or policy behavior. No CLI upgrade or hosted command follows from the changelog.


## November 5 current-main integration candidate

The owner chose to retire fresh legacy public signing: cached clients must refresh
onto tracked admission. The legacy endpoint can only verify an exact retained
original reservation and object. Its new service-only lookup is a pure read;
it never calls abuse admission, creates a historical tracking admission, signs,
or treats HEAD as drain evidence. Missing retained evidence fails closed.
The apply-once draft now depends on current main's durable abuse-admission schema.
It is still outside CLI migrations and is not installed in any hosted database.

Tracked public video/thumbnail keys retain the worker's launch_<attempt UUID>
namespace. Private premium/avatar names retain their previous format. Each public
attempt has a positive signed byte size, explicit create-only contract, verified
account/profile/ban checks and its own abuse reservation before durable admission.
The browser sends If-None-Match:* and supplies Content-Length itself. HTTP 412
reconciles the same attempt; verification outages retain only nonsecret metadata
and never create a replacement admission, PUT or capability for that conflict.
These local changes do not prove legacy completion, provider quiescence or restore
safety. legacyUploadCoverage remains unknown and safeToRestore remains false.
