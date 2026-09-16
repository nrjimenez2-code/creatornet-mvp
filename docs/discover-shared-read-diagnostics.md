# Initial feed shared-read diagnostics

These request-local measurements explain observable waits inside existing initial
session preparation. They do not change cache keys, the cache callback body,
the 30-second revalidation setting, the 60-second acceptance bound, overlapping
read sharing, ranking, identity checks, moderation, or session writes.

The existing diagnostic gate applies: numeric `Server-Timing` fields in preview;
in production, numeric logs only during the existing explicitly bounded timing
window, with the existing limit of 64 logs per route module. There are at most
44 new numeric fields, using three fixed buckets; the logger accepts at most 96
input measurements per entry. No identities, cache keys, post IDs, query inputs,
results, URLs, exception messages, or per-read lists enter the diagnostic store.

| Prefix | Work covered |
| --- | --- |
| `inv` | Shared initial inventory read, including its caller's in-flight wait |
| `evi` | Sum across this request's evidence batches, including in-flight waits |
| `sessionstore` | Session insert or combined session/first-page RPC, including existing result validation |

The `inv` bucket does **not** cover the personal history, profile, follow, or
legacy-interest reads that run alongside inventory in `sessioninput`. Existing
phase and direct database timings remain necessary for those operations.

For `inv` and `evi`, the fixed suffixes are:

| Suffix | Meaning |
| --- | --- |
| `calls`, `errors` | Caller operations started; caller operations observed rejecting |
| `joins` | Caller reused an already pending read in this process; it did not own that loader |
| `bypass` | Existing non-Vercel cache bypass used |
| `fresh` | Returned cache envelope age was at most 30 seconds |
| `stale` | Envelope age exceeded 30 but was at most 60 seconds; value remained eligible to return immediately |
| `expired`, `invalid` | Envelope exceeded the acceptance bound or had unusable metadata; existing fallback applied |
| `cacheerror` | Cache invocation failed without a propagated loader failure |
| `fallback` | Existing direct read-once fallback was selected |
| `reuse` | This shared-read invocation reused its pending/completed loader promise, such as expired fallback joining background refresh |
| `completed` | Cache failure preserved an already completed successful read; no second read was issued |
| `loads`, `loaderrors` | Physical loader executions started here; observed loader rejections |
| `wait`, `waitcount` | Sum of this caller's operation wait in milliseconds; valid completed duration samples |
| `cachewait`, `cachewaitcount` | Sum of awaited cache invocation duration; valid completed duration samples |
| `readwait`, `readwaitcount` | Sum of physical loader duration; valid completed duration samples |

`sessionstore` has only `calls`, `errors`, `waitcount`, and `wait`. It does not
cache or share writes. Count fields use the existing numeric `;dur=` encoding
but represent counts, not milliseconds.

Next's cache API exposes an envelope and loader callback, not an authoritative
hit/miss flag. `fresh=1, loads=0` means an accepted recent envelope with no local
loader execution observed; `loads=1` means a local loader ran. Background
revalidation, cache availability and cache-write failure can also run loaders.
Do not label these observations an exact provider cache-hit ratio.

Each joining request owns its `wait` and `errors`; only the owner reports its
cache/loader observations. Evidence duration sums may overlap when batches run
concurrently, and cache duration can include loader duration. Do not add these
sums to each other or treat them as non-overlapping phase breakdowns, SQL time,
percentiles, or connection-pool utilization. A duration of zero with sample
count zero means no valid completed observation, not measured zero latency.

The response snapshot closes its request-local bucket. Background refresh may
continue normally afterward: a loader start can be observed with no completed
read duration or error yet. Late work cannot change the completed snapshot or
another request's observations. No per-request store is retained in a global
map; the existing shared read promises and cache lifecycle are unchanged.

## Capture boundary

The completed comparison used the frozen workspace harness files
`work/staging-sustained-feed.cjs` and `work/staging-page-only.cjs`. Their collection
and recovery allowlists do **not** include these fields. Those frozen drivers
and their completed-run hashes must remain unchanged. A separately versioned
capture/recovery update and offline tests are required before a new live run
can preserve this diagnostic evidence in its journals. Response headers alone
do not establish that the workload artifacts captured the measurements.

These are local application diagnostics, with no deployment, live measurement,
capacity proof, or inferred network/cold-start/pool bottleneck from this change.
