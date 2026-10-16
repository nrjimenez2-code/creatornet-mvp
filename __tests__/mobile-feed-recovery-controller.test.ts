/** @jest-environment jsdom */
// Ownership/guard tests only. Mocked media cannot establish WebKit sound grants,
// picture/audio continuity, native decoder release or physical performance.
import { PreparedMobileFeedController } from "@/lib/mobileFeedPreparedController";
import { mobileFeedPlaybackReady, mobileFeedResumeSnapshot, ownsMobileFeedPlayer } from "@/lib/mobileFeedPlayer";
import * as diagnostics from "@/lib/mobileFeedDiagnostics";

let controller: PreparedMobileFeedController;
let callbacks: Map<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>;
let paused: WeakMap<HTMLMediaElement, boolean>;
let requestId = 0;
let originalRequest: typeof HTMLVideoElement.prototype.requestVideoFrameCallback;
let originalCancel: typeof HTMLVideoElement.prototype.cancelVideoFrameCallback;
let testCase = 0;
const src = (id: string) => `https://example.test/recovery-${testCase}-${id}.mp4`;
const events = (kind: string) => diagnostics.exportFeedTrace().events.filter(event => event.kind === kind);

function media(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 4 }, currentSrc: { configurable: true, get: () => video.src },
    duration: { configurable: true, value: 60 }, seeking: { configurable: true, value: false },
    videoWidth: { configurable: true, value: 240 }, videoHeight: { configurable: true, value: 426 },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 60 } },
  });
}
function deliver(video: HTMLVideoElement, time: number, count = Math.round(time * 30) + 1, age = 0, metadata: Partial<VideoFrameCallbackMetadata> = {}) {
  video.currentTime = time;
  const pending = [...(callbacks.get(video)?.values() ?? [])]; callbacks.get(video)?.clear();
  pending.forEach(callback => callback(performance.now(), { mediaTime: time, presentedFrames: count,
    presentationTime: performance.now() - age, ...metadata } as VideoFrameCallbackMetadata));
}
function prepare(id: string, version = src(id)) {
  const host = document.createElement("div"); document.body.appendChild(host);
  controller.prepare({ postId: id, src: src(id), contentVersion: version, host, present: jest.fn() });
  const video = host.querySelector("video")!; media(video);
  video.dispatchEvent(new Event("loadedmetadata"));
  const obsolete = [...(callbacks.get(video)?.values() ?? [])];
  const target = mobileFeedResumeSnapshot(id, version).position;
  // Saved-position preparation has to finish its requested seek first.
  video.dispatchEvent(new Event("seeked"));
  deliver(video, target + 1 / 30);
  expect(video.paused).toBe(true);
  return { video, obsolete, target, host };
}
function activate(id: string, options: { contentVersion?: string; position?: number; reload?: boolean; playingIntent?: boolean; soundIntent?: boolean; previewHost?: HTMLElement } = {}) {
  const host = document.createElement("div");
  const prepared = [...document.querySelectorAll<HTMLVideoElement>("video[data-mobile-preparation]")].find(video => video.getAttribute("src") === src(id));
  const previewHost = options.previewHost ?? prepared?.parentElement ?? document.createElement("div");
  document.body.appendChild(host);
  if (!options.previewHost && !previewHost.isConnected) document.body.appendChild(previewHost);
  const token = Symbol(id), ready = jest.fn(), failed = jest.fn(), recover = jest.fn(), present = jest.fn();
  const video = controller.activate({ postId: id, src: src(id), host, previewHost, token, ready, failed, recover, present, ...options });
  media(video); video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("seeked"));
  return { video, token, ready, failed, recover, present, host, previewHost };
}
async function play(active: ReturnType<typeof activate>, request?: Promise<void>) {
  await mobileFeedPlaybackReady(active.token);
  const requestedAt = performance.now(), result = request ?? active.video.play();
  controller.observeMainPlay(active.token, { requestedAt, returnedAt: performance.now(), request: result });
  controller.playRequested(active.token);
  await Promise.resolve();
  if (!active.video.paused) active.video.dispatchEvent(new Event("playing"));
}
async function cold(id: string) {
  const active = activate(id); await play(active);
  deliver(active.video, 1 / 30); deliver(active.video, 2 / 30);
  return active;
}

beforeEach(() => {
  testCase++; jest.useFakeTimers(); jest.setSystemTime(100_000);
  window.history.replaceState({}, "", "/?feedDebug=1"); diagnostics.resetFeedTrace(); requestId = 0;
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  callbacks = new Map(); paused = new WeakMap();
  originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
  originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;
  jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event("pause")); });
  jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    if (!callbacks.has(this)) callbacks.set(this, new Map());
    const id = ++requestId; callbacks.get(this)!.set(id, callback); return id;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) { callbacks.get(this)?.delete(id); };
  controller = new PreparedMobileFeedController("prepared-preload-audio", { retainAudiblePlayer: true });
});
afterEach(() => {
  controller.dispose(); document.body.innerHTML = "";
  if (originalRequest) HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest;
  else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  if (originalCancel) HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel;
  else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
  jest.restoreAllMocks(); jest.useRealTimers();
});


