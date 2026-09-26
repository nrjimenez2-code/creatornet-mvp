/** Opt-in, local-only measurements. Nothing here controls playback or sends telemetry. */
type Value = string | number | boolean | null;
type Detail = Record<string, Value>;
export type FeedTraceEvent = { sequence: number; at: number; kind: string; activation: number | null; postId: string | null; source: number; seek: number; detail: Detail };
export type FeedTraceIdentity = { activation: number; postId: string; source: number; seek: number };
export class FeedTrace {
  private events: FeedTraceEvent[];
  private cursor = 0;
  private count = 0;
  private sequence = 0;
  private activation = 0;
  constructor(readonly capacity = 24_000, private now = () => performance.now()) {
    this.events = [];
  }
  begin(postId: string): FeedTraceIdentity { return { activation: ++this.activation, postId, source: 0, seek: 0 }; }
  record(kind: string, identity: FeedTraceIdentity | null, detail: Detail = {}) {
    this.events[this.cursor] = { sequence: ++this.sequence, at: this.now(), kind, activation: identity?.activation ?? null, postId: identity?.postId ?? null, source: identity?.source ?? 0, seek: identity?.seek ?? 0, detail };
    this.cursor = (this.cursor + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  snapshot() {
    const start = this.count === this.capacity ? this.cursor : 0;
    return { droppedEvents: this.sequence - this.count, events: Array.from({ length: this.count }, (_, i) => this.events[(start + i) % this.capacity]) };
  }
  clear() { this.events = []; this.cursor = this.count = this.sequence = 0; }
}

const trace = new FeedTrace();
const states = new WeakMap<HTMLVideoElement, { identity: FeedTraceIdentity; stop: () => void; target: (time: number) => void }>();
let runContext: Detail = {};
let captureEnabled: boolean | undefined;
export function feedTraceEnabled() {
  if (typeof window === "undefined") return false;
  return captureEnabled ??= new URLSearchParams(window.location.search).get("feedDebug") === "1";
}
export function recordFeedEvent(kind: string, detail: Detail = {}, video?: HTMLVideoElement) {
  if (video && kind === "resume-seek-request" && typeof detail.target === "number") states.get(video)?.target(detail.target);
  if (feedTraceEnabled()) trace.record(kind, video ? states.get(video)?.identity ?? null : null, detail);
}
export function setFeedRunContext(context: Detail) { runContext = { ...runContext, ...context }; }
export function resetFeedTrace() { trace.clear(); recordFeedEvent("run-reset"); }
export function exportFeedTrace() {
  return {
    schema: 1, exportedAt: new Date().toISOString(), timeOrigin: performance.timeOrigin,
    userAgent: navigator.userAgent, context: runContext,
    unavailable: { audibleOutput: "Requires external recording; unmuted is only intent", visiblePresentation: "Compositor submissions require phone recording", deviceMemory: "Unavailable on iOS; use device profiling", decoderCPU: "Requires device profiling", thermalState: "Record manually", transferBytes: "Null when Resource Timing does not expose bytes" },
    ...trace.snapshot(),
  };
}
export function playableBuffer(video: HTMLVideoElement, position = video.currentTime): number {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= position && video.buffered.end(i) >= position) return video.buffered.end(i) - position;
  }
  return 0;
}
export function sourceKind(src: string) { return src.includes(".m3u8") ? "hls" : src.includes("/auto/") ? "resolver" : src.includes(".mp4") ? "mp4" : "other"; }

export function recordLegacyPreparation(video: HTMLVideoElement, postId: string, metadata?: VideoFrameCallbackMetadata) {
  if (!feedTraceEnabled()) return;
  const valid = !!metadata && video.readyState >= 2 && !video.seeking && video.currentSrc === video.src && Math.abs(video.currentTime - metadata.mediaTime) <= 0.1;
  video.dataset.measuredPreparedSource = valid ? video.src : "";
  video.dataset.measuredPreparedTime = valid ? String(metadata.mediaTime) : "";
  recordFeedEvent("legacy-preview-frame", { postId, valid, position: video.currentTime, buffer: playableBuffer(video), readyState: video.readyState, seeking: video.seeking });
}
export function measuredPreparation(video: HTMLVideoElement | null, src: string, target: number): boolean {
  if (!video || !video.dataset.measuredPreparedTime || video.dataset.measuredPreparedSource !== new URL(src, document.baseURI).href) return false;
  const remaining = Number.isFinite(video.duration) ? video.duration - target : 1;
  return !video.seeking && video.readyState >= 2 && Math.abs(Number(video.dataset.measuredPreparedTime) - target) <= 0.1 && remaining > 0 && playableBuffer(video, target) + 0.001 >= Math.min(1, remaining);
}

/** Two advancing submissions, with no seek/source/owner change, establish moving media. */
export function validFeedFrame(video: HTMLVideoElement, source: string, mediaTime: number, previousTime: number | null) {
  return video.readyState >= 2 && !video.seeking && !video.paused && video.src === source && video.currentSrc === source &&
    Number.isFinite(mediaTime) && Math.abs(video.currentTime - mediaTime) <= 0.25 &&
    previousTime !== null && mediaTime > previousTime + 0.0001;
}

