# Feed offer requests and detached video cleanup

Repeated post updates previously started an offer request for each update. FeedList now owns a queue that coalesces updates for 25 ms, deduplicates pending post IDs, permits one active read, and sends at most 100 posts per batch. The pending queue holds at most 200 distinct IDs. Initial desktop enrichment remains immediate; mobile enrichment retains its existing background scheduling.

Only capacity refusals are deferred and retried near the active post (two posts on either side). Failed reads do not automatically retry. A visible refresh control lets the viewer recover delayed purchase options. Unverified purchase options remain disabled.

Generation, version, creator, and product checks reject stale work before dispatch and application. Removing or moderating a post removes queued work immediately. Changing feeds or leaving aborts the current read and clears pending work; an ignored abort does not release the active request slot before its promise settles. The request retains its 10-second deadline through response-body consumption or cancellation.

VideoCard captures the media node and releases its source only after that node is detached. Watch events and playback listeners settle first. Connected nodes keep their resource during source changes, activation changes, and Strict Mode effect replay. A keyed retry releases the old node rather than its replacement.

## Validation and limits

The combined changes on the current staging base passed 139 tests in 13 focused suites, including offer queue/integration, realtime updates, purchase controls, stale requests, handoff, detached media, audio preference, and public CDN media paths. The implementations match the previously reviewed patches after line-ending normalization.

Earlier controlled browser diagnostics observed 100 post updates reduced from 100 offer reads to one, and detached video downloads being cancelled. Those checks used synthetic fixtures and are not production-capacity evidence. Staging latency, realistic long scrolling, and mixed load must still be measured after deployment.

This bounds offer transport concurrency and queued snapshots, not all frontend memory. Retained feed rows, version/deferred metadata, and row searches still grow with feed length. The broad realtime subscription is unchanged. This change does not establish 1,000- or 10,000-user capacity, change ranking, or alter payment verification and media access authorization.
