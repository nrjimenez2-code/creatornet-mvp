# Creator profile read flow

The signed-in staging smoke on source `da17b5e` measured two profile responses at
2,426.5 ms and 906.7 ms. Exact provider traces showed a cold first function
(1,851 ms, reported cold-start 327 ms) and a hot second function (668 ms).
These two observations locate a remaining latency problem; they do not establish
endpoint percentiles or a concurrent-user capacity limit.

The profile previously awaited viewer verification, then public profile resolution,
then a second creator-interest lookup before starting its parallel content reads.
Metadata performed another profile lookup with a different projection.

The page now starts verified viewer lookup and public creator resolution together.
The creator projection includes the primary-interest source, so the same resolved
row supplies the existing four-point interest update. Metadata and the page share
`readCreatorPublicProfile` through React `cache`, which is scoped to one server
render. No viewer identity, follow state, likes or response is stored in a shared
or persistent cache. ID-first lookup, exact username fallback, seller validation,
moderation filters, error states and the existing score-update function are retained.

For a successful ID route with signed-in viewer and visible posts, this removes
one explicit interest round trip and the separate metadata profile query when the
framework shares the render cache. It also overlaps the previously serial auth
and profile reads. It does not remove verified authentication or parallelize
personalized reads before that verification has completed.

The existing reviewed offer mapping change is included: canonical IDs and legacy
aliases use first-write-wins maps, while retaining canonical precedence, active
filter differences, ownership checks, term validation, deduplication and output
order. Output arrays are appended instead of repeatedly copied. The separate
local benchmark verified exact output parity with large synthetic catalogs;
that is CPU evidence, not page-latency or live-capacity evidence.

The page still loads its returned creator catalog before likes and serialization.
Correct cursor pagination, independently reachable older offers and an honest
total count remain separate required work. This change does not silently cap the
gallery or introduce cross-request caching. The prepared username index migration
is separate and is not included here.

Validation covers actual page execution with delayed auth, creator resolution,
metadata, primary-interest selection, anonymous reads, distinct verified viewers,
failed resolution, moderation, offer mappings and schema readiness. Hosted CI and
a same-deployment comparison remain necessary before claiming a latency improvement.

Framework references: [Next.js metadata memoization](https://nextjs.org/docs/app/api-reference/functions/generate-metadata)
and [React request-scoped cache](https://react.dev/reference/react/cache).
