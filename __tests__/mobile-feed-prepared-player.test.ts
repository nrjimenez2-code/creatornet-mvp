/** @jest-environment jsdom */
// Ownership/guard tests only. Mocked media cannot establish WebKit sound grants,
// picture/audio continuity, native decoder release or physical performance.
import { MobileFeedController } from "@/lib/mobileFeedController.prototype";
import { adoptPreparedMobileFeedPlayer, claimMobileFeedPlayer, mobileFeedPlaybackReady, mobileFeedResumeSnapshot, ownsMobileFeedPlayer, releaseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";
import * as diagnostics from "@/lib/mobileFeedDiagnostics";

let controller: MobileFeedController;
let callbacks: Map<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>;
let paused: WeakMap<HTMLMediaElement, boolean>;
let requestId = 0;
let originalRequest: typeof HTMLVideoElement.prototype.requestVideoFrameCallback;
let originalCancel: typeof HTMLVideoElement.prototype.cancelVideoFrameCallback;
const src = (id: string) => `https://example.test/prepared-${id}.mp4`;
const events = (kind: string) => diagnostics.exportFeedTrace().events.filter(event => event.kind === kind);

function media(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 4 }, currentSrc: { configurable: true, get: () => video.src },
    duration: { configurable: true, value: 60 }, seeking: { configurable: true, value: false },
    videoWidth: { configurable: true, value: 240 }, videoHeight: { configurable: true, value: 426 },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 60 } },
  });
}
function deliver(video: HTMLVideoElement, time: number, count = Math.round(time * 30) + 1, age = 0) {
  video.currentTime = time;
  const pending = [...(callbacks.get(video)?.values() ?? [])]; callbacks.get(video)?.clear();
  pending.forEach(callback => callback(performance.now(), { mediaTime: time, presentedFrames: count,
    presentationTime: performance.now() - age } as VideoFrameCallbackMetadata));
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
  return { video, obsolete, target };
}
function activate(id: string, options: { contentVersion?: string; position?: number; reload?: boolean; playingIntent?: boolean; soundIntent?: boolean } = {}) {
  const host = document.createElement("div"), previewHost = document.createElement("div"); document.body.append(host, previewHost);
  const token = Symbol(id), ready = jest.fn(), failed = jest.fn(), present = jest.fn();
  const video = controller.activate({ postId: id, src: src(id), host, previewHost, token, ready, failed, present, ...options });
  media(video); video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("seeked"));
  return { video, token, ready, failed, present, host, previewHost };
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
  jest.useFakeTimers(); jest.setSystemTime(100_000);
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
  controller = new MobileFeedController("prepared");
});
afterEach(() => {
  controller.dispose(); document.body.innerHTML = "";
  if (originalRequest) HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest;
  else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  if (originalCancel) HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel;
  else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
  jest.restoreAllMocks(); jest.useRealTimers();
});

test("promotion revokes the old token, records one departure and keeps the prepared source/position without reload or seek", async () => {
  const first = await cold("a"); first.video.muted = false; first.video.currentTime = 0.2;
  const prepared = prepare("b"), position = prepared.video.currentTime;
  const load = jest.spyOn(prepared.video, "load"), loadCalls = load.mock.calls.length, seek = jest.spyOn(prepared.video, "currentTime", "set");
  const promoted = activate("b");
  expect(promoted.video).toBe(prepared.video); expect(promoted.video.currentTime).toBe(position);
  expect(load.mock.contexts.slice(loadCalls).filter(element => element === prepared.video)).toHaveLength(0);
  expect(seek).not.toHaveBeenCalled();
  expect(ownsMobileFeedPlayer(first.token, first.video)).toBe(false);
  expect(ownsMobileFeedPlayer(promoted.token, prepared.video, src("b"))).toBe(true);
  expect(first.video.paused).toBe(true); expect(first.video.muted).toBe(true);
  expect(first.video.hasAttribute("src")).toBe(false); expect(first.video.isConnected).toBe(false);
  expect(events("resume-departure").filter(event => event.detail.postId === "a")).toHaveLength(1);
  expect(mobileFeedResumeSnapshot("a", src("a")).position).toBe(0.2);
  expect(promoted.previewHost.querySelector("video")).toBeNull();
  prepared.obsolete.forEach(callback => callback(performance.now(), { mediaTime: 1 } as VideoFrameCallbackMetadata));
  expect(promoted.video.getAttribute("src")).toBe(src("b"));
  promoted.video.muted = false; await play(promoted);
  deliver(promoted.video, position); deliver(promoted.video, position + 1 / 30);
  expect(promoted.ready).toHaveBeenCalledTimes(1);
  expect(events("presentation-handoff").at(-1)?.detail).toEqual(expect.objectContaining({ reason: "prepared-player", muted: false, outputMeasured: false }));
  controller.dispose();
  expect(promoted.video.getAttribute("src")).toBe(src("b")); expect(promoted.video.paused).toBe(true);
});

