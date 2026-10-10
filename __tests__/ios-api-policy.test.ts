import { mobileBearer, mobileOrigin, mobilePreflightHeaders } from '../lib/mobileApiPolicy';
describe('iPhone API origin and credential policy', () => {
  it('accepts only the exact locally packaged origin or explicitly configured loopback preview', () => {
    expect(mobileOrigin('capacitor://localhost')).toBe('capacitor://localhost');
    expect(mobileOrigin('http://127.0.0.1:5175', 'http://127.0.0.1:5175')).toBe('http://127.0.0.1:5175');
    for (const origin of [null, 'null', 'capacitor://localhost.evil.example', 'https://evil.example', 'http://localhost:5176']) expect(mobileOrigin(origin, 'http://127.0.0.1:5175')).toBeNull();
    expect(mobileOrigin('https://evil.example', 'https://evil.example')).toBeNull();
  });
  it('a supplied header must be exactly one bounded Bearer credential', () => {
    expect(mobileBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    for (const header of [null, 'Basic token', 'Bearer token extra', 'Bearer token\nCookie:x', 'Bearer ' + 'x'.repeat(8193)]) expect(mobileBearer(header)).toBeNull();
  });
  it('does not permit credentialed or arbitrary preflight headers', () => {
    expect(mobilePreflightHeaders('Authorization, Content-Type, X-CN-Discover-Actor')).toBe(true);
    expect(mobilePreflightHeaders('Cookie')).toBe(false);
    expect(mobilePreflightHeaders('X-Admin-Override')).toBe(false);
  });
});
