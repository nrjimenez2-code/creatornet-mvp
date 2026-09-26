"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

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

/** Shared feed player timeline. Touch uses a direct drag surface; range keeps mouse and keyboard seeking. */
export default function VideoSeekBar({ videoRef }: Props) {
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const scrubbingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const touchPointerRef = useRef(false);
  const touchPositionRef = useRef(0);
  const lastTouchSeekRef = useRef(-Infinity);
  const touchTargetRef = useRef<HTMLDivElement>(null);

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

  const stopScrubbing = useCallback(() => {
    const video = videoRef.current;
    if (touchPointerRef.current && video) video.currentTime = touchPositionRef.current;
    activePointerIdRef.current = null;
    touchPointerRef.current = false;
    scrubbingRef.current = false;
    setIsScrubbing(false);
    if (video) setPosition(video.currentTime || 0);
  }, [videoRef]);

  useEffect(() => {
    if (duration <= 0 && activePointerIdRef.current !== null) {
      touchPointerRef.current = false;
      stopScrubbing();
    }
  }, [duration, stopScrubbing]);

  const touchPositionAt = useCallback((clientX: number) => {
    const bounds = touchTargetRef.current?.getBoundingClientRect();
    if (!bounds?.width || duration <= 0) return null;
    return Math.min(duration, Math.max(0, (clientX - bounds.left) / bounds.width * duration));
  }, [duration]);
  const moveTouch = useCallback((clientX: number) => {
    const next = touchPositionAt(clientX);
    if (next === null) return;
    touchPositionRef.current = next;
    setPosition(next);
    // Keep the visual preview immediate without asking a phone to decode every finger movement.
    const now = performance.now();
    if (now - lastTouchSeekRef.current >= 80) {
      const video = videoRef.current;
      if (video) video.currentTime = next;
      lastTouchSeekRef.current = now;
    }
  }, [touchPositionAt, videoRef]);

  useEffect(() => {
    const moveOutside = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current || !touchPointerRef.current) return;
      if (event.target instanceof Node && touchTargetRef.current?.contains(event.target)) return;
      moveTouch(event.clientX);
    };
    const endPointer = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) return;
      if (event.type === "pointerup" && touchPointerRef.current) moveTouch(event.clientX);
      stopScrubbing();
    };
    const endOnBlur = () => {
      setKeyboardFocused(false);
      if (activePointerIdRef.current !== null) stopScrubbing();
    };
    const endWhenHidden = () => {
      if (document.hidden) endOnBlur();
    };
    window.addEventListener("pointermove", moveOutside);
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    window.addEventListener("blur", endOnBlur);
    document.addEventListener("visibilitychange", endWhenHidden);
    return () => {
      window.removeEventListener("pointermove", moveOutside);
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
      window.removeEventListener("blur", endOnBlur);
      document.removeEventListener("visibilitychange", endWhenHidden);
    };
  }, [moveTouch, stopScrubbing]);
  const finishPointer = (event: PointerEvent<HTMLElement>, fromTouch: boolean) => {
    if (event.pointerId !== activePointerIdRef.current) return;
    if (fromTouch && event.type === "pointerup") moveTouch(event.clientX);
    stopScrubbing();
  };
  const progress = duration > 0 ? Math.min(100, Math.max(0, position / duration * 100)) : 0;
  const markerPosition = `clamp(4px, ${progress}%, calc(100% - 4px))`;
  const timeLabelPosition = `clamp(44px, ${progress}%, calc(100% - 44px))`;

  return (
    <div className="video-seek-control absolute inset-x-3 bottom-0 z-40 h-7 lg:inset-x-4" data-no-playback-toggle>
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
          className={`video-seek-thumb pointer-events-none absolute bottom-2 h-2 w-2 -translate-x-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.45)] transition-opacity motion-reduce:transition-none ${isScrubbing || keyboardFocused ? "opacity-100" : "opacity-0"}`}
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
        className="video-seek-range absolute inset-0 h-full w-full cursor-pointer opacity-0 touch-none disabled:cursor-default"
        onChange={(event) => seek(Number(event.currentTarget.value))}
        onPointerDown={(event) => {
          activePointerIdRef.current = event.pointerId;
          setKeyboardFocused(false);
          scrubbingRef.current = true;
          setIsScrubbing(true);
        }}
        onPointerUp={(event) => finishPointer(event, false)}
        onPointerCancel={(event) => finishPointer(event, false)}
        onLostPointerCapture={(event) => finishPointer(event, false)}
        onFocus={(event) => setKeyboardFocused(event.currentTarget.matches(":focus-visible"))}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
            setKeyboardFocused(true);
            setIsScrubbing(true);
          }
        }}
        onKeyUp={stopScrubbing}
        onBlur={() => { setKeyboardFocused(false); stopScrubbing(); }}
      />
      <div
        ref={touchTargetRef}
        aria-hidden="true"
        className="video-seek-touch-target absolute inset-0 z-10 h-full w-full touch-none"
        onPointerDown={(event) => {
          if (duration <= 0 || activePointerIdRef.current !== null) return;
          activePointerIdRef.current = event.pointerId;
          touchPointerRef.current = true;
          scrubbingRef.current = true;
          lastTouchSeekRef.current = -Infinity;
          setKeyboardFocused(false);
          setIsScrubbing(true);
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
          } catch {
            // The window release/cancel listeners still end a rejected capture.
          }
          moveTouch(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.pointerId === activePointerIdRef.current) moveTouch(event.clientX);
        }}
        onPointerUp={(event) => finishPointer(event, true)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onLostPointerCapture={(event) => finishPointer(event, true)}
      />
    </div>
  );
}
