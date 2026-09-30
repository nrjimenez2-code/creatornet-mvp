/** @jest-environment jsdom */
// LOCAL EXPERIMENT: clocks below implement playbackRate; this is not Safari evidence.
import { MobileFeedController } from "@/lib/mobileFeedController.prototype";
import { exportFeedTrace, resetFeedTrace } from "@/lib/mobileFeedDiagnostics";

type RateMode = "normal" | "throw" | "ignored-getter" | "ignored-engine" | "freeze-300ms";
type RateWrite = { video: HTMLMediaElement; rate: number; at: number; paused: boolean; hidden: boolean };
let controller: MobileFeedController;
let callbacks: Map<HTMLVideoElement, Map<number, VideoFrameRequestCallback>>;
let paused: WeakMap<HTMLMediaElement, boolean>;
let rates: WeakMap<HTMLMediaElement, number>;
let modes: WeakMap<HTMLMediaElement, RateMode>;
let frozenUntil: WeakMap<HTMLMediaElement, number>;
let writes: RateWrite[];
let nextId: number;
let originalRequest: typeof HTMLVideoElement.prototype.requestVideoFrameCallback;
let originalCancel: typeof HTMLVideoElement.prototype.cancelVideoFrameCallback;
let scenarioNumber = 0;

function media(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 4 }, currentSrc: { configurable: true, get: () => video.src },
    duration: { configurable: true, value: 60 }, seeking: { configurable: true, value: false },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 60 } },
  });
}
function deliver(video: HTMLVideoElement, mediaTime: number, clock = mediaTime, count = Math.round(mediaTime * 30) + 1, submissionAgeMs = 0) {
  video.currentTime = clock;
  const pending = [...(callbacks.get(video)?.values() ?? [])]; callbacks.get(video)?.clear();
  pending.forEach(callback => callback(performance.now(), {
    mediaTime, presentedFrames: count, presentationTime: performance.now() - submissionAgeMs,
    expectedDisplayTime: performance.now() - submissionAgeMs,
  } as VideoFrameCallbackMetadata));
}
function events(kind: string) { return exportFeedTrace().events.filter(event => event.kind === kind); }
function bridgeWrites(video: HTMLVideoElement) { return writes.filter(write => write.video === video); }

beforeEach(() => {
  window.history.replaceState({}, "", "/?feedDebug=1");
  jest.useFakeTimers(); resetFeedTrace(); nextId = 0;
  callbacks = new Map(); paused = new WeakMap(); rates = new WeakMap(); modes = new WeakMap(); frozenUntil = new WeakMap(); writes = [];
  originalRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
  originalCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, true); this.dispatchEvent(new Event("pause"));
  });
  jest.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false); this.dispatchEvent(new Event("play")); return Promise.resolve();
  });
  jest.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return paused.get(this) ?? true; });
  jest.spyOn(HTMLMediaElement.prototype, "playbackRate", "get").mockImplementation(function (this: HTMLMediaElement) { return rates.get(this) ?? 1; });
  jest.spyOn(HTMLMediaElement.prototype, "playbackRate", "set").mockImplementation(function (this: HTMLMediaElement, rate: number) {
    writes.push({ video: this, rate, at: performance.now(), paused: this.paused, hidden: (this as HTMLVideoElement).style.visibility === "hidden" });
    const mode = modes.get(this);
    if (mode === "throw" && rate !== 1) throw new DOMException("unsupported test rate", "NotSupportedError");
    if (mode === "ignored-getter") return;
    rates.set(this, rate);
    if (mode === "freeze-300ms" && rate !== 1) frozenUntil.set(this, performance.now() + 300);
  });
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    if (!callbacks.has(this)) callbacks.set(this, new Map());
    const id = ++nextId; callbacks.get(this)!.set(id, callback); return id;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) { callbacks.get(this)?.delete(id); };
  controller = new MobileFeedController();
});
afterEach(() => {
  controller.dispose(); document.body.innerHTML = "";
  if (originalRequest) HTMLVideoElement.prototype.requestVideoFrameCallback = originalRequest;
  else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  if (originalCancel) HTMLVideoElement.prototype.cancelVideoFrameCallback = originalCancel;
  else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
  jest.restoreAllMocks(); jest.useRealTimers();
});

