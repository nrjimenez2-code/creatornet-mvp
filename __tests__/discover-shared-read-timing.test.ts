const cache = jest.fn();
jest.mock('next/cache', () => ({ unstable_cache: (...args: unknown[]) => cache(...args) }));
import { discoverSharedRead, type DiscoverSharedReadObservation } from '@/lib/discoverSharedRead';
import { inFlightRead } from '@/lib/inFlightRead';
import {
  DISCOVER_SHARED_READ_METRICS, discoverSharedReadTimingHeader,
  observeDiscoverSharedRead, withDiscoverSharedReadTiming,
} from '@/lib/discoverSharedReadTiming';

const originalVercel = process.env.VERCEL;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function metrics() {
  return Object.fromEntries(discoverSharedReadTimingHeader().map(value => {
    const [name, duration] = value.split(';dur=');
    return [name, Number(duration)];
  }));
}
function inventory<T>(read: () => Promise<T>) {
  return observeDiscoverSharedRead('inventory', observation =>
    discoverSharedRead('fixture-private-key', read, observation));
}
beforeEach(() => { process.env.VERCEL = '1'; cache.mockReset(); });
afterEach(() => {
  jest.restoreAllMocks();
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
});

test('disabled observation preserves the original promise and has no request context', async () => {
  const result = Promise.resolve({ private: 'value' });
  const work = jest.fn((observation?: DiscoverSharedReadObservation) => {
    expect(observation).toBeUndefined();
    return result;
  });
  const pending = withDiscoverSharedReadTiming(false, () => observeDiscoverSharedRead('inventory', work));
  expect(pending).toBe(result);
  await pending;
  expect(work).toHaveBeenCalledTimes(1);
  expect(discoverSharedReadTimingHeader()).toEqual([]);
});

