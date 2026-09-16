# Bounded Discover page transport

`DISCOVER_COMPACT_PAGE_ENABLED=true` selects compact page RPCs. With `DISCOVER_PAGE_INVENTORY_ENABLED=true`, existing-session reads call `discover_compact_page_v1`; with combined creation enabled, first-page creation calls `discover_create_compact_page_v1`. The default remains disabled. No frontend response or pagination parameter changes.

The full ranked IDs and audience/pilot metadata remain in the session table. The RPC returns only up to the requested 50 IDs, total count, expiry and the existing fresh inventory batch. The application derives the same continuation offset and hasMore, checks compact metadata and preserves moderation filtering, empty-page continuation and viewer-scoped likes/follows. Missing/expired/wrong-owner sessions retain CN001; other failures remain retryable server errors. Failed creation does not fall back to a second insert.

Both new functions use SECURITY INVOKER and a fixed search path. PUBLIC, anon and authenticated cannot execute them; service_role can. Existing RPCs remain available for older deployments and rollback. Apply migration 20260916051608_discover_compact_page.sql before enabling the flag, verify live permissions and parity, then enable only the staging preview branch and redeploy. Disable the flag to restore the previous path.

The preceding staging probe requested 20 posts from a 1,018-ID snapshot: SQL JSON text was 63,296 bytes, including 40,720 bytes for the entire ID list. This motivates bounded output; it is not compressed wire size or proof of a latency gain. Local database tests compare pages from a 10,001-ID snapshot against the legacy function, including final/out-of-range pages, role denial, ownership/expiry, fresh moderation and creation rollback. Repeat the fixed instrumented staging workload and exact cleanup before making performance claims.

This targets the current staging branch. Production rollout and 1,000/10,000-user capacity certification remain separate, unproven work.
