/**
 * The main phone feed keeps one media element for audible playback. WebKit's
 * autoplay grant belongs to the element, so replacing it for each post or
 * after a route change can ask for the same sound gesture again.
 *
 * This module owns the element and two short-lived playback positions. Feed
 * cards own their presentation, listeners and muted previews. Desktop never calls it.
 * The closed Preview format lab alone can adopt a prepared element explicitly;
 * normal feed claims preserve the shared element and its grant.
 */
import { beginFeedVideoTrace, endFeedVideoTrace, feedTraceEnabled, playableBuffer, recordFeedEvent } from "./mobileFeedDiagnostics";

let player: HTMLVideoElement | null = null;
let parkingPlace: HTMLDivElement | null = null;
let owner: symbol | null = null;
let currentPostId: string | null = null;
let currentContentVersion = "";
let managedResume = true;
let parkedSnapshot: ResumeSnapshot | null = null;
let pendingParking: { video: HTMLVideoElement; postId: string | null } | null = null;

const RESUME_WINDOW_MS = 5_000;
const MAX_RECENT_POSITIONS = 2;
export type ResumeSnapshot = Readonly<{ postId: string; contentVersion: string; position: number; expiresAt: number | null }>;
const recentPositions = new Map<string, ResumeSnapshot>();
const managedPositions = new WeakSet<ResumeSnapshot>();
const expiryListeners = new Set<(snapshot: ResumeSnapshot) => void>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSeek: { token: symbol; promise: Promise<void>; cancel: () => void; recoveryTarget: () => number | null } | null = null;
let seekOutcome: { token: symbol; failed: boolean; recoveryTarget: number | null } | null = null;

function retainedPosition(): number {
  // Retry must keep an unfinished candidate return's intended position, not
  // the wrong position the media element reported before timing out.
  const target = pendingSeek?.token === owner ? pendingSeek.recoveryTarget()
    : seekOutcome?.token === owner && seekOutcome.failed ? seekOutcome.recoveryTarget : null;
  return target ?? player!.currentTime;
}

function rememberPosition(): void {
  if (!player || !currentPostId) return;
  const time = retainedPosition();
  if (!Number.isFinite(time) || time < 0) return;
  expirePositions();
  recentPositions.delete(currentPostId);
  parkedSnapshot = Object.freeze({ postId: currentPostId, contentVersion: currentContentVersion, position: time, expiresAt: Date.now() + RESUME_WINDOW_MS });
  if (managedResume) managedPositions.add(parkedSnapshot);
  recentPositions.set(currentPostId, parkedSnapshot);
  recordFeedEvent("resume-departure", { postId: currentPostId, contentVersion: currentContentVersion, position: time, expiresAt: parkedSnapshot.expiresAt });
  while (recentPositions.size > MAX_RECENT_POSITIONS) discardPosition(recentPositions.values().next().value!, "evicted");
  scheduleExpiry();
}

function discardPosition(snapshot: ResumeSnapshot, reason: string) {
  recentPositions.delete(snapshot.postId);
  recordFeedEvent("resume-expiry", { postId: snapshot.postId, contentVersion: snapshot.contentVersion, reason, expiresAt: snapshot.expiresAt });
  // Expiry of another post must never seek or clear the actively watched player.
  if (!owner && parkedSnapshot === snapshot && managedPositions.has(snapshot) && player) {
    player.pause(); player.removeAttribute("src"); player.load(); parkedSnapshot = null;
  }
  expiryListeners.forEach(listener => listener(snapshot));
}
function expirePositions() {
  for (const snapshot of recentPositions.values()) {
    if (snapshot.expiresAt !== null && Date.now() >= snapshot.expiresAt + (managedPositions.has(snapshot) ? 0 : 1)) discardPosition(snapshot, "deadline");
  }
}
function scheduleExpiry() {
  clearTimeout(expiryTimer); expiryTimer = undefined;
  const deadline = Math.min(...Array.from(recentPositions.values(), value => value.expiresAt === null ? Infinity : value.expiresAt + (managedPositions.has(value) ? 0 : 1)));
  if (Number.isFinite(deadline)) expiryTimer = setTimeout(() => { expirePositions(); scheduleExpiry(); }, Math.max(0, deadline - Date.now()));
}
export function onMobileResumeExpiry(listener: (snapshot: ResumeSnapshot) => void): () => void {
  expiryListeners.add(listener); return () => { expiryListeners.delete(listener); };
}
/** Non-consuming reads and retries cannot extend the departure deadline. */
export function mobileFeedResumeSnapshot(postId: string, contentVersion: string, strictDeadline = false): ResumeSnapshot {
  expirePositions();
  // Preview promotion also enforces the exact boundary on a departure saved by
  // conventional playback. Preserve conventional callers' existing deadline.
  const departing = recentPositions.get(postId);
  if (strictDeadline && departing && departing.expiresAt !== null && Date.now() >= departing.expiresAt) {
    discardPosition(departing, "deadline"); scheduleExpiry();
  }
  const saved = recentPositions.get(postId);
  if (saved && saved.contentVersion !== contentVersion) { discardPosition(saved, "content-replaced"); scheduleExpiry(); }
  if (!owner && parkedSnapshot?.expiresAt === null && parkedSnapshot.postId === postId && parkedSnapshot.contentVersion === contentVersion) return parkedSnapshot;
  return saved?.contentVersion === contentVersion ? saved : Object.freeze({ postId, contentVersion, position: 0, expiresAt: null });
}
export function sameMobileResume(a: ResumeSnapshot, b: ResumeSnapshot): boolean {
  return a.postId === b.postId && a.contentVersion === b.contentVersion && a.position === b.position && a.expiresAt === b.expiresAt;
}

