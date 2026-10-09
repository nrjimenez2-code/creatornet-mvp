import { NextRequest } from 'next/server';

const verifyUser = jest.fn();
const readProfile = jest.fn();
const websiteTag = jest.fn(async (request: NextRequest, _context: unknown) => Response.json({ cookie: request.headers.get('cookie') }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { getUser: verifyUser } }) }));
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: readProfile }) }) }) } }));
jest.mock('@/lib/rateLimit', () => ({ allowRequest: () => true, clientKey: () => 'fixture-ip' }));
jest.mock('@/app/api/tag/[hashtag]/route', () => ({ GET: (request: NextRequest, context: unknown) => websiteTag(request, context) }));

import { GET, OPTIONS } from '@/app/api/mobile/tag/[hashtag]/route';

const context = { params: Promise.resolve({ hashtag: 'trading' }) };
const userId = '11111111-1111-4111-8111-111111111111';
function request(options: { origin?: string; auth?: string; cookie?: string; method?: string; preflight?: boolean } = {}) {
  const headers = new Headers({ Origin: options.origin ?? 'capacitor://localhost' });
  if (options.auth) headers.set('Authorization', options.auth);
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.preflight) headers.set('Access-Control-Request-Method', 'GET');
  return new NextRequest('https://www.creatornet.net/api/mobile/tag/trading', { method: options.method ?? 'GET', headers });
}
beforeEach(() => {
  process.env.CREATORNET_IOS_API_ENABLED = 'true';
  websiteTag.mockClear(); verifyUser.mockReset(); readProfile.mockReset();
  verifyUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  readProfile.mockResolvedValue({ data: { id: userId, banned_at: null }, error: null });
});
afterEach(() => { delete process.env.CREATORNET_IOS_API_ENABLED; });

test('mobile tag preserves anonymous public browsing without forwarding website cookies', async () => {
  const response = await GET(request({ cookie: 'sb-session=website' }), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ cookie: null });
  expect(response.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
  expect(websiteTag).toHaveBeenCalledWith(expect.any(NextRequest), context);
  expect(verifyUser).not.toHaveBeenCalled();
});

test('mobile tag verifies signed-in accounts and denies banned or invalid-origin requests', async () => {
  expect((await GET(request({ auth: 'Bearer fixture' }), context)).status).toBe(200);
  expect(verifyUser).toHaveBeenCalledWith('fixture');
  expect(websiteTag).toHaveBeenCalledTimes(1);
  readProfile.mockResolvedValueOnce({ data: { id: userId, banned_at: '2026-10-09' }, error: null });
  expect((await GET(request({ auth: 'Bearer fixture' }), context)).status).toBe(403);
  expect((await GET(request({ origin: 'https://evil.example' }), context)).status).toBe(403);
  expect(websiteTag).toHaveBeenCalledTimes(1);
});

test('mobile tag allows only GET preflight', async () => {
  expect((await OPTIONS(request({ method: 'OPTIONS', preflight: true }), context)).status).toBe(204);
  expect((await GET(request({ method: 'POST' }), context)).status).toBe(405);
  expect(websiteTag).not.toHaveBeenCalled();
});
