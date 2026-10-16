/** @jest-environment jsdom */
// Real VideoCard ownership/lifecycle with mocked media; no physical audio claim.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "@/__tests__/__mocks__/supabaseQueryMock";
const mockClient = createMockClient();
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient, supabase: mockClient }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ session: null, loading: false, userId: null }) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (raw: string | null | undefined) => raw ?? null }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }), useSearchParams: () => ({ get: () => null }) }));
jest.mock("@/components/CommentPanel", () => ({ __esModule: true, default: () => null }));
import VideoCard from "@/components/VideoCard";
import { normalFeedController } from "@/lib/mobileFeedCandidate";
import { exportFeedTrace, resetFeedTrace } from "@/lib/mobileFeedDiagnostics";
import { mobileFeedResumeSnapshot } from "@/lib/mobileFeedPlayer";
import * as playbackResolution from "@/lib/useFeedPlaybackResolution";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const controller = normalFeedController("prepared-preload-audio");
let root: Root, container: HTMLDivElement, caseIndex = 0, requestId = 0;
let paused: WeakMap<HTMLMediaElement, boolean>;
let callbacks: Map<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>;
let play: jest.SpyInstance;
let savedRequest: typeof HTMLVideoElement.prototype.requestVideoFrameCallback;
let savedCancel: typeof HTMLVideoElement.prototype.cancelVideoFrameCallback;
let savedMatchMedia: typeof window.matchMedia, savedFetch: typeof global.fetch;
const id = (name: string) => `card-recovery-${caseIndex}-${name}`;
const src = (name: string) => `https://example.test/${id(name)}.mp4`;
const events = (kind: string) => exportFeedTrace().events.filter(event => event.kind === kind);
const card = (name: string) => container.querySelector<HTMLElement>(`[data-card="${name}"]`)!;
const video = (name: string) => card(name).querySelector<HTMLVideoElement>("video");

function media(element: HTMLVideoElement) {
  Object.defineProperties(element, {
    readyState: { configurable: true, value: 4 }, currentSrc: { configurable: true, get: () => element.src },
    duration: { configurable: true, value: 60 }, seeking: { configurable: true, value: false },
    videoWidth: { configurable: true, value: 240 }, videoHeight: { configurable: true, value: 426 },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 60 } },
  });
}
async function frame(element: HTMLVideoElement, time: number, count: number) {
  await act(async () => {
    element.currentTime = time;
    const pending = [...(callbacks.get(element)?.values() ?? [])]; callbacks.get(element)?.clear();
    pending.forEach(callback => callback(performance.now(), { mediaTime: time, presentedFrames: count,
      presentationTime: performance.now() } as VideoFrameCallbackMetadata));
  });
}
async function render(active: "a" | "b", prepare = false) {
  await act(async () => root.render(createElement("div", null, ...(["a", "b"] as const).map(name =>
    createElement("section", { key: name, "data-card": name }, createElement(VideoCard, {
      src: src(name), postId: id(name), creator: "Creator", caption: name,
      sharedMobileFeedPlayer: true, mobileHandoff: "prepared-preload-audio",
      isActive: name === active, prepareFrame: prepare && name !== active, soundEnabled: false,
    }))))));
  // A terminal failure can park the element outside the card. Keep its mock
  // reference so assertions describe the recovery failure instead of null DOM.
  const activeVideo = video(active) ?? play.mock.contexts.at(-1) as HTMLVideoElement;
  media(activeVideo);
  await act(async () => { activeVideo.dispatchEvent(new Event("loadedmetadata")); activeVideo.dispatchEvent(new Event("seeked")); });
  return activeVideo;
}
async function moving(element: HTMLVideoElement, start = 0) {
  await frame(element, start + 1 / 30, 2); await frame(element, start + 2 / 30, 3);
}
beforeEach(() => {
  caseIndex++; requestId = 0; jest.useFakeTimers(); jest.setSystemTime(100_000);
  window.history.replaceState({}, "", "/?feedDebug=1&feedDelivery=0"); resetFeedTrace();
  savedFetch = global.fetch; global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  savedMatchMedia = window.matchMedia;
  window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() })) as unknown as typeof window.matchMedia;
  jest.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  jest.spyOn(document, "hidden", "get").mockReturnValue(false);
  paused = new WeakMap(); callbacks = new Map();
  jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event("pause")); });
  play = jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  savedRequest = HTMLVideoElement.prototype.requestVideoFrameCallback; savedCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    if (!callbacks.has(this)) callbacks.set(this, new Map());
    const request = ++requestId; callbacks.get(this)!.set(request, callback); return request;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (request) { callbacks.get(this)?.delete(request); };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); controller.dispose(); container.remove();
  HTMLVideoElement.prototype.requestVideoFrameCallback = savedRequest; HTMLVideoElement.prototype.cancelVideoFrameCallback = savedCancel;
  window.matchMedia = savedMatchMedia; global.fetch = savedFetch; jest.restoreAllMocks(); jest.useRealTimers();
});