async function scenario(options: { lead?: number; startMs?: number; mainMedia?: number; mainLag?: number; mode?: RateMode; staleBridge?: boolean; bridgeCallbacks?: "missing" | "rejected"; mainSubmissionAgeMs?: number; rateMode?: "reactive" | "prearmed" | "steady" | "guarded" } = {}) {
  if (options.rateMode) { controller.dispose(); controller = new MobileFeedController(options.rateMode); }
  const lead = options.lead ?? 0.5, startMs = options.startMs ?? 764;
  const mainMedia = options.mainMedia ?? 1 / 30, mainLag = options.mainLag ?? 0.1283666667;
  const bridgeMedia = mainMedia + lead;
  const postId = `bridge-rate-${++scenarioNumber}`, src = `https://example.test/${postId}.m3u8`;
  const preparedHost = document.createElement("div"); document.body.appendChild(preparedHost);
  const preparedPresent = jest.fn();
  controller.prepare({ postId, src, host: preparedHost, present: preparedPresent });
  const bridge = preparedHost.querySelector("video")!; media(bridge);
  modes.set(bridge, options.mode ?? "normal");
  bridge.dispatchEvent(new Event("loadedmetadata")); deliver(bridge, 1 / 30);
  expect(preparedPresent).toHaveBeenCalledWith(true);
  const host = document.createElement("div"), previewHost = document.createElement("div"); document.body.append(host, previewHost);
  const readyAt: number[] = [], ready = jest.fn(() => { readyAt.push(performance.now()); }), failed = jest.fn();
  const token = Symbol("bridge-rate");
  const main = controller.activate({ postId, src, token, host, previewHost, present: jest.fn(), ready, failed });
  media(main); main.dispatchEvent(new Event("loadedmetadata")); main.dispatchEvent(new Event("seeked"));
  void main.play(); main.dispatchEvent(new Event("playing")); await Promise.resolve();
  expect(previewHost.querySelector("video")).toBe(bridge);
  const initialMainMuted = main.muted;
  if (!options.bridgeCallbacks) deliver(bridge, 2 / 30);
  if (options.staleBridge) {
    jest.advanceTimersByTime(startMs - 200); deliver(bridge, bridgeMedia - 0.2);
    jest.advanceTimersByTime(200); bridge.currentTime = bridgeMedia;
  } else if (options.bridgeCallbacks) {
    jest.advanceTimersByTime(startMs);
    if (options.bridgeCallbacks === "rejected") deliver(bridge, bridgeMedia, bridgeMedia + 0.5);
  } else {
    jest.advanceTimersByTime(startMs); deliver(bridge, bridgeMedia);
  }
  deliver(main, mainMedia - 1 / 30, mainMedia - 1 / 30 + mainLag, undefined, options.mainSubmissionAgeMs);
  deliver(main, mainMedia, mainMedia + mainLag, undefined, options.mainSubmissionAgeMs);
  let mainPosition = mainMedia + mainLag, bridgePosition = bridgeMedia;
  let lastMainFrame = mainMedia, lastBridgeFrame = options.staleBridge ? bridgeMedia - 0.2 : bridgeMedia;
  let lastBridgeSubmissionAt = options.staleBridge ? startMs - 200 : startMs;
  let maxBridgeSubmissionGapMs = 0;
  const publishBridge = () => {
    const timestamp = Math.floor((bridgePosition + 1e-9) * 30) / 30;
    if (timestamp > lastBridgeFrame + 0.0001) {
      lastBridgeFrame = timestamp;
      maxBridgeSubmissionGapMs = Math.max(maxBridgeSubmissionGapMs, performance.now() - lastBridgeSubmissionAt);
      lastBridgeSubmissionAt = performance.now();
      deliver(bridge, timestamp, bridgePosition);
    }
  };
  const advance = (durationMs: number, emitBridge = true, emitMain = true) => {
    let remaining = durationMs;
    while (remaining > 0) {
      const step = Math.min(8, remaining), before = performance.now();
      if (!main.paused) mainPosition += step / 1000 * main.playbackRate;
      if (!bridge.paused) {
        const frozen = Math.max(0, Math.min(step, (frozenUntil.get(bridge) ?? 0) - before));
        const actualRate = modes.get(bridge) === "ignored-engine" ? 1 : bridge.playbackRate;
        bridgePosition += (step - frozen) / 1000 * actualRate;
      }
      main.currentTime = mainPosition; bridge.currentTime = bridgePosition;
      jest.advanceTimersByTime(step); remaining -= step;
      const mainTimestamp = Math.floor((mainPosition - mainLag + 1e-9) * 30) / 30;
      if (emitMain && mainTimestamp > lastMainFrame + 0.0001) {
        lastMainFrame = mainTimestamp; deliver(main, mainTimestamp, mainPosition);
      }
      if (emitBridge) publishBridge();
    }
  };
  return { main, bridge, token, ready, readyAt, failed, previewHost, advance, publishBridge, initialMainMuted,
    maxBridgeSubmissionGapMs: () => maxBridgeSubmissionGapMs };
}

