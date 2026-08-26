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
