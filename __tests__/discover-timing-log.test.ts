import { createDiscoverTimingLogger, discoverTimingEnabled } from '@/lib/discoverTimingLog';

const originalEnv = process.env.VERCEL_ENV;
const originalUntil = process.env.DISCOVER_TIMING_LOG_UNTIL;
const enable = () => {
  process.env.VERCEL_ENV = 'production';
  process.env.DISCOVER_TIMING_LOG_UNTIL = new Date(Date.now() + 60_000).toISOString();
};
afterEach(() => {
  if (originalEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalEnv;
  if (originalUntil === undefined) delete process.env.DISCOVER_TIMING_LOG_UNTIL;
  else process.env.DISCOVER_TIMING_LOG_UNTIL = originalUntil;
  jest.restoreAllMocks();
});

test('requires an explicit short production window and expires without another deployment', () => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  const log = createDiscoverTimingLogger('feed');
  enable();
  expect(discoverTimingEnabled()).toBe(true);
  log(200, ['total;dur=12.3']);
  expect(info).toHaveBeenCalledTimes(1);
  jest.spyOn(Date, 'now').mockReturnValue(now + 60_000);
  expect(discoverTimingEnabled()).toBe(false);
  log(200, ['total;dur=12.3']);
  expect(info).toHaveBeenCalledTimes(1);
});

test.each([undefined, '', 'true', 'private-value', '2020-01-01T00:00:00Z', '2999-01-01T00:00:00Z'])('rejects invalid or out-of-window configuration %s', value => {
  process.env.VERCEL_ENV = 'production';
  if (value === undefined) delete process.env.DISCOVER_TIMING_LOG_UNTIL;
  else process.env.DISCOVER_TIMING_LOG_UNTIL = value;
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  expect(discoverTimingEnabled()).toBe(false);
  createDiscoverTimingLogger('feed')(200, ['total;dur=1']);
  expect(info).not.toHaveBeenCalled();
});

test.each(['preview', 'development', undefined])('never emits production logs in %s', environment => {
  enable();
  if (environment === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = environment;
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  createDiscoverTimingLogger('feed')(200, ['total;dur=1']);
  expect(info).not.toHaveBeenCalled();
  expect(discoverTimingEnabled()).toBe(environment === 'preview');
});

test('only emits allowlisted numeric measurements and bounds logging per route module', () => {
  enable();
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  const log = createDiscoverTimingLogger('feed-events');
  const values = ['context;dur=12.5', 'context;dur=2', 'total;dur=20',
    'actor;dur=123', 'total;dur=private-token', 'session;dur=private-session',
    'media;dur=Infinity', 'page;dur=-2', 'write;dur=1;https://private.test',
    'dbmax;dur=9999999999999999'];
  for (let index = 0; index < 1000; index++) log(200, values);
  expect(info).toHaveBeenCalledTimes(64);
  expect(info.mock.calls[0]).toEqual(['[discover-timing]', JSON.stringify({
    route: 'feed-events', status: 200, metrics: {context: 14.5, total: 20},
  })]);
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/private|actor|https|Infinity/);
});

test('empty metrics or invalid status are ignored and logging failures cannot fail requests', () => {
  enable();
  const info = jest.spyOn(console, 'info').mockImplementation(() => { throw new Error('logger failed'); });
  const log = createDiscoverTimingLogger('feed');
  log(200, ['unknown;dur=1']);
  log(NaN, ['total;dur=1']);
  log(700, ['total;dur=1']);
  expect(info).not.toHaveBeenCalled();
  expect(() => log(200, ['total;dur=1'])).not.toThrow();
});

test('retains only numeric transport measurements inside the existing private log gate',()=>{
  enable();
  const info=jest.spyOn(console,'info').mockImplementation(()=>{});
  createDiscoverTimingLogger('feed-events')(200,[
    'dbtransportcount;dur=1','dbrequestcount;dur=1','dbsendcount;dur=1','dbresponsecount;dur=1',
    'dbprepare;dur=2','dbdispatch;dur=3','dbresponse;dur=100','dbresponsemax;dur=100','dbresume;dur=4',
    'dbresponse;dur=private-value',
  ]);
  expect(JSON.parse(info.mock.calls[0][1]).metrics).toEqual({
    dbtransportcount:1,dbrequestcount:1,dbsendcount:1,dbresponsecount:1,
    dbprepare:2,dbdispatch:3,dbresponse:100,dbresponsemax:100,dbresume:4,
  });
  expect(JSON.stringify(info.mock.calls)).not.toContain('private-value');
});
