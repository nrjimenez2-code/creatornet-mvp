import { discoverTimingEnabled } from './discoverTimingLog';
import { serverStartupMetrics, previewStartupBoundaries } from './serverStartupTiming';

// Create once per route module, then capture immediately on handler entry.
// An optional first-dependency marker brackets subsequent import evaluation in
// Preview. Earlier framework/platform work is not a measured request phase.
// Invocation 1 means first observed use of this module instance,
// not a proven cold start; neither age nor ordinal identifies an instance.
export function createDiscoverRouteTiming(importStarted?: number) {
  const loadedAt = performance.now();
  let invocation = 0;
  return (): string[] => {
    if (!discoverTimingEnabled()) return [];
    const entryAt = performance.now();
    const age = entryAt - loadedAt;
    invocation = Math.min(invocation + 1, Number.MAX_SAFE_INTEGER);
    const metrics = [`invocation;dur=${invocation}`];
    const addDuration = (name: string, value: number) => {
      if (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)
        metrics.push(`${name};dur=${value.toFixed(1)}`);
    };
    addDuration('routeage', age);
    // Uptime is process age at entry, not request duration. Omit it if the
    // runtime does not provide a valid Node uptime; diagnostics must not fail.
    try {
      if (typeof process.uptime === 'function') addDuration('uptime', process.uptime() * 1000);
    } catch { /* An unavailable uptime is not a request failure. */ }
    return [...metrics, ...serverStartupMetrics(),
      ...(importStarted !== undefined && invocation <= 64
        ? previewStartupBoundaries(importStarted, loadedAt, entryAt) : [])];
  };
}