async function flush() { await Promise.resolve(); await Promise.resolve(); }
function advance(ms: number) { jest.advanceTimersByTime(ms); }
function qualify(active: ReturnType<typeof activate>, start = active.video.currentTime) {
  deliver(active.video, start + 1 / 30, 10); deliver(active.video, start + 2 / 30, 11);
}

test("retained mode preserves the audible element across a prepared cover and defers a third source", async () => {
  const first = await cold("a"); first.video.muted = false;
  const neighbor = prepare("b");
  expect(neighbor.video.muted).toBe(true);
  const next = activate("b", { previewHost: neighbor.host, soundIntent: true });
  expect(next.video).toBe(first.video); expect(next.video).not.toBe(neighbor.video);
  expect(next.present).toHaveBeenLastCalledWith(true);
  expect(neighbor.video.paused).toBe(true); expect(neighbor.video.muted).toBe(true);
  const third = document.createElement("div"); document.body.appendChild(third);
  controller.prepare({ postId: "c", src: src("c"), host: third, present: jest.fn() });
  expect(third.querySelector("video")).toBeNull();
  expect(document.querySelectorAll("video[src]")).toHaveLength(2);
  await play(next); qualify(next);
  expect(next.ready).toHaveBeenCalledTimes(1);
  expect(neighbor.video.getAttribute("src")).not.toBe(src("b"));
  expect(neighbor.host.querySelector("video")).toBeNull();
  expect(third.querySelector("video")).not.toBeNull();
  expect(document.querySelectorAll("video[src]")).toHaveLength(2);
  const back = activate("a"); await play(back); qualify(back);
  expect(back.video).toBe(first.video);
});

test("the full startup frame budget starts after a successful 1900ms return seek", async () => {
  const first = await cold("seek-a"); first.video.currentTime = 12;
  await cold("seek-b");
  const host = document.createElement("div"), previewHost = document.createElement("div"); document.body.append(host, previewHost);
  const token = Symbol("seek-return"), ready = jest.fn(), failed = jest.fn(), recover = jest.fn();
  const video = controller.activate({ postId: "seek-a", src: src("seek-a"), host, previewHost, token, ready, failed, recover, present: jest.fn() });
  media(video); expect(mobileFeedPlaybackReady(token)).not.toBeNull();
  advance(1900); video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("seeked")); await flush();
  const request = video.play(); controller.observeMainPlay(token, { requestedAt: performance.now(), returnedAt: performance.now(), request }); await flush();
  advance(1000); deliver(video, 12.033, 20); advance(200); deliver(video, 12.066, 21);
  expect(ready).toHaveBeenCalledTimes(1); expect(failed).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
});

test("late advancing submissions qualify while replayed counts, timestamps and wrong sources do not", async () => {
  const active = activate("late"); await play(active);
  advance(200); deliver(active.video, 0.033, 1, 101);
  advance(200); deliver(active.video, 0.066, 1, 101); // static frame identity
  expect(active.ready).not.toHaveBeenCalled();
  advance(200); deliver(active.video, 0.099, 2, 590); // submitted before the last accepted callback
  expect(active.ready).not.toHaveBeenCalled();
  Object.defineProperty(active.video, "currentSrc", { configurable: true, value: src("other") });
  advance(200); deliver(active.video, 0.132, 3, 101);
  expect(active.ready).not.toHaveBeenCalled();
  media(active.video);
  advance(200); deliver(active.video, 0.165, 4, 101);
  advance(200); deliver(active.video, 0.198, 5, 101);
  expect(active.ready).toHaveBeenCalledTimes(1);
});

test("AbortError gets one current-owner recovery and a repeated interruption ends in Retry", async () => {
  const active = activate("abort");
  await play(active, Promise.reject(new DOMException("interrupted", "AbortError")));
  advance(100); expect(active.recover).toHaveBeenCalledTimes(1);
  expect(active.recover).toHaveBeenCalledWith("play-interrupted"); expect(active.failed).not.toHaveBeenCalled();
  await play(active, Promise.reject(new DOMException("interrupted again", "AbortError")));
  advance(100);
  expect(active.recover).toHaveBeenCalledTimes(1); expect(active.failed).toHaveBeenCalledWith("play-interrupted");
  expect(controller.canPlay(active.token)).toBe(false);
  expect(events("prepared-player-play-rejected").at(-1)?.detail.errorName).toBe("AbortError");
});

test("a browser-origin startup pause recovers once, then bounded lack of motion fails", async () => {
  const active = activate("native-pause"); await play(active);
  advance(500); active.video.pause(); advance(100);
  expect(active.recover).toHaveBeenCalledWith("native-pause");
  await play(active); advance(3001);
  expect(active.failed).toHaveBeenCalledWith("recovery-timeout"); expect(controller.canPlay(active.token)).toBe(false);
});

