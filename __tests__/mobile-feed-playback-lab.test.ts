/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type Activation = {
  token: symbol; postId: string; src: string; host: HTMLElement;
  contentVersion?: string; present: (ready: boolean) => void; ready: () => void; failed: () => void; reload?: boolean;
};
type Preparation = { postId: string; src: string; contentVersion?: string; present: (ready: boolean) => void };
let mockActive: Activation | null;
let mockVideo: HTMLVideoElement | null;
let mockTraceEnabled = false;
const mockController = {
  activate: jest.fn((input: Activation) => {
    mockActive = input;
    mockVideo ??= document.createElement("video");
    mockVideo.src = input.src;
    input.host.appendChild(mockVideo);
    input.present(false);
    return mockVideo;
  }),
  prepare: jest.fn<void, [Preparation]>(),
  cancelPreparation: jest.fn(),
  canPlay: jest.fn((token: symbol) => mockActive?.token === token),
  playRequested: jest.fn(),
  observeMainPlay: jest.fn(),
  release: jest.fn<void, [symbol, boolean?]>(token => { if (mockActive?.token === token) { mockVideo?.pause(); mockActive = null; } }),
  releaseForTransfer: jest.fn<void, [symbol]>(token => { if (mockActive?.token === token) { mockVideo?.pause(); mockActive = null; } }),
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
  feedTraceEnabled: () => mockTraceEnabled, observeFeedScroll: () => () => {},
  recordFeedEvent: jest.fn(), setFeedRunContext: jest.fn(),
}));
jest.mock("@/components/MobileFeedDiagnostics", () => ({ __esModule: true, default: () => null }));

import PlaybackLab from "@/app/playback-lab/PlaybackLab";
import { MobileFeedController as RateController } from "@/lib/mobileFeedController.prototype";
import { recordFeedEvent, setFeedRunContext } from "@/lib/mobileFeedDiagnostics";
import { playbackFormatFixtures, type PlaybackFormat } from "@/lib/playbackFormatFixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixtures = [
  { id: "lab-a", label: "Clip A", src: "https://example.test/a.m3u8", contentVersion: "a-v1" },
  { id: "lab-b", label: "Clip B", src: "https://example.test/b.m3u8", contentVersion: "b-v1" },
  { id: "lab-c", label: "Clip C", src: "https://example.test/c.m3u8", contentVersion: "c-v1" },
];
const formatFixtures = { original: playbackFormatFixtures("original"), mp4: playbackFormatFixtures("mp4"), hls: playbackFormatFixtures("hls") };
let container: HTMLDivElement;
let root: Root;
let hidden: jest.SpyInstance;
let play: jest.SpyInstance;
let intersect: IntersectionObserverCallback;
let savedObserver: typeof IntersectionObserver;

