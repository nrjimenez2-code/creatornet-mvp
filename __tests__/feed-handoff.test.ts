/** @jest-environment jsdom */
import { scheduleFeedBackground, scheduleFeedTelemetry } from "@/lib/feedBackground";

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.runOnlyPendingTimers(); jest.useRealTimers(); });

test("generation-owned background work is deferred and cancellable", () => {
  const work = jest.fn();
  const cancel = scheduleFeedBackground(work);
  expect(work).not.toHaveBeenCalled();
  cancel();
  jest.runOnlyPendingTimers();
  expect(work).not.toHaveBeenCalled();
  scheduleFeedBackground(work);
  jest.runOnlyPendingTimers();
  expect(work).toHaveBeenCalledTimes(1);
});

test("telemetry flushes once on page exit and survives a quick navigation", () => {
  const work = jest.fn();
  scheduleFeedTelemetry(work);
  expect(work).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("pagehide"));
  jest.runOnlyPendingTimers();
  expect(work).toHaveBeenCalledTimes(1);
});

test("startup telemetry waits for a decoded frame, with a bounded stalled-video fallback", () => {
  const video = document.createElement("video");
  let frame!: VideoFrameRequestCallback;
  video.requestVideoFrameCallback = jest.fn(callback => { frame = callback; return 1; });
  video.cancelVideoFrameCallback = jest.fn();
  const work = jest.fn();
  scheduleFeedTelemetry(work, video);
  jest.advanceTimersByTime(300);
  expect(work).not.toHaveBeenCalled();
  frame(300, {} as VideoFrameCallbackMetadata);
  jest.advanceTimersByTime(250);
  expect(work).toHaveBeenCalledTimes(1);
  scheduleFeedTelemetry(work, video);
  jest.advanceTimersByTime(1250);
  expect(work).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event("pagehide"));
  expect(work).toHaveBeenCalledTimes(2);
});
