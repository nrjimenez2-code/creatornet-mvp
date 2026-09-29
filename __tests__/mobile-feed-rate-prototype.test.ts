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
function deliver(video: HTMLVideoElement, mediaTime: number, clock = mediaTime, count = Math.round(mediaTime * 30) + 1) {
  video.currentTime = clock;
  const pending = [...(callbacks.get(video)?.values() ?? [])]; callbacks.get(video)?.clear();
  pending.forEach(callback => callback(performance.now(), { mediaTime, presentedFrames: count } as VideoFrameCallbackMetadata));
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

async function scenario(options: { lead?: number; startMs?: number; mainMedia?: number; mainLag?: number; mode?: RateMode; staleBridge?: boolean; rateMode?: "reactive" | "prearmed" } = {}) {
  if (options.rateMode === "prearmed") { controller.dispose(); controller = new MobileFeedController("prearmed"); }
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
  deliver(bridge, 2 / 30);
  if (options.staleBridge) {
    jest.advanceTimersByTime(startMs - 200); deliver(bridge, bridgeMedia - 0.2);
    jest.advanceTimersByTime(200); bridge.currentTime = bridgeMedia;
  } else {
    jest.advanceTimersByTime(startMs); deliver(bridge, bridgeMedia);
  }
  deliver(main, mainMedia - 1 / 30, mainMedia - 1 / 30 + mainLag);
  deliver(main, mainMedia, mainMedia + mainLag);
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
