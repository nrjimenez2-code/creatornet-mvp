// lib/sameOrigin.ts — CSRF guard for routes that set or clear auth cookies.
//
// /auth/callback takes access/refresh tokens in a POST body and writes the
// session cookies. Without an origin check, any website can submit a form
// carrying the attacker's own tokens and log the visitor into the
// attacker's account on this domain. Browsers always send Origin on
// cross-site POSTs and on same-origin fetch() POSTs, so requiring it to
// match the request's own host costs nothing for the real caller
// (components/SupabaseAuthSync.tsx).

export function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  return o.host.toLowerCase() === host.toLowerCase();
}