test.each(["manual", "hidden", "interrupted"])("%s pause never spends the automatic recovery attempt", async reason => {
  const active = await cold(`pause-${reason}`);
  if (reason === "manual") controller.pauseRequested(active.token);
  if (reason === "hidden") Object.defineProperty(document, "hidden", { configurable: true, value: true });
  if (reason === "interrupted") Object.defineProperty(navigator, "audioSession", { configurable: true, value: { state: "interrupted" } });
  active.video.pause(); advance(10_000);
  expect(active.recover).not.toHaveBeenCalled(); expect(active.failed).not.toHaveBeenCalled();
  if (reason === "interrupted") delete (navigator as Navigator & { audioSession?: unknown }).audioSession;
});

test("post-start waiting has one bounded recovery and requires new advancing frames", async () => {
  const active = await cold("stall");
  active.video.dispatchEvent(new Event("waiting")); advance(3000);
  expect(active.recover).toHaveBeenCalledWith("playback-stall");
  await play(active); qualify(active);
  expect(active.ready).toHaveBeenCalledTimes(2);
  active.video.dispatchEvent(new Event("waiting")); advance(3000);
  expect(active.recover).toHaveBeenCalledTimes(1); expect(active.failed).toHaveBeenCalledWith("playback-stall");
});

test("a policy denial stays available for caller-owned muted fallback without automatic recovery", async () => {
  const active = activate("policy"); active.video.muted = false;
  await play(active, Promise.reject(new DOMException("gesture needed", "NotAllowedError")));
  advance(5000); expect(active.recover).not.toHaveBeenCalled(); expect(active.failed).not.toHaveBeenCalled();
  active.video.muted = true; await play(active); qualify(active);
  expect(active.ready).toHaveBeenCalledTimes(1);
});

test("late failure from an obsolete owner and queued pause while unpaused cannot disturb the new activation", async () => {
  const first = activate("obsolete"); let reject!: (error: unknown) => void;
  const request = new Promise<void>((_, fail) => { reject = fail; });
  const requestedAt = performance.now(); controller.observeMainPlay(first.token, { requestedAt, returnedAt: requestedAt, request });
  const next = activate("current"); await play(next);
  reject(new DOMException("old interrupted", "AbortError")); await flush();
  next.video.dispatchEvent(new Event("pause")); qualify(next); advance(100);
  expect(next.ready).toHaveBeenCalledTimes(1); expect(first.recover).not.toHaveBeenCalled(); expect(next.recover).not.toHaveBeenCalled();
});

test("release tears down retained cover and all recovery work without touching a successor", async () => {
  await cold("release-a"); const neighbor = prepare("release-b");
  const active = activate("release-b", { previewHost: neighbor.host }); await play(active);
  active.video.pause(); controller.release(active.token);
  expect(neighbor.video.hasAttribute("src")).toBe(false);
  const next = activate("release-c"); await play(next); qualify(next); advance(500);
  expect(active.recover).not.toHaveBeenCalled(); expect(active.failed).not.toHaveBeenCalled();
  expect(next.ready).toHaveBeenCalledTimes(1); expect(ownsMobileFeedPlayer(next.token, next.video, src("release-c"))).toBe(true);
});



test("audio interruption suppresses recovery until the session becomes available again", async () => {
  const active = await cold("interruption-return");
  const session = { state: "interrupted" };
  Object.defineProperty(navigator, "audioSession", { configurable: true, value: session });
  active.video.pause(); advance(5000);
  expect(active.recover).not.toHaveBeenCalled(); expect(active.failed).not.toHaveBeenCalled();
  session.state = "active"; advance(350);
  expect(active.recover).toHaveBeenCalledWith("native-pause");
  delete (navigator as Navigator & { audioSession?: unknown }).audioSession;
});

test("submission and frame-count watermarks reject replay pairs after an invalid delivery", async () => {
  const active = activate("watermarks"); await play(active);
  advance(500); deliver(active.video, 0.033, 10, 100);
  advance(100); deliver(active.video, 0.066, 11, 300);
  advance(100); deliver(active.video, 0.099, 12, 350);
  expect(active.ready).not.toHaveBeenCalled(); // both timestamps precede the first submission
  advance(100); deliver(active.video, 0.132, 8, 100);
  advance(100); deliver(active.video, 0.165, 9, 100);
  expect(active.ready).not.toHaveBeenCalled(); // two increasing counts still replay older frame identities
  advance(100); deliver(active.video, 0.198, 13, 100);
  expect(active.ready).toHaveBeenCalledTimes(1);
});

test("a brief native pause that resumes by itself does not consume recovery", async () => {
  const active = await cold("brief-pause");
  active.video.pause(); advance(50);
  paused.set(active.video, false); active.video.dispatchEvent(new Event("playing"));
  advance(50);
  expect(active.recover).not.toHaveBeenCalled(); expect(active.failed).not.toHaveBeenCalled();
  advance(200); deliver(active.video, 0.4, 20);
  active.video.dispatchEvent(new Event("waiting")); advance(3250);
  expect(active.recover).toHaveBeenCalledWith("playback-stall");
});

