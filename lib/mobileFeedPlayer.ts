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

const RESUME_WINDOW_MS = 5_000;
const MAX_RECENT_POSITIONS = 2;
const recentPositions = new Map<string, { src: string; time: number; savedAt: number }>();
let pendingSeek: { token: symbol; promise: Promise<void>; cancel: () => void } | null = null;

function rememberPosition(): void {
  if (!player || !currentPostId) return;
  const time = player.currentTime;
  if (!Number.isFinite(time) || time <= 0) return;
  recentPositions.delete(currentPostId);
  recentPositions.set(currentPostId, { src: player.getAttribute("src") || "", time, savedAt: Date.now() });
  while (recentPositions.size > MAX_RECENT_POSITIONS) recentPositions.delete(recentPositions.keys().next().value!);
}

function takeRecentPosition(postId: string, src: string): number | null {
  const saved = recentPositions.get(postId);
  recentPositions.delete(postId);
  if (!saved || saved.src !== src || Date.now() - saved.savedAt > RESUME_WINDOW_MS) return null;
  return saved.time;
}

/** Read-only measurement of the existing return policy; never consumes a position. */
export function recentMobileFeedPosition(postId: string, src: string): number {
  const saved = recentPositions.get(postId);
  return saved && saved.src === src && Date.now() - saved.savedAt <= RESUME_WINDOW_MS ? saved.time : 0;
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
  const finish = () => {
    if (done) return;
    done = true;
    video.removeEventListener("loadedmetadata", seek);
    video.removeEventListener("seeked", finish);
    video.removeEventListener("error", finish);
    clearTimeout(timer);
    if (pendingSeek?.token === token) pendingSeek = null;
    settle();
  };
  const timer = setTimeout(() => { recordFeedEvent("resume-seek-timeout", { target: time }, video); finish(); }, 2_000);
  const seek = () => {
    if (owner !== token || done) return finish();
    try {
      const target = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(time, Math.max(0, video.duration - 0.01)) : time;
      if (Math.abs(video.currentTime - target) < 0.05) return finish();
      video.currentTime = target;
    } catch { finish(); }
  };
  pendingSeek = { token, promise, cancel: finish };
  video.addEventListener("loadedmetadata", seek);
  video.addEventListener("seeked", finish);
  video.addEventListener("error", finish);
  // A bad stream must never leave the card unable to attempt playback.
  if (video.readyState >= 1) seek();
}

/** The active card waits for a short return seek before starting playback. */
export function mobileFeedPlaybackReady(token: symbol): Promise<void> | null {
  return pendingSeek?.token === token ? pendingSeek.promise : null;
}

function getParkingPlace(): HTMLDivElement {
  if (!parkingPlace || !parkingPlace.isConnected) {
    parkingPlace = document.createElement("div");
    parkingPlace.setAttribute("aria-hidden", "true");
    parkingPlace.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(parkingPlace);
  }
  return parkingPlace;
}

export function claimMobileFeedPlayer(host: HTMLElement, token: symbol, src: string, postId = src, warmEligible: boolean | null = null): HTMLVideoElement {
  if (!player) {
    player = document.createElement("video");
    player.playsInline = true;
    player.loop = true;
  }
  const changedPost = currentPostId !== postId;
  const changedSource = player.getAttribute("src") !== src;
  const returningFromAnotherPage = owner === null && currentPostId === postId;
  if (owner !== token) player.pause();
  if (owner && changedPost) rememberPosition();
  if (changedPost || changedSource) cancelPendingSeek();
  owner = token;
  host.appendChild(player);
  beginFeedVideoTrace(player, postId, src, warmEligible);
  if (changedSource) {
    player.src = src;
  }
  currentPostId = postId;
  if (changedPost || changedSource || returningFromAnotherPage) {
    const saved = takeRecentPosition(postId, src);
    if (saved !== null) seekBeforePlayback(player, token, saved);
    else if (!changedSource && player.currentTime > 0) seekBeforePlayback(player, token, 0);
  }
  return player;
}

export function releaseMobileFeedPlayer(token: symbol): void {
  if (!player || owner !== token) return;
  player.pause();
  rememberPosition();
  cancelPendingSeek();
  endFeedVideoTrace(player);
  owner = null;
  getParkingPlace().appendChild(player);
}
