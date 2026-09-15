# Manual feed capacity comparison

This reuses the bounded production canary from the prelaunch investigation on a GitHub-hosted runner. It distinguishes local-connection effects from application service time. It is not the 1,000-user acceptance test.

The workflow runs offline safeguards on relevant pull requests. Live traffic requires a manual dispatch on this repository's main branch. It needs no Supabase, provider, Vercel, account or payment credentials. There is no scheduled traffic. The target is fixed to https://www.creatornet.net and only the public feed GET and exposure/watch POST endpoints are allowed. It creates anonymous test sessions and viewing receipts; it never creates posts, accounts, bookings or purchases.

Before dispatch, independently verify the actual production app SHA, feature settings and four-post catalog. Confirm no other load run or fixture cleanup is active. Supply that SHA and select one stage (5 first, then 25 or 50 only when results justify it). Arrivals span at most five seconds, each journey observes three posts with real 5.1-second waits and a repeated watch claim. Startup requests remain measured; no priming is used. The existing feed p95 <=1,500ms, telemetry p95 <=500ms and errors <1% gates are unchanged. No test contacts production on pull requests.

Each run retains an append-only intent journal, exact synthetic actor/session/post scope, aggregate samples and request correlations as a seven-day GitHub Actions artifact. Signed actor tokens stay only in process memory. Artifacts contain no login credentials, cookies, user emails or response bodies. Download the artifacts promptly; a successful workload does not clean up records automatically.

After the run settles, inspect errors and unresolved first-page intents. Any cancellation, timeout or unknown first-page outcome requires authoritative reconciliation before cleanup. Download the exact artifacts into the controlled local outputs folder and use the existing reviewed production fixture SQL generator and database tool. Verify receipts and guards, execute its exact cleanup, then run the independent zero-scope postcheck. Do not dispatch another stage until cleanup is complete. Never broaden deletion to a time window or modify unrelated production activity.

Limits: at most 50 anonymous journeys in this workflow; one three-post stage; fixed request ceilings; no live browser/video transport, signed-in identity load, sustained 1,000-user plateau or normal concurrent 20-item pagination. Compare its geographic/network context with actual browser observations. Passing this small cloud check alone cannot close original items 19/21.

GitHub manual workflow reference: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
