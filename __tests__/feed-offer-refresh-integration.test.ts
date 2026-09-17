/** @jest-environment jsdom */
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const viewer = { userId: 'viewer', loading: false };
let desktop = true;
const handlers: ((event: any) => void)[] = [];
const channel = { on: (_: unknown, _filter: unknown, fn: typeof handlers[number]) => { handlers.push(fn); return channel; }, subscribe: () => channel };
const client = { channel: () => channel, removeChannel: jest.fn() };
const pageFetch = jest.fn();
jest.mock('@/lib/supabaseClient', () => ({ createClient: () => client }));
jest.mock('@/lib/useUser', () => ({ useUser: () => viewer }));
jest.mock('@/lib/browserVisibility', () => ({ useDesktopViewport: () => desktop, usePageVisible: () => true }));
jest.mock('@/lib/posthog', () => ({ trackEvent: jest.fn(), normalizeCategory: (v: unknown) => v }));
jest.mock('@/lib/discoverClient', () => ({ fetchDiscoverPage: (...args: unknown[]) => pageFetch(...args), rememberDiscoverSession: jest.fn() }));
jest.mock('@/components/VideoCard', () => ({ __esModule: true, default: (props: any) =>
  createElement('video', { 'data-card': props.postId, 'data-props': JSON.stringify(props) }) }));
// Real FeedList, helper and queue; only external Auth/page/offer transports are injected.
import FeedList from '@/components/FeedList';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let observer: IntersectionObserverCallback;
class Observer { constructor(fn: IntersectionObserverCallback) { observer = fn; } observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
let container: HTMLDivElement, root: Root, mounted: boolean;
let fetchMock: jest.Mock;
const terms = { version: 'monthly-mentorship-v1', minimumMonths: 3, autoRenew: true };
const row = (id: string) => ({ post_id: id, creator_id: 'creator', product_id: `alias-${id}`, poster_url: 'poster.jpg', title: id });
const page = (count = 10) => ({ items: Array.from({ length: count }, (_, i) => row(String(i))), session: 'session', nextOffset: count, hasMore: false });
const ids = (url: string) => new URL(url, 'https://site.invalid').searchParams.get('ids')!.split(',');
const response = (postIds: string[], minimumMonths = 3) => ({ ok: true, json: async () => ({ offers: Object.fromEntries(postIds.map(id => [id, {
  productId: `canonical-${id}`, linkedProductId: `alias-${id}`, creatorId: 'creator', productType: 'mentorship', priceCents: 9900,
  monthlyTerms: { ...terms, minimumMonths },
}])) }) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const props = (id: string) => JSON.parse(container.querySelector(`[data-card="${id}"]`)!.getAttribute('data-props')!);
const current = () => handlers[handlers.length - 1];
const update = (id: string, changes: Record<string, unknown> = {}) => current()({ eventType: 'UPDATE', new: { id, poster_url: 'poster.jpg', product_id: `alias-${id}`, ...changes }, old: {} });
const tick = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
const render = (strict = false) => act(async () => {
  const feed = createElement(FeedList, { activeTab: 'discover', onChangeTab: jest.fn() });
  root.render(strict ? createElement(StrictMode, null, feed) : feed);
});
const activate = async (id: string) => {
  await act(async () => {
    const scroller = container.querySelector<HTMLDivElement>('div[tabindex="0"]')!;
    scroller.scrollTop = Number(id) * 700;
    scroller.dispatchEvent(new Event('scroll'));
    jest.advanceTimersByTime(20);
  });
  await act(async () => observer([
    { target: container.querySelector(`[data-post-id="${id}"]`)!, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry,
  ], {} as IntersectionObserver));
};
beforeEach(() => {
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 700, width: 390, top: 0, bottom: 700, left: 0, right: 390, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  jest.useFakeTimers(); desktop = true; viewer.userId = 'viewer'; handlers.length = 0;
  pageFetch.mockReset().mockResolvedValue(page());
  fetchMock = jest.fn(async (url: string) => response(ids(url))); global.fetch = fetchMock;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); mounted = true;
});
afterEach(async () => { if (mounted) await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); });

test('500 actual subscribed updates collapse into one latest 10-ID read after 25ms', async () => {
  await render(); expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockImplementation(async (url: string) => response(ids(url), 6));
  await act(async () => { for (let i = 0; i < 500; i++) update(String(i % 10), { title: `latest-${i}` }); });
  expect(props('0').purchaseOptionsReady).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(1);
  await tick(24); expect(fetchMock).toHaveBeenCalledTimes(1); await tick(1);
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(ids(fetchMock.mock.calls[1][0])).toHaveLength(10);
  expect(props('0').monthlyTerms.minimumMonths).toBe(6); expect(props('0').purchaseOptionsReady).toBe(true);
});

test('mobile delayed initial enrichment cannot overwrite a realtime version already admitted and completed', async () => {
  desktop = false; await render(); expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockImplementation(async (url: string) => response(ids(url), 6));
  await act(async () => update('0')); await tick(25);
  expect(props('0').monthlyTerms.minimumMonths).toBe(6);
  await tick(250);
  // The nine untouched initial posts still enrich; the obsolete initial job for0 does not send.
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(ids(fetchMock.mock.calls[1][0])).not.toContain('0');
  expect(props('0').monthlyTerms.minimumMonths).toBe(6);
});

test('same post IDs in a new viewer generation cannot bypass an ignored-abort old original', async () => {
  const old = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(old.promise);
  await render(); const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  await act(async () => update('0'));
  viewer.userId = 'other-viewer'; await render();
  expect(signal.aborted).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(1);
  await tick(25); expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => old.resolve(response(['0'], 12)));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(props('0').monthlyTerms.minimumMonths).toBe(3);
  expect(props('0').purchaseOptionsReady).toBe(true);
});

test.each(['DELETE', 'hidden_at', 'removed_at'])('%s removes queued work immediately, including partial moderation payloads', async mode => {
  await render(); await act(async () => {
    update('0'); update('1');
    current()(mode === 'DELETE' ? { eventType: 'DELETE', new: {}, old: { id: '0' } }
      : { eventType: 'UPDATE', new: { id: '0', [mode]: '2026-09-16T00:00:00Z' }, old: {}, errors: ['truncated'] });
  });
  expect(container.querySelector('[data-post-id="0"]')).toBeNull(); await tick(25);
  expect(ids(fetchMock.mock.calls[1][0])).toEqual(['1']);
  expect(container.querySelector('[data-post-id="0"]')).toBeNull();
});

test('a healthy truncated update does not remove media or trust its missing old payload', async () => {
  await render(); await act(async () => current()({ eventType: 'UPDATE', new: { id: '0' }, old: {}, errors: ['truncated'] }));
  expect(container.querySelector('[data-post-id="0"]')).not.toBeNull(); expect(props('0').purchaseOptionsReady).toBe(false);
  await tick(25); expect(fetchMock).toHaveBeenCalledTimes(2); expect(props('0').purchaseOptionsReady).toBe(true);
});

test('explicit product detach and creator mismatch cannot restore stale purchase readiness', async () => {
  await render(); const old = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(old.promise);
  await act(async () => update('0')); await tick(25);
  await act(async () => update('0', { product_id: null }));
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ offers: {} }) });
  await act(async () => old.resolve(response(['0'], 12))); await tick(25);
  expect(props('0').productId).toBeNull(); expect(props('0').purchaseOptionsReady).toBe(false);
  const count = fetchMock.mock.calls.length;
  await act(async () => update('1', { creator_id: 'someone-else' })); await tick(25);
  expect(fetchMock).toHaveBeenCalledTimes(count); expect(props('1').purchaseOptionsReady).toBe(false);
});

