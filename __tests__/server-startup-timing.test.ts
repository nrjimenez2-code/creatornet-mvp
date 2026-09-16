const startupKey = Symbol.for('creatornet.startup-timing.v1');
const originalEnv = { ...process.env };
let mockNow = 0;
const mockCapture = jest.fn();
jest.mock('@sentry/nextjs', () => { mockNow += 80; return { captureRequestError: mockCapture }; });
jest.mock('../sentry.server.config', () => { mockNow += 20; return {}; });
jest.mock('../sentry.edge.config', () => { mockNow += 10; return {}; });
const parse = (metrics: string[]) => Object.fromEntries(metrics.map(s => {
  const [key, value] = s.split(';dur='); return [key, Number(value)];
}));
beforeEach(() => {
  jest.resetModules();
  delete (globalThis as any)[startupKey];
  mockNow = 100;
  process.env.VERCEL_ENV = 'preview';
  jest.spyOn(performance, 'now').mockImplementation(() => mockNow);
});
afterEach(() => {
  delete (globalThis as any)[startupKey];
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

test.each([['nodejs',20],['edge',10]])('preserves %s initialization and distinguishes imports from awaited registration', async (runtime, duration) => {
  process.env.NEXT_RUNTIME = String(runtime);
  const instrumentation = await import('../instrumentation');
  const timing = await import('../lib/serverStartupTiming');
  expect(instrumentation.onRequestError).toBe(mockCapture);
  expect(parse(timing.serverStartupMetrics())).toEqual({bootcomplete:0,bootimports:80,bootage:80});
  await instrumentation.register();
  mockNow += 5;
  expect(parse(timing.serverStartupMetrics())).toEqual({bootcomplete:1,bootimports:80,bootregister:duration,bootage:85+Number(duration)});
  // Separately bundled readers reuse the same realm record; no new startup.
  jest.resetModules();
  const reader = await import('../lib/serverStartupTiming');
  expect(reader.serverStartupMetrics()).toEqual(timing.serverStartupMetrics());
});

test('production diagnostics expire without removing initialization or error capture', async () => {
  process.env.NEXT_RUNTIME = 'nodejs';
  process.env.VERCEL_ENV = 'production';
  process.env.DISCOVER_TIMING_LOG_UNTIL = new Date(Date.now()+60000).toISOString();
  const instrumentation = await import('../instrumentation');
  await instrumentation.register();
  const timing = await import('../lib/serverStartupTiming');
  expect(timing.serverStartupMetrics().length).toBe(4);
  process.env.DISCOVER_TIMING_LOG_UNTIL = '2020-01-01T00:00:00Z';
  expect(timing.serverStartupMetrics()).toEqual([]);
  expect(instrumentation.onRequestError).toBe(mockCapture);
});

test('disabled diagnostics store no timing state and still initialize Sentry', async () => {
  process.env.NEXT_RUNTIME = 'nodejs';
  process.env.VERCEL_ENV = 'production';
  delete process.env.DISCOVER_TIMING_LOG_UNTIL;
  const instrumentation = await import('../instrumentation');
  await instrumentation.register();
  expect(mockNow).toBe(200);
  expect((globalThis as any)[startupKey]).toBeUndefined();
});

test('missing markers and diagnostic clock failure never block request timing', async () => {
  const timing = await import('../lib/serverStartupTiming');
  expect(timing.serverStartupMetrics()).toEqual([]);
  jest.spyOn(performance,'now').mockImplementation(() => {throw Error('Clock unavailable');});
  expect(() => timing.markServerStartup('start')).not.toThrow();
  expect(timing.serverStartupMetrics()).toEqual([]);
});

test('startup measurements reach only the existing bounded numeric request logger', async () => {
  process.env.NEXT_RUNTIME = 'edge';
  process.env.VERCEL_ENV = 'production';
  process.env.DISCOVER_TIMING_LOG_UNTIL = new Date(Date.now()+60000).toISOString();
  const instrumentation = await import('../instrumentation');
  await instrumentation.register();
  const { createDiscoverRouteTiming } = await import('../lib/discoverRouteTiming');
  const { createDiscoverTimingLogger } = await import('../lib/discoverTimingLog');
  const info = jest.spyOn(console,'info').mockImplementation(() => {});
  createDiscoverTimingLogger('feed')(200,createDiscoverRouteTiming()());
  const logged = JSON.parse(info.mock.calls[0][1]).metrics;
  expect(logged).toMatchObject({bootcomplete:1,bootimports:80,bootregister:10,bootage:90});
  expect(Object.values(logged).every(value => typeof value === 'number')).toBe(true);
});

test('registration failures propagate and never claim startup completed', async () => {
  process.env.NEXT_RUNTIME = 'nodejs';
  jest.doMock('../sentry.server.config', () => { throw Error('monitor initialization failed'); });
  const instrumentation = await import('../instrumentation');
  await expect(instrumentation.register()).rejects.toThrow('monitor initialization failed');
  const timing = await import('../lib/serverStartupTiming');
  expect(parse(timing.serverStartupMetrics()).bootcomplete).toBe(0);
  expect(parse(timing.serverStartupMetrics())).not.toHaveProperty('bootregister');
});
