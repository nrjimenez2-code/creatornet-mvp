"use client";

import { useEffect, useState } from "react";
import { exportFeedTrace, resetFeedTrace, setFeedRunContext } from "@/lib/mobileFeedDiagnostics";

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
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState("");
  const exportRun = async () => {
    const file = new File([JSON.stringify(exportFeedTrace(), null, 2)], `creatornet-feed-${Date.now()}.json`, { type: "application/json" });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "CreatorNet feed trace" });
      else {
        const url = URL.createObjectURL(file);
        const link = document.createElement("a"); link.href = url; link.download = file.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      setStatus("Trace exported");
    } catch { setStatus("Export cancelled or unavailable. Try Safari's share/download controls."); }
  };
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

  return <div aria-label="Feed playback diagnostics" aria-live="off" className="fixed right-2 top-2 z-[70] max-w-[65vw] rounded-lg bg-black/85 p-2 font-mono text-[10px] leading-4 text-white" data-no-playback-toggle>
    <div>post {activePostId?.slice(0, 8) ?? "none"}</div>
    {reading ? <>
      <div>{reading.source} · ready {reading.readyState} · {reading.muted ? "muted" : "sound requested"}</div>
      <div>moving frame {reading.startupMs} ms</div>
      <div>buffer {reading.bufferSeconds} s · dropped {reading.droppedFrames}</div>
    </> : <div>Waiting for video…</div>}
    <button type="button" onClick={() => setExpanded(!expanded)} className="underline">{expanded ? "Hide capture controls" : "Capture controls"}</button>
    {expanded && <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pt-2">
      {(["runId", "buildCommit", "surface", "iosVersion", "instagramVersion", "network", "powerMode", "temperature", "recordingId"] as const).map(field => <label key={field}>
        {field}<input aria-label={field} className="block w-full bg-white/10 p-1" onChange={event => setFeedRunContext({ [field]: event.target.value.slice(0, 160) })} />
      </label>)}
      <div>Sound, visible output and memory need phone evidence. Hide these controls before swiping.</div>
      <button type="button" className="rounded border p-1" onClick={() => { resetFeedTrace(); setStatus("New run; swipe to the first scored post"); }}>Start new run</button>
      <button type="button" className="rounded border p-1" onClick={() => void exportRun()}>Export trace</button>
      <div role="status">{status}</div>
    </div>}
  </div>;
}
