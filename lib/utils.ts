// lib/utils.ts

/** Default profile picture when user has not set one. Served from public/Default_DP.png */
export const DEFAULT_AVATAR_URL = "/Default_DP.png";

export function debounce<T extends (...args: any[]) => void>(fn: T, ms = 300) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
