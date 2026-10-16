// Shared prepared player. Supported mobile feeds use it by default; lab controls remain explicit.
import { adoptPreparedMobileFeedPlayer, claimMobileFeedPlayer, finishPreparedMobileFeedRetirement, mobileFeedPlaybackReady, mobileFeedResumeSnapshot, onMobileFeedPauseRequested, onMobileResumeExpiry, ownsMobileFeedPlayer, preparedMobileFeedRetirementPending, sameMobileResume, releaseMobileFeedPlayer, type ResumeSnapshot } from "./mobileFeedPlayer";
import { feedTraceEnabled, playableBuffer, recordFeedEvent, validFeedFrame } from "./mobileFeedDiagnostics";
import { insightPlaybackSuspended } from "./insightPlayback";

type Presentation = (ready: boolean) => void;
type Preparation = { postId: string; src: string; contentVersion?: string; host: HTMLElement; present: Presentation };
type PreparationPhase = "loading" | "acquiring-frame" | "ready" | "retrying" | "cancelled";
type Slot = { video: HTMLVideoElement; generation: number; postId: string; src: string; snapshot: ResumeSnapshot; phase: PreparationPhase; target: number; ready: boolean; audioEnabled: boolean; frameTime: number | null; frameCount: number | null; stop: () => void; pause: (reason?: string) => void; decode: () => void; present: Presentation };
type NativePlayTiming = { requestedAt: number; returnedAt: number; request: Promise<void> | undefined };
type ActivationInput = { postId: string; src: string; contentVersion?: string; host: HTMLElement; previewHost: HTMLElement; token: symbol; present: Presentation; ready: () => void; failed?: (reason?: string) => void; recover?: (reason: string) => void; position?: number; reload?: boolean; playingIntent?: boolean; soundIntent?: boolean };
type Activation = { token: symbol; postId: string; src: string; video: HTMLVideoElement; playing: boolean; current: () => boolean; playRequested: () => void; pauseRequested?: () => void; observeMainPlay: (timing: NativePlayTiming) => void; stop: () => void };
const BUFFER_TARGET = 1;
const PREPARATION_BUDGET_MS = 2_500;
const STARTUP_FRAME_SAMPLE_LIMIT = 8;
const NATIVE_PLAY_SAMPLE_LIMIT = 4;
const PLAYBACK_RECOVERY_MS = 3_000;
const MOTION_SAMPLE_MS = 250;
const PLAY_ERROR_NAMES = new Set(["AbortError", "NotAllowedError", "NotSupportedError", "InvalidStateError", "NetworkError", "SecurityError", "EncodingError", "TimeoutError", "TypeError", "Error"]);

function playErrorName(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? error.name : undefined;
  return typeof name === "string" && PLAY_ERROR_NAMES.has(name) ? name : "UnknownError";
}

function audioSessionSnapshot(): Record<string, string | null> {
  // Observe only. Changing the session type could change sound/route behavior.
  try {
    const session = (navigator as Navigator & { audioSession?: { state?: unknown; type?: unknown } }).audioSession;
    if (!session) return { audioSessionAvailability: "unsupported", audioSessionState: null, audioSessionType: null };
    const state = session.state, type = session.type;
    const stateKnown = state === "active" || state === "inactive" || state === "interrupted";
    const typeKnown = type === "auto" || type === "playback" || type === "ambient" || type === "transient" || type === "transient-solo" || type === "play-and-record";
    return { audioSessionAvailability: stateKnown ? "available" : "state-unavailable",
      audioSessionState: stateKnown ? state : null, audioSessionType: typeKnown ? type : null };
  } catch {
    return { audioSessionAvailability: "unavailable", audioSessionState: null, audioSessionType: null };
  }
}

function submittedAt(metadata: VideoFrameCallbackMetadata, now: number) {
  // Callback delivery can be late. It cannot refresh an old submitted frame.
  return Number.isFinite(metadata.presentationTime) && metadata.presentationTime >= 0 && metadata.presentationTime <= now
    ? metadata.presentationTime : -Infinity;
}

function preparationBuffer(video: HTMLVideoElement, target: number) {
  // The iPhone HLS trace starts its first range at 0.000001 even with a valid
  // opening frame. Normalize only that zero-start boundary, not real gaps or
  // saved return positions, and count only the duration actually buffered.
  if (target === 0 && video.buffered.length) {
    const start = video.buffered.start(0);
    if (start > 0 && start <= 0.000001) return Math.max(0, video.buffered.end(0) - start);
  }
  return playableBuffer(video, target);
}

/** Promote a qualified paused neighbor into sole ownership. Physical phone
 * acceptance was owner-waived for release and remains unverified. */
export class PreparedMobileFeedController {
  constructor(private readonly preparationMode: "prepared" | "prepared-audio" | "prepared-inplace-audio" | "prepared-preload-audio" = "prepared-preload-audio", private readonly options?: { deferPreparedRetirement?: boolean; retainAudiblePlayer?: boolean }) {}
  private get pausedPreparation() { return this.preparationMode === "prepared-preload-audio"; }
  private get preparedAudio() { return this.preparationMode === "prepared-audio" || this.preparationMode === "prepared-inplace-audio" || this.pausedPreparation; }
  private slots: Slot[] = [];
  private active: Activation | null = null;
  private preparing: Slot | null = null;
  private retainedCover: Slot | null = null;
  private deferredPreparation: Preparation | null = null;
  private preparedActiveReady = false;
  private acceptedPreparationSound = false;
  private sequence = 0;
  private unsubscribeExpiry: (() => void) | null = null;
  private watchExpiry() {
    this.unsubscribeExpiry ??= onMobileResumeExpiry(snapshot => {
      for (const slot of this.slots) {
        if (sameMobileResume(slot.snapshot, snapshot)) this.clear(slot);
      }
    });
  }

