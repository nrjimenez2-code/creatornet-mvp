import { discoverTimingEnabled } from './discoverTimingLog';

// One numeric record per JS realm, shared across separately bundled route and
// instrumentation modules. No request data or process/instance identifier.
const key = Symbol.for('creatornet.startup-timing.v1');
type Startup = { started: number; imported?: number; registering?: number; ready?: number };
const state = globalThis as typeof globalThis & { [key]?: Startup };

export function markServerStartup(phase: 'start' | 'imported' | 'registering' | 'ready') {
  try {
    if (!discoverTimingEnabled()) return;
    const now = performance.now();
    if (!Number.isFinite(now) || now < 0) return;
    if (phase === 'start') { state[key] ??= { started: now }; return; }
    const record = state[key];
    if (!record || now < record.started) return;
    if (phase === 'imported') record.imported ??= now;
    if (phase === 'registering') record.registering ??= now;
    if (phase === 'ready' && record.registering !== undefined) record.ready ??= now;
  } catch { /* Diagnostics cannot interrupt startup or error monitoring. */ }
}

export function serverStartupMetrics(): string[] {
  try {
    if (!discoverTimingEnabled()) return [];
    const record = state[key];
    if (!record) return [];
    const metrics = [`bootcomplete;dur=${record.ready === undefined ? 0 : 1}`];
    const duration = (name: string, start: number, end?: number) => {
      if (end !== undefined && Number.isFinite(end - start) && end >= start)
        metrics.push(`${name};dur=${(end - start).toFixed(1)}`);
    };
    duration('bootimports', record.started, record.imported);
    if (record.registering !== undefined) duration('bootregister', record.registering, record.ready);
    duration('bootage', record.started, performance.now());
    return metrics;
  } catch { return []; }
}

// Numeric offsets on the same monotonic clock, never request phases. Preview
// only; no new production logging, collector, timer, identifier or state.
export function previewStartupBoundaries(importStart: number, loadedAt: number, entryAt: number): string[] {
  try {
    if (process.env.VERCEL_ENV !== 'preview') return [];
    if (![importStart, loadedAt, entryAt].every(n => Number.isFinite(n) && n >= 0) ||
        importStart > loadedAt || loadedAt > entryAt) return [];
    const metrics: string[] = [];
    const add = (name: string, value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= entryAt)
        metrics.push(`${name};dur=${value.toFixed(1)}`);
    };
    add('routeimportstart', importStart);
    add('routeimports', loadedAt - importStart);
    add('handlerentry', entryAt);
    const record = state[key];
    add('bootstart', record?.started);
    add('bootready', record?.ready);
    // Node exposes these on global performance; Edge/missing milestones omit.
    const node = (performance as typeof performance & {
      nodeTiming?: { nodeStart?: number; bootstrapComplete?: number; loopStart?: number }
    }).nodeTiming;
    add('nodestart', node?.nodeStart);
    add('nodebootstrap', node?.bootstrapComplete);
    add('nodeloopstart', node?.loopStart);
    return metrics;
  } catch { return []; }
}
