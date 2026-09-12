/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

let followRecord = false;
const mockClient = createMockClient((op) => op.table === "follows" ? { data: followRecord ? { following_id: "creator" } : null, error: null } : undefined);
const userCtx: { userId: string | null; session: null } = { userId: null, session: null };
const router = { push: jest.fn(), replace: jest.fn() };
jest.mock("@/lib/useUser", () => ({ useUser: () => userCtx }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient, supabase: mockClient }));
jest.mock("@/lib/supabaseBrowser", () => ({ createBrowserClient: () => mockClient }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (v: string) => v }));
jest.mock("next/navigation", () => ({ useRouter: () => router }));
jest.mock("@/components/CommentPanel", () => ({ __esModule: true, default: () => null }));
import VideoCard from "@/components/VideoCard";
import FollowButton from "@/components/FollowButton";
import PostComposer from "@/components/PostComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = NoopObserver;
let root: Root;
let container: HTMLDivElement;
const fetchMock = jest.fn();
const response = (data: unknown) => ({ ok: true, json: async () => data });
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = async (element: HTMLElement) => act(async () => element.click());
beforeEach(() => {
  followRecord = false;
  userCtx.userId = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset().mockResolvedValue(response({ success: true }));
  globalThis.fetch = fetchMock;
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

test("optimistic likes survive unrelated renders; changed server props and a new post reset the displayed count", async () => {
  const props = { postId: "post-a", likeCount: 2, isLiked: false, isActive: false, title: "A" };
  fetchMock.mockImplementation(async (url: string) => response(url.endsWith("/like") ? { success: true, liked: true, likes_count: 3 } : {}));
  await act(async () => root.render(createElement(VideoCard, props)));
  await click(button("Like"));
  expect(button("Like").parentElement?.textContent).toContain("3");
  await act(async () => root.render(createElement(VideoCard, { ...props, title: "Re-render" })));
  expect(button("Like").parentElement?.textContent).toContain("3");
  await act(async () => root.render(createElement(VideoCard, { ...props, likeCount: 9, isLiked: true })));
  expect(button("Like").parentElement?.textContent).toContain("9");
  await act(async () => root.render(createElement(VideoCard, { ...props, postId: "post-b" })));
  expect(button("Like").parentElement?.textContent).toContain("2");
});

test("mute responds to local interaction and subsequent global sound changes", async () => {
  const props = { src: "https://example.test/video.mp4", isActive: false, soundEnabled: false };
  await act(async () => root.render(createElement(VideoCard, props)));
  expect(container.querySelector("video")?.muted).toBe(true);
  await click(button("Unmute video"));
  expect(container.querySelector("video")?.muted).toBe(false);
  await act(async () => root.render(createElement(VideoCard, { ...props, caption: "unchanged sound" })));
  expect(container.querySelector("video")?.muted).toBe(false);
  await act(async () => root.render(createElement(VideoCard, { ...props, soundEnabled: true })));
  await act(async () => root.render(createElement(VideoCard, props)));
  expect(container.querySelector("video")?.muted).toBe(true);
});

test("follow success survives unchanged props and a different creator resets the button", async () => {
  fetchMock.mockResolvedValue(response({ success: true, following: true }));
  await act(async () => root.render(createElement(FollowButton, { creatorId: "creator-a", initialFollowing: false })));
  await click(container.querySelector("button")!);
  expect(container.textContent).toBe("Following");
  await act(async () => root.render(createElement(FollowButton, { creatorId: "creator-a", initialFollowing: false })));
  expect(container.textContent).toBe("Following");
  await act(async () => root.render(createElement(FollowButton, { creatorId: "creator-b", initialFollowing: false })));
  expect(container.textContent).toBe("Follow");
});

test("follow failure restores the original button", async () => {
  const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(window, "alert").mockImplementation(() => {});
  fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "test rejection" }) });
  await act(async () => root.render(createElement(FollowButton, { creatorId: "creator-a", initialFollowing: false })));
  await click(container.querySelector("button")!);
  expect(container.textContent).toBe("Follow");
  expect(errorLog).toHaveBeenCalled();
});

test("composer disables its product selector until products finish loading", async () => {
  userCtx.userId = "creator";
  let release!: (value: unknown) => void;
  fetchMock.mockImplementation((url: string) => url === "/api/products"
    ? new Promise((resolve) => { release = resolve; })
    : Promise.resolve(response({ onboarding_complete: true })));
  await act(async () => root.render(createElement(PostComposer)));
  await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  expect(container.querySelector("select")?.disabled).toBe(true);
  await act(async () => release(response({ items: [{ id: "p1", title: "Test course", type: "course", price_cents: 10000 }] })));
  expect(container.querySelector("select")?.disabled).toBe(false);
  expect(container.textContent).toContain("Test course");
});

test.each([false, true])("a failed Connect readiness response clears a pending paid attachment (network failure: %s)", async (networkFailure) => {
  userCtx.userId = "creator";
  let release!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  fetchMock.mockImplementation((url: string) => url === "/api/stripe/connect/status"
    ? new Promise((resolve, fail) => { release = resolve; reject = fail; })
    : Promise.resolve(response({ items: [] })));
  await act(async () => root.render(createElement(PostComposer)));
  await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  const price = container.querySelector<HTMLInputElement>('input[placeholder="Optional, e.g. 25 for $25"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(price, "100");
    price.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(price.value).toBe("100");
  await act(async () => networkFailure ? reject(new Error("test offline")) : release(response({ onboarding_complete: false })));
  const attach = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(attach.checked).toBe(false);
  expect(attach.disabled).toBe(true);
  expect(container.querySelector("select")).toBeNull();
  expect(price.value).toBe("");
  expect(price.disabled).toBe(true);
});
