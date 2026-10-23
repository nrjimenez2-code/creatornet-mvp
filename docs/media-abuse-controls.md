# Public media processing admission

New public video upload issuance uses `videos/<creator UUID>/launch_<upload UUID>.<extension>`.
The flat filename preserves the existing owned-folder validation. The media processor
recognizes only that exact namespace for first-content-version admission; timestamp and
other legacy source keys retain their existing per-ETag overwrite behavior.

Before creating a processing job or importing into Stream, the processor conditionally
creates `admissions/source-v1/<SHA256(source key)>.json` in the existing private processing
state bucket. The record binds the source key, first observed current ETag, and immutable
job identity. R2 conditional creation resolves competing versions. A lost write response
is reconciled by reading that same record on retry; a malformed/unavailable record cannot
admit an import. The winning ETag continues through the existing per-job intent and
ambiguous-import reconciliation. Another ETag is acknowledged without another import.
Failed processing does not release the admission. A replacement upload needs a new key.

This bounds new processing admission to one source version per new key. It does not by
itself prevent replayed PUT writes, remove queued events, limit the number of distinct
keys a creator can obtain, or bound all provider reconciliation requests. Conditional
upload headers, application quotas and edge admission are separate controls. Old signed
URLs retain their original expiry and cannot be revoked by changing this Worker.

## Playback freshness and request amplification

The existing completed public metadata caches remain bounded at 1,024 entries per state
binding and 30 seconds with fixed expiry. They never cache a source HEAD. Each later
playback lookup checks the current source ETag; the descriptor also checks the processed
MP4's existence and type. Deletion or overwrite cannot reuse a cached old source version.
Original-file fallback remains available when processing state is absent or obsolete.

No cross-invocation I/O promise cache is added. Cloudflare isolates request contexts and
warns against sharing their I/O objects. The inspected read graph has no duplicate
simultaneous same-key reads within one invocation, so a request-local coalescer would
add no useful reduction. Concurrent external requests can therefore still amplify R2
HEADs and metadata reads. Reducing that requires a separately reviewed immutable-object
freshness policy or a supported coordination service and actual runtime acceptance.
Do not silently weaken deletion checks or increase processing concurrency to mask it.

## Verification and rollout

Run `node --test workers/media-processor/worker.test.mjs` for existing fallback,
deletion/overwrite, output and Stream-identity checks plus first-version admission,
conditional-create conflict, uncertain write, failed processing and legacy overwrite
cases. These synthetic tests do not prove hosted R2 event ordering, signed browser PUT,
Stream billing, or Worker runtime acceptance.

Deploy the reviewed Worker and matching application namespace under an authorized
rollout before admitting new public uploads. Inspect existing Worker bindings and
private state bucket before changing them; no Durable Object, bucket or queue is required
by this change. Preserve admissions and jobs across rollback. Rolling back the guard
removes its protection for later events, so prefer a forward repair while new issuance
stays closed. Never reset admissions or repeat an uncertain Stream import to make a test
pass. Production deployment, provider tests and billing acceptance need exact receipts.

References: [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[Worker request isolation](https://developers.cloudflare.com/workers/observability/errors/).
