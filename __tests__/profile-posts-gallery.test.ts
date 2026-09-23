/**
 * @jest-environment jsdom
 */
/**
 * Profile gallery modal render window (Noah #2, profile video choppiness).
 *
 * The feed and the profile modal share one player (components/VideoCard),
 * which mounts a <video preload="metadata"> plus its own observers. The feed
 * only mounts VideoCards inside `isWithinRenderWindow` (lib/feedV3, PR #102);
 * the profile modal used to mount one per post, so a creator with N posts
 * opened N media requests at once and then smooth-scrolled through all of
 * them to the clicked one.
 *
 * These tests render the REAL ProfilePostsGallery with VideoCard stubbed to
 * a marker element and assert the window: with 12 posts and the 6th clicked,
 * at most 5 VideoCards mount (indexes 3..7) and aria-hidden placeholders fill
 * the rest; with 3 posts every post mounts. They also pin the initial
 * alignment to `behavior: "instant"` so the open jump no longer animates.
 */

import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

type StubVideoCardProps = {
  postId?: string | null; onDeleted?: () => void;
  mainFeedMobileLayout?: boolean; creatorVerified?: boolean;
  fillMobileViewport?: boolean;
  desktopFeedMediaKey?: string; desktopFeedUseNaturalFrame?: boolean;
  onDesktopFeedRatio?: (mediaKey: string, ratio: number) => void;
  caption?: string; titleForCheckout?: string;
};

jest.mock("@/components/VideoCard", () => ({
  __esModule: true,
  default: (props: StubVideoCardProps) =>
    createElement("div", {
      "data-testid": "video-card",
      "data-post-id": props.postId ?? "",
      "data-feed-style": props.mainFeedMobileLayout,
      "data-full-mobile-height": props.fillMobileViewport,
      "data-verified": props.creatorVerified,
      "data-media-key": props.desktopFeedMediaKey,
      "data-natural-frame": props.desktopFeedUseNaturalFrame,
      "data-caption": props.caption,
      "data-checkout-title": props.titleForCheckout,
      onClick: props.onDeleted,
      onDoubleClick: () => props.onDesktopFeedRatio?.(props.desktopFeedMediaKey ?? "", 1),
    }),
}));

// BackButton (rendered inside the modal) reads next/navigation's router.
jest.mock("next/navigation", () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));

// lib/posthog constructs the posthog-js client at module scope; the gallery
// only needs normalizeCategory from it.
jest.mock("@/lib/posthog", () => ({
  normalizeCategory: (raw: string | null | undefined) => raw ?? null,
}));

// Imported after the mocks above are registered (jest hoists the factories).
import ProfilePostsGallery from "@/components/ProfilePostsGallery";
import { RENDER_WINDOW_RADIUS } from "@/lib/feedV3";

// react-dom/client refuses act() outside a marked act environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const MAX_MOUNTED = 2 * RENDER_WINDOW_RADIUS + 1;

const observe = jest.fn();
const disconnect = jest.fn();

class IntersectionObserverStub {
  observe = observe;
  unobserve = jest.fn();
  disconnect = disconnect;
  takeRecords = () => [];
}

const scrollIntoView = jest.fn();

const makePosts = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `post-${i}`,
    title: `Post ${i}`,
    video_url: `https://cdn.example/${i}.mp4`,
    poster_url: null,
  }));

const mountedIndexes = (): number[] =>
  Array.from(document.querySelectorAll("[data-index]"))
    .filter((wrapper) => wrapper.querySelector('[data-testid="video-card"]'))
    .map((wrapper) => Number(wrapper.getAttribute("data-index")));

const placeholderIndexes = (): number[] =>
  Array.from(document.querySelectorAll("[data-index]"))
    .filter(
      (wrapper) =>
        !wrapper.querySelector('[data-testid="video-card"]') &&
        wrapper.querySelector('[aria-hidden="true"]')
    )
    .map((wrapper) => Number(wrapper.getAttribute("data-index")));

