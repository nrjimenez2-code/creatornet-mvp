/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

const mockClient = createMockClient();
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient, supabase: mockClient }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session: null, loading: false, userId: null }) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (raw: string | null | undefined) => raw ?? null }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }), useSearchParams: () => ({ get: () => null }) }));
jest.mock("@/components/CommentPanel", () => ({ __esModule: true, default: () => null }));

import VideoCard from "@/components/VideoCard";
import { mobileFeedController } from "@/lib/mobileFeedController";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("candidate terminal Retry", () => {
  let caseIndex = 0;
  let container: HTMLDivElement;
  let root: Root;
  let paused: WeakMap<HTMLMediaElement, boolean>;
  let visibility: jest.SpyInstance;
  let play: jest.SpyInstance;
  let savedMatchMedia: typeof window.matchMedia;
  let savedRequest: typeof HTMLVideoElement.prototype.requestVideoFrameCallback;
  let savedCancel: typeof HTMLVideoElement.prototype.cancelVideoFrameCallback;
  let savedFetch: typeof global.fetch;

  beforeEach(() => {
    caseIndex++;
    jest.useFakeTimers();
    savedFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    paused = new WeakMap();
    visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    savedMatchMedia = window.matchMedia;
    window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() })) as unknown as typeof window.matchMedia;
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event("pause")); });
    play = jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event("play")); return Promise.resolve(); });
    savedRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
    savedCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;
    // A supported frame API that never reports a valid moving frame reproduces
    // the observed watchdog path, without asserting a browser/codec cause.
    HTMLVideoElement.prototype.requestVideoFrameCallback = jest.fn(() => 1);
    HTMLVideoElement.prototype.cancelVideoFrameCallback = jest.fn();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    mobileFeedController.dispose();
    container.remove();
    window.matchMedia = savedMatchMedia;
    HTMLVideoElement.prototype.requestVideoFrameCallback = savedRequest;
    HTMLVideoElement.prototype.cancelVideoFrameCallback = savedCancel;
    global.fetch = savedFetch;
    jest.restoreAllMocks(); jest.useRealTimers();
  });
  async function render(extra: Partial<Parameters<typeof VideoCard>[0]> = {}) {
    await act(async () => root.render(createElement(VideoCard, {
      src: `https://cdn.example.com/terminal-${caseIndex}.m3u8`, postId: `terminal-${caseIndex}`,
      creator: "Luis", caption: "Watchdog case", isActive: true,
      sharedMobileFeedPlayer: true, mobileHandoff: true, soundEnabled: true,
      ...extra,
    })));
    return container.querySelector("video")!;
  }
  async function changeVisibility(state: DocumentVisibilityState) {
    await act(async () => { visibility.mockReturnValue(state); document.dispatchEvent(new Event("visibilitychange")); });
  }
  async function failWatchdog() {
    const video = await render();
    expect(play).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(3_000));
    expect(container.textContent).toContain("This video couldn’t load.");
    expect(video.paused).toBe(true);
    return video;
  }

  test("foreground cannot restart a watchdog-failed activation behind its Retry overlay", async () => {
    const video = await failWatchdog();
    const requests = play.mock.calls.length;
    await changeVisibility("hidden"); await changeVisibility("visible");
    expect(play).toHaveBeenCalledTimes(requests);
    expect(video.paused).toBe(true);
    expect(container.textContent).toContain("Retry video");
  });

  test("a queued canplay retry cannot restart the watchdog-failed activation", async () => {
    play.mockRejectedValue(new Error("not ready"));
    const video = await failWatchdog();
    const requests = play.mock.calls.length;
    await act(async () => video.dispatchEvent(new Event("canplay")));
    expect(play).toHaveBeenCalledTimes(requests);
    expect(container.textContent).toContain("Retry video");
  });

  test("a late autoplay rejection cannot start muted playback after watchdog Retry", async () => {
    let reject!: (reason: DOMException) => void;
    play.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    await failWatchdog();
    const requests = play.mock.calls.length;
    await act(async () => reject(new DOMException("gesture required", "NotAllowedError")));
    expect(play).toHaveBeenCalledTimes(requests);
    expect(container.textContent).toContain("Retry video");
  });

  test("keyboard playback cannot bypass the watchdog Retry button", async () => {
    await failWatchdog();
    const requests = play.mock.calls.length;
    const group = container.querySelector<HTMLElement>('[role="group"]')!;
    group.focus();
    await act(async () => group.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(play).toHaveBeenCalledTimes(requests);
    expect(container.textContent).toContain("Retry video");
  });

  test("a sound gesture records intent without restarting watchdog-failed playback", async () => {
    await failWatchdog();
    const requests = play.mock.calls.length;
    const mute = container.querySelector<HTMLButtonElement>('button[aria-label="Mute video"]')!;
    await act(async () => mute.click());
    const unmute = container.querySelector<HTMLButtonElement>('button[aria-label="Unmute video"]')!;
    await act(async () => unmute.click());
    expect(play).toHaveBeenCalledTimes(requests);
    expect(container.textContent).toContain("Retry video");
  });

  test("explicit Retry creates an activation that can play and resume from background", async () => {
    const video = await failWatchdog();
    const requests = play.mock.calls.length;
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry video")!;
    await act(async () => retry.click());
    expect(container.querySelector("video")).toBe(video);
    expect(container.textContent).not.toContain("This video couldn’t load.");
    expect(play).toHaveBeenCalledTimes(requests + 1);
    await changeVisibility("hidden"); await changeVisibility("visible");
    expect(play).toHaveBeenCalledTimes(requests + 2);
  });

  test.each([true, false])("healthy playback and manual pause survive visibility changes (candidate=%s)", async candidate => {
    const video = await render({ mobileHandoff: candidate });
    expect(play).toHaveBeenCalledTimes(1);
    const requests = play.mock.calls.length;
    await changeVisibility("hidden"); await changeVisibility("visible");
    expect(play).toHaveBeenCalledTimes(requests + 1);
    const group = container.querySelector<HTMLElement>('[role="group"]')!;
    group.focus();
    await act(async () => group.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(video.paused).toBe(true);
    const pausedRequests = play.mock.calls.length;
    await changeVisibility("hidden"); await changeVisibility("visible");
    expect(play).toHaveBeenCalledTimes(pausedRequests);
  });
});
