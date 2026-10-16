/** @jest-environment jsdom */
// Real card lifecycle with mocked media. No physical timing/audio/resource claim.
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
import { normalFeedController } from "@/lib/mobileFeedCandidate";
import { exportFeedTrace, resetFeedTrace } from "@/lib/mobileFeedDiagnostics";
import { mobileFeedResumeSnapshot } from "@/lib/mobileFeedPlayer";
import * as playbackResolution from "@/lib/useFeedPlaybackResolution";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const controller = normalFeedController("prepared-preload-audio");
let root: Root, container: HTMLDivElement, caseIndex = 0, requestId = 0;
let paused: WeakMap<HTMLMediaElement, boolean>;
let callbacks: Map<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>;
let play: jest.SpyInstance, visibility: jest.SpyInstance;
let savedRequest: typeof HTMLVideoElement.prototype.requestVideoFrameCallback;
let savedCancel: typeof HTMLVideoElement.prototype.cancelVideoFrameCallback;
let savedMatchMedia: typeof window.matchMedia, savedFetch: typeof global.fetch;
const id = (name: string) => `cards-${caseIndex}-${name}`;
const src = (name: string) => `https://example.test/${id(name)}.mp4`;
const events = (kind: string) => exportFeedTrace().events.filter(event => event.kind === kind);

function media(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 4 }, currentSrc: { configurable: true, get: () => video.src },
    duration: { configurable: true, value: 60 }, seeking: { configurable: true, value: false },
    videoWidth: { configurable: true, value: 240 }, videoHeight: { configurable: true, value: 426 },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 60 } },
  });
}
async function frame(video: HTMLVideoElement, time: number, count: number, age = 0) {
  await act(async () => {
    video.currentTime = time;
    const pending = [...(callbacks.get(video)?.values() ?? [])]; callbacks.get(video)?.clear();
    pending.forEach(callback => callback(performance.now(), { mediaTime: time, presentedFrames: count,
      presentationTime: performance.now() - age } as VideoFrameCallbackMetadata));
  });
}
async function render(active: "a" | "b", sound = true, sourceB = src("b")) {
  await act(async () => root.render(createElement("div", null, ...(["a", "b"] as const).map(name =>
    createElement("section", { key: name, "data-card": name }, createElement(VideoCard, {
      src: name === "a" ? src(name) : sourceB, postId: id(name), creator: "Creator", caption: name,
      sharedMobileFeedPlayer: true, mobileHandoff: "prepared-preload-audio",
      isActive: name === active, prepareFrame: name !== active, soundEnabled: sound && name === active,
    }))))));
  const activeVideo = video(active);
  media(activeVideo);
  await act(async () => { activeVideo.dispatchEvent(new Event("loadedmetadata")); activeVideo.dispatchEvent(new Event("seeked")); });
}
const card = (name: string) => container.querySelector<HTMLElement>(`[data-card="${name}"]`)!;
const video = (name: string) => card(name).querySelector<HTMLVideoElement>("video")!;
async function warm() {
  await render("a"); const first = video("a"), next = video("b"); media(first); media(next);
  expect(next.hasAttribute("src")).toBe(false); // no load until main motion qualifies
  await frame(first, 1 / 30, 2); await frame(first, 2 / 30, 3);
  expect(next.getAttribute("src")).toBe(src("b"));
  await act(async () => next.dispatchEvent(new Event("loadedmetadata")));
  await frame(next, 0, 1);
  expect(next.paused).toBe(true); expect(next.muted).toBe(true);
  expect(play.mock.contexts.filter(element => element === next)).toHaveLength(0);
  return { first, next };
}
async function visibilityChange(state: DocumentVisibilityState) {
  await act(async () => { visibility.mockReturnValue(state); document.dispatchEvent(new Event("visibilitychange")); });
}
async function key(name: string) {
  const group = card(name).querySelector<HTMLElement>('[role="group"]')!;
  group.focus(); await act(async () => group.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
}
beforeEach(() => {
  caseIndex++; requestId = 0; jest.useFakeTimers(); jest.setSystemTime(100_000);
  window.history.replaceState({}, "", "/?feedDebug=1&feedDelivery=0"); resetFeedTrace();
  savedFetch = global.fetch; global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  savedMatchMedia = window.matchMedia;
  window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn() })) as unknown as typeof window.matchMedia;
  visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  jest.spyOn(document, "hidden", "get").mockImplementation(() => document.visibilityState === "hidden");
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

test("normal cards preserve the audible player and retain a qualified muted cover until main motion", async () => {
  const { first, next } = await warm(), parent = next.parentElement;
  const load = jest.spyOn(next, "load"), seek = jest.spyOn(next, "currentTime", "set");
  const loadsBefore = load.mock.contexts.filter(element => element === next).length;
  play.mockImplementation(function (this: HTMLMediaElement) {
    expect(this).toBe(first); expect(next.paused).toBe(true); expect(next.muted).toBe(true);
    paused.set(this, false); this.dispatchEvent(new Event("play")); return Promise.resolve();
  });
  await render("b");
  expect(video("b")).toBe(first); expect(next.parentElement).toBe(parent);
  expect(load.mock.contexts.filter(element => element === next)).toHaveLength(loadsBefore); expect(seek).not.toHaveBeenCalled();
  expect(events("prepared-player-selection").at(-1)?.detail.result).toBe("retained-main-with-cover");
  await frame(first, 1 / 30, 2, 150); await frame(first, 2 / 30, 3, 150);
  expect(events("presentation-handoff").filter(event => event.postId === id("b"))).toHaveLength(0);
  await frame(first, 3 / 30, 4); await frame(first, 4 / 30, 5);
  expect(events("presentation-handoff").filter(event => event.postId === id("b"))).toHaveLength(1);
  expect(document.querySelectorAll("video[src]").length).toBeLessThanOrEqual(2);
});

