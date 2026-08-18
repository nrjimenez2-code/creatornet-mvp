// proxy.ts (project root)
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Routes that require a signed-in user.
 *
 * Matched EXACTLY, not by prefix. That matters: `/profile/:username` is a
 * PUBLIC creator profile (see app/profile/[username]/page.tsx, which simply
 * redirects to /creators/:username, a page that renders fine for logged-out
 * visitors). A `startsWith("/profile")` check swallows it and bounces every
 * shared creator link to the login page.
 *
 * Keep this array in sync with `config.matcher` below. They are two halves of
 * the same rule and nothing enforces that they agree.
 */
const protectedExact = ["/profile", "/profile/edit"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!protectedExact.includes(pathname)) return;

  // Supabase puts the session in a cookie that starts with "sb-".
  // NOTE: this only checks that such a cookie EXISTS. It does not verify the
  // session. It is a redirect convenience so signed-out users land on /auth
  // instead of an empty page; it is not the security boundary. The real
  // protection is the per-page auth check plus row-level security.
  const hasSbCookie = Array.from(req.cookies.getAll()).some((c) =>
    c.name.startsWith("sb-")
  );
  if (!hasSbCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/auth";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
}

export const config = {
  // Exact literals on purpose. Do NOT change these to `/profile/:path*` —
  // that is what was gating public creator profiles.
  matcher: ["/profile", "/profile/edit"],
};
