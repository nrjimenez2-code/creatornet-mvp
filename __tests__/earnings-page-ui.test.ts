/** @jest-environment node */
import { renderToStaticMarkup } from 'react-dom/server';
import EarningsPage from '@/app/dashboard/earnings/page';
import type { CreatorEarningsView } from '@/lib/creatorEarningsView';
const load = jest.fn();
jest.mock('@/lib/creatorEarningsView', () => ({ fetchCurrentCreatorEarningsView: () => load() }));
jest.mock('@/components/StripeConnectBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/BackButton', () => ({ __esModule: true, default: () => null }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
const view: CreatorEarningsView = { recordedEarningsCents: 12345, ledgerAvailable: true, historyLimited: false, rows: [] };
beforeEach(() => { load.mockReset().mockResolvedValue(view); });
test('empty earnings keeps recorded amount and removes the profile-record subtitle', async () => {
  const html = renderToStaticMarkup(await EarningsPage());
  expect(html).toContain('$123.45'); expect(html).toContain('Recorded net earnings');
  expect(html).toContain('Payment history'); expect(html).toContain('No tracked payments yet');
  expect(html).not.toContain('From your CreatorNet profile record');
});
test('unavailable history is not represented as empty history', async () => {
  load.mockResolvedValue({ ...view, ledgerAvailable: false });
  const html = renderToStaticMarkup(await EarningsPage());
  expect(html).toContain('temporarily unavailable'); expect(html).not.toContain('No tracked payments yet');
  expect(html).toContain('$123.45');
});
test('populated history retains original net, refund adjustment, disputes and current net', async () => {
  load.mockResolvedValue({ ...view, historyLimited: true, rows: [{ id:'sample',label:'Product sale',grossCents:10000,platformFeeCents:1200,processingFeeCents:320,creatorNetCents:8480,refundedGrossCents:2000,reversedEarningsCents:1696,disputedAmountCents:1000,disputeStatus:'needs_response',currentNetCents:6784,currency:'USD',status:'partially_refunded',createdAt:'2026-09-12T00:00:00Z' }] });
  const html = renderToStaticMarkup(await EarningsPage());
  for (const text of ['Product sale','$100.00','$12.00','$3.20','$84.80','$16.96','$10.00','$67.84','needs response','Only the latest 100 tracked payments']) expect(html).toContain(text);
});
test('signed-out requests still redirect', async () => {
  load.mockResolvedValue(null); await expect(EarningsPage()).rejects.toThrow('redirect:/auth');
});
