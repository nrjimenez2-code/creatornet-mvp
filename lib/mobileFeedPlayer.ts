/**
 * The main phone feed keeps one media element for audible playback. WebKit's
 * autoplay grant belongs to the element, so replacing it for each post or
 * after a route change can ask for the same sound gesture again.
 *
 * This module owns the element and two short-lived playback positions. Feed
 * cards own their presentation, listeners and muted previews. Desktop never calls it.
 */
import { beginFeedVideoTrace, endFeedVideoTrace, recordFeedEvent } from "./mobileFeedDiagnostics";

let player: HTMLVideoElement | null = null;
let parkingPlace: HTMLDivElement | null = null;
let owner: symbol | null = null;
let currentPostId: string | null = null;
let currentContentVersion = "";
let managedResume = true;
let parkedSnapshot: ResumeSnapshot | null = null;

const RESUME_WINDOW_MS = 5_000;
const MAX_RECENT_POSITIONS = 2;
export type ResumeSnapshot = Readonly<{ postId: string; contentVersion: string; position: number; expiresAt: number | null }>;
const recentPositions = new Map<string, ResumeSnapshot>();
const managedPositions = new WeakSet<ResumeSnapshot>();
const expiryListeners = new Set<(snapshot: ResumeSnapshot) => void>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSeek: { token: symbol; promise: Promise<void>; cancel: () => void } | null = null;
let seekOutcome: { token: symbol; failed: boolean } | null = null;

function rememberPosition(): void {
  if (!player || !currentPostId) return;
  const time = player.currentTime;
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
export function mobileFeedResumeSnapshot(postId: string, contentVersion: string): ResumeSnapshot {
  expirePositions();
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

function seekBeforePlayback(video: HTMLVideoElement, token: symbol, time: number): void {
  recordFeedEvent("resume-seek-request", { target: time }, video);
  let settle!: () => void;
  const promise = new Promise<void>(resolve => { settle = resolve; });
  let done = false;
  let target = time;
  const finish = (failed = false) => {
    if (done) return;
    done = true;
    video.removeEventListener("loadedmetadata", seek);
    video.removeEventListener("seeked", seeked);
    video.removeEventListener("error", failedSeek);
    clearTimeout(timer);
    if (pendingSeek?.token === token) pendingSeek = null;
    if (owner === token) seekOutcome = { token, failed };
    settle();
  };
  const failedSeek = () => finish(true);
  const seeked = () => {
    if (owner !== token || video.seeking || video.currentSrc !== video.src || Math.abs(video.currentTime - target) > 0.05) return;
    finish();
  };
  const timer = setTimeout(() => { recordFeedEvent("resume-seek-timeout", { target: time }, video); failedSeek(); }, 2_000);
  const seek = () => {
    if (owner !== token || done) return failedSeek();
    if (video.currentSrc !== video.src) return;
    try {
      target = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(time, Math.max(0, video.duration - 0.01)) : time;
      if (Math.abs(video.currentTime - target) < 0.05) return finish();
      video.currentTime = target;
    } catch { failedSeek(); }
  };
  pendingSeek = { token, promise, cancel: failedSeek };
  video.addEventListener("loadedmetadata", seek);
  video.addEventListener("seeked", seeked);
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

export function claimMobileFeedPlayer(host: HTMLElement, token: symbol, src: string, postId = src, options?: { position?: number; snapshot?: ResumeSnapshot; contentVersion?: string; managedResume?: boolean; warmEligible?: boolean; reload?: boolean }): HTMLVideoElement {
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
    if (saved > 0 || player.currentTime > 0 || !changedSource) seekBeforePlayback(player, token, saved);
  }
  return player;
}

export function releaseMobileFeedPlayer(token: symbol, departure = true): void {
  if (!player || owner !== token) return;
  player.pause();
  if (departure) rememberPosition();
  else parkedSnapshot = Object.freeze({ postId: currentPostId!, contentVersion: currentContentVersion, position: player.currentTime, expiresAt: null });
  cancelPendingSeek();
  endFeedVideoTrace(player);
  owner = null;
  getParkingPlace().appendChild(player);
}