test("startup samples retain submission age and stay bounded during an unaligned session", async () => {
  const s = await scenario({ lead: 0.6, startMs: 200, mainSubmissionAgeMs: 75, rateMode: "steady" });
  const first = events("lab-main-startup-frame");
  expect(first).toHaveLength(2);
  expect(first[0].detail).toEqual(expect.objectContaining({ callback: 1, qualified: false, submissionAgeMs: 75, processingDurationMs: null }));
  expect(first[1].detail).toEqual(expect.objectContaining({ callback: 2, qualified: true, submissionAgeMs: 75 }));
  s.advance(1_000);
  expect(events("lab-main-startup-frame")).toHaveLength(8);
  expect(events("lab-main-startup-frame").map(event => event.detail.callback)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(s.ready).not.toHaveBeenCalled();
  for (let i = 0; i < 5; i++) { s.main.pause(); void s.main.play(); await Promise.resolve(); }
  expect(events("lab-bridge-play-request")).toHaveLength(4);
  expect(events("lab-bridge-play-settled")).toHaveLength(4);
  expect(events("lab-source-readback").map(event => event.detail.role).sort()).toEqual(["bridge", "main"]);
  expect(events("lab-source-readback").every(event => event.detail.selectedSource === s.main.src)).toBe(true);
  expect(events("bridge-align-seek")).toHaveLength(0); expect(writes).toHaveLength(0);
});

test("source readback withholds a prior unrelated URL until the activation source matches", async () => {
  controller.dispose(); controller = new MobileFeedController("steady");
  const ready = jest.fn(), src = "https://example.test/source-readback.mp4";
  const main = controller.activate({ postId: "source-readback", src, token: Symbol("source-readback"),
    host: document.createElement("div"), previewHost: document.createElement("div"), present: jest.fn(), ready });
  media(main);
  main.dispatchEvent(new Event("loadedmetadata")); main.dispatchEvent(new Event("seeked")); await Promise.resolve();
  Object.defineProperty(main, "currentSrc", { configurable: true, value: "https://unrelated.test/prior.mp4?private=value" });
  void main.play(); deliver(main, 0);
  expect(events("lab-source-readback")).toHaveLength(0);
  expect(events("lab-main-startup-frame")[0].detail.currentSourceMatches).toBe(false);
  expect(ready).not.toHaveBeenCalled();
  Object.defineProperty(main, "currentSrc", { configurable: true, get: () => main.src });
  deliver(main, 0); deliver(main, 1 / 30);
  expect(events("lab-source-readback")).toHaveLength(1);
  expect(events("lab-source-readback")[0].detail).toEqual(expect.objectContaining({ role: "main", selectedSource: src, sourceKind: "mp4" }));
  expect(JSON.stringify(exportFeedTrace())).not.toContain("unrelated.test");
  expect(ready).toHaveBeenCalledTimes(1);
  await Promise.resolve();
});

test("obsolete startup callbacks and bridge play settlements cannot label the next owner", async () => {
  let resolveBridge!: () => void, bridgeCalls = 0;
  const delayed = new Promise<void>(resolve => { resolveBridge = resolve; });
  jest.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
    paused.set(this, false); this.dispatchEvent(new Event("play"));
    return this.dataset.mobilePreparation === "true" && ++bridgeCalls > 1 ? delayed : Promise.resolve();
  });
  const s = await scenario({ lead: 0.6, startMs: 200, rateMode: "steady" });
  const obsolete = [...(callbacks.get(s.main)?.values() ?? [])];
  const sampleCount = events("lab-main-startup-frame").length;
  const settledCount = events("lab-bridge-play-settled").length;
  controller.activate({ postId: "next-owner", src: "https://example.test/next-owner.mp4", token: Symbol("next-owner"),
    host: document.createElement("div"), previewHost: document.createElement("div"), present: jest.fn(), ready: jest.fn() });
  obsolete.forEach(callback => callback(performance.now(), { mediaTime: 0.1, presentedFrames: 4,
    presentationTime: performance.now(), expectedDisplayTime: performance.now() } as VideoFrameCallbackMetadata));
  resolveBridge(); await Promise.resolve(); await Promise.resolve();
  expect(events("lab-main-startup-frame")).toHaveLength(sampleCount);
  expect(events("lab-bridge-play-settled")).toHaveLength(settledCount);
  expect(events("lab-source-readback").some(event => event.postId === "next-owner")).toBe(false);
});

