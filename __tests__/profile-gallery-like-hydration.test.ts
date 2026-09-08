/**
 * @jest-environment jsdom
 */
/**
 * components/ProfilePostsGallery.tsx — the heart must know it is already filled.
 *
 * The gallery never passed `isLiked`, so VideoCard fell back to its `false`
 * default and every heart on a profile rendered empty. /api/likes toggles
 * server-side, so a fan who had already liked a post tapped a hollow heart and
 * silently DELETED their like — the creator's like count went down. Production
 * has 40 like rows, so this was reachable.
 *
 * Mutation check: remove `isLiked={likedIds.has(post.id)}` from the gallery and
 * the first test fails.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const seen: Array<{ postId: string; isLiked: unknown }> = [];

jest.mock("@/components/VideoCard", () => ({
  __esModule: true,
  default: (props: { postId: string; isLiked?: boolean }) => {
    seen.push({ postId: props.postId, isLiked: props.isLiked });
    return null;
  },
}));
jest.mock("@/lib/posthog", () => ({
  trackEvent: jest.fn(),
  normalizeCategory: (raw: string | null) => raw,
}));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children?: unknown }) =>
    createElement("a", { href }, children as never),
}));

import ProfilePostsGallery from "@/components/ProfilePostsGallery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has neither of these; the gallery builds an observer once it opens.
class StubIO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): unknown[] {
    return [];
  }
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ?? StubIO;
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

const POSTS = [
  { id: "liked_post", creator_id: "c1", title: "One", video_url: "https://x.invalid/a.mp4", poster_url: null },
  { id: "unliked_post", creator_id: "c1", title: "Two", video_url: "https://x.invalid/b.mp4", poster_url: null },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  seen.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  document.body.style.overflow = "";
});

async function openGallery(likedPostIds?: string[]) {
  await act(async () => {
    root.render(
      createElement(ProfilePostsGallery, {
        posts: POSTS as never,
        creatorId: "c1",
        creatorName: "Creator",
        likedPostIds,
      })
    );
  });
  // open the modal so the cards actually mount
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement | null)?.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

test("a post the viewer already liked mounts with isLiked true", async () => {
  await openGallery(["liked_post"]);

  const liked = seen.find((c) => c.postId === "liked_post");
  const unliked = seen.find((c) => c.postId === "unliked_post");
  expect(liked).toBeDefined();
  expect(liked?.isLiked).toBe(true);
  expect(unliked?.isLiked).toBe(false);
});

test("with no likedPostIds every card is unliked (no false positives)", async () => {
  await openGallery(undefined);

  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((c) => c.isLiked === false)).toBe(true);
});
