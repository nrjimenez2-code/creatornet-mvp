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
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: (props: { postId: string; onFeedDeleted?: (id: string) => void }) => createElement("button", { onClick: () => props.onFeedDeleted?.(props.postId) }, "Simulate deletion") }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));

import FeedList from "@/components/FeedList";

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
  test("shows Loading… while the RPC is in flight and never flashes an empty state", async () => {
    mockUser = { userId: "u1", loading: false };
    rpcImpl = () => new Promise(() => {}); // never resolves

    await render({ activeTab: "discover" });

    expect(text()).toContain("Loading…");
    expect(text()).not.toContain("No posts yet");
    expect(text()).not.toContain("Couldn");
  });

  test("keeps Loading… while auth is still settling (no premature sign-in prompt)", async () => {
    mockUser = { userId: null, loading: true };

    await render({ activeTab: "following" });

    expect(text()).toContain("Loading…");
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

  test("RPC error: error text and a Try again control, not an empty state", async () => {
    mockUser = { userId: "u1", loading: false };
    rpcImpl = async () => ({ data: null, error: { message: "boom" } });

    await render({ activeTab: "discover" });

    expect(text()).toContain("Couldn't load the feed");
    expect(buttonNamed("Try again")).not.toBeNull();
    expect(text()).not.toContain("No posts yet");
  });
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