test.each([{ lead: 0.4, startMs: 919 }, { lead: 0.5, startMs: 764 }])("observed lead $lead converges through rate-dependent progression before 3 seconds", async ({ lead, startMs }) => {
  const s = await scenario({ lead, startMs });
  expect(s.bridge.playbackRate).toBe(0.75); expect(s.main.playbackRate).toBe(1);
  s.advance(2999 - performance.now());
  expect(s.ready).toHaveBeenCalledTimes(1); expect(s.readyAt[0]).toBeLessThan(3000); expect(s.failed).not.toHaveBeenCalled();
  expect(events("bridge-align-seek")).toHaveLength(0); expect(events("handoff-timeout")).toHaveLength(0);
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
  expect(bridgeWrites(s.bridge)[1]).toEqual(expect.objectContaining({ paused: true, hidden: true }));
  expect(writes.filter(write => write.video === s.main)).toHaveLength(0);
  expect(s.main.muted).toBe(s.initialMainMuted);
  expect(s.maxBridgeSubmissionGapMs()).toBeLessThan(250);
  console.log("RATE_PROTOTYPE_IDEAL", JSON.stringify({ lead, startMs, handoffMs: s.readyAt[0], maxBridgeSubmissionGapMs: s.maxBridgeSubmissionGapMs(), seeks: 0, correctionWrites: 1 }));
});

test("prearmed mode writes at preparation readiness while hidden and paused, then resets after handoff", async () => {
  const s = await scenario({ rateMode: "prearmed", lead: 0.5, startMs: 764 });
  expect(bridgeWrites(s.bridge)[0]).toEqual(expect.objectContaining({ rate: 0.75, paused: true, hidden: true }));
  expect(events("preparation-rate-prearm")[0].detail.result).toBe("applied");
  expect(events("bridge-rate-prototype")[0].detail.result).toBe("prearmed");
  expect(s.main.playbackRate).toBe(1);
  s.advance(2999 - performance.now());
  expect(s.ready).toHaveBeenCalledTimes(1);
  expect(s.failed).not.toHaveBeenCalled();
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
  expect(events("bridge-align-seek")).toHaveLength(0);
});

test("steady mode avoids injected rate-write freezes while retaining the three-second recovery bound", async () => {
  const s = await scenario({ rateMode: "steady", mode: "freeze-300ms", lead: 0.4, startMs: 919 });
  expect(events("bridge-rate-prototype")[0].detail.result).toBe("steady-1x");
  s.advance(3000 - performance.now());
  expect(s.readyAt).toEqual([3000]);
  expect(s.failed).not.toHaveBeenCalled();
  expect(events("handoff-recovery")[0].detail.result).toBe("moving-main");
  expect(s.maxBridgeSubmissionGapMs()).toBeLessThan(250);
  expect(bridgeWrites(s.bridge)).toHaveLength(0);
  expect(writes.filter(write => write.video === s.main)).toHaveLength(0);
  expect(events("bridge-align-seek")).toHaveLength(0);
  expect(s.main.muted).toBe(s.initialMainMuted);
});

test("steady mode can hand off naturally aligned frames without changing either rate", async () => {
  const s = await scenario({ rateMode: "steady", lead: 0, mainMedia: 0.1, mainLag: 0 });
  expect(s.readyAt).toEqual([764]);
  expect(events("handoff-timeout")).toHaveLength(0);
  expect(s.failed).not.toHaveBeenCalled();
  expect(writes).toHaveLength(0);
});