/** Non-consuming read lets preparation use exactly the active player's return policy. */
export function recentMobileFeedPosition(postId: string, src: string): number {
  return mobileFeedResumeSnapshot(postId, src).position;
}

export function ownsMobileFeedPlayer(token: symbol, video: HTMLVideoElement, src?: string): boolean {
  return owner === token && player === video && (src === undefined || video.getAttribute("src") === src);
}

function cancelPendingSeek(): void {
  if (pendingSeek && player) recordFeedEvent("resume-seek-cancel", {}, player);
  pendingSeek?.cancel();
  pendingSeek = null;
}

function seekBeforePlayback(video: HTMLVideoElement, token: symbol, time: number, recover = false): void {
  recordFeedEvent("resume-seek-request", { target: time }, video);
  let settle!: () => void;
  const promise = new Promise<void>(resolve => { settle = resolve; });
  let done = false;
  let target = time;
  let started = false;
  let mismatched = false;
  let corrected = false;
  const finish = (failed = false) => {
    if (done) return;
    done = true;
    video.removeEventListener("loadedmetadata", seek);
    video.removeEventListener("seeked", seeked);
    video.removeEventListener("loadeddata", correct);
    video.removeEventListener("canplay", correct);
    video.removeEventListener("error", failedSeek);
    clearTimeout(timer);
    if (pendingSeek?.token === token) pendingSeek = null;
    if (owner === token) seekOutcome = { token, failed, recoveryTarget: recover ? target : null };
    settle();
  };
  const failedSeek = () => finish(true);
  const correct = () => {
    if (!recover || done || owner !== token || !started || !mismatched || corrected || video.seeking || video.readyState < 2 || video.currentSrc !== video.src) return;
    // A completed seek can report the wrong position while the source loads.
    // Correct it once after current-frame data arrives, within the same timer.
    corrected = true;
    recordFeedEvent("resume-seek-correction", { target, position: video.currentTime }, video);
    try { video.currentTime = target; } catch { failedSeek(); }
  };
  const seeked = () => {
    if (done || owner !== token || video.seeking || video.currentSrc !== video.src) return;
    if (Math.abs(video.currentTime - target) > 0.05) { mismatched = true; correct(); return; }
    finish();
  };
  const timer = setTimeout(() => { recordFeedEvent("resume-seek-timeout", { target: time }, video); failedSeek(); }, 2_000);
  const seek = () => {
    if (owner !== token || done) return failedSeek();
    if (video.currentSrc !== video.src) return;
    if (recover && started) return;
    try {
      target = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(time, Math.max(0, video.duration - 0.01)) : time;
      if (Math.abs(video.currentTime - target) < 0.05) return finish();
      started = true;
      video.currentTime = target;
    } catch { failedSeek(); }
  };
  pendingSeek = { token, promise, cancel: failedSeek, recoveryTarget: () => recover ? target : null };
  video.addEventListener("loadedmetadata", seek);
  video.addEventListener("seeked", seeked);
  video.addEventListener("loadeddata", correct);
  video.addEventListener("canplay", correct);
  video.addEventListener("error", failedSeek);
  // A bad stream must never leave the card unable to attempt playback.
  if (video.readyState >= 1) seek();
}

