import { withDiscoverDatabaseTiming, timedDatabaseFetch, discoverDatabaseTimingHeader } from '@/lib/discoverDatabaseTiming';

const originalFetch = global.fetch;
const originalEnv = process.env.VERCEL_ENV;
afterEach(() => { global.fetch = originalFetch; process.env.VERCEL_ENV = originalEnv; });

test('isolates overlapping requests and records no private inputs', async () => {
  process.env.VERCEL_ENV = 'preview';
  global.fetch = jest.fn(async () => new Response('{}'));
  const results = await Promise.all([1, 3].map(count => withDiscoverDatabaseTiming(async () => {
    for(let i=0;i<count;i++) await timedDatabaseFetch('https://private.test/person', {headers:{Authorization:'secret'}});
    return discoverDatabaseTimingHeader();
  })));
  expect(results[0]).toContain('dbcount;dur=1');
  expect(results[1]).toContain('dbcount;dur=3');
  expect(JSON.stringify(results)).not.toMatch(/secret|private|person/);
  expect(discoverDatabaseTimingHeader()).toEqual([]);
});

test('preserves fetch rejection and does not retain context afterward', async () => {
  process.env.VERCEL_ENV = 'preview';
  const failure = new Error('network failure');
  global.fetch = jest.fn(async () => { throw failure; });
  await withDiscoverDatabaseTiming(async () => {
    await expect(timedDatabaseFetch('https://example.test')).rejects.toBe(failure);
    expect(discoverDatabaseTimingHeader()).toContain('dbcount;dur=1');
  });
  expect(discoverDatabaseTimingHeader()).toEqual([]);
});

test('production passes through without diagnostics', async () => {
  process.env.VERCEL_ENV = 'production';
  const response = new Response('{}');
  global.fetch = jest.fn(async () => response);
  await withDiscoverDatabaseTiming(async () => {
    expect(await timedDatabaseFetch('https://example.test')).toBe(response);
    expect(discoverDatabaseTimingHeader()).toEqual([]);
  });
});

test('accepts only numeric upstream durations and distinguishes missing samples', async () => {
  process.env.VERCEL_ENV = 'preview';
  global.fetch = jest.fn()
    .mockResolvedValueOnce(new Response('{}', {headers:{'x-envoy-upstream-service-time':'12.5'}}))
    .mockResolvedValueOnce(new Response('{}', {headers:{'x-envoy-upstream-service-time':'private-detail'}}))
    .mockResolvedValueOnce(new Response('{}'));
  await withDiscoverDatabaseTiming(async () => {
    for(let i=0;i<3;i++) await timedDatabaseFetch('https://example.test');
    expect(discoverDatabaseTimingHeader()).toContain('upstream;dur=12.5');
    expect(discoverDatabaseTimingHeader()).toContain('upstreamcount;dur=1');
    expect(discoverDatabaseTimingHeader().join(',')).not.toContain('private-detail');
  });
});
