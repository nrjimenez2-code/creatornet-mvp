/** Let the current paint finish, then use an idle slot with a bounded fallback.
 * Returns cancellation for work owned by a feed generation or signed-in viewer.
 */
export function scheduleFeedBackground(work: () => void, delay = 250) {
  let cancelled = false;
  let idle: number | undefined;
  const timer = window.setTimeout(() => {
    const run = () => { if (!cancelled) work(); };
    if (window.requestIdleCallback) idle = window.requestIdleCallback(run, { timeout: 750 });
    else run();
  }, delay);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}

/** Recorded events survive a quick swipe or navigation; send before page exit. */
export function scheduleFeedTelemetry(work: () => void, video?: HTMLVideoElement) {
  let sent = false;
  let cancel = () => {};
  let frame: number | undefined;
  let fallback: number | undefined;
  const stopWaiting = () => {
    window.clearTimeout(fallback);
    if (frame !== undefined) video?.cancelVideoFrameCallback(frame);
    video?.removeEventListener("playing", ready);
  };
  const run = () => {
    if (sent) return;
    sent = true;
    cancel();
    stopWaiting();
    window.removeEventListener("pagehide", run);
    work();
  };
  const ready = () => {
    stopWaiting();
    cancel();
    cancel = scheduleFeedBackground(run);
  };
  if (video) {
    fallback = window.setTimeout(ready, 1000);
    if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(ready);
    else video.addEventListener("playing", ready, { once: true });
  } else ready();
  window.addEventListener("pagehide", run, { once: true });
}