/** The active card waits for a short return seek before starting playback. */
export function mobileFeedPlaybackReady(token: symbol): Promise<void> | null {
  return pendingSeek?.token === token ? pendingSeek.promise : null;
}
export function mobileFeedSeekFailed(token: symbol): boolean { return seekOutcome?.token === token && seekOutcome.failed; }

function getParkingPlace(): HTMLDivElement {
  if (!parkingPlace || !parkingPlace.isConnected) {
    parkingPlace = document.createElement("div");
    parkingPlace.setAttribute("aria-hidden", "true");
    parkingPlace.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(parkingPlace);
  }
  return parkingPlace;
}

export function claimMobileFeedPlayer(host: HTMLElement, token: symbol, src: string, postId = src, options?: { position?: number; snapshot?: ResumeSnapshot; contentVersion?: string; managedResume?: boolean; warmEligible?: boolean; reload?: boolean; boundedSeekRecovery?: boolean }): HTMLVideoElement {
  const transfer = pendingParking;
  pendingParking = null;
  if (!player) {
    player = document.createElement("video");
    player.playsInline = true;
    player.loop = true;
  }
  const changedPost = currentPostId !== postId;
  const contentVersion = options?.contentVersion ?? src;
  const changedContent = currentContentVersion !== contentVersion;
  const changedSource = player.getAttribute("src") !== src || options?.reload === true;
  const returningFromAnotherPage = owner === null && currentPostId === postId;
  if (owner !== token) player.pause();
  if (owner && changedPost) rememberPosition();
  const latest = mobileFeedResumeSnapshot(postId, contentVersion);
  const retained = !changedPost && !changedContent && parkedSnapshot?.expiresAt === null ? parkedSnapshot.position : null;
  if (changedPost || changedSource) cancelPendingSeek();
  owner = token;
  seekOutcome = null;
  host.appendChild(player);
  beginFeedVideoTrace(player, postId, src, options?.warmEligible ?? null);
  if (transfer?.video === player) recordFeedEvent("main-transfer", { mode: "direct", fromPostId: transfer.postId }, player);
  if (changedSource) {
    player.src = src;
  }
  currentPostId = postId;
  currentContentVersion = contentVersion;
  managedResume = options?.managedResume !== false;
  if (changedPost || changedSource || returningFromAnotherPage || changedContent) {
    // Always consume history, even if the controller supplied the same snapshot.
    recentPositions.delete(postId); scheduleExpiry(); parkedSnapshot = null;
    const snapshotPosition = options?.snapshot && sameMobileResume(options.snapshot, latest) ? options.snapshot.position : latest.position;
    const saved = options?.position ?? retained ?? snapshotPosition;
    recordFeedEvent("resume-decision", { postId, contentVersion, position: saved, expiresAt: latest.expiresAt, decision: saved > 0 ? "resume" : "restart" }, player);
    // Conventional playback keeps its existing fresh-source start behavior.
    // Candidate playback also guards a retained nonzero timeline while a new
    // source is attaching, so an expired return cannot show the old position.
    if (saved > 0 || !changedSource || (managedResume && player.currentTime > 0)) seekBeforePlayback(player, token, saved, options?.boundedSeekRecovery === true);
  }
  return player;
}

/** Preview experiment only. The caller must revoke the departing owner and
 * detach preparation observers first. Recheck the live snapshot and media before
 * replacing the shared element; adoption never reloads or seeks the selected video.
 * The original mode requires muted preparation. Only the separately selected
 * paused-audio Preview control supplies expectedMuted:false after sound checks.
 * A fulfilled play promise on this new element still does not prove audible output.
 */
