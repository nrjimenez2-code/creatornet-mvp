/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const viewer = { userId: "viewer", loading: false };
const channel = { on: jest.fn().mockReturnThis(), subscribe: jest.fn().mockReturnThis() };
const client = { channel: () => channel, removeChannel: jest.fn() };
jest.mock("@/lib/useUser", () => ({ useUser: () => viewer }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => client }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (value: string) => value }));
jest.mock("@/lib/feedOffers", () => ({ loadFeedOffers: async () => [] }));
jest.mock("@/lib/browserVisibility", () => ({ useDesktopViewport: () => true, usePageVisible: () => true }));
jest.mock("@/components/VideoCard", () => ({
  __esModule: true,
  default: ({ postId, activeTab, isActive }: { postId: string; activeTab: string; isActive: boolean }) =>
    createElement("video", { "data-card-id": postId, "data-tab": activeTab, "data-active": String(isActive) }),
}));
// Keep the real feed transport: these tests verify that the request actually
// receives cancellation, as well as checking the component's rendered state.
import FeedList from "@/components/FeedList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class Observer {
  static instances: Observer[] = [];
  nodes = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) {
    Observer.instances.push(this);
  }
  observe(node: Element) { this.nodes.add(node); }
  unobserve(node: Element) { this.nodes.delete(node); }
  disconnect() { this.disconnected = true; this.nodes.clear(); }
  activate(node: Element) {
    this.callback([{ target: node, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
globalThis.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
const fetchMock = jest.fn();
type Page = { items: ReturnType<typeof rows>; session: string; nextOffset: number; hasMore: boolean; actorToken: string };
const response = (page: Page) => ({ ok: true, json: async () => page });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
function rows(prefix: string, count = 4) {
  return Array.from({ length: count }, (_, index) => ({ post_id: `${prefix}-${index}`, creator_id: "creator", title: `${prefix}-${index}`, video_url: "https://example.test/video.mp4" }));
}
function page(prefix: string, count = 4, more = false, offset = count): Page {
  return { items: rows(prefix, count), session: `${prefix}-session`, actorToken: `${prefix}-token`, nextOffset: offset, hasMore: more };
}
let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
const render = async (tab: "discover" | "following") => {
  await act(async () => root.render(createElement(FeedList, { activeTab: tab, onChangeTab: jest.fn() })));
};
const request = (index: number) => ({
  url: new URL(fetchMock.mock.calls[index][0], "https://example.test"),
  signal: fetchMock.mock.calls[index][1].signal as AbortSignal,
});
async function activate(id: string) {
  const node = container.querySelector(`[data-post-id="${id}"]`)!;
  const observer = Observer.instances.find(instance => !instance.disconnected && instance.nodes.has(node))!;
  expect(observer).toBeDefined();
  await act(async () => observer.activate(node));
}
beforeEach(() => {
  viewer.userId = "viewer";
  viewer.loading = false;
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  Observer.instances = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
  Element.prototype.scrollIntoView = jest.fn();
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

test("a loaded tab cannot keep playing under a pending tab; identical IDs get a new observed scroll root", async () => {
  const following = deferred<ReturnType<typeof response>>();
  fetchMock.mockResolvedValueOnce(response(page("shared"))).mockReturnValueOnce(following.promise);
  await render("discover");
  expect(container.querySelectorAll("video")).toHaveLength(3);
  const oldRoot = Observer.instances[0].options.root;
  const oldSignal = request(0).signal;
  await render("following");
  expect(container.textContent).toContain("Loading");
  expect(container.querySelector("video")).toBeNull();
  expect(oldSignal.aborted).toBe(true);
  expect(request(1).signal.aborted).toBe(false);
  await act(async () => following.resolve(response(page("shared"))));
  expect(container.querySelector('video[data-tab="following"]')).not.toBeNull();
  const currentObserver = Observer.instances.find(instance => !instance.disconnected)!;
  expect(currentObserver.options.root).not.toBe(oldRoot);
  await activate("shared-2");
  expect(container.querySelector('video[data-card-id="shared-2"]')?.getAttribute("data-active")).toBe("true");
  expect(container.querySelectorAll("video").length).toBeLessThanOrEqual(5);
});

test("an obsolete pagination response cannot append items or replace the new tab's cursor", async () => {
  const oldMore = deferred<ReturnType<typeof response>>();
  const followingMore = deferred<ReturnType<typeof response>>();
  fetchMock.mockResolvedValueOnce(response(page("discover", 20, true)))
    .mockReturnValueOnce(oldMore.promise)
    .mockResolvedValueOnce(response(page("following", 20, true)))
    .mockReturnValueOnce(followingMore.promise);
  await render("discover");
  await activate("discover-18");
  expect(request(1).url.searchParams.get("offset")).toBe("20");
  expect(request(1).signal).toBe(request(0).signal);
  await render("following");
  expect(request(1).signal.aborted).toBe(true);
  await act(async () => oldMore.resolve(response(page("obsolete", 4, false, 999))));
  expect(container.querySelector('[data-post-id="obsolete-0"]')).toBeNull();
  expect(container.querySelector('[data-post-id="following-0"]')).not.toBeNull();
  await activate("following-18");
  expect(request(3).url.searchParams.get("offset")).toBe("20");
  expect(request(3).url.searchParams.get("session")).toBe("following-session");
  expect(request(3).signal.aborted).toBe(false);
  expect(container.querySelectorAll("video").length).toBeLessThanOrEqual(5);
});

test("authentication changes abort a pending read and ignore its late completion", async () => {
  const oldPage = deferred<ReturnType<typeof response>>();
  fetchMock.mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce(response(page("new-viewer")));
  await render("discover");
  viewer.userId = "new-viewer";
  await render("discover");
  expect(request(0).signal.aborted).toBe(true);
  await act(async () => oldPage.resolve(response(page("old-viewer"))));
  expect(container.querySelector('[data-post-id="old-viewer-0"]')).toBeNull();
  expect(container.querySelector('[data-post-id="new-viewer-0"]')).not.toBeNull();
});

test("unmount aborts the active pagination transport", async () => {
  fetchMock.mockResolvedValueOnce(response(page("leaving", 20, true))).mockReturnValueOnce(new Promise(() => {}));
  await render("discover");
  await activate("leaving-18");
  expect(request(1).signal.aborted).toBe(false);
  await act(async () => root.unmount());
  mounted = false;
  expect(request(1).signal.aborted).toBe(true);
});

test("a failed current page retries its existing session and offset without losing the loaded feed", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  const retried = deferred<ReturnType<typeof response>>();
  fetchMock.mockResolvedValueOnce(response(page("retry", 20, true)))
    .mockResolvedValueOnce({ok:false,status:503,json:async()=>({error:'Could not load this feed. Refresh to try again.'})})
    .mockReturnValueOnce(retried.promise);
  await render("discover");
  await activate("retry-18");
  expect(container.querySelector('[data-post-id="retry-18"]')).not.toBeNull();
  const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Retry"))!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(request(2).url.searchParams.get("session")).toBe("retry-session");
  expect(request(2).url.searchParams.get("offset")).toBe("20");
  expect(request(2).signal).toBe(request(1).signal);
  expect(request(2).signal.aborted).toBe(false);
  await act(async () => retried.resolve(response(page("next", 4, false, 24))));
  expect(container.querySelector('[data-post-id="next-0"]')).not.toBeNull();
  expect(container.querySelectorAll("section[data-post-id]")).toHaveLength(24);
  expect(container.textContent).not.toContain("Couldn’t load more");
});

test("an unavailable snapshot waits for an explicit refresh, which replaces the feed and starts at offset zero", async () => {
  const refreshed = deferred<ReturnType<typeof response>>();
  fetchMock.mockResolvedValueOnce(response(page("expired", 20, true)))
    .mockResolvedValueOnce({ok:false,status:410,json:async()=>({error:'This feed needs to be refreshed.',code:'DISCOVER_SESSION_UNAVAILABLE'})})
    .mockReturnValueOnce(refreshed.promise)
    .mockReturnValueOnce(new Promise(() => {}));
  await render("discover");
  await activate("expired-18");
  expect(container.querySelector('[data-post-id="expired-18"]')).not.toBeNull();
  const refresh = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Refresh feed to continue")!;
  expect(refresh).toBeDefined();
  expect(container.textContent).not.toContain("Retry");
  await activate("expired-19");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => refresh.click());
  expect(request(2).url.searchParams.get("offset")).toBe("0");
  expect(request(2).url.searchParams.has("session")).toBe(false);
  expect(request(1).signal.aborted).toBe(true);
  expect(container.textContent).toContain("Loading");
  expect(container.querySelector("video")).toBeNull();
  await act(async () => refreshed.resolve(response(page("fresh",20,true))));
  expect(container.querySelector('[data-post-id="expired-0"]')).toBeNull();
  expect(container.querySelectorAll("section[data-post-id]")).toHaveLength(20);
  expect(container.querySelector('video[data-card-id="fresh-0"]')?.getAttribute("data-active")).toBe("true");
  await activate("fresh-18");
  expect(request(3).url.searchParams.get("session")).toBe("fresh-session");
  expect(request(3).url.searchParams.get("offset")).toBe("20");
  expect(request(3).signal.aborted).toBe(false);
});
