"use client";

import { useEffect, useState } from "react";

type Props = {
  activePostId: string | null;
  getVideo: (postId: string) => HTMLVideoElement | null;
};

type Reading = {
  source: "HLS" | "MP4" | "other";
  startupMs: string;
  stalls: string;
  bufferSeconds: string;
  droppedFrames: string;
  readyState: number;
  muted: boolean;
};

export function readMobileFeedDiagnostics(video: HTMLVideoElement): Reading {
  let ahead = 0;
  for (let index = 0; index < video.buffered.length; index++) {
    if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
      ahead = video.buffered.end(index) - video.currentTime;
      break;
    }
  }
  const url = video.currentSrc || video.src;
  return {
    source: url.includes(".m3u8") ? "HLS" : url.includes(".mp4") ? "MP4" : "other",
    startupMs: video.dataset.startupMs ?? "…",
    stalls: video.dataset.stallCount ?? "0",
    bufferSeconds: ahead.toFixed(1),
    droppedFrames: String(video.getVideoPlaybackQuality?.().droppedVideoFrames ?? "—"),
    readyState: video.readyState,
    muted: video.muted,
  };
}

/** Shown only with ?feedDebug=1 so an iPhone screenshot can capture playback evidence. */
export default function MobileFeedDiagnostics({ activePostId, getVideo }: Props) {
  const [reading, setReading] = useState<Reading | null>(null);
  useEffect(() => {
    if (!activePostId) return;
    const update = () => {
      const video = getVideo(activePostId);
      setReading(video ? readMobileFeedDiagnostics(video) : null);
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [activePostId, getVideo]);

  return <div aria-label="Feed playback diagnostics" aria-live="off" className="pointer-events-none fixed right-2 top-2 z-[70] max-w-[45vw] rounded-lg bg-black/85 p-2 font-mono text-[10px] leading-4 text-white">
    <div>post {activePostId?.slice(0, 8) ?? "none"}</div>
    {reading ? <>
      <div>{reading.source} · ready {reading.readyState} · {reading.muted ? "muted" : "sound"}</div>
      <div>first frame {reading.startupMs} ms · stalls {reading.stalls}</div>
      <div>buffer {reading.bufferSeconds} s · dropped {reading.droppedFrames}</div>
    </> : <div>Waiting for video…</div>}
  </div>;
}
