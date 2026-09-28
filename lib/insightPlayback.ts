/** Suspend underlying playback until the same active video can safely resume. */
const suspended = new WeakSet<HTMLVideoElement>();
export function insightPlaybackSuspended(video: HTMLVideoElement) { return suspended.has(video); }
export function pauseForInsights(video: HTMLVideoElement | null, stillActive: () => boolean): () => void {
  if (!video) return () => {};
  const wasPlaying = !video.paused;
  const source = video.getAttribute("src");
  const stop = () => video.pause();
  suspended.add(video); video.addEventListener("play", stop); video.pause();
  return () => {
    suspended.delete(video); video.removeEventListener("play", stop);
    if (wasPlaying && video.isConnected && !document.hidden && source === video.getAttribute("src") && stillActive()) void video.play().catch(() => {});
  };
}