/** Attach before src assignment. A new activation tears down all earlier callbacks. */
export function beginFeedVideoTrace(video: HTMLVideoElement, postId: string, src: string, warmEligible: boolean | null = null) {
  if (!feedTraceEnabled()) return;
  states.get(video)?.stop();
  const identity = trace.begin(postId);
  const expectedSource = new URL(src, document.baseURI).href;
  const started = performance.now();
  const qualityStart = video.getVideoPlaybackQuality?.();
  let alive = true;
  let frame: number | undefined;
  let previousTime: number | null = null;
  let lastFrameAt: number | null = null;
  let moving = false;
  let waitingAt: number | null = null;
  let sampleAt = -Infinity;
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  let intendedPosition = 0;
  let targetObserved = false;
  const record = (kind: string, detail: Detail = {}) => { if (alive) trace.record(kind, identity, detail); };
  const cancelFrame = () => { if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); frame = undefined; };
  const observe = () => {
    if (!alive || !video.requestVideoFrameCallback) return;
    const generation = `${identity.source}:${identity.seek}`;
    frame = video.requestVideoFrameCallback((now, metadata) => {
      if (!alive || states.get(video)?.identity !== identity || generation !== `${identity.source}:${identity.seek}`) return;
      if (!video.seeking && video.currentSrc === expectedSource && metadata.mediaTime >= intendedPosition - 0.1 && metadata.mediaTime <= intendedPosition + (now - started) / 1_000 + 0.25) targetObserved = true;
      const valid = targetObserved && validFeedFrame(video, expectedSource, metadata.mediaTime, previousTime);
      if (video.readyState >= 2 && !video.seeking && video.currentSrc === expectedSource) previousTime = metadata.mediaTime;
      else previousTime = null;
      if (valid) {
        if (!moving) {
          moving = true;
          const ms = now - started;
          video.dataset.startupMs = String(Math.round(ms));
          video.dataset.firstFrameReadyState = String(video.readyState);
          record("moving-frame", { activationMs: ms, mediaTime: metadata.mediaTime, buffer: playableBuffer(video), muted: video.muted });
        }
        if (lastFrameAt !== null && now - lastFrameAt > 250) record("frame-gap", { durationMs: now - lastFrameAt, mediaTime: metadata.mediaTime });
        lastFrameAt = now;
        if (waitingAt !== null) { record("stall-end", { durationMs: now - waitingAt, reason: "advancing-frame" }); waitingAt = null; }
        if (now - sampleAt >= 500) { record("frame-sample", { mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames, buffer: playableBuffer(video), muted: video.muted }); sampleAt = now; }
      }
      observe();
    });
  };
  const invalidate = () => { cancelFrame(); previousTime = null; lastFrameAt = null; observe(); };
  const listeners: Array<[string, () => void]> = [];
  const on = (name: string, fn: () => void) => { video.addEventListener(name, fn); listeners.push([name, fn]); };
  on("loadstart", () => { identity.source++; record("loadstart"); invalidate(); });
  on("loadedmetadata", () => record("metadata", { duration: Number.isFinite(video.duration) ? video.duration : null, width: video.videoWidth, height: video.videoHeight }));
  on("loadeddata", () => record("loadeddata", { buffer: playableBuffer(video) }));
  on("canplay", () => record("playable-buffer", { buffer: playableBuffer(video), readyState: video.readyState }));
  on("seeking", () => {
    intendedPosition = video.currentTime; targetObserved = false;
    identity.seek++; record("seek-start", { target: video.currentTime }); invalidate();
    clearTimeout(seekTimer);
    const seek = identity.seek;
    seekTimer = setTimeout(() => { if (alive && identity.seek === seek) record("seek-timeout", { target: video.currentTime }); }, 2_000);
  });
  on("seeked", () => { clearTimeout(seekTimer); record("seek-complete", { position: video.currentTime }); invalidate(); });
  on("play", () => record("play-event", { muted: video.muted }));
  on("playing", () => record("playing-event", { muted: video.muted, buffer: playableBuffer(video) }));
  on("volumechange", () => record("sound-state", { muted: video.muted, volume: video.volume, outputMeasured: false }));
  on("waiting", () => { if (waitingAt === null) { waitingAt = performance.now(); record("stall-start", { phase: moving ? "playback" : "startup", buffer: playableBuffer(video) }); } });
  on("pause", () => { record("pause", { position: video.currentTime }); previousTime = null; lastFrameAt = null; });
  on("error", () => record("media-error", { code: video.error?.code ?? null, position: video.currentTime, sourceKind: sourceKind(video.src), buffer: playableBuffer(video) }));
  const stop = () => {
    if (!alive) return;
    const quality = video.getVideoPlaybackQuality?.();
    record("activation-end", { position: video.currentTime, movingObserved: moving, incompleteStallMs: waitingAt === null ? null : performance.now() - waitingAt, droppedFrames: quality && qualityStart ? quality.droppedVideoFrames - qualityStart.droppedVideoFrames : null, totalFrames: quality && qualityStart ? quality.totalVideoFrames - qualityStart.totalVideoFrames : null });
    alive = false; cancelFrame(); clearTimeout(seekTimer);
    listeners.forEach(([name, fn]) => video.removeEventListener(name, fn));
    if (states.get(video)?.identity === identity) states.delete(video);
  };
  states.set(video, { identity, stop, target: time => { intendedPosition = time; targetObserved = false; identity.seek++; invalidate(); } });
  delete video.dataset.startupMs;
  delete video.dataset.firstFrameReadyState;
  record("activation", { sourceKind: sourceKind(src), warmEligible, readyState: video.readyState, buffer: playableBuffer(video), frameCallbackAvailable: !!video.requestVideoFrameCallback });
  record("source-assignment", { changed: video.src !== expectedSource });
  if (!video.requestVideoFrameCallback) record("measurement-unavailable", { measurement: "moving-frames" });
  observe();
}
export function endFeedVideoTrace(video: HTMLVideoElement) { states.get(video)?.stop(); }

