import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMockClient, type MockClient, type Op } from './__mocks__/supabaseQueryMock';

let db: MockClient;
let user: string | null;
let claimed: boolean;
let owner: string;
let expired: boolean;
let hidden: Set<string>;
let banned: boolean;
let claimAfterPage: boolean;
let authError: {name: string} | null;
const authRead = jest.fn();
const legacyFeed = jest.fn();
jest.mock('@/lib/supabaseAdmin', () => ({get supabaseAdmin() { return db; }}));
jest.mock('@/lib/supabaseServer', () => ({createServerClient: () => ({
  auth: {getUser: async () => {
    authRead();
    return {data: {user: user ? {id: user} : null}, error: authError};
  }},
  rpc: (...args: unknown[]) => legacyFeed(...args),
})}));
import { GET } from '@/app/api/feed/route';
import { discoverExistingPageIdentity, discoverIdentity, discoverEventIdentity } from '@/lib/discoverServer';

const anonymous = '11111111-1111-4111-8111-111111111111';
const otherAnonymous = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const creatorId = '44444444-4444-4444-8444-444444444444';
const posts = ['p1', 'p2', 'p3'].map((id, index) => ({
  id, creator_id: creatorId, title: 'Post '+id, created_at: '2026-01-01',
  video_url: 'https://media.example.test/private/'+id+'?signature=fixture',
  poster_url: 'https://media.example.test/'+id+'.jpg', likes_count: index+1,
  comments_count: 2, shares_count: 3, purchase_count: 4,
}));
const flags = ['DISCOVER_V4_ENABLED', 'DISCOVER_ANON_PAGE_ENABLED',
  'DISCOVER_VIEWER_STATE_PAGE_ENABLED',
  'DISCOVER_PAGE_INVENTORY_ENABLED', 'DISCOVER_COMPACT_PAGE_ENABLED',
  'DISCOVER_CREATE_PAGE_ENABLED', 'DISCOVER_EVENT_CONTEXT_ENABLED',
  'DISCOVER_BATCH_INVENTORY_ENABLED', 'DISCOVER_PILOT_ID', 'VERCEL',
  'SUPABASE_SERVICE_ROLE_KEY'] as const;
const savedEnv = Object.fromEntries(flags.map(key => [key, process.env[key]]));
const token = (id = anonymous) => id+'.'+createHmac('sha256', 'checked-page-test-key')
  .update('discover-actor:'+id).digest('hex');
const request = (params = 'session='+sessionId+'&limit=2',
  cookieToken: string | null = token(), headerToken?: string) => new NextRequest(
  'https://example.test/api/feed?'+params, {headers: {
    ...(cookieToken === null ? {} : {cookie: 'cn_discover_actor='+cookieToken}),
    ...(headerToken === undefined ? {} : {'x-cn-discover-actor': headerToken}),
  }});
