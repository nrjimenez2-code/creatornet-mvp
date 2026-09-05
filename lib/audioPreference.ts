"use client";

import { useSyncExternalStore } from "react";

/**
 * Per-device sound preference for video playback (Noah #6).
 *
 * Mute state used to live only in React (FeedList's globalSoundOn, VideoCard's
 * isMuted, nothing at all on the watch page), so every reload came back muted.
 * This is the single store: localStorage under SOUND_PREF_KEY, read through
 * useSyncExternalStore so SSR and hydration render the muted default and the
 * saved choice applies on the first client render (same shape as
 * components/CookieNotice.tsx).
 *
 * Every storage access is wrapped. Private mode / blocked storage degrades to
 * "remembered for this page only" via the in-memory mirror, never to a throw.
 */
export const SOUND_PREF_KEY = "cn-sound-on";

/** Last value written; the source of truth only when storage is unreadable. */
let inMemorySoundOn = false;

const listeners = new Set<() => void>();

export function readSoundOn(): boolean {
  try {
    return window.localStorage.getItem(SOUND_PREF_KEY) === "true";
  } catch {
    // No window (SSR) or storage blocked — new-visitor default, or whatever
    // this page already chose.
    return inMemorySoundOn;
  }
}

export function writeSoundOn(soundOn: boolean): void {
  inMemorySoundOn = soundOn;
  try {
    window.localStorage.setItem(SOUND_PREF_KEY, soundOn ? "true" : "false");
  } catch {
    // Storage blocked — the choice still applies for this page via listeners.
  }
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  const onStorage = (event: StorageEvent) => {
    // key === null is a storage.clear(); other keys are not ours.
    if (event.key === null || event.key === SOUND_PREF_KEY) notify();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("storage", onStorage);
  };
}

const getServerSnapshot = () => false;

/** [soundOn, setSoundOn] — every subscriber on the page updates together. */
export function useSoundPreference(): [boolean, (soundOn: boolean) => void] {
  const soundOn = useSyncExternalStore(subscribe, readSoundOn, getServerSnapshot);
  return [soundOn, writeSoundOn];
}