/** rAF measures main-thread opportunity, not physical display refresh or compositor FPS. */
export function observeFeedScroll(root: HTMLElement, tab: string) {
  if (!feedTraceEnabled()) return () => {};
  recordFeedEvent("feed-surface", { tab });
  let gestureAt: number | null = null;
  let previous = 0;
  let raf = 0;
  let settling: ReturnType<typeof setTimeout> | undefined;
  let touching = false;
  const intervals: number[] = [];
  const sample = (now: number) => {
    if (previous) { intervals.push(now - previous); if (intervals.length > 600) intervals.shift(); }
    previous = now; raf = requestAnimationFrame(sample);
  };
  const settle = (method = "120ms-scroll-quiet") => {
    if (gestureAt === null || touching) return;
    cancelAnimationFrame(raf);
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    recordFeedEvent("scroll-settle", { tab, gestureMs: performance.now() - gestureAt, settleMethod: method, rafMedianMs: median, observedRafHz: median ? 1_000 / median : null, rafMaxMs: sorted.at(-1) ?? null, rafSamples: sorted.length, gapsAbove1_5Cadence: median ? intervals.filter(ms => ms > median * 1.5).length : null });
    gestureAt = null; previous = 0;
  };
  const begin = (origin: string) => {
    if (gestureAt === null) { gestureAt = performance.now(); intervals.length = 0; previous = 0; raf = requestAnimationFrame(sample); recordFeedEvent("gesture-start", { tab, origin }); }
    clearTimeout(settling); settling = setTimeout(settle, 120);
  };
  const touchStart = () => { touching = true; begin("touch"); clearTimeout(settling); };
  const touchEnd = () => { touching = false; clearTimeout(settling); settling = setTimeout(settle, 120); };
  const scroll = () => { begin("scroll"); };
  const scrollEnd = () => settle("native-scrollend");
  const visibility = () => { recordFeedEvent("page-visibility", { hidden: document.hidden }); if (document.hidden) { touching = false; settle("page-hidden"); } };
  root.addEventListener("touchstart", touchStart, { passive: true });
  root.addEventListener("touchend", touchEnd, { passive: true });
  root.addEventListener("touchcancel", touchEnd, { passive: true });
  root.addEventListener("scroll", scroll, { passive: true });
  root.addEventListener("scrollend", scrollEnd);
  document.addEventListener("visibilitychange", visibility);
  let resources: PerformanceObserver | undefined;
  let longTasks: PerformanceObserver | undefined;
  try {
    resources = new PerformanceObserver(list => {
      for (const item of list.getEntries() as PerformanceResourceTiming[]) {
        if (!/media\.creatornet\.net|cloudflarestream\.com/.test(item.name)) continue;
        recordFeedEvent("media-resource", { sourceKind: sourceKind(item.name), durationMs: item.duration, transferBytes: item.transferSize > 0 ? item.transferSize : null, encodedBytes: item.encodedBodySize > 0 ? item.encodedBodySize : null });
      }
    });
    resources.observe({ type: "resource" });
  } catch { recordFeedEvent("measurement-unavailable", { measurement: "resource-timing" }); }
  try {
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      longTasks = new PerformanceObserver(list => { for (const task of list.getEntries()) recordFeedEvent("long-task", { start: task.startTime, durationMs: task.duration }); });
      longTasks.observe({ type: "longtask" });
    } else recordFeedEvent("measurement-unavailable", { measurement: "long-tasks" });
  } catch { recordFeedEvent("measurement-unavailable", { measurement: "long-tasks" }); }
  return () => { touching = false; settle("feed-exit"); cancelAnimationFrame(raf); clearTimeout(settling); resources?.disconnect(); longTasks?.disconnect(); root.removeEventListener("touchstart", touchStart); root.removeEventListener("touchend", touchEnd); root.removeEventListener("touchcancel", touchEnd); root.removeEventListener("scroll", scroll); root.removeEventListener("scrollend", scrollEnd); document.removeEventListener("visibilitychange", visibility); };
}