function inventory(selected: string[]) {
  return {
    posts: posts.filter(post => selected.includes(post.id)).map(post => ({
      ...post, hidden_at: hidden.has(post.id) ? '2026-01-01' : null,
    })),
    profiles: [{id: creatorId, full_name: 'Public Creator', username: 'creator',
      avatar_url: 'https://media.example.test/avatar.jpg', banned_at: banned ? '2026-01-01' : null}],
    primaryProducts: [], legacyProducts: [], offerings: [],
  };
}
function page(offset: number, limit: number) {
  const selected = posts.slice(offset, offset+limit).map(post => post.id);
  return {page_post_ids: selected, total_count: posts.length,
    expires_at: expired ? '2000-01-01' : '2100-01-01', inventory: inventory(selected)};
}
function respond(op: Op): {data: any; error: any} {
  const args = op.payload as Record<string, any>;
  if (op.table === 'discover_user_compact_page_v1') {
    const original = respond({...op, table: 'discover_compact_page_v1'});
    if (original.error) return original;
    return {data: {...original.data, viewer_state: {user_id: args.p_user_id,
      liked_post_ids: original.data.page_post_ids.includes('p1') ? ['p1'] : [],
      followed_creator_ids: original.data.inventory.posts.length ? [creatorId] : []}}, error: null};
  }
  if (op.table === 'discover_identity_links_v1')
    return {data: claimed ? {anonymous_id: anonymous} : null, error: null};
  if (op.table === 'link_discover_identity_v1') return {data: true, error: null};
  if (['discover_anon_compact_page_v1','discover_compact_page_v1','discover_page_inventory_v1'].includes(op.table)) {
    const checked = op.table === 'discover_anon_compact_page_v1';
    const actor = checked ? 'anon:'+args.p_anonymous : args.p_actor;
    if ((checked && claimed) || actor !== owner || args.p_session !== sessionId || expired)
      return {data: null, error: {code: 'CN001'}};
    const result = page(args.p_offset, args.p_limit);
    if (checked && claimAfterPage) claimed = true;
    return {data: checked ? {anonymousClaimChecked: true, page: result} :
      op.table === 'discover_page_inventory_v1' ? {...result, post_ids: posts.map(post => post.id)} : result, error: null};
  }
  if (op.table === 'discover_create_compact_page_v1')
    return {data: {id: sessionId, page: page(args.p_offset, args.p_limit)}, error: null};
  if (op.table === 'discover_sessions_v1') return {data: op.filters.actor === owner && !expired
    ? {post_ids: posts.map(post => post.id), expires_at: '2100-01-01'} : null, error: null};
  if (op.table === 'posts') return {data: inventory(op.inFilters[0]?.values as string[] ?? posts.map(post => post.id)).posts, error: null};
  if (op.table === 'profiles') return {data: inventory([]).profiles, error: null};
  if (op.table === 'likes') return {data: [{post_id: 'p1'}], error: null};
  if (op.table === 'follows') return {data: [{following_id: creatorId}], error: null};
  return {data: [], error: null};
}
function useDatabase(responder = respond) {
  db = createMockClient(responder);
  const from = db.from;
  db.from = table => {
    const source = from(table);
    return {...source, select: (columns: string) => {
      const query = source.select(columns);
      query.gte = () => query;
      query.gt = () => query;
      return query;
    }};
  };
}
let log: jest.SpyInstance;
beforeEach(() => {
  for (const key of flags) delete process.env[key];
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'checked-page-test-key';
  for (const key of ['DISCOVER_V4_ENABLED','DISCOVER_ANON_PAGE_ENABLED',
    'DISCOVER_PAGE_INVENTORY_ENABLED','DISCOVER_COMPACT_PAGE_ENABLED']) process.env[key] = 'true';
  user = null; claimed = false; owner = 'anon:'+anonymous; expired = false;
  hidden = new Set(); banned = false; claimAfterPage = false; authError = null;
  authRead.mockClear(); legacyFeed.mockReset().mockResolvedValue({data: [], error: null});
  useDatabase();
  log = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); });
