/** @jest-environment jsdom */

import { readMobileFeedDiagnostics } from "@/components/MobileFeedDiagnostics";

test("iPhone debug readout reports the active source and live buffer", () => {
  const video = document.createElement("video");
  video.src = "https://example.test/manifest/video.m3u8";
  video.currentTime = 2;
  video.dataset.startupMs = "83";
  video.dataset.stallCount = "1";
  Object.defineProperty(video, "buffered", { value: {
    length: 1, start: () => 0, end: () => 5.5,
  } });
  video.getVideoPlaybackQuality = () => ({ droppedVideoFrames: 2 }) as VideoPlaybackQuality;
  expect(readMobileFeedDiagnostics(video)).toEqual(expect.objectContaining({
    source: "HLS", startupMs: "83", stalls: "1", bufferSeconds: "3.5", droppedFrames: "2",
  }));
});
