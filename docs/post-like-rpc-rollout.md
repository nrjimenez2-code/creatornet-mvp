# Batched like mutation

The 50-viewer staging diagnostic on `badee3399c7866ee605d553624e5701c50e6ab87`
measured like p95 3,832.8 ms. Its slowest matched request spent 4,239 ms inside a
warm function. This motivates reducing sequential calls; it does not establish
that SQL execution or connection saturation caused that latency.

With `POST_LIKE_RPC_V1=true`, the route still verifies the session and rate limit.
It then sends the verified actor to a service-role-only, security-invoker RPC.
The flag is absent/off by default. Never set it in production as part of a
staging trial.

| Case | Previous Data API calls | Enabled path |
|---|---:|---:|
| Newly inserted like with recognized interest | 5 | 2 |
| Unlike | 3 | 1 |
| Already-liked PUT | 2 | 1 |

Auth verification is additional in every case. The new-like second call is the
unchanged best-effort interest helper, preserving normalization and +5 only on
insertion. It remains awaited; this change does not alter recommendation timing
by deferring it. Unknown categories are still ignored by that helper.

The likes row and counter change commit together. The installed Discover trigger
still records or invalidates the recommendation event, including its creator
self-like exclusion. A transaction-scoped advisory lock serializes only one
actor/post pair. Counter updates still contend on a popular post's row; this
does not claim that hot-post contention is eliminated. A two-second lock timeout
rolls back the mutation. RPC errors never fall back to replaying legacy writes.

Before staging enablement, verify the current likes unique index, foreign keys,
service-role table grants/RLS bypass and installed Discover trigger against the
retained staging schema. Apply the additive migration to staging, verify its
invoker mode and execute grants, then enable the staging-only flag on a new
deployment. Run correctness smoke checks before another identical 50-viewer
diagnostic. Compare endpoint latency and request counts; local tests are not a
capacity or hosted-latency result.

Rollback: disable the environment-specific flag and redeploy. Leave the additive
function installed until requests to the enabled deployment have drained. No
existing trigger, table, policy, payment path or analytics setting changes.

Validation covers actual PostgreSQL SQL/trigger behavior, unauthorized RPC
roles, duplicate PUTs, toggles, actor isolation, zero-floor counting, rollback,
verified route actor, flag-off compatibility and no replay after RPC errors.
Separate native PostgreSQL 17 checks cover simultaneous PUTs/toggles, eight actors
on one post and a contended lock timing out without partial effects. This is
local correctness evidence, not 1,000- or 10,000-user capacity proof.

Reference: [Supabase database functions](https://supabase.com/docs/guides/database/functions).
