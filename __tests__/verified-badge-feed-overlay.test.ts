/**
 * @jest-environment jsdom
 */
/**
 * Purple "Verified creator" badge on the MAIN FEED overlay — phase 2 of
 * Noah #3 (phase 1 = PR #130: lib/sellReady.ts + VerifiedCreatorBadge).
 *
 * 1. Renders the REAL components/VideoCard.tsx (createRoot + act, no JSX —
 *    same mocks as policy-links-purchase-flow.test.ts) and asserts the badge
 *    is the element right AFTER the creator's name in BOTH name branches
 *    (Link when a profile href exists, plain span when it does not), and
 *    only when `creatorVerified` is true. It is a sibling, not a child, of
 *    the name: the name element `truncate`s (overflow hidden), so a badge
 *    inside it is clipped away for long names — measured in a browser
 *    fixture during review: badge right edge 439px vs link right edge 370px.
 * 2. Source tripwires, because FeedList's realtime/virtualised render is too
 *    heavy to mount here and the SQL cannot run in jest:
 *    - FeedList passes `creatorVerified={p.creator_verified` to VideoCard.
 *    - supabase/schema/023-feed-v3-verified-seller-STAGED.sql declares
 *      `creator_verified boolean` in RETURNS TABLE and selects the ONE
 *      sell-ready expression in both branches (following + discover).
 *
 * Mutation-checked: deleting the <VerifiedCreatorBadge> line makes the two
 * placement tests fail; loosening the mapper makes the mapping test fail.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

const REPO_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Module mocks — registered before the component import (jest hoists these).
// ---------------------------------------------------------------------------

const mockClient = createMockClient();
jest.mock("@/lib/supabaseClient", () => ({
  createClient: () => mockClient,
  supabase: mockClient,
}));

const userCtx: { session: null; loading: boolean; userId: string | null } = {
  session: null,
  loading: false,
  userId: null,
};
jest.mock("@/lib/useUser", () => ({
  useUser: () => userCtx,
}));

jest.mock("@/lib/posthog", () => ({
  trackEvent: jest.fn(),
  normalizeCategory: (raw: string | null | undefined) => raw ?? null,
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

jest.mock("@/components/CommentPanel", () => ({
  __esModule: true,
  default: () => null,
}));

import VideoCard from "@/components/VideoCard";
import { VERIFIED_CREATOR_LABEL } from "@/components/VerifiedCreatorBadge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver; VideoCard constructs one for autoplay.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = NoopObserver;

type VideoCardProps = Parameters<typeof VideoCard>[0];

const BADGE = `[role="img"][aria-label="${VERIFIED_CREATOR_LABEL}"]`;
const CREATOR = "Jane Doe";

describe("VideoCard shows the Verified creator badge on the feed overlay", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    userCtx.userId = null;
    userCtx.loading = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(props: Partial<VideoCardProps>) {
    await act(async () => {
      root.render(
        createElement(VideoCard, {
          poster: "https://cdn.example.com/p.jpg",
          creator: CREATOR,
          caption: "A tip",
          hashtags: "#fitness",
          postId: "post_1",
          ...props,
        })
      );
    });
  }

  test("falls back to the original if CDN media fails and uses CDN for the next post", async () => {
    const original = "https://pub-91a8d994910d498d90b109487939e1db.r2.dev/videos/fallback-test.mp4";
    await render({ src: original });
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("https://media.creatornet.net/auto/videos/fallback-test.mp4");
    await act(async () => video.dispatchEvent(new Event("error")));
    expect(video.getAttribute("src")).toBe(original);
    await render({ src: original.replace("fallback-test", "next-test") });
    expect(video.getAttribute("src")).toBe("https://media.creatornet.net/auto/videos/next-test.mp4");
  });

  test("active source fallback restarts playback", async () => {
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    try {
      await render({ src: "https://pub-91a8d994910d498d90b109487939e1db.r2.dev/videos/recover.mp4", isActive: true });
      play.mockClear();
      await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));
      expect(play).toHaveBeenCalledTimes(1);
    } finally { play.mockRestore(); }
  });

  test("page hide pauses playback; resume preserves manual pause and never starts an inactive card", async () => {
    let paused = true;
    const visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const pausedGetter = jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => { paused = false; });
    const pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => { paused = true; });
    const change = async (state: DocumentVisibilityState) => act(async () => {
      visibility.mockReturnValue(state);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    try {
      await render({ src: "https://cdn.example.com/visible.mp4", isActive: true });
      expect(paused).toBe(false);
      await change("hidden");
      expect(paused).toBe(true);
      const calls = play.mock.calls.length;
      await change("visible");
      expect(play).toHaveBeenCalledTimes(calls + 1);
      const group = container.querySelector('[role="group"]')!;
      (group as HTMLElement).focus();
      await act(async () => group.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
      expect(paused).toBe(true);
      const manuallyPausedCalls = play.mock.calls.length;
      await change("hidden"); await change("visible");
      expect(play).toHaveBeenCalledTimes(manuallyPausedCalls);
      await render({ src: "https://cdn.example.com/visible.mp4", isActive: false });
      await change("hidden"); await change("visible");
      expect(play).toHaveBeenCalledTimes(manuallyPausedCalls);
    } finally { await act(async () => root.render(null)); visibility.mockRestore(); pausedGetter.mockRestore(); play.mockRestore(); pause.mockRestore(); }
  });

  test("a successful like reports authoritative state to the feed, but a failed mutation does not", async () => {
    const savedFetch = global.fetch;
    const change = jest.fn();
    userCtx.userId = "buyer";
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, liked: true, likes_count: 9 }) })) as any;
    try {
      await render({ onInteractionChange: change });
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Like"]')!.click());
      expect(change).toHaveBeenCalledWith("post_1", { is_liked: true, likes_count: 9 });
      change.mockClear();
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, json: async () => ({ success: false }) });
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Like"]')!.click());
        expect(change).not.toHaveBeenCalled();
        expect(container.querySelector('button[aria-label="Like"] svg')?.getAttribute("class")).toContain("fill-red-500");
      } finally { error.mockRestore(); }
    } finally { global.fetch = savedFetch; }
  });

  test("already-ready playback rejection retries once and stops when inactive", async () => {
    jest.useFakeTimers();
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("interrupted", "AbortError"));
    const ready = jest.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    try {
      await render({ src: "https://cdn.example.com/retry.mp4", isActive: true });
      await act(async () => jest.advanceTimersByTime(100));
      expect(play).toHaveBeenCalledTimes(2);
      await act(async () => jest.advanceTimersByTime(1000));
      expect(play).toHaveBeenCalledTimes(2);
      await render({ src: "https://cdn.example.com/next.mp4", isActive: true });
      await render({ src: "https://cdn.example.com/next.mp4", isActive: false });
      play.mockClear();
      await act(async () => jest.advanceTimersByTime(100));
      expect(play).not.toHaveBeenCalled();
    } finally { play.mockRestore(); ready.mockRestore(); jest.useRealTimers(); }
  });

  test("source fallback respects manual pause", async () => {
    jest.useFakeTimers();
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    try {
      await render({ src: "https://pub-91a8d994910d498d90b109487939e1db.r2.dev/videos/paused.mp4", isActive: true, tapToTogglePlayback: true });
      const video = container.querySelector("video")!;
      Object.defineProperty(video, "paused", { get: () => false });
      video.pause = jest.fn();
      await act(async () => video.click());
      await act(async () => jest.advanceTimersByTime(300));
      play.mockClear();
      await act(async () => video.dispatchEvent(new Event("error")));
      expect(play).not.toHaveBeenCalled();
    } finally { play.mockRestore(); jest.useRealTimers(); }
  });

  test("playback feedback follows manual pause and resume, then fades", async () => {
    jest.useFakeTimers();
    try {
      await render({ src: "https://cdn.example.com/video.mp4", tapToTogglePlayback: true, postId: undefined });
      const video = container.querySelector("video")!;
      let paused = false;
      Object.defineProperty(video, "paused", { get: () => paused });
      video.pause = jest.fn(() => { paused = true; video.dispatchEvent(new Event("pause")); });
      video.play = jest.fn(async () => { paused = false; video.dispatchEvent(new Event("play")); });
      const feedback = () => container.querySelector('[data-playback-feedback]')!;
      expect(feedback().className).toContain("opacity-0");
      await act(async () => video.click());
      await act(async () => jest.advanceTimersByTime(300));
      expect(feedback().getAttribute("data-playback-feedback")).toBe("paused");
      expect(feedback().className).toContain("opacity-100");
      await act(async () => jest.advanceTimersByTime(1000));
      expect(feedback().className).toContain("opacity-100");
      await act(async () => video.click());
      await act(async () => jest.advanceTimersByTime(300));
      expect(feedback().getAttribute("data-playback-feedback")).toBe("playing");
      expect(feedback().className).toContain("opacity-100");
      await act(async () => jest.advanceTimersByTime(650));
      expect(feedback().className).toContain("opacity-0");
      expect(feedback().className).toContain("pointer-events-none");
      const caption = container.querySelector("p")!;
      await act(async () => caption.click());
      await act(async () => jest.advanceTimersByTime(300));
      expect(paused).toBe(true);
      await act(async () => caption.parentElement!.click());
      await act(async () => jest.advanceTimersByTime(300));
      expect(paused).toBe(false);
      const pauseCalls = (video.pause as jest.Mock).mock.calls.length;
      const mute = container.querySelector<HTMLButtonElement>('button[aria-label="Mute video"], button[aria-label="Unmute video"]')!;
      await act(async () => mute.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect((video.pause as jest.Mock).mock.calls.length).toBe(pauseCalls);
      expect(paused).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  test("repeated double taps replay the heart without toggling playback or adding another like", async () => {
    jest.useFakeTimers();
    try {
      const onLike = jest.fn();
      await render({ src: "https://cdn.example.com/video.mp4", postId: undefined, onLike });
      const video = container.querySelector("video")!;
      video.pause = jest.fn();
      video.play = jest.fn().mockResolvedValue(undefined);
      const doubleTap = async () => {
        await act(async () => {
          video.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 75, clientY: 150 }));
          jest.advanceTimersByTime(100);
          video.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 77, clientY: 152 }));
        });
      };
      await doubleTap();
      const firstHeart = container.querySelector<HTMLElement>("[data-tap-heart]")!;
      expect(firstHeart.style.left).toBe("77px");
      expect(firstHeart.style.top).toBe("152px");
      expect(onLike).toHaveBeenCalledTimes(1);
      await doubleTap();
      expect(container.querySelector("[data-tap-heart]")).not.toBe(firstHeart);
      expect(onLike).toHaveBeenCalledTimes(1);
      await act(async () => jest.advanceTimersByTime(800));
      expect(container.querySelector("[data-tap-heart]")).toBeNull();
      expect(video.pause).not.toHaveBeenCalled();
      expect(video.play).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  test("double taps send one like-only request while saving and after success", async () => {
    jest.useFakeTimers();
    const oldFetch = global.fetch;
    let finish!: (value: unknown) => void;
    const request = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    global.fetch = request as unknown as typeof fetch;
    try {
      await render({ src: "https://cdn.example.com/video.mp4", postId: "post" });
      const video = container.querySelector("video")!;
      video.pause = jest.fn();
      const doubleTap = async () => act(async () => { video.click(); video.click(); });
      await doubleTap();
      await doubleTap();
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(expect.stringContaining("/api/posts/post/like"), expect.objectContaining({ method: "PUT" }));
      await act(async () => finish({ ok: true, json: async () => ({ success: true, liked: true, likes_count: 1 }) }));
      await doubleTap();
      expect(request).toHaveBeenCalledTimes(1);
    } finally { global.fetch = oldFetch; jest.useRealTimers(); }
  });

  test("a delayed canplay retry cannot restart an inactive feed video", async () => {
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("not ready"));
    const pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    try {
      await render({ src: "https://cdn.example.com/video.mp4", postId: undefined, isActive: true });
      expect(play).toHaveBeenCalledTimes(1);
      await render({ src: "https://cdn.example.com/video.mp4", postId: undefined, isActive: false });
      await act(async () => container.querySelector("video")!.dispatchEvent(new Event("canplay")));
      expect(play).toHaveBeenCalledTimes(1);
      expect(pause).toHaveBeenCalled();
    } finally { play.mockRestore(); pause.mockRestore(); }
  });

  test("failed original playback offers a retry that rebinds the new player", async () => {
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    try {
      await render({ src: "https://cdn.example.com/video.mp4", postId: undefined, isActive: true });
      const failed = container.querySelector("video")!;
      await act(async () => failed.dispatchEvent(new Event("error")));
      const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry video");
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      expect(container.querySelector("video")).not.toBe(failed);
      expect(container.textContent).not.toContain("This video couldn’t load.");
      expect(play).toHaveBeenCalledTimes(2);
      await act(async () => container.querySelector("video")!.dispatchEvent(new Event("play")));
      expect(container.querySelector('[data-playback-feedback="playing"]')).not.toBeNull();
    } finally { play.mockRestore(); pause.mockRestore(); }
  });

  test("poster remains until the first displayed frame and returns on a source change", async () => {
    const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    try {
      await render({ src: "https://cdn.example.com/one.mp4", poster: "/poster.jpg", isActive: true });
      expect(container.querySelector('img[aria-hidden="true"]')).not.toBeNull();
      await act(async () => container.querySelector("video")!.dispatchEvent(new Event("playing")));
      expect(container.querySelector('img[aria-hidden="true"]')).toBeNull();
      await render({ src: "https://cdn.example.com/two.mp4", poster: "/poster.jpg", isActive: true });
      expect(container.querySelector('img[aria-hidden="true"]')).not.toBeNull();
    } finally { play.mockRestore(); pause.mockRestore(); }
  });

  /** The element whose text is exactly the creator's display name. */
  test("follow plus is hidden for self and while auth loads, but remains for another creator", async () => {
    const onFollow = jest.fn();
    userCtx.userId = "owner";
    await render({ creatorId: "owner", showFollowButton: true, onFollow });
    expect(container.querySelector('button[aria-label="Follow Jane Doe"]')).toBeNull();
    userCtx.loading = true;
    await render({ creatorId: "other", showFollowButton: true, onFollow });
    expect(container.querySelector('button[aria-label="Follow Jane Doe"]')).toBeNull();
    userCtx.loading = false;
    await render({ creatorId: "other", showFollowButton: true, onFollow });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Follow Jane Doe"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(onFollow).toHaveBeenCalledTimes(1);
  });

  function nameNode(): HTMLElement {
    const all = Array.from(container.querySelectorAll<HTMLElement>("a, span"));
    const node = all.find((el) => el.childNodes[0]?.textContent === CREATOR);
    if (!node) throw new Error("creator name not rendered");
    return node;
  }

  test("Link branch: badge is the element right after the profile link, not inside it", async () => {
    await render({ creatorUsername: "jane", creatorVerified: true });

    const link = nameNode();
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/profile/jane");
    // The link's accessible name stays just the creator's name.
    expect(link.textContent).toBe(CREATOR);
    expect(link.querySelector(BADGE)).toBeNull();

    const badge = link.nextElementSibling as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.matches(BADGE)).toBe(true);
    // Small size on the overlay.
    expect(badge!.style.width).toBe("14px");
    // Exactly one badge on the card.
    expect(container.querySelectorAll(BADGE)).toHaveLength(1);
  });

  test("span branch (no profile href): badge is the element right after the span", async () => {
    await render({ creatorUsername: null, creatorId: null, creatorVerified: true });

    const span = nameNode();
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toBe(CREATOR);
    expect(span.querySelector(BADGE)).toBeNull();

    const badge = span.nextElementSibling as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.matches(BADGE)).toBe(true);
    expect(container.querySelectorAll(BADGE)).toHaveLength(1);
  });

  test("no badge when creatorVerified is false", async () => {
    await render({ creatorUsername: "jane", creatorVerified: false });
    expect(nameNode().textContent).toBe(CREATOR);
    expect(container.querySelector(BADGE)).toBeNull();
  });

  test("no badge when creatorVerified is omitted (pre-migration default)", async () => {
    await render({ creatorUsername: "jane" });
    expect(container.querySelector(BADGE)).toBeNull();
  });

  test("the badge icon is decorative; the label carries the meaning", async () => {
    await render({ creatorUsername: "jane", creatorVerified: true });
    const badge = container.querySelector<HTMLElement>(BADGE)!;
    expect(badge.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(badge.getAttribute("title")).toMatch(/Stripe/);
  });
});

