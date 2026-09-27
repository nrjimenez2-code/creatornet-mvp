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
  const ready = jest.fn(), failed = jest.fn(), present = jest.fn(), token = Symbol(id);
  const host = document.createElement("div"), previewHost = document.createElement("div"); document.body.append(host, previewHost);
  const video = controller.activate({ postId: id, src, host, previewHost, token, ready, failed, present }); media(video);
  video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("seeked"));
  void video.play();
  video.dispatchEvent(new Event("playing"));
  return { video, token, host, previewHost, ready, failed, present };
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

test("a first frame at 0.2 seeks back once rather than widening the target tolerance", () => {
  const p = prepare("corrective"); frame(p.video, 0.2);
  expect(p.video.currentTime).toBe(0); expect(p.present).not.toHaveBeenCalledWith(true);
  frame(p.video, 0.2); expect(p.video.currentTime).toBe(0.2);
  frame(p.video, 0.033); expect(p.present).toHaveBeenCalledWith(true);
});
test("one retry keeps the same buffered source and rejects callbacks from the first attempt", () => {
  const p = prepare("retry-buffer"); const stale = [...frames.get(p.video)!.values()][0];
  jest.advanceTimersByTime(2_500); expect(p.video.src).toBe(p.src);
  jest.advanceTimersByTime(249); expect(frames.get(p.video)!.size).toBe(0);
  jest.advanceTimersByTime(1); stale(0, { mediaTime: 0.033 } as VideoFrameCallbackMetadata);
  expect(p.present).not.toHaveBeenCalledWith(true);
  frame(p.video, 0.033); expect(p.present).toHaveBeenCalledWith(true);
  jest.advanceTimersByTime(5_000); expect(p.video.src).toBe(p.src);
});
test("reversal during the retry delay releases the obsolete slot and timer", () => {
  const p = prepare("retry-old"); jest.advanceTimersByTime(2_500);
  const next = prepare("retry-next"); jest.advanceTimersByTime(250);
  expect(p.present).not.toHaveBeenCalledWith(true);
  expect(next.video.src).toBe(next.src); frame(next.video, 0.033);
  expect(next.present).toHaveBeenCalledWith(true);
});
test("loading starts before main presentation; decoding waits for the main playable buffer", () => {
  const active = activate("loading-main", "https://example.test/loading-main.mp4"); media(active.video, 0.2);
  const p = prepare("loading-neighbor");
  expect(p.video.src).toBe(p.src); expect(frames.get(p.video)?.size ?? 0).toBe(0);
  expect(p.video.paused).toBe(true);
  media(active.video, 2); active.video.dispatchEvent(new Event("progress"));
  expect(frames.get(p.video)?.size).toBe(1); frame(p.video, 0.033);
  expect(p.present).toHaveBeenCalledWith(true); expect(active.ready).not.toHaveBeenCalled();
});
test("incomplete activation retains its element and can recover into a qualified bridge", () => {
  const p = prepare("partial"); media(p.video, 0.2); frame(p.video, 0.033);
  const active = activate("partial", p.src);
  expect(active.previewHost.querySelector("video")).toBe(p.video);
  expect(active.present).toHaveBeenLastCalledWith(false);
  media(p.video, 2); p.video.dispatchEvent(new Event("progress"));
  expect(active.present).toHaveBeenLastCalledWith(true);
  frame(p.video, 0.066); frame(active.video, 0.033); frame(active.video, 0.066);
  expect(active.ready).toHaveBeenCalledTimes(1); expect(active.previewHost.querySelector("video")).toBeNull();
});
test("the watchdog removes a stalled bridge, exposes Retry and cancels its frame callbacks", () => {
  const p = prepare("stalled"); frame(p.video, 0.033);
  const active = activate("stalled", p.src); jest.advanceTimersByTime(3_000);
  expect(active.failed).toHaveBeenCalledTimes(1); expect(active.ready).not.toHaveBeenCalled();
  expect(active.previewHost.querySelector("video")).toBeNull(); expect(frames.get(p.video)?.size).toBe(0);
  expect(active.video.paused).toBe(true);
  const next = prepare("after-stall"); expect(next.video.src).toBe(next.src);
});
test("the watchdog releases a misaligned bridge only when the main is valid and recently moving", () => {
  const p = prepare("valid-main"); frame(p.video, 0.033);
  const active = activate("valid-main", p.src); jest.advanceTimersByTime(2_900);
  frame(p.video, 1.2);
  frame(active.video, 0.033); frame(active.video, 0.066);
  expect(active.ready).not.toHaveBeenCalled(); jest.advanceTimersByTime(100);
  expect(active.ready).toHaveBeenCalledTimes(1); expect(active.failed).not.toHaveBeenCalled();
  expect(active.previewHost.querySelector("video")).toBeNull();
});
test("expiry releases offscreen preparation and activation never inherits its expired frame", () => {
  const token = Symbol("expiring");
  const video = claimMobileFeedPlayer(document.createElement("div"), token, "https://example.test/expiring.mp4", "expiring");
  video.currentTime = 12.4; releaseMobileFeedPlayer(token);
  const p = prepare("expiring"); frame(p.video, 12.4);
  jest.advanceTimersByTime(5_000); expect(p.video.hasAttribute("src")).toBe(false);
  const active = activate("expiring", p.src);
  expect(active.present).toHaveBeenLastCalledWith(false); expect(active.video.currentTime).toBe(0);
});
test("a near-end resume needs only its remaining playable media", () => {
  const token = Symbol("near-end");
  const video = claimMobileFeedPlayer(document.createElement("div"), token, "https://example.test/near-end.mp4", "near-end");
  video.currentTime = 59.9; releaseMobileFeedPlayer(token);
  const p = prepare("near-end"); media(p.video, 60); frame(p.video, 59.9);
  expect(p.present).toHaveBeenCalledWith(true);
});

