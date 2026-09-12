import 'server-only';
import { createServerClient } from '@/lib/supabaseServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { dailySeries, sectionLabels, type AnalyticsDetail, type AnalyticsSection, type AnalyticsWindow } from './analytics-dashboard';

// Only fixed query specifications. Identity comes from auth.getUser, never a
// URL or client prop. Raw records never cross the server/client boundary.
const specs = {
  engagement: { table: 'likes', columns: 'id,created_at,posts!inner(creator_id)', owner: 'posts.creator_id', time: 'created_at' },
  clicks: { table: 'post_events', columns: 'id,occurred_at,user_id', owner: 'creator_id', time: 'occurred_at', kind: 'buy_click' },
  checkouts: { table: 'post_events', columns: 'id,occurred_at', owner: 'creator_id', time: 'occurred_at', kind: 'checkout_start' },
  sales: { table: 'orders', columns: 'id,created_at,status,gross_amount,currency', owner: 'creator_id', time: 'created_at' },
  bookings: { table: 'bookings', columns: 'id,created_at,status', owner: 'creator_id', time: 'created_at' },
  refunds: { table: 'orders', columns: 'id,created_at,status,refunded_amount,currency', owner: 'creator_id', time: 'created_at' },
} as const;
const definitions: Record<AnalyticsSection, { metric: string; description: string }> = {
  views: { metric: 'Video views', description: 'Playback starts across your videos. Repeat plays can count; this is not unique reach.' },
  engagement: { metric: 'Likes', description: 'Likes added during this period that are still active. Removed likes are not included.' },
  clicks: { metric: 'Buy clicks', description: 'Clicks on your buy button, including repeat clicks. Unique signed-in clickers are counted separately across the whole period.' },
  checkouts: { metric: 'Checkouts started', description: 'Starts recorded by the product checkout flow. Payment links and other checkout paths are not included.' },
  sales: { metric: 'Paid order sales', description: 'USD value of currently paid orders, grouped by order creation date. Refunded orders are excluded. This is not payout earnings or a payment-date report.' },
  bookings: { metric: 'Bookings created', description: 'Bookings grouped by the date they were created. A completed payment does not confirm that a call took place.' },
  refunds: { metric: 'Refunded orders', description: 'Fully refunded orders, grouped by their original creation date. This is not a report of when refunds happened; partial refunds are not included in this count.' },
};
type Row = Record<string, unknown>;
async function readRows(section: Exclude<AnalyticsSection, 'views'>, owner: string, window: AnalyticsWindow): Promise<Row[]> {
  const spec = specs[section];
  const rows: Row[] = [];
  // Exact count avoids silently reporting partial totals under API row limits.
  for (let offset = 0; offset < 20000; offset += 500) {
    let query = supabaseAdmin.from(spec.table).select(spec.columns, { count: 'exact' })
      .eq(spec.owner, owner).gte(spec.time, `${window.start}T00:00:00Z`).lt(spec.time, window.endExclusive)
      .order(spec.time, { ascending: true }).order('id', { ascending: true });
    if ('kind' in spec) query = query.eq('kind', spec.kind);
    const { data, error, count } = await query.range(offset, offset + 499);
    if (error || data === null || count === null || count > 20000) throw new Error('Analytics query unavailable');
    rows.push(...data as unknown as Row[]);
    if (rows.length >= count) return rows;
    if (data.length < 500) throw new Error('Incomplete analytics response');
  }
  throw new Error('Analytics range too large');
}
export async function loadAnalyticsDetail(section: AnalyticsSection, window: AnalyticsWindow): Promise<AnalyticsDetail | null> {
  const client = createServerClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return null;
  const base: AnalyticsDetail = { section, title: sectionLabels[section], ...definitions[section], unit: section === 'sales' ? 'currency' : 'count', points: [], stats: [], unavailable: false };
  try {
    if (section === 'views') {
      const { data, error } = await client.rpc('creator_views_timeseries', { p_start: window.start, p_end: window.end, p_creator_id: user.id });
      if (error || !Array.isArray(data) || data.length !== window.days) throw new Error('Views unavailable');
      base.points = dailySeries(window, data.map(row => ({ date: row.date, value: Number(row.views) })));
    } else {
      const rows = await readRows(section, user.id, window);
      const selected = section === 'sales' ? rows.filter(row => row.status === 'paid') : section === 'refunds' ? rows.filter(row => row.status === 'refunded') : rows;
      if (section === 'sales' && selected.some(row => row.currency !== 'usd')) throw new Error('Unsupported mixed currencies');
      base.points = dailySeries(window, selected.map(row => {
        if (section === 'sales' && (row.gross_amount === null || row.gross_amount === undefined)) throw new Error('Missing sales amount');
        return { date: String(row[specs[section].time]), value: section === 'sales' ? Number(row.gross_amount) : 1 };
      }));
      if (section === 'clicks') base.stats.push({ label: 'Unique signed-in clickers', value: new Set(rows.map(row => row.user_id).filter(Boolean)).size.toLocaleString('en-US') });
      if (section === 'sales') base.stats.push({ label: 'Paid orders', value: selected.length.toLocaleString('en-US') });
    }
    return base;
  } catch (error) {
    console.error('[analytics] Section unavailable:', section, error instanceof Error ? error.message : 'Query failed');
    return { ...base, points: [], stats: [], unavailable: true };
  }
}
