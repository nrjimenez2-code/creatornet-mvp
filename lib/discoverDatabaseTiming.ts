import { AsyncLocalStorage } from 'node:async_hooks';
import { performance as nodePerformance } from 'node:perf_hooks';
import { discoverTimingEnabled } from './discoverTimingLog';
import { observeDiscoverTransport, type DiscoverTransportTiming } from './discoverTransportTiming';

type Timing = { count: number; totalMs: number; maxMs: number; upstreamMs: number; upstreamCount: number;
  transport: { count:number; requests:number; sends:number; responses:number; prepare:number; dispatch:number; response:number; responseMax:number; resume:number };
  loopStart: ReturnType<typeof nodePerformance.eventLoopUtilization> };
const timing = new AsyncLocalStorage<Timing>();

export function withDiscoverDatabaseTiming<T>(work: () => T): T {
  if (!discoverTimingEnabled()) return work();
  return timing.run({ count: 0, totalMs: 0, maxMs: 0, upstreamMs: 0, upstreamCount: 0,
    transport:{count:0,requests:0,sends:0,responses:0,prepare:0,dispatch:0,response:0,responseMax:0,resume:0},
    loopStart: nodePerformance.eventLoopUtilization() }, work);
}

// Only numeric timings are retained. URLs, headers, bodies and credentials are
// never stored. Total is the sum of requests and can overlap when parallel.
export const timedDatabaseFetch: typeof fetch = async (input, init) => {
  const current = timing.getStore();
  if (!current) return fetch(input, init);
  const start = performance.now();
  try {
    const response = await observeDiscoverTransport(() => fetch(input, init), (observed: DiscoverTransportTiming) => {
      const sum = current.transport;
      sum.requests += observed.requests; sum.sends += observed.sends; sum.responses += observed.responses;
      if (observed.phases) {
        sum.count++; sum.prepare += observed.phases.prepare; sum.dispatch += observed.phases.dispatch;
        sum.response += observed.phases.response; sum.responseMax = Math.max(sum.responseMax,observed.phases.response);
        sum.resume += observed.phases.resume;
      }
    });
    const upstream = response.headers.get('x-envoy-upstream-service-time');
    if (upstream && /^\d{1,9}(?:\.\d{1,3})?$/.test(upstream)) {
      current.upstreamMs += Number(upstream);
      current.upstreamCount++;
    }
    return response;
  }
  finally {
    const elapsed = performance.now() - start;
    current.count++;
    current.totalMs += elapsed;
    current.maxMs = Math.max(current.maxMs, elapsed);
  }
};

export function discoverDatabaseTimingHeader(): string[] {
  const current = timing.getStore();
  // Process activity during this request includes work for overlapping requests.
  // It distinguishes a busy JS process from idle network/service wait.
  const loop = current ? nodePerformance.eventLoopUtilization(current.loopStart) : null;
  return current ? [
    `dbtotal;dur=${current.totalMs.toFixed(1)}`,
    `dbmax;dur=${current.maxMs.toFixed(1)}`,
    `dbcount;dur=${current.count}`,
    `upstream;dur=${current.upstreamMs.toFixed(1)}`,
    `upstreamcount;dur=${current.upstreamCount}`,
    `dbtransportcount;dur=${current.transport.count}`,
    `dbrequestcount;dur=${current.transport.requests}`,
    `dbsendcount;dur=${current.transport.sends}`,
    `dbresponsecount;dur=${current.transport.responses}`,
    ...(current.transport.count ? [
      `dbprepare;dur=${current.transport.prepare.toFixed(1)}`,
      `dbdispatch;dur=${current.transport.dispatch.toFixed(1)}`,
      `dbresponse;dur=${current.transport.response.toFixed(1)}`,
      `dbresponsemax;dur=${current.transport.responseMax.toFixed(1)}`,
      `dbresume;dur=${current.transport.resume.toFixed(1)}`,
    ] : []),
    `loopbusy;dur=${loop!.active.toFixed(1)}`,
    `loopidle;dur=${loop!.idle.toFixed(1)}`,
  ] : [];
}
