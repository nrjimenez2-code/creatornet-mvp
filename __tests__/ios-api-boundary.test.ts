import { NextRequest } from 'next/server';
const verifyUser = jest.fn();
const readProfile = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { getUser: verifyUser } }) }));
jest.mock('../lib/supabaseAdmin', () => ({ supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: readProfile }) }) }) } }));
jest.mock('../lib/rateLimit', () => ({ allowRequest: () => true, clientKey: () => 'fixture-ip' }));
import { mobileApi } from '../lib/mobileApi';
const userId = '11111111-1111-4111-8111-111111111111';
function request(options: { origin?: string; auth?: string; cookie?: string; method?: string; body?: string } = {}) {
  const headers = new Headers({ Origin: options.origin ?? 'capacitor://localhost' });
  if (options.auth) headers.set('Authorization', options.auth);
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.body) headers.set('Content-Type', 'application/json');
  return new NextRequest('https://www.creatornet.net/api/mobile/profile/me', { method: options.method ?? 'GET', headers, body: options.body });
}
beforeEach(() => {
  process.env.CREATORNET_IOS_API_ENABLED = 'true';
  verifyUser.mockReset(); readProfile.mockReset();
  verifyUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
  readProfile.mockResolvedValue({ data: { id: userId, banned_at: null }, error: null });
});
afterEach(() => { delete process.env.CREATORNET_IOS_API_ENABLED; });
describe('iPhone API authentication boundary', () => {
  it('does not enable the new surface by default', async () => {
    delete process.env.CREATORNET_IOS_API_ENABLED;
    const handler = jest.fn(async () => Response.json({ ok: true }));
    expect((await mobileApi(handler, ['GET'])(request({ auth: 'Bearer fixture' }))).status).toBe(503);
    expect(handler).not.toHaveBeenCalled(); expect(verifyUser).not.toHaveBeenCalled();
  });
  it('does not let an authorization header alone bypass the origin guard', async () => {
    const handler = jest.fn(async () => Response.json({ ok: true }));
    expect((await mobileApi(handler, ['GET'])(request({ auth: 'Bearer fixture', origin: 'https://evil.example' }))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled(); expect(verifyUser).not.toHaveBeenCalled();
  });
  it.each(['Basic attacker', 'Bearer invalid credential'])('rejects malformed credentials without browser fallback: %s', async auth => {
    const handler = jest.fn(async () => Response.json({ ok: true }));
    expect((await mobileApi(handler, ['GET'])(request({ auth, cookie: 'sb-session=fixture' }))).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
  it('verifies the credential, fails closed for deleted/banned accounts and never calls the protected handler', async () => {
    const handler = jest.fn(async () => Response.json({ ok: true }));
    for (const [profile, status] of [[null, 401], [{ id: userId, banned_at: '2026-10-06' }, 403]] as const) {
      readProfile.mockResolvedValueOnce({ data: profile, error: null });
      expect((await mobileApi(handler, ['GET'])(request({ auth: 'Bearer fixture' }))).status).toBe(status);
    }
    expect(verifyUser).toHaveBeenCalledWith('fixture'); expect(handler).not.toHaveBeenCalled();
  });
  it('does not forward cookies or return website session cookies, and scopes CORS to the validated origin', async () => {
    const handler = jest.fn(async (req: NextRequest) => { expect(req.headers.has('cookie')).toBe(false); return new Response('ok', { headers: { 'Set-Cookie': 'sb-session=fixture' } }); });
    const result = await mobileApi(handler, ['GET'])(request({ auth: 'Bearer fixture', cookie: 'sb-session=fixture' }));
    expect(result.status).toBe(200); expect(result.headers.has('set-cookie')).toBe(false);
    expect(result.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    expect(result.headers.has('access-control-allow-credentials')).toBe(false);
  });
  it('rejects an invalid verified token and oversized JSON before any action executes', async () => {
    const handler = jest.fn(async () => Response.json({ ok: true }));
    verifyUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'invalid' } });
    expect((await mobileApi(handler, ['POST'])(request({ auth: 'Bearer fixture', method: 'POST', body: '{}' }))).status).toBe(401);
    expect((await mobileApi(handler, ['POST'])(request({ auth: 'Bearer fixture', method: 'POST', body: JSON.stringify({ large: 'x'.repeat(70_000) }) }))).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });
});
