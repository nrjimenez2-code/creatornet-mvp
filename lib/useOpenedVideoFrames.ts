"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { naturalDesktopFeedFrameFits } from "@/lib/desktopFeedFrame";

function subscribeViewportSize(notify: () => void) {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
}

const viewportSizeSnapshot = () => `${window.innerWidth}:${window.innerHeight}`;

/** Keep each opened post's measured shape while its video card is unmounted. */
export function useOpenedVideoFrames() {
  const snapshot = useSyncExternalStore(subscribeViewportSize, viewportSizeSnapshot, () => "0:0");
  const [viewportWidth, viewportHeight] = snapshot.split(":").map(Number);
  const [mediaRatios, setMediaRatios] = useState<Record<string, number>>({});

  const rememberMediaRatio = useCallback((mediaKey: string, ratio: number) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    setMediaRatios(previous => previous[mediaKey] === ratio
      ? previous
      : { ...previous, [mediaKey]: ratio });
  }, []);

  const frameForMedia = (mediaKey: string) => {
    const ratio = mediaRatios[mediaKey];
    return {
      mediaKey,
      ratio,
      useNaturalFrame: naturalDesktopFeedFrameFits(ratio, viewportWidth, viewportHeight),
    };
  };

  return { frameForMedia, rememberMediaRatio };
}
