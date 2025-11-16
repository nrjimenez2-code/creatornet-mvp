// proxy.ts (project root)
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const protectedPaths = ["/profile", "/analytics", "/closers"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!protectedPaths.some((p) => pathname.startsWith(p))) return;

  // Supabase puts the session in a cookie that starts with "sb-"
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
  matcher: ["/profile/:path*", "/analytics/:path*", "/closers/:path*"],
};
