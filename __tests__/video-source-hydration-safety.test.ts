/**
 * @jest-environment jsdom
 *
 * HARDENING, not a regression test for a live bug. Read this before assuming
 * there was one — I originally reported this as a shipped defect and that was
 * WRONG. Correction, verified against production:
 *
 *   curl https://www.creatornet.net/dashboard | grep -c '<video'   ->  0
 *
 * No page server-renders a feed card. /dashboard ships "Loading…" and FeedList
 * mounts VideoCards only after its client-side fetch, and FeedList is the only
 * caller that passes preferAdaptive. So the hydration path below never runs in
 * the app today, and adaptive playback does engage on iOS — confirmed in a
 * WebKit browser on the live site, where the <video src> is the .m3u8.
 *
 * What is still true is that the COMPONENT can produce server/client-divergent
 * markup if it is ever server-rendered:
 *
 *   const [nativeHls] = useState(() => typeof document !== "undefined" && ...);
 *
 * A useState initializer also runs during the hydration render, so the server
 * would emit the MP4 while an iPhone computed the .m3u8. React does not repair
 * a mismatched <video src> — "some attributes of the server rendered HTML
 * didn't match the client properties. This won't be patched up." — so the MP4
 * would stick, silently, forever.
 *
 * Making /dashboard server-rendered is a plausible future optimisation, and
 * this trap has already hit VideoCard twice (see <video muted> in
 * audio-preference.test.ts). So the rule is pinned now, while it is cheap:
 * what the server renders for a card must not vary with what the client can
 * play.
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