test("retirement timing preserves native calls, source and ownership", async () => {
  const enabled = true;
  const first = await cold(`timing-first-${enabled}`), prepared = prepare(`timing-next-${enabled}`);
  controller.release(first.token);
  const host = document.createElement("div"), token = Symbol("timed-owner"); document.body.appendChild(host);
  const snapshot = mobileFeedResumeSnapshot(`timing-next-${enabled}`, src(`timing-next-${enabled}`));
  let now = 100, muted = first.video.muted;
  jest.spyOn(diagnostics, "feedTraceEnabled").mockReturnValue(enabled);
  jest.spyOn(performance, "now").mockImplementation(() => now);
  jest.mocked(HTMLMediaElement.prototype.pause).mockClear();
  jest.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, true); this.dispatchEvent(new Event("pause")); if (this === first.video) now += 2;
  });
  Object.defineProperty(first.video, "muted", { configurable: true, get: () => muted, set: value => { muted = value; now += 3; } });
  const load = jest.mocked(HTMLMediaElement.prototype.load); load.mockClear();
  load.mockImplementation(function (this: HTMLMediaElement) { if (this === first.video) now += 7; });
  const append = host.appendChild.bind(host);
  jest.spyOn(host, "appendChild").mockImplementation(child => { now += 5; return append(child); });
  const position = prepared.video.currentTime;
  const promoted = adoptPreparedMobileFeedPlayer(host, token, prepared.video, src(`timing-next-${enabled}`), snapshot, prepared.target + 1 / 30);
  expect(promoted).toBe(prepared.video); expect(ownsMobileFeedPlayer(token, prepared.video)).toBe(true);
  expect(prepared.video.currentTime).toBe(position); expect(prepared.video.getAttribute("src")).toBe(src(`timing-next-${enabled}`));
  expect(first.video.hasAttribute("src")).toBe(false); expect(first.video.isConnected).toBe(false); expect(muted).toBe(true);
  expect(load.mock.contexts).toEqual([first.video]); expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
  expect(events("main-transfer").at(-1)?.detail).toEqual(expect.objectContaining({
    adoptionStartedAt: 100, retiredPostId: `timing-first-${enabled}`, retiredPauseReturnedMs: 2, retiredMuteAppliedMs: 5,
    retiredTraceEndedMs: 5, retiredSourceRemovedMs: 5, retiredLoadReturnedMs: 12, retiredDetachedMs: 12, promotedAttachedMs: 17,
  }));
  releaseMobileFeedPlayer(token);
});

test("a moving media clock and quality counters without frame delivery retain the watchdog failure and expose its pending observer", async () => {
  await cold("missing-frame-first"); prepare("missing-frame-next");
  const active = activate("missing-frame-next");
  const quality = jest.fn().mockReturnValue({ totalVideoFrames: 90, droppedVideoFrames: 0 });
  Object.defineProperty(active.video, "getVideoPlaybackQuality", { configurable: true, value: quality });
  await play(active);
  active.video.currentTime = 2.9;
  jest.advanceTimersByTime(3_001);
  expect(active.ready).not.toHaveBeenCalled(); expect(active.failed).toHaveBeenCalledTimes(1);
  expect(active.video.paused).toBe(true);
  const timeout = events("handoff-timeout").at(-1);
  expect(timeout?.detail).toEqual(expect.objectContaining({
    targetObserved: false, playAccepted: true, position: 2.9,
    frameRequestCount: expect.any(Number), frameDeliveryCount: 0, frameDiscardCount: 0,
    frameRequestPending: true, frameRequestHandle: expect.any(Number), framePendingMs: expect.any(Number),
    totalVideoFrames: 90, connected: true, hidden: false, paused: false,
  }));
  expect(timeout?.detail.framePendingMs).toBeGreaterThanOrEqual(3_000);
  expect(events("lab-main-frame-request").filter(event => event.postId === "missing-frame-next").length).toBeLessThanOrEqual(8);
});

