import { allowedAppPath, parseAppLink } from '../packages/shared/src/appLinks';
const site = 'https://www.creatornet.net';
const state = '11111111-1111-4111-8111-111111111111';
describe('iPhone incoming links', () => {
  it('accepts a PKCE code with a matching-shaped state on the configured universal link and custom fallback', () => {
    for (const prefix of [site + '/app/auth/callback', 'creatornet://auth/callback']) {
      expect(parseAppLink(prefix + '?code=one-use-code&cn_state=' + state, site)).toEqual({ kind: 'auth', code: 'one-use-code', state, cancelled: false });
    }
  });
  it.each([site + '.evil.example/app/open?path=%2Fprofile', 'https://evil.example/app/open?path=%2Fprofile', 'creatornet://auth/callback#access_token=secret', 'creatornet://auth/callback?code=x&cn_state=' + state + '&refresh_token=secret', 'creatornet://open?path=https%3A%2F%2Fevil.example', 'creatornet://return?context=' + state + '&paid=true'])('rejects an untrusted or token-bearing link %s', value => expect(parseAppLink(value, site)).toBeNull());
  it('requires an opaque return context and never treats a claimed payment result as authority', () => {
    expect(parseAppLink(site + '/app/return?context=' + state, site)).toEqual({ kind: 'commerce', context: state });
    expect(parseAppLink(site + '/app/return?success=true', site)).toBeNull();
  });
  it('allowlists routes, removes unknown query values, and keeps protected destinations for server reauthorization', () => {
    expect(allowedAppPath('/profile?access_token=secret')).toBe('/profile');
    expect(allowedAppPath('/admin/commerce')).toBe('/admin/commerce');
    for (const path of ['//evil.example', '/api/admin/refunds', '/profile/../admin', '/profile%2fedit', '/profile\\edit']) expect(allowedAppPath(path)).toBeNull();
  });
});