export function adoptPreparedMobileFeedPlayer(host: HTMLElement, token: symbol, video: HTMLVideoElement, src: string, snapshot: ResumeSnapshot, frameTime: number, options?: { expectedMuted: boolean; retainAttachment?: boolean }): HTMLVideoElement | null {
  const latest = mobileFeedResumeSnapshot(snapshot.postId, snapshot.contentVersion, true);
  const remaining = video.duration - snapshot.position;
  if (owner !== null || video === player || document.hidden || !sameMobileResume(snapshot, latest) ||
      (options?.retainAttachment && (!host.isConnected || video.parentElement !== host)) ||
      video.getAttribute("src") !== src || video.currentSrc !== video.src || !video.paused || video.muted !== (options?.expectedMuted ?? true) ||
      video.seeking || video.readyState < 2 || video.playbackRate !== 1 || video.error ||
      video.videoWidth <= 0 || video.videoHeight <= 0 || !Number.isFinite(remaining) || remaining <= 0 ||
      !Number.isFinite(frameTime) || Math.abs(frameTime - snapshot.position) > 0.1 ||
      !Number.isFinite(video.currentTime) || Math.abs(video.currentTime - frameTime) > 0.1 ||
      playableBuffer(video, snapshot.position) + 0.001 < Math.min(1, remaining)) return null;

  // Clear the obsolete source only after all rejection paths. The released
  // element may have a deferred parking ticket; it must never reclaim this owner.
  const retired = player;
  // Preview diagnostics only: cumulative synchronous operation return times.
  // These do not timestamp native audio drain, admission or decoder release.
  const adoptionStartedAt = feedTraceEnabled() ? performance.now() : null;
  const timing: Record<string, string | number | null> | null = adoptionStartedAt === null ? null
    : { adoptionStartedAt, retiredPostId: currentPostId };
  const mark = (step: string) => { if (timing && adoptionStartedAt !== null) timing[step] = performance.now() - adoptionStartedAt; };
  pendingParking = null;
  cancelPendingSeek();
  if (retired) {
    retired.pause(); mark("retiredPauseReturnedMs");
    retired.muted = true; mark("retiredMuteAppliedMs");
    endFeedVideoTrace(retired); mark("retiredTraceEndedMs");
    retired.removeAttribute("src"); mark("retiredSourceRemovedMs");
    retired.load(); mark("retiredLoadReturnedMs");
    retired.remove(); mark("retiredDetachedMs");
  }
  player = video; owner = token; seekOutcome = null;
  currentPostId = snapshot.postId; currentContentVersion = snapshot.contentVersion;
  managedResume = true; parkedSnapshot = null;
  recentPositions.delete(snapshot.postId); scheduleExpiry();
  // The separate in-place Preview control keeps the qualified connected node
  // in its preparation host. Rejected placement cannot retire the old source.
  if (!options?.retainAttachment) host.appendChild(video);
  mark("promotedAttachedMs");
  beginFeedVideoTrace(video, snapshot.postId, src, true);
  recordFeedEvent("main-transfer", { mode: "prepared", retiredSourceRemoved: !retired?.hasAttribute("src"), position: video.currentTime,
    ...(options?.retainAttachment ? { preparedAttachmentRetained: true } : {}),
    ...(timing ?? {}) }, video);
  recordFeedEvent("resume-decision", { postId: snapshot.postId, contentVersion: snapshot.contentVersion, position: snapshot.position,
    expiresAt: latest.expiresAt, decision: snapshot.position > 0 ? "resume" : "restart" }, video);
  return video;
}

export function releaseMobileFeedPlayer(token: symbol, departure = true, options?: { deferParking?: boolean }): void {
  if (!player || owner !== token) return;
  player.pause();
  if (departure) rememberPosition();
  else parkedSnapshot = Object.freeze({ postId: currentPostId!, contentVersion: currentContentVersion, position: retainedPosition(), expiresAt: null });
  cancelPendingSeek();
  endFeedVideoTrace(player);
  owner = null;
  pendingParking = null;
  if (departure && options?.deferParking) {
    // Preview control only: an immediate new claim moves the same paused player
    // straight between card hosts. Revoke ownership and save the departure now;
    // if no claim follows in this task, still park before the next paint.
    const transfer = { video: player, postId: currentPostId };
    pendingParking = transfer;
    queueMicrotask(() => {
      // A superseded release must never park a newer owner or release ticket.
      if (pendingParking !== transfer || owner !== null || player !== transfer.video) return;
      pendingParking = null;
      recordFeedEvent("main-transfer", { mode: "parked", reason: "no-immediate-claim", fromPostId: transfer.postId });
      getParkingPlace().appendChild(transfer.video);
    });
  } else getParkingPlace().appendChild(player);
}

/** Stop sound as soon as a top-level mobile tab is selected. Card cleanup still
 * owns the position snapshot and release when the route changes. */
export function pauseMobileFeedPlayer(): void {
  player?.pause();
}