test("callback diagnostics stay off and cannot turn delivered obsolete callbacks into successor readiness", async () => {
  await cold("obsolete-frame-first"); prepare("obsolete-frame-next");
  const active = activate("obsolete-frame-next");
  const pending = [...(callbacks.get(active.video)?.values() ?? [])];
  controller.release(active.token);
  const successor = activate("obsolete-frame-successor");
  pending.forEach(callback => callback(performance.now(), { mediaTime: 0.1, presentedFrames: 4 } as VideoFrameCallbackMetadata));
  expect(successor.ready).not.toHaveBeenCalled(); expect(active.ready).not.toHaveBeenCalled();
  controller.dispose();
  window.history.replaceState({}, "", "/");
  jest.spyOn(diagnostics, "feedTraceEnabled").mockReturnValue(false);
  controller = new MobileFeedController("prepared");
  const quiet = activate("quiet-frame-diagnostics");
  const quality = jest.fn().mockReturnValue({ totalVideoFrames: 90, droppedVideoFrames: 0 });
  Object.defineProperty(quiet.video, "getVideoPlaybackQuality", { configurable: true, value: quality });
  await play(quiet); jest.advanceTimersByTime(3_001);
  expect(quiet.failed).toHaveBeenCalledTimes(1); expect(quality).not.toHaveBeenCalled();
});

test("diagnostics-off adoption adds no timing clock reads", () => {
  window.history.replaceState({}, "", "/");
  jest.isolateModules(() => {
    const api = jest.requireActual<typeof import("@/lib/mobileFeedPlayer")>("@/lib/mobileFeedPlayer");
    const firstToken = Symbol("off-first"), nextToken = Symbol("off-next"), host = document.createElement("div");
    document.body.appendChild(host);
    const first = api.claimMobileFeedPlayer(host, firstToken, src("off-first"), "off-first"); media(first);
    api.releaseMobileFeedPlayer(firstToken);
    const prepared = document.createElement("video"); prepared.src = src("off-next"); prepared.muted = true; media(prepared);
    prepared.currentTime = 1 / 30;
    const snapshot = api.mobileFeedResumeSnapshot("off-next", src("off-next"));
    const clock = jest.spyOn(performance, "now");
    expect(api.adoptPreparedMobileFeedPlayer(host, nextToken, prepared, src("off-next"), snapshot, 1 / 30)).toBe(prepared);
    expect(api.ownsMobileFeedPlayer(nextToken, prepared)).toBe(true);
    expect(clock).not.toHaveBeenCalled();
    api.releaseMobileFeedPlayer(nextToken);
  });
});

test("prepared handoff timing includes retirement before the existing activation trace starts", async () => {
  const first = await cold("timing-origin-first"); prepare("timing-origin-next");
  let now = 100; jest.spyOn(performance, "now").mockImplementation(() => now);
  jest.mocked(HTMLMediaElement.prototype.load).mockImplementation(function (this: HTMLMediaElement) { if (this === first.video) now += 70; });
  const next = activate("timing-origin-next"); await play(next);
  now = 200; deliver(next.video, 1 / 30);
  now = 230; deliver(next.video, 2 / 30);
  expect(events("prepared-player-selection").at(-1)?.detail).toEqual(expect.objectContaining({ activationRequestedAt: 100, selectionElapsedMs: 70 }));
  expect(events("presentation-handoff").at(-1)?.detail).toEqual(expect.objectContaining({ activationMs: 60, requestToHandoffMs: 130, outputMeasured: false }));
});

