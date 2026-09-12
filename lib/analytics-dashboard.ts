export const analyticsSections = ['views', 'engagement', 'clicks', 'checkouts', 'sales', 'bookings', 'refunds'] as const;
export type AnalyticsSection = typeof analyticsSections[number];
export type AnalyticsPoint = { date: string; value: number };
export type AnalyticsWindow = { days: number; start: string; end: string; endExclusive: string };
export type AnalyticsDetail = { section: AnalyticsSection; title: string; metric: string; unit: 'count' | 'currency'; description: string; points: AnalyticsPoint[]; stats: { label: string; value: string }[]; unavailable: boolean };
export const sectionLabels: Record<AnalyticsSection, string> = { views: 'Views', engagement: 'Engagement', clicks: 'Clicks', checkouts: 'Checkouts', sales: 'Sales', bookings: 'Bookings', refunds: 'Refunds' };
export function analyticsWindow(input: string | undefined, now = new Date()): AnalyticsWindow {
  const days = input === '30' ? 30 : input === '14' ? 14 : 7;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  const exclusive = new Date(end); exclusive.setUTCDate(exclusive.getUTCDate() + 1);
  return { days, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), endExclusive: exclusive.toISOString() };
}
export function analyticsSection(value: string | undefined): AnalyticsSection {
  return analyticsSections.includes(value as AnalyticsSection) ? value as AnalyticsSection : 'views';
}
export function dailySeries(window: AnalyticsWindow, rows: { date: string; value: number }[]): AnalyticsPoint[] {
  const points = Array.from({ length: window.days }, (_, i) => {
    const day = new Date(`${window.start}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + i);
    return { date: day.toISOString().slice(0, 10), value: 0 };
  });
  for (const row of rows) {
    if (!Number.isFinite(row.value) || row.value < 0) throw new Error('Invalid analytics value');
    const point = points.find(point => point.date === row.date.slice(0, 10));
    if (point) point.value += row.value;
  }
  return points;
}
export function formatMetric(value: number, unit: AnalyticsDetail['unit']) {
  return unit === 'currency' ? (value / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}
