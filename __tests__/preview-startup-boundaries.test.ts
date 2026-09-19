import { markServerStartup, previewStartupBoundaries } from '../lib/serverStartupTiming';
import { createDiscoverRouteTiming } from '../lib/discoverRouteTiming';

const original = { ...process.env };
const key = Symbol.for('creatornet.startup-timing.v1');
const parse = (values: string[]) => Object.fromEntries(values.map(v => {
  const [name, value] = v.split(';dur='); return [name, Number(value)];
}));
beforeEach(() => { process.env.VERCEL_ENV = 'preview'; });
afterEach(() => {
  process.env = { ...original };
  delete (globalThis as any)[key];
  jest.restoreAllMocks();
});

test('keeps startup offsets, dependency evaluation and handler entry distinct', () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  markServerStartup('start'); now = 150;
  markServerStartup('registering'); now = 200;
  markServerStartup('ready'); now = 400;
  const entry = createDiscoverRouteTiming(250); now = 425;
  expect(parse(entry())).toMatchObject({bootstart:100,bootready:200,
    routeimportstart:250,routeimports:150,routeage:25,handlerentry:425});
  now = 900;
  expect(parse(entry())).toMatchObject({routeimportstart:250,routeimports:150,
    routeage:500,handlerentry:900,invocation:2});
});

test('new diagnostic fields are bounded to 64 invocations independently per route', () => {
  jest.spyOn(performance, 'now').mockReturnValue(100);
  const feed = createDiscoverRouteTiming(10), events = createDiscoverRouteTiming(20);
  for (let i = 0; i < 64; i++) expect(parse(feed()).routeimports).toBe(90);
  expect(parse(feed())).not.toHaveProperty('routeimports');
  expect(parse(events()).routeimports).toBe(80);
});

test.each(['production', 'development'])('no new offsets in %s even with existing timed logging', env => {
  process.env.VERCEL_ENV = env;
  process.env.DISCOVER_TIMING_LOG_UNTIL = new Date(Date.now()+60000).toISOString();
  expect(previewStartupBoundaries(1,2,3)).toEqual([]);
  expect(parse(createDiscoverRouteTiming(0)())).not.toHaveProperty('handlerentry');
});

test.each([[NaN,2,3],[1,Infinity,3],[-1,2,3],[3,2,4],[1,4,3]])(
  'invalid or reversed markers are unavailable, never zero-filled (%s,%s,%s)', (a,b,c) => {
    expect(previewStartupBoundaries(a,b,c)).toEqual([]);
  });

test('missing application startup markers stay absent', () => {
  const result = parse(previewStartupBoundaries(1,2,3));
  expect(result).not.toHaveProperty('bootstart');
  expect(result).not.toHaveProperty('bootready');
});

test('route probes retain separate first-evaluation timestamps', async () => {
  jest.resetModules();
  const clock = jest.spyOn(performance, 'now').mockReturnValue(10);
  const feed = await import('../app/api/feed/startupProbe');
  clock.mockReturnValue(20);
  const events = await import('../app/api/feed-events/startupProbe');
  expect(feed.routeImportStarted).toBe(10);
  expect(events.routeImportStarted).toBe(20);
  expect((await import('../app/api/feed/startupProbe')).routeImportStarted).toBe(10);
});

test('probe clock failures are diagnostic-only', async () => {
  jest.resetModules();
  jest.spyOn(performance, 'now').mockImplementation(() => { throw Error('unavailable'); });
  expect((await import('../app/api/feed/startupProbe')).routeImportStarted).toBeUndefined();
});