afterAll(() => {
  for (const key of flags) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test('verified token becomes a page-only candidate without an actor or a stale claim lookup', async () => {
  expect(await discoverExistingPageIdentity(request())).toEqual({
    anonymousPageCandidate: true, anonymousId: anonymous, token: token(),
  });
  expect(authRead).toHaveBeenCalledTimes(1);
  expect(db.ops).toHaveLength(0);
});

test.each([null, 'malformed', anonymous+'.'+'0'.repeat(64)])('missing or forged token cannot become a candidate (%s)', async value => {
  const identity = await discoverExistingPageIdentity(request(undefined, value));
  expect(identity).not.toHaveProperty('anonymousPageCandidate');
  expect(identity).toHaveProperty('newAnonymous', true);
  expect(identity).not.toHaveProperty('actor', 'anon:'+anonymous);
  const response = await GET(request(undefined, value));
  expect(response.status).toBe(410);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.opsFor('discover_anon_compact_page_v1')).toHaveLength(0);
});

test('header precedence and Auth verification remain authoritative', async () => {
  expect(await discoverExistingPageIdentity(request(undefined, token(otherAnonymous), token())))
    .toHaveProperty('anonymousId', anonymous);
  const invalidHeader = await discoverExistingPageIdentity(request(undefined, token(), 'forged'));
  expect(invalidHeader).not.toHaveProperty('anonymousPageCandidate');
  authError = {name: 'AuthRetryableFetchError'};
  const failure = await GET(request());
  expect(failure.status).toBe(503);
  expect(db.ops).toHaveLength(0);
  authError = {name: 'AuthSessionMissingError'};
  expect((await GET(request())).status).toBe(200);
});

test.each([undefined, 'false'])('absent/disabled flag retains a fresh identity read (%s)', async flag => {
  if (flag === undefined) delete process.env.DISCOVER_ANON_PAGE_ENABLED;
  else process.env.DISCOVER_ANON_PAGE_ENABLED = flag;
  expect((await GET(request())).status).toBe(200);
  expect(db.ops.map(op => op.table)).toEqual(['discover_identity_links_v1', 'discover_compact_page_v1']);
});

test.each(['DISCOVER_PAGE_INVENTORY_ENABLED','DISCOVER_COMPACT_PAGE_ENABLED'])('missing dependency %s retains the checked old path', async flag => {
  delete process.env[flag];
  expect(await discoverExistingPageIdentity(request())).not.toHaveProperty('anonymousPageCandidate');
  expect((await GET(request())).status).toBe(200);
  expect(db.opsFor('discover_identity_links_v1')).toHaveLength(2);
  expect(db.opsFor('discover_anon_compact_page_v1')).toHaveLength(0);
});

test('disabled Discover still uses the original legacy route without Auth or candidate resolution', async () => {
  delete process.env.DISCOVER_V4_ENABLED;
  expect((await GET(request())).status).toBe(200);
  expect(authRead).not.toHaveBeenCalled();
  expect(legacyFeed).toHaveBeenCalledWith('get_feed_v3', {p_tab: 'discover', p_limit: 2, p_offset: 0});
  expect(db.ops).toHaveLength(0);
});

test('ordinary anonymous page has wire parity while removing exactly the separate claim request', async () => {
  delete process.env.DISCOVER_ANON_PAGE_ENABLED;
  const oldResponse = await GET(request());
  const oldBody = await oldResponse.json();
  expect(db.ops.map(op => op.table)).toEqual(['discover_identity_links_v1', 'discover_compact_page_v1']);
  useDatabase(); process.env.DISCOVER_ANON_PAGE_ENABLED = 'true';
  const response = await GET(request());
  expect(await response.json()).toEqual(oldBody);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.ops).toHaveLength(1);
  expect(db.ops[0]).toMatchObject({table: 'discover_anon_compact_page_v1', payload: {
    p_session: sessionId, p_anonymous: anonymous, p_offset: 0, p_limit: 2,
  }});
  expect(oldBody.actorToken).toBe(token());
  expect(oldBody.items[0]).toMatchObject({video_url: posts[0].video_url,
    creator_name: 'Public Creator', creator_avatar_url: 'https://media.example.test/avatar.jpg',
    likes_count: 1, comments_count: 2, is_liked: false, is_following: false});
  expect(oldBody.nextOffset).toBe(2); expect(oldBody.hasMore).toBe(true);
});

test('claimed token returns 410 without replacement credentials; a later fresh session rotates normally', async () => {
  claimed = true;
  const unavailable = await GET(request());
  expect(unavailable.status).toBe(410);
  expect(await unavailable.json()).toEqual({error: 'This feed needs to be refreshed.', code: 'DISCOVER_SESSION_UNAVAILABLE'});
  expect(unavailable.headers.get('set-cookie')).toBeNull();
  expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
  expect(db.opsFor('discover_identity_links_v1')).toHaveLength(0);
  process.env.DISCOVER_CREATE_PAGE_ENABLED = 'true';
  const refreshed = await GET(request('limit=2'));
  const body = await refreshed.json();
  expect(refreshed.status).toBe(200);
  expect(body.actorToken).not.toBe(token());
  expect(body.actorToken).toMatch(/^[a-f0-9-]{36}\.[a-f0-9]{64}$/);
  expect(refreshed.headers.get('set-cookie')).toContain('cn_discover_actor='+body.actorToken);
  expect(refreshed.headers.get('set-cookie')).toMatch(/HttpOnly/i);
  expect(refreshed.headers.get('set-cookie')).toMatch(/SameSite=lax/i);
  expect(refreshed.headers.get('set-cookie')).toContain('Max-Age=7776000');
  expect(db.opsFor('discover_identity_links_v1')).toHaveLength(1);
  expect(db.opsFor('discover_anon_compact_page_v1')).toHaveLength(1);
  expect(db.opsFor('discover_create_compact_page_v1')).toHaveLength(1);
});

test('sessionless identity and event identity retain their independent fresh checks with the page flag enabled', async () => {
  claimed = true;
  const identity = await discoverExistingPageIdentity(request(''));
  expect(identity).toHaveProperty('newAnonymous', true);
  expect(identity).not.toHaveProperty('anonymousPageCandidate');
  expect(await discoverIdentity(request())).toHaveProperty('newAnonymous', true);
  expect(await discoverEventIdentity(request())).toMatchObject({anonymousClaimCheck: 'complete'});
  expect(db.opsFor('discover_identity_links_v1')).toHaveLength(3);
  expect(db.opsFor('discover_anon_compact_page_v1')).toHaveLength(0);
});

