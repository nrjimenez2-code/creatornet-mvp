/** @jest-environment jsdom */
import { bindWatchProgress } from "@/lib/watchProgress";

let video: HTMLVideoElement;
let cleanup: (() => void) | undefined;
const fetchMock = jest.fn();
beforeEach(() => {
  video = document.createElement("video");
  Object.defineProperty(video, "duration", { configurable: true, value: 60 });
  Object.defineProperty(video, "paused", { configurable: true, value: false });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ progress: { seconds: 3 } }) });
  globalThis.fetch = fetchMock;
});
afterEach(() => cleanup?.());
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const writes = () => fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");

test("resumes an unfinished short position without generating a write", async () => {
  cleanup = bindWatchProgress(video, "post-one");
  await settle();
  expect(video.currentTime).toBe(3);
  expect(writes()).toHaveLength(0);
});
test("waits for metadata and never seeks after the viewer has started", async () => {
  Object.defineProperty(video, "duration", { configurable: true, value: NaN });
  cleanup = bindWatchProgress(video, "post-one");
  await settle();
  expect(video.currentTime).toBe(0);
  video.dispatchEvent(new Event("play"));
  video.currentTime = 8;
  Object.defineProperty(video, "duration", { configurable: true, value: 60 });
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(video.currentTime).toBe(8);
});
test("pause flushes a newer position inside the five-second throttle", async () => {
  cleanup = bindWatchProgress(video, "post-one");
  await settle();
  video.dispatchEvent(new Event("play"));
  video.currentTime = 8;
  video.dispatchEvent(new Event("timeupdate"));
  video.currentTime = 9;
  video.dispatchEvent(new Event("timeupdate"));
  expect(writes()).toHaveLength(1);
  video.dispatchEvent(new Event("pause"));
  await settle();
  expect(writes()).toHaveLength(2);
  expect(JSON.parse(writes()[1][1].body)).toEqual({ post_id: "post-one", seconds: 9, duration: 60 });
});
test("cleanup saves the last position once and detaches listeners", async () => {
  cleanup = bindWatchProgress(video, "post-one");
  await settle();
  video.dispatchEvent(new Event("play"));
  video.currentTime = 9;
  cleanup();
  video.currentTime = 12;
  video.dispatchEvent(new Event("pause"));
  window.dispatchEvent(new Event("pagehide"));
  expect(writes()).toHaveLength(1);
  expect(writes()[0][1].keepalive).toBe(true);
  cleanup = undefined;
});
test("an ended clip records its duration", async () => {
  cleanup = bindWatchProgress(video, "post-one");
  await settle();
  video.dispatchEvent(new Event("play"));
  video.currentTime = 60;
  video.dispatchEvent(new Event("ended"));
  expect(JSON.parse(writes()[0][1].body).seconds).toBe(60);
});

test("a delayed save cannot overtake the newest queued stop position", async () => {
  cleanup = bindWatchProgress(video, "post-one");
  await settle();
  let release: ((value: { ok: boolean }) => void) | undefined;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  video.dispatchEvent(new Event("play"));
  video.currentTime = 8;
  video.dispatchEvent(new Event("timeupdate"));
  video.currentTime = 9;
  video.dispatchEvent(new Event("pause"));
  video.currentTime = 12;
  window.dispatchEvent(new Event("pagehide"));
  expect(writes()).toHaveLength(1);
  release!({ ok: true });
  await settle();
  expect(writes()).toHaveLength(2);
  expect(JSON.parse(writes()[1][1].body).seconds).toBe(12);
});
