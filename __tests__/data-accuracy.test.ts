/**
 * Data-accuracy fixes: category whitelist, delta allowlist, rate limiting,
 * order status state machine.
 */

import {
  INTEREST_CATEGORIES,
  toInterestCategory,
  isAllowedInterestDelta,
} from "@/lib/interestCategories";
import { allowRequest, clientKey, _resetRateLimits } from "@/lib/rateLimit";
import {
  canTransition,
  ORDER_OPEN_STATUSES,
  ORDER_REFUNDABLE_STATUSES,
} from "@/lib/orderStatus";

describe("interest categories", () => {
  test("the eight onboarding interests, lowercased, are the whole list", () => {
    expect([...INTEREST_CATEGORIES]).toEqual([
      "entrepreneurship",
      "money & investing",
      "social media growth",
      "content creation",
      "online skills",
      "health & fitness",
      "self improvement",
      "tech & ai automation",
    ]);
  });

  test("onboarding display names normalise to the stored form", () => {
    expect(toInterestCategory("Money & Investing")).toBe("money & investing");
    expect(toInterestCategory("  Self Improvement ")).toBe("self improvement");
    expect(toInterestCategory("TECH & AI   AUTOMATION")).toBe("tech & ai automation");
  });

  test("anything else is rejected, not stored", () => {
    expect(toInterestCategory("$$$random$$$")).toBeNull();
    expect(toInterestCategory("entrepreneur")).toBeNull(); // a hashtag, not a category
    expect(toInterestCategory("")).toBeNull();
    expect(toInterestCategory(null)).toBeNull();
    expect(toInterestCategory(42)).toBeNull();
    expect(toInterestCategory({ toString: () => "money & investing" })).toBeNull();
  });

  test("only the spec'd deltas are allowed", () => {
    for (const d of [1, 2, 3, 4, 5, 10, 15, 25]) expect(isAllowedInterestDelta(d)).toBe(true);
    for (const d of [0, -5, -25, 6, 100, 1e9, NaN, Infinity, "5", null, undefined]) {
      expect(isAllowedInterestDelta(d)).toBe(false);
    }
  });
});

describe("rate limiter", () => {
  beforeEach(() => _resetRateLimits());

  test("allows up to the limit then blocks within the window", () => {
    const opts = { limit: 5, windowMs: 60_000 };
    const t0 = 1_000_000;
    const results = Array.from({ length: 7 }, () => allowRequest("k", opts, t0));
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  test("refills over time", () => {
    const opts = { limit: 10, windowMs: 10_000 }; // 1 token per second
    const t0 = 5_000_000;
    for (let i = 0; i < 10; i++) expect(allowRequest("r", opts, t0)).toBe(true);
    expect(allowRequest("r", opts, t0)).toBe(false);
    expect(allowRequest("r", opts, t0 + 999)).toBe(false);
    expect(allowRequest("r", opts, t0 + 1_000)).toBe(true);
    expect(allowRequest("r", opts, t0 + 1_000)).toBe(false);
    expect(allowRequest("r", opts, t0 + 60_000)).toBe(true); // fully refilled, capped at limit
  });

  test("keys are independent", () => {
    const opts = { limit: 1, windowMs: 60_000 };
    expect(allowRequest("a", opts, 0)).toBe(true);
    expect(allowRequest("a", opts, 0)).toBe(false);
    expect(allowRequest("b", opts, 0)).toBe(true);
  });

  test("a burst of 1000 from one key lets exactly `limit` through", () => {
    const opts = { limit: 120, windowMs: 60_000 };
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (allowRequest("burst", opts, 0)) allowed++;
    expect(allowed).toBe(120);
  });

  test("clientKey takes the first forwarded address", () => {
    const req = { headers: { get: (n: string) => (n === "x-forwarded-for" ? "1.2.3.4, 10.0.0.1" : null) } };
    expect(clientKey(req)).toBe("1.2.3.4");
    expect(clientKey({ headers: { get: () => null } })).toBe("unknown");
  });
});

describe("order status state machine", () => {
  // The live constraint orders_status_check allows exactly these four.
  test("the model matches the database constraint", () => {
    expect([...ORDER_OPEN_STATUSES]).toEqual(["created"]);
    expect([...ORDER_REFUNDABLE_STATUSES]).toEqual(["created", "paid"]);
  });

  test("open orders can be paid or canceled", () => {
    for (const s of ORDER_OPEN_STATUSES) {
      expect(canTransition(s, "paid")).toBe(true);
      expect(canTransition(s, "canceled")).toBe(true);
    }
  });

  test("paid never goes back to created, paid or canceled", () => {
    expect(canTransition("paid", "created")).toBe(false);
    expect(canTransition("paid", "paid")).toBe(false);
    expect(canTransition("paid", "canceled")).toBe(false);
  });

  test("refunded is terminal: a late checkout.completed cannot re-pay it", () => {
    expect(canTransition("refunded", "paid")).toBe(false);
    expect(canTransition("refunded", "created")).toBe(false);
    expect(canTransition("refunded", "refunded")).toBe(false);
  });

  test("only paid orders can be refunded", () => {
    expect(canTransition("paid", "refunded")).toBe(true);
    // Stripe can deliver charge.refunded before the success event that would
    // have moved CreatorNet's still-linked order from created to paid.
    expect(canTransition("created", "refunded")).toBe(true);
    expect(canTransition("canceled", "refunded")).toBe(false);
  });

  test("a null status (legacy row) is treated as created", () => {
    expect(canTransition(null, "paid")).toBe(true);
    expect(canTransition(undefined, "canceled")).toBe(true);
  });
});