async function audioControl(id: string) {
  controller.dispose(); controller = new MobileFeedController("prepared-audio");
  const first = await cold(id); first.video.muted = false; await play(first);
  return first;
}

test("audio control unmutes only a ready paused slot, then promotes it without early play, load or seek", async () => {
  const first = await audioControl("audio-first"), prepared = prepare("audio-next");
  const playCalls = jest.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
  const load = jest.spyOn(prepared.video, "load"), loadCalls = load.mock.calls.length;
  const seek = jest.spyOn(prepared.video, "currentTime", "set");
  expect(prepared.video.muted).toBe(false); expect(prepared.video.paused).toBe(true);
  first.video.dispatchEvent(new Event("progress")); jest.advanceTimersByTime(1_000);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCalls);
  const next = activate("audio-next", { soundIntent: true, playingIntent: true });
  expect(next.video).toBe(prepared.video); expect(next.video.muted).toBe(false); expect(next.video.paused).toBe(true);
  expect(first.video.paused).toBe(true); expect(first.video.muted).toBe(true);
  expect(load.mock.contexts.slice(loadCalls).filter(element => element === prepared.video)).toHaveLength(0);
  expect(seek).not.toHaveBeenCalled();
  expect(events("prepared-player-selection").at(-1)?.detail.preparationAudio).toBe("paused-unmuted");
  expect(events("preparation-sound-state").at(-1)?.detail).toEqual(expect.objectContaining({ enabled: true, paused: true, muted: false, outputMeasured: false }));
  await play(next); deliver(next.video, 1 / 30); deliver(next.video, 2 / 30);
  expect(next.ready).toHaveBeenCalledTimes(1);
  expect([...document.querySelectorAll("video")].filter(video => !video.paused && !video.muted)).toEqual([next.video]);
});

test("audio control stays muted until a current unmuted request resolves; obsolete requests cannot enable it", async () => {
  controller.dispose(); controller = new MobileFeedController("prepared-audio");
  const first = activate("audio-pending-first"); first.video.muted = true; await play(first);
  deliver(first.video, 1 / 30); deliver(first.video, 2 / 30);
  const prepared = prepare("audio-pending-next");
  expect(prepared.video.muted).toBe(true);
  first.video.muted = false;
  let resolve!: () => void;
  await play(first, new Promise<void>(settled => { resolve = settled; }));
  expect(prepared.video.muted).toBe(true);
  first.video.muted = true; await play(first);
  resolve(); await Promise.resolve();
  expect(prepared.video.muted).toBe(true);
  first.video.muted = false; await play(first);
  expect(prepared.video.muted).toBe(false); expect(prepared.video.paused).toBe(true);
});

test("audio control decodes muted and cannot enable a stale ready source on later main sound acceptance", async () => {
  await audioControl("audio-acquire-first");
  const host = document.createElement("div"); document.body.appendChild(host);
  controller.prepare({ postId: "audio-acquire-next", src: src("audio-acquire-next"), host, present: jest.fn() });
  const video = host.querySelector("video")!; media(video);
  expect(video.muted).toBe(true); expect(video.paused).toBe(false);
  video.dispatchEvent(new Event("loadedmetadata")); deliver(video, 1 / 30);
  expect(video.paused).toBe(true); expect(video.muted).toBe(false);
  Object.defineProperty(video, "buffered", { value: { length: 0 } });
  // Progress on the current main rechecks qualification before retaining audio.
  const active = [...document.querySelectorAll("video")].find(element => !element.paused)!;
  active.dispatchEvent(new Event("progress"));
  expect(video.muted).toBe(true);
  const next = activate("audio-acquire-next", { soundIntent: true });
  expect(next.video).not.toBe(video);
});

