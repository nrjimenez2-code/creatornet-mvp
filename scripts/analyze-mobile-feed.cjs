const fs = require('node:fs');

function percentile(values, fraction = 0.95) {
  if (!values.length) return null;
  const value = [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}
function analyze(runs) {
  const groups = new Map(), failures = [], invalidRuns = [], delays = new Map();
  const seenRuns = new Set();
  for (const [index, run] of runs.entries()) {
    const context = run.context ?? {};
    const id = context.runId || `missing-run-id-${index}`;
    const missing = ['runId', 'buildCommit', 'surface', 'feed', 'mode', 'iosVersion', 'network', 'powerMode', 'temperature', 'recordingId'].filter(field => !context[field]);
    if (context.surface === 'instagram' && !context.instagramVersion) missing.push('instagramVersion');
    if (run.schema !== 1 || !Array.isArray(run.events)) { invalidRuns.push({ run: id, reason: 'Unsupported trace schema' }); continue; }
    if (missing.length) invalidRuns.push({ run: id, reason: 'Missing run context', fields: missing });
    if (run.droppedEvents) invalidRuns.push({ run: id, reason: 'History truncated', droppedEvents: run.droppedEvents });
    if (seenRuns.has(id)) { invalidRuns.push({ run: id, reason: 'Duplicate run ID; not counted twice' }); continue; }
    seenRuns.add(id);
    const tabs = new Set(run.events.filter(event => event.kind === 'feed-surface').map(event => event.detail.tab));
    if (tabs.size > 1) invalidRuns.push({ run: id, reason: 'Multiple feed tabs in one run; export each tab separately' });
    // Separate cold/constrained conditions and unlike device/build conditions.
    const dimensions = ['mode', 'buildCommit', 'surface', 'feed', 'network', 'iosVersion', 'instagramVersion', 'powerMode', 'temperature'];
    const key = JSON.stringify(dimensions.map(field => context[field] ?? null));
    if (!groups.has(key)) groups.set(key, { context, runs: new Set(), transitions: 0, warmed: [], cold: [], preparationMisses: 0, failures: 0, scrolling: [] });
    const group = groups.get(key); group.runs.add(id);
    const activations = new Map();
    for (const event of run.events) {
      if (event.kind === 'activation') activations.set(event.activation, { start: event, events: [] });
      activations.get(event.activation)?.events.push(event);
      if (event.kind === 'preparation-miss') group.preparationMisses++;
      if (event.kind === 'scroll-settle') group.scrolling.push(event.detail);
      if (['media-error', 'fallback-held', 'preparation-miss', 'handoff-timeout', 'resume-seek-timeout', 'seek-timeout', 'bridge-play-rejected'].includes(event.kind) ||
          (['frame-gap', 'stall-end'].includes(event.kind) && event.detail.durationMs > 250)) {
        failures.push({ run: id, sequence: event.sequence, activation: event.activation, kind: event.kind, detail: event.detail }); group.failures++;
      }
    }
    for (const { start, events } of activations.values()) {
      group.transitions++;
      const first = kind => events.find(event => event.kind === kind);
      const audible = first('moving-frame');
      const bridge = first('moving-presentation');
      const cover = first('cover-removal') ?? first('presentation-handoff');
      const mainVisibleAt = audible && cover ? Math.max(audible.at, cover.at) : Infinity;
      const presentedAt = Math.min(bridge?.at ?? Infinity, mainVisibleAt);
      const latency = Number.isFinite(presentedAt) ? presentedAt - start.at : Infinity;
      const result = { run: id, activation: start.activation, postId: start.postId, latencyMs: Number.isFinite(latency) ? latency : null, audiblePlayerMovingMs: audible ? audible.at - start.at : null, complete: Number.isFinite(latency) };
      (start.detail.warmEligible === true ? group.warmed : group.cold).push(result);
      if (!result.complete) { failures.push({ run: id, activation: start.activation, kind: 'no-moving-presentation', warmEligible: start.detail.warmEligible }); group.failures++; }
      for (const kind of ['metadata', 'seek-complete', 'play-request', 'moving-presentation', 'moving-frame', 'cover-removal']) {
        const event = first(kind); if (!event) continue;
        const delayKey = `${key}:${kind}`;
        if (!delays.has(delayKey)) delays.set(delayKey, { context, metric: `activation-to-${kind}`, values: [] });
        delays.get(delayKey).values.push(event.at - start.at);
      }
    }
  }
  const cohorts = [...groups.values()].map(group => {
    const values = group.warmed.map(row => row.latencyMs ?? Infinity);
    const missing = group.warmed.filter(row => !row.complete).length;
    const p95 = percentile(values);
    return { context: group.context, runs: group.runs.size, transitions: group.transitions, warmedTransitions: values.length, warmedMissingPresentation: missing,
      warmedP95Ms: p95, warmedWithin150ms: values.length > 0 && missing === 0 && p95 !== null && p95 <= 150,
      sampleGate: values.length >= 100 && group.runs.size >= 3, preparationMisses: group.preparationMisses,
      coldTransitions: group.cold, warmed: group.warmed, failureCount: group.failures, scrolling: group.scrolling };
  });
  return { schema: 1, acceptance: 'NOT_ESTABLISHED', reason: 'Traces measure compositor submissions and main-thread scheduling. Phone recordings, audible output, same-phone TikTok comparison, quality and resource review remain required.',
    invalidRuns, cohorts, failures,
    rankedDelays: [...delays.values()].map(row => ({ context: row.context, metric: row.metric, samples: row.values.length, p95Ms: percentile(row.values) })).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0)) };
}
module.exports = { analyze, percentile };
if (require.main === module) {
  const paths = process.argv.slice(2);
  if (!paths.length) { console.error('Usage: node scripts/analyze-mobile-feed.cjs run-1.json run-2.json ...'); process.exitCode = 1; }
  else console.log(JSON.stringify(analyze(paths.map(file => JSON.parse(fs.readFileSync(file, 'utf8')))), null, 2));
}
