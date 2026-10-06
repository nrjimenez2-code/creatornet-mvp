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
  window.addEventListener('creatornet:visibility', notify);
  return () => { document.removeEventListener("visibilitychange", notify); window.removeEventListener('creatornet:visibility', notify); };
}
let nativeVisible: boolean | null = null;
/** The installed app supplies lifecycle state; website visibility keeps its existing behavior. */
export function setNativePageVisible(visible: boolean | null) {
  nativeVisible = visible;
  window.dispatchEvent(new Event('creatornet:visibility'));
}
const visibilitySnapshot = () => nativeVisible !== false && document.visibilityState !== "hidden";
export function usePageVisible() {
  return useSyncExternalStore(subscribeVisibility, visibilitySnapshot, () => true);
}