test('capacity-deferred nearby posts recover on activation, removed ones cannot return, and remaining overload exposes Refresh', async () => {
  pageFetch.mockResolvedValue(page(305));
  const first = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(first.promise);
  await render(); expect(ids(fetchMock.mock.calls[0][0])).toHaveLength(100);
  expect(container.textContent).toContain('Purchase options delayed');
  await activate('250');
  await act(async () => current()({ eventType: 'DELETE', new: {}, old: { id: '251' } }));
  await tick(25); expect(fetchMock).toHaveBeenCalledTimes(1); expect(props('250').purchaseOptionsReady).toBe(false);
  await act(async () => first.resolve(response(ids(fetchMock.mock.calls[0][0]))));
  expect(fetchMock.mock.calls.every(call => ids(call[0]).length <= 100)).toBe(true);
  expect(fetchMock.mock.calls.slice(1).flatMap(call => ids(call[0]))).not.toContain('251');
  expect(props('250').purchaseOptionsReady).toBe(true);
  expect(container.querySelector('[data-post-id="251"]')).toBeNull();
  expect(container.textContent).toContain('Purchase options delayed');
  pageFetch.mockResolvedValue(page());
  await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Purchase options delayed'))!.click());
  expect(container.textContent).not.toContain('Purchase options delayed'); expect(pageFetch).toHaveBeenCalledTimes(2);
  expect(props('0').purchaseOptionsReady).toBe(true);
});

test('invalid offer responses do not retry on window changes or elapsed time', async () => {
  await render(); fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ offers: {} }) });
  await act(async () => update('0')); await tick(25); expect(props('0').purchaseOptionsReady).toBe(false);
  await activate('1'); await activate('0'); await tick(60000);
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(props('0').purchaseOptionsReady).toBe(false);
});

test('unmount aborts actual offer transport, drops timers and handles its late response', async () => {
  const old = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(old.promise);
  await render(); await act(async () => update('0'));
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  await act(async () => root.unmount()); mounted = false; expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(response(['0']))); await tick(60000);
  // React's act check uses queueMicrotask, which Jest counts with fake timers.
  jest.runAllTicks();
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(container.children).toHaveLength(0); expect(jest.getTimerCount()).toBe(0);
});

test('StrictMode effect restart reopens only the new generation', async () => {
  await render(true); expect(props('0').purchaseOptionsReady).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
