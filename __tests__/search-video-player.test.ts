/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SearchPost } from "@/lib/searchTypes";
import type { PostRow } from "@/lib/feedV3";
import { loadSearchVideos } from "@/lib/searchVideoPlayer";
import SearchVideoPlayer from "@/components/SearchVideoPlayer";

jest.mock("@/lib/searchVideoPlayer", () => ({ loadSearchVideos: jest.fn() }));
jest.mock("@/lib/posthog", () => ({ normalizeCategory: (value: unknown) => value }));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: ({ onClick }: { onClick: () => void }) => createElement("button", { onClick }, "Back") }));
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: (props: Record<string, unknown>) => createElement("div", {
  "data-video": props.postId, "data-active": props.isActive, "data-liked": props.isLiked,
  "data-product": props.productId, "data-ready": props.purchaseOptionsReady,
}, createElement("a", { href: `/profile/${props.creatorUsername}` }, String(props.creatorName))) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
let intersection: IntersectionObserverCallback;
const scroll = jest.fn();
const loadMore = jest.fn();
const onClose = jest.fn();
const onDeleted = jest.fn();
const retry = jest.fn();
const results = (count: number): SearchPost[] => Array.from({ length: count }, (_, index) => ({
  id: `p${index}`, creator_id: `c${index}`, creator: { username: `creator${index}` },
  caption: `Video ${index}`, content: null, media_url: `https://example.com/${index}.mp4`, poster_url: null,
}));
const metadata = (posts: SearchPost[]): PostRow[] => posts.map(post => ({
  id: post.id, creator_id: post.creator_id, creator_username: post.creator.username,
  creator_name: post.creator.username, product_id: "offer", purchaseOptionsReady: true,
  price_cents: 500, title: post.caption, content: null, video_url: post.media_url,
  poster_url: null, interests: [], created_at: null, is_liked: true,
}));
const render = async (posts: SearchPost[], initialIndex = 0, hasMore = false) => {
  await act(async () => root.render(createElement(SearchVideoPlayer, {
    posts, initialIndex, hasMore, onClose, onDeleted, loadMore, retry, loading: false, error: "",
  })));
};
beforeEach(() => {
  jest.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe() {} disconnect() {}
  } });
  Element.prototype.scrollTo = scroll;
  window.scrollTo = jest.fn();
  window.requestAnimationFrame = callback => { callback(0); return 1; };
  window.cancelAnimationFrame = jest.fn();
  jest.mocked(loadSearchVideos).mockImplementation(async posts => metadata(posts));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.style.overflow = ""; });

test("opens the selected result with the shared player and hydrates creator, likes and offer controls", async () => {
  await render(results(2), 1);
  expect(host.querySelector('[data-video="p1"]')?.getAttribute("data-active")).toBe("true");
  expect(host.querySelector('[data-video="p0"]')?.getAttribute("data-active")).toBe("false");
  expect(host.querySelector('[data-video="p1"] a')?.getAttribute("href")).toBe("/profile/creator1");
  expect(host.querySelector('[data-video="p1"]')?.getAttribute("data-liked")).toBe("true");
  expect(host.querySelector('[data-video="p1"]')?.getAttribute("data-product")).toBe("offer");
  expect(host.querySelector('[data-video="p1"]')?.getAttribute("data-ready")).toBe("true");
  expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: "instant" }));
  expect(host.querySelectorAll("[data-video]")).toHaveLength(2);
});

test("scrolling changes the active video and only mounts a small window of search results", async () => {
  await render(results(12), 6);
  expect(host.querySelectorAll("[data-video]").length).toBeLessThanOrEqual(5);
  const next = host.querySelector('[data-index="7"]')!;
  await act(async () => intersection([{ target: next, isIntersecting: true, intersectionRatio: 0.9 } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(host.querySelector('[data-video="p7"]')?.getAttribute("data-active")).toBe("true");
  expect(host.querySelector('[data-video="p6"]')?.getAttribute("data-active")).toBe("false");
});

test("near the end loads more matching results once and appended results stay in the same player", async () => {
  await render(results(2), 1, true);
  expect(loadMore).toHaveBeenCalledTimes(1);
  await render(results(2), 1, true);
  expect(loadMore).toHaveBeenCalledTimes(1);
  await render(results(4), 1, false);
  expect(host.querySelector('[data-video="p1"]')?.getAttribute("data-active")).toBe("true");
  expect(host.querySelector('[data-video="p2"]')).not.toBeNull();
});

test("Back, Close and Escape dismiss; unmount restores the original scroll lock and focus", async () => {
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  document.body.style.overflow = "auto";
  await render(results(2));
  expect(document.body.style.overflow).toBe("hidden");
  await act(async () => (host.querySelector('button[aria-label="Close video player"]') as HTMLButtonElement).click());
  await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(onClose).toHaveBeenCalledTimes(3);
  await act(async () => root.render(null));
  expect(document.body.style.overflow).toBe("auto");
  expect(document.activeElement).toBe(trigger);
  expect(window.scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: "instant" });
  trigger.remove();
});

test("a failed metadata request has a retry and never renders a guessed empty heart", async () => {
  jest.mocked(loadSearchVideos).mockRejectedValueOnce(new Error("offline"));
  await render(results(1));
  expect(host.querySelector("[data-video]")).toBeNull();
  expect(host.textContent).toContain("Couldn’t load this video.");
  const button = Array.from(host.querySelectorAll("button")).find(element => element.textContent === "Try again")!;
  await act(async () => button.click());
  expect(host.querySelector('[data-video="p0"]')).not.toBeNull();
});

test("removed results are unavailable instead of playing stale search media", async () => {
  jest.mocked(loadSearchVideos).mockResolvedValue([]);
  await render(results(1));
  expect(host.textContent).toContain("This video is no longer available.");
  expect(host.querySelector("[data-video]")).toBeNull();
});