test.each(["mute", "pause", "hidden", "cancel", "denied"])("audio control revokes paused sound on %s", async reason => {
  const first = await audioControl(`audio-revoke-${reason}`), prepared = prepare(`audio-revoke-next-${reason}`);
  expect(prepared.video.muted).toBe(false);
  if (reason === "mute") { first.video.muted = true; await play(first); }
  if (reason === "pause") { controller.pauseRequested(first.token); first.video.pause(); }
  if (reason === "hidden") { Object.defineProperty(document, "hidden", { value: true }); controller.suspend(); }
  if (reason === "cancel") controller.cancelPreparation();
  if (reason === "denied") await play(first, Promise.reject(new DOMException("blocked", "NotAllowedError")));
  expect(prepared.video.muted).toBe(true); expect(prepared.video.paused).toBe(true);
  if (["hidden", "cancel", "denied"].includes(reason)) expect(prepared.video.hasAttribute("src")).toBe(false);
});

test.each([{ soundIntent: false }, { soundIntent: true, playingIntent: false }])("selection intent %j revokes prepared audio before adoption", async intent => {
  await audioControl("audio-intent-first"); const prepared = prepare("audio-intent-next");
  const next = activate("audio-intent-next", intent);
  expect(next.video).toBe(prepared.video); expect(next.video.muted).toBe(true); expect(next.video.paused).toBe(true);
  expect(events("prepared-player-selection").at(-1)?.detail.preparationAudio).toBe("muted");
});

test.each(["playing", "source", "reload"])("audio control %s preparation still cannot promote", async reason => {
  const id = `audio-invalid-next-${reason}`, first = await audioControl(`audio-invalid-first-${reason}`);
  const prepared = prepare(id);
  if (reason === "playing") paused.set(prepared.video, false);
  if (reason === "source") Object.defineProperty(prepared.video, "currentSrc", { value: "https://example.test/wrong.mp4" });
  const next = activate(id, { soundIntent: true, reload: reason === "reload" });
  expect(next.video).not.toBe(prepared.video);
  expect(prepared.video.paused).toBe(true); expect(prepared.video.muted).toBe(true);
  expect(prepared.video.hasAttribute("src")).toBe(false);
  expect(next.video).toBe(first.video);
});

test("paused unmuted preparation cannot bypass the exact saved-return expiry", async () => {
  const first = await audioControl("audio-expiry-saved"); first.video.currentTime = 12;
  const other = await cold("audio-expiry-other"); other.video.muted = false; await play(other);
  const prepared = prepare("audio-expiry-saved"); expect(prepared.video.muted).toBe(false);
  jest.setSystemTime(105_000);
  const returned = activate("audio-expiry-saved", { soundIntent: true });
  expect(returned.video).toBe(other.video); expect(returned.video).not.toBe(prepared.video);
  expect(events("resume-decision").at(-1)?.detail.position).toBe(0);
  expect(prepared.video.muted).toBe(true); expect(prepared.video.paused).toBe(true);
});

test.each(["source", "content", "target", "clock", "playing", "unmuted", "rate", "buffer", "dimensions", "ready", "seeking", "reload"])("%s mismatch rejects promotion and uses a cold main without an independent bridge", async mismatch => {
  const first = await cold(`guard-first-${mismatch}`), id = `guard-next-${mismatch}`;
  const prepared = prepare(id);
  if (mismatch === "source") Object.defineProperty(prepared.video, "currentSrc", { value: "https://example.test/wrong.mp4" });
  if (mismatch === "clock") prepared.video.currentTime = 2;
  if (mismatch === "playing") paused.set(prepared.video, false);
  if (mismatch === "unmuted") prepared.video.muted = false;
  if (mismatch === "rate") prepared.video.playbackRate = 0.75;
  if (mismatch === "buffer") Object.defineProperty(prepared.video, "buffered", { value: { length: 0 } });
  if (mismatch === "dimensions") Object.defineProperty(prepared.video, "videoWidth", { value: 0 });
  if (mismatch === "ready") Object.defineProperty(prepared.video, "readyState", { value: 1 });
  if (mismatch === "seeking") Object.defineProperty(prepared.video, "seeking", { value: true });
  const next = activate(id, { contentVersion: mismatch === "content" ? "replacement" : undefined,
    position: mismatch === "target" ? 5 : undefined, reload: mismatch === "reload" });
  expect(next.video).toBe(first.video); expect(next.video).not.toBe(prepared.video);
  expect(prepared.video.hasAttribute("src")).toBe(false); expect(prepared.video.paused).toBe(true);
  expect(next.previewHost.querySelector("video")).toBeNull(); expect(next.present).toHaveBeenCalledWith(false);
  expect(events("prepared-player-selection").at(-1)?.detail.result).toBe("cold-fallback");
});