test("a per-element sound grant survives prepared A to B to A without another tap", async () => {
  const grants = new WeakSet<HTMLMediaElement>(); let gesture = false;
  play.mockImplementation(function (this: HTMLMediaElement) {
    if (gesture) grants.add(this);
    if (!this.muted && !grants.has(this)) return Promise.reject(new DOMException("gesture required", "NotAllowedError"));
    paused.set(this, false); this.dispatchEvent(new Event("play")); return Promise.resolve();
  });
  await render("a"); const first = video("a");
  expect(card("a").textContent).toContain("Tap for sound");
  await act(async () => {
    gesture = true;
    [...card("a").querySelectorAll("button")].find(button => button.textContent?.includes("Tap for sound"))!.click();
    gesture = false;
  });
  expect(first.muted).toBe(false);
  await frame(first, 1 / 30, 2); await frame(first, 2 / 30, 3);
  await render("b");
  expect(video("b")).toBe(first); expect(first.muted).toBe(false);
  expect(card("b").textContent).not.toContain("Tap for sound");
  await frame(first, 1 / 30, 2); await frame(first, 2 / 30, 3);
  const neighbor = video("a"); media(neighbor);
  const target = mobileFeedResumeSnapshot(id("a"), `${src("a")}|${src("a")}`, true).position;
  await act(async () => neighbor.dispatchEvent(new Event("loadedmetadata"))); await frame(neighbor, target, 1);
  await render("a");
  expect(video("a")).toBe(first); expect(first.muted).toBe(false);
  expect(card("a").textContent).not.toContain("Tap for sound");
});

test("a changed selected source rejects the old neighbor and takes the guarded cold path", async () => {
  const { first, next } = await warm();
  await render("b", true, `${src("b")}?version=2`);
  expect(video("b")).toBe(first); expect(next.hasAttribute("src")).toBe(false);
  expect(events("prepared-player-selection").at(-1)?.detail.result).toBe("cold-fallback");
});

test("mute and manual pause immediately revoke preparation sound and foreground preserves the pause", async () => {
  const { first, next } = await warm();
  await act(async () => card("a").querySelector<HTMLButtonElement>('button[aria-label="Mute video"]')!.click());
  expect(first.muted).toBe(true); expect(next.muted).toBe(true); expect(next.paused).toBe(true);
  await key("a"); expect(first.paused).toBe(true);
  const requests = play.mock.calls.length;
  await visibilityChange("hidden"); await visibilityChange("visible");
  expect(play).toHaveBeenCalledTimes(requests);
  await key("a"); expect(first.paused).toBe(false);
});

test("unmuted policy denial falls back to qualified muted playback and keeps an explicit sound gesture", async () => {
  play.mockImplementationOnce(function (this: HTMLMediaElement) {
    paused.set(this, false); this.dispatchEvent(new Event("play")); return Promise.reject(new DOMException("gesture required", "NotAllowedError"));
  });
  await render("a"); const first = video("a"); media(first);
  expect(first.muted).toBe(true); expect(card("a").textContent).toContain("Tap for sound");
  await frame(first, 1 / 30, 2); await frame(first, 2 / 30, 3);
  expect(events("presentation-handoff").some(event => event.postId === id("a"))).toBe(true);
  await act(async () => [...card("a").querySelectorAll("button")].find(button => button.textContent?.includes("Tap for sound"))!.click());
  expect(first.muted).toBe(false); expect(first.paused).toBe(false);
  expect(card("a").textContent).not.toContain("Retry video");
});

test.each([4_999, 5_000])("a profile-style unmount/return at %i ms uses the fixed departure deadline", async delay => {
  await render("a", false); const first = video("a"); media(first); first.currentTime = 12;
  await act(async () => root.render(null)); controller.dispose();
  expect(mobileFeedResumeSnapshot(id("a"), `${src("a")}|${src("a")}`, true).position).toBe(12);
  jest.setSystemTime(100_000 + delay);
  await render("a", false);
  const returning = video("a"); media(returning);
  await act(async () => { returning.dispatchEvent(new Event("loadedmetadata")); returning.dispatchEvent(new Event("seeked")); });
  expect(returning.currentTime).toBe(delay < 5_000 ? 12 : 0);
  expect(events("resume-decision").filter(event => event.postId === id("a")).at(-1)?.detail.position).toBe(delay < 5_000 ? 12 : 0);
});

test.each([false, true])("profile return only resumes the same resolved delivery URL (changed=%s)", async changed => {
  const firstUrl = `${src("resolved")}?output=mp4`, otherUrl = `${src("resolved")}?output=hls`;
  const descriptor = { key: "videos/resolved.mp4", contentVersion: "same-asset-version", originalUrl: src("a"),
    processedMp4Url: firstUrl, hlsUrl: otherUrl, durationSeconds: 60 };
  let selection = { descriptor, source: firstUrl, waiting: false, delivery: "mp4" as const };
  jest.spyOn(playbackResolution, "useFeedPlaybackResolution").mockImplementation(() => selection);
  await render("a", false); const first = video("a"); first.currentTime = 12;
  await act(async () => root.render(null)); controller.dispose();
  if (changed) selection = { ...selection, source: otherUrl };
  await render("a", false);
  expect(video("a").currentTime).toBe(changed ? 0 : 12);
  expect(events("resume-decision").filter(event => event.postId === id("a")).at(-1)?.detail.position).toBe(changed ? 0 : 12);
});
