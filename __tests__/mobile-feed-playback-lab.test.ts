/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type Activation = {
  token: symbol; postId: string; src: string; host: HTMLElement;
  present: (ready: boolean) => void; ready: () => void; failed: () => void; reload?: boolean;
};
type Preparation = { postId: string; present: (ready: boolean) => void };
let mockActive: Activation | null;
let mockVideo: HTMLVideoElement | null;
const mockController = {
  activate: jest.fn((input: Activation) => {
    mockActive = input;
    mockVideo ??= document.createElement("video");
    mockVideo.src = input.src;
    input.host.appendChild(mockVideo);
    input.present(false);
    return mockVideo;
  }),
  prepare: jest.fn((_input: Preparation) => {}),
  cancelPreparation: jest.fn(),
  canPlay: jest.fn((token: symbol) => mockActive?.token === token),
  playRequested: jest.fn(),
  release: jest.fn((token: symbol) => { if (mockActive?.token === token) { mockVideo?.pause(); mockActive = null; } }),
  // The real suspend() cancels preparation without revoking active ownership.
  // A harness terminal error must block playback independently of this method.
  suspend: jest.fn(),
  dispose: jest.fn(() => { mockActive = null; }),
};

jest.mock("@/lib/mobileFeedController", () => ({ MobileFeedController: jest.fn(() => mockController) }));
jest.mock("@/lib/mobileFeedController.prototype", () => ({ MobileFeedController: jest.fn(() => mockController) }));
jest.mock("@/lib/mobileFeedPlayer", () => ({
  mobileFeedPlaybackReady: jest.fn(() => null),
  mobileFeedSeekFailed: jest.fn(() => false),
}));
jest.mock("@/lib/mobileFeedDiagnostics", () => ({
  feedTraceEnabled: () => false, observeFeedScroll: () => () => {},
  recordFeedEvent: jest.fn(), setFeedRunContext: jest.fn(),
}));
jest.mock("@/components/MobileFeedDiagnostics", () => ({ __esModule: true, default: () => null }));

import PlaybackLab from "@/app/playback-lab/PlaybackLab";
import { MobileFeedController as RateController } from "@/lib/mobileFeedController.prototype";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixtures = [
  { id: "lab-a", label: "Clip A", src: "https://example.test/a.m3u8", contentVersion: "a-v1" },
  { id: "lab-b", label: "Clip B", src: "https://example.test/b.m3u8", contentVersion: "b-v1" },
  { id: "lab-c", label: "Clip C", src: "https://example.test/c.m3u8", contentVersion: "c-v1" },
];
let container: HTMLDivElement;
let root: Root;
let hidden: jest.SpyInstance;
let play: jest.SpyInstance;
let intersect: IntersectionObserverCallback;
let savedObserver: typeof IntersectionObserver;

beforeEach(() => {
  jest.clearAllMocks();
  mockActive = null; mockVideo = null;
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(false);
  jest.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
  jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { paused.set(this, true); });
  play = jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false);
    return Promise.resolve();
  });
  savedObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.IntersectionObserver = savedObserver;
  jest.restoreAllMocks();
});

async function render(controllerMode: "current" | "rate" | "prearmed" = "current") {
  await act(async () => root.render(createElement(PlaybackLab, { fixtures, buildCommit: "fixture-build", controllerMode })));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(element => element.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
async function visibility(value: boolean) {
  await act(async () => {
    hidden.mockReturnValue(value);
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function swipeTo(index: number) {
  const sections = [...container.querySelectorAll<HTMLElement>("section[data-post-id]")];
  await act(async () => intersect(sections.map((target, item) => ({
    target, isIntersecting: item === index, intersectionRatio: item === index ? 1 : 0,
    boundingClientRect: target.getBoundingClientRect(), intersectionRect: target.getBoundingClientRect(),
    rootBounds: null, time: performance.now(),
  })), {} as IntersectionObserver));
}
function latestActivation() { return mockController.activate.mock.calls.at(-1)![0]; }

test("prearmed lab mode selects the paused-rate controller variant", async () => {
  await render("prearmed");
  expect(RateController).toHaveBeenCalledWith("prearmed");
});

test.each(["media", "watchdog"])("%s failure blocks Play, sound and foreground until Retry creates a new owner", async kind => {
  await render();
  await click("Play");
  const failedOwner = latestActivation().token;
  await act(async () => {
    if (kind === "media") mockVideo!.dispatchEvent(new Event("error"));
    else latestActivation().failed();
  });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(mockVideo!.paused).toBe(true);
  const requests = play.mock.calls.length;
  await click("Play");
  await click("Tap for sound");
  await visibility(true);
  await visibility(false);
  expect(play).toHaveBeenCalledTimes(requests);

  await click("Retry video");
  expect(latestActivation().token).not.toBe(failedOwner);
  expect(latestActivation().reload).toBe(true);
  expect(play.mock.calls.length).toBeGreaterThan(requests);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("a prepared neighbor becomes visible before its section activates and is covered again when cancelled", async () => {
  await render();
  await click("Play");
  const neighbor = container.querySelector<HTMLElement>('[data-post-id="lab-b"]')!;
  const preparation = mockController.prepare.mock.calls.at(-1)![0];
  expect(preparation.postId).toBe("lab-b");
  expect(neighbor.querySelector('[aria-hidden="true"]')).not.toBeNull();

  await act(async () => preparation.present(true));
  expect(neighbor.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(mockController.activate).toHaveBeenCalledTimes(1);
  await act(async () => preparation.present(false));
  expect(neighbor.querySelector('[aria-hidden="true"]')).not.toBeNull();
});

test("manual pause survives a same-card rerender but an observed new card starts playback", async () => {
  await render();
  await click("Play");
  await click("Pause");
  const requests = play.mock.calls.length;
  expect(mockVideo!.paused).toBe(true);
  await render();
  await click("Tap for sound");
  expect(play).toHaveBeenCalledTimes(requests);
  expect(mockController.activate).toHaveBeenCalledTimes(1);

  await swipeTo(1);
  expect(latestActivation().postId).toBe("lab-b");
  expect(mockController.activate).toHaveBeenCalledTimes(2);
  expect(play.mock.calls.length).toBeGreaterThan(requests);
  expect(mockVideo!.paused).toBe(false);
});

test("Retry forces one reload without forcing reload again on a later return", async () => {
  await render();
  await click("Play");
  await act(async () => mockVideo!.dispatchEvent(new Event("error")));
  await click("Retry video");
  expect(latestActivation().reload).toBe(true);
  await swipeTo(1);
  await swipeTo(0);
  expect(latestActivation().postId).toBe("lab-a");
  expect(latestActivation().reload).toBe(false);
});