test.each([4_999, 5_000, 5_001])("prepared return at %i ms checks the live fixed departure deadline", async delay => {
  const id = `return-${delay}`, first = await cold(id); first.video.currentTime = 12;
  const other = await cold(`other-${delay}`), prepared = prepare(id);
  jest.setSystemTime(100_000 + delay);
  const returned = activate(id);
  expect(returned.video).toBe(delay < 5_000 ? prepared.video : other.video);
  expect(events("resume-decision").at(-1)?.detail.position).toBe(delay < 5_000 ? 12 : 0);
  expect(returned.video.currentTime).toBe(delay < 5_000 ? 12 + 1 / 30 : 0);
});

test.each([4_999, 5_000, 5_001])("a conventional departure also obeys the prepared mode's exact %i ms boundary", delay => {
  const id = `conventional-${delay}`, token = Symbol(id);
  const previous = claimMobileFeedPlayer(document.createElement("div"), token, src(id), id, { managedResume: false });
  media(previous); previous.currentTime = 12; releaseMobileFeedPlayer(token);
  const prepared = prepare(id); jest.setSystemTime(100_000 + delay);
  const returned = activate(id);
  expect(returned.video).toBe(delay < 5_000 ? prepared.video : previous);
  expect(events("resume-decision").at(-1)?.detail.position).toBe(delay < 5_000 ? 12 : 0);
});

test("stale, duplicate-count and seeking frames cannot qualify; an advancing fresh submitted pair can", async () => {
  prepare("fresh"); const active = activate("fresh"); await play(active);
  deliver(active.video, 1 / 30, 1, 300); deliver(active.video, 2 / 30, 2, 300);
  expect(active.ready).not.toHaveBeenCalled();
  deliver(active.video, 3 / 30, 3); deliver(active.video, 4 / 30, 3);
  expect(active.ready).not.toHaveBeenCalled();
  Object.defineProperty(active.video, "seeking", { configurable: true, value: true });
  active.video.dispatchEvent(new Event("seeking")); deliver(active.video, 10, 10);
  expect(active.ready).not.toHaveBeenCalled();
  Object.defineProperty(active.video, "seeking", { value: false });
  active.video.currentTime = 1; active.video.dispatchEvent(new Event("seeking"));
  deliver(active.video, 1, 31); deliver(active.video, 1 + 1 / 30, 32);
  expect(active.ready).toHaveBeenCalledTimes(1);
});

test("a rejected sound play keeps the attempt failed and does not qualify frames or prepare a moving neighbor", async () => {
  prepare("denied"); const active = activate("denied"); active.video.muted = false;
  await play(active, Promise.reject(new DOMException("gesture required", "NotAllowedError")));
  deliver(active.video, 1 / 30); deliver(active.video, 2 / 30);
  jest.advanceTimersByTime(3_001);
  expect(active.ready).not.toHaveBeenCalled(); expect(active.video.paused).toBe(true);
  expect(events("prepared-player-play-rejected")).toHaveLength(1);
  expect(controller.canPlay(active.token)).toBe(true); // explicit gesture may recover this live owner
});

test("pause and hidden suspension preserve the source without firing Retry; resumed playback still has a bounded watchdog", async () => {
  prepare("pause"); const active = activate("pause"); await play(active); active.video.pause();
  jest.advanceTimersByTime(3_001); expect(active.failed).not.toHaveBeenCalled();
  Object.defineProperty(document, "hidden", { configurable: true, value: true }); controller.suspend();
  expect(active.video.getAttribute("src")).toBe(src("pause"));
  Object.defineProperty(document, "hidden", { value: false }); await play(active);
  jest.advanceTimersByTime(3_000); expect(active.failed).toHaveBeenCalledTimes(1);
  expect(controller.canPlay(active.token)).toBe(false);
  const retry = activate("pause", { reload: true }); expect(retry.video).toBe(active.video);
  expect(events("prepared-player-selection").at(-1)?.detail.result).toBe("cold-fallback");
});

