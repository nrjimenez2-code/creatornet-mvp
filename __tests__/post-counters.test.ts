/**
 * Atomic like counting — lib/postCounters.ts
 *
 * Pins the behaviour the pre-launch spec asks for in Priority 4 ("replace unsafe
 * count updates with atomic increments") plus the fallback that makes this safe
 * to merge before the database function exists.
 */

const mockRpc = jest.fn();
const mockSingle = jest.fn();
const mockUpdateEq = jest.fn();
const mockFrom = jest.fn(() => ({
  select: jest.fn(() => ({ eq: jest.fn(() => ({ single: mockSingle })) })),
  update: jest.fn(() => ({ eq: mockUpdateEq })),
}));

const admin = { rpc: mockRpc, from: mockFrom } as never;

import { bumpPostLikes } from "@/lib/postCounters";

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe("bumpPostLikes", () => {
  test("a like goes through the atomic function, not a read-then-write", async () => {
    mockRpc.mockResolvedValueOnce({ data: 41, error: null });

    const result = await bumpPostLikes(admin, "post-1", 1);

    expect(result).toEqual({ count: 41, usedFallback: false });
    expect(mockRpc).toHaveBeenCalledWith("bump_post_likes", {
      p_post_id: "post-1",
      p_delta: 1,
    });
    // The whole point: no SELECT-then-UPDATE round trip.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test("an unlike sends delta -1 through the same path", async () => {
    mockRpc.mockResolvedValueOnce({ data: 39, error: null });

    const result = await bumpPostLikes(admin, "post-1", -1);

    expect(result).toEqual({ count: 39, usedFallback: false });
    expect(mockRpc).toHaveBeenCalledWith("bump_post_likes", {
      p_post_id: "post-1",
      p_delta: -1,
    });
  });

  test("the new count comes back in the same round trip", async () => {
    mockRpc.mockResolvedValueOnce({ data: 7, error: null });

    expect((await bumpPostLikes(admin, "p", 1)).count).toBe(7);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  test("if the database function is missing, liking still works", async () => {
    // Merging this before 002-atomic-like-counter.sql is applied must not break
    // the like button.
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'function public.bump_post_likes does not exist', code: "42883" },
    });
    mockSingle.mockResolvedValueOnce({ data: { likes_count: 10 }, error: null });
    mockUpdateEq.mockResolvedValueOnce({ error: null });

    const result = await bumpPostLikes(admin, "post-1", 1);

    expect(result).toEqual({ count: 11, usedFallback: true });
  });

  test("the fallback clamps at zero rather than going negative", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "missing" } });
    mockSingle.mockResolvedValueOnce({ data: { likes_count: 0 }, error: null });
    mockUpdateEq.mockResolvedValueOnce({ error: null });

    expect((await bumpPostLikes(admin, "post-1", -1)).count).toBe(0);
  });

  test("the fallback treats a null count as zero", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "missing" } });
    mockSingle.mockResolvedValueOnce({ data: { likes_count: null }, error: null });
    mockUpdateEq.mockResolvedValueOnce({ error: null });

    expect((await bumpPostLikes(admin, "post-1", 1)).count).toBe(1);
  });

  test("a failed read in the fallback reports null instead of inventing a number", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "missing" } });
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: "row not found" } });

    expect(await bumpPostLikes(admin, "post-1", 1)).toEqual({
      count: null,
      usedFallback: true,
    });
  });

  test("a non-numeric RPC response falls back rather than trusting it", async () => {
    // Guards against the RPC returning null/undefined and the count silently
    // becoming 0 on a post that has thousands of likes.
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    mockSingle.mockResolvedValueOnce({ data: { likes_count: 500 }, error: null });
    mockUpdateEq.mockResolvedValueOnce({ error: null });

    const result = await bumpPostLikes(admin, "post-1", 1);

    expect(result.usedFallback).toBe(true);
    expect(result.count).toBe(501);
  });
});
