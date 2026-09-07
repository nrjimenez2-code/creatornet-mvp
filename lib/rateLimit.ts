// lib/rateLimit.ts — small, in-memory, per-key token bucket.
//
// This is a speed bump, not a wall. It lives in the memory of one serverless
// instance, so a determined attacker who spreads requests across instances
// (or waits for a cold start) gets a fresh bucket. What it does stop is the
// cheap case: one script hammering /api/post-metrics or /api/share from a
// single connection to inflate a post's numbers. That is the realistic abuse
// for a site this size, and it costs nothing to block. If stats inflation
// becomes a real problem, swap the Map for Upstash/Redis behind the same
// function signature.
//
// COVERAGE, and what is deliberately left alone.
// Limited: post-metrics, interest-score, share, comments (create, edit and
// delete), likes, follow, reviews, search/perform, upload/presign, post
// creation, product creation, booking create and cancel, and posts/creators.
// Also: verification (the blue-check code request, 5/hour — the admin queue
// is human-reviewed, so a script filling it is the abuse to stop).
//
// posts/creators is the one that mattered most: it is unauthenticated, runs on
// the service-role client, and used to accept an unbounded array of ids, so a
// single anonymous request could make the database build an enormous IN (...).
// It is now both limited and capped.
//
// NOT limited, on purpose — do not "finish the job" by adding these:
//   * /api/stripe/webhook and /api/webhook — these are Stripe's own calls.
//     Refusing one drops a payment notification.
//   * /api/checkout, /api/confirm-purchase, /api/premium/access — the money
//     path. A false positive here means a buyer is charged and refused their
//     file, which is far worse than the abuse it would prevent.
//   * /api/auth/callback — refusing this breaks signing in.
//   * /api/admin/* — already behind an admin check, and locking the founder
//     out of his own moderation tools during a spike is the wrong trade.
//   * /api/watch/progress — legitimately high-frequency (playback position).
//
// Keying is by IP, matching the existing routes. That is weaker than keying by
// user id behind carrier NAT, which is why every limit here is set generously:
// these numbers are meant to catch scripts, not people.

import { NextResponse } from "next/server";

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

export type RateLimitOptions = {
  /** Max requests allowed in one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

/**
 * Returns true if the request identified by `key` is allowed.
 * `now` is injectable for tests.
 */
export function allowRequest(
  key: string,
  { limit, windowMs }: RateLimitOptions,
  now: number = Date.now()
): boolean {
  if (limit <= 0) return false;
  const refillPerMs = limit / windowMs;

  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_KEYS) {
      // Drop the oldest entry rather than grow without bound.
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    b = { tokens: limit, updatedAt: now };
    buckets.set(key, b);
  } else {
    const elapsed = Math.max(0, now - b.updatedAt);
    b.tokens = Math.min(limit, b.tokens + elapsed * refillPerMs);
    b.updatedAt = now;
    // Re-insert so Map order reflects recency; eviction above then drops
    // the least recently used key, not the earliest inserted one.
    buckets.delete(key);
    buckets.set(key, b);
  }

  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Best-effort client identifier behind Vercel's proxy. */
export function clientKey(req: { headers: { get(name: string): string | null } }): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0].trim() : req.headers.get("x-real-ip") ?? "unknown";
  return ip;
}

/** Test hook. */
export function _resetRateLimits(): void {
  buckets.clear();
}

/**
 * The standard response for a caller who has run out of budget.
 *
 * 429 with a Retry-After, so a well-behaved client backs off and a human sees
 * a sentence rather than a stack trace. Routes where a refusal would break
 * something the user cares about (a share, a metrics ping) should return their
 * normal success shape with a `limited` flag instead — see
 * app/api/posts/[postId]/share/route.ts.
 */
export function tooManyRequests(
  message = "You're doing that a bit too fast. Wait a moment and try again.",
  retryAfterSeconds = 60
): NextResponse {
  return NextResponse.json(
    { error: message, code: "RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}
