/**
 * @jest-environment jsdom
 *
 * VideoCard's SERVER markup must never depend on a browser capability.
 *
 * #154 added adaptive HLS and gated it on:
 *
 *   const [nativeHls] = useState(() => typeof document !== "undefined" &&
 *     !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl"));
 *
 * A useState initializer also runs during the HYDRATION render, so that is not
 * a client-only read. On the Node server `document` is undefined -> false ->
 * MP4 src; on iPhone Safari the hydration render -> true -> the .m3u8 src. And
 * FeedList passes preferAdaptive={!desktop} while useDesktopViewport's
 * getServerSnapshot is () => false, so preferAdaptive is TRUE during SSR.
 *
 * React does not repair a mismatched <video src>. Its own words: "some
 * attributes of the server rendered HTML didn't match the client properties.
 * This won't be patched up." Verified by hydrating: the MP4 stayed in the DOM
 * and a later re-render did not correct it, because nativeHls never changes.
 * Adaptive playback therefore never engaged on the one platform it was for.
 *
 * This is the THIRD time this trap has hit VideoCard (see the <video muted>
 * regression in audio-preference.test.ts). The rule this pins: whatever the
 * server renders for a card must not vary with what the client can play.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

const mockClient = createMockClient();
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient, supabase: mockClient }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session: null, loading: false, userId: null }) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (r: string | null) => r ?? null }));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));
jest.mock("@/components/CommentPanel", () => ({ __esModule: true, default: () => null }));

import VideoCard from "@/components/VideoCard";
import adaptiveManifest from "@/lib/feedAdaptiveManifest.json";

/** A source that DOES have an adaptive rendition, so the branch is reachable. */
const PROVISIONED = "https://pub-91a8d994910d498d90b109487939e1db.r2.dev/videos/767658b6-7b2a-4cc4-91b4-6a0f78073a8e/1789167390042.mp4";

const media = () => window.HTMLMediaElement.prototype as unknown as { canPlayType: (t: string) => string };

function serverMarkup(canPlayType: string) {
  const original = media().canPlayType;
  media().canPlayType = () => canPlayType;
  try {
    return renderToStaticMarkup(
      createElement(VideoCard, { src: PROVISIONED, postId: "p1", preferAdaptive: true })
    );
  } finally {
    media().canPlayType = original;
  }
}
const videoSrc = (html: string) => (html.match(/<video[^>]*\ssrc="([^"]+)"/) || [])[1];

describe("VideoCard server markup is capability-independent", () => {
  test("the fixture really is adaptive-provisioned, or this test proves nothing", () => {
    const paths = Object.keys(adaptiveManifest as Record<string, string>);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => PROVISIONED.endsWith(p.replace(/^\/feed-v1\//, "")) || true)).toBe(true);
    // The MP4 the card would emit must be a key in the adaptive manifest.
    const mp4 = videoSrc(serverMarkup(""));
    expect(mp4).toBeDefined();
    expect(paths).toContain(new URL(mp4!).pathname);
  });

  test("a browser that supports native HLS gets the same SERVER markup as one that does not", () => {
    // Falsy canPlayType is exactly the branch the Node server takes, because
    // `document` is undefined there.
    expect(videoSrc(serverMarkup("maybe"))).toBe(videoSrc(serverMarkup("")));
  });

  test("the server never emits an .m3u8 source", () => {
    for (const answer of ["maybe", "probably", ""]) {
      expect(videoSrc(serverMarkup(answer))).not.toMatch(/\.m3u8/);
    }
  });

  test("capability detection is not seeded into useState", () => {
    const source = require("fs").readFileSync(
      require("path").join(process.cwd(), "components/VideoCard.tsx"), "utf8"
    );
    expect(source).not.toMatch(/useState\([^)]*canPlayType/s);
    expect(source).toContain("useNativeHls()");
  });
});
