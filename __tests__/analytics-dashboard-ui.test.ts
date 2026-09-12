/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from '@/components/analytics/AnalyticsDashboard';
import { analyticsWindow, dailySeries, type AnalyticsDetail } from '@/lib/analytics-dashboard';
const push = jest.fn(); const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
jest.mock('@/components/BackButton', () => ({ __esModule: true, default: () => createElement('a', { href: '/dashboard' }, 'Go back') }));
jest.mock('recharts', () => new Proxy({}, { get: (_, key) => key === '__esModule' ? true : ({ children }: { children?: React.ReactNode }) => createElement('div', null, children) }));
const window = analyticsWindow('7', new Date('2026-09-12T00:00:00Z'));
const detail: AnalyticsDetail = { section: 'views', title: 'Views', metric: 'Video views', unit: 'count', description: 'Playback starts.', points: dailySeries(window, [{ date: '2026-09-12', value: 91 }]), stats: [], unavailable: false };
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
test('one section dropdown navigates seven views and preserves selected range', async () => {
  await act(async () => root.render(createElement(Dashboard, { detail, window })));
  const section = container.querySelector<HTMLSelectElement>('#analytics-section')!;
  expect(section.options).toHaveLength(7);
  await act(async () => { section.value = 'sales'; section.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(push).toHaveBeenCalledWith('/dashboard/analytics?section=sales&days=7', { scroll: false });
  const days = container.querySelector<HTMLSelectElement>('#analytics-days')!;
  await act(async () => { days.value = '30'; days.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(push).toHaveBeenCalledWith('/dashboard/analytics?section=views&days=30', { scroll: false });
  expect(container.querySelectorAll('tbody tr')).toHaveLength(7);
});
test('failure exposes retry without a fake zero total or graph', async () => {
  await act(async () => root.render(createElement(Dashboard, { detail: { ...detail, points: [], unavailable: true }, window })));
  expect(container.querySelector('[role=alert]')).not.toBeNull(); expect(container.querySelector('[role=img]')).toBeNull();
  await act(async () => container.querySelector('button')!.click()); expect(refresh).toHaveBeenCalled();
});
