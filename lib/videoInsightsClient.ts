"use client";
import { IntervalWatch } from "./qualifiedWatch";
import type { InsightSource } from "./videoInsights";

export const insightCollectionClientEnabled = () => process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_COLLECTION_ENABLED === "true";
type Session = {
  key: string; postId: string; sessionId: string; secret: string; source: InsightSource; surface: "feed" | "watch";
  watch: IntervalWatch; token: string | null; issued: boolean; ended: boolean; sequence: number; sent: number;
  duration: number | null; busy: boolean; dirty: boolean; disabled: boolean; detachTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  retryAt: number;
};
let current: Session | null = null;
let startQueue = Promise.resolve();
let queuedStarts = 0;
let requests = 0;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function secret() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join(""); }
async function request(session: Session, path: string, body: object) {
  if (Date.now() < session.retryAt) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (session.disabled) return null;
    if (attempt) await delay(attempt * 400);
    // Drop overload; collection can never queue an unbounded amount of playback work.
    if (requests >= 4) return null;
    requests++;
    try {
      const response = await fetch(`/api/video-insights/${path}`, { method: "POST", credentials: "include", keepalive: true,
        headers: { "Content-Type": "application/json", ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(3500) });
      if (response.ok) return await response.json();
      if ([400,401,403,404,409].includes(response.status)) { session.disabled = true; return null; }
      if (response.status === 429) { session.retryAt = Date.now()+60000; return null; }
    } catch { /* bounded retry; telemetry never interrupts playback */ }
    finally { requests--; }
  }
  session.retryAt = Date.now()+30000;
  return null;
}
async function issue(session: Session) {
  if (session.issued || session.disabled) return session.issued;
  if (queuedStarts >= 24) { session.disabled = true; return false; }
  queuedStarts++;
  // Serialize first-time cookie issuance for signed-out playback.
  const previous = startQueue;
  let release!: () => void;
  startQueue = new Promise<void>(resolve => { release = resolve; });
  try {
    await previous;
    if (Date.now() - session.startedAt > 30000 && !session.issued) { session.disabled = true; return false; }
    const body = { sessionId: session.sessionId, secret: session.secret,
      postId: session.postId, source: session.source, surface: session.surface, startedAt: session.startedAt };
    let result = await request(session, "sessions", body);
    if (result?.identityReady) result = await request(session, "sessions", body);
    if (result?.sessionId === session.sessionId) { session.issued = true; session.duration = result.duration; }
    return session.issued;
  } finally { queuedStarts--; release(); }
}
function flush(session: Session) {
  session.dirty = true;
  if (session.busy || session.disabled) return;
  session.busy = true;
  void (async () => {
    try {
      if (!await issue(session)) return;
      while (session.dirty && !session.disabled) {
        session.dirty = false;
        const seconds = session.watch.seconds;
        const intervals = session.watch.intervals.map(([a,b]) => [a, Math.min(b, session.duration ?? b)]).filter(([a,b]) => b>a);
        const result = await request(session, "events", { sessionId: session.sessionId, secret: session.secret,
          sequence: ++session.sequence, seconds, intervals });
        if (!result) break;
        session.sent = seconds;
      }
    } finally { session.busy = false; }
  })();
}
function finish(session: Session) { session.ended = true; session.watch.resetSample(); clearTimeout(session.detachTimer); flush(session); if (current === session) current = null; }
export function leaveInsightVideo(postId: string) { if (current?.postId === postId) finish(current); }

