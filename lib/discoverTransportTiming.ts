import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

type Trace = { start: number; requests: number; sends: number; responses: number;
  created?: number; sent?: number; headers?: number; closed: boolean };
export type DiscoverTransportTiming = {
  requests: number; sends: number; responses: number;
  phases?: { prepare: number; dispatch: number; response: number; resume: number };
};
const active = new AsyncLocalStorage<Trace>();
const requests = new WeakMap<object, Trace>();
let subscribed = false;

// Passive native-fetch observation. Request objects are weak correlation keys;
// no URL, header, cookie, body, socket or error detail is read or retained.
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  for (const [name, stage] of [
    ['undici:request:create', 'created'],
    ['undici:client:sendHeaders', 'sent'],
    ['undici:request:headers', 'headers'],
  ] as const) channel(name).subscribe(message => {
    try {
      const request = (message as {request?: unknown})?.request;
      if (!request || typeof request !== 'object') return;
      const trace = stage === 'created' ? active.getStore() : requests.get(request);
      if (!trace || trace.closed) return;
      const at = performance.now();
      if (stage === 'created') { requests.set(request, trace); trace.requests++; }
      else if (stage === 'sent') trace.sends++;
      else trace.responses++;
      trace[stage] ??= at;
    } catch { /* Diagnostics callbacks must never throw into the transport. */ }
  });
}

export async function observeDiscoverTransport<T>(work: () => Promise<T>, record: (value: DiscoverTransportTiming) => void): Promise<T> {
  subscribe();
  const trace: Trace = {start:performance.now(),requests:0,sends:0,responses:0,closed:false};
  try { return await active.run(trace, work); }
  finally {
    trace.closed = true;
    try {
      const end = performance.now();
      const times = [trace.start,trace.created,trace.sent,trace.headers,end];
      // Redirects/retries can create multiple physical requests. Do not assign
      // one request's send timestamp to another request's response timestamp.
      const complete = trace.requests === 1 && trace.sends === 1 && trace.responses === 1 &&
        times.every((value,index) => typeof value === 'number' && Number.isFinite(value) &&
          (index === 0 || value >= times[index-1]!));
      record({requests:trace.requests,sends:trace.sends,responses:trace.responses,
        ...(complete ? {phases:{prepare:trace.created!-trace.start,dispatch:trace.sent!-trace.created!,
          response:trace.headers!-trace.sent!,resume:end-trace.headers!}} : {})});
    } catch { /* Preserve the original response or rejection if observation fails. */ }
  }
}
