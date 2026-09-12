import { redirect } from 'next/navigation';
import { analyticsSection, analyticsWindow } from '@/lib/analytics-dashboard';
import { loadAnalyticsDetail } from '@/lib/analytics-dashboard-server';
import AnalyticsDashboard from '@/components/analytics/AnalyticsDashboard';

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ section?: string; days?: string }> }) {
  const params = await searchParams;
  const section = analyticsSection(params.section);
  const window = analyticsWindow(params.days);
  const detail = await loadAnalyticsDetail(section, window);
  if (!detail) redirect('/auth');
  return <AnalyticsDashboard detail={detail} window={window} />;
}
