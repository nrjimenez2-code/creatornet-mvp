# Critical request admission

The existing Supabase database owns critical feed/search/upload budgets. The local synchronous limiter remains only a cheap front guard; it is not the durable authority. Webhooks, existing payment/provider recovery, and entitlement delivery do not acquire this new dependency.

`abuse_admit_v1` is a service-only SECURITY INVOKER function with a fixed empty lookup path. Its private RLS tables have no client access. SQL owns the policies, and ordered row locks plus a rollback-on-denial subtransaction make actor/IP/count/byte/time admission atomic. A denied fresh actor leaves no zero-count row. There is no global lock row for all viewers.

Budgets use UTC fixed minute/hour/day windows, not rolling windows. A boundary can admit the last burst of one window and the first burst of the next. Current provisional defaults:

| Action | Per actor | Per IP |
| --- | --- | --- |
| Feed pages | 120/minute | 1,200/minute |
| New feed snapshots | 6/minute, 60/hour | 120/minute, 1,200/hour |
| Search/details | 60/minute | 600/minute |
| Search suggestions | 90/minute | 900/minute |
| Public upload issuance | 30/minute; 200 files, 20 GiB/day | 300/minute |
| Private upload issuance | 20/minute; 20 files, 120 GB, 40 reserved hours/day | 200/minute |

Signed-in viewers use verified server identities. Discover's existing signed anonymous actors remain distinct; anonymous requests without one share the broader IP allowance rather than a lower per-user allowance. Only Vercel's overwritten single-IP header selects production IP identity; generic forwarded headers cannot select a quota key. Local development uses loopback.

Only domain-separated HMACs enter counter keys. No raw IP/email/token is stored. The existing server-only service key derives these hashes, so there is no new secret. Rotating that key changes quota identities and resets their accounting; plan rotations accordingly. Public operation UUIDs still select the same owned object key, and existing private asset rows remain the authoritative provider recovery path across rotations. Bucket cleanup retains at most two days of windows; bounded reservation cleanup retains seven days, beyond the one-hour public PUT and six-hour private upload leases. Cleanup runs opportunistically on successful reads, without a new scheduled job. Idle expired records remain until later activity.

Quota exhaustion returns 429 with Retry-After. Database failure, timeout, missing production IP, malformed admission, or unavailable recovery returns a retryable 503 before new signing/ranking/provider dispatch. No automatic local-only fallback or capacity refund occurs after an uncertain result.

Public uploads require the explicit `create-only-v1` client contract. Cached older composers receive 409 with a refresh instruction. Updated clients retain one operation UUID across retries, reserve one flat `videos/<creator>/launch_<uuid>.ext` key (likewise thumbnails), and PUT with signed Content-Type, Content-Length and If-None-Match `*`. The browser supplies Content-Length from the File. CORS must allow Content-Type and If-None-Match. A 412 is recovered only through the same authenticated reservation and an exact size/MIME HEAD check; it is never blindly accepted and never creates a replacement key. The worker separately binds the first ETag for this namespace to avoid repeated encoding on replay. That worker change is maintained separately.

Private upload recovery checks the existing asset/fingerprint before admission. New generation keys include the most recent terminal asset ID, so an explicit canceled/failed re-upload can reserve a new asset, while concurrent and ambiguous attempts retain the original identity. Provider creation still follows the existing unique asset claim; a lost race does not dispatch. Maximum individual sizes remain 500 MiB public, 10 MiB thumbnail, and private strictly below 30 GB / at most ten hours.

Rollout: apply reviewed additive admission and feed-bridge migrations before deploying the new server/client contract, while the release gate stays private. Do not replay old migrations. Verify service-only ACLs, durable denial and recovery behavior, then complete real browser/provider conditional-PUT acceptance before publishing opens. Synthetic SQL/browser checks do not establish a capacity limit, R2 provider acceptance, or disaster recovery. There is no operator quota override API in this change; changes to these provisional SQL limits require a reviewed policy migration.
