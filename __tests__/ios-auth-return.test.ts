import { GET } from '../app/app/auth/callback/route';
const state = '11111111-1111-4111-8111-111111111111';
it('the hosted auth fallback passes only a PKCE code/state to the known app scheme, without changing browser sessions', async () => {
  const response = await GET(new Request('https://www.creatornet.net/app/auth/callback?code=fixture-code&cn_state=' + state));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('creatornet://auth/callback?cn_state=' + state + '&amp;code=fixture-code');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.has('set-cookie')).toBe(false);
});
it.each(['?access_token=secret&refresh_token=secret', '?code=fixture&cn_state=' + state + '&redirect=https://evil.example', '?code=%22%3E%3Cscript%3E&cn_state=' + state])('rejects token/arbitrary destination/injection attempts: %s', async query => {
  const response = await GET(new Request('https://www.creatornet.net/app/auth/callback' + query));
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('secret');
});
