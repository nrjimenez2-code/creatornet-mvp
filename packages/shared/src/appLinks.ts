export type AppLink = { kind: 'auth'; code: string | null; state: string; cancelled: boolean } | { kind: 'route'; path: string } | { kind: 'commerce'; context: string };
const safeRoutes = [
  /^\/dashboard$/, /^\/search$/, /^\/profile(?:\/edit)?$/, /^\/onboarding$/, /^\/notifications$/,
  /^\/creators\/[a-zA-Z0-9._-]+(?:\/reviews)?$/, /^\/watch\/[a-f0-9-]{36}$/,
  /^\/library(?:\/[a-f0-9-]{36}(?:\/[a-f0-9-]{36})?)?$/, /^\/calls$/, /^\/memberships$/,
  /^\/payments$/, /^\/dashboard\/(?:closers|earnings|analytics)$/, /^\/admin(?:\/(?:users|content|reviews|commerce)(?:\/installments)?)?$/,
  /^\/legal\/(?:terms|privacy|support|refunds|delivery|creators|cookies|purchase-agreement)$/,
];
export function allowedAppPath(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value) || /%2f|%5c|%2e/i.test(value) || value.split('?')[0].split('/').some(part => part === '.' || part === '..')) return null;
  let url: URL;
  try { url = new URL(value, 'https://app.invalid'); } catch { return null; }
  if (url.origin !== 'https://app.invalid' || !safeRoutes.some(pattern => pattern.test(url.pathname))) return null;
  const query = new URLSearchParams();
  for (const key of ['postId', 'tab', 'q', 'feedDebug', 'feedBridge']) {
    const item = url.searchParams.get(key);
    if (item && item.length <= 200) query.set(key, item);
  }
  return url.pathname + (query.size ? '?' + query : '');
}
export function parseAppLink(value: string, websiteOrigin: string): AppLink | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.hash || value.includes('\\')) return null;
  let route: string;
  if (url.protocol === 'creatornet:' && ['auth', 'return', 'open'].includes(url.hostname)) route = '/' + url.hostname + url.pathname;
  else if (url.protocol === 'https:' && url.origin === new URL(websiteOrigin).origin && url.pathname.startsWith('/app/')) route = url.pathname.slice(4);
  else return null;
  if (route === '/auth/callback') {
    const state = url.searchParams.get('cn_state') ?? '';
    const code = url.searchParams.get('code');
    if (!/^[a-f0-9-]{36}$/.test(state) || (code && !/^[a-zA-Z0-9_-]{1,512}$/.test(code))) return null;
    if ([...url.searchParams.keys()].some(key => !['code', 'cn_state', 'error', 'error_code', 'error_description'].includes(key))) return null;
    return { kind: 'auth', state, code, cancelled: url.searchParams.has('error') || !code };
  }
  if (route === '/return') {
    const context = url.searchParams.get('context') ?? '';
    return /^[a-f0-9-]{36}$/.test(context) && url.searchParams.size === 1 ? { kind: 'commerce', context } : null;
  }
  if (route === '/open') {
    const path = allowedAppPath(url.searchParams.get('path') ?? '');
    return path && url.searchParams.size === 1 ? { kind: 'route', path } : null;
  }
  return null;
}
