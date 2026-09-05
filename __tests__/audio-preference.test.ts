/**
 * @jest-environment jsdom
 */
/**
 * Persistent per-device sound preference (Noah #6).
 *
 * Until this existed, mute state lived only in React (FeedList's
 * globalSoundOn, VideoCard's isMuted, nothing on the watch page), so every
 * reload came back muted. lib/audioPreference.ts is the single store
 * (localStorage "cn-sound-on"); FeedList, VideoCard and the watch page read
 * and write it.
 *
 * The rule that matters most is the last test: when the browser refuses
 * unmuted autoplay (NotAllowedError — no gesture yet on this page), VideoCard
 * falls back to muted playback and shows a "Tap for sound" chip, and the saved
 * preference is NOT rewritten as muted. Writing it there would silently undo
 * the user's choice on every fresh page load.
 *
 * Real renders (createRoot + act) of the real VideoCard; play() is stubbed
 * because jsdom has no media pipeline.
 */

import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

// Module mocks — same wiring as policy-links-purchase-flow.test.ts.
const mockClient = createMockClient();
jest.mock("@/lib/supabaseClient", () => ({
  createClient: () => mockClient,
  supabase: mockClient,
}));
const userCtx = { session: null, loading: false, userId: null };
jest.mock("@/lib/useUser", () => ({
  useUser: () => userCtx,
}));
jest.mock("@/lib/posthog", () => ({
  trackEvent: jest.fn(),
  normalizeCategory: (raw: string | null | undefined) => raw ?? null,
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));
jest.mock("@/components/CommentPanel", () => ({
  __esModule: true,
  default: () => null,
}));

import {
  SOUND_PREF_KEY,
  readSoundOn,
  writeSoundOn,
  useSoundPreference,
} from "@/lib/audioPreference";
import VideoCard from "@/components/VideoCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The autoplay observer callback also POSTs an impression metric; jest's jsdom
// has no fetch. Nothing here asserts on it.
(globalThis as { fetch?: unknown }).fetch = jest.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
);

// Controllable IntersectionObserver: VideoCard's autoplay (and lazy-src)
// observers register here and tests fire them.
type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;
const observerCallbacks: ObserverCallback[] = [];
class FakeIntersectionObserver {
  constructor(callback: ObserverCallback) {
    observerCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  FakeIntersectionObserver;

/** `muted` at each play() call, in order. */
let playCalls: boolean[] = [];
/** Autoplay policy stand-in: unmuted play() is refused until a gesture. */
let gestureSeen = false;

beforeAll(() => {
  jest
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(function (this: HTMLMediaElement) {
      playCalls.push(this.muted);
      if (!this.muted && !gestureSeen) {
        const err = new Error(
          "play() failed because the user didn't interact with the document first.",
        );
        err.name = "NotAllowedError";
        return Promise.reject(err);
      }
      return Promise.resolve();
    });
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

function intersect(): void {
  const entry = { isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry;
  observerCallbacks.forEach((cb) => cb([entry]));
}

const SRC = "https://cdn.example/clip.mp4";

describe("audio preference", () => {
  let container: HTMLDivElement;
  let root: Root;

  const chip = () =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Tap for sound"),
    ) ?? null;
  const muteButton = () =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Unmute video"], button[aria-label="Mute video"]',
    );

  beforeEach(() => {
    localStorage.clear();
    playCalls = [];
    gestureSeen = false;
    observerCallbacks.length = 0;
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

  test("readSoundOn/writeSoundOn round-trip through localStorage; new visitors are muted", () => {
    expect(readSoundOn()).toBe(false);

    writeSoundOn(true);
    expect(localStorage.getItem(SOUND_PREF_KEY)).toBe("true");
    expect(readSoundOn()).toBe(true);

    writeSoundOn(false);
    expect(readSoundOn()).toBe(false);
  });

  test("blocked localStorage: reads false, writes do not throw, the choice still applies in-page", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const getSpy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    const setSpy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    try {
      expect(readSoundOn()).toBe(false);
      expect(() => writeSoundOn(true)).not.toThrow();
      expect(readSoundOn()).toBe(true); // in-memory mirror, this page only
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
      writeSoundOn(false); // reset the in-memory mirror for later tests
    }
  });

  test("server render snapshot is muted even when the device prefers sound", () => {
    writeSoundOn(true);
    const Probe = () => {
      const [soundOn] = useSoundPreference();
      return createElement("span", null, soundOn ? "on" : "off");
    };
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>off</span>");
  });

  test("useSoundPreference updates subscribers on write and on cross-tab storage events", async () => {
    const seen: boolean[] = [];
    const Probe = () => {
      const [soundOn] = useSoundPreference();
      seen.push(soundOn);
      return null;
    };
    await act(async () => {
      root.render(createElement(Probe));
    });
    expect(seen.at(-1)).toBe(false);

    await act(async () => {
      writeSoundOn(true);
    });
    expect(seen.at(-1)).toBe(true);

    localStorage.setItem(SOUND_PREF_KEY, "false");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: SOUND_PREF_KEY }));
    });
    expect(seen.at(-1)).toBe(false);
  });

  test("uncontrolled VideoCard (profile/tag modals): the mute button writes the preference", async () => {
    await act(async () => {
      root.render(createElement(VideoCard, { src: SRC, postId: "p1" }));
    });
    const video = container.querySelector("video");
    expect(video?.muted).toBe(true); // new visitor

    await act(async () => {
      muteButton()!.click();
    });
    expect(video?.muted).toBe(false);
    expect(localStorage.getItem(SOUND_PREF_KEY)).toBe("true");

    await act(async () => {
      muteButton()!.click();
    });
    expect(video?.muted).toBe(true);
    expect(localStorage.getItem(SOUND_PREF_KEY)).toBe("false");
  });

  test("uncontrolled VideoCard seeds from the saved preference", async () => {
    writeSoundOn(true);
    await act(async () => {
      root.render(createElement(VideoCard, { src: SRC, postId: "p1" }));
    });
    expect(container.querySelector("video")?.muted).toBe(false);
  });

  test("controlled VideoCard (feed): the parent owns the preference, the card only reports the toggle", async () => {
    const onToggleSound = jest.fn();
    await act(async () => {
      root.render(
        createElement(VideoCard, { src: SRC, postId: "p1", soundEnabled: true, onToggleSound }),
      );
    });
    expect(container.querySelector("video")?.muted).toBe(false);

    await act(async () => {
      muteButton()!.click();
    });
    expect(onToggleSound).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SOUND_PREF_KEY)).toBeNull();
  });

  test("sound preferred but autoplay blocked: plays muted, shows the chip, does NOT persist muted", async () => {
    writeSoundOn(true);
    await act(async () => {
      root.render(createElement(VideoCard, { src: SRC, postId: "p1" }));
    });
    const video = container.querySelector("video")!;
    expect(video.muted).toBe(false); // seeded from the preference
    expect(chip()).toBeNull();

    await act(async () => {
      intersect();
    });

    expect(playCalls).toEqual([false, true]); // refused unmuted, retried muted
    expect(video.muted).toBe(true);
    expect(chip()).not.toBeNull();
    expect(localStorage.getItem(SOUND_PREF_KEY)).toBe("true");

    // The chip click is a real gesture: unmute + play, preference untouched.
    gestureSeen = true;
    await act(async () => {
      chip()!.click();
    });
    expect(video.muted).toBe(false);
    expect(playCalls.at(-1)).toBe(false);
    expect(chip()).toBeNull();
    expect(localStorage.getItem(SOUND_PREF_KEY)).toBe("true");
  });
});
