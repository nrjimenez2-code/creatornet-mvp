/**
 * @jest-environment jsdom
 */
/**
 * components/FeedList.tsx — loading / empty / error states of the feed.
 *
 * Renders the REAL FeedList (createRoot + act, no JSX — same pattern as
 * single-auth-flow.test.ts) against a stub supabase client whose
 * `rpc("get_feed_v3")` result each test controls.
 *
 * What it locks:
 *  - initial load shows "Loading…" and never flashes an empty state first
 *  - Following + signed out: a sign-in prompt with a link to /auth, and the
 *    RPC is NOT called (this used to render a flat "No posts yet.")
 *  - Following + signed in + no rows: a message that is true whether or not the
 *    viewer follows anybody, plus a Browse Discover control
 *  - Discover + no rows: "No posts yet"
 *  - RPC error: "Couldn't load the feed" + a Try again control
 *  - RPC error AFTER a tab switch, with rows still in state: the error still
 *    wins. Switching tabs does not clear `items`, so this used to render the
 *    previous tab's videos as if the new tab had loaded.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type RpcResult = { data: unknown; error: { message: string } | null };

let rpcImpl: () => Promise<RpcResult> = async () => ({ data: [], error: null });
const rpcSpy = jest.fn((...args: unknown[]) => {
  void args;
  return rpcImpl();
});
const removeChannel = jest.fn();
type Channel = { on: jest.Mock; subscribe: jest.Mock };
const channel: Channel = { on: jest.fn(() => channel), subscribe: jest.fn(() => channel) };

let mockUser: { userId: string | null; loading: boolean } = { userId: null, loading: false };

jest.mock("@/lib/supabaseClient", () => ({
  createClient: () => ({
    rpc: (...args: unknown[]) => rpcSpy(...args),
    channel: () => channel,
    removeChannel,
  }),
}));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: mockUser.userId, session: null, loading: mockUser.loading }),
}));
jest.mock("@/lib/posthog", () => ({
  trackEvent: jest.fn(),
  normalizeCategory: (raw: string | null) => raw,
}));
// VideoCard is never mounted in these states; stub it so its imports
// (Stripe-adjacent fetches, portals) stay out of the test.
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: (props: { postId: string; activeTab?: string; isActive?: boolean; prepareFrame?: boolean; preload?: string; onFirstFrame?: (id: string) => void; onFeedDeleted?: (id: string) => void }) => createElement("button", { "data-active-tab": props.activeTab, "data-is-active": props.isActive, "data-prepare-frame": props.prepareFrame, "data-preload": props.preload, onDoubleClick: () => props.onFirstFrame?.(props.postId), onClick: () => props.onFeedDeleted?.(props.postId) }, "Simulate deletion") }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));

// Keep the existing UI fixtures while moving their transport to the session API.
// Dedicated discover API tests verify real HTTP paging and session ownership.
jest.mock("@/lib/discoverClient", () => ({
  rememberDiscoverSession: jest.fn(),
  fetchDiscoverPage: async (tab: string, offset: number, limit: number) => {
    const { data, error } = await rpcSpy("get_feed_v3", {p_tab:tab,p_offset:offset,p_limit:limit});
    if (error) throw new Error(error.message);
    const items = Array.isArray(data) ? data : [];
    return {items,session:"test-session",nextOffset:offset+items.length,hasMore:items.length>=limit};
  },
}));
import FeedList from "@/components/FeedList";
import { saveMobileFeedSnapshot } from "@/lib/mobileFeedSnapshot";
import type { PostRow } from "@/lib/feedV3";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver. FeedList only builds one once it has rows,
// so the empty/error tests never needed it — the tab-switch test below does.
class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): unknown[] {
    return [];
  }
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ?? StubIntersectionObserver;

let container: HTMLDivElement;
let root: Root;

async function render(props: { activeTab: "following" | "discover"; onChangeTab?: (t: "following" | "discover") => void }) {
  await act(async () => {
    root.render(
      createElement(FeedList, {
        activeTab: props.activeTab,
        onChangeTab: props.onChangeTab ?? (() => {}),
        highlightPostId: null,
      })
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const text = () => container.textContent ?? "";
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) ?? null;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockUser = { userId: null, loading: false };
  rpcImpl = async () => ({ data: [], error: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  (console.error as jest.Mock).mockRestore?.();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("FeedList states", () => {
  test("shows the feed skeleton while the RPC is in flight and never flashes an empty state", async () => {
    mockUser = { userId: "u1", loading: false };
    rpcImpl = () => new Promise(() => {}); // never resolves

    await render({ activeTab: "discover" });

    expect(text()).toContain("Loading feed…");
    expect(text()).not.toContain("No posts yet");
    expect(text()).not.toContain("Couldn");
  });

  test("keeps the feed skeleton while auth is still settling (no premature sign-in prompt)", async () => {
    mockUser = { userId: null, loading: true };

    await render({ activeTab: "following" });

    expect(text()).toContain("Loading feed…");
    expect(text()).not.toContain("Sign in");
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  test("Following + signed out: sign-in prompt with a link to /auth, RPC not called", async () => {
    mockUser = { userId: null, loading: false };

    await render({ activeTab: "following" });

    expect(text()).toContain("Sign in to see posts from creators you follow");
    const link = container.querySelector('a[href="/auth"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("Sign in");
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(text()).not.toContain("No posts yet");
  });

  // Zero rows does not mean zero follows — the RPC joins follows and then
  // filters out hidden/removed/media-less posts. On production 7 of 8 accounts
  // that follow somebody get zero rows here, so the copy must not claim they
  // follow nobody.
  test("Following + signed in + no rows: a message true in both cases, with a Browse Discover control", async () => {
    mockUser = { userId: "u1", loading: false };
    const onChangeTab = jest.fn();

    await render({ activeTab: "following", onChangeTab });

    expect(rpcSpy).toHaveBeenCalledWith("get_feed_v3", expect.objectContaining({ p_tab: "following" }));
    expect(text()).toContain("Nothing new from creators you follow");
    expect(text()).not.toContain("not following anyone yet");
    const browse = buttonNamed("Browse Discover");
    expect(browse).not.toBeNull();
    expect(browse?.getAttribute("type")).toBe("button");

    await act(async () => {
      browse?.click();
    });
    expect(onChangeTab).toHaveBeenCalledWith("discover");
  });

  test("Discover + no rows: plain empty state", async () => {
    mockUser = { userId: null, loading: false };

    await render({ activeTab: "discover" });

    expect(rpcSpy).toHaveBeenCalledWith("get_feed_v3", expect.objectContaining({ p_tab: "discover" }));
    expect(text()).toContain("No posts yet");
    expect(text()).not.toContain("Sign in to see posts");
    expect(text()).not.toContain("not following anyone");
  });

  test("mobile profile return restores the feed while its fresh request is pending", async () => {
    mockUser = { userId: "profile-return-viewer", loading: false };
    rpcImpl = async () => ({ data: [
      { post_id: "return-post", creator_id: "creator", video_url: "https://example.invalid/return.mp4", title: "Return video" },
    ], error: null });
    await render({ activeTab: "discover" });
    const scroll = container.querySelector<HTMLElement>('[tabindex="0"]');
    expect(scroll).not.toBeNull();
    scroll!.scrollTop = 731;
    await act(async () => scroll!.dispatchEvent(new Event("scroll", { bubbles: true })));
    await act(async () => root.unmount());

    rpcImpl = () => new Promise(() => {});
    root = createRoot(container);
    await render({ activeTab: "discover" });
    expect(buttonNamed("Simulate deletion")).not.toBeNull();
    expect(text()).not.toContain("Loading feed…");
    expect(container.querySelector<HTMLElement>('[tabindex="0"]')?.scrollTop).toBe(731);
  });

  test("mobile revalidation keeps the visible post when ranking order changes", async () => {
    mockUser = { userId: "return-ranking-viewer", loading: false };
    const cached = (id: string): PostRow => ({
      id, creator_id: "creator", product_id: null, price_cents: null,
      title: id, video_url: `https://example.invalid/${id}.mp4`, poster_url: null,
      content: id, interests: null, created_at: null,
    });
    saveMobileFeedSnapshot("discover", mockUser.userId, [cached("first"), cached("third")], "third", 700);
    let finishRequest!: (result: RpcResult) => void;
    rpcImpl = () => new Promise(resolve => { finishRequest = resolve; });
    await render({ activeTab: "discover" });
    expect(container.querySelector('[data-post-id="third"] [data-is-active]')?.getAttribute("data-is-active")).toBe("true");

    await act(async () => finishRequest({ data: [
      { post_id: "third", creator_id: "creator", video_url: "https://example.invalid/third.mp4", title: "third" },
      { post_id: "first", creator_id: "creator", video_url: "https://example.invalid/first.mp4", title: "first" },
    ], error: null }));
    expect(container.querySelector('[data-post-id="third"] [data-is-active]')?.getAttribute("data-is-active")).toBe("true");
  });

  test("a background refresh keeps a hydrated tip return outside the first feed page", async () => {
    mockUser = { userId: "tip-return-viewer", loading: false };
    saveMobileFeedSnapshot("discover", mockUser.userId, [{
      id: "cached", creator_id: "creator", product_id: null, price_cents: null,
      title: "cached", video_url: "https://example.invalid/cached.mp4", poster_url: null,
      content: "cached", interests: null, created_at: null,
    }], "cached", 0);
    let finishRequest!: (result: RpcResult) => void;
    rpcImpl = () => new Promise(resolve => { finishRequest = resolve; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [{
        id: "tip-target", creator_id: "creator", title: "tip target",
        video_url: "https://example.invalid/tip-target.mp4", tips_available: true,
      }] }),
    })) as unknown as typeof fetch;
    try {
      await act(async () => root.render(createElement(FeedList, {
        activeTab: "discover", onChangeTab: () => {},
        highlightPostId: "tip-target", openTipPostId: "tip-target", resumeTipId: "tip-1",
      })));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(container.querySelector('[data-post-id="tip-target"]')).not.toBeNull();

      await act(async () => finishRequest({ data: [
        { post_id: "cached", creator_id: "creator", video_url: "https://example.invalid/cached.mp4", title: "cached" },
      ], error: null }));
      expect(container.querySelector('[data-post-id="tip-target"]')).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failed revalidation cannot revive stale rows on the next return", async () => {
    mockUser = { userId: "return-error-viewer", loading: false };
    saveMobileFeedSnapshot("discover", mockUser.userId, [{
      id: "old", creator_id: "creator", product_id: null, price_cents: null,
      title: "Old", video_url: "https://example.invalid/old.mp4", poster_url: null,
      content: "Old", interests: null, created_at: null,
    }], "old", 0);
    rpcImpl = async () => ({ data: null, error: { message: "boom" } });
    await render({ activeTab: "discover" });
    expect(text()).toContain("Couldn't load the feed");
    await act(async () => root.unmount());
    rpcImpl = () => new Promise(() => {});
    root = createRoot(container);
    await render({ activeTab: "discover" });
    expect(text()).toContain("Loading feed…");
  });

  test("phone feed warms only the next card after the active frame is ready", async () => {
    mockUser = { userId: "warmup-viewer", loading: false };
    rpcImpl = async () => ({ data: ["one", "two", "three"].map(id => ({
      post_id: id, creator_id: "creator", video_url: `https://example.invalid/${id}.mp4`, title: id,
    })), error: null });
    await render({ activeTab: "discover" });
    const card = (id: string) => container.querySelector<HTMLButtonElement>(`[data-post-id="${id}"] button`);
    expect(card("two")?.getAttribute("data-prepare-frame")).toBe("false");
    expect(card("two")?.getAttribute("data-preload")).toBe("metadata");
    expect(card("three")?.getAttribute("data-preload")).toBe("metadata");
    await act(async () => card("one")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(card("two")?.getAttribute("data-prepare-frame")).toBe("true");
    expect(card("two")?.getAttribute("data-preload")).toBe("auto");
    expect(card("three")?.getAttribute("data-prepare-frame")).toBe("false");
  });

  test("RPC error: error text and a Try again control, not an empty state", async () => {
    mockUser = { userId: "u1", loading: false };
    rpcImpl = async () => ({ data: null, error: { message: "boom" } });

    await render({ activeTab: "discover" });

    expect(text()).toContain("Couldn't load the feed");
    expect(buttonNamed("Try again")).not.toBeNull();
    expect(text()).not.toContain("No posts yet");
  });
});

  test("cards receive the current feed tab so Discover controls follow tab switches", async () => {
    mockUser = { userId: "u1", loading: false };
    rpcImpl = async () => ({ data: [{ post_id: "p1", creator_id: "c1", video_url: "https://example.invalid/v.mp4", title: "A video" }], error: null });
    await render({ activeTab: "discover" });
    expect(buttonNamed("Simulate deletion")?.getAttribute("data-active-tab")).toBe("discover");
    await render({ activeTab: "following" });
    expect(buttonNamed("Simulate deletion")?.getAttribute("data-active-tab")).toBe("following");
  });

  test("deleting the final feed video removes it immediately without a realtime event", async () => {
    mockUser = { userId: "u1", loading: false };
    rpcImpl = async () => ({ data: [{ post_id: "p1", creator_id: "u1", video_url: "https://example.invalid/v.mp4", title: "A video" }], error: null });
    await render({ activeTab: "discover" });
    await act(async () => { buttonNamed("Simulate deletion")!.click(); });
    expect(buttonNamed("Simulate deletion")).toBeNull();
  });

  // Switching tabs does not clear `items`. Before the fix the empty/error block
  // was gated on `items.length === 0`, so a failed load on the new tab left the
  // PREVIOUS tab's videos on screen with no error and no retry — a failed read
  // presented as a successful one.
  // Mutation check: revert the `feedError ||` in FeedList's guard and this fails.
  test("RPC error after a tab switch still shows the error, not the previous tab's rows", async () => {
    mockUser = { userId: "u1", loading: false };

    // 1. Discover loads one real row, so `items` is non-empty.
    rpcImpl = async () => ({
      data: [
        {
          post_id: "p1",
          creator_id: "c1",
          video_url: "https://example.invalid/v.mp4",
          poster_url: null,
          title: "A video",
        },
      ],
      error: null,
    });
    await render({ activeTab: "discover" });
    expect(text()).not.toContain("Couldn't load the feed");

    // 2. Switch to Following and have that load fail, with the row still in state.
    rpcImpl = async () => ({ data: null, error: { message: "boom" } });
    await render({ activeTab: "following" });

    expect(text()).toContain("Couldn't load the feed");
    expect(buttonNamed("Try again")).not.toBeNull();
    // and it must not silently fall through to the "nothing new" empty state
    expect(text()).not.toContain("Nothing new from creators you follow");
  });
