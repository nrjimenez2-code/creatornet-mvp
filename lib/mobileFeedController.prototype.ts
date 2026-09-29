// PREVIEW LAB ONLY: bounded bridge-rate convergence; never imported by the normal feed.
import { claimMobileFeedPlayer, mobileFeedPlaybackReady, mobileFeedResumeSnapshot, onMobileResumeExpiry, ownsMobileFeedPlayer, sameMobileResume, releaseMobileFeedPlayer, type ResumeSnapshot } from "./mobileFeedPlayer";
import { feedTraceEnabled, playableBuffer, recordFeedEvent, validFeedFrame } from "./mobileFeedDiagnostics";

type Presentation = (ready: boolean) => void;
type Preparation = { postId: string; src: string; contentVersion?: string; host: HTMLElement; present: Presentation };
type PreparationPhase = "loading" | "acquiring-frame" | "ready" | "retrying" | "cancelled";
type Slot = { video: HTMLVideoElement; generation: number; postId: string; src: string; snapshot: ResumeSnapshot; phase: PreparationPhase; target: number; ready: boolean; frameTime: number | null; frameCount: number | null; frameStep: number | null; stop: () => void; pause: (reason?: string) => void; decode: () => void; onReady?: () => void; present: Presentation };
type Activation = { token: symbol; postId: string; src: string; video: HTMLVideoElement; playing: boolean; bridge: Slot | null; partial: Slot | null; current: () => boolean; playRequested: () => void; stop: () => void };
const BUFFER_TARGET = 1;
const PREPARATION_BUDGET_MS = 2_500;

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

/** Owns preparation and presentation only. The audible element retains its WebKit grant. */
export class MobileFeedController {
  private slots: Slot[] = [];
  private active: Activation | null = null;
  private preparing: Slot | null = null;
  private sequence = 0;
  private unsubscribeExpiry: (() => void) | null = null;
  private watchExpiry() {
    this.unsubscribeExpiry ??= onMobileResumeExpiry(snapshot => {
      for (const slot of this.slots) {
        if (slot !== this.active?.bridge && slot !== this.active?.partial && sameMobileResume(slot.snapshot, snapshot)) this.clear(slot);
      }
    });
  }

  private decodeAllowed() {
    const active = this.active;
    const remaining = active && Number.isFinite(active.video.duration) ? active.video.duration - active.video.currentTime : BUFFER_TARGET;
    return !document.hidden && !active?.bridge && (!active || (active.playing && !active.video.paused && !active.video.seeking && active.video.readyState >= 2 && remaining > 0 && playableBuffer(active.video) >= Math.min(BUFFER_TARGET, remaining)));
  }
  private resumePreparation() {
    const slot = this.active?.partial ?? this.preparing;
    if (this.decodeAllowed()) slot?.decode(); else slot?.pause("main-priority");
  }