test('accepted recent cache envelope and local loader are reported separately', async () => {
  cache.mockReturnValue(async () => ({ value: 'cached', readAt: Date.now() }));
  const read = jest.fn(async () => 'loaded');
  const hit = await withDiscoverSharedReadTiming(true, async () => {
    expect(await inventory(read)).toBe('cached');
    return metrics();
  });
  expect(read).not.toHaveBeenCalled();
  expect(hit).toMatchObject({ invcalls: 1, invfresh: 1, invloads: 0,
    invcachewaitcount: 1, invreadwaitcount: 0, invwaitcount: 1, inverrors: 0 });
  cache.mockImplementation((load: () => Promise<unknown>) => load);
  const loaded = await withDiscoverSharedReadTiming(true, async () => {
    expect(await inventory(read)).toBe('loaded');
    return metrics();
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(loaded).toMatchObject({ invfresh: 1, invloads: 1, invreadwaitcount: 1 });
  expect(cache.mock.calls[0][1]).toEqual(['discover-input-v1',
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.VERCEL_GIT_COMMIT_SHA ?? '', 'fixture-private-key']);
  expect(cache.mock.calls[0][2]).toEqual({ revalidate: 30 });
  expect(JSON.stringify([hit, loaded])).not.toMatch(/private|cached|loaded/);
});

test('local bypass still observes physical read outcomes without touching the cache', async () => {
  delete process.env.VERCEL;
  await withDiscoverSharedReadTiming(true, async () => {
    expect(await inventory(async () => 7)).toBe(7);
    expect(metrics()).toMatchObject({ invcalls: 1, invbypass: 1, invloads: 1,
      invreadwaitcount: 1, invcachewaitcount: 0, invfresh: 0 });
  });
  expect(cache).not.toHaveBeenCalled();
});

test('expired envelope and background refresh join one physical read with distinct waits', async () => {
  const live = deferred<string>();
  let background!: Promise<unknown>;
  const read = jest.fn(() => live.promise);
  let clock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  cache.mockImplementation((load: () => Promise<unknown>) => async () => {
    background = load();
    return { value: 'expired', readAt: Date.now() - 61_000 };
  });
  const request = withDiscoverSharedReadTiming(true, async () => {
    expect(await inventory(read)).toBe('live');
    return metrics();
  });
  await tick();
  expect(read).toHaveBeenCalledTimes(1);
  clock = 45;
  live.resolve('live');
  expect(await request).toMatchObject({ invexpired: 1, invfallback: 1, invreuse: 1,
    invloads: 1, invcachewait: 0, invcachewaitcount: 1,
    invreadwait: 45, invreadwaitcount: 1, invwait: 45, invwaitcount: 1 });
  await background;
});

test('stale accepted data does not wait for refresh and its snapshot excludes late work', async () => {
  const live = deferred<string>();
  let background!: Promise<unknown>, snapshot!: Record<string, number>;
  let clock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  cache.mockImplementation((load: () => Promise<unknown>) => async () => {
    background = load();
    return { value: 'recent', readAt: Date.now() - 31_000 };
  });
  const first = withDiscoverSharedReadTiming(true, async () => {
    expect(await inventory(() => live.promise)).toBe('recent');
    snapshot = metrics();
    await background;
    expect(metrics()).toEqual(snapshot);
  });
  await tick();
  expect(snapshot).toMatchObject({ invstale: 1, invloads: 1, invreadwaitcount: 0,
    invwaitcount: 1, invfallback: 0 });
  await withDiscoverSharedReadTiming(true, async () => {
    cache.mockReturnValue(async () => ({ value: 'other', readAt: Date.now() }));
    expect(await inventory(async () => 'unused')).toBe('other');
    clock = 90;
    live.resolve('refreshed');
    await first;
    expect(metrics()).toMatchObject({ invcalls: 1, invfresh: 1, invloads: 0,
      invreadwaitcount: 0, invstale: 0 });
  });
});

test('a failed late refresh cannot modify its completed response or another request', async () => {
  const live = deferred<never>();
  let background!: Promise<unknown>;
  cache.mockImplementation((load: () => Promise<unknown>) => async () => {
    background = load().catch(() => undefined);
    return { value: 'recent', readAt: Date.now() - 31_000 };
  });
  let snapshot!: Record<string, number>;
  const first = withDiscoverSharedReadTiming(true, async () => {
    await inventory(() => live.promise);
    snapshot = metrics();
    await background;
    expect(metrics()).toEqual(snapshot);
  });
  await tick();
  await withDiscoverSharedReadTiming(true, async () => {
    live.reject(new Error('background failed'));
    await first;
    expect(metrics()).toEqual({});
  });
  expect(snapshot.invloaderrors).toBe(0);
});

test.each(['availability', 'write'] as const)('cache %s failure preserves the existing fallback without retrying', async kind => {
  cache.mockImplementation((load: () => Promise<unknown>) => async () => {
    if (kind === 'write') await load();
    throw new Error('cache unavailable');
  });
  const read = jest.fn(async () => 'value');
  await withDiscoverSharedReadTiming(true, async () => {
    expect(await inventory(read)).toBe('value');
    expect(metrics()).toMatchObject({ invcalls: 1, invcacheerror: 1, invloads: 1,
      invfallback: kind === 'availability' ? 1 : 0, invcompleted: kind === 'write' ? 1 : 0,
      inverrors: 0, invloaderrors: 0 });
  });
  expect(read).toHaveBeenCalledTimes(1);
});

test.each([null, {}, { readAt: 'private' }, { value: 'bad', readAt: NaN }])('invalid cache envelope records fallback with no values exposed (%p)', async envelope => {
  cache.mockReturnValue(async () => envelope);
  await withDiscoverSharedReadTiming(true, async () => {
    expect(await inventory(async () => 'live')).toBe('live');
    expect(metrics()).toMatchObject({ invinvalid: 1, invfallback: 1, invloads: 1 });
  });
});

test('a failed loader preserves exact rejection and leaves no diagnostic context', async () => {
  const failure = new Error('private backend error');
  cache.mockImplementation((load: () => Promise<unknown>) => load);
  const read = jest.fn(async () => { throw failure; });
  await withDiscoverSharedReadTiming(true, async () => {
    await expect(inventory(read)).rejects.toBe(failure);
    expect(metrics()).toMatchObject({ invcalls: 1, inverrors: 1, invloaderrors: 1,
      invloads: 1, invfallback: 0, invcacheerror: 0, invreadwaitcount: 1 });
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(discoverSharedReadTimingHeader()).toEqual([]);
});

test.each([false, true])('in-flight joiners own their waits and outcomes, never another caller loader (failure=%s)', async fails => {
  const share = inFlightRead<string>();
  const live = deferred<string>();
  const failure = new Error('unavailable');
  const read = jest.fn(() => live.promise);
  cache.mockImplementation((load: () => Promise<unknown>) => load);
  let clock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  const request = () => withDiscoverSharedReadTiming(true, async () => {
    const value = observeDiscoverSharedRead('inventory', observation => share('same-private-key',
      () => discoverSharedRead('inventory', read, observation), () => observation?.event('join')));
    if (fails) await expect(value).rejects.toBe(failure);
    else expect(await value).toBe('common');
    return metrics();
  });
  const owner = request();
  await tick();
  clock = 10;
  const joiner = request();
  await tick();
  clock = 40;
  if (fails) live.reject(failure); else live.resolve('common');
  const [a, b] = await Promise.all([owner, joiner]);
  expect(a).toMatchObject({ invcalls: 1, invjoins: 0, invloads: 1, invwait: 40,
    invreadwait: 40, invcachewaitcount: 1, inverrors: Number(fails), invloaderrors: Number(fails) });
  expect(b).toMatchObject({ invcalls: 1, invjoins: 1, invloads: 0, invwait: 30,
    invcachewaitcount: 0, invreadwaitcount: 0, inverrors: Number(fails), invloaderrors: 0 });
  expect(read).toHaveBeenCalledTimes(1);
  expect(await share('same-private-key', async () => 'new')).toBe('new');
  expect(JSON.stringify([a, b])).not.toMatch(/private|common|unavailable/);
});

test('different keys and nested requests retain independent, bounded diagnostics', async () => {
  const share = inFlightRead<string>();
  cache.mockImplementation((load: () => Promise<unknown>) => load);
  await withDiscoverSharedReadTiming(true, async () => {
    await inventory(async () => 'outer');
    const nested = await withDiscoverSharedReadTiming(true, async () => {
      await Promise.all(['one', 'two'].map(key => observeDiscoverSharedRead('evidence', observation =>
        share(key, () => discoverSharedRead(key, async () => key, observation), () => observation?.event('join')))));
      return metrics();
    });
    expect(nested).toMatchObject({ evicalls: 2, eviloads: 2, evijoins: 0 });
    expect(nested.invcalls).toBeUndefined();
    await withDiscoverSharedReadTiming(false, async () => {
      await observeDiscoverSharedRead('write', async observation => {
        expect(observation).toBeUndefined();
      });
      expect(metrics()).toEqual({});
    });
    const outer = metrics();
    expect(outer).toMatchObject({ invcalls: 1, invloads: 1 });
    expect(outer.evicalls).toBeUndefined();
    expect(outer.sessionstorecalls).toBeUndefined();
  });
});

test('write success and validation failure report only bounded numeric outcome and wait', async () => {
  await withDiscoverSharedReadTiming(true, async () => {
    expect(await observeDiscoverSharedRead('write', async () => 'session-private-id')).toBe('session-private-id');
    const failure = new Error('invalid page');
    await expect(observeDiscoverSharedRead('write', async () => { throw failure; })).rejects.toBe(failure);
    expect(metrics()).toEqual({ sessionstorecalls: 2, sessionstoreerrors: 1,
      sessionstorewaitcount: 2, sessionstorewait: expect.any(Number) });
  });
});

test.each(['throw', 'nonfinite', 'backward'])('unusable %s clock samples never fail work or manufacture duration coverage', async mode => {
  const clock = jest.spyOn(performance, 'now');
  if (mode === 'throw') clock.mockImplementation(() => { throw new Error('clock'); });
  else if (mode === 'nonfinite') clock.mockReturnValue(NaN);
  else clock.mockReturnValueOnce(10).mockReturnValue(0);
  await withDiscoverSharedReadTiming(true, async () => {
    expect(await observeDiscoverSharedRead('write', async () => 1)).toBe(1);
    expect(metrics()).toEqual({ sessionstorecalls: 1, sessionstoreerrors: 0,
      sessionstorewaitcount: 0, sessionstorewait: 0 });
  });
});

test('many calls accumulate in fixed buckets and snapshots ignore unknown diagnostic names', async () => {
  await withDiscoverSharedReadTiming(true, async () => {
    for (let index = 0; index < 125; index++) {
      await observeDiscoverSharedRead('evidence', async observation => {
        observation!.event('actor_private_key' as 'join');
        return index;
      });
    }
    await observeDiscoverSharedRead('inventory', async () => 1);
    await observeDiscoverSharedRead('write', async () => 1);
    const values = metrics();
    expect(Object.keys(values).sort()).toEqual([...DISCOVER_SHARED_READ_METRICS].sort());
    expect(Object.keys(values)).toHaveLength(44);
    expect(values.evicalls).toBe(125);
    expect(JSON.stringify(values)).not.toMatch(/actor|private|key/);
    expect(Object.isFrozen(DISCOVER_SHARED_READ_METRICS)).toBe(true);
    await observeDiscoverSharedRead('evidence', async observation => {
      expect(observation).toBeUndefined();
    });
    expect(metrics()).toEqual(values);
  });
});