test("a same-version retry aligns its target with the retained active position", () => {
  const active = activate("retry-position", "https://example.test/retry-position.mp4");
  active.video.currentTime = 8; controller.release(active.token, false);
  const returned = activate("retry-position", "https://example.test/retry-position.mp4");
  frame(returned.video, 8.033); frame(returned.video, 8.066);
  expect(returned.ready).toHaveBeenCalledTimes(1);
});
test("partial recovery never starts a moving preview while the user paused the main", () => {
  const p = prepare("paused-partial"); media(p.video, 0.2); frame(p.video, 0.033);
  const active = activate("paused-partial", p.src); active.video.pause();
  media(p.video, 2); p.video.dispatchEvent(new Event("progress"));
  expect(p.video.paused).toBe(true); expect(active.video.paused).toBe(true);
});

test("an accepted main play request starts the muted bridge before the queued play event", () => {
  const p = prepare("queued-play"); frame(p.video, 0.033);
  const active = activate("queued-play", p.src); active.video.pause();
  const play = jest.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false); return Promise.resolve();
  });
  void active.video.play();
  controller.playRequested(Symbol("obsolete")); expect(p.video.paused).toBe(true);
  controller.playRequested(active.token);
  expect(p.video.paused).toBe(false); expect(p.video.muted).toBe(true);
  const calls = play.mock.calls.length;
  controller.playRequested(active.token); active.video.dispatchEvent(new Event("play"));
  expect(play.mock.calls.length).toBe(calls); expect(frames.get(p.video)?.size).toBe(1);
  active.video.pause(); active.video.dispatchEvent(new Event("play"));
  controller.playRequested(active.token);
  expect(p.video.paused).toBe(true); expect(active.video.paused).toBe(true);
});

test("a rejected main play request cannot start the muted bridge", async () => {
  const p = prepare("rejected-play"); frame(p.video, 0.033);
  const active = activate("rejected-play", p.src); active.video.pause();
  jest.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException("gesture required", "NotAllowedError"));
  const rejection = active.video.play().catch(error => error);
  controller.playRequested(active.token);
  expect(p.video.paused).toBe(true); expect(active.video.paused).toBe(true);
  expect((await rejection).name).toBe("NotAllowedError");
});

function clockedFrame(video: HTMLVideoElement, time: number, clock: number, count: number) {
  video.currentTime = clock;
  const callbacks = [...(frames.get(video)?.values() ?? [])]; frames.get(video)?.clear();
  callbacks.forEach(cb => cb(performance.now(), { mediaTime: time, presentedFrames: count } as VideoFrameCallbackMetadata));
}

test("alignment waits for the sought frame instead of restarting a pending decoder seek", () => {
  const p = prepare("pending-align"); frame(p.video, 0.033);
  const active = activate("pending-align", p.src);
  clockedFrame(p.video, 0.066, 0.066, 2); clockedFrame(p.video, 0.633, 0.633, 19);
  const obsolete = [...frames.get(p.video)!.values()][0];
  clockedFrame(active.video, 0, 0.12, 1); clockedFrame(active.video, 0.033, 0.153, 2);
  expect(p.video.currentTime).toBe(0.153);
  obsolete(performance.now(), { mediaTime: 0.033, presentedFrames: 20 } as VideoFrameCallbackMetadata);
  expect(active.ready).not.toHaveBeenCalled(); expect(frames.get(p.video)?.size).toBe(1);
  jest.advanceTimersByTime(170);
  clockedFrame(active.video, 0.133, 0.253, 5);
  expect(p.video.currentTime).toBe(0.153); expect(active.ready).not.toHaveBeenCalled();
  clockedFrame(p.video, 0.153, 0.153, 21);
  expect(active.ready).toHaveBeenCalledTimes(1); expect(active.failed).not.toHaveBeenCalled();
  expect(active.previewHost.querySelector("video")).toBeNull(); expect(frames.get(p.video)?.size).toBe(0);
  jest.advanceTimersByTime(3_000); expect(active.failed).not.toHaveBeenCalled();
});

test("reversal during alignment cancels the pending frame and rejects its late callback", () => {
  const p = prepare("reversed-align"); frame(p.video, 0.033);
  const active = activate("reversed-align", p.src);
  clockedFrame(p.video, 0.633, 0.633, 19);
  clockedFrame(active.video, 0, 0.12, 1); clockedFrame(active.video, 0.033, 0.153, 2);
  const obsolete = [...frames.get(p.video)!.values()][0];
  const next = activate("after-align", "https://example.test/after-align.mp4");
  obsolete(performance.now(), { mediaTime: 0.153, presentedFrames: 20 } as VideoFrameCallbackMetadata);
  expect(frames.get(p.video)?.size).toBe(0); expect(p.video.hasAttribute("src")).toBe(false);
  expect(active.ready).not.toHaveBeenCalled(); expect(next.ready).not.toHaveBeenCalled();
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
  expect(p.video.hasAttribute("src")).toBe(true);
  jest.advanceTimersByTime(2_750);
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
