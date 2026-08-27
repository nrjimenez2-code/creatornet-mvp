// lib/posthogSampling.ts — client-side sampling for the highest-volume
// PostHog events, so a 10k-user day doesn't blow through the event budget.
//
// Only the events named here are sampled; everything else always sends.
// Dashboard counts for sampled events read LOW by the sampling factor
// (e.g. at 0.5, real pageviews ≈ 2× the reported number).
//
// Tune per environment without a code change (values 0..1):
//   NEXT_PUBLIC_POSTHOG_SAMPLE_PAGEVIEW    — $pageview and $pageleave
//   NEXT_PUBLIC_POSTHOG_SAMPLE_IMPRESSION  — video_impression

const DEFAULT_PAGEVIEW_RATE = 0.5;
const DEFAULT_IMPRESSION_RATE = 0.25;

function parseRate(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

/** Sampling rate for an event name; 1 means "always send". */
export function sampleRateFor(event: string): number {
  switch (event) {
    case "$pageview":
    case "$pageleave":
      // NEXT_PUBLIC_* must be read with static property access so Next.js
      // can inline it into the client bundle.
      return parseRate(
        process.env.NEXT_PUBLIC_POSTHOG_SAMPLE_PAGEVIEW,
        DEFAULT_PAGEVIEW_RATE
      );
    case "video_impression":
      return parseRate(
        process.env.NEXT_PUBLIC_POSTHOG_SAMPLE_IMPRESSION,
        DEFAULT_IMPRESSION_RATE
      );
    default:
      return 1;
  }
}

/** Coin flip against the event's sampling rate. `random` is injectable for tests. */
export function shouldSendEvent(
  event: string,
  random: () => number = Math.random
): boolean {
  const rate = sampleRateFor(event);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return random() < rate;
}