test("waiting before automatic play and an obsolete queued pause do not extend the activation watchdog", async () => {
  const active = activate("watchdog-deadline", { position: 12 });
  active.video.dispatchEvent(new Event("pause")); // queued departure while awaiting playback
  jest.advanceTimersByTime(2_000); await play(active);
  active.video.dispatchEvent(new Event("pause")); // paused is false: an obsolete event
  jest.advanceTimersByTime(999); expect(active.failed).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); expect(active.failed).toHaveBeenCalledTimes(1);
});

test.each(["initial", "requested"])("a deliberately %s paused activation can wait before its explicit play attempt", async kind => {
  const active = activate(`paused-entry-${kind}`, { playingIntent: kind === "requested" });
  if (kind === "requested") controller.pauseRequested(active.token);
  jest.advanceTimersByTime(5_000); expect(active.failed).not.toHaveBeenCalled();
  await play(active); jest.advanceTimersByTime(2_999); expect(active.failed).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); expect(active.failed).toHaveBeenCalledTimes(1);
});

test("repeated promotion bounds source-bearing elements and disposal cannot clear the promoted source", async () => {
  let active = await cold("bounded-0"); const retired: HTMLVideoElement[] = [];
  for (let i = 1; i <= 30; i++) {
    const prepared = prepare(`bounded-${i}`); retired.push(active.video);
    active = activate(`bounded-${i}`); expect(active.video).toBe(prepared.video);
    await play(active); deliver(active.video, 1 / 30); deliver(active.video, 2 / 30);
    expect(document.querySelectorAll("video[src]").length).toBeLessThanOrEqual(2);
    expect(document.querySelectorAll('video[data-mobile-preparation="true"]').length).toBe(0);
    expect(retired.every(video => !video.hasAttribute("src") && !video.isConnected && video.paused)).toBe(true);
  }
  controller.dispose(); expect(active.video.hasAttribute("src")).toBe(true);
  jest.advanceTimersByTime(5_000); expect(active.video.hasAttribute("src")).toBe(false);
});

test("a deferred old parking ticket and cancelled preparation cannot move or unload a promoted owner", async () => {
  const first = await cold("deferred-a"), prepared = prepare("deferred-b");
  controller.releaseForTransfer(first.token);
  const active = activate("deferred-b"); jest.runAllTicks();
  controller.cancelPreparation("deferred-b");
  expect(active.video).toBe(prepared.video); expect(active.video.parentElement).toBe(active.host);
  expect(ownsMobileFeedPlayer(active.token, active.video)).toBe(true);
  expect(first.video.hasAttribute("src")).toBe(false);
  expect(active.video.getAttribute("src")).toBe(src("deferred-b"));
});

test("neighbor decoding waits for qualified active motion and ordinary claims can reuse the released promoted owner", async () => {
  const first = activate("priority-a"); await play(first);
  const host = document.createElement("div"); document.body.appendChild(host);
  const playMock = jest.mocked(HTMLMediaElement.prototype.play), calls = playMock.mock.calls.length;
  controller.prepare({ postId: "priority-b", src: src("priority-b"), host, present: jest.fn() });
  const neighbor = host.querySelector("video")!; media(neighbor);
  neighbor.dispatchEvent(new Event("loadedmetadata"));
  expect(playMock.mock.contexts.slice(calls).filter(video => video === neighbor)).toHaveLength(0);
  deliver(first.video, 1 / 30); deliver(first.video, 2 / 30);
  expect(playMock.mock.contexts.slice(calls).filter(video => video === neighbor).length).toBeGreaterThan(0);
  deliver(neighbor, 1 / 30); const promoted = activate("priority-b");
  controller.dispose(); controller = new MobileFeedController("steady");
  const ordinary = activate("ordinary-return");
  expect(ordinary.video).toBe(promoted.video);
  expect(ordinary.video.dataset.mobilePreparation).toBeUndefined();
  expect(document.querySelectorAll('video[data-mobile-preparation="true"]').length).toBe(0);
  expect(ownsMobileFeedPlayer(promoted.token, promoted.video)).toBe(false);
});
