# Bounded evidence reads for first-feed preparation

New ranked sessions read evidence for the full eligible catalog in batches of at most 200 post IDs. Previously every evidence read waited for the previous one, including its shared cache lookup. The batches have independent inputs; ranking waits for all of them.

`DISCOVER_EVIDENCE_BOUNDED_READS_ENABLED=true` enables windows of two evidence reads per session. Only the exact string `true` enables this path; an absent flag, `false` or `1` retains serial reads. The last window may contain one read. No deployment flag is changed by this patch.

Every window settles before another starts. Results are concatenated in original batch order even if responses finish out of order. Any rejection fails session preparation, after settling its already-started peer; no later window or session write starts. If both reads fail, the earlier batch's failure is returned. These reads are not forcibly cancelled: one may be shared with another session. There is no new timeout or retry policy; an unresolved peer can still delay settlement under the existing request/platform limits.

The existing 200-ID limit, in-flight sharing, cache keys, 30-second revalidation and 60-second maximum accepted input age remain unchanged. Evidence SQL, full ranking, viewer history, authentication, claim checks, moderation, payment/access checks and private response caching remain unchanged. Following sessions do not read evidence.

This is a per-session foreground concurrency bound, **not a global connection-pool limit**. Separate requests, module instances and cache background refreshes can overlap. A new commit also changes the existing cache namespace. A 200-post evidence response can include many audience summaries; the database regression fixture returns 1,800 summaries for 200 posts. Total retained inventory/evidence still grows with the catalog. Do not describe this change as bounding total session memory or proving database headroom.

## Evidence and evaluation

The completed staging comparison C on base `19bed23abce8d9695f3397c0bcd3afd6cb7a29b0` used 25 anonymous first sessions followed by 650 later pages. Its first-feed p95 was approximately 4.62 seconds. First-session phase p50/p95 values were: evidence 852/1503 ms, inventory/viewer inputs 465/1380 ms, ranking 59/86 ms, and save plus first page 296/591 ms. These wall-time phases motivated this narrow experiment; their percentiles are not additive. Sampled database observations showed no saturation, which does not prove peak headroom.

Earlier first-session samples had long evidence waits despite only one request-local database fetch. Shared in-flight work can be attributed to another invocation, and cache access itself takes time. The evidence phase must not be labelled SQL execution time or all cache hits merely from those counters.

After local/hosted checks and review, compare the flag disabled and enabled on staging with the same bounded workload and source, preserving errors, missed starts, first-page/later-page denominators and exact cleanup. Examine p50/p95/p99 for first-feed and evidence phases, actual underlying read concurrency/counts, cache-wrapper waits versus underlying read waits, response rows/bytes, process memory and database utilization. Include cold-cache/refresh and reused-cache conditions; do not attribute deployment startup variation to this flag. Require unchanged ranking snapshots and fresh moderation behavior.

Local tests verify ordering, parity with serial ranking and placements, a maximum of two pending foreground reads, literal flag gating, default serial behavior, failure/drain behavior and refusal to save partial sessions. They do not establish a live latency benefit, mixed-user capacity, CDN/video performance, or 1,000/10,000-session headroom. No new infrastructure, dependency or database migration is required.
