# Combined Discover session creation and first page

`DISCOVER_CREATE_PAGE_ENABLED=true` enables one service-role RPC for saving the ranked session and loading fresh first-page inventory. The default remains disabled. Requests containing a session parameter continue through the existing owned-page read. No frontend contract or pagination cursor changes.

Apply `20260916040322_discover_create_page.sql` before enabling the flag. The function is SECURITY INVOKER with execution revoked from PUBLIC, anon and authenticated and granted only to service_role. Identity resolution remains before session creation. The function validates actor/user consistency and pagination bounds, then inserts and invokes the existing owned/expiring page function. Inventory includes current moderation fields, which the shared application mapper filters as before. Personalized likes/follows remain separate viewer-scoped reads. No personalized response caching is introduced.

A page-function error rolls back the insertion. The application does not retry with a legacy insert after an error because a lost response could otherwise create duplicate sessions. Existing expiry cleanup remains unchanged. The function preserves all pilot metadata and full ranked post/audience snapshots.

Rollout: pass hosted CI; apply/verify the migration on staging; deploy with the flag disabled; enable only for the staging branch; repeat the same bounded, journaled one-reader workload; reconcile and clean exact fixture IDs. Do not raise concurrency unless the latency gate passes. Production enablement and capacity claims require separate evidence. Disable the flag to return new sessions to the previous path; already-created sessions remain compatible.

Timing: the combined call reports `sessionwritepage`, not `sessionwrite`. The outer `session` metric now includes initial-page mapping (and viewer likes/follows where applicable); there is no separate initial `page` metric. Compare end-to-end latency and like-for-like phase boundaries. Extend the load runner's numeric allowlist before measurement. Later-page metrics are unchanged.

The observed staging INSERT statement averaged 1.859 ms of database execution across 1,762 historical calls. That aggregate is not the same sample as the 181.6 ms application-side median save phase and excludes transport. It supports investigating round trips; it does not prove a specific latency reduction.