test.each([true, false])("serial control unloads ready=%s preparation before main source assignment and rejects obsolete callbacks", async preparedReady => {
  controller.dispose(); controller = new MobileFeedController("serial");
  const postId = `serial-${++scenarioNumber}`, src = `https://example.test/${postId}.m3u8`;
  const preparedHost = document.createElement("div"); document.body.appendChild(preparedHost);
  controller.prepare({ postId, src, host: preparedHost, present: jest.fn() });
  const prepared = preparedHost.querySelector("video")!; media(prepared);
  prepared.dispatchEvent(new Event("loadedmetadata"));
  const obsolete = [...(callbacks.get(prepared)?.values() ?? [])];
  if (preparedReady) deliver(prepared, 1 / 30);
  const originalSourceSetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!.set!;
  let observedAssignment = false;
  jest.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(function (this: HTMLMediaElement, value: string) {
    if (this.dataset.mobilePreparation !== "true" && value === src) {
      observedAssignment = true;
      expect(prepared.hasAttribute("src")).toBe(false);
      expect(prepared.isConnected).toBe(false);
      expect(prepared.paused).toBe(true);
      expect(callbacks.get(prepared)?.size ?? 0).toBe(0);
    }
    originalSourceSetter.call(this, value);
  });
  const host = document.createElement("div"), previewHost = document.createElement("div"); document.body.append(host, previewHost);
  const ready = jest.fn(), token = Symbol("serial");
  const main = controller.activate({ postId, src, token, host, previewHost, present: jest.fn(), ready });
  expect(observedAssignment).toBe(true);
  expect(previewHost.querySelector("video")).toBeNull();
  expect(events("preparation-serial-discard").at(-1)?.detail).toEqual(expect.objectContaining({
    ready: preparedReady, selectedSourceMatches: true, sourceRemoved: true, detached: true, paused: true,
  }));
  media(main); main.muted = false;
  main.dispatchEvent(new Event("loadedmetadata")); main.dispatchEvent(new Event("seeked"));
  void main.play(); main.dispatchEvent(new Event("playing")); await Promise.resolve();
  deliver(main, 0); jest.advanceTimersByTime(34); deliver(main, 1 / 30);
  expect(ready).toHaveBeenCalledTimes(1);
  expect(events("presentation-handoff").at(-1)?.detail.reason).toBe("main-only");
  expect(events("activation").at(-1)?.detail.warmEligible).toBe(false);
  obsolete.forEach(callback => callback(performance.now(), { mediaTime: 1 / 30, presentedFrames: 2 } as VideoFrameCallbackMetadata));
  expect(ready).toHaveBeenCalledTimes(1); expect(events("bridge-frame")).toHaveLength(0);
  expect(main.muted).toBe(false); expect(main.playbackRate).toBe(1); expect(writes).toHaveLength(0);
  const neighborHost = document.createElement("div"); document.body.appendChild(neighborHost);
  const neighborPresent = jest.fn();
  controller.prepare({ postId: `${postId}-next`, src: `${src}?next=1`, host: neighborHost, present: neighborPresent });
  const neighbor = neighborHost.querySelector("video")!; media(neighbor);
  neighbor.dispatchEvent(new Event("loadedmetadata")); deliver(neighbor, 1 / 30);
  expect(neighborPresent).toHaveBeenCalledWith(true);
  expect(main.paused).toBe(false); expect(main.muted).toBe(false);
});

test("serial control preserves the shared main and saved return target when discarding prepared return video", async () => {
  controller.dispose(); controller = new MobileFeedController("serial");
  const postId = `serial-return-${++scenarioNumber}`, src = `https://example.test/${postId}.m3u8`;
  const firstToken = Symbol("serial-departure");
  const main = controller.activate({ postId, src, token: firstToken, host: document.createElement("div"),
    previewHost: document.createElement("div"), present: jest.fn(), ready: jest.fn() });
  media(main); main.currentTime = 2.5;
  controller.release(firstToken);
  jest.advanceTimersByTime(1000);
  const preparedHost = document.createElement("div"); document.body.appendChild(preparedHost);
  const preparedPresent = jest.fn();
  controller.prepare({ postId, src, host: preparedHost, present: preparedPresent });
  const prepared = preparedHost.querySelector("video")!; media(prepared);
  prepared.dispatchEvent(new Event("loadedmetadata")); deliver(prepared, 2.5);
  expect(preparedPresent).toHaveBeenCalledWith(true);
  const ready = jest.fn();
  const returned = controller.activate({ postId, src, token: Symbol("serial-return"), host: document.createElement("div"),
    previewHost: document.createElement("div"), present: jest.fn(), ready });
  expect(returned).toBe(main);
  expect(events("source-version").at(-1)?.detail.position).toBe(2.5);
  expect(events("preparation-serial-discard").at(-1)?.detail).toEqual(expect.objectContaining({ target: 2.5, ready: true }));
  expect(prepared.hasAttribute("src")).toBe(false);
  returned.dispatchEvent(new Event("loadedmetadata")); returned.dispatchEvent(new Event("seeked"));
  void returned.play(); returned.dispatchEvent(new Event("playing")); await Promise.resolve();
  deliver(returned, 2.5); jest.advanceTimersByTime(34); deliver(returned, 2.5 + 1 / 30);
  expect(ready).toHaveBeenCalledTimes(1);
  expect(events("presentation-handoff").at(-1)?.detail.reason).toBe("main-only");
});

test.each(["missing", "rejected"] as const)("guarded mode recovers from %s bridge callbacks as soon as main motion is verified", async bridgeCallbacks => {
  const s = await scenario({ rateMode: "guarded", bridgeCallbacks, startMs: 765 });
  expect(s.readyAt).toEqual([765]); expect(s.failed).not.toHaveBeenCalled();
  expect(events("handoff-timeout")).toHaveLength(0);
  expect(events("presentation-handoff")[0].detail).toEqual(expect.objectContaining({ reason: "bridge-motion-unverified", aligned: false }));
  expect(events("handoff-recovery")[0].detail.trigger).toBe("bridge-motion-unverified");
  const diagnostic = events("handoff-frame-diagnostic")[0].detail;
  expect(diagnostic).toEqual(expect.objectContaining({ bridgeRequestCount: bridgeCallbacks === "missing" ? 1 : 2,
    bridgeCallbackCount: bridgeCallbacks === "missing" ? 0 : 1, bridgeAcceptedCount: 0 }));
  expect(diagnostic.lastBridgeReject).toBe(bridgeCallbacks === "missing" ? null : "position-drift");
  expect(s.bridge.paused).toBe(true); expect(s.bridge.style.visibility).toBe("hidden");
  expect(callbacks.get(s.bridge)?.size ?? 0).toBe(0); expect(s.previewHost.querySelector("video")).toBeNull();
  expect(writes).toHaveLength(0); expect(s.main.muted).toBe(s.initialMainMuted);
  expect(events("bridge-align-seek")).toHaveLength(0);
});

