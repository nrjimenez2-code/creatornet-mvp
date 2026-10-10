import { apiDestination, AppApiClient } from '../packages/shared/src/apiClient';
describe('iPhone API transport', () => {
  it.each(['//evil.example/api/steal', '/api/../outside', '/api/%2e%2e/private', '/api/x?access_token=secret', '/api/x#access_token=secret', '/api\\evil'])('rejects an unsafe destination %s', path => {
    expect(() => apiDestination('https://www.creatornet.net', path)).toThrow();
  });
  it('sends a verified session credential only to the explicit API origin and never follows redirects or sends cookies', async () => {
    const transport = jest.fn(async () => Response.json({ ok: true }));
    const client = new AppApiClient('https://www.creatornet.net', async () => ({ userId: 'buyer', accessToken: 'fixture-token' }), transport);
    await client.request('/api/mobile/feed', { headers: { Authorization: 'Bearer attacker', Cookie: 'browser=fixture' } });
    const [url, request] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.creatornet.net/api/mobile/feed');
    expect(request.credentials).toBe('omit'); expect(request.redirect).toBe('error');
    const headers = new Headers(request.headers);
    expect(headers.get('authorization')).toBe('Bearer fixture-token'); expect(headers.has('cookie')).toBe(false);
  });
  it('discards a response belonging to an account that was switched during the request', async () => {
    let actor = 'buyer-a';
    const transport = jest.fn(async () => { actor = 'buyer-b'; return Response.json({ private: true }); });
    const client = new AppApiClient('https://www.creatornet.net', async () => ({ userId: actor, accessToken: 'fixture-token' }), transport);
    await expect(client.request('/api/mobile/profile/me')).rejects.toMatchObject({ status: 409 });
  });
  it('never retries a financial mutation or forwards caller authentication when signed out', async () => {
    const transport = jest.fn(async () => new Response(null, { status: 401 }));
    const client = new AppApiClient('https://www.creatornet.net', async () => null, transport);
    const result = await client.request('/api/mobile/operation', { method: 'POST', headers: { Authorization: 'Bearer caller' } });
    expect(result.status).toBe(401); expect(transport).toHaveBeenCalledTimes(1);
    const request = (transport.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(new Headers(request.headers).has('authorization')).toBe(false);
  });
  it('also discards an old response after signing out and back into the same account', async () => {
    let generation = 1;
    const transport = jest.fn(async () => { generation = 3; return Response.json({ private: true }); });
    const client = new AppApiClient('https://www.creatornet.net', async () => ({ userId: 'buyer', accessToken: 'fixture-token', generation }), transport);
    await expect(client.request('/api/mobile/profile/me')).rejects.toMatchObject({ status: 409 });
  });
});
