import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

const PAGE_SIZE = 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const metadataKeys = ['profiles', 'primaryProducts', 'legacyProducts', 'offerings'] as const;
type Row = Record<string, any>;
type Inventory = { posts: Row[] } & Record<typeof metadataKeys[number], Row[]>;

// This retains the full initial ranking catalog and the existing shared mapper.
// It changes transport batching, not ranking, entitlements or page validation.
export async function readInitialDiscoverInventory(admin: Pick<SupabaseClient, 'rpc'>): Promise<Inventory> {
  const posts: Row[] = [];
  const metadata = Object.fromEntries(metadataKeys.map(key => [key, new Map<string, Row>()])) as
    Record<typeof metadataKeys[number], Map<string, Row>>;
  let after: string | null = null;
  for (;;) {
    const { data, error }: { data: Inventory | null; error: unknown } =
      await admin.rpc('discover_initial_inventory_page_v1', { p_after: after, p_limit: PAGE_SIZE });
    if (error) throw error;
    if (!data || !Array.isArray(data.posts) || data.posts.length > PAGE_SIZE ||
        metadataKeys.some(key => !Array.isArray(data[key]))) throw new Error('Initial inventory page unavailable');
    let cursor: string | null = after;
    for (const post of data.posts as Row[]) {
      if (!post || typeof post.id !== 'string' || !UUID.test(post.id) ||
          (cursor !== null && post.id <= cursor)) throw new Error('Initial inventory cursor did not advance');
      cursor = post.id;
      posts.push(post);
    }
    for (const key of metadataKeys) for (const row of data[key] as Row[]) {
      if (!row || typeof row.id !== 'string' || !UUID.test(row.id)) throw new Error('Initial inventory metadata unavailable');
      metadata[key].set(row.id, row);
    }
    if (data.posts.length < PAGE_SIZE) break;
    after = cursor;
  }
  return { posts, profiles: [...metadata.profiles.values()], primaryProducts: [...metadata.primaryProducts.values()],
    legacyProducts: [...metadata.legacyProducts.values()], offerings: [...metadata.offerings.values()] };
}
