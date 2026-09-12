/** @jest-environment jsdom */
import { createFeedHandoff } from "@/lib/feedHandoff";
import { scheduleFeedBackground, scheduleFeedTelemetry } from "@/lib/feedBackground";

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.runOnlyPendingTimers(); jest.useRealTimers(); });

test("a reversed or skipped swipe never activates the transient video", () => {
  const commit = jest.fn();
  const handoff = createFeedHandoff(commit);
  handoff.propose("second");
  jest.advanceTimersByTime(40);
  handoff.propose(null);
  jest.advanceTimersByTime(100);
  expect(commit).not.toHaveBeenCalled();
  handoff.propose("second");
  jest.advanceTimersByTime(40);
  handoff.propose("third");
  jest.advanceTimersByTime(80);
  expect(commit.mock.calls).toEqual([["third"]]);
});

test("repeated observations do not postpone a stable handoff; teardown cancels", () => {
  const commit = jest.fn();
  const handoff = createFeedHandoff(commit);
  handoff.propose("second");
  jest.advanceTimersByTime(60);
  handoff.propose("second");
  jest.advanceTimersByTime(20);
  expect(commit).toHaveBeenCalledWith("second");
  handoff.propose("third");
  handoff.cancel();
  jest.runOnlyPendingTimers();
  expect(commit).toHaveBeenCalledTimes(1);
});

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