  private clear(slot: Slot) {
    slot.generation = ++this.sequence;
    slot.stop(); slot.stop = () => {}; slot.decode = () => {}; slot.onReady = undefined; slot.phase = "cancelled";
    recordFeedEvent("preparation-state", { postId: slot.postId, phase: slot.phase });
    slot.pause("cancelled"); slot.video.muted = true;
    slot.video.style.visibility = "hidden";
    // Reset only after the obsolete bridge is paused and hidden. Reused slots
    // must never inherit a correction rate from the preceding activation.
    try { if (slot.video.playbackRate !== 1) slot.video.playbackRate = 1; } catch { /* Source removal below still bounds cleanup. */ }
    slot.present(false);
    slot.ready = false; slot.frameTime = slot.frameStep = slot.frameCount = null;
    slot.video.removeAttribute("src"); slot.video.load(); slot.video.remove();
    slot.postId = slot.src = "";
    if (this.preparing === slot) this.preparing = null;
    if (this.active?.partial === slot) this.active.partial = null;
  }
  private slot(): Slot {
    const available = this.slots.find(slot => slot !== this.active?.bridge && slot !== this.active?.partial && slot !== this.preparing);
    if (available) { this.clear(available); return available; }
    if (this.slots.length >= 2) throw new Error("Mobile preparation resource limit");
    const video = document.createElement("video");
    video.playsInline = true; video.loop = true; video.muted = true; video.preload = "auto";
    video.className = "absolute inset-0 h-full w-full object-cover pointer-events-none";
    video.style.visibility = "hidden";
    video.dataset.mobilePreparation = "true";
    const slot: Slot = { video, generation: ++this.sequence, postId: "", src: "", snapshot: mobileFeedResumeSnapshot("", ""), phase: "cancelled", target: 0, ready: false, frameTime: null, frameCount: null, frameStep: null, stop: () => {}, pause: () => video.pause(), decode: () => {}, present: () => {} };
    this.slots.push(slot); return slot;
  }
  prepare(input: Preparation) {
    this.watchExpiry();
    if (document.hidden || this.active?.postId === input.postId) return;
    const snapshot = mobileFeedResumeSnapshot(input.postId, input.contentVersion ?? input.src);
    if (this.preparing?.postId === input.postId && this.preparing.src === input.src && sameMobileResume(this.preparing.snapshot, snapshot)) return;
    if (this.preparing) this.clear(this.preparing);
    const slot = this.slot(); this.preparing = slot;
    const video = slot.video;
    const generation = slot.generation;
    const current = () => slot.generation === generation && (this.preparing === slot || this.active?.partial === slot) && !document.hidden;
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
      recordFeedEvent("preparation-state", { postId: slot.postId, phase: slot.phase, attempt });
      video.style.visibility = "visible";
      if (slot.onReady) slot.onReady(); else slot.present(true);
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
      const requestedEpoch = playEpoch;
      const requestedAttempt = attemptEpoch;
      if (collectDiagnostics) playRequestCount++;
      void video.play()?.then(() => {
        if (collectDiagnostics && current() && requestedAttempt === attemptEpoch) playResolvedCount++;
      }, (reason: unknown) => {
        const errorName = reason && typeof reason === "object" && "name" in reason && typeof reason.name === "string" ? reason.name : "unknown";
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
      observe(); play();
    };
    slot.stop = () => { playEpoch++; clearTimeout(timer); clearTimeout(retryTimer); cancelFrame(); video.removeEventListener("loadedmetadata", seek); video.removeEventListener("seeked", seeked); video.removeEventListener("progress", progress); video.removeEventListener("error", error); };
    video.addEventListener("loadedmetadata", seek); video.addEventListener("seeked", seeked);
    video.addEventListener("progress", progress); video.addEventListener("error", error);
    recordFeedEvent("preparation-start", { postId: slot.postId, target: slot.target, generation, phase: slot.phase, contentVersion: snapshot.contentVersion, expiresAt: snapshot.expiresAt });
    video.src = input.src;
    video.load(); slot.decode();
  }
  cancelPreparation(postId?: string) {
    if (this.preparing && (!postId || this.preparing.postId === postId)) this.clear(this.preparing);
  }

  activate(input: { postId: string; src: string; contentVersion?: string; host: HTMLElement; previewHost: HTMLElement; token: symbol; present: Presentation; ready: () => void; failed?: () => void; position?: number; reload?: boolean }) {
    this.watchExpiry();
    if (this.active) this.release(this.active.token);
    const snapshot = mobileFeedResumeSnapshot(input.postId, input.contentVersion ?? input.src);
    const target = input.position ?? snapshot.position;
    const prepared = this.preparing;
    const remaining = prepared && Number.isFinite(prepared.video.duration) ? prepared.video.duration - target : BUFFER_TARGET;
    const eligible = !!prepared && prepared.postId === input.postId && prepared.src === input.src && prepared.ready &&
      sameMobileResume(prepared.snapshot, snapshot) && Math.abs(prepared.target - target) < 0.01 && remaining > 0 && preparationBuffer(prepared.video, target) + 0.001 >= Math.min(BUFFER_TARGET, remaining);
    const bridge = eligible ? prepared : null;
    const partial = prepared && !eligible && prepared.postId === input.postId && prepared.src === input.src && sameMobileResume(prepared.snapshot, snapshot) && Math.abs(prepared.target - target) < 0.01 && !input.reload ? prepared : null;
    if (prepared && !bridge && !partial) {
      if (prepared.postId === input.postId) this.clear(prepared);
      else {
        // This is still the selected neighbor. Another card can finish resolving
        // after its preparation effect ran; selection changes own cancellation.
        prepared.pause("activation-priority");
        recordFeedEvent("preparation-retained", { postId: prepared.postId, activatedPostId: input.postId, phase: prepared.phase, position: prepared.target });
      }
    }
    if (partial) { partial.pause("selected-partial"); partial.video.style.visibility = "hidden"; partial.present(false); this.preparing = null; input.previewHost.appendChild(partial.video); }
    if (bridge) { bridge.stop(); bridge.stop = () => {}; this.preparing = null; bridge.present = input.present; input.previewHost.appendChild(bridge.video); }
    const video = claimMobileFeedPlayer(input.host, input.token, input.src, input.postId, { position: input.position, snapshot, contentVersion: snapshot.contentVersion, warmEligible: eligible, reload: input.reload, boundedSeekRecovery: true });
    recordFeedEvent("source-version", { contentVersion: snapshot.contentVersion, position: target, expiresAt: snapshot.expiresAt }, video);
    const activatedAt = performance.now();
    let alive = true;
    let frame: number | undefined;
    let bridgeFrame: number | undefined;
    let previousMain: number | null = null;
    let previousMainCount: number | null = null;
    let lastMain: number | null = null;
    let lastMainAt = -Infinity;
    let mainStep: number | null = null;
    let complete = false;
    let resyncAt = -Infinity;
    let bridgeSeekEpoch = 0;
    let bridgeSeekTarget: number | null = null;
    let epoch = 0;
    let intendedPosition = target;
    let targetObserved = false;
    let bridgeMoving = false;
    let lastBridgeAt = -Infinity;
    let rateAttempted = false;
    const restoreBridgeRate = () => {
      const preview = active.bridge;
      try { if (preview && preview.video.playbackRate !== 1) preview.video.playbackRate = 1; } catch { /* Cleanup/watchdog remains bounded. */ }
    };
    const collectFrameDiagnostics = feedTraceEnabled();
    const qualityAtActivation = collectFrameDiagnostics ? video.getVideoPlaybackQuality?.() : null;
    let mainRequestCount = 0;
    let mainCallbackCount = 0;
    let mainValidCount = 0;
    let firstMainReject: string | null = null;
    let lastMainReject: string | null = null;
    let firstMainRequestAt: number | null = null;
    let firstMainCallbackAt: number | null = null;
    let firstMainValidAt: number | null = null;
    let lastMainCallbackAt: number | null = null;
    let lastMainMediaTime: number | null = null;
    let lastMainPresentedFrames: number | null = null;
    const current = () => alive && this.active?.token === input.token && ownsMobileFeedPlayer(input.token, video, input.src);
    const active: Activation = { token: input.token, postId: input.postId, src: input.src, video, playing: false, bridge, partial, current, playRequested: () => {}, stop: () => {} };
    this.active = active;
    input.present(!!bridge);
    const finish = () => {
      if (!current() || complete) return;
      complete = true;
      if (active.bridge) { const old = active.bridge; if (bridgeFrame !== undefined) old.video.cancelVideoFrameCallback?.(bridgeFrame); bridgeFrame = undefined; active.bridge = null; this.clear(old); }
      if (active.partial) this.clear(active.partial);
      if (collectFrameDiagnostics) {
        const qualityAtHandoff = video.getVideoPlaybackQuality?.();
        recordFeedEvent("handoff-frame-diagnostic", {
          mainRequestCount, mainCallbackCount, mainValidCount, firstMainReject, lastMainReject,
          firstMainRequestMs: firstMainRequestAt === null ? null : firstMainRequestAt - activatedAt,
          firstMainCallbackMs: firstMainCallbackAt === null ? null : firstMainCallbackAt - activatedAt,
          firstMainValidMs: firstMainValidAt === null ? null : firstMainValidAt - activatedAt,
          lastMainCallbackAgeMs: lastMainCallbackAt === null ? null : performance.now() - lastMainCallbackAt,
          targetObserved, totalFramesDelta: qualityAtHandoff && qualityAtActivation ? qualityAtHandoff.totalVideoFrames - qualityAtActivation.totalVideoFrames : null,
          droppedFramesDelta: qualityAtHandoff && qualityAtActivation ? qualityAtHandoff.droppedVideoFrames - qualityAtActivation.droppedVideoFrames : null,
        }, video);
      }
      input.ready(); recordFeedEvent("presentation-handoff", { warmEligible: eligible, alignmentFrameSeconds: mainStep }, video);
      this.resumePreparation();
    };
    const align = () => {
      if (!current() || document.hidden || video.seeking || video.paused || lastMain === null) return;
      if (!active.bridge) return finish();
      const now = performance.now();
      const preview = active.bridge;
      const frameStep = mainStep ?? preview.frameStep;
      if (preview.frameTime === null || frameStep === null || preview.video.seeking) return;
      // The projection can choose a direction or reject apparent alignment;
      // it can never authorize handoff without aligned actual frames.
      // Two freshly sampled actual frames still have to meet the original
      // alignment tolerance. Sparse or differently aged samples cannot start a correction.
      const mainAgeMs = now - lastMainAt, bridgeAgeMs = now - lastBridgeAt;
      const fresh = mainAgeMs <= 100 && bridgeAgeMs <= 100;
      const rawError = preview.frameTime - lastMain;
      const tolerance = frameStep + 0.001;
      const projectedError = rawError + bridgeAgeMs / 1_000 * preview.video.playbackRate - mainAgeMs / 1_000 * video.playbackRate;
      // A delayed callback is not proof that buffered playback stopped. Keep
      // an admitted fixed correction, but reject handoff until evidence is fresh.
      if (!fresh) return;
      if (!active.playing || video.playbackRate !== 1) {
        if (rateAttempted) restoreBridgeRate();
        return;
      }
      // Unequal sample ages may make old submitted frames look aligned while
      // their timelines have already diverged. Projection can reject this,
      // but cannot authorize a handoff without actual aligned frame evidence.
      if (Math.abs(rawError) <= tolerance && Math.abs(projectedError) <= tolerance) return finish();
      if (rateAttempted || !bridgeMoving || preview.video.paused || preview.video.playbackRate !== 1) return;
      if (!Number.isFinite(projectedError) || Math.sign(projectedError) !== Math.sign(rawError) || Math.abs(projectedError) <= 2 * tolerance) return;
      // One fixed rate per activation, with an unchanged 3 s watchdog. Reserve
      // 250 ms for scheduling; ideal convergence is not a physical guarantee.
      const remainingSeconds = (3_000 - (now - activatedAt)) / 1_000;
      const requiredSeconds = Math.max(0, Math.max(Math.abs(rawError), Math.abs(projectedError)) - tolerance) / 0.25;
      rateAttempted = true;
      if (requiredSeconds > remainingSeconds - 0.25) {
        recordFeedEvent("bridge-rate-prototype", { result: "insufficient-budget", rawError, projectedError, requiredSeconds, remainingSeconds }, video);
        return;
      }
      const rate = projectedError > 0 ? 0.75 : 1.25;
      try {
        preview.video.playbackRate = rate;
        recordFeedEvent("bridge-rate-prototype", { result: preview.video.playbackRate === rate ? "applied" : "ignored", rate, rawError, projectedError, requiredSeconds, remainingSeconds }, video);
      } catch {
        recordFeedEvent("bridge-rate-prototype", { result: "unsupported", rate, rawError, projectedError, requiredSeconds, remainingSeconds }, video);
      }
      // Unsupported, ignored, non-converging, and late corrections use the
      // existing bounded watchdog. This prototype never starts alignment seeks.
    };
    const observeBridge = () => {
      const preview = active.bridge;
      if (!current() || !preview || bridgeFrame !== undefined || !preview.video.requestVideoFrameCallback) return;
      const generation = preview.generation;
      const seekEpoch = bridgeSeekEpoch;
      bridgeFrame = preview.video.requestVideoFrameCallback((now, metadata) => {
        if (!current() || preview !== active.bridge || generation !== preview.generation || seekEpoch !== bridgeSeekEpoch) return;
        bridgeFrame = undefined;
        const alignmentFrame = bridgeSeekTarget === null || (metadata.mediaTime >= bridgeSeekTarget - 0.1 && metadata.mediaTime <= bridgeSeekTarget + (now - resyncAt) / 1_000 + 0.25);
        if (alignmentFrame && !preview.video.seeking && preview.video.readyState >= 2 && preview.video.currentSrc === preview.video.src && Math.abs(preview.video.currentTime - metadata.mediaTime) <= 0.25) {
          if (bridgeSeekTarget !== null) {
            recordFeedEvent("bridge-align-frame", { target: bridgeSeekTarget, mediaTime: metadata.mediaTime, seekMs: now - resyncAt }, video);
            bridgeSeekTarget = null;
          }
          const delta = preview.frameTime === null ? null : metadata.mediaTime - preview.frameTime;
          const count = preview.frameCount === null ? 0 : metadata.presentedFrames - preview.frameCount;
          if (delta !== null && delta > 0 && count > 0 && delta / count <= 1) preview.frameStep = Math.min(preview.frameStep ?? Infinity, delta / count);
          if (!bridgeMoving && delta !== null && delta > 0 && !preview.video.paused) {
            bridgeMoving = true;
            recordFeedEvent("moving-presentation", { activationMs: now - activatedAt, mediaTime: metadata.mediaTime, role: "muted-bridge", audioMeasured: false }, video);
          }
          preview.frameTime = metadata.mediaTime;
          preview.frameCount = metadata.presentedFrames;
          lastBridgeAt = now;
          recordFeedEvent("bridge-frame", { mediaTime: metadata.mediaTime, muted: preview.video.muted }, video);
          align();
        }
        observeBridge();
      });
    };
    const observeMain = () => {
      if (!current() || complete || frame !== undefined || !video.requestVideoFrameCallback) return;
      const seekEpoch = epoch;
      if (collectFrameDiagnostics) { mainRequestCount++; firstMainRequestAt ??= performance.now(); }
      frame = video.requestVideoFrameCallback((_now, metadata) => {
        if (!current() || seekEpoch !== epoch || complete) return;
        frame = undefined;
        if (collectFrameDiagnostics) {
          mainCallbackCount++;
          lastMainCallbackAt = performance.now();
          firstMainCallbackAt ??= lastMainCallbackAt;
          lastMainMediaTime = metadata.mediaTime;
          lastMainPresentedFrames = metadata.presentedFrames;
        }
        if (!video.seeking && metadata.mediaTime >= intendedPosition - 0.1 && metadata.mediaTime <= intendedPosition + (performance.now() - activatedAt) / 1_000 + 0.25) targetObserved = true;
        const valid = targetObserved && validFeedFrame(video, video.src, metadata.mediaTime, previousMain);
        if (valid) {
          if (collectFrameDiagnostics) { mainValidCount++; firstMainValidAt ??= performance.now(); }
          const delta = metadata.mediaTime - previousMain!;
          const count = previousMainCount === null ? 0 : metadata.presentedFrames - previousMainCount;
          if (delta > 0 && count > 0 && delta / count <= 1) mainStep = Math.min(mainStep ?? Infinity, delta / count);
          lastMain = metadata.mediaTime; lastMainAt = performance.now(); align();
        } else if (collectFrameDiagnostics) {
          const reason = !targetObserved ? "target-not-observed" : video.readyState < 2 ? "ready-state" : video.seeking ? "seeking"
            : video.paused ? "paused" : video.currentSrc !== video.src ? "current-source-mismatch"
              : !Number.isFinite(metadata.mediaTime) ? "invalid-media-time" : Math.abs(video.currentTime - metadata.mediaTime) > 0.25 ? "position-drift"
                : previousMain === null ? "first-frame" : metadata.mediaTime <= previousMain + 0.0001 ? "nonadvancing" : "other";
          firstMainReject ??= reason;
          lastMainReject = reason;
        }
        previousMain = !video.seeking && video.readyState >= 2 && video.currentSrc === video.src ? metadata.mediaTime : null;
        previousMainCount = metadata.presentedFrames;
        observeMain();
      });
    };
    const seeking = () => { epoch++; previousMain = lastMain = null; intendedPosition = video.currentTime; targetObserved = false; restoreBridgeRate(); if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); frame = undefined; observeMain(); };
    const pause = () => { active.playing = false; active.bridge?.video.pause(); restoreBridgeRate(); active.partial?.pause("main-paused"); this.preparing?.pause("main-paused"); previousMain = lastMain = null; };
    const play = () => {
      if (!current() || document.hidden || video.paused) return;
      if (active.bridge) {
        active.bridge.video.style.visibility = "visible"; input.present(true);
        if (active.bridge.video.paused) void active.bridge.video.play()?.catch(() => { if (current() && active.bridge) { recordFeedEvent("bridge-play-rejected", {}, video); input.present(false); active.bridge.video.style.visibility = "hidden"; } });
      }
      this.resumePreparation();
    };
    active.playRequested = play;
    if (partial) partial.onReady = () => {
      if (!current() || complete || active.partial !== partial) return;
      active.partial = null; active.bridge = partial; partial.present = input.present;
      partial.video.muted = true; input.present(true); play(); observeBridge();
      recordFeedEvent("preparation-recovery", { postId: input.postId, warmEligible: false, position: target }, video);
    };
    // Browsers without frame callbacks retain ordinary playback, but never qualify as measured success.
    const unsupported = () => { if (!video.requestVideoFrameCallback && !video.seeking && video.readyState >= 2 && video.currentTime > target) { recordFeedEvent("presentation-unverified", {}, video); finish(); } };
    video.addEventListener("seeking", seeking); video.addEventListener("pause", pause); video.addEventListener("play", play); video.addEventListener("timeupdate", unsupported);
    const progress = () => this.resumePreparation();
    const playing = () => { active.playing = true; progress(); };
    const waiting = () => { active.playing = false; restoreBridgeRate(); progress(); };
    // A stalled fetch can coexist with healthy buffered playback. Recheck the
    // buffer budget without waiting for a playing event that may never repeat.
    video.addEventListener("progress", progress); video.addEventListener("playing", playing); video.addEventListener("waiting", waiting); video.addEventListener("stalled", progress);
    const watchdog = setTimeout(() => {
      if (!current() || complete) return;
      const qualityAtTimeout = collectFrameDiagnostics ? video.getVideoPlaybackQuality?.() : null;
      recordFeedEvent("handoff-timeout", {
        position: video.currentTime, buffer: playableBuffer(video), mainRequestCount, mainCallbackCount, mainValidCount,
        firstMainRequestMs: firstMainRequestAt === null ? null : firstMainRequestAt - activatedAt,
        firstMainCallbackMs: firstMainCallbackAt === null ? null : firstMainCallbackAt - activatedAt,
        firstMainValidMs: firstMainValidAt === null ? null : firstMainValidAt - activatedAt,
        firstMainReject, lastMainReject, lastMainCallbackAgeMs: lastMainCallbackAt === null ? null : performance.now() - lastMainCallbackAt,
        lastMainMediaTime, lastMainPresentedFrames, targetObserved, frameRequestPending: frame !== undefined,
        readyState: video.readyState, paused: video.paused, seeking: video.seeking, hidden: document.hidden,
        currentSourceMatches: video.currentSrc === video.src, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
        totalFramesDelta: qualityAtTimeout && qualityAtActivation ? qualityAtTimeout.totalVideoFrames - qualityAtActivation.totalVideoFrames : null,
        droppedFramesDelta: qualityAtTimeout && qualityAtActivation ? qualityAtTimeout.droppedVideoFrames - qualityAtActivation.droppedVideoFrames : null,
      }, video);
      if (targetObserved && lastMain !== null && performance.now() - lastMainAt <= 250 && !video.paused && !video.seeking && video.readyState >= 2) { finish(); recordFeedEvent("handoff-recovery", { result: "moving-main" }, video); }
      else {
        if (active.bridge) { const old = active.bridge; if (bridgeFrame !== undefined) old.video.cancelVideoFrameCallback?.(bridgeFrame); bridgeFrame = undefined; active.bridge = null; this.clear(old); }
        if (active.partial) this.clear(active.partial);
        input.present(false); video.pause(); active.stop(); input.failed?.();
        recordFeedEvent("handoff-recovery", { result: "retry" }, video);
      }
    }, 3_000);
    active.stop = () => { alive = false; epoch++; bridgeSeekEpoch++; bridgeSeekTarget = null; clearTimeout(watchdog); if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); if (bridgeFrame !== undefined) active.bridge?.video.cancelVideoFrameCallback?.(bridgeFrame); video.removeEventListener("seeking", seeking); video.removeEventListener("pause", pause); video.removeEventListener("play", play); video.removeEventListener("timeupdate", unsupported); video.removeEventListener("progress", progress); video.removeEventListener("playing", playing); video.removeEventListener("waiting", waiting); video.removeEventListener("stalled", progress); };
    if (bridge) { bridge.video.muted = true; bridge.video.style.visibility = "visible"; play(); observeBridge(); }
    const pending = mobileFeedPlaybackReady(input.token);
    if (pending) void pending.then(() => { if (current()) observeMain(); }); else observeMain();
    recordFeedEvent("resource-count", { videoElements: this.slots.length + 1, preparationDecoders: bridge ? 1 : 0 }, video);
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
  release(token: symbol, departure = true) {
    if (this.active?.token !== token) return;
    const old = this.active; old.stop(); this.active = null;
    if (old.bridge) this.clear(old.bridge);
    if (old.partial) this.clear(old.partial);
    releaseMobileFeedPlayer(token, departure);
  }
  suspend() {
    this.cancelPreparation();
    if (this.active?.bridge) { const old = this.active.bridge; this.active.bridge = null; this.clear(old); }
    if (this.active?.partial) this.clear(this.active.partial);
  }
  dispose() {
    if (this.active) this.release(this.active.token);
    this.slots.forEach(slot => this.clear(slot)); this.slots = []; this.preparing = null;
    this.unsubscribeExpiry?.(); this.unsubscribeExpiry = null;
  }
}
export const mobileFeedController = new MobileFeedController();
