# Staging database locality comparison

The observed staging deployment runs in Vercel iad1 (AWS us-east-1), while the staging Supabase project nwqfofezfzljhxolkycz runs in us-east-2. This staging-only configuration places functions in cle1, matching the database region. Vercel documents this mapping and recommends placing compute near its database: https://vercel.com/docs/regions.

This branch targets feat/discover-conversion-ranking only. Do not merge this experiment into production without checking the production database region and separately validating its impact. No database, authentication, payment, ranking or cache behavior changes here. The existing staging-only combined first-page flag remains unchanged.

After hosted checks, deploy to the staging branch and verify the actual deployment region and source commit. Repeat the fixed one-reader journaled workload with the same catalog shape and transport observer. Compare client and route latency, database wall time, cold/repeat requests and errors; do not attribute all differences to geography from sequential small runs. Clean the exact session and catalog fixtures. Reverting the regions entry restores the project default for subsequent deployments.

This comparison does not certify 1,000 or 10,000-user capacity. Sustained mixed-user tests, resource utilization, media playback and capacity headroom remain required.