export function bindVideoInsights(video: HTMLVideoElement, input: {
  postId: string; media: string; userId: string | null; token: string | null; source: InsightSource; surface?: "feed" | "watch";
  eligible: () => boolean; container?: Element; active?: boolean;
}) {
  if (!insightCollectionClientEnabled()) return () => {};
  const key = `${input.postId}:${input.media}:${input.userId ?? "anonymous"}`;
  let session = current?.key === key ? current : null;
  if (session) { clearTimeout(session.detachTimer);session.token=input.token; }
  let visible = input.active !== false;
  let alive = true, frame: number | undefined;
  let blocked = false;
  const sessionForAdvance = () => {
    if (!session) {
      if (current && current.key !== key) finish(current);
      session = { key, postId: input.postId, sessionId: crypto.randomUUID(), secret: secret(), source: input.source,
        surface: input.surface ?? "feed", watch: measurement, token: input.token, issued: false, ended: false,
        sequence: 0, sent: 0, duration: null, busy: false, dirty: false, disabled: false, startedAt: Date.now(), retryAt: 0 };
      current = session;
    }
    return session;
  };
  let measurement = session?.watch ?? new IntervalWatch();
  measurement.resetSample();
  const eligible = () => alive && !session?.ended && visible && !blocked && !document.hidden && !video.paused && !video.seeking && video.readyState >= 2 && input.eligible();
  const sample = (now: number, position: number) => {
    const before = measurement.seconds;
    measurement.sample(now, position, eligible(), video.playbackRate, video.loop ? video.duration : undefined);
    if (measurement.seconds > before) {
      const active = sessionForAdvance();
      if (!active.issued || measurement.seconds - active.sent >= 5) flush(active);
    }
  };
  const observeFrame = (now: number, metadata: VideoFrameCallbackMetadata) => {
    sample(now, metadata.mediaTime);
    if (alive) frame = video.requestVideoFrameCallback(observeFrame);
  };
  const fallback = () => sample(performance.now(), video.currentTime);
  const reset = () => { measurement.resetSample(); };
  const pause = () => { reset(); if (session) flush(session); };
  const stall = () => { blocked = true; pause(); };
  const play = () => { blocked = false; reset();measurement.sample(performance.now(),video.currentTime,eligible(),video.playbackRate); };
  const ended = () => {
    const before=measurement.seconds;
    measurement.sample(performance.now(),video.currentTime,alive && visible && !blocked && !document.hidden && !video.seeking && input.eligible(),video.playbackRate);
    if(measurement.seconds>before)sessionForAdvance();
    pause();
  };
  const hiding = () => { pause(); };
  const pagehide = () => { if (session) finish(session); };
  const pageshow = () => { if (session?.ended) { session=null;measurement=new IntervalWatch();blocked=false; } };
  const observer = input.container && input.active === undefined ? new IntersectionObserver(entries => {
    visible = entries[0]?.intersectionRatio >= 0.75;
    if (!visible) { pause(); if (session) finish(session); session = null; measurement = new IntervalWatch(); }
  }, { threshold: 0.75 }) : null;
  if (observer && input.container) { visible = false; observer.observe(input.container); }
  if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(observeFrame);
  else video.addEventListener("timeupdate", fallback);
  for (const event of ["pause", "seeking", "ratechange"]) video.addEventListener(event, pause);
  video.addEventListener("ended",ended);
  for (const event of ["waiting", "stalled", "emptied"]) video.addEventListener(event, stall);
  for (const event of ["playing", "seeked", "loadeddata"]) video.addEventListener(event, play);
  document.addEventListener("visibilitychange", hiding);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", pageshow);
  return () => {
    alive = false; observer?.disconnect();
    if (frame !== undefined) video.cancelVideoFrameCallback(frame);
    video.removeEventListener("timeupdate", fallback);
    for (const event of ["pause", "seeking", "ratechange"]) video.removeEventListener(event, pause);
    video.removeEventListener("ended",ended);
    for (const event of ["waiting", "stalled", "emptied"]) video.removeEventListener(event, stall);
    for (const event of ["playing", "seeked", "loadeddata"]) video.removeEventListener(event, play);
    document.removeEventListener("visibilitychange", hiding); window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("pageshow", pageshow);
    pause();
    // Effect handoff/StrictMode/remount may reattach synchronously. A different post ends immediately.
    if (session && !session.ended) session.detachTimer = setTimeout(() => { if (session) finish(session); }, 250);
  };
}