test("guarded mode preserves a healthy unaligned bridge until bounded recovery", async () => {
  const s = await scenario({ rateMode: "guarded" }); s.advance(3000 - performance.now());
  expect(s.readyAt).toEqual([3000]); expect(events("bridge-motion-unverified")).toHaveLength(0);
  expect(events("presentation-handoff")[0].detail.reason).toBe("watchdog"); expect(writes).toHaveLength(0);
});

test("guarded mode withdraws a previously moving bridge only after motion evidence expires and main stays fresh", async () => {
  const s = await scenario({ rateMode: "guarded" }); s.advance(300, false);
  expect(s.ready).toHaveBeenCalledTimes(1); expect(s.readyAt[0] - 764).toBeGreaterThan(250);
  expect(s.readyAt[0] - 764).toBeLessThan(300); expect(s.failed).not.toHaveBeenCalled();
  expect(events("bridge-motion-unverified")[0].detail.lastBridgeMotionAgeMs).toBeGreaterThan(250);
  expect(events("handoff-timeout")).toHaveLength(0); expect(writes).toHaveLength(0);
});

test("guarded recovery requires fresh main submissions, not freshly delivered old callbacks", async () => {
  const s = await scenario({ rateMode: "guarded", bridgeCallbacks: "missing", mainSubmissionAgeMs: 300 });
  expect(s.ready).not.toHaveBeenCalled(); s.advance(3000 - performance.now(), false, false);
  expect(s.ready).not.toHaveBeenCalled(); expect(s.failed).toHaveBeenCalledTimes(1);
  expect(events("handoff-recovery")[0].detail.result).toBe("retry");
});

test("a late duplicate bridge callback cannot refresh the 267 ms old frame observed in Safari", async () => {
  const s = await scenario({ lead: 0.3, startMs: 806 });
  jest.advanceTimersByTime(326);
  deliver(s.bridge, 0.3666666667, 0.4, 13, 267);
  deliver(s.main, 0.3333333333); deliver(s.main, 0.3666666667);
  expect(s.ready).not.toHaveBeenCalled();
  expect(events("bridge-frame").at(-1)?.detail.submissionAgeMs).toBe(267);
  // A new advancing, aligned frame can still complete the handoff.
  deliver(s.bridge, 0.4); deliver(s.main, 0.4);
  expect(s.ready).toHaveBeenCalledTimes(1);
});

test("guarded recovery does not use bridge evidence during main waiting, seeking, pause or hidden state", async () => {
  const s = await scenario({ rateMode: "guarded" });
  s.main.dispatchEvent(new Event("waiting")); s.advance(300, false);
  expect(s.ready).not.toHaveBeenCalled();
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  s.main.dispatchEvent(new Event("playing")); deliver(s.main, 0.4);
  expect(s.ready).not.toHaveBeenCalled();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(s.main, "seeking", { configurable: true, value: true }); deliver(s.main, 0.5);
  expect(s.ready).not.toHaveBeenCalled();
  Object.defineProperty(s.main, "seeking", { configurable: true, value: false }); s.main.pause(); deliver(s.main, 0.6);
  expect(s.ready).not.toHaveBeenCalled(); expect(events("bridge-motion-unverified")).toHaveLength(0);
});

test("bridge callbacks expose compositor metadata without treating it as pixel proof", async () => {
  const s = await scenario({ rateMode: "steady" });
  const pending = [...(callbacks.get(s.bridge)?.values() ?? [])]; callbacks.get(s.bridge)?.clear();
  s.bridge.currentTime = 0.6;
  pending.forEach(callback => callback(performance.now(), {
    mediaTime: 0.6, presentedFrames: 19, width: 720, height: 1280,
    presentationTime: 760, expectedDisplayTime: 780, processingDuration: 0.012,
  } as VideoFrameCallbackMetadata));
  expect(events("bridge-frame").at(-1)?.detail).toEqual(expect.objectContaining({
    mediaTime: 0.6, rate: 1, paused: false, presentedFrames: 19,
    width: 720, height: 1280, callbackTime: 764, presentationTime: 760, expectedDisplayTime: 780, processingDuration: 0.012,
  }));
});

