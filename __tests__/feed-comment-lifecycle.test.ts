/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

const userCtx: { userId: string | null; loading: boolean; session: null } = { userId: null, loading: false, session: null };
const mockRpc = jest.fn();
const channel = { on: jest.fn().mockReturnThis(), subscribe: jest.fn().mockReturnThis() };
const mockClient = { ...createMockClient(), rpc: mockRpc, channel: () => channel, removeChannel: jest.fn() };
let hashtag = "sales";
jest.mock("@/lib/useUser", () => ({ useUser: () => userCtx }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (v: string) => v }));
jest.mock("next/navigation", () => ({ useParams: () => ({ hashtag }), useRouter: () => ({ back: jest.fn() }) }));
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: ({ title, caption }: { title?: string; caption?: string }) => createElement("p", null, title ?? caption) }));
import CommentPanel from "@/components/CommentPanel";
import FeedList from "@/components/FeedList";
import TagFeedPage from "@/app/tag/[hashtag]/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopObserver { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = NoopObserver;
let container: HTMLDivElement;
let root: Root;
const fetchMock = jest.fn();
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
const comment = (content: string) => ({ id: content, user_id: "someone", content, created_at: "2026-09-04T12:00:00Z", user: { id: "someone", username: "test", full_name: null, avatar_url: null } });
const feedRow = (title: string) => ({ post_id: title, creator_id: "creator", title, video_url: "https://example.test/v.mp4", created_at: "2026-09-04T12:00:00Z" });
beforeEach(() => {
  userCtx.userId = null;
  userCtx.loading = false;
  hashtag = "sales";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockRpc.mockReset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  Element.prototype.scrollIntoView = jest.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

test("comments show loading and a late response cannot overwrite another post", async () => {
  const first = deferred<ReturnType<typeof response>>();
  const second = deferred<ReturnType<typeof response>>();
  fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await act(async () => root.render(createElement(CommentPanel, { postId: "a", isOpen: true, onClose: jest.fn() })));
  expect(container.textContent).toContain("Loading comments...");
  const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  await act(async () => root.render(createElement(CommentPanel, { postId: "b", isOpen: true, onClose: jest.fn() })));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => second.resolve(response({ success: true, comments: [comment("current post comment")] })));
  await act(async () => first.resolve(response({ success: true, comments: [comment("stale post comment")] })));
  expect(container.textContent).toContain("current post comment");
  expect(container.textContent).not.toContain("stale post comment");
});

test("a comment retry shows loading, then only the successful result", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  const retry = deferred<ReturnType<typeof response>>();
  fetchMock.mockResolvedValueOnce(response({ success: false, error: "test failure" }, false)).mockReturnValueOnce(retry.promise);
  await act(async () => root.render(createElement(CommentPanel, { postId: "a", isOpen: true, onClose: jest.fn() })));
  expect(container.textContent).not.toContain("No comments yet");
  const retryButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Try again"));
  expect(retryButton).toBeDefined();
  await act(async () => retryButton!.click());
  expect(container.textContent).toContain("Loading comments...");
  await act(async () => retry.resolve(response({ success: true, comments: [] })));
  expect(container.textContent).toContain("No comments yet");
});

test("closing and reopening comments retains that post's unsent draft", async () => {
  userCtx.userId = "viewer";
  fetchMock.mockResolvedValue(response({ success: true, comments: [] }));
  const props = { postId: "a", isOpen: true, onClose: jest.fn() };
  await act(async () => root.render(createElement(CommentPanel, props)));
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Add a comment..."]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "my unsent draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => root.render(createElement(CommentPanel, { ...props, isOpen: false })));
  await act(async () => root.render(createElement(CommentPanel, props)));
  expect(container.querySelector<HTMLInputElement>('input[placeholder="Add a comment..."]')?.value).toBe("my unsent draft");
});

test("feed tab changes show loading, and stale results never replace the new tab", async () => {
  userCtx.userId = "viewer";
  const first = deferred<{ data: unknown; error: null }>();
  const second = deferred<{ data: unknown; error: null }>();
  mockRpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await act(async () => root.render(createElement(FeedList, { activeTab: "discover", onChangeTab: jest.fn() })));
  expect(container.textContent).toContain("Loading");
  await act(async () => root.render(createElement(FeedList, { activeTab: "following", onChangeTab: jest.fn() })));
  expect(container.textContent).toContain("Loading");
  await act(async () => second.resolve({ data: [feedRow("Following result")], error: null }));
  await act(async () => first.resolve({ data: [feedRow("Stale discover result")], error: null }));
  expect(container.textContent).toContain("Following result");
  expect(container.textContent).not.toContain("Stale discover result");
});

test("feed waits for authentication and handles signed-out following without a request", async () => {
  userCtx.loading = true;
  const props = { activeTab: "following" as const, onChangeTab: jest.fn() };
  await act(async () => root.render(createElement(FeedList, props)));
  expect(container.textContent).toContain("Loading");
  expect(mockRpc).not.toHaveBeenCalled();
  userCtx.loading = false;
  await act(async () => root.render(createElement(FeedList, props)));
  expect(container.textContent).not.toContain("Loading");
  expect(mockRpc).not.toHaveBeenCalled();
});

test("a new hashtag resets its feed and discards the old request", async () => {
  const first = deferred<ReturnType<typeof response>>();
  const second = deferred<ReturnType<typeof response>>();
  fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await act(async () => root.render(createElement(TagFeedPage)));
  const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  hashtag = "fitness";
  await act(async () => root.render(createElement(TagFeedPage)));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => second.resolve(response({ items: [], hasMore: false })));
  await act(async () => first.resolve(response({ items: [{ id: "old", title: "stale sales post", video_url: "https://example.test/video.mp4", creator_id: "creator" }], hasMore: false })));
  expect(container.textContent).toContain("fitness");
  expect(container.textContent).not.toContain("stale sales post");
});
