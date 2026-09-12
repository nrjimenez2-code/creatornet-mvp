import { analyticsWindow, dailySeries, analyticsSection } from '@/lib/analytics-dashboard';
import { loadAnalyticsDetail } from '@/lib/analytics-dashboard-server';
const getUser = jest.fn(); const rpc = jest.fn(); const from = jest.fn();
jest.mock('@/lib/supabaseServer', () => ({ createServerClient: () => ({ auth: { getUser }, rpc }) }));
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: (...args: unknown[]) => from(...args) } }));
const window = analyticsWindow('7', new Date('2026-09-12T23:59:00Z'));
function query(rows: Record<string, unknown>[], count = rows.length, error: unknown = null) {
  const q: Record<string, jest.Mock> = {};
  for (const key of ['select', 'eq', 'gte', 'lt', 'order']) q[key] = jest.fn(() => q);
  q.range = jest.fn(async (offset: number, end: number) => ({ data: rows.slice(offset, end + 1), count, error }));
  from.mockReturnValue(q); return q;
}
beforeEach(() => { jest.clearAllMocks(); getUser.mockResolvedValue({ data: { user: { id: 'owner' } }, error: null }); });
test('seven days are exactly seven UTC dates across year boundaries', () => {
  expect(window.start).toBe('2026-09-06'); expect(window.endExclusive).toBe('2026-09-13T00:00:00.000Z');
  expect(analyticsWindow('7', new Date('2026-01-02T00:00:00Z')).start).toBe('2025-12-27');
  expect(analyticsWindow('999').days).toBe(7); expect(analyticsSection('bad')).toBe('views');
});
test('zero fills dates and sums events without accepting invalid amounts', () => {
  expect(dailySeries(window, [{ date: '2026-09-12', value: 2 }, { date: '2026-09-12', value: 3 }]).map(p => p.value)).toEqual([0,0,0,0,0,0,5]);
  expect(() => dailySeries(window, [{ date: '2026-09-12', value: NaN }])).toThrow();
});
test('unauthenticated requests never issue privileged queries', async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: null });
  expect(await loadAnalyticsDetail('sales', window)).toBeNull(); expect(from).not.toHaveBeenCalled();
});
test.each(['engagement','clicks','checkouts','sales','bookings','refunds'] as const)('%s query is owner scoped with exclusive end', async section => {
  const q = query([]); const result = await loadAnalyticsDetail(section, window);
  expect(q.eq).toHaveBeenCalledWith(section === 'engagement' ? 'posts.creator_id' : 'creator_id', 'owner');
  expect(q.lt).toHaveBeenCalledWith(expect.any(String), window.endExclusive);
  expect(result?.unavailable).toBe(false); expect(result?.points).toHaveLength(7);
});
test('pagination includes events after the first API page and deduplicates signed-in clickers for the period', async () => {
  const q = query(Array.from({ length: 501 }, (_, i) => ({ id: i, occurred_at: '2026-09-12T12:00:00Z', user_id: i % 2 ? null : 'same-user' })));
  const result = await loadAnalyticsDetail('clicks', window);
  expect(q.range).toHaveBeenCalledTimes(2); expect(result?.points[6].value).toBe(501); expect(result?.stats[0].value).toBe('1');
});
test('failed or truncated reads are unavailable, not zero', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  query([], 1); expect((await loadAnalyticsDetail('sales', window))?.unavailable).toBe(true);
  query([], 0, { message: 'failed' }); expect((await loadAnalyticsDetail('bookings', window))?.unavailable).toBe(true);
  query([], 20001); expect((await loadAnalyticsDetail('clicks', window))?.unavailable).toBe(true);
  spy.mockRestore();
});
test('sales retain current paid-order semantics; pending/refunded do not inflate gross', async () => {
  query(['paid','pending','refunded'].map((status, id) => ({ id, status, gross_amount: 12345, currency: 'usd', created_at: '2026-09-10T12:00:00Z' })));
  const result = await loadAnalyticsDetail('sales', window);
  expect(result?.points[4].value).toBe(12345); expect(result?.stats[0].value).toBe('1');
  expect(result?.stats[1]).toEqual({ label: 'Average order value', value: '$123.45' });
});
test('views RPC remains tied to signed-in creator; failure is not a zero graph', async () => {
  rpc.mockResolvedValue({ data: dailySeries(window, []).map(p => ({ date: p.date, views: p.value })), error: null });
  expect((await loadAnalyticsDetail('views', window))?.unavailable).toBe(false);
  expect(rpc).toHaveBeenCalledWith('creator_views_timeseries', { p_creator_id: 'owner', p_start: window.start, p_end: window.end });
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  rpc.mockResolvedValue({ data: [], error: null }); expect((await loadAnalyticsDetail('views', window))?.unavailable).toBe(true); spy.mockRestore();
});
