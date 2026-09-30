/** @jest-environment jsdom */
import { MobileFeedController } from "@/lib/mobileFeedController";
import { claimMobileFeedPlayer, mobileFeedPlaybackReady, releaseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";
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
function pendingPreparation(id: string) {
  let reject!: (reason: DOMException) => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  jest.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(function (this: HTMLMediaElement) {
    paused.set(this, false); this.dispatchEvent(new Event("play")); return pending;
  });
  return { ...prepare(id), reject };
}
function activate(id: string, src: string, buffer = 10) {
  const ready = jest.fn(), failed = jest.fn(), present = jest.fn(), token = Symbol(id);
  const host = document.createElement("div"), previewHost = document.createElement("div"); document.body.append(host, previewHost);
  const video = controller.activate({ postId: id, src, host, previewHost, token, ready, failed, present }); media(video, buffer);
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

test("a network stalled event with healthy main playback keeps neighbor preparation running", () => {
  const active = activate("network-stalled-main", "https://example.test/network-stalled-main.mp4", 2);
  const p = prepare("network-stalled-neighbor");
  expect(p.video.paused).toBe(false);
  active.video.dispatchEvent(new Event("stalled"));
  expect(active.video.paused).toBe(false);
  expect(p.video.paused).toBe(false);
  frame(p.video, 0.033);
  expect(p.present).toHaveBeenCalledWith(true);
});

test("actual waiting pauses neighbor preparation until main playback resumes", () => {
  const active = activate("waiting-main", "https://example.test/waiting-main.mp4", 2);
  const p = prepare("waiting-neighbor");
  expect(p.video.paused).toBe(false);
  active.video.dispatchEvent(new Event("waiting"));
  expect(p.video.paused).toBe(true);
  active.video.dispatchEvent(new Event("progress"));
  expect(p.video.paused).toBe(true);
  active.video.dispatchEvent(new Event("playing"));
  expect(p.video.paused).toBe(false);
  frame(p.video, 0.033);
  expect(p.present).toHaveBeenCalledWith(true);
});

test("a network stalled event still yields to insufficient main buffer and resumes when it refills", () => {
  const active = activate("stalled-low-buffer-main", "https://example.test/stalled-low-buffer-main.mp4", 2);
  const p = prepare("stalled-low-buffer-neighbor");
  expect(p.video.paused).toBe(false);
  media(active.video, 0.2);
  active.video.dispatchEvent(new Event("stalled"));
  expect(p.video.paused).toBe(true);
  expect(p.present).not.toHaveBeenCalledWith(true);
  media(active.video, 2);
  active.video.dispatchEvent(new Event("progress"));
  expect(p.video.paused).toBe(false);
  frame(p.video, 0.033);
  expect(p.present).toHaveBeenCalledWith(true);
});

test("activating another post preserves the still-selected ready return neighbor", () => {
  const selected = prepare("selected-return"); frame(selected.video, 0.033);
  const incoming = activate("incoming-other", "https://example.test/incoming-other.mp4");
  expect(selected.video.getAttribute("src")).toBe(selected.src);
  expect(selected.video.paused).toBe(true);
  expect(incoming.previewHost.querySelector("video")).toBeNull();
  expect(incoming.present).toHaveBeenLastCalledWith(false);
  const returned = activate("selected-return", selected.src);
  expect(returned.video).toBe(incoming.video);
  expect(returned.previewHost.querySelector("video")).toBe(selected.video);
  expect(returned.present).toHaveBeenLastCalledWith(true);
});

test("retained partial preparation pauses for a new main buffer and resumes without another slot", () => {
  const selected = prepare("selected-partial"); media(selected.video, 0.2);
  const token = Symbol("buffer-gated-incoming");
  const video = controller.activate({ postId: "buffer-gated-incoming", src: "https://example.test/buffer-gated-incoming.mp4",
    host: document.createElement("div"), previewHost: document.createElement("div"), token, present: jest.fn(), ready: jest.fn() });
  media(video, 0.2); void video.play(); video.dispatchEvent(new Event("playing"));
  expect(selected.video.src).toBe(selected.src); expect(selected.video.paused).toBe(true);
  media(selected.video, 2); selected.video.dispatchEvent(new Event("progress"));
  expect(selected.video.paused).toBe(true); expect(selected.present).not.toHaveBeenCalledWith(true);
  media(video, 2); video.dispatchEvent(new Event("progress"));
  expect(selected.video.paused).toBe(false); frame(selected.video, 0.033);
  expect(selected.present).toHaveBeenLastCalledWith(true);
  expect(selected.video.paused).toBe(true);
  const returned = activate("selected-partial", selected.src);
  expect(returned.previewHost.querySelector("video")).toBe(selected.video);
  expect(returned.present).toHaveBeenLastCalledWith(true);
  expect(document.querySelectorAll("video[data-mobile-preparation]")).toHaveLength(1);
});

test("a pending preparation play aborted by incoming decoder priority remains recoverable", async () => {
  const selected = pendingPreparation("priority-abort");
  const incoming = activate("priority-main", "https://example.test/priority-main.mp4", 0.2);
  expect(selected.video.paused).toBe(true);
  selected.reject(new DOMException("Interrupted by pause", "AbortError")); await Promise.resolve();
  expect(frames.get(selected.video)?.size).toBe(1);
  expect(selected.video.src).toBe(selected.src);
  media(incoming.video, 2); incoming.video.dispatchEvent(new Event("progress"));
  frame(selected.video, 0.033); expect(selected.present).toHaveBeenLastCalledWith(true);
});

test("an old pending play rejection cannot cancel preparation after priority resumes it", async () => {
  const selected = pendingPreparation("resumed-abort");
  const incoming = activate("resumed-main", "https://example.test/resumed-main.mp4", 0.2);
  media(incoming.video, 2); incoming.video.dispatchEvent(new Event("progress"));
  expect(selected.video.paused).toBe(false);
  selected.reject(new DOMException("Queued pause rejection", "AbortError")); await Promise.resolve();
  expect(frames.get(selected.video)?.size).toBe(1);
  frame(selected.video, 0.033); expect(selected.present).toHaveBeenLastCalledWith(true);
});

test("a timed-out attempt's pending play rejection cannot destroy the buffered retry", async () => {
  const selected = pendingPreparation("retry-play-abort");
  jest.advanceTimersByTime(2_750);
  selected.reject(new DOMException("Obsolete attempt", "NotSupportedError")); await Promise.resolve();
  expect(selected.video.src).toBe(selected.src);
  expect(frames.get(selected.video)?.size).toBe(1);
  frame(selected.video, 0.033); expect(selected.present).toHaveBeenLastCalledWith(true);
});

test("a corrective seek's pending play rejection does not cancel target reacquisition", async () => {
  const selected = pendingPreparation("corrective-play-abort"); frame(selected.video, 0.2);
  expect(selected.video.currentTime).toBe(0);
  selected.reject(new DOMException("Interrupted by corrective pause", "AbortError")); await Promise.resolve();
  expect(frames.get(selected.video)?.size).toBe(1);
  frame(selected.video, 0.033); expect(selected.present).toHaveBeenLastCalledWith(true);
});

test("current preparation play failures still exhaust the two-attempt bound", async () => {
  jest.mocked(HTMLMediaElement.prototype.play)
    .mockRejectedValueOnce(new DOMException("Playback denied", "NotAllowedError"))
    .mockRejectedValueOnce(new DOMException("Unsupported source", "NotSupportedError"));
  const selected = prepare("current-play-error"); await Promise.resolve();
  expect(frames.get(selected.video)?.size).toBe(0); expect(selected.video.src).toBe(selected.src);
  jest.advanceTimersByTime(250); await Promise.resolve();
  expect(selected.video.hasAttribute("src")).toBe(false);
  expect(selected.present).not.toHaveBeenCalledWith(true);
});

test("a current media error still fails preparation while decoder priority pauses it", () => {
  const selected = prepare("paused-media-error");
  const incoming = activate("paused-media-main", "https://example.test/paused-media-main.mp4", 0.2);
  expect(selected.video.paused).toBe(true);
  selected.video.dispatchEvent(new Event("error"));
  expect(frames.get(selected.video)?.size).toBe(0);
  media(incoming.video, 2); incoming.video.dispatchEvent(new Event("progress"));
  jest.advanceTimersByTime(250); selected.video.dispatchEvent(new Event("error"));
  expect(selected.video.hasAttribute("src")).toBe(false);
  expect(selected.present).not.toHaveBeenCalledWith(true);
});

test("pausing a pending preparation play does not extend its attempt deadline", async () => {
  const selected = pendingPreparation("paused-attempt-deadline");
  jest.advanceTimersByTime(1_500);
  activate("deadline-main", "https://example.test/deadline-main.mp4", 0.2);
  selected.reject(new DOMException("Interrupted by priority", "AbortError")); await Promise.resolve();
  jest.advanceTimersByTime(999); expect(frames.get(selected.video)?.size).toBe(1);
  jest.advanceTimersByTime(1); expect(frames.get(selected.video)?.size).toBe(0);
  expect(selected.video.src).toBe(selected.src);
});

test("changing the selected neighbor cancels a preparation retained across another activation", () => {
  const selected = prepare("retained-old");
  const stale = [...frames.get(selected.video)!.values()][0];
  activate("retained-incoming", "https://example.test/retained-incoming.mp4");
  const next = prepare("retained-next");
  stale(performance.now(), { mediaTime: 0.033 } as VideoFrameCallbackMetadata);
  expect(selected.present).not.toHaveBeenCalledWith(true);
  expect(next.present).not.toHaveBeenCalledWith(true);
  frame(next.video, 0.033); expect(next.present).toHaveBeenLastCalledWith(true);
  controller.cancelPreparation("retained-next"); expect(next.video.hasAttribute("src")).toBe(false);
});

test("a retained saved-position preparation expires without rewinding the new active post", () => {
  const saved = activate("retained-expiry", "https://example.test/retained-expiry.mp4");
  saved.video.currentTime = 12.4; controller.release(saved.token);
  const selected = prepare("retained-expiry"); frame(selected.video, 12.4);
  const incoming = activate("expiry-incoming", "https://example.test/expiry-incoming.mp4");
  frame(incoming.video, 2.3); frame(incoming.video, 2.333);
  jest.advanceTimersByTime(5_000);
  expect(selected.video.hasAttribute("src")).toBe(false);
  expect(incoming.video.currentTime).toBe(2.333);
  const returned = activate("retained-expiry", selected.src);
  expect(returned.previewHost.querySelector("video")).toBeNull(); expect(returned.video.currentTime).toBe(0);
});

test("activation never retains a mismatched preparation for the same post", () => {
  const selected = prepare("retained-source", "https://example.test/old-version.mp4"); frame(selected.video, 0.033);
  const active = activate("retained-source", "https://example.test/new-version.mp4");
  expect(selected.video.hasAttribute("src")).toBe(false);
  expect(active.previewHost.querySelector("video")).toBeNull(); expect(active.present).toHaveBeenLastCalledWith(false);
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

test("a stale main frame cannot trigger a new bridge seek just before an aligned main callback", async () => {
  const p = prepare("stale-main-alignment"); frame(p.video, 0.033);
  const active = activate("stale-main-alignment", p.src);
  await Promise.resolve(); // A reused shared player can finish its zero-start seek in a microtask.
  clockedFrame(p.video, 0.125, 0.125, 3);
  clockedFrame(p.video, 0.166667, 0.166667, 4);
  clockedFrame(active.video, 0, 0.02, 1);
  clockedFrame(active.video, 0.041667, 0.0684, 2);
  expect(p.video.currentTime).toBe(0.0684); // Initial bridge resync is still allowed.
  jest.advanceTimersByTime(1_000);
  active.video.currentTime = 1.067988;
  clockedFrame(p.video, 1.083333, 1.083333, 26);
  expect(p.video.currentTime).toBe(1.083333); // Wait for fresh main evidence before seeking again.
  clockedFrame(active.video, 1.041667, 1.067988, 26);
  expect(active.ready).toHaveBeenCalledTimes(1);
  expect(active.failed).not.toHaveBeenCalled();
  jest.advanceTimersByTime(3_000);
  expect(active.failed).not.toHaveBeenCalled();
});

test("a bridge frame matching an old main frame cannot release stale presentation", async () => {
  const p = prepare("stale-main-release"); frame(p.video, 0.033);
  const active = activate("stale-main-release", p.src);
  await Promise.resolve();
  clockedFrame(p.video, 0.125, 0.125, 3);
  clockedFrame(p.video, 0.166667, 0.166667, 4);
  clockedFrame(active.video, 0, 0.02, 1);
  clockedFrame(active.video, 0.041667, 0.0684, 2);
  jest.advanceTimersByTime(1_000);
  active.video.currentTime = 1.067988;
  clockedFrame(p.video, 0.041667, 0.041667, 26);
  expect(active.ready).not.toHaveBeenCalled();
  clockedFrame(active.video, 1.041667, 1.067988, 26);
  expect(active.ready).not.toHaveBeenCalled();
  expect(p.video.currentTime).toBe(1.067988); // The fresh main frame may resync the bridge.
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

test("candidate activation corrects a missed return before moving-main handoff", async () => {
  const seed = Symbol("correction-seed");
  const video = claimMobileFeedPlayer(document.createElement("div"), seed, "https://example.test/seed.mp4", "correction-seed");
  releaseMobileFeedPlayer(seed);
  let readyState = 0, position = 0;
  const writes: number[] = [];
  Object.defineProperties(video, {
    readyState: { configurable: true, get: () => readyState },
    currentTime: { configurable: true, get: () => position, set: value => { writes.push(value); position = writes.length === 1 ? 8 : value; } },
    currentSrc: { configurable: true, get: () => video.src },
  });
  const token = Symbol("corrected-main"), ready = jest.fn(), failed = jest.fn();
  const target = 11.521602;
  controller.activate({ postId: "corrected-main", src: "https://example.test/return.m3u8", position: target,
    host: document.createElement("div"), previewHost: document.createElement("div"), token, present: jest.fn(), ready, failed });
  const pending = mobileFeedPlaybackReady(token)!;
  readyState = 1; video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("seeked"));
  expect(writes).toEqual([target]); expect(ready).not.toHaveBeenCalled();
  readyState = 4; video.dispatchEvent(new Event("loadeddata"));
  expect(writes).toEqual([target, target]);
  video.dispatchEvent(new Event("seeked")); await pending;
  media(video, 20); void video.play(); video.dispatchEvent(new Event("playing"));
  frame(video, target + 0.033); frame(video, target + 0.066);
  expect(ready).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(3_000); expect(failed).not.toHaveBeenCalled();
  controller.release(token);
});
