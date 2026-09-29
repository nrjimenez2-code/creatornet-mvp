/** @jest-environment jsdom */
import type { MobileFeedController as Controller } from "@/lib/mobileFeedController";

let controller: Controller;
let diagnostics: typeof import("@/lib/mobileFeedDiagnostics");
let frames: Map<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>;
let paused: WeakMap<HTMLMediaElement, boolean>;
let nextFrame: number;
let play: jest.SpyInstance;
const originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
const originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  frames = new Map(); paused = new WeakMap(); nextFrame = 0;
  jest.spyOn(document, "hidden", "get").mockReturnValue(false);
  jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); });
  jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  play = jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false);
    return Promise.resolve();
  });
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    const id = ++nextFrame;
    if (!frames.has(this)) frames.set(this, new Map());
    frames.get(this)!.set(id, callback);
    return id;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) { frames.get(this)?.delete(id); };
});

afterEach(() => {
  controller?.dispose();
  document.body.replaceChildren();
  if (originalRequest) HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest;
  else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  if (originalCancel) HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel;
  else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function prepare(ranges: number[][], debug = true) {
  window.history.replaceState({}, "", debug ? "/?feedDebug=1" : "/");
  diagnostics = require("@/lib/mobileFeedDiagnostics");
  const { MobileFeedController } = require("@/lib/mobileFeedController") as typeof import("@/lib/mobileFeedController");
  diagnostics.resetFeedTrace();
  controller = new MobileFeedController();
  const host = document.createElement("div"); document.body.appendChild(host);
  const present = jest.fn();
  controller.prepare({ postId: "diagnostic-neighbor", src: "https://example.test/neighbor.m3u8", host, present });
  const video = host.querySelector("video")!;
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 4 },
    networkState: { configurable: true, value: 2 },
    currentSrc: { configurable: true, get: () => video.src },
    duration: { configurable: true, value: 30 },
    seeking: { configurable: true, value: false },
    buffered: { configurable: true, value: { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] } },
  });
  video.dispatchEvent(new Event("loadedmetadata"));
  return { video, present };
}

function deliverFrame(video: HTMLVideoElement, time: number) {
  video.currentTime = time;
  const pending = [...(frames.get(video)?.values() ?? [])];
  frames.get(video)?.clear();
  pending.forEach(callback => callback(performance.now(), { mediaTime: time, presentedFrames: 1 } as VideoFrameCallbackMetadata));
}

function miss(attempt: number) {
  return diagnostics.exportFeedTrace().events.find(event => event.kind === "preparation-miss" && event.detail.attempt === attempt)?.detail;
}

test("a near-zero decoded frame exposes a buffered range that excludes the exact target", async () => {
  const { video, present } = prepare([[0.033, 4]]);
  await Promise.resolve();
  deliverFrame(video, 0.033);
  jest.advanceTimersByTime(2_500);

  expect(miss(1)).toEqual(expect.objectContaining({
    reason: "attempt-timeout", frameTarget: 0, position: 0.033,
    buffer: 0, bufferAtPosition: 3.967, bufferedRanges: "[[0.033,4]]", bufferedRangeCount: 1,
    frameValid: true, positioned: true, frameRequestPending: false,
    frameRequestCount: 1, frameCallbackCount: 1, lastFrameMediaTime: 0.033,
    paused: true, lastPauseReason: "target-frame", playRequestCount: 1, playResolvedCount: 1,
  }));
  expect(present).not.toHaveBeenCalledWith(true);
  expect(diagnostics.exportFeedTrace().events.some(event => event.kind === "preparation-ready")).toBe(false);
});

test("a buffered playing preparation distinguishes a pending callback from a received frame", async () => {
  prepare([[0, 4]]);
  await Promise.resolve();
  jest.advanceTimersByTime(2_500);

  expect(miss(1)).toEqual(expect.objectContaining({
    reason: "attempt-timeout", buffer: 4, bufferAtPosition: 4, bufferedRanges: "[[0,4]]",
    readyState: 4, networkState: 2, currentSourceMatches: true,
    frameValid: false, positioned: true, frameRequestPending: true,
    frameRequestCount: 1, frameCallbackCount: 0, lastFrameMediaTime: null,
    paused: false, seeking: false, decodeAllowed: true,
    playRequestCount: 1, playResolvedCount: 1, playRejectedCount: 0,
  }));
});

test("an unresolved play stays distinguishable and its late resolution cannot qualify the retry", async () => {
  const resolvePlay: Array<() => void> = [];
  play.mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false);
    return new Promise<void>(resolve => resolvePlay.push(resolve));
  });
  prepare([[0, 4]]);
  jest.advanceTimersByTime(2_500);
  expect(miss(1)).toEqual(expect.objectContaining({ playRequestCount: 1, playResolvedCount: 0, playRejectedCount: 0 }));

  jest.advanceTimersByTime(250);
  expect(resolvePlay).toHaveLength(2);
  resolvePlay[0]();
  await Promise.resolve();
  jest.advanceTimersByTime(2_500);
  expect(miss(2)).toEqual(expect.objectContaining({
    playRequestCount: 1, playResolvedCount: 0, playRejectedCount: 0,
    frameRequestCount: 1, frameCallbackCount: 0, frameRequestPending: true,
  }));
});

test("debug disabled skips preparation snapshots while retaining the two-attempt bound", async () => {
  const { video, present } = prepare([[0, 4]], false);
  const networkState = jest.fn(() => 2);
  Object.defineProperty(video, "networkState", { configurable: true, get: networkState });
  await Promise.resolve();
  jest.advanceTimersByTime(2_750);
  await Promise.resolve();
  jest.advanceTimersByTime(2_500);

  expect(networkState).not.toHaveBeenCalled();
  expect(diagnostics.exportFeedTrace().events).toEqual([]);
  expect(video.hasAttribute("src")).toBe(false);
  expect(present).not.toHaveBeenCalledWith(true);
});
