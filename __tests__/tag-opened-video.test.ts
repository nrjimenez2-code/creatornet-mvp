/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("next/navigation", () => ({ useParams: () => ({ hashtag: "trading" }) }));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/posthog", () => ({ normalizeCategory: (value: unknown) => value }));
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: (props: Record<string, unknown>) => createElement("div", {
  "data-opened-video": props.postId,
  "data-caption": props.caption,
  "data-verified": props.creatorVerified,
  "data-feed-style": props.mainFeedMobileLayout,
  "data-full-mobile-height": props.fillMobileViewport,
}) }));

import TagFeedPage from "@/app/tag/[hashtag]/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("opened hashtag video shows the feed title instead of repeating its raw hashtag caption", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const originalFetch = global.fetch;
  const originalObserver = global.IntersectionObserver;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const originalRaf = window.requestAnimationFrame;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [{
    id: "post-1", title: "demo", content: "#trading", video_url: "video.mp4", poster_url: null,
    creator_id: "creator-1", creator: { username: "noah", full_name: "Noah", avatar_url: null, verified: true },
    interests: ["trading"], hashtags: ["trading"],
  }], hasMore: false, nextOffset: 1 }) })) as unknown as typeof fetch;
  global.IntersectionObserver = class { observe() {} disconnect() {} } as unknown as typeof IntersectionObserver;
  Element.prototype.scrollIntoView = jest.fn();
  window.requestAnimationFrame = callback => { callback(0); return 1; };
  try {
    await act(async () => root.render(createElement(TagFeedPage)));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open post: demo"]')!.click());
    const opened = host.querySelector<HTMLElement>('[data-opened-video="post-1"]')!;
    expect(opened.getAttribute("data-caption")).toBe("demo");
    expect(opened.getAttribute("data-verified")).toBe("true");
    expect(opened.getAttribute("data-feed-style")).toBe("true");
    expect(opened.getAttribute("data-full-mobile-height")).toBe("true");
    expect(opened.closest('[data-index="0"]')?.classList.contains("h-[100dvh]")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    global.fetch = originalFetch;
    global.IntersectionObserver = originalObserver;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    window.requestAnimationFrame = originalRaf;
    document.body.style.overflow = "";
  }
});
