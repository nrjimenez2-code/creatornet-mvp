/** Binds the existing progress endpoint to a player; owns no authentication. */
export function bindWatchProgress(video: HTMLVideoElement, postId: string): () => void {
  let disposed = false;
  let loaded = false;
  let started = false;
  let resumeSeconds: number | null = null;
  let lastSavedSeconds: number | null = null;
  let lastSaveAt = 0;
  let writing = false;
  let queued: { seconds: number; duration: number } | null = null;

  const applyResume = () => {
    if (disposed || started || resumeSeconds === null || !Number.isFinite(video.duration) || video.duration <= 0) return;
    // A completed clip starts again; a short, unfinished clip also resumes.
    video.currentTime = resumeSeconds < video.duration ? Math.max(0, resumeSeconds) : 0;
    resumeSeconds = null;
  };

  void fetch(`/api/watch/progress?post_id=${encodeURIComponent(postId)}`, { credentials: "include" })
    .then(async (response) => response.ok ? response.json() : null)
    .then((body) => {
      if (disposed) return;
      loaded = true;
      const seconds: unknown = body?.progress?.seconds;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
        resumeSeconds = seconds;
        applyResume();
      }
    })
    .catch(() => { loaded = true; });

  const flush = () => {
    if (writing || !queued) return;
    const point = queued;
    queued = null;
    writing = true;
    void fetch("/api/watch/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify({ post_id: postId, ...point }),
    }).then((response) => {
      if (!response.ok && lastSavedSeconds === point.seconds) lastSavedSeconds = null;
    }).catch(() => {
      if (lastSavedSeconds === point.seconds) lastSavedSeconds = null;
    }).finally(() => {
      writing = false;
      // Serialize this player's writes so a slow earlier save cannot overwrite
      // its newer pause/end position. Only keep the newest queued position.
      flush();
    });
  };

  const save = (force: boolean) => {
    if (disposed || !loaded || !started || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const seconds = Math.max(0, Math.min(video.currentTime, video.duration));
    if (!Number.isFinite(seconds) || seconds === lastSavedSeconds) return;
    const now = Date.now();
    if (!force && now - lastSaveAt < 5000) return;
    lastSaveAt = now;
    lastSavedSeconds = seconds;
    queued = { seconds, duration: video.duration };
    flush();
  };
  const onPlay = () => { started = true; };
  const onTimeUpdate = () => { if (!video.paused) save(false); };
  const onStop = () => save(true);
  video.addEventListener("loadedmetadata", applyResume);
  video.addEventListener("play", onPlay);
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("pause", onStop);
  video.addEventListener("ended", onStop);
  window.addEventListener("pagehide", onStop);

  return () => {
    save(true);
    disposed = true;
    video.removeEventListener("loadedmetadata", applyResume);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("pause", onStop);
    video.removeEventListener("ended", onStop);
    window.removeEventListener("pagehide", onStop);
  };
}
