// Passive diagnostics for Node's existing native fetch. No dispatcher, socket,
// headers, request body or response body is changed or serialized here.
const { AsyncLocalStorage } = require('node:async_hooks');
const diagnosticsChannel = require('node:diagnostics_channel');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const round = value => Math.round(value * 10) / 10;

function createFetchDiagnostics(options = {}) {
  const { intervalMs = 1000, resolutionMs = 10, maxIntervals = 7200,
    maxSlowWrites = 2000, slowWriteMs = 5 } = options;
  if (![intervalMs, resolutionMs, maxIntervals, maxSlowWrites].every(n => Number.isInteger(n) && n > 0) ||
      !Number.isFinite(slowWriteMs) || slowWriteMs < 0) throw new Error('Invalid diagnostic options');
  const started = performance.now();
  const context = new AsyncLocalStorage();
  const requests = new WeakMap(), sockets = new WeakMap();
  const intervals = [], slowWrites = [], subscriptions = [];
  const writes = { journal: { count: 0, totalMs: 0, maxMs: 0 }, checkpoint: { count: 0, totalMs: 0, maxMs: 0 } };
  let socketCount = 0, diagnosticErrors = 0, callbackCount = 0, callbackMs = 0, callbackMaxMs = 0;
  let droppedIntervals = 0, droppedSlowWrites = 0, closed = false;
  let previousAt = started, previousElu = performance.eventLoopUtilization();
  const delay = monitorEventLoopDelay({ resolution: resolutionMs });
  delay.enable();

  const boundedAppend = (list, value, limit, dropped) => {
    if (list.length < limit) list.push(value);
    else dropped();
  };
  const subscribe = (name, handler) => {
    const channel = diagnosticsChannel.channel(name);
    const callback = message => {
      const began = performance.now();
      try { handler(message, began); }
      catch { diagnosticErrors++; } // Diagnostics must never alter request behavior.
      finally {
        const elapsed = performance.now() - began;
        callbackCount++; callbackMs += elapsed; callbackMaxMs = Math.max(callbackMaxMs, elapsed);
      }
    };
    channel.subscribe(callback);
    subscriptions.push(() => channel.unsubscribe(callback));
  };
  const socketInfo = socket => {
    let info = sockets.get(socket);
    if (!info) { info = { ordinal: ++socketCount, uses: 0 }; sockets.set(socket, info); }
    return info;
  };
  subscribe('undici:request:create', ({ request }, now) => {
    const trace = context.getStore();
    if (!trace) return;
    requests.set(request, trace);
    trace.requestCount++;
    trace.created ??= now;
  });
  // Connection events cannot be assigned to the actor that happens to be
  // running. Attach an age only after sendHeaders identifies the actual socket.
  subscribe('undici:client:connected', ({ socket }, now) => {
    socketInfo(socket).connected = now;
  });
  subscribe('undici:client:sendHeaders', ({ request, socket }, now) => {
    const trace = requests.get(request);
    if (!trace) return;
    const info = socketInfo(socket);
    info.uses++;
    trace.sendCount++;
    if (trace.sent === undefined) {
      trace.sent = now;
      trace.socketOrdinal = info.ordinal;
      trace.socketUse = info.uses;
      if (info.connected !== undefined) trace.socketConnected = info.connected;
    }
  });
  for (const [channel, field] of [
    ['undici:request:bodySent', 'bodySent'],
    ['undici:request:headers', 'headers'],
    ['undici:request:trailers', 'bodyEnded'],
    ['undici:request:error', 'error'],
  ]) subscribe(channel, ({ request }, now) => {
    const trace = requests.get(request);
    if (trace) trace[field] ??= now;
  });

  function sampleLoop() {
    const now = performance.now();
    const currentElu = performance.eventLoopUtilization();
    const change = performance.eventLoopUtilization(currentElu, previousElu);
    boundedAppend(intervals, {
      atMs: round(now - started), spanMs: round(now - previousAt),
      timerLateMs: round(Math.max(0, now - previousAt - intervalMs)),
      activeMs: round(change.active), idleMs: round(change.idle),
      delaySamples: Number(delay.count),
      delayP95Ms: delay.count ? round(delay.percentile(95) / 1e6) : 0,
      delayMaxMs: delay.count ? round(delay.max / 1e6) : 0,
    }, maxIntervals, () => droppedIntervals++);
    previousAt = now; previousElu = currentElu; delay.reset();
  }
  const timer = setInterval(sampleLoop, intervalMs);
  timer.unref();

  return {
    trace(start = performance.now()) {
      if (closed) throw new Error('Diagnostics closed');
      const record = { start, requestCount: 0, sendCount: 0 };
      return {
        run: work => context.run(record, work),
        fetchResolved: () => { record.fetchResolved ??= performance.now(); },
        jsonResolved: () => { record.jsonResolved ??= performance.now(); },
        summary() {
          const result = { atMs: round(record.start - started), requestCount: record.requestCount, sendCount: record.sendCount };
          for (const [field, output] of [
            ['created', 'createMs'], ['sent', 'sendMs'], ['bodySent', 'requestBodySentMs'],
            ['headers', 'responseHeadersMs'], ['bodyEnded', 'responseBodyEndMs'],
            ['fetchResolved', 'fetchResolvedMs'], ['jsonResolved', 'jsonResolvedMs'], ['error', 'errorMs'],
          ]) if (Number.isFinite(record[field])) result[output] = round(record[field] - record.start);
          if (record.socketOrdinal !== undefined) {
            result.socketOrdinal = record.socketOrdinal;
            result.socketUse = record.socketUse;
            result.reusedSocket = Number(record.socketUse > 1);
          }
          for (const [from, to, name] of [
            ['start', 'sent', 'beforeSendMs'], ['sent', 'headers', 'responseWaitMs'],
            ['headers', 'bodyEnded', 'bodyReceiveMs'], ['bodyEnded', 'jsonResolved', 'afterBodyToJsonMs'],
            ['headers', 'fetchResolved', 'headersToFetchMs'], ['socketConnected', 'sent', 'socketAgeMs'],
          ]) if (Number.isFinite(record[from]) && Number.isFinite(record[to]) && record[to] >= record[from])
            result[name] = round(record[to] - record[from]);
          return result;
        },
      };
    },
    measureWrite(kind, work) {
      if (!Object.hasOwn(writes, kind)) throw new Error('Unknown diagnostic write kind');
      const began = performance.now();
      try { return work(); }
      finally {
        const elapsed = performance.now() - began, group = writes[kind];
        group.count++; group.totalMs += elapsed; group.maxMs = Math.max(group.maxMs, elapsed);
        if (elapsed >= slowWriteMs) boundedAppend(slowWrites, {
          atMs: round(began - started), durationMs: round(elapsed), kind,
        }, maxSlowWrites, () => droppedSlowWrites++);
      }
    },
    snapshot() {
      return {
        version: 1, node: process.version, undici: process.versions.undici ?? null,
        elapsedMs: round(performance.now() - started), intervalMs, resolutionMs,
        maxIntervals, maxSlowWrites, slowWriteMs, closed,
        diagnosticErrors, callbackCount, callbackTotalMs: round(callbackMs), callbackMaxMs: round(callbackMaxMs),
        observedSockets: socketCount, droppedIntervals, droppedSlowWrites,
        writes: Object.fromEntries(Object.entries(writes).map(([kind, group]) => [kind, {
          count: group.count, totalMs: round(group.totalMs), maxMs: round(group.maxMs),
        }])),
        intervals: intervals.slice(), slowWrites: slowWrites.slice(),
        limitations: 'Passive native-fetch observation. Missing phases are unavailable, not zero. Multiple sends/requests require individual review. Socket reuse counts observed tracked sends. Before-send combines scheduling/connection setup/local stalls; response-wait combines network/platform/handler work. No request-specific DNS/TLS phases. Body end is the Undici transport event, before fetch decompression/JSON completion. Event-loop intervals and slow writes are bounded; dropped counts are explicit. The final report write cannot include its own completed duration.',
      };
    },
    close() {
      if (closed) return;
      clearInterval(timer); sampleLoop(); delay.disable();
      subscriptions.forEach(unsubscribe => unsubscribe());
      closed = true;
    },
  };
}

module.exports = { createFetchDiagnostics };
