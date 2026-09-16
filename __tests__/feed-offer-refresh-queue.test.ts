import { FeedOfferRefreshQueue, type FeedOfferJob } from '@/lib/feedOfferRefreshQueue';
import { loadFeedOffers } from '@/lib/feedOffers';
import { mapFeedV3Rows, type PostRow } from '@/lib/feedV3';

const post = (id: string) => mapFeedV3Rows([{ post_id: id, creator_id: 'creator', product_id: `alias-${id}`, poster_url: 'poster' }])[0];
const job = (id: string, version = 1, generation = 1): FeedOfferJob => ({ post: post(id), version, generation });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let queue: FeedOfferRefreshQueue, current: Map<string, FeedOfferJob>, load: jest.Mock, apply: jest.Mock, available: jest.Mock;
const originalFetch = global.fetch;
beforeEach(() => {
  jest.useFakeTimers(); current = new Map(); apply = jest.fn(); available = jest.fn();
  load = jest.fn(async (posts: PostRow[]) => posts.map(p => ({ ...p, purchaseOptionsReady: true })));
  queue = new FeedOfferRefreshQueue({ load, apply, capacityAvailable: available, isCurrent: j => current.get(j.post.id) === j });
  queue.begin(1);
});
afterEach(() => { queue.stop(); jest.useRealTimers(); global.fetch = originalFetch; });
const admit = (jobs: FeedOfferJob[], immediate = false) => { jobs.forEach(j => current.set(j.post.id, j)); return queue.enqueue(jobs, immediate); };

test('same-post bursts retain only the latest revision and one 25ms timer', async () => {
  for (let version = 1; version <= 1000; version++) admit([job('one', version)]);
  expect(queue.status()).toEqual({ active: 0, pending: 1 });
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(24); await flush(); expect(load).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); await flush();
  expect(load).toHaveBeenCalledTimes(1); expect(apply.mock.calls[0][0][0].job.version).toBe(1000);
  expect(queue.status()).toEqual({ active: 0, pending: 0 });
});

test('hard pending/batch bounds and an unresolved original serialize physical reads', async () => {
  const first = deferred<PostRow[]>(); load.mockReturnValueOnce(first.promise);
  const jobs = Array.from({ length: 301 }, (_, i) => job(String(i)));
  expect(admit(jobs)).toHaveLength(101);
  expect(queue.status()).toEqual({ active: 0, pending: 200 });
  jest.advanceTimersByTime(25); await flush();
  expect(load.mock.calls[0][0]).toHaveLength(100);
  expect(queue.status()).toEqual({ active: 1, pending: 100 });
  jest.advanceTimersByTime(60000); await flush(); expect(load).toHaveBeenCalledTimes(1);
  first.resolve(load.mock.calls[0][0]); await flush();
  expect(load).toHaveBeenCalledTimes(2); expect(load.mock.calls[1][0]).toHaveLength(100);
  expect(apply).toHaveBeenCalledTimes(2); expect(apply.mock.calls[0][0]).toHaveLength(100);
  expect(queue.status()).toEqual({ active: 0, pending: 0 });
});

test('stale delayed initial admission cannot replace a newer realtime job', async () => {
  const initial = job('same', 1), newer = job('same', 2);
  admit([newer]); expect(queue.enqueue([initial], true)).toEqual([]);
  jest.advanceTimersByTime(25); await flush();
  expect(load).toHaveBeenCalledTimes(1); expect(apply.mock.calls[0][0][0].job).toBe(newer);
});

test('new revisions and removal reject stale jobs before dispatch and before applying', async () => {
  const original = deferred<PostRow[]>(); load.mockReturnValueOnce(original.promise);
  const first = job('same'); admit([first], true); await flush();
  admit([job('same', 2), job('gone')]); current.delete('gone'); queue.remove('gone');
  original.resolve([{ ...first.post, purchaseOptionsReady: true }]); await flush();
  expect(apply).not.toHaveBeenCalled();
  jest.advanceTimersByTime(25); await flush();
  expect(load.mock.calls[1][0].map((p: PostRow) => p.id)).toEqual(['same']);
  expect(apply.mock.calls[0][0][0].job.version).toBe(2);
});

