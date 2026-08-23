/**
 * Booking checkout, auth-callback CSRF guard, Stripe redirect origin, and
 * the 010 database locks.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { isSameOriginRequest } from "@/lib/sameOrigin";

const REPO_ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

function req(headers: Record<string, string>): Request {
  return { headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } } as unknown as Request;
}

describe("isSameOriginRequest", () => {
  test("the real caller (same-origin fetch) passes", () => {
    expect(isSameOriginRequest(req({ origin: "https://www.creatornet.net", host: "www.creatornet.net" }))).toBe(true);
    expect(isSameOriginRequest(req({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
  });

  test("behind Vercel the forwarded host is what counts", () => {
    expect(isSameOriginRequest(req({ origin: "https://www.creatornet.net", "x-forwarded-host": "www.creatornet.net", host: "internal" }))).toBe(true);
  });

  test("a cross-site form post is refused", () => {
    expect(isSameOriginRequest(req({ origin: "https://evil.example", host: "www.creatornet.net" }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: "null", host: "www.creatornet.net" }))).toBe(false);
    expect(isSameOriginRequest(req({ host: "www.creatornet.net" }))).toBe(false); // no Origin at all
    expect(isSameOriginRequest(req({ origin: "https://www.creatornet.net.evil.example", host: "www.creatornet.net" }))).toBe(false);
  });
});

describe("source tripwires", () => {
  const checkout = read("app/api/checkout/route.ts");
  const booking = checkout.slice(checkout.indexOf('if (body.type === "booking") {'), checkout.indexOf('return new Response("Unsupported type"'));

  test("booking checkout requires a signed-in buyer and records them", () => {
    expect(booking).toMatch(/if \(!resolvedBuyerId\)[\s\S]{0,120}status: 401/);
    expect(booking).toMatch(/buyer_id: resolvedBuyerId/);
    expect(booking).toMatch(/buyer_user_id: resolvedBuyerId/);
  });

  test("booking checkout takes creator and redirect from the post row, not the body", () => {
    expect(booking).not.toMatch(/body\.creator_id/);
    expect(booking).not.toMatch(/body\.bookingRedirectUrl/);
    expect(booking).toMatch(/isSafeBookingTarget\(target\)/);
  });

  test("Stripe success/cancel URLs come from the configured site, not the Host header", () => {
    expect(checkout).toMatch(/NEXT_PUBLIC_SITE_URL \|\| process\.env\.NEXT_PUBLIC_BASE_URL/);
    expect(checkout).not.toMatch(/req\.headers\.get\("origin"\)/);
  });

  test("webhook never resolves a booking buyer from the card email", () => {
    const wh = read("app/api/stripe/webhook/route.ts");
    const fn = wh.slice(wh.indexOf("async function insertBookingFromSession"), wh.indexOf("async function", wh.indexOf("async function insertBookingFromSession") + 10));
    expect(fn).not.toMatch(/customers\.retrieve/);
    expect(fn).not.toMatch(/eq\("email"/);
    expect(fn).toMatch(/if \(!buyer_id\)[\s\S]{0,160}return;/);
  });

  test("both auth callbacks check the request origin before touching cookies", () => {
    for (const f of ["app/auth/callback/route.ts", "app/api/auth/callback/route.ts"]) {
      const src = read(f);
      expect(src).toMatch(/isSameOriginRequest\(req\)/);
      expect(src.indexOf("isSameOriginRequest(req)")).toBeLessThan(src.indexOf("setSession"));
      expect(src.indexOf("isSameOriginRequest(req)")).toBeLessThan(src.indexOf("signOut"));
    }
  });

  test("SQL 010 locks orders inserts, post counters, increment RPCs and anonymous uploads", () => {
    const sql = read("supabase/schema/010-lock-orders-counters-storage.sql");
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.orders FROM anon, authenticated/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "buyer inserts own order"/);
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.posts FROM anon, authenticated/);
    const grant = sql.slice(sql.indexOf("GRANT UPDATE ("), sql.indexOf(") ON public.posts"));
    for (const locked of ["likes_count", "comments_count", "shares_count", "purchase_count", "views", "premium_path", "product_id", "price_cents", "creator_id", "user_id", "video_url"]) {
      expect(grant).not.toMatch(new RegExp(`\\b${locked}\\b`));
    }
    for (const fn of ["increment_post_likes", "increment_post_comments", "increment_post_shares"]) {
      expect(sql).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\)\\s+FROM PUBLIC, anon, authenticated`));
    }
    expect(sql).toMatch(/DROP POLICY IF EXISTS "objects\.insert: owner can upload to allowed buckets" ON storage\.objects/);
  });
});
