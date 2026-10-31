import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { blankPublicPage, featureOpen, isLegalPage, routePolicy } from "@/lib/release/policy";
import { hasPrivateAccess, hasOwnedContinuation, loadReleaseSettings, verifiedIdentity } from "@/lib/release/server";
import { publicHoldingHtml } from "@/lib/release/launch";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", Vary: "Cookie, Authorization" };
export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (req.headers.has("next-action")) return NextResponse.json({ error: "Server actions are unavailable during controlled release." }, { status: 403, headers: privateHeaders });
  if (path.startsWith("/_next/static/") || path === "/_next/image" || ["/favicon.ico", "/creatornet-icon-192.png", "/apple-touch-icon.png"].includes(path)) return NextResponse.next();
  const policy = routePolicy(path, req.method);
  const responseCookies: Array<{ name: string; value: string; options?: CookieOptions }> = [];
  const finish = (response: NextResponse) => {
    Object.entries(privateHeaders).forEach(([key, value]) => response.headers.set(key, value));
    responseCookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
    return response;
  };
  const next = () => {
    // Overwrite untrusted client markers on every request.
    const headers = new Headers(req.headers);
    headers.set("x-creatornet-public-shell", ["public", "purchase", "continuation"].includes(policy.kind) ? "1" : "0");
    return finish(NextResponse.next({ request: { headers } }));
  };
  // Exact operation exceptions retain their handler's signature/cron/token checks.
  const legalPage = policy.kind === "public" && isLegalPage(path);
  if (policy.kind === "operation" || (policy.kind === "public" && !legalPage)) return next();
  if (["/sitemap.xml", "/robots.txt"].includes(path)) return next();
  const settings = await loadReleaseSettings();
  let user = null;
  try { user = await getAuthenticatedUser(req, { onCookie: (name, value, options) => { req.cookies.set(name, value); responseCookies.push({ name, value, options }); } }); } catch { /* deny */ }
  // Preserve policies/support for signed-in accounts and existing buyers, while
  // anonymous direct links reveal no legal/product copy in the temporary mode.
  if (legalPage && (!blankPublicPage(settings) || verifiedIdentity(user))) return next();
  if (policy.kind === "purchase" && verifiedIdentity(user)) return next();
  if (policy.kind === "continuation" && await hasOwnedContinuation(req, user)) return next();
  const privateAccess = await hasPrivateAccess(user, settings);
  if (policy.kind === "owner") {
    if (privateAccess && user?.id === settings?.owner_id) return next();
  } else if (privateAccess || featureOpen(settings, policy.feature ?? null)) {
    if (req.headers.has("next-action")) return finish(NextResponse.json({ error: "Server actions are unavailable during controlled release." }, { status: 403 }));
    return next();
  }
  if (path.startsWith("/api/") || !["GET", "HEAD"].includes(req.method) || req.headers.has("next-action")) {
    return finish(NextResponse.json({ error: "Private access required." }, { status: user ? 403 : 401 }));
  }
  // Restricted page code and its product-data requests never execute.
  return finish(new NextResponse(req.method === "HEAD" ? null : publicHoldingHtml(settings), { headers: { "Content-Type": "text/html; charset=utf-8" } }));
}
export const config = { matcher: ["/:path*"] };