  private decodeAllowed() {
    const active = this.active;
    const remaining = active && Number.isFinite(active.video.duration) ? active.video.duration - active.video.currentTime : BUFFER_TARGET;
    return !document.hidden && (!active || this.preparedActiveReady) &&
      (!active || (active.playing && !active.video.paused && !active.video.seeking && active.video.readyState >= 2 && remaining > 0 && playableBuffer(active.video) >= Math.min(BUFFER_TARGET, remaining)));
  }
  private resumePreparation() {
    if (this.retainedCover) return;
    if (this.deferredPreparation && this.active && !preparedMobileFeedRetirementPending(this.active.token)) {
      const input = this.deferredPreparation; this.deferredPreparation = null; this.prepare(input);
    }
    this.refreshPreparationSound();
    const slot = this.preparing;
    if (this.decodeAllowed()) slot?.decode(); else slot?.pause("main-priority");
  }

  private refreshPreparationSound() {
    if (!this.preparedAudio || !this.preparing) return;
    const slot = this.preparing, video = slot.video, active = this.active;
    const remaining = video.duration - slot.target;
    // This control changes mute only after decoding has stopped. A native play
    // resolution on the current unmuted main permits the experiment; it is not
    // evidence of audible output or a transferable WebKit gesture grant.
    const enabled = !this.options?.retainAudiblePlayer && !!active?.current() && this.acceptedPreparationSound && this.preparedActiveReady &&
      active.playing && !active.video.paused && !active.video.muted && !document.hidden &&
      slot.ready && slot.phase === "ready" && video.paused && !video.seeking && video.playbackRate === 1 &&
      !video.error && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 &&
      Number.isFinite(slot.frameTime) && Number.isFinite(slot.frameCount) &&
      Math.abs((slot.frameTime ?? Infinity) - slot.target) <= 0.1 &&
      Number.isFinite(video.currentTime) && Math.abs(video.currentTime - (slot.frameTime ?? Infinity)) <= 0.1 &&
      Number.isFinite(remaining) && remaining > 0 && playableBuffer(video, slot.target) + 0.001 >= Math.min(BUFFER_TARGET, remaining) &&
      video.getAttribute("src") === slot.src && video.currentSrc === video.src &&
      sameMobileResume(slot.snapshot, mobileFeedResumeSnapshot(slot.postId, slot.snapshot.contentVersion, true));
    if (slot.audioEnabled === enabled && video.muted === !enabled) return;
    // The slot never plays after ready. Cancellation, background and expiry
    // mute/remove it; promotion removes it from preparation before main play.
    video.muted = !enabled; slot.audioEnabled = enabled;
    recordFeedEvent("preparation-sound-state", { postId: slot.postId, enabled, paused: video.paused,
      muted: video.muted, position: video.currentTime, outputMeasured: false });
  }