test.each(["throw", "ignored-getter"] as const)("prearmed %s rate setter stays bounded without a moving rate write", async mode => {
  const s = await scenario({ rateMode: "prearmed", mode });
  expect(events("preparation-rate-prearm")[0].detail.result).toBe(mode === "throw" ? "unsupported" : "ignored");
  expect(events("bridge-rate-prototype")[0].detail.result).toBe("missing-prearm");
  s.advance(3000 - performance.now());
  expect(s.readyAt).toEqual([3000]);
  expect(s.failed).not.toHaveBeenCalled();
  expect(bridgeWrites(s.bridge).filter(write => write.rate !== 1)).toHaveLength(1);
  expect(events("bridge-align-seek")).toHaveLength(0);
  expect(s.main.playbackRate).toBe(1);
});

test("a behind bridge speeds up while audible-main rate and mute intent remain unchanged", async () => {
  const s = await scenario({ lead: -0.4, mainMedia: 0.5, mainLag: 0 });
  expect(s.bridge.playbackRate).toBe(1.25); s.advance(2999 - performance.now());
  expect(s.ready).toHaveBeenCalledTimes(1); expect(s.readyAt[0]).toBeLessThan(3000);
  expect(s.main.playbackRate).toBe(1); expect(s.main.muted).toBe(s.initialMainMuted); expect(s.bridge.muted).toBe(true);
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([1.25, 1]);
  expect(events("bridge-align-seek")).toHaveLength(0);
});

test("insufficient correction time does not enlarge the deadline or start a rate change", async () => {
  const s = await scenario({ startMs: 1500 });
  expect(events("bridge-rate-prototype")[0].detail.result).toBe("insufficient-budget");
  expect(bridgeWrites(s.bridge)).toHaveLength(0); s.advance(1500);
  expect(s.readyAt).toEqual([3000]); expect(events("handoff-timeout")).toHaveLength(1);
  expect(events("bridge-align-seek")).toHaveLength(0); expect(s.failed).not.toHaveBeenCalled();
});

test.each(["throw", "ignored-getter", "ignored-engine"] as const)("a %s rate setter/engine uses bounded recovery without retries or seeks", async mode => {
  const s = await scenario({ mode }); s.advance(3000 - performance.now());
  expect(s.readyAt).toEqual([3000]); expect(s.failed).not.toHaveBeenCalled();
  expect(events("handoff-timeout")).toHaveLength(1); expect(events("bridge-align-seek")).toHaveLength(0);
  expect(bridgeWrites(s.bridge).filter(write => write.rate !== 1)).toHaveLength(1);
  expect(s.bridge.playbackRate).toBe(1); expect(s.main.playbackRate).toBe(1);
});

test("stale bridge samples cannot admit a correction until both streams are freshly observed", async () => {
  const s = await scenario({ staleBridge: true });
  expect(bridgeWrites(s.bridge)).toHaveLength(0); expect(s.ready).not.toHaveBeenCalled();
  s.publishBridge(); expect(s.bridge.playbackRate).toBe(0.75);
  s.advance(2999 - performance.now()); expect(s.ready).toHaveBeenCalledTimes(1);
  expect(bridgeWrites(s.bridge).filter(write => write.rate !== 1)).toHaveLength(1);
});

test("delayed bridge callbacks cannot falsely align an old frame or trigger more rate writes", async () => {
  const s = await scenario(); s.advance(600, false);
  expect(s.ready).not.toHaveBeenCalled(); expect(bridgeWrites(s.bridge)).toHaveLength(1);
  expect(s.bridge.playbackRate).toBe(0.75);
  s.publishBridge(); s.advance(2999 - performance.now());
  expect(s.ready).toHaveBeenCalledTimes(1); expect(events("bridge-align-seek")).toHaveLength(0);
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
});

test("stale main callbacks cannot authorize early handoff and never cause rate oscillation", async () => {
  const s = await scenario(); s.advance(600, true, false);
  expect(s.ready).not.toHaveBeenCalled(); expect(bridgeWrites(s.bridge)).toHaveLength(1);
  expect(s.bridge.playbackRate).toBe(0.75);
  s.advance(2999 - performance.now()); expect(s.ready).toHaveBeenCalledTimes(1);
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
});

test("a long callback gap can miss the alignment window and must remain a bounded recovery", async () => {
  const s = await scenario(); s.advance(1200);
  expect(s.ready).not.toHaveBeenCalled();
  s.advance(1000, false); // Bridge continues at .75x while callback delivery is absent.
  s.publishBridge(); expect(s.ready).not.toHaveBeenCalled();
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75]);
  s.advance(3000 - performance.now());
  expect(s.readyAt).toEqual([3000]); expect(s.failed).not.toHaveBeenCalled();
  expect(events("handoff-timeout")).toHaveLength(1);
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
  expect(events("bridge-align-seek")).toHaveLength(0);
});