describe("tripwire: FeedList forwards creator_verified to VideoCard", () => {
  const source = readFileSync(join(REPO_ROOT, "components/FeedList.tsx"), "utf8");

  test("passes creatorVerified from the mapped row, hidden when the name is hidden", () => {
    expect(source).toMatch(
      /creatorVerified=\{p\.creator_verified === true && p\.creator_name != null\}/
    );
  });
});

describe("tripwire: migration 023 returns creator_verified from both feed branches", () => {
  const sql = readFileSync(
    join(REPO_ROOT, "supabase/schema/023-feed-v3-verified-seller-STAGED.sql"),
    "utf8"
  );
  const SELL_READY_SQL =
    "(prof.stripe_account_id is not null and coalesce(prof.stripe_onboarding_complete, false))";

  // This used to assert the file said "STAGED — NOT APPLIED". It was applied to
  // production on 2026-09-07, so that assertion is now inverted and would keep a
  // stale claim true. What actually matters is unchanged: the file must state its
  // status unambiguously (a filename ending in -STAGED is not enough — this one
  // still does) and must keep recording that 025 runs FIRST, because running 025
  // after 023 silently drops creator_verified.
  test("states its applied status explicitly and still records the 025 → 023 order", () => {
    const declaresStaged = /STAGED — NOT APPLIED/.test(sql);
    const declaresApplied = /APPLIED TO PRODUCTION \d{4}-\d{2}-\d{2}/.test(sql);
    expect(declaresStaged || declaresApplied).toBe(true);
    // never both — that would be a file contradicting itself
    expect(declaresStaged && declaresApplied).toBe(false);
    expect(sql).toMatch(/025-feed-v3-purchase-count-STAGED\.sql[^\n]*FIRST/);
  });

  test("declares creator_verified boolean as the LAST column of RETURNS TABLE", () => {
    const returns = sql.match(/returns table \(([\s\S]*?)\)\s*language plpgsql/);
    expect(returns).not.toBeNull();
    const columns = returns![1]
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    expect(columns[columns.length - 1]).toBe("creator_verified boolean");
    // 025's purchase_count must survive (023 is 025 + one column).
    expect(columns).toContain("purchase_count integer");
    expect(columns).toHaveLength(24);
  });

  test("selects the one sell-ready expression in the following AND discover branches", () => {
    const occurrences = sql.split(SELL_READY_SQL).length - 1;
    expect(occurrences).toBe(2);
    // Following branch: bare expression right after purchase_count.
    expect(sql).toMatch(
      /coalesce\(p\.purchase_count, 0\),\s*\(prof\.stripe_account_id is not null and coalesce\(prof\.stripe_onboarding_complete, false\)\)\s*from posts p/
    );
    // Discover branch: aliased inside the subquery and re-selected outside.
    expect(sql).toMatch(/\) as r_creator_verified\s*from posts p/);
    expect(sql).toMatch(/x\.r_purchase_count,\s*x\.r_creator_verified\s*from \(/);
  });

  test("never returns the raw stripe_account_id as a column", () => {
    // Inside the function body the id may only appear in the `is not null` test.
    const body = sql.slice(sql.indexOf("\nbegin;"), sql.indexOf("\ncommit;"));
    expect(body.match(/stripe_account_id(?! is not null)/g)).toBeNull();
  });

  test("has CHECK and ROLLBACK sections", () => {
    expect(sql).toMatch(/CHECK BLOCK/);
    expect(sql).toMatch(/ROLLBACK/);
  });
});



