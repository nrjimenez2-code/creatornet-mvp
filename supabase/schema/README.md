# Schema snapshot

## Why this exists

Before this file, **the CreatorNet database schema existed in exactly one place: the live
database.** `supabase/` was git-ignored, the repo contained no `.sql` files at all, and
`supabase_migrations` is empty. There was no versioned record of the schema, which means
there was nothing to diff a proposed change against and nothing to restore to if a change
went wrong.

This directory is that record. It was reconstructed by reading the live database's own
catalog on **2026-08-12**, read-only. Nothing was changed to produce it.

## Files

| File | Contents |
|---|---|
| `snapshot-2026-08-12.sql` | All 27 public tables: columns, constraints, indexes, and the row-level-security on/off state of each. |

The 110 row-level-security policies are **not** duplicated here. The ones being changed
have their exact current definitions in the paired rollback script that ships with each
proposed change, and the full set regenerates from a single read-only query (below).

## What this is NOT

This is a catalog-derived snapshot, not `pg_dump` output. Being honest about the gap
matters, because "roll back to the snapshot" is only as good as the snapshot.

**Not captured here:**
- Table data. This is structure only.
- Function and trigger bodies (they live in the live DB; dump them with
  `pg_get_functiondef` when needed).
- Custom types and enums. Several columns reference them, for example
  `booking_payments.plan_type` uses `booking_payment_plan` and `products.fulfillment`
  uses `fulfillment_type`. **Restoring from this file into an empty database would fail
  until those types are created first.**
- Sequence current values, grants and role memberships, storage buckets, auth schema
  configuration, extensions, and cron jobs.

So: this is a reliable reference for *what the schema is today* and a reliable diff base
for reviewing a proposed change. It is **not** a disaster-recovery backup. For that,
confirm whether the Supabase project is on a paid plan, which is what enables
point-in-time recovery.

## Regenerating it

Both files come from read-only catalog queries. The exact SQL is in
`~/projects/creatornet-clone/docs/plan/sql/README.md`. Re-run and diff against these
files to see what has drifted.

## Things worth noticing in the current schema

- **`purchases` carries roughly two dozen indexes on 60 rows**, including five separate
  indexes on `payment_intent_id` alone (`purchases_payment_intent_id_idx`,
  `purchases_payment_intent_idx`, `purchases_payment_intent_uidx`,
  `purchases_payment_intent_unique`, `purchases_payment_intent_id_key`) and three on
  `session_id`. That is what unversioned, repeatedly-patched schema looks like. Cleaning
  it up is safe and cheap, but it is cosmetic next to the security items and should wait.
- **Five tables have row-level security switched off**: `booking_payments`,
  `profile_reviews`, `post_engagements`, `stripe_events`, `_patch_export`. See
  `~/projects/creatornet-clone/docs/plan/sql/` for the remediation and its rollback.
- **`stripe_events` exists and is empty**, and no code references it. The webhook
  idempotency table was created and never wired up.
- **`_patch_export`** holds columns `rn`, `ord`, `ddl`. It looks like the output table of
  a one-off schema-export script, left behind. Worth confirming and dropping.
- `posts` has both a `likes` integer and a `likes_count` integer, plus a separate `likes`
  table and a separate `post_likes` table. Two generations of the same feature coexist.
- `profile_reviews` and `reviews` are two different review systems, both live.
