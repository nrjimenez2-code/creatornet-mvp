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
 *  - Following + signed in + no rows: "not following anyone" + a Browse
 *    Discover control that calls onChangeTab("discover")
 *  - Discover + no rows: "No posts yet"
 *  - RPC error: "Couldn't load the feed" + a Try again control
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
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));

import FeedList from "@/components/FeedList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  test("Following + signed in + no rows: not-following message with a Browse Discover control", async () => {
    mockUser = { userId: "u1", loading: false };
    const onChangeTab = jest.fn();

    await render({ activeTab: "following", onChangeTab });

    expect(rpcSpy).toHaveBeenCalledWith("get_feed_v3", expect.objectContaining({ p_tab: "following" }));
    expect(text()).toContain("not following anyone yet");
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
