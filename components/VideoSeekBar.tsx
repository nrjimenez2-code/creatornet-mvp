"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
};

function formatTime(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return whole >= 3600
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

/** Shared feed player timeline. The range input handles mouse, touch, and keyboard seeking. */
export default function VideoSeekBar({ videoRef }: Props) {
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const scrubbingRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const syncDuration = () => {
      setDuration(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
    };
    const syncPosition = () => {
      if (!scrubbingRef.current) setPosition(video.currentTime || 0);
    };

    syncDuration();
    syncPosition();
    video.addEventListener("loadedmetadata", syncDuration);
    video.addEventListener("durationchange", syncDuration);
    video.addEventListener("timeupdate", syncPosition);
    video.addEventListener("seeking", syncPosition);
    video.addEventListener("seeked", syncPosition);
    return () => {
      video.removeEventListener("loadedmetadata", syncDuration);
      video.removeEventListener("durationchange", syncDuration);
      video.removeEventListener("timeupdate", syncPosition);
      video.removeEventListener("seeking", syncPosition);
      video.removeEventListener("seeked", syncPosition);
    };
  }, [videoRef]);

  const seek = (nextPosition: number) => {
    const video = videoRef.current;
    if (!video || duration <= 0) return;
    const next = Math.min(duration, Math.max(0, nextPosition));
    setPosition(next);
    video.currentTime = next;
  };
  const stopScrubbing = () => {
    scrubbingRef.current = false;
    setIsScrubbing(false);
  };
  const progress = duration > 0 ? Math.min(100, Math.max(0, position / duration * 100)) : 0;
  const markerPosition = `clamp(4px, ${progress}%, calc(100% - 4px))`;
  const timeLabelPosition = `clamp(44px, ${progress}%, calc(100% - 44px))`;

  return (
    <div className="group/seek absolute inset-x-3 bottom-0 z-40 h-8 lg:inset-x-4" data-no-playback-toggle>
      {isScrubbing && duration > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[22px] -translate-x-1/2 rounded-full border border-white/15 bg-black/75 px-1.5 py-0.5 text-[10px] font-medium leading-3 tabular-nums text-white shadow-sm backdrop-blur-sm"
          style={{ left: timeLabelPosition }}
        >
          {formatTime(position)} / {formatTime(duration)}
        </div>
      )}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-[11px] h-0.5 rounded-full bg-white/25">
        <div className="h-full rounded-full bg-white/75" style={{ width: `${progress}%` }} />
      </div>
      {duration > 0 && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute bottom-2 h-2 w-2 -translate-x-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.45)] transition-opacity group-hover/seek:opacity-100 group-focus-within/seek:opacity-100 motion-reduce:transition-none ${isScrubbing ? "opacity-100" : "opacity-0"}`}
          style={{ left: markerPosition }}
        />
      )}
      <input
        type="range"
        min={0}
        max={duration || 1}
        step="0.01"
        value={Math.min(position, duration || 1)}
        disabled={duration <= 0}
        aria-label="Seek video"
        aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 touch-none disabled:cursor-default"
        onChange={(event) => seek(Number(event.currentTarget.value))}
        onPointerDown={() => {
          scrubbingRef.current = true;
          setIsScrubbing(true);
        }}
        onPointerUp={stopScrubbing}
        onPointerCancel={stopScrubbing}
        onLostPointerCapture={stopScrubbing}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
            setIsScrubbing(true);
          }
        }}
        onKeyUp={stopScrubbing}
        onBlur={stopScrubbing}
      />
    </div>
  );
}
