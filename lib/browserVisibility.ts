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
