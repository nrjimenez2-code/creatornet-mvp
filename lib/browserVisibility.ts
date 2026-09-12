"use client";

import { useSyncExternalStore } from "react";

const desktopQuery = "(min-width: 1024px)";
function subscribeDesktop(notify: () => void) {
  const query = window.matchMedia?.(desktopQuery);
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
}
const desktopSnapshot = () => window.matchMedia?.(desktopQuery).matches ?? false;
export function useDesktopViewport() {
  return useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false);
}

function subscribeVisibility(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}
const visibilitySnapshot = () => document.visibilityState !== "hidden";
export function usePageVisible() {
  return useSyncExternalStore(subscribeVisibility, visibilitySnapshot, () => true);
}

/**
 * Native HLS support (iOS Safari).
 *
 * This MUST go through useSyncExternalStore with an explicit server snapshot,
 * never `useState(() => ...document...)`. A useState initializer also runs
 * during the HYDRATION render, so it is not a client-only read: the server
 * emits the MP4 src while the first client render computes the .m3u8 one.
 * React does not repair a mismatched <video src> — it says so itself, "some
 * attributes of the server rendered HTML didn't match the client properties.
 * This won't be patched up." The MP4 then sticks forever, because nativeHls
 * never changes and nothing else triggers a patch.
 *
 * With a server snapshot of false the hydration render matches the server, and
 * React applies the real value in a normal post-hydration update instead.
 * Same trap as <video muted> in VideoCard — this is its third appearance.
 */
const noopSubscribe = () => () => {};
const nativeHlsSnapshot = () => !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
export function useNativeHls() {
  return useSyncExternalStore(noopSubscribe, nativeHlsSnapshot, () => false);
}