test('signed-in account claim, ownership, likes and follows still use the ordinary page path', async () => {
  user = 'viewer'; owner = 'user:viewer';
  const response = await GET(request());
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.actorToken).toBeNull();
  expect(body.items[0]).toMatchObject({is_liked: true, is_following: true});
  expect(db.ops.map(op => op.table)).toEqual(['link_discover_identity_v1', 'discover_compact_page_v1', 'likes', 'follows']);
  expect(db.ops[0].payload).toEqual({p_anonymous: anonymous, p_user: 'viewer'});
  expect(db.ops[1].payload).toMatchObject({p_actor: 'user:viewer'});
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('signed-in batch retains wire parity, verified identity and private caching with one page RPC', async () => {
  user = 'viewer'; owner = 'user:viewer';
  const original = await (await GET(request())).json();
  useDatabase(); process.env.DISCOVER_VIEWER_STATE_PAGE_ENABLED = 'true';
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(original);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(authRead).toHaveBeenCalledTimes(2);
  expect(db.ops.map(op => op.table)).toEqual(['link_discover_identity_v1', 'discover_user_compact_page_v1']);
  expect(db.ops[1].payload).toMatchObject({p_user_id: 'viewer', p_actor: 'user:viewer'});
});

test.each(['missing', 'foreign-user', 'foreign-like', 'foreign-follow', 'duplicate', 'extra-key'])
('malformed private state (%s) fails closed without separate reads or fallback', async reason => {
  user = 'viewer'; owner = 'user:viewer'; process.env.DISCOVER_VIEWER_STATE_PAGE_ENABLED = 'true';
  useDatabase(op => {
    const result = respond(op);
    if (op.table === 'discover_user_compact_page_v1') {
      const state = result.data.viewer_state;
      if (reason === 'missing') delete result.data.viewer_state;
      if (reason === 'foreign-user') state.user_id = 'other';
      if (reason === 'foreign-like') state.liked_post_ids = ['outside-page'];
      if (reason === 'foreign-follow') state.followed_creator_ids = ['other-creator'];
      if (reason === 'duplicate') state.liked_post_ids = ['p1', 'p1'];
      if (reason === 'extra-key') state.private_extra = 'secret';
    }
    return result;
  });
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(db.ops.map(op => op.table)).toEqual(['link_discover_identity_v1', 'discover_user_compact_page_v1']);
});

test.each(['PGRST202', '42501', '57014', 'CN001'])('private page RPC error %s never falls back', async code => {
  user = 'viewer'; owner = 'user:viewer'; process.env.DISCOVER_VIEWER_STATE_PAGE_ENABLED = 'true';
  useDatabase(op => op.table === 'discover_user_compact_page_v1' ? {data: null, error: {code}} : respond(op));
  expect((await GET(request())).status).toBe(code === 'CN001' ? 410 : 503);
  expect(db.ops.map(op => op.table)).toEqual(['link_discover_identity_v1', 'discover_user_compact_page_v1']);
});

test('private page uses verified Auth identity and ignores caller-supplied viewer IDs', async () => {
  user = 'viewer'; owner = 'user:viewer'; process.env.DISCOVER_VIEWER_STATE_PAGE_ENABLED = 'true';
  expect((await GET(request('session='+sessionId+'&user_id=other&actor=user:other',null))).status).toBe(200);
  expect(db.opsFor('discover_user_compact_page_v1')[0].payload).toMatchObject({p_user_id:'viewer',p_actor:'user:viewer'});
  useDatabase(); authError = {name:'AuthRetryableFetchError'};
  expect((await GET(request())).status).toBe(503);
  expect(db.ops).toHaveLength(0);
});

test('private page flag does not change anonymous reads or bypass current moderation', async () => {
  process.env.DISCOVER_VIEWER_STATE_PAGE_ENABLED = 'true';
  expect((await GET(request())).status).toBe(200);
  expect(db.ops.map(op => op.table)).toEqual(['discover_anon_compact_page_v1']);
  user = 'viewer'; owner = 'user:viewer'; hidden = new Set(['p1', 'p2']);
  useDatabase();
  const body = await (await GET(request())).json();
  expect(body.items.map((p: any) => p.post_id)).toEqual(['p3']);
  expect(body.nextOffset).toBe(3); expect(body.hasMore).toBe(false);
  expect(db.opsFor('discover_user_compact_page_v1')).toHaveLength(2);
  banned = true; useDatabase();
  expect((await (await GET(request())).json()).items).toEqual([]);
});

test.each(['DISCOVER_COMPACT_PAGE_ENABLED', 'DISCOVER_PAGE_INVENTORY_ENABLED'])
('private page flag retains old path without dependency %s', async dependency => {
  user = 'viewer'; owner = 'user:viewer'; process.env.DISCOVER_VIEWER_STATE_PAGE_ENABLED = 'true';
  delete process.env[dependency];
  expect((await GET(request())).status).toBe(200);
  expect(db.opsFor('discover_user_compact_page_v1')).toHaveLength(0);
  expect(db.opsFor('likes')).toHaveLength(1); expect(db.opsFor('follows')).toHaveLength(1);
});

test.each(['wrong-owner', 'missing', 'expired', 'claimed'])('unavailable %s page has the same non-disclosing 410', async reason => {
  if (reason === 'wrong-owner') owner = 'anon:'+otherAnonymous;
  if (reason === 'expired') expired = true;
  if (reason === 'claimed') claimed = true;
  const response = await GET(request('session='+(reason === 'missing' ? otherAnonymous : sessionId)+'&limit=2'));
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({error: 'This feed needs to be refreshed.', code: 'DISCOVER_SESSION_UNAVAILABLE'});
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.ops).toHaveLength(1);
});

