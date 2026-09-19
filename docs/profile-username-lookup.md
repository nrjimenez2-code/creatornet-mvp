# Exact profile username lookup

DB MIGRATION REQUIRED: `supabase/migrations/20260916133026_profile_username_lookup.sql`.

Profile routes resolve an exact username after an ID miss. The existing unique index on `lower(username)` preserves case-insensitive uniqueness, but does not serve the route's plain `username = value` predicate. The migration adds a nonunique B-tree on the plain column and leaves the expression index in place.

The transaction has a one-second lock timeout and ten-second statement timeout. Before applying to staging, verify the current column, both index definitions, table size, and absence of the new index. Apply this exact transaction once, then independently verify a valid/ready index and unchanged rows, grants, policies and original unique index. A failed or uncertain application requires inspection before retry. This is not a production rollout procedure; a large or busy production table requires a separately reviewed index build.

The migration was generated earlier in this performance investigation, so its timestamp precedes another already-applied staging migration. Check migration history and apply only this reviewed file; do not use a broad catch-up command that applies unrelated pending migrations.

Five tests execute the actual migration in an isolated PGlite database and verify index shape, matching/null behavior, preserved uniqueness, unchanged rows/security definitions, and role-switched access. The fixture is synthetic rather than a complete copy of deployed policies.

Earlier local growth checks at 10,000 and 100,000 profiles changed the exact lookup from a full sequential scan to an index scan. At 100,000 rows, the present lookup went from 736 buffer hits to four. Those local PostgreSQL 18.3/PGlite checks do not establish staging PostgreSQL 17.6 endpoint latency, index-write overhead, locking under load, or concurrent-user capacity. The staging profile table is currently small and may reasonably retain a sequential scan.