test('rapid generation changes abort but retain an ignored-abort original until its actual settlement', async () => {
  const original = deferred<PostRow[]>(); load.mockReturnValueOnce(original.promise);
  const old = job('same'); admit([old], true); await flush();
  const signal = load.mock.calls[0][1] as AbortSignal;
  queue.begin(2); admit([job('same', 1, 2)], true);
  queue.begin(3); const latest = job('same', 1, 3); admit([latest], true);
  expect(signal.aborted).toBe(true); expect(load).toHaveBeenCalledTimes(1);
  expect(queue.status()).toEqual({ active: 1, pending: 1 });
  original.resolve([{ ...old.post, purchaseOptionsReady: true }]); await flush();
  expect(load).toHaveBeenCalledTimes(2); expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0][0][0].job).toBe(latest);
});

test.each(['throw', 'reject', 'invalid'] as const)('%s has no automatic retry and cannot strand the next queued batch', async mode => {
  if (mode === 'throw') load.mockImplementationOnce(() => { throw Error('synthetic'); });
  if (mode === 'reject') load.mockRejectedValueOnce(Error('synthetic'));
  if (mode === 'invalid') load.mockResolvedValueOnce([null]);
  admit([job('failed')], true); await flush();
  jest.advanceTimersByTime(60000); await flush(); expect(load).toHaveBeenCalledTimes(1);
  admit([job('next')], true); await flush(); expect(load).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenCalledTimes(1); expect(apply.mock.calls[0][0][0].job.post.id).toBe('next');
});

test('stop clears queued work/timer and late original results cannot publish', async () => {
  const original = deferred<PostRow[]>(); load.mockReturnValueOnce(original.promise);
  const first = job('first'); admit([first], true); await flush(); admit([job('queued')]); queue.stop();
  expect(load.mock.calls[0][1].aborted).toBe(true); expect(queue.status()).toEqual({ active: 1, pending: 0 });
  original.resolve([first.post]); await flush(); jest.advanceTimersByTime(60000); await flush();
  expect(apply).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('actual helper propagates caller abort and refuses an ignored-abort successful response', async () => {
  const transport = deferred<Response>(), controller = new AbortController();
  global.fetch = jest.fn(() => transport.promise);
  const pending = loadFeedOffers([post('one')], controller.signal);
  const signal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal;
  controller.abort(); expect(signal.aborted).toBe(true);
  transport.resolve(Response.json({ offers: { one: { creatorId: 'creator', productId: 'canonical', linkedProductId: 'alias-one', productType: 'course', monthlyTerms: null } } }));
  expect((await pending)[0].purchaseOptionsReady).toBe(false); expect(jest.getTimerCount()).toBe(0);
});

test('actual helper deadline does not pretend an unsettled transport ended; pre-abort dispatches nothing', async () => {
  const transport = deferred<Response>(); global.fetch = jest.fn(() => transport.promise);
  let settled = false;
  const pending = loadFeedOffers([post('one')]).finally(() => { settled = true; });
  jest.advanceTimersByTime(10000); await flush();
  expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true); expect(settled).toBe(false);
  transport.reject(Error('finally settled')); await pending; expect(settled).toBe(true);
  const controller = new AbortController(); controller.abort();
  expect((await loadFeedOffers([post('one')], controller.signal))[0].purchaseOptionsReady).toBe(false);
  expect(global.fetch).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('a rejected HTTP body retains the real queue slot until cancellation settles', async () => {
  const cancelled = deferred<void>();
  const cancel = jest.fn(() => cancelled.promise);
  global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, body: { cancel } })
    .mockResolvedValue({ ok: true, json: async () => ({ offers: {} }) });
  queue = new FeedOfferRefreshQueue({ load: loadFeedOffers, apply, capacityAvailable: available, isCurrent: j => current.get(j.post.id) === j });
  queue.begin(1); admit([job('error')], true); await flush(); admit([job('next')], true);
  expect(cancel).toHaveBeenCalledTimes(1); expect(global.fetch).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(10000); await flush();
  expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true);
  expect(queue.status().active).toBe(1); expect(global.fetch).toHaveBeenCalledTimes(1);
  cancelled.resolve(); await flush();
  expect(global.fetch).toHaveBeenCalledTimes(2); expect(queue.status().active).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});
