// lib/visiblePosts.ts
//
// Moderation filter for consumer-facing reads of `posts`.
//
// The admin board sets `posts.hidden_at` (hide) and `posts.removed_at`
// (remove). The feed RPCs (get_feed_v2/get_feed_v3) and the sitemap already
// exclude both, but "hide" is only a real control if every other discovery
// surface — search, tag pages, public creator profiles, direct /watch links,
// continue-watching — excludes them too. Apply this to each of those reads.
//
// Do NOT apply it to the creator's own profile (they should still see their
// own hidden posts), to buy-time product resolution, or to entitlement checks
// on the money path.

type NullFilterable<T> = {
  is(column: string, value: null): T;
};

/** Narrows a `posts` query to rows that are neither hidden nor removed. */
export function onlyVisiblePosts<T extends NullFilterable<T>>(query: T): T {
  return query.is("hidden_at", null).is("removed_at", null);
}
