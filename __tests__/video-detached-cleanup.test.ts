/** @jest-environment jsdom */
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

const db = createMockClient();
const sendEvent = jest.fn();
jest.mock("@/lib/supabaseClient", () => ({ supabase: db, createClient: () => db }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: null, loading: false, session: null }) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (value: unknown) => value }));
jest.mock("@/lib/discoverClient", () => ({ sendDiscoverEvent: (...args: unknown[]) => sendEvent(...args), hasDiscoverSession: () => true }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/components/CommentPanel", () => ({ __esModule: true, default: () => null }));
import VideoCard from "@/components/VideoCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class Observer { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Observer;

let container: HTMLDivElement, root: Root, mounted: boolean;
let paused: WeakMap<HTMLMediaElement, boolean>;
let releases: Array<{ video: HTMLMediaElement; src: string | null; connected: boolean; events: unknown[][] }>;
let playResult: () => Promise<void>;
let play: jest.SpyInstance, pause: jest.SpyInstance, load: jest.SpyInstance;
const base = { src: "/clip.mp4", postId: "post-1", creatorId: "creator-1", isActive: true, soundEnabled: false };

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  paused = new WeakMap(); releases = []; playResult = () => Promise.resolve();
  jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  jest.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  jest.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(20);
  play = jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false);
    return playResult();
  });
  pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    const wasPlaying = !(paused.get(this) ?? true);
    paused.set(this, true);
    if (wasPlaying) this.dispatchEvent(new Event("pause"));
  });
  load = jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLMediaElement) {
    releases.push({ video: this, src: this.getAttribute("src"), connected: this.isConnected,
      events: sendEvent.mock.calls.map(args => [...args]) });
    this.dispatchEvent(new Event("abort"));
    this.dispatchEvent(new Event("emptied"));
  });
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container); mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  container.remove(); jest.restoreAllMocks();
});

async function render(overrides: Partial<Parameters<typeof VideoCard>[0]> = {}, strict = false) {
  await act(async () => {
    const card = createElement(VideoCard, { ...base, ...overrides });
    root.render(strict ? createElement(StrictMode, null, card) : card);
  });
  return container.querySelector("video");
}
async function unmount() { await act(async () => root.unmount()); mounted = false; }

test("actual unmount pauses and releases only the captured detached video", async () => {
  const video = (await render())!;
  expect(video.isConnected).toBe(true);
  expect(load).not.toHaveBeenCalled();
  await unmount();
  expect(video.paused).toBe(true);
  expect(video.hasAttribute("src")).toBe(false);
  expect(pause.mock.contexts).toContain(video);
  expect(releases).toEqual([{ video, src: null, connected: false, events: sendEvent.mock.calls }]);
});

test.each([0.75, 3])("watch settlement at %ss precedes media release without duplicate cleanup events", async seconds => {
  let now = 1000;
  jest.spyOn(performance, "now").mockImplementation(() => now);
  const video = (await render())!;
  const sample = async (position: number) => {
    now = 1000 + position * 1000; video.currentTime = position;
    await act(async () => video.dispatchEvent(new Event("timeupdate")));
  };
  await sample(0);
  for (let position = 1; position < seconds; position++) await sample(position);
  await sample(seconds);
  await unmount();
  const expected = [["post-1", "exposure"], ["post-1", "watch", seconds],
    ...(seconds < 2 ? [["post-1", "quick_skip"]] : [])];
  expect(sendEvent.mock.calls).toEqual(expected);
  expect(releases[0].events).toEqual(expected);
  video.dispatchEvent(new Event("pause"));
  video.dispatchEvent(new Event("play"));
  video.dispatchEvent(new Event("timeupdate"));
  expect(sendEvent.mock.calls).toEqual(expected);
});

test("source, mute, and activation changes keep the connected video resource", async () => {
  const original = (await render())!;
  expect(await render({ src: "/replacement.mp4" })).toBe(original);
  expect(await render({ src: "/replacement.mp4", soundEnabled: true })).toBe(original);
  expect(await render({ src: "/replacement.mp4", soundEnabled: true, isActive: false })).toBe(original);
  expect(original.getAttribute("src")).toBe("/replacement.mp4");
  expect(load).not.toHaveBeenCalled();
  await unmount();
  expect(releases).toHaveLength(1);
});

test("StrictMode's connected effect replay keeps the source; real unmount releases once", async () => {
  const video = (await render({}, true))!;
  expect(play.mock.contexts.filter(node => node === video).length).toBeGreaterThanOrEqual(2);
  expect(video.getAttribute("src")).toBe(base.src);
  expect(video.isConnected).toBe(true);
  expect(load).not.toHaveBeenCalled();
  await unmount();
  expect(releases).toHaveLength(1);
  expect(releases[0]).toMatchObject({ video, src: null, connected: false });
});

test("keyed retry releases the failed node without clearing or pausing its replacement", async () => {
  const oldVideo = (await render())!;
  await act(async () => oldVideo.dispatchEvent(new Event("error")));
  const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry video")!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  const replacement = container.querySelector("video")!;
  expect(replacement).not.toBe(oldVideo);
  expect(releases).toHaveLength(1);
  expect(releases[0]).toMatchObject({ video: oldVideo, src: null, connected: false });
  expect(oldVideo.paused).toBe(true);
  expect(replacement.isConnected).toBe(true);
  expect(replacement.getAttribute("src")).toBe(base.src);
  expect(replacement.paused).toBe(false);
  expect(pause.mock.contexts).not.toContain(replacement);
  await unmount();
  expect(releases.map(entry => entry.video)).toEqual([oldVideo, replacement]);
});

test("source-to-no-video releases the old node and leaves the replacement poster", async () => {
  const video = (await render())!;
  expect(await render({ src: undefined, poster: "/poster.jpg" })).toBeNull();
  expect(container.querySelector('img[src="/poster.jpg"]')).not.toBeNull();
  expect(releases).toHaveLength(1);
  expect(releases[0]).toMatchObject({ video, src: null, connected: false });
  await unmount();
  expect(releases).toHaveLength(1);
});

test.each(["resolve", "reject"] as const)("late play %s after release cannot restart playback or create exposure", async outcome => {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const pendingPlay = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  playResult = () => pendingPlay;
  const video = (await render())!;
  expect(sendEvent).not.toHaveBeenCalled();
  const calls = play.mock.calls.length;
  await unmount();
  await act(async () => {
    if (outcome === "resolve") resolve();
    else reject(Object.assign(new Error("Media resource reset"), { name: "AbortError" }));
    await pendingPlay.catch(() => {});
  });
  expect(video.paused).toBe(true);
  expect(video.hasAttribute("src")).toBe(false);
  expect(play).toHaveBeenCalledTimes(calls);
  expect(sendEvent).not.toHaveBeenCalled();
  expect(releases).toHaveLength(1);
});