test("one current AbortError receives bounded recovery before terminal Retry", async () => {
  play.mockRejectedValueOnce(new DOMException("play interrupted by load", "AbortError"));
  const first = await render("a");
  expect(card("a").textContent).not.toContain("Retry video");
  await act(async () => jest.advanceTimersByTime(100));
  expect(play.mock.contexts.filter(element => element === first)).toHaveLength(2);
  await moving(first);
  expect(events("presentation-handoff").some(event => event.postId === id("a"))).toBe(true);
  expect(card("a").textContent).not.toContain("Retry video");
});

test("a successful same-source reactivation clears the preceding terminal overlay", async () => {
  const first = await render("a"); await act(async () => first.dispatchEvent(new Event("error")));
  expect(card("a").textContent).toContain("Retry video");
  await render("b"); const returning = await render("a"); await moving(returning);
  expect(events("presentation-handoff").some(event => event.postId === id("a"))).toBe(true);
  expect(returning.paused).toBe(false); expect(card("a").textContent).not.toContain("Retry video");
});

test("resolved MP4 falls back to original at entry even when a legacy HLS mapping exists", async () => {
  const original = "https://media.creatornet.net/videos/073e7bcb-5986-49cc-8be9-8567c6494562/1788481864376.mov";
  const processed = "https://media.creatornet.net/feed-auto/" + "a".repeat(64) + ".mp4";
  const descriptor = { key: original.split("net/")[1], contentVersion: "sha256:" + "a".repeat(64), originalUrl: original, processedMp4Url: processed, durationSeconds: 60 };
  jest.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
  jest.spyOn(playbackResolution, "useFeedPlaybackResolution").mockReturnValue({ descriptor, source: processed, waiting: false, delivery: "mp4" });
  await act(async () => root.render(createElement(VideoCard, {
    src: original, postId: id("a"), creator: "Creator", caption: "fallback", sharedMobileFeedPlayer: true,
    mobileHandoff: "prepared-preload-audio", isActive: true, prepareFrame: false, soundEnabled: false, preferAdaptive: true,
  })));
  const element = container.querySelector<HTMLVideoElement>("video")!; media(element); element.currentTime = 0;
  expect(element.getAttribute("src")).toBe(processed);
  await act(async () => element.dispatchEvent(new Event("error")));
  const fallback = container.querySelector<HTMLVideoElement>("video")!; media(fallback);
  expect(fallback.getAttribute("src")).toBe(original);
  expect(events("fallback").at(-1)?.detail.from).toBe("mp4");
  expect(events("fallback-held")).toHaveLength(0); expect(container.textContent).not.toContain("Retry video");
});

test("explicit Retry reload applies once and permits the next qualified prepared return", async () => {
  const first = await render("a"); await act(async () => first.dispatchEvent(new Event("error")));
  const retry = [...card("a").querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Retry video"))!;
  expect(retry).toBeTruthy(); await act(async () => retry.click());
  const retried = video("a")!; media(retried);
  await act(async () => { retried.dispatchEvent(new Event("loadedmetadata")); retried.dispatchEvent(new Event("seeked")); });
  await moving(retried);
  const next = await render("b", true), preparation = video("a")!; media(preparation); await moving(next);
  await act(async () => preparation.dispatchEvent(new Event("loadedmetadata")));
  const target = mobileFeedResumeSnapshot(id("a"), src("a") + "|" + src("a"), true).position;
  await frame(preparation, target, 1);
  expect(events("preparation-ready").at(-1)?.detail.postId).toBe(id("a"));
  await render("a", true);
  expect(events("prepared-player-selection").at(-1)?.detail.result).toBe("retained-main-with-cover");
  expect(video("a")).toBe(first);
  expect(preparation.hasAttribute("src")).toBe(true);
  expect(preparation.muted).toBe(true);
});
