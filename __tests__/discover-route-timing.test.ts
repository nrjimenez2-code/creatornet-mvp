import {createDiscoverRouteTiming} from '@/lib/discoverRouteTiming';

const originalEnv = process.env.VERCEL_ENV;
afterEach(() => {
  if (originalEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalEnv;
  jest.restoreAllMocks();
});
const values = (metrics:string[]) => Object.fromEntries(metrics.map(metric => {
  const [name,value] = metric.split(';dur=');
  return [name,Number(value)];
}));

test('captures numeric entry snapshots with independent module ordinals',async()=>{
  process.env.VERCEL_ENV = 'preview';
  const feed = createDiscoverRouteTiming();
  const events = createDiscoverRouteTiming();
  const first = feed();
  const captured = [...first];
  await Promise.resolve();
  const second = feed();
  expect(values(first).invocation).toBe(1);
  expect(values(second).invocation).toBe(2);
  expect(values(events()).invocation).toBe(1);
  expect(first).toEqual(captured);
  expect(values(second).routeage).toBeGreaterThanOrEqual(values(first).routeage);
  expect(first.every(metric=>/^[a-z]+;dur=\d+(?:\.\d+)?$/.test(metric))).toBe(true);
  expect(Object.keys(values(first))).toEqual(['invocation','routeage','uptime']);
  expect(values(first).routeage).toBeGreaterThanOrEqual(0);
  expect(values(first).uptime).toBeGreaterThanOrEqual(0);
});

test.each(['production','development',undefined])('omits diagnostics in %s without observing process uptime',environment=>{
  if (environment === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = environment;
  const uptime = jest.spyOn(process,'uptime');
  const entry = createDiscoverRouteTiming();
  expect(entry()).toEqual([]);
  expect(uptime).not.toHaveBeenCalled();
});

test.each([NaN,Infinity,-1])('omits invalid uptime %s rather than serializing it',uptime=>{
  process.env.VERCEL_ENV = 'preview';
  jest.spyOn(process,'uptime').mockReturnValue(uptime);
  const metrics = createDiscoverRouteTiming()();
  expect(values(metrics)).not.toHaveProperty('uptime');
  expect(values(metrics).invocation).toBe(1);
});

test('unavailable uptime cannot fail a request entry',()=>{
  process.env.VERCEL_ENV = 'preview';
  jest.spyOn(process,'uptime').mockImplementation(()=>{throw new Error('unavailable');});
  expect(values(createDiscoverRouteTiming()())).toEqual({invocation:1,routeage:expect.any(Number)});
});
