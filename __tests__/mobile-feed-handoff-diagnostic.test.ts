/** @jest-environment jsdom */
import { MobileFeedController } from "@/lib/mobileFeedController";
import { exportFeedTrace, resetFeedTrace } from "@/lib/mobileFeedDiagnostics";

test("the opt-in watchdog trace distinguishes a received but unqualified frame", () => {
  window.history.replaceState({}, "", "/?feedDebug=1");
  jest.useFakeTimers();
  resetFeedTrace();
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  let nextFrame = 0;
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  const originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
  const originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;
  HTMLVideoElement.prototype.requestVideoFrameCallback = callback => {
    callbacks.set(++nextFrame, callback);
    return nextFrame;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = id => { callbacks.delete(id); };
  const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false);
    return Promise.resolve();
  });
  const pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); });
  const pausedGetter = jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  const controller = new MobileFeedController();
  const token = Symbol("diagnostic");
  try {
    const video = controller.activate({
      postId: "diagnostic", src: "https://example.test/diagnostic.mp4", token,
      host: document.createElement("div"), previewHost: document.createElement("div"),
      present: jest.fn(), ready: jest.fn(), failed: jest.fn(),
    });
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 4 },
      currentSrc: { configurable: true, get: () => video.src },
      seeking: { configurable: true, value: false },
    });
    void video.play();
    for (const callback of [...callbacks.values()]) callback(performance.now(), { mediaTime: 0, presentedFrames: 1 } as VideoFrameCallbackMetadata);
    jest.advanceTimersByTime(3_000);
    const timeout = exportFeedTrace().events.find(event => event.kind === "handoff-timeout");
    expect(timeout?.detail).toEqual(expect.objectContaining({
      mainCallbackCount: 1, mainValidCount: 0, firstMainReject: "first-frame",
      targetObserved: true, currentSourceMatches: true, readyState: 4,
    }));
  } finally {
    controller.release(token, false);
    if (originalRequest) HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest;
    else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    if (originalCancel) HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel;
    else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
    play.mockRestore(); pause.mockRestore(); pausedGetter.mockRestore();
    jest.useRealTimers();
  }
});

test("the opt-in handoff trace separates frame request, callback and qualification times", () => {
  window.history.replaceState({}, "", "/?feedDebug=1");
  jest.useFakeTimers();
  resetFeedTrace();
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  let nextFrame = 0;
  const originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
  const originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;
  HTMLVideoElement.prototype.requestVideoFrameCallback = callback => { callbacks.set(++nextFrame, callback); return nextFrame; };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = id => { callbacks.delete(id); };
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, false); return Promise.resolve(); });
  const pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); });
  const pausedGetter = jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  const controller = new MobileFeedController();
  const token = Symbol("handoff-diagnostic");
  try {
    const ready = jest.fn();
    const video = controller.activate({
      postId: "handoff-diagnostic", src: "https://example.test/diagnostic.mp4", token,
      host: document.createElement("div"), previewHost: document.createElement("div"),
      present: jest.fn(), ready, failed: jest.fn(),
    });
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 4 },
      currentSrc: { configurable: true, get: () => video.src },
      seeking: { configurable: true, value: false },
    });
    void video.play();
    const deliver = (time: number, count: number) => {
      video.currentTime = time;
      const pending = [...callbacks.values()]; callbacks.clear();
      pending.forEach(callback => callback(performance.now(), { mediaTime: time, presentedFrames: count } as VideoFrameCallbackMetadata));
    };
    deliver(0, 1);
    jest.advanceTimersByTime(500);
    deliver(0.04, 2);
    const diagnostic = exportFeedTrace().events.find(event => event.kind === "handoff-frame-diagnostic");
    expect(ready).toHaveBeenCalledTimes(1);
    expect(diagnostic?.detail).toEqual(expect.objectContaining({
      mainRequestCount: 2, mainCallbackCount: 2, mainValidCount: 1,
      firstMainReject: "first-frame", targetObserved: true,
      firstMainRequestMs: expect.any(Number), firstMainCallbackMs: expect.any(Number), firstMainValidMs: expect.any(Number),
    }));
    expect(diagnostic?.detail.firstMainValidMs).toBeGreaterThanOrEqual(500);
  } finally {
    controller.release(token, false);
    if (originalRequest) HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest;
    else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    if (originalCancel) HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel;
    else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
    play.mockRestore(); pause.mockRestore(); pausedGetter.mockRestore();
    jest.useRealTimers();
  }
});
