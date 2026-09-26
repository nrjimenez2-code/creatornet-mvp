/** @jest-environment jsdom */
import { MobileFeedController } from "@/lib/mobileFeedController";
import { claimMobileFeedPlayer, releaseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";
import { planMobileFallback, type VerifiedTimeline } from "@/lib/mobileFeedRecovery";

let controller: MobileFeedController;
let frames: Map<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>;
let nextId: number;
let paused: WeakMap<HTMLMediaElement, boolean>;
function frame(video: HTMLVideoElement, time: number) {
  video.currentTime = time;
  const callbacks = [...(frames.get(video)?.values() ?? [])]; frames.get(video)?.clear();
  callbacks.forEach(cb => cb(performance.now(), { mediaTime: time, presentedFrames: nextId } as VideoFrameCallbackMetadata));
}
function media(video: HTMLVideoElement, buffer = 10) {
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 4 }, currentSrc: { configurable: true, get: () => video.src },
    duration: { configurable: true, value: 60 }, seeking: { configurable: true, value: false },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => buffer } },
  });
}
function prepare(id: string, src = `https://example.test/${id}.mp4`) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const present = jest.fn(); controller.prepare({ postId: id, src, host, present });
  const video = host.querySelector("video")!; media(video); video.dispatchEvent(new Event("loadedmetadata"));
  return { host, video, present, src };
}
function activate(id: string, src: string) {
  const ready = jest.fn(), present = jest.fn(), token = Symbol(id);
  const host = document.createElement("div"), previewHost = document.createElement("div"); document.body.append(host, previewHost);
  const video = controller.activate({ postId: id, src, host, previewHost, token, ready, present }); media(video);
  video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("seeked"));
  void video.play();
  return { video, token, host, previewHost, ready, present };
}
beforeEach(() => {
  jest.useFakeTimers(); nextId = 0; frames = new Map(); paused = new WeakMap();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event("pause")); });
  jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) { const id = ++nextId; if (!frames.has(this)) frames.set(this, new Map()); frames.get(this)!.set(id, callback); return id; };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) { frames.get(this)?.delete(id); };
  controller = new MobileFeedController();
});
afterEach(() => { controller.dispose(); document.body.innerHTML = ""; jest.restoreAllMocks(); jest.useRealTimers(); });

test("warmup needs a valid target frame and one second of actual playable media", () => {
  const p = prepare("buffer"); media(p.video, 0.2); frame(p.video, 0.033);
  expect(p.present).not.toHaveBeenCalledWith(true);
  media(p.video, 2); p.video.dispatchEvent(new Event("progress"));
  expect(p.present).toHaveBeenCalledWith(true);
  expect(p.video.paused).toBe(true);
});

test("a timer and metadata-only frame cannot declare a preparation successful", () => {
  const p = prepare("timeout"); Object.defineProperty(p.video, "readyState", { value: 1 }); frame(p.video, 0);
  jest.advanceTimersByTime(2_500);
  expect(p.present).not.toHaveBeenCalledWith(true);
  expect(p.video.hasAttribute("src")).toBe(false);
});

test("keeps the prepared element through activation and waits for timeline alignment", async () => {
  const p = prepare("handoff"); frame(p.video, 0.033);
  const active = activate("handoff", p.src); await Promise.resolve();
  expect(active.previewHost.querySelector("video")).toBe(p.video);
  frame(p.video, 0.066); frame(active.video, 0.033); frame(active.video, 0.066);
  expect(active.ready).toHaveBeenCalledTimes(1);
  expect(active.previewHost.querySelector("video")).toBeNull();
  expect(active.video.muted).toBeDefined();
});

test("reversal cancels obsolete decode and stale frame/play promises cannot mark the new slot ready", async () => {
  const p = prepare("reversal-a"); const late = [...frames.get(p.video)!.values()][0];
  const next = prepare("reversal-b"); late(5, { mediaTime: 0.033 } as VideoFrameCallbackMetadata);
  expect(p.present).not.toHaveBeenCalledWith(true);
  expect(next.present).not.toHaveBeenCalledWith(true);
  frame(next.video, 0.033);
  expect(next.present).toHaveBeenCalledWith(true);
  await Promise.resolve();
});

test("a recent return prepares at its saved time and an expired position restarts at zero", () => {
  const token = Symbol("save");
  const video = claimMobileFeedPlayer(document.createElement("div"), token, "https://example.test/return.mp4", "return");
  video.currentTime = 12.4; releaseMobileFeedPlayer(token);
  const p = prepare("return"); expect(p.video.currentTime).toBe(12.4);
  controller.cancelPreparation(); jest.advanceTimersByTime(5_001);
  const expired = prepare("return"); expect(expired.video.currentTime).toBe(0);
});

test("rapid skipped cards keep at most three attached media elements and one muted preparation decoder", async () => {
  const active = activate("resource-active", "https://example.test/resource-active.mp4"); await Promise.resolve();
  for (let i = 0; i < 30; i++) {
    prepare(`skip-${i}`);
    expect(document.querySelectorAll("video").length).toBeLessThanOrEqual(3);
    expect([...document.querySelectorAll<HTMLVideoElement>("video[data-mobile-preparation]")].filter(video => !video.paused)).toHaveLength(1);
  }
  controller.release(active.token);
});

test("background cancels preparation and stale activation frames do not uncover a new post", async () => {
  const a = activate("stale-a", "https://example.test/stale-a.mp4"); await Promise.resolve();
  const old = [...frames.get(a.video)!.values()];
  const b = activate("stale-b", "https://example.test/stale-b.mp4"); await Promise.resolve();
  old.forEach(cb => cb(40, { mediaTime: 0.033 } as VideoFrameCallbackMetadata));
  expect(a.ready).not.toHaveBeenCalled(); expect(b.ready).not.toHaveBeenCalled();
  const p = prepare("hide"); Object.defineProperty(document, "hidden", { value: true }); controller.suspend();
  expect(p.video.paused).toBe(true); expect(p.video.hasAttribute("src")).toBe(false);
});

test("fallback restores only verified content timelines and cannot loop", () => {
  const attempted = new Set<string>();
  const proof: VerifiedTimeline[] = [{ from: "v1.m3u8", to: "v1.mp4", contentVersion: "sha256:verified-fixture", offsetSeconds: 0, evidence: "fixture-timeline-match" }];
  expect(planMobileFallback("v1.m3u8", "v1.mp4", 12.4, attempted, proof)).toEqual({ kind: "replace", position: 12.4, source: "v1.mp4" });
  expect(planMobileFallback("v1.m3u8", "v1.mp4", 12.4, attempted, proof).kind).toBe("terminal");
  expect(planMobileFallback("v1.m3u8", "overwritten.mp4", 12.4, new Set(), proof)).toEqual(expect.objectContaining({ kind: "terminal", reason: "unverified-timeline", capturedPosition: 12.4 }));
  expect(planMobileFallback("v1.m3u8", "v1.mp4", 0, new Set()).kind).toBe("replace");
});