test.each(['PGRST202', '42501', '57014'])('checked RPC failure %s never falls back or returns data', async code => {
  useDatabase(op => op.table === 'discover_anon_compact_page_v1' ? {data: null, error: {code}} : respond(op));
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty('items');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.ops.map(op => op.table)).toEqual(['discover_anon_compact_page_v1']);
});

test.each([
  ['missing marker', (data: any) => {delete data.anonymousClaimChecked;}],
  ['false marker', (data: any) => {data.anonymousClaimChecked = false;}],
  ['string marker', (data: any) => {data.anonymousClaimChecked = 'true';}],
  ['missing page', (data: any) => {delete data.page;}],
  ['legacy page', (data: any) => {delete data.page.page_post_ids; data.page.post_ids = ['p1','p2','p3'];}],
  ['missing inventory', (data: any) => {delete data.page.inventory;}],
  ['missing inventory array', (data: any) => {delete data.page.inventory.profiles;}],
  ['null inventory row', (data: any) => {data.page.inventory.posts = [null];}],
  ['bad expiry', (data: any) => {data.page.expires_at = 'invalid';}],
  ['negative total', (data: any) => {data.page.total_count = -1;}],
  ['fractional total', (data: any) => {data.page.total_count = 1.5;}],
  ['duplicate IDs', (data: any) => {data.page.page_post_ids = ['p1','p1'];}],
  ['short page', (data: any) => {data.page.page_post_ids = [];}],
] as const)('malformed %s fails closed without unchecked inventory or pagination', async (_name, corrupt) => {
  useDatabase(op => {
    const result = respond(op);
    if (op.table === 'discover_anon_compact_page_v1') corrupt(result.data);
    return result;
  });
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty('items');
  expect(db.ops.map(op => op.table)).toEqual(['discover_anon_compact_page_v1']);
});

test('all-hidden pages keep the fresh checked loader and preserve later cursor and moderation', async () => {
  hidden = new Set(['p1','p2']);
  const response = await GET(request());
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.items.map((item: {post_id: string}) => item.post_id)).toEqual(['p3']);
  expect(body.nextOffset).toBe(3); expect(body.hasMore).toBe(false);
  expect(db.ops.map(op => op.table)).toEqual(['discover_anon_compact_page_v1', 'discover_anon_compact_page_v1']);
  expect(db.ops.map(op => (op.payload as any).p_offset)).toEqual([0,2]);
  banned = true; useDatabase();
  expect((await (await GET(request())).json()).items).toEqual([]);
  expect(db.ops).toHaveLength(2);
});

test('claim becoming visible before a hidden-page retry blocks the whole response', async () => {
  hidden = new Set(['p1','p2']); claimAfterPage = true;
  const response = await GET(request());
  expect(response.status).toBe(410);
  expect(await response.json()).not.toHaveProperty('items');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.ops.map(op => op.table)).toEqual(['discover_anon_compact_page_v1', 'discover_anon_compact_page_v1']);
});

test.each(['offset=-1','offset=NaN','offset=1.2','limit=0','limit=51'])('invalid bounds %s fail before any identity or DB work', async bounds => {
  expect((await GET(request('session='+sessionId+'&'+bounds))).status).toBe(400);
  expect(authRead).not.toHaveBeenCalled(); expect(db.ops).toHaveLength(0);
});