beforeEach(() => {
  jest.clearAllMocks();
  mockActive = null; mockVideo = null;
  mockTraceEnabled = false;
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

async function render(controllerMode: "current" | "rate" | "prearmed" | "steady" | "guarded" | "single" | "serial" | "prepared" = "current", sourceFormat?: PlaybackFormat, directMainTransfer = false) {
  await act(async () => root.render(createElement(PlaybackLab, { fixtures: sourceFormat ? formatFixtures[sourceFormat] : fixtures, buildCommit: "fixture-build", controllerMode, sourceFormat, directMainTransfer })));
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

test("debug capture observes the existing main play return before starting the bridge", async () => {
  mockTraceEnabled = true;
  await render("steady", "mp4", true); await click("Play");
  expect(play).toHaveBeenCalledTimes(1);
  expect(mockController.observeMainPlay).toHaveBeenCalledWith(latestActivation().token, {
    requestedAt: expect.any(Number), returnedAt: expect.any(Number), request: play.mock.results[0].value,
  });
  expect(mockController.observeMainPlay.mock.invocationCallOrder[0]).toBeLessThan(mockController.playRequested.mock.invocationCallOrder[0]);
});

test("debug-off lab keeps the existing play calls without native timing observations", async () => {
  await render("steady", "mp4", true); await click("Play");
  expect(play).toHaveBeenCalledTimes(1);
  expect(mockController.playRequested).toHaveBeenCalledWith(latestActivation().token);
  expect(mockController.observeMainPlay).not.toHaveBeenCalled();
});

test("prepared lab distinguishes the build/mode and observes acceptance even when debug is off", async () => {
  await render("prepared", "mp4"); await click("Play");
  expect(RateController).toHaveBeenCalledWith("prepared");
  expect(setFeedRunContext).toHaveBeenLastCalledWith(expect.objectContaining({ labMainTransfer: "prepared", labController: "prepared", labFormat: "mp4" }));
  expect(container.textContent).toContain("Prepared player carries picture and sound");
  expect(mockController.observeMainPlay).toHaveBeenCalledTimes(1);
  await click("Tap for sound"); await swipeTo(1);
  expect(mockVideo!.muted).toBe(false); expect(mockController.releaseForTransfer).not.toHaveBeenCalled();
  await click("Pause"); const requests = play.mock.calls.length;
  await render("prepared", "mp4"); await click("Mute"); await visibility(true); await visibility(false);
  expect(play).toHaveBeenCalledTimes(requests);
});

test.each(["promise", "synchronous"])("prepared %s sound denial stays recorded and foreground cannot retry without a gesture", async kind => {
  await render("prepared", "mp4"); await click("Play"); await click("Tap for sound");
  const deny = () => { const error = new DOMException("gesture required", "NotAllowedError"); if (kind === "synchronous") throw error; return Promise.reject(error); };
  play.mockImplementationOnce(deny);
  await swipeTo(1);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Playback permission was denied");
  expect(recordFeedEvent).toHaveBeenCalledWith("lab-play-rejected", expect.objectContaining({ name: "NotAllowedError", muted: false, preparedPlayer: true, outputMeasured: false }), mockVideo);
  expect(mockVideo!.muted).toBe(true); expect(mockVideo!.paused).toBe(true);
  const requests = play.mock.calls.length; await visibility(true); await visibility(false);
  expect(play).toHaveBeenCalledTimes(requests);
  await click("Tap for sound"); expect(play.mock.calls.length).toBe(requests + 1); expect(mockVideo!.muted).toBe(false);
});

test("a rejected old prepared owner cannot mute or relabel its successor", async () => {
  await render("prepared", "mp4"); await click("Play"); await click("Tap for sound");
  let reject!: (error: DOMException) => void;
  play.mockImplementationOnce(() => new Promise<void>((_, rejectRequest) => { reject = rejectRequest; }));
  await swipeTo(1); await swipeTo(0);
  await act(async () => reject(new DOMException("old gesture", "NotAllowedError")));
  expect(mockVideo!.muted).toBe(false);
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain("denied");
});

test("prepared non-permission failure requires Retry and preserves the sound intent", async () => {
  await render("prepared", "mp4"); await click("Play"); await click("Tap for sound");
  play.mockRejectedValueOnce(new DOMException("bad media", "NotSupportedError")); await swipeTo(1);
  expect(container.querySelector('[role="alert"]')).not.toBeNull(); const requests = play.mock.calls.length;
  await visibility(true); await visibility(false); expect(play).toHaveBeenCalledTimes(requests);
  await click("Retry video"); expect(latestActivation().reload).toBe(true); expect(mockVideo!.muted).toBe(false);
});

test.each(["original", "mp4"] as const)("%s comparison uses native MP4 support, pins both sources and keeps sound/ownership", async format => {
  jest.mocked(HTMLMediaElement.prototype.canPlayType).mockImplementation(type => type === "video/mp4" ? "probably" : "");
  await render("steady", format);
  expect(RateController).toHaveBeenCalledWith("steady");
  expect(container.textContent).toContain(`Preview format comparison · steady · ${format} · fixture-buil`);
  expect(setFeedRunContext).toHaveBeenLastCalledWith(expect.objectContaining({
    feed: "preview-playback-format-lab", labFormat: format, labFixtureSet: "carlos-noah-v1", labController: "steady", labBuildCommit: "fixture-build",
  }));
  await click("Play");
  await click("Tap for sound");
  const [carlos, noah] = formatFixtures[format];
  expect(latestActivation()).toEqual(expect.objectContaining({postId:carlos.id, src:carlos.src, contentVersion:carlos.contentVersion}));
  expect(mockController.prepare).toHaveBeenCalledWith(expect.objectContaining({postId:noah.id, src:noah.src, contentVersion:noah.contentVersion}));
  const shared = mockVideo;
  await swipeTo(1);
  expect(latestActivation()).toEqual(expect.objectContaining({postId:noah.id, src:noah.src, contentVersion:noah.contentVersion}));
  expect(mockVideo).toBe(shared);
  expect(mockVideo!.muted).toBe(false);
  await click("Pause");
  await render("steady", format);
  expect(mockVideo!.paused).toBe(true);
  expect(mockController.activate).toHaveBeenCalledTimes(2);
});

test("format HLS stays unavailable without native HLS, without substituting an MP4", async () => {
  jest.mocked(HTMLMediaElement.prototype.canPlayType).mockImplementation(type => type === "video/mp4" ? "probably" : "");
  await render("steady", "hls");
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(container.textContent).toContain("This browser does not report native HLS support.");
  await click("Play");
  expect(mockController.activate).not.toHaveBeenCalled();
});

test("legacy HLS lab retains its source set and native HLS capability gate", async () => {
  jest.mocked(HTMLMediaElement.prototype.canPlayType).mockImplementation(type => type === "video/mp4" ? "probably" : "");
  await render("steady");
  expect(container.textContent).toContain("Preview controller experiment · steady · fixture-buil");
  expect(setFeedRunContext).toHaveBeenLastCalledWith(expect.objectContaining({feed:"preview-hls-controller-lab", labFormat:"hls", labFixtureSet:"legacy-hls"}));
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(mockController.activate).not.toHaveBeenCalled();
});

test("prearmed lab mode selects the paused-rate controller variant", async () => {
  await render("prearmed");
  expect(RateController).toHaveBeenCalledWith("prearmed");
});

test("steady lab mode selects the controller with rate correction disabled", async () => {
  await render("steady");
  expect(RateController).toHaveBeenCalledWith("steady");
});

test("guarded lab mode selects the controller with early unverified-motion recovery", async () => {
  await render("guarded");
  expect(RateController).toHaveBeenCalledWith("guarded");
});

test("single-player control never prepares a neighbor across sound, swipes, pause and foreground return", async () => {
  await render("single");
  expect(RateController).toHaveBeenCalledWith("steady");
  await click("Play");
  await click("Tap for sound");
  await swipeTo(1);
  await swipeTo(2);
  await swipeTo(1);
  await swipeTo(0);
  await click("Pause");
  expect(mockVideo!.paused).toBe(true);
  await click("Play");
  await visibility(true);
  await visibility(false);
  expect(mockController.prepare).not.toHaveBeenCalled();
  expect(mockController.activate.mock.calls.map(([input]) => input.postId)).toEqual(["lab-a", "lab-b", "lab-c", "lab-b", "lab-a"]);
  expect(container.querySelectorAll("video")).toHaveLength(1);
  expect(mockVideo!.muted).toBe(false);
  expect(mockVideo!.paused).toBe(false);
});

test("serial control selects the unload-before-main controller and retains neighbor preparation", async () => {
  await render("serial");
  expect(RateController).toHaveBeenCalledWith("serial");
  await click("Play");
  expect(mockController.prepare).toHaveBeenCalledWith(expect.objectContaining({ postId: "lab-b" }));
  await swipeTo(1);
  expect(mockController.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ postId: "lab-c" }));
});

test("single-player Retry uses the shared main without starting preparation", async () => {
  await render("single");
  await click("Play");
  await act(async () => mockVideo!.dispatchEvent(new Event("error")));
  await click("Retry video");
  expect(latestActivation().reload).toBe(true);
  expect(mockController.prepare).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(mockVideo!.paused).toBe(false);
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
  expect(mockController.release.mock.calls.at(-1)?.[1]).toBe(true);
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

test("direct MP4 control defers parking only for a post change, retaining sound and immediate Retry/exit release", async () => {
  await render("steady", "mp4", true);
  expect(container.textContent).toContain("Direct player transfer comparison");
  expect(setFeedRunContext).toHaveBeenLastCalledWith(expect.objectContaining({ labMainTransfer: "direct", labFormat: "mp4", labController: "steady" }));
  await click("Play"); await click("Tap for sound");
  const carlos = latestActivation().token, shared = mockVideo;
  await swipeTo(1);
  expect(mockController.releaseForTransfer).toHaveBeenCalledTimes(1);
  expect(mockController.releaseForTransfer).toHaveBeenCalledWith(carlos);
  expect(mockVideo).toBe(shared);
  expect(mockVideo!.muted).toBe(false);

  await act(async () => mockVideo!.dispatchEvent(new Event("error")));
  expect(mockController.release).toHaveBeenLastCalledWith(latestActivation().token, false);
  await click("Retry video");
  expect(latestActivation().reload).toBe(true);
  expect(mockController.releaseForTransfer).toHaveBeenCalledTimes(1);
  const last = latestActivation().token;
  await act(async () => root.unmount());
  expect(mockController.release).toHaveBeenLastCalledWith(last, true);
  expect(mockController.releaseForTransfer).toHaveBeenCalledTimes(1);
});

test.each([
  ["steady", "mp4", false], ["steady", "hls", true],
  ["steady", "original", true], ["current", "mp4", true],
] as const)("%s/%s with direct=%s keeps ordinary parking outside the explicit control", async (mode, format, direct) => {
  await render(mode, format, direct);
  expect(container.textContent).not.toContain("Direct player transfer comparison");
  expect(setFeedRunContext).toHaveBeenLastCalledWith(expect.objectContaining({ labMainTransfer: "parked" }));
  await click("Play"); await swipeTo(1);
  expect(mockController.releaseForTransfer).not.toHaveBeenCalled();
  expect(mockController.release).toHaveBeenLastCalledWith(expect.any(Symbol), true);
});
