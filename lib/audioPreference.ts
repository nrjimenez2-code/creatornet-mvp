"use client";

import { useSyncExternalStore } from "react";

export const SOUND_PREF_KEY = "cn-sound-on";
export const SOUND_ACCOUNT_FIELD = "cn_sound_on";
type Choice = { soundOn: boolean; pending: boolean; revision: string };
export type SoundAccount = {
  id: string;
  load: () => Promise<boolean | undefined>;
  save: (soundOn: boolean) => Promise<void>;
};

// Only explicit choices belong here, never a browser autoplay refusal.
let account: SoundAccount | null = null;
let flush: (() => void) | null = null;
let accountLoading = false;
let authResolved = false;
const saves = new Map<string, Promise<void>>();
const memory = new Map<string, Choice>();
const brokenWrites = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const keyFor = (id?: string) => id ? `${SOUND_PREF_KEY}:${id}` : SOUND_PREF_KEY;

function readChoice(key: string): Choice | undefined {
  if (brokenWrites.has(key)) return memory.get(key);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "true" || raw === "false") {
      return { soundOn: raw === "true", pending: false, revision: raw };
    }
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<Choice>;
    if (typeof value?.soundOn === "boolean" && typeof value.revision === "string") {
      return { soundOn: value.soundOn, pending: value.pending === true, revision: value.revision };
    }
  } catch {
    return memory.get(key);
  }
  return undefined;
}

function storeChoice(key: string, choice: Choice): void {
  memory.set(key, choice);
  try {
    // Keep the guest format compatible with existing saved choices.
    window.localStorage.setItem(key, key === SOUND_PREF_KEY ? String(choice.soundOn) : JSON.stringify(choice));
    brokenWrites.delete(key);
  } catch {
    brokenWrites.add(key);
  }
}

export function readSoundOn(): boolean {
  if (!authResolved) return false;
  const choice = readChoice(keyFor(account?.id));
  if (choice) return choice.soundOn;
  // A new device must load an existing account mute before attempting audio.
  return accountLoading ? false : (account ? readChoice(SOUND_PREF_KEY)?.soundOn ?? true : true);
}

export function writeSoundOn(soundOn: boolean): void {
  storeChoice(keyFor(account?.id), {
    soundOn, pending: account !== null, revision: crypto.randomUUID(),
  });
  notify();
  flush?.();
}

/** One connection at the app root, never one auth request per feed card. */
export function connectSoundAccount(next: SoundAccount | null): () => void {
  account = next;
  authResolved = true;
  let disposed = false;
  let saving = false;
  const key = keyFor(next?.id);
  accountLoading = next !== null;

  const savePending = async () => {
    if (!next || disposed || saving) return;
    saving = true;
    try {
      // Serialize rapid toggles. Failed writes survive reloads as pending.
      while (!disposed) {
        const choice = readChoice(key);
        if (!choice?.pending) break;
        // Also order writes across token-refresh/reconnect effect lifetimes.
        const savingChoice = (saves.get(next.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
          if (!disposed) await next.save(choice.soundOn);
        });
        saves.set(next.id, savingChoice);
        await savingChoice;
        if (disposed) break;
        const latest = readChoice(key);
        if (latest?.revision === choice.revision) {
          storeChoice(key, { ...choice, pending: false });
        } else if (latest && latest.soundOn !== choice.soundOn) {
          // Another tab may have saved its newer choice before our older
          // request completed. Reassert that latest choice, not the old one.
          storeChoice(key, { ...latest, pending: true });
        }
      }
    } catch {
      // Playback still works. Retry on the next choice, reconnect or login.
    } finally {
      saving = false;
    }
  };
  const retry = () => { void savePending(); };
  flush = retry;
  notify();

  const loadRemote = () => {
    if (!next || disposed) return;
    const initial = readChoice(key);
    const startingRevision = initial?.revision;
    void next.load().then((remote) => {
      if (disposed) return;
      const local = readChoice(key);
      if (initial?.pending || local?.pending || local?.revision !== startingRevision) return;
      if (typeof remote === "boolean") {
        storeChoice(key, { soundOn: remote, pending: false, revision: crypto.randomUUID() });
      } else if (!local) {
        // Migrate the old browser choice only when the account has no choice.
        const legacy = readChoice(SOUND_PREF_KEY);
        if (legacy) storeChoice(key, { ...legacy, pending: true, revision: crypto.randomUUID() });
      }
      notify();
      retry();
    }).catch(() => { /* Keep the cached account choice while offline. */ }).finally(() => {
      if (!disposed) {
        accountLoading = false;
        notify();
      }
    });
  };
  const reconnect = () => { loadRemote(); retry(); };
  if (next) {
    loadRemote();
    retry();
    window.addEventListener("online", reconnect);
  }
  return () => {
    disposed = true;
    window.removeEventListener("online", reconnect);
    if (account === next) {
      account = null;
      accountLoading = false;
      flush = null;
    }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === keyFor(account?.id)) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

// Hydration matches SSR; apply the preference once the browser can read it.
const getServerSnapshot = () => false;
export function useSoundPreference(): [boolean, (soundOn: boolean) => void] {
  return [useSyncExternalStore(subscribe, readSoundOn, getServerSnapshot), writeSoundOn];
}
