import { claimMobileFeedPlayer, mobileFeedPlaybackReady, ownsMobileFeedPlayer, recentMobileFeedPosition, releaseMobileFeedPlayer } from "./mobileFeedPlayer";
import { playableBuffer, recordFeedEvent, validFeedFrame } from "./mobileFeedDiagnostics";

type Presentation = (ready: boolean) => void;
type Preparation = { postId: string; src: string; host: HTMLElement; present: Presentation };
type Slot = { video: HTMLVideoElement; generation: number; postId: string; src: string; target: number; ready: boolean; frameTime: number | null; frameCount: number | null; frameStep: number | null; stop: () => void; present: Presentation };
type Activation = { token: symbol; postId: string; src: string; video: HTMLVideoElement; bridge: Slot | null; stop: () => void };
const BUFFER_TARGET = 1;
const PREPARATION_BUDGET_MS = 2_500;

/** Owns preparation and presentation only. The audible element retains its WebKit grant. */
export class MobileFeedController {
  private slots: Slot[] = [];
  private active: Activation | null = null;
  private preparing: Slot | null = null;
  private sequence = 0;

  private clear(slot: Slot) {
    slot.generation = ++this.sequence;
    slot.stop(); slot.stop = () => {};
    slot.video.pause(); slot.video.muted = true;
    slot.video.style.visibility = "hidden";
    slot.present(false);
    slot.ready = false; slot.frameTime = slot.frameStep = slot.frameCount = null;
    slot.video.removeAttribute("src"); slot.video.load(); slot.video.remove();
    slot.postId = slot.src = "";
    if (this.preparing === slot) this.preparing = null;
  }
  private slot(): Slot {
    const available = this.slots.find(slot => slot !== this.active?.bridge && slot !== this.preparing);
    if (available) { this.clear(available); return available; }
    if (this.slots.length >= 2) throw new Error("Mobile preparation resource limit");
    const video = document.createElement("video");
    video.playsInline = true; video.loop = true; video.muted = true; video.preload = "auto";
    video.className = "absolute inset-0 h-full w-full object-cover pointer-events-none";
    video.style.visibility = "hidden";
    video.dataset.mobilePreparation = "true";
    const slot: Slot = { video, generation: ++this.sequence, postId: "", src: "", target: 0, ready: false, frameTime: null, frameCount: null, frameStep: null, stop: () => {}, present: () => {} };
    this.slots.push(slot); return slot;
  }
  prepare(input: Preparation) {
    if (document.hidden || this.active?.bridge || this.active?.postId === input.postId) return;
    if (this.preparing?.postId === input.postId && this.preparing.src === input.src) return;
    if (this.preparing) this.clear(this.preparing);
    const slot = this.slot(); this.preparing = slot;
    const video = slot.video;
    const generation = slot.generation;
    const current = () => slot.generation === generation && this.preparing === slot && !document.hidden;
    slot.postId = input.postId; slot.src = input.src; slot.present = input.present;
    slot.target = recentMobileFeedPosition(input.postId, input.src);
    input.host.appendChild(video);
    let frame: number | undefined;
    let frameValid = false;
    let positioned = false;
    let frameTarget = slot.target;
    const usable = () => {
      const remaining = Number.isFinite(video.duration) ? video.duration - frameTarget : BUFFER_TARGET;
      const buffer = playableBuffer(video, frameTarget);
      return frameValid && !video.seeking && remaining > 0 && buffer + 0.001 >= Math.min(BUFFER_TARGET, remaining);
    };
    const ready = () => {
      if (!current() || !usable() || slot.ready) return;
      slot.ready = true; video.pause(); video.style.visibility = "visible"; slot.present(true);
      recordFeedEvent("preparation-ready", { postId: slot.postId, position: frameTarget, buffer: playableBuffer(video, frameTarget), generation, bufferTarget: BUFFER_TARGET });
    };
    const observe = () => {
      if (!current() || !video.requestVideoFrameCallback) return;
      frame = video.requestVideoFrameCallback((_now, metadata) => {
        if (!current()) return;
        if (positioned && video.readyState >= 2 && !video.seeking && video.currentSrc === video.src && Math.abs(metadata.mediaTime - frameTarget) <= 0.1) {
          frameValid = true; slot.frameTime = metadata.mediaTime; slot.frameCount = metadata.presentedFrames; video.pause(); ready();
        } else observe();
      });
    };
    const seek = () => {
      if (!current()) return;
      frameTarget = Number.isFinite(video.duration) ? Math.min(slot.target, Math.max(0, video.duration - 0.01)) : slot.target;
      try { if (Math.abs(video.currentTime - frameTarget) > 0.01) video.currentTime = frameTarget; positioned = true; }
      catch { positioned = false; }
    };
    const error = () => { if (current()) { recordFeedEvent("preparation-miss", { postId: slot.postId, reason: "media-error", code: video.error?.code ?? null }); this.clear(slot); } };
    const timer = setTimeout(() => {
      if (current() && !slot.ready) { recordFeedEvent("preparation-miss", { postId: slot.postId, reason: "budget", buffer: playableBuffer(video, frameTarget) }); this.clear(slot); }
    }, PREPARATION_BUDGET_MS);
    slot.stop = () => { clearTimeout(timer); if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); video.removeEventListener("loadedmetadata", seek); video.removeEventListener("progress", ready); video.removeEventListener("error", error); };
    video.addEventListener("loadedmetadata", seek);
    video.addEventListener("progress", ready);
    video.addEventListener("error", error);
    recordFeedEvent("preparation-start", { postId: slot.postId, target: slot.target, generation });
    video.src = input.src;
    if (video.readyState >= 1) seek();
    observe();
    void video.play()?.catch(() => { if (current()) { recordFeedEvent("preparation-miss", { postId: slot.postId, reason: "play-blocked" }); this.clear(slot); } });
  }
  cancelPreparation(postId?: string) {
    if (this.preparing && (!postId || this.preparing.postId === postId)) this.clear(this.preparing);
  }

  activate(input: { postId: string; src: string; host: HTMLElement; previewHost: HTMLElement; token: symbol; present: Presentation; ready: () => void; position?: number; reload?: boolean }) {
    if (this.active) this.release(this.active.token);
    const target = input.position ?? recentMobileFeedPosition(input.postId, input.src);
    const prepared = this.preparing;
    const remaining = prepared && Number.isFinite(prepared.video.duration) ? prepared.video.duration - target : BUFFER_TARGET;
    const eligible = !!prepared && prepared.postId === input.postId && prepared.src === input.src && prepared.ready &&
      Math.abs(prepared.target - target) < 0.01 && remaining > 0 && playableBuffer(prepared.video, target) + 0.001 >= Math.min(BUFFER_TARGET, remaining);
    const bridge = eligible ? prepared : null;
    if (prepared && !bridge) this.clear(prepared);
    if (bridge) { bridge.stop(); bridge.stop = () => {}; this.preparing = null; bridge.present = input.present; input.previewHost.appendChild(bridge.video); }
    const video = claimMobileFeedPlayer(input.host, input.token, input.src, input.postId, { position: target, warmEligible: eligible, reload: input.reload });
    const activatedAt = performance.now();
    let alive = true;
    let frame: number | undefined;
    let bridgeFrame: number | undefined;
    let previousMain: number | null = null;
    let previousMainCount: number | null = null;
    let lastMain: number | null = null;
    let mainStep: number | null = null;
    let complete = false;
    let resyncAt = -Infinity;
    let epoch = 0;
    let intendedPosition = target;
    let targetObserved = false;
    let bridgeMoving = false;
    const current = () => alive && this.active?.token === input.token && ownsMobileFeedPlayer(input.token, video, input.src);
    const active: Activation = { token: input.token, postId: input.postId, src: input.src, video, bridge, stop: () => {} };
    this.active = active;
    input.present(!!bridge);
    const finish = () => {
      if (!current() || complete) return;
      complete = true;
      if (active.bridge) { const old = active.bridge; active.bridge = null; this.clear(old); }
      input.ready(); recordFeedEvent("presentation-handoff", { warmEligible: eligible, alignmentFrameSeconds: mainStep }, video);
    };
    const align = () => {
      if (!current() || document.hidden || video.seeking || video.paused || lastMain === null) return;
      if (!active.bridge) return finish();
      const preview = active.bridge;
      const frameStep = mainStep ?? preview.frameStep;
      if (preview.frameTime !== null && frameStep !== null && !preview.video.seeking && Math.abs(lastMain - preview.frameTime) <= frameStep + 0.001) return finish();
      if (performance.now() - resyncAt > 150 && !preview.video.seeking) {
        resyncAt = performance.now(); preview.frameTime = null;
        try { preview.video.currentTime = video.currentTime; } catch { /* Stay covered until valid alignment. */ }
        recordFeedEvent("bridge-align-seek", { target: video.currentTime }, video);
      }
    };
    const observeBridge = () => {
      const preview = active.bridge;
      if (!current() || !preview || !preview.video.requestVideoFrameCallback) return;
      const generation = preview.generation;
      bridgeFrame = preview.video.requestVideoFrameCallback((now, metadata) => {
        if (!current() || preview !== active.bridge || generation !== preview.generation) return;
        if (!preview.video.seeking && preview.video.readyState >= 2 && preview.video.currentSrc === preview.video.src) {
          const delta = preview.frameTime === null ? null : metadata.mediaTime - preview.frameTime;
          const count = preview.frameCount === null ? 0 : metadata.presentedFrames - preview.frameCount;
          if (delta !== null && delta > 0 && count > 0 && delta / count <= 1) preview.frameStep = Math.min(preview.frameStep ?? Infinity, delta / count);
          if (!bridgeMoving && delta !== null && delta > 0 && !preview.video.paused) {
            bridgeMoving = true;
            recordFeedEvent("moving-presentation", { activationMs: now - activatedAt, mediaTime: metadata.mediaTime, role: "muted-bridge", audioMeasured: false }, video);
          }
          preview.frameTime = metadata.mediaTime;
          preview.frameCount = metadata.presentedFrames;
          recordFeedEvent("bridge-frame", { mediaTime: metadata.mediaTime, muted: preview.video.muted }, video);
          align();
        }
        observeBridge();
      });
    };
    const observeMain = () => {
      if (!current() || complete || frame !== undefined || !video.requestVideoFrameCallback) return;
      const seekEpoch = epoch;
      frame = video.requestVideoFrameCallback((_now, metadata) => {
        if (!current() || seekEpoch !== epoch || complete) return;
        frame = undefined;
        if (!video.seeking && metadata.mediaTime >= intendedPosition - 0.1 && metadata.mediaTime <= intendedPosition + (performance.now() - activatedAt) / 1_000 + 0.25) targetObserved = true;
        if (targetObserved && validFeedFrame(video, video.src, metadata.mediaTime, previousMain)) {
          const delta = metadata.mediaTime - previousMain!;
          const count = previousMainCount === null ? 0 : metadata.presentedFrames - previousMainCount;
          if (delta > 0 && count > 0 && delta / count <= 1) mainStep = Math.min(mainStep ?? Infinity, delta / count);
          lastMain = metadata.mediaTime; align();
        }
        previousMain = !video.seeking && video.readyState >= 2 && video.currentSrc === video.src ? metadata.mediaTime : null;
        previousMainCount = metadata.presentedFrames;
        observeMain();
      });
    };
    const seeking = () => { epoch++; previousMain = lastMain = null; intendedPosition = video.currentTime; targetObserved = false; if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); frame = undefined; observeMain(); };
    const pause = () => { active.bridge?.video.pause(); previousMain = lastMain = null; };
    const play = () => {
      if (!current() || document.hidden) return;
      if (active.bridge) {
        active.bridge.video.style.visibility = "visible"; input.present(true);
        void active.bridge.video.play()?.catch(() => { if (current() && active.bridge) { recordFeedEvent("bridge-play-rejected", {}, video); input.present(false); active.bridge.video.style.visibility = "hidden"; } });
      }
    };
    // Browsers without frame callbacks retain ordinary playback, but never qualify as measured success.
    const unsupported = () => { if (!video.requestVideoFrameCallback && !video.seeking && video.readyState >= 2 && video.currentTime > target) { recordFeedEvent("presentation-unverified", {}, video); finish(); } };
    video.addEventListener("seeking", seeking); video.addEventListener("pause", pause); video.addEventListener("play", play); video.addEventListener("timeupdate", unsupported);
    const watchdog = setTimeout(() => { if (current() && !complete) recordFeedEvent("handoff-timeout", { position: video.currentTime, buffer: playableBuffer(video) }, video); }, 3_000);
    active.stop = () => { alive = false; epoch++; clearTimeout(watchdog); if (frame !== undefined) video.cancelVideoFrameCallback?.(frame); if (bridgeFrame !== undefined) bridge?.video.cancelVideoFrameCallback?.(bridgeFrame); video.removeEventListener("seeking", seeking); video.removeEventListener("pause", pause); video.removeEventListener("play", play); video.removeEventListener("timeupdate", unsupported); };
    if (bridge) { bridge.video.muted = true; bridge.video.style.visibility = "visible"; play(); observeBridge(); }
    const pending = mobileFeedPlaybackReady(input.token);
    if (pending) void pending.then(() => { if (current()) observeMain(); }); else observeMain();
    recordFeedEvent("resource-count", { videoElements: this.slots.length + 1, preparationDecoders: bridge ? 1 : 0 }, video);
    return video;
  }
  release(token: symbol) {
    if (this.active?.token !== token) return;
    const old = this.active; old.stop(); this.active = null;
    if (old.bridge) this.clear(old.bridge);
    releaseMobileFeedPlayer(token);
  }
  suspend() {
    this.cancelPreparation();
    if (this.active?.bridge) { this.active.bridge.video.pause(); this.active.bridge.video.style.visibility = "hidden"; this.active.bridge.present(false); }
  }
  dispose() {
    if (this.active) this.release(this.active.token);
    this.slots.forEach(slot => this.clear(slot)); this.slots = []; this.preparing = null;
  }
}
export const mobileFeedController = new MobileFeedController();