describe("ProfilePostsGallery modal render window", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
      IntersectionObserverStub;
    Element.prototype.scrollIntoView = scrollIntoView;
    // Run rAF callbacks synchronously so the initial alignment happens
    // inside act() and the observer gate (alignedRef) opens deterministically.
    (globalThis as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
      .requestAnimationFrame = (cb) => {
      cb(0);
      return 0;
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
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

  const renderAndOpen = async (postCount: number, clickIndex: number) => {
    await act(async () => {
      root.render(
        createElement(ProfilePostsGallery, {
          posts: makePosts(postCount),
          creatorId: "creator-1",
          creatorName: "Creator",
        })
      );
    });

    const tiles = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Open post:"]'
    );
    expect(tiles).toHaveLength(postCount);

    await act(async () => {
      tiles[clickIndex].click();
    });
  };

  test("with 12 posts and the 6th opened, at most 5 VideoCards mount and placeholders fill the rest", async () => {
    // Arrange + Act
    await renderAndOpen(12, 5);

    // Assert: every post still has its snap/observer wrapper...
    expect(document.querySelectorAll("[data-index]")).toHaveLength(12);

    // ...but only the window around the active post carries a VideoCard.
    const mounted = mountedIndexes();
    expect(mounted.length).toBeLessThanOrEqual(MAX_MOUNTED);
    expect(mounted).toEqual([3, 4, 5, 6, 7]);

    // The other seven are aria-hidden placeholders, not missing nodes.
    expect(placeholderIndexes()).toEqual([0, 1, 2, 8, 9, 10, 11]);
  });

  test("placeholders keep VideoCard's root height classes so snap geometry matches", async () => {
    // Arrange + Act
    await renderAndOpen(12, 5);

    // Assert: the placeholder mirrors VideoCard's root height classes
    // (components/VideoCard.tsx root <div>) — a mismatch breaks snap points
    // and the close-to-tile scroll, which index into the same slots.
    const placeholder = document
      .querySelector('[data-index="0"]')
      ?.querySelector('[aria-hidden="true"]');
    expect(placeholder).not.toBeNull();
    for (const cls of [
      "max-lg:h-[100dvh]",
      "lg:h-[100dvh]",
      "lg:min-h-[100dvh]",
    ]) {
      expect(placeholder!.classList.contains(cls)).toBe(true);
    }
  });

  test("with 3 posts every post mounts a VideoCard", async () => {
    // Arrange + Act
    await renderAndOpen(3, 1);

    // Assert
    expect(mountedIndexes()).toEqual([0, 1, 2]);
    expect(placeholderIndexes()).toEqual([]);
  });

  test("opened profile posts use feed styling and retain a measured square desktop frame", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    await act(async () => window.dispatchEvent(new Event("resize")));
    await renderAndOpen(3, 1);
    const card = container.querySelector<HTMLElement>('[data-post-id="post-1"]')!;
    expect(card.getAttribute("data-feed-style")).toBe("true");
    expect(card.getAttribute("data-full-mobile-height")).toBe("true");
    expect(card.getAttribute("data-media-key")).toBe("https://cdn.example/1.mp4");
    expect(card.getAttribute("data-natural-frame")).toBe("false");
    expect(card.getAttribute("data-caption")).toBe("");
    expect(card.getAttribute("data-checkout-title")).toBe("Post 1");
    expect(card.closest('[data-index="1"]')?.classList.contains("h-[100dvh]")).toBe(true);
    await act(async () => card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector('[data-post-id="post-1"]')?.getAttribute("data-natural-frame")).toBe("true");
  });

  test("successful deletion closes the player and removes just that profile tile", async () => {
    await renderAndOpen(3, 1);
    await act(async () => { (container.querySelector('[data-testid="video-card"]') as HTMLElement).click(); });
    expect(container.querySelectorAll('button[aria-label^="Open post:"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="video-card"]')).toBeNull();
  });

  test("observes every wrapper (placeholders included) and jumps instantly to the clicked post", async () => {
    // Arrange + Act
    await renderAndOpen(12, 5);

    // Assert: the gallery observer still sees all 12 slots...
    expect(observe).toHaveBeenCalledTimes(12);

    // ...and the initial alignment is an instant jump, not a smooth scroll
    // through posts 0..4.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: "center", behavior: "instant" })
    );
    const target = scrollIntoView.mock.instances[0] as Element;
    expect(target.getAttribute("data-index")).toBe("5");
  });
});
