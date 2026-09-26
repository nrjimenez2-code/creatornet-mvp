/** @jest-environment jsdom */
import { FeedTrace, beginFeedVideoTrace, endFeedVideoTrace, exportFeedTrace, resetFeedTrace, validFeedFrame } from "@/lib/mobileFeedDiagnostics";

test("trace wraps without losing ordering, reports dropped events and copies transition identity", () => {
  let now = 0;
  const trace = new FeedTrace(3, () => ++now);
  const id = trace.begin("post-a");
  trace.record("activation", id);
  id.source++; trace.record("source", id);
  id.seek++; trace.record("seek", id);
  trace.record("frame", id);
  expect(trace.snapshot()).toEqual({ droppedEvents: 1, events: [
    expect.objectContaining({ sequence: 2, source: 1, seek: 0 }),
    expect.objectContaining({ sequence: 3, source: 1, seek: 1 }),
    expect.objectContaining({ sequence: 4, source: 1, seek: 1 }),
  ] });
});

test("moving frame requires advancing media, current source, ready media and no seek", () => {
  const video = document.createElement("video"); video.src = "https://example.test/a.mp4"; video.currentTime = 2;
  Object.defineProperties(video, { readyState: { configurable: true, value: 2 }, paused: { configurable: true, value: false }, currentSrc: { configurable: true, value: video.src } });
  expect(validFeedFrame(video, video.src, 2, 1.97)).toBe(true);
  expect(validFeedFrame(video, video.src, 2, 2)).toBe(false);
  expect(validFeedFrame(video, video.src, 2, null)).toBe(false);
  expect(validFeedFrame(video, "https://example.test/b.mp4", 2, 1.97)).toBe(false);
  Object.defineProperty(video, "seeking", { value: true });
  expect(validFeedFrame(video, video.src, 2, 1.97)).toBe(false);
});

test("cancelled frame callbacks cannot complete an earlier activation or seek", () => {
  window.history.replaceState({}, "", "/?feedDebug=1"); resetFeedTrace();
  const video = document.createElement("video"); video.src = "https://example.test/a.mp4";
  Object.defineProperties(video, { readyState: { value: 2 }, paused: { value: false }, currentSrc: { get: () => video.src } });
  const callbacks: VideoFrameRequestCallback[] = [];
  video.requestVideoFrameCallback = cb => { callbacks.push(cb); return callbacks.length; };
  video.cancelVideoFrameCallback = jest.fn();
  beginFeedVideoTrace(video, "a", video.src);
  const stale = callbacks[0];
  beginFeedVideoTrace(video, "b", video.src);
  video.currentTime = 1;
  stale(20, { mediaTime: 1 } as VideoFrameCallbackMetadata);
  const beforeSeek = callbacks.at(-1)!;
  video.dispatchEvent(new Event("seeking"));
  beforeSeek(30, { mediaTime: 1.03 } as VideoFrameCallbackMetadata);
  expect(exportFeedTrace().events.filter(e => e.kind === "moving-frame")).toHaveLength(0);
  endFeedVideoTrace(video);
  expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
});