  private clear(slot: Slot) {
    slot.generation = ++this.sequence;
    slot.stop(); slot.stop = () => {}; slot.decode = () => {}; slot.phase = "cancelled";
    recordFeedEvent("preparation-state", { postId: slot.postId, phase: slot.phase });
    slot.pause("cancelled"); slot.video.muted = true;
    slot.video.style.visibility = "hidden";
    // Reset only after the obsolete preparation is paused and hidden. Reused slots
    // must never inherit a correction rate from the preceding activation.
    try { if (slot.video.playbackRate !== 1) slot.video.playbackRate = 1; } catch { /* Source removal below still bounds cleanup. */ }
    slot.present(false);
    slot.ready = false; slot.audioEnabled = false; slot.frameTime = slot.frameCount = null;
    slot.video.removeAttribute("src"); slot.video.load(); slot.video.remove();
    slot.postId = slot.src = "";
    if (this.preparing === slot) this.preparing = null;
    if (this.retainedCover === slot) this.retainedCover = null;

  }
  private slot(): Slot {
    const available = this.slots.find(slot => slot !== this.preparing);
    if (available) { this.clear(available); return available; }
    if (this.slots.length >= 1) throw new Error("Mobile preparation resource limit");
    const video = document.createElement("video");
    video.playsInline = true; video.loop = true; video.muted = true; video.preload = "auto";
    video.className = "absolute inset-0 h-full w-full object-cover pointer-events-none";
    video.style.visibility = "hidden";
    video.dataset.mobilePreparation = "true";
    const slot: Slot = { video, generation: ++this.sequence, postId: "", src: "", snapshot: mobileFeedResumeSnapshot("", ""), phase: "cancelled", target: 0, ready: false, audioEnabled: false, frameTime: null, frameCount: null, stop: () => {}, pause: () => video.pause(), decode: () => {}, present: () => {} };
    this.slots.push(slot); return slot;
  }
  prepare(input: Preparation) {
    this.watchExpiry();
    if (document.hidden || this.active?.postId === input.postId) return;
    if (this.retainedCover || (this.active && preparedMobileFeedRetirementPending(this.active.token))) {
      // Retaining the departing source uses the existing second-element budget.
      // Remember the latest requested neighbor without creating a third element.
      this.deferredPreparation = input;
      return;
    }
    this.deferredPreparation = null;
    const snapshot = mobileFeedResumeSnapshot(input.postId, input.contentVersion ?? input.src, true);
    if (this.preparing?.postId === input.postId && this.preparing.src === input.src && sameMobileResume(this.preparing.snapshot, snapshot)) return;
    if (this.preparing) this.clear(this.preparing);
    const slot = this.slot(); this.preparing = slot;
    const video = slot.video;
    const generation = slot.generation;
    const current = () => slot.generation === generation && this.preparing === slot && !document.hidden;
    slot.postId = input.postId; slot.src = input.src; slot.present = input.present;
    slot.snapshot = snapshot; slot.target = snapshot.position; slot.phase = "loading";
    input.host.appendChild(video);
    let frame: number | undefined;
    let frameValid = false;
    let positioned = false;
    let frameTarget = slot.target;
    let attempt = 0;
    let attemptEpoch = 0;
    let playEpoch = 0;
    let correctiveSeek = false;
    let decoding = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const collectDiagnostics = feedTraceEnabled();
    let frameRequestCount = 0, frameCallbackCount = 0;
    let playRequestCount = 0, playResolvedCount = 0, playRejectedCount = 0, obsoletePlayRejectionCount = 0;
    let lastFrameMediaTime: number | null = null;
    let lastFrameReject: string | null = null;
    let lastPauseReason: string | null = null;
    const diagnostics = (): Record<string, string | number | boolean | null> => {
      if (!collectDiagnostics) return {};
      const buffered = video.buffered;
      const ranges = Array.from({ length: Math.min(buffered.length, 4) }, (_, i) => [buffered.start(i), buffered.end(i)]);
      const main = this.active;
      return {
        frameTarget, position: video.currentTime, bufferAtPosition: playableBuffer(video),
        bufferedRanges: JSON.stringify(ranges), bufferedRangeCount: buffered.length,
        readyState: video.readyState, networkState: video.networkState, paused: video.paused, seeking: video.seeking,
        currentSourceMatches: video.currentSrc === video.src, positioned, frameValid, frameRequestPending: frame !== undefined,
        frameRequestCount, frameCallbackCount, lastFrameMediaTime, lastFrameReject,
        playRequestCount, playResolvedCount, playRejectedCount, obsoletePlayRejectionCount, lastPauseReason,
        decodeAllowed: this.decodeAllowed(), mainPaused: main?.video.paused ?? null,
        mainPlaying: main?.playing ?? null, mainBuffer: main ? playableBuffer(main.video) : null,
      };
    };
    // pause() can reject pending play promises in a later browser task. Mark
    // those requests obsolete before resuming or starting the next attempt.
    slot.pause = reason => { if (collectDiagnostics) lastPauseReason = reason ?? "unspecified"; playEpoch++; video.pause(); };
    const usable = () => {
      const remaining = Number.isFinite(video.duration) ? video.duration - frameTarget : BUFFER_TARGET;
      const buffer = preparationBuffer(video, frameTarget);
      return frameValid && !video.seeking && remaining > 0 && buffer + 0.001 >= Math.min(BUFFER_TARGET, remaining);
    };
    const ready = () => {
      if (!current() || !usable() || slot.ready) return;
      const detail = diagnostics();
      slot.ready = true; slot.phase = "ready"; slot.pause("ready"); slot.stop();
      this.refreshPreparationSound();
      recordFeedEvent("preparation-state", { postId: slot.postId, phase: slot.phase, attempt });
      video.style.visibility = "visible";
      slot.present(true);
      recordFeedEvent("preparation-ready", { ...detail, postId: slot.postId, position: frameTarget, buffer: preparationBuffer(video, frameTarget), generation, bufferTarget: BUFFER_TARGET });
    };
    const observe = () => {
      if (!current() || !video.requestVideoFrameCallback) return;
      const observedEpoch = attemptEpoch;
      if (collectDiagnostics) frameRequestCount++;
      frame = video.requestVideoFrameCallback((_now, metadata) => {
        if (!current() || observedEpoch !== attemptEpoch) return;
        frame = undefined;
        if (collectDiagnostics) { frameCallbackCount++; lastFrameMediaTime = metadata.mediaTime; }
        if (positioned && video.readyState >= 2 && !video.seeking && video.currentSrc === video.src && Math.abs(metadata.mediaTime - frameTarget) <= 0.1) {
          frameValid = true; slot.frameTime = metadata.mediaTime; slot.frameCount = metadata.presentedFrames; slot.pause("target-frame"); ready();
        } else if (positioned && !video.seeking && video.currentSrc === video.src && metadata.mediaTime > frameTarget + 0.1 && !correctiveSeek) {
          if (collectDiagnostics) lastFrameReject = "position-mismatch";
          correctiveSeek = true; slot.pause("corrective-seek"); positioned = false;
          recordFeedEvent("preparation-corrective-seek", { postId: slot.postId, attempt, target: frameTarget, reported: metadata.mediaTime });
          try { video.currentTime = frameTarget; positioned = !video.seeking; } catch { /* The bounded attempt can retry. */ }
          observe();
          if (positioned && this.decodeAllowed()) play();
        } else {
          if (collectDiagnostics) lastFrameReject = !positioned ? "unpositioned" : video.readyState < 2 ? "ready-state"
            : video.seeking ? "seeking" : video.currentSrc !== video.src ? "current-source-mismatch" : "position-mismatch";
          observe();
        }
      });
    };
    const seek = () => {
      if (!current()) return;
      frameTarget = Number.isFinite(video.duration) ? Math.min(slot.target, Math.max(0, video.duration - 0.01)) : slot.target;
      try { if (Math.abs(video.currentTime - frameTarget) > 0.01) video.currentTime = frameTarget; positioned = true; }
      catch { positioned = false; }
    };
    const cancelFrame = () => { attemptEpoch++; if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); frame = undefined; };
    const miss = (reason: string, detail: { errorName?: string; mediaErrorCode?: number | null } = {}) => {
      if (!current() || slot.ready || slot.phase === "retrying") return;
      // Capture before our own pause/cancel obscures the state that missed readiness.
      const snapshot = diagnostics();
      slot.pause("attempt-miss"); cancelFrame(); clearTimeout(timer); decoding = false;
      recordFeedEvent("preparation-miss", { postId: slot.postId, reason, attempt, buffer: preparationBuffer(video, frameTarget), ...snapshot, ...detail });
      if (attempt >= 2) return this.clear(slot);
      slot.phase = "retrying";
      recordFeedEvent("preparation-state", { postId: slot.postId, phase: slot.phase, attempt });
      retryTimer = setTimeout(() => {
        if (!current()) return;
        slot.phase = "loading"; correctiveSeek = false; frameValid = false; positioned = false;
        slot.decode();
      }, 250);
    };
    const error = () => miss("media-or-play-error", { mediaErrorCode: video.error?.code ?? null });
    const play = () => {
      // Separate Preview control: acquire a paused load's actual opening frame,
      // without starting and pausing a muted playback timeline. Every caller
      // (progress, seek completion and retry) must preserve that policy.
      if (this.pausedPreparation) return;
      const requestedEpoch = playEpoch;
      const requestedAttempt = attemptEpoch;
      if (collectDiagnostics) playRequestCount++;
      void video.play()?.then(() => {
        if (collectDiagnostics && current() && requestedAttempt === attemptEpoch) playResolvedCount++;
      }, (reason: unknown) => {
        const errorName = playErrorName(reason);
        if (collectDiagnostics && current() && requestedAttempt === attemptEpoch) {
          playRejectedCount++;
          if (requestedEpoch !== playEpoch) obsoletePlayRejectionCount++;
        }
        if (requestedEpoch !== playEpoch) {
          if (current()) recordFeedEvent("preparation-play-obsolete", { postId: slot.postId, attempt, errorName });
          return;
        }
        miss("media-or-play-error", { errorName });
      });
    };
    const seeked = () => {
      if (!current() || !decoding || video.seeking) return;
      positioned = Math.abs(video.currentTime - frameTarget) <= 0.01;
      if (!frameValid && this.decodeAllowed()) play();
    };
    const progress = () => { ready(); slot.decode(); };
    slot.decode = () => {
      if (!current() || slot.ready || slot.phase === "retrying" || !this.decodeAllowed()) return;
      if (decoding) { if (!frameValid && video.paused) play(); return; }
      decoding = true; attempt++; slot.phase = "acquiring-frame"; correctiveSeek = false;
      if (collectDiagnostics) {
        frameRequestCount = frameCallbackCount = playRequestCount = playResolvedCount = playRejectedCount = obsoletePlayRejectionCount = 0;
        lastFrameMediaTime = null; lastFrameReject = lastPauseReason = null;
      }
      recordFeedEvent("preparation-state", { postId: slot.postId, phase: slot.phase, attempt });
      timer = setTimeout(() => miss("attempt-timeout"), PREPARATION_BUDGET_MS);
      if (video.readyState >= 1) seek();
      observe();
      if (this.pausedPreparation) {
        // Install the callback before loading, and load only after the same
        // active-player buffer/motion budget admits preparation. No callback
        // means no qualified preparation; bounded misses keep the cold path.
        video.src = input.src; video.load();
      } else play();
    };
    slot.stop = () => { playEpoch++; clearTimeout(timer); clearTimeout(retryTimer); cancelFrame(); video.removeEventListener("loadedmetadata", seek); video.removeEventListener("seeked", seeked); video.removeEventListener("progress", progress); video.removeEventListener("error", error); };
    video.addEventListener("loadedmetadata", seek); video.addEventListener("seeked", seeked);
    video.addEventListener("progress", progress); video.addEventListener("error", error);
    recordFeedEvent("preparation-start", { postId: slot.postId, target: slot.target, generation, phase: slot.phase, contentVersion: snapshot.contentVersion, expiresAt: snapshot.expiresAt });
    if (!this.pausedPreparation) { video.src = input.src; video.load(); }
    slot.decode();
  }
  cancelPreparation(postId?: string) {
    if (this.deferredPreparation && (!postId || this.deferredPreparation.postId === postId)) this.deferredPreparation = null;
    if (this.preparing && (!postId || this.preparing.postId === postId)) this.clear(this.preparing);
  }

  activate(input: ActivationInput) {
    const activationRequestedAt = feedTraceEnabled() ? performance.now() : null;
    this.watchExpiry();
    if (this.active) this.release(this.active.token);
    this.preparedActiveReady = false;
    const snapshot = mobileFeedResumeSnapshot(input.postId, input.contentVersion ?? input.src, true);
    const target = input.position ?? snapshot.position;
    const prepared = this.preparing;
    const retainAttachment = this.preparationMode === "prepared-inplace-audio" || this.pausedPreparation;
    const deferRetirement = this.pausedPreparation && this.options?.deferPreparedRetirement === true;
    const preparedAudioEnabled = this.preparedAudio && this.acceptedPreparationSound &&
      prepared?.audioEnabled === true && input.soundIntent === true && input.playingIntent !== false;
    // A changed sound/pause intent revokes this control before selection. An
    // unexpected unmuted slot in the original prepared mode remains ineligible.
    if (prepared?.audioEnabled && !preparedAudioEnabled) { prepared.video.muted = true; prepared.audioEnabled = false; }
    let promoted: HTMLVideoElement | null = null;
    let cover: Slot | null = null;
    if (!input.reload && prepared?.ready && prepared.phase === "ready" && prepared.postId === input.postId && prepared.src === input.src &&
        sameMobileResume(prepared.snapshot, snapshot) && Math.abs(prepared.target - target) < 0.01 && target === snapshot.position &&
        prepared.frameTime !== null && prepared.frameCount !== null && Number.isFinite(prepared.frameCount)) {
      // Invalidate every preparation callback/settlement before adoption. Unlike
      // clear(), this cancellation never removes or reloads the qualified source.
      prepared.generation = ++this.sequence; prepared.stop(); prepared.stop = () => {};
      prepared.decode = () => {};
      if (this.options?.retainAudiblePlayer) {
        const candidate = prepared.video, remaining = candidate.duration - target;
        // A prepared frame is only a muted cover. Keep the user's audible element
        // and its gesture grant; never promote the neighbor into sound ownership.
        if (!document.hidden && candidate.parentElement === input.previewHost && input.previewHost.isConnected &&
            candidate.getAttribute("src") === input.src && candidate.currentSrc === candidate.src && candidate.paused && candidate.muted &&
            !candidate.seeking && !candidate.error && candidate.playbackRate === 1 && candidate.readyState >= 2 &&
            candidate.videoWidth > 0 && candidate.videoHeight > 0 && Number.isFinite(remaining) && remaining > 0 &&
            Math.abs(prepared.frameTime - target) <= 0.1 && Number.isFinite(candidate.currentTime) &&
            Math.abs(candidate.currentTime - prepared.frameTime) <= 0.1 && playableBuffer(candidate, target) + 0.001 >= Math.min(BUFFER_TARGET, remaining)) {
          cover = prepared; this.preparing = null; this.retainedCover = cover;
        }
      } else {
        promoted = adoptPreparedMobileFeedPlayer(retainAttachment ? input.previewHost : input.host, input.token, prepared.video, input.src, snapshot, prepared.frameTime,
          retainAttachment ? { expectedMuted: !preparedAudioEnabled, retainAttachment: true, ...(deferRetirement ? { deferRetirement: true } : {}) } : preparedAudioEnabled ? { expectedMuted: false } : undefined);
      }
      if (promoted) {
        this.preparing = null; this.slots = this.slots.filter(slot => slot !== prepared);
        prepared.present(false); prepared.phase = "cancelled";
        delete promoted.dataset.mobilePreparation; promoted.style.visibility = "visible";
      }
    }
    // An ineligible selected preparation cannot become an independent bridge.
    // Keep a different neighbor only while paused, under the same decoder budget.
    if (!promoted && !cover && prepared) {
      if (prepared.postId === input.postId) this.clear(prepared);
      else prepared.pause("activation-priority");
    }
    const video = promoted ?? claimMobileFeedPlayer(input.host, input.token, input.src, input.postId, {
      position: input.position, snapshot, contentVersion: snapshot.contentVersion, warmEligible: false, reload: input.reload, boundedSeekRecovery: true,
    });
    this.acceptedPreparationSound = false;
    const activatedAt = performance.now();
    const recoverable = this.options?.retainAudiblePlayer === true;
    const pending = mobileFeedPlaybackReady(input.token);
    let awaitingSeek = !!pending;
    let alive = true, complete = false, accepted = false, playAttempted = false;
    let frame: number | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
    let motionTimer: ReturnType<typeof setTimeout> | undefined, sampleTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let intentionalPause = input.playingIntent === false, policyBlocked = false;
    let recovering = false, recoveryUsed = false;
    let lastMotionAt = activatedAt, submissionFloor = activatedAt, previousSubmission: number | null = null;
    // The bounded return seek owns its own deadline. Normal feed startup receives
    // its full frame budget only after that seek settles; lab timing stays explicit.
    let watchdogDeadline: number | null = intentionalPause || (recoverable && awaitingSeek) ? null : activatedAt + PLAYBACK_RECOVERY_MS;
    let epoch = 0, playEpoch = 0, playRequests = 0, callbacks = 0;
    let previous: number | null = null, previousCount: number | null = null;
    let intendedPosition = target, targetObserved = false;
    const collectFrameDiagnostics = feedTraceEnabled();
    let frameRequests = 0, frameDeliveries = 0, frameDiscards = 0, frameCancellations = 0;
    let frameRequestedAt: number | null = null;
    let lastFrameDiscardReason: string | null = null, lastFrameCancelReason: string | null = null;
    const quality = () => {
      try {
        const value = video.getVideoPlaybackQuality?.();
        return { totalVideoFrames: value?.totalVideoFrames ?? null, droppedVideoFrames: value?.droppedVideoFrames ?? null };
      } catch { return { totalVideoFrames: null, droppedVideoFrames: null }; }
    };
    const initialQuality = collectFrameDiagnostics ? quality() : null;
    const frameDiagnostics = (includeQuality = false): Record<string, string | number | boolean | null> => {
      if (!collectFrameDiagnostics) return {};
      const currentQuality = includeQuality ? quality() : null;
      return {
        frameRequestCount: frameRequests, frameDeliveryCount: frameDeliveries, frameDiscardCount: frameDiscards,
        frameCancellationCount: frameCancellations, lastFrameDiscardReason, lastFrameCancelReason,
        frameRequestPending: frame !== undefined, frameRequestHandle: frame ?? null,
        framePendingMs: frame !== undefined && frameRequestedAt !== null ? performance.now() - frameRequestedAt : null,
        frameEpoch: epoch,
        ...(currentQuality ? {
          totalVideoFrames: currentQuality.totalVideoFrames, droppedVideoFrames: currentQuality.droppedVideoFrames,
          totalVideoFramesDelta: currentQuality.totalVideoFrames !== null && initialQuality?.totalVideoFrames !== null && initialQuality?.totalVideoFrames !== undefined
            ? currentQuality.totalVideoFrames - initialQuality.totalVideoFrames : null,
          connected: video.isConnected, hidden: document.hidden, visibilityStyle: video.style.visibility,
          paused: video.paused, seeking: video.seeking, playingIntent: active.playing,
        } : {}),
      };
    };
    const current = () => alive && this.active?.token === input.token && ownsMobileFeedPlayer(input.token, video, input.src);
    const active: Activation = { token: input.token, postId: input.postId, src: input.src, video,
      playing: false, current, playRequested: () => {}, observeMainPlay: () => {}, stop: () => {} };
    this.active = active;
    const systemSuspended = () => document.hidden || insightPlaybackSuspended(video) || audioSessionSnapshot().audioSessionState === "interrupted";
    const blocked = () => intentionalPause || systemSuspended();
    const fail = (reason: string) => {
      if (!current()) return;
      recordFeedEvent("handoff-recovery", { result: "retry", mode: "prepared", reason, recoveryUsed }, video);
      this.cancelPreparation(); input.present(false); active.stop(); video.pause(); input.failed?.(reason);
    };
    const recover = (reason: string) => {
      if (!current() || blocked() || policyBlocked || awaitingSeek) return;
      if (recoveryUsed || !input.recover) return fail(reason);
      recoveryUsed = true; recovering = true; accepted = false;
      epoch++;
      if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); frame = undefined;
      clearTimeout(sampleTimer); sampleTimer = undefined;
      previous = previousCount = previousSubmission = null; targetObserved = false;
      intendedPosition = video.currentTime; submissionFloor = performance.now();
      watchdogDeadline = performance.now() + PLAYBACK_RECOVERY_MS;
      lastMotionAt = performance.now();
      clearTimeout(watchdog); watchdog = undefined;
      this.cancelPreparation();
      if (this.retainedCover) this.clear(this.retainedCover);
      input.present(false);
      recordFeedEvent("handoff-recovery", { result: "attempt", mode: "prepared", reason, attempt: 1 }, video);
      input.recover(reason);
      armWatchdog(); observe(); watchMotion();
    };
    const queueRecovery = (reason: string) => {
      if (!recoverable || !current() || blocked() || policyBlocked || recoveryTimer !== undefined) return;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (reason === "native-pause" && !video.paused) return;
        recover(reason);
      }, 100);
    };
    const watchMotion = () => {
      if (!recoverable || !current() || motionTimer !== undefined || intentionalPause) return;
      motionTimer = setTimeout(() => {
        motionTimer = undefined;
        if (!current()) return;
        if (blocked() || policyBlocked || awaitingSeek) lastMotionAt = performance.now();
        else if (complete && !recovering && performance.now() - lastMotionAt >= PLAYBACK_RECOVERY_MS) recover("playback-stall");
        else if (playAttempted && video.paused && !recovering) queueRecovery("native-pause");
        else armWatchdog();
        watchMotion();
      }, MOTION_SAMPLE_MS);
    };
    input.present(!!promoted || !!cover);
    recordFeedEvent("source-version", { contentVersion: snapshot.contentVersion, position: target, expiresAt: snapshot.expiresAt }, video);
    recordFeedEvent("prepared-player-selection", { result: cover ? "retained-main-with-cover" : promoted ? "promoted" : "cold-fallback", target, position: video.currentTime,
      warmEligible: !!promoted || !!cover, preparedSourceRetained: !!promoted || !!cover, outputMeasured: false,
      ...(this.preparedAudio ? { preparationAudio: promoted && preparedAudioEnabled ? "paused-unmuted" : "muted" } : {}),
      ...(retainAttachment ? { preparedAttachmentRetained: !!promoted || !!cover } : {}),
      ...(this.pausedPreparation ? { preparationPlayback: "paused-load" } : {}),
      ...(deferRetirement ? { retiredSourceCleanup: "after-startup", retiredSourcePending: preparedMobileFeedRetirementPending(input.token) } : {}),
      ...(activationRequestedAt === null ? {} : { activationRequestedAt, selectionElapsedMs: performance.now() - activationRequestedAt }) }, video);
    const armWatchdog = () => {
      if (!current() || (complete && !recovering) || watchdog !== undefined || document.hidden ||
          (recoverable ? blocked() || policyBlocked || awaitingSeek : video.paused)) return;
      watchdogDeadline ??= performance.now() + 3_000;
      watchdog = setTimeout(() => {
        watchdog = undefined;
        if (!current() || (complete && !recovering) || document.hidden ||
            (recoverable ? blocked() || policyBlocked || awaitingSeek : video.paused)) return;
        recordFeedEvent("handoff-timeout", { mode: "prepared", targetObserved, playAccepted: accepted, position: video.currentTime,
          readyState: video.readyState, buffer: playableBuffer(video), currentSourceMatches: video.currentSrc === video.src,
          ...frameDiagnostics(true) }, video);
        if (recoverable) recover(recovering ? "recovery-timeout" : "startup-timeout");
        else { input.present(false); video.pause(); active.stop(); input.failed?.("startup-timeout");
          recordFeedEvent("handoff-recovery", { result: "retry", mode: "prepared", reason: "startup-timeout" }, video); }
      }, Math.max(0, watchdogDeadline - performance.now()));
    };
    const observe = () => {
      if (!current() || (complete && !recoverable) || frame !== undefined || sampleTimer !== undefined || !video.requestVideoFrameCallback) return;
      const requestedEpoch = epoch;
      if (collectFrameDiagnostics) { frameRequests++; frameRequestedAt = performance.now(); }
      frame = video.requestVideoFrameCallback((callbackAt, metadata) => {
        if (collectFrameDiagnostics) frameDeliveries++;
        if (!current() || requestedEpoch !== epoch || (complete && !recoverable)) {
          if (collectFrameDiagnostics) {
            frameDiscards++;
            lastFrameDiscardReason = !current() ? "obsolete-owner" : requestedEpoch !== epoch ? "obsolete-epoch" : "complete";
          }
          return;
        }
        frame = undefined; callbacks++;
        frameRequestedAt = null;
        const now = performance.now(), submitted = submittedAt(metadata, now);
        // A late callback can still carry two genuinely advancing submissions
        // from this activation. Wall-clock delivery latency alone is not failure.
        const fresh = recoverable ? submitted >= submissionFloor && (previousSubmission === null || submitted >= previousSubmission)
          : now - submitted <= 100;
        if (fresh && !video.paused && !video.seeking && video.readyState >= 2 && video.currentSrc === video.src &&
            metadata.mediaTime >= intendedPosition - 0.1 && metadata.mediaTime <= intendedPosition + (now - activatedAt) / 1_000 + 0.25) targetObserved = true;
        const countAdvances = previousCount !== null && Number.isFinite(previousCount) && Number.isFinite(metadata.presentedFrames) && metadata.presentedFrames > previousCount;
        const valid = accepted && (recoverable || active.playing) && !document.hidden && fresh && countAdvances && targetObserved &&
          video.playbackRate === 1 && validFeedFrame(video, video.src, metadata.mediaTime, previous);
        if (feedTraceEnabled() && callbacks <= STARTUP_FRAME_SAMPLE_LIMIT) recordFeedEvent("lab-main-startup-frame", {
          callback: callbacks, callbackAt, deliveredAt: now, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
          presentationTime: Number.isFinite(metadata.presentationTime) ? metadata.presentationTime : null,
          expectedDisplayTime: Number.isFinite(metadata.expectedDisplayTime) ? metadata.expectedDisplayTime : null,
          processingDuration: typeof metadata.processingDuration === "number" && Number.isFinite(metadata.processingDuration) ? metadata.processingDuration : null,
          width: Number.isFinite(metadata.width) ? metadata.width : null, height: Number.isFinite(metadata.height) ? metadata.height : null,
          position: video.currentTime, target: intendedPosition, targetObserved, qualified: valid, submissionAgeMs: now - submittedAt(metadata, now),
          currentSourceMatches: video.currentSrc === video.src, playAccepted: accepted, muted: video.muted, ...audioSessionSnapshot(),
        }, video);
        if (valid) {
          lastMotionAt = now; active.playing = true;
          if (!complete || recovering) {
            complete = true; recovering = false; this.preparedActiveReady = true; clearTimeout(watchdog); watchdog = undefined;
            if (this.retainedCover) this.clear(this.retainedCover);
            input.ready();
            recordFeedEvent("presentation-handoff", { warmEligible: !!promoted || !!cover, reason: cover ? "retained-main" : promoted ? "prepared-player" : "main-only",
              independentBridge: false, activationMs: now - activatedAt, muted: video.muted, outputMeasured: false,
              ...(activationRequestedAt === null ? {} : { requestToHandoffMs: now - activationRequestedAt }) }, video);
            finishPreparedMobileFeedRetirement(input.token, "fresh-advancing-frame");
            this.resumePreparation();
          }
        }
        previous = fresh && !video.paused && !video.seeking && video.readyState >= 2 && video.currentSrc === video.src ? metadata.mediaTime : null;
        if (recoverable) {
          // Invalid/replayed deliveries cannot lower either watermark and make a
          // later replay appear new. Only a seek/recovery changes their epoch.
          if (fresh && Number.isFinite(metadata.presentedFrames) && (previousCount === null || metadata.presentedFrames >= previousCount)) previousCount = metadata.presentedFrames;
          if (fresh) previousSubmission = submitted;
        } else previousCount = fresh ? metadata.presentedFrames : null;
        if (recoverable && complete && !recovering) sampleTimer = setTimeout(() => { sampleTimer = undefined; observe(); }, MOTION_SAMPLE_MS);
        else observe();
      });
      if (collectFrameDiagnostics && frameRequests <= STARTUP_FRAME_SAMPLE_LIMIT) recordFeedEvent("lab-main-frame-request", {
        ...frameDiagnostics(), position: video.currentTime, paused: video.paused, playAccepted: accepted,
      }, video);
    };
    const seeking = () => {
      epoch++; previous = previousCount = null; intendedPosition = video.currentTime; targetObserved = false;
      previousSubmission = null; submissionFloor = performance.now(); lastMotionAt = performance.now();
      clearTimeout(sampleTimer); sampleTimer = undefined;
      if (collectFrameDiagnostics && frame !== undefined) { frameCancellations++; lastFrameCancelReason = "seeking"; }
      if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); frame = undefined; observe();
    };
    const pauseState = (resetDeadline = true, preserveAcceptance = false) => {
      // A known system/modal suspension does not revoke this owner's fulfilled
      // play request. Native resume may call video.play() outside the card helper.
      if (!preserveAcceptance) { playEpoch++; accepted = false; }
      active.playing = false; previous = previousCount = null;
      if (preserveAcceptance) {
        epoch++; submissionFloor = performance.now(); previousSubmission = null;
        if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); frame = undefined;
        clearTimeout(sampleTimer); sampleTimer = undefined;
      }
      finishPreparedMobileFeedRetirement(input.token, document.hidden ? "hidden" : "pause");
      this.acceptedPreparationSound = false; this.refreshPreparationSound();
      clearTimeout(watchdog); watchdog = undefined;
      clearTimeout(motionTimer); motionTimer = undefined;
      clearTimeout(recoveryTimer); recoveryTimer = undefined;
      if (resetDeadline) watchdogDeadline = null;
      this.preparing?.pause("main-paused");
    };
    const pause = () => {
      // A queued pause from the released source cannot extend the deadline while
      // awaiting a seek, or cancel playback that already resumed on this source.
      if (!video.paused) return;
      if (recoverable && current() && !blocked() && !policyBlocked && playAttempted) {
        active.playing = false; this.preparing?.pause("main-paused");
        queueRecovery("native-pause"); armWatchdog();
      } else {
        pauseState(playAttempted, recoverable && !intentionalPause && !policyBlocked && systemSuspended());
        if (recoverable && !intentionalPause) watchMotion();
      }
    };
    const play = () => { if (current()) { if (!video.paused) playAttempted = true; armWatchdog(); observe(); } };
    const progress = () => this.resumePreparation();
    const playing = () => { active.playing = true; progress(); watchMotion(); armWatchdog(); };
    const waiting = () => { active.playing = false; progress(); };
    active.playRequested = play;
    active.pauseRequested = () => { if (current()) { intentionalPause = true; pauseState(); } };
    const unsubscribePause = onMobileFeedPauseRequested(pausedVideo => {
      if (pausedVideo === video && current()) active.pauseRequested?.();
    });
    active.observeMainPlay = ({ requestedAt, returnedAt, request }) => {
      if (!current()) return;
      intentionalPause = false; policyBlocked = false;
      clearTimeout(recoveryTimer); recoveryTimer = undefined;
      lastMotionAt = performance.now();
      playAttempted = true;
      const requestEpoch = ++playEpoch, requestId = ++playRequests, requestedMuted = video.muted;
      accepted = false;
      this.acceptedPreparationSound = false; this.refreshPreparationSound();
      const sampled = feedTraceEnabled() && requestId <= NATIVE_PLAY_SAMPLE_LIMIT;
      if (sampled) recordFeedEvent("lab-main-play-returned", { requestId, activationMs: requestedAt - activatedAt, elapsedMs: returnedAt - requestedAt,
        position: video.currentTime, paused: video.paused, muted: requestedMuted, ...audioSessionSnapshot(), ...frameDiagnostics() }, video);
      void request?.then(() => {
        if (!current() || requestEpoch !== playEpoch) return;
        accepted = true; active.playing = !video.paused;
        this.acceptedPreparationSound = !requestedMuted && !video.muted && !video.paused;
        if (sampled) recordFeedEvent("lab-main-play-settled", { requestId, result: "resolved", muted: requestedMuted,
          elapsedMs: performance.now() - requestedAt, afterReturnMs: performance.now() - returnedAt, outputMeasured: false,
          ...frameDiagnostics() }, video);
        play(); progress(); watchMotion();
      }, (error: unknown) => {
        if (!current() || requestEpoch !== playEpoch) return;
        const errorName = playErrorName(error);
        policyBlocked = errorName === "NotAllowedError";
        recordFeedEvent("prepared-player-play-rejected", { requestId, errorName, muted: requestedMuted, warmEligible: !!promoted, outputMeasured: false }, video);
        finishPreparedMobileFeedRetirement(input.token, "play-rejected");
        if (recoverable && errorName === "AbortError") queueRecovery("play-interrupted");
        video.pause(); this.cancelPreparation();
      });
    };
    video.addEventListener("seeking", seeking); video.addEventListener("pause", pause); video.addEventListener("play", play);
    video.addEventListener("playing", playing); video.addEventListener("waiting", waiting);
    video.addEventListener("progress", progress); video.addEventListener("stalled", progress);
    active.stop = () => {
      alive = false; this.preparedActiveReady = false; epoch++; playEpoch++; clearTimeout(watchdog);
      unsubscribePause();
      clearTimeout(motionTimer); clearTimeout(sampleTimer); clearTimeout(recoveryTimer);
      this.deferredPreparation = null;
      if (this.retainedCover) this.clear(this.retainedCover);
      finishPreparedMobileFeedRetirement(input.token, "stop");
      if (collectFrameDiagnostics && frame !== undefined) { frameCancellations++; lastFrameCancelReason = "stop"; }
      if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
      video.removeEventListener("seeking", seeking); video.removeEventListener("pause", pause); video.removeEventListener("play", play);
      video.removeEventListener("playing", playing); video.removeEventListener("waiting", waiting);
      video.removeEventListener("progress", progress); video.removeEventListener("stalled", progress);
    };
    if (pending) void pending.then(() => {
      awaitingSeek = false;
      if (!current()) return;
      if (recoverable && !intentionalPause) watchdogDeadline = performance.now() + PLAYBACK_RECOVERY_MS;
      observe(); armWatchdog();
    }); else observe();
    recordFeedEvent("resource-count", { videoElements: this.slots.length + 1 + (preparedMobileFeedRetirementPending(input.token) ? 1 : 0), preparationDecoders: this.preparing ? 1 : 0, mode: "prepared" }, video);
    return video;
  }

  /** Shared-player ownership survives watchdog Retry; stopped activations may not play. */
  canPlay(token: symbol) {
    return this.active?.token === token && this.active.current();
  }
  /** The main play call updates paused before its queued play event arrives. */
  playRequested(token: symbol) {
    if (this.active?.token === token) this.active.playRequested();
  }
  /** Prepared mode only: distinguish user pause from a queued prior-source event. */
  pauseRequested(token: symbol) {
    if (this.active?.token === token) this.active.pauseRequested?.();
  }
  /** Observes the caller's existing native main play call, including acceptance. */
  observeMainPlay(token: symbol, timing: NativePlayTiming) {
    if (this.active?.token === token) this.active.observeMainPlay(timing);
  }
  soundChanged(token: symbol) {
    if (this.active?.token === token) this.refreshPreparationSound();
  }
  release(token: symbol, departure = true) {
    this.releaseOwned(token, departure, false);
  }
  /** Explicit Preview comparison; Retry, route exit and dispose use release(). */
  releaseForTransfer(token: symbol) {
    this.releaseOwned(token, true, true);
  }
  private releaseOwned(token: symbol, departure: boolean, deferParking: boolean) {
    if (this.active?.token !== token) return;
    const old = this.active; old.stop(); this.active = null;


    releaseMobileFeedPlayer(token, departure, { deferParking });
  }
  suspend() {
    this.active?.pauseRequested?.();
    this.cancelPreparation();


  }
  dispose() {
    if (this.active) this.release(this.active.token);
    this.slots.forEach(slot => this.clear(slot)); this.slots = []; this.preparing = null;
    this.unsubscribeExpiry?.(); this.unsubscribeExpiry = null;
  }
}
