export function mobileOrigin(origin: string | null, developmentOrigin?: string): string | null {
  if (origin === 'capacitor://localhost') return origin;
  if (!origin || !developmentOrigin || origin !== developmentOrigin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== origin) return null;
    return origin;
  } catch { return null; }
}
export function mobileBearer(header: string | null): string | null {
  return header?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/)?.[1] ?? null;
}
export function mobilePreflightHeaders(value: string): boolean {
  return value.split(',').map(header => header.trim().toLowerCase()).filter(Boolean).every(header => ['authorization', 'content-type', 'x-cn-discover-actor'].includes(header));
}
