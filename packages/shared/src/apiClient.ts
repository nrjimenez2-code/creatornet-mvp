export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function apiDestination(base: string, path: string): URL {
  const origin = new URL(base);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('An explicit HTTPS API origin is required.');
  }
  if (!path.startsWith('/api/') || path.includes('\\') || /%2f|%5c|%2e/i.test(path) || path.split('?')[0].split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid API destination.');
  }
  const url = new URL(path, origin);
  if (url.origin !== origin.origin || url.hash || [...url.searchParams.keys()].some(key => /^(access_token|refresh_token|authorization)$/i.test(key))) {
    throw new Error('Invalid API destination.');
  }
  return url;
}

export type ApiIdentity = { userId: string; accessToken: string; generation?: number } | null;
export class AppApiClient {
  constructor(private readonly base: string, private readonly identity: () => Promise<ApiIdentity>, private readonly transport: typeof fetch = globalThis.fetch) {
    apiDestination(base, '/api/mobile/feed');
  }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = apiDestination(this.base, path);
    const actor = await this.identity();
    const headers = new Headers(init.headers);
    headers.delete('cookie');
    headers.delete('authorization');
    if (actor) headers.set('authorization', `Bearer ${actor.accessToken}`);
    // Cookies and redirects cannot transfer app sessions or silently change the recipient.
    // Mutations are never automatically retried: the existing operation owns its retry.
    const response = await this.transport(url.href, { ...init, headers, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const current = await this.identity();
    if ((actor?.userId ?? null) !== (current?.userId ?? null) || actor?.generation !== current?.generation) {
      await response.body?.cancel();
      throw new ApiError(409, 'Your account changed. Please try again.');
    }
    return response;
  }
  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw new ApiError(response.status, response.status === 401 ? 'Please sign in again.' : 'Could not complete this request. Please try again.');
    return response.json() as Promise<T>;
  }
}
