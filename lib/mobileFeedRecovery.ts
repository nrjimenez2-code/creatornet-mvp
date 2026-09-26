/** A source URL association alone does not prove equivalent media timelines. */
export type VerifiedTimeline = { contentVersion: string; from: string; to: string; offsetSeconds: number; evidence: string };

// Populate only after content-version and timeline validation. No legacy mappings
// are silently promoted to verified equivalence; overwritten originals fail closed.
export const verifiedMobileTimelines: readonly VerifiedTimeline[] = [];

export function fallbackPosition(from: string, to: string, time: number, proof: readonly VerifiedTimeline[] = verifiedMobileTimelines): number | null {
  if (!Number.isFinite(time) || time < 0) return null;
  const match = proof.find(row => row.from === from && row.to === to && row.contentVersion && row.evidence && Number.isFinite(row.offsetSeconds));
  return match ? Math.max(0, time + match.offsetSeconds) : null;
}

export function planMobileFallback(from: string, to: string | undefined, time: number, attempted: Set<string>, proof: readonly VerifiedTimeline[] = verifiedMobileTimelines) {
  if (!to || to === from || attempted.has(to)) return { kind: "terminal" as const, reason: "exhausted" };
  const position = fallbackPosition(from, to, time, proof);
  // At initial entry no timeline has been consumed, so ordinary fallback is safe.
  if (position === null && time > 0.05) return { kind: "terminal" as const, reason: "unverified-timeline", capturedPosition: time };
  attempted.add(to);
  return { kind: "replace" as const, position: position ?? 0, source: to };
}
