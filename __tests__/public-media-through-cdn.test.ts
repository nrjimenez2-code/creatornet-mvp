/**
 * @jest-environment jsdom
 */
/**
 * Public media goes through the CDN, never the raw bucket.
 *
 * The feed rewrites every public video and poster from the R2 bucket's
 * `pub-….r2.dev` origin to `https://media.creatornet.net` (lib/feedMedia).
 * Cloudflare documents `r2.dev` as a non-production, rate-limited URL. The
 * creator-page gallery, the search results and the hashtag pages render the
 * same posts as plain tiles and used to pass the stored bucket URL straight
 * to <img>/<video>, so under real traffic those thumbnails would be the first
 * thing to throttle. These tests render the REAL ProfilePostsGallery and pin
 * the tile sources to the CDN, and pin the two page files that build tiles
 * the same way.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

jest.mock("@/components/VideoCard", () => ({
  __esModule: true,
  default: () => createElement("div", { "data-testid": "video-card" }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/lib/posthog", () => ({
  normalizeCategory: (raw: string | null | undefined) => raw ?? null,
}));

import ProfilePostsGallery from "@/components/ProfilePostsGallery";
import { FEED_MEDIA_ORIGIN } from "@/lib/feedMedia";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUCKET = "https://pub-91a8d994910d498d90b109487939e1db.r2.dev";
const posts = [
  { id: "poster", title: "poster", poster_url: `${BUCKET}/thumbnails/c1/1.jpg`, video_url: `${BUCKET}/videos/c1/1.mp4` },
  { id: "video-only", title: "video only", poster_url: null, video_url: `${BUCKET}/videos/c1/2.mp4` },
  { id: "third-party", title: "third party", poster_url: "https://example.com/p.jpg", video_url: "https://example.com/v.mp4" },
];

describe("public tiles load media through the CDN", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeAll(() => {
    class IntersectionObserverStub {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
      takeRecords = () => [];
    }
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = IntersectionObserverStub;
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
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

  test("creator gallery tiles use media.creatornet.net for bucket posters and videos", async () => {
    await act(async () => {
      root.render(createElement(ProfilePostsGallery, { posts, creatorId: "creator-1", creatorName: "Creator" }));
    });
    const tiles = Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-label^='Open post']"));
    expect(tiles).toHaveLength(3);

    const poster = tiles[0].querySelector("img");
    expect(poster?.getAttribute("src")).toBe(`${FEED_MEDIA_ORIGIN}/thumbnails/c1/1.jpg`);

    const video = tiles[1].querySelector("video");
    expect(video?.getAttribute("src")).toBe(`${FEED_MEDIA_ORIGIN}/auto/videos/c1/2.mp4`);

    // Third-party sources are not ours to rewrite.
    expect(tiles[2].querySelector("img")?.getAttribute("src")).toBe("https://example.com/p.jpg");

    for (const el of container.querySelectorAll("img, video")) {
      expect(el.getAttribute("src") ?? "").not.toContain("r2.dev");
    }
  });

  test("search and hashtag tiles are built the same way", () => {
    const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
    const search = read("app/search/page.tsx");
    const tag = read("app/tag/[hashtag]/page.tsx");
    const gallery = read("components/ProfilePostsGallery.tsx");

    for (const source of [search, tag, gallery]) {
      expect(source).toContain('from "@/lib/feedMedia"');
      expect(source).not.toMatch(/src=\{(p|post)\.(poster_url|media_url|video_url)\}/);
    }
    expect(search).toContain("src={feedPosterUrl(p.poster_url)}");
    expect(search).toContain("src={feedMediaUrl(p.media_url)}");
    // Search opens the full feed; it no longer has a separate video detail modal.
    expect(tag).toContain("src={feedPosterUrl(p.poster_url)}");
    expect(tag).toContain("src={feedMediaUrl(p.video_url)}");
  });
});