test("main waiting aborts correction once and resuming cannot start a second rate change", async () => {
  const s = await scenario(); s.main.dispatchEvent(new Event("waiting"));
  expect(s.bridge.playbackRate).toBe(1); expect(s.main.playbackRate).toBe(1);
  expect(s.main.paused).toBe(false); expect(s.main.muted).toBe(s.initialMainMuted);
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
  expect(events("bridge-rate-reset")[0].detail).toEqual(expect.objectContaining({ reason: "main-waiting", previousRate: 0.75, rate: 1 }));
  s.main.dispatchEvent(new Event("playing")); s.advance(3000 - performance.now());
  expect(s.readyAt).toEqual([3000]); expect(s.failed).not.toHaveBeenCalled();
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
  expect(events("bridge-align-seek")).toHaveLength(0);
});

test("unequal fresh sample ages cannot hand off solely because old frame timestamps match", async () => {
  const s = await scenario({ lead: 0.1, mainMedia: 0.1, mainLag: 0 });
  // The bridge last submitted .2 at the current instant. After 90 ms, main
  // submits .2 too, but the running .75x bridge projects to .2675.
  jest.advanceTimersByTime(90);
  s.bridge.currentTime = 0.2675;
  deliver(s.main, 0.2, 0.2);
  expect(s.ready).not.toHaveBeenCalled();
  expect(s.bridge.playbackRate).toBe(0.75);
  expect(bridgeWrites(s.bridge).filter(write => write.rate !== 1)).toHaveLength(1);
  // Fresh actual frames AND their projections agree, so handoff can finish.
  deliver(s.main, 0.2666666667, 0.2666666667);
  deliver(s.bridge, 0.2666666667, 0.2675);
  expect(s.ready).toHaveBeenCalledTimes(1);
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
});

test("reversal cancels old callbacks and resets the hidden paused bridge before slot reuse", async () => {
  const s = await scenario(); const obsolete = [...(callbacks.get(s.bridge)?.values() ?? [])];
  const main = controller.activate({ postId: "reversal", src: "https://example.test/reversal.mp4", token: Symbol("reversal"),
    host: document.createElement("div"), previewHost: document.createElement("div"), present: jest.fn(), ready: jest.fn() });
  media(main); main.dispatchEvent(new Event("loadedmetadata")); main.dispatchEvent(new Event("seeked")); void main.play(); main.dispatchEvent(new Event("playing"));
  expect(s.bridge.playbackRate).toBe(1); expect(s.bridge.paused).toBe(true); expect(s.bridge.style.visibility).toBe("hidden");
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
  obsolete.forEach(callback => callback(performance.now(), { mediaTime: 0.6, presentedFrames: 19 } as VideoFrameCallbackMetadata));
  expect(s.ready).not.toHaveBeenCalled(); expect(callbacks.get(s.bridge)?.size ?? 0).toBe(0);
  const neighborHost = document.createElement("div");
  controller.prepare({ postId: "new-neighbor", src: "https://example.test/new-neighbor.mp4", host: neighborHost, present: jest.fn() });
  expect(neighborHost.querySelector("video")).toBe(s.bridge);
  expect(s.bridge.playbackRate).toBe(1); expect(s.bridge.muted).toBe(true);
});

test.each(["pause", "seek", "suspend"] as const)("%s resets bridge rate and leaves main rate unchanged", async action => {
  const s = await scenario();
  if (action === "pause") s.main.pause();
  else if (action === "seek") s.main.dispatchEvent(new Event("seeking"));
  else controller.suspend();
  expect(s.bridge.playbackRate).toBe(1); expect(s.main.playbackRate).toBe(1);
  expect(bridgeWrites(s.bridge).map(write => write.rate)).toEqual([0.75, 1]);
  expect(writes.filter(write => write.video === s.main)).toHaveLength(0);
});

test("a rate-change freeze can violate the visual goal even when ideal convergence still succeeds", async () => {
  const s = await scenario({ mode: "freeze-300ms" }); s.advance(3000 - performance.now());
  expect(s.ready).toHaveBeenCalledTimes(1); expect(s.maxBridgeSubmissionGapMs()).toBeGreaterThan(250);
  console.log("RATE_PROTOTYPE_INJECTED_RISK", JSON.stringify({ handoffMs: s.readyAt[0], maxBridgeSubmissionGapMs: s.maxBridgeSubmissionGapMs(), satisfiesFreezeGoal: false }));
});
