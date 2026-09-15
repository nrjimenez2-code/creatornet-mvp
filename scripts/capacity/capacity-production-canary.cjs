'use strict';
// Prepared production canary. Importing this module never starts a workload.
// Adapted from capacity-active-feed.cjs; staging behavior remains unchanged.
const fsDefault = require('node:fs');
const path = require('node:path');
const { setTimeout: sleepDefault } = require('node:timers/promises');
const { performance: performanceDefault } = require('node:perf_hooks');
const { createFetchDiagnostics } = require('./capacity-fetch-diagnostics.cjs');
const { readVercelCorrelation } = require('./capacity-response-correlation.cjs');
const MODE = 'production-canary';
const PROJECT = 'rvkqxgghqitkwzdsuclz';
const ORIGIN = 'https://www.creatornet.net';
const COMMIT_VERIFICATION = 'Operator-verified expected SHA; not server-attested by these responses.';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_FEED_PAGES = 6;

function validateConfiguration(configuration) {
  const { commit, stages, name, postsPerActor, primingJourneys } = configuration ?? {};
  if (Object.keys(configuration ?? {}).some(key => !['commit','stages','name','postsPerActor','primingJourneys'].includes(key)) ||
      !SHA.test(commit ?? '') || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name ?? '') ||
      !Array.isArray(stages) || stages.length === 0 || stages.length > 3 ||
      stages.some((n, i) => !Number.isInteger(n) || n < 1 || n > 50 || (i > 0 && n <= stages[i - 1])) ||
      !Number.isInteger(postsPerActor) || postsPerActor < 3 || postsPerActor > 6 || ![0, 1].includes(primingJourneys))
    throw new Error('Invalid production canary configuration');
  return Object.freeze({ commit, stages: Object.freeze([...stages]), name, postsPerActor, primingJourneys });
}
function parseCanaryArguments(argv) {
  if (argv[0] !== '--production' || argv.length < 4 || argv.length > 6)
    throw new Error('Usage: --production EXPECTED_SHA STAGES NAME [POSTS_3_TO_6] [PRIME_0_OR_1]');
  const [, commit, stageArg, name, postsArg = '3', primeArg = '0'] = argv;
  if (!/^\d+(?:,\d+)*$/.test(stageArg ?? '') || !/^[3-6]$/.test(postsArg) || !/^[01]$/.test(primeArg))
    throw new Error('Invalid production canary arguments');
  return validateConfiguration({ commit, stages: stageArg.split(',').map(Number), name,
    postsPerActor: Number(postsArg), primingJourneys: Number(primeArg) });
}
function outputPaths(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name ?? '')) throw new Error('Invalid production run name');
  const folder = path.join(__dirname, '../outputs');
  return Object.freeze({ report: path.join(folder, `capacity-prod-${name}.json`),
    fixture: path.join(folder, `capacity-prod-${name}-cleanup.json`),
    journal: path.join(folder, `capacity-prod-${name}-fixtures.jsonl`),
    correlation: path.join(folder, `capacity-prod-${name}-correlation.json`) });
}
function writeAtomicSnapshot(fs, file, text, purpose = 'checkpoint') {
  const temporary = file + '.' + purpose + '.tmp';
  // A failed/interrupted write leaves its temporary file for inspection while
  // the previous canonical snapshot remains complete. Never overwrite a temp.
  fs.writeFileSync(temporary, text, { flag: 'wx' });
  fs.renameSync(temporary, file);
}
function assertAllowedRequest(input, init = {}) {
  const url = new URL(input), method = init.method ?? 'GET';
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw new Error('Canary destination rejected');
  const headers = Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]);
  if (headers.some(([key]) => !['content-type', 'x-cn-discover-actor'].includes(key))) throw new Error('Canary header rejected');
  const token = headers.find(([key]) => key === 'x-cn-discover-actor')?.[1];
  if (token !== undefined && !TOKEN.test(token)) throw new Error('Canary actor token rejected');
  if (method === 'GET' && url.pathname === '/api/feed' && init.body === undefined) {
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some(key => !['tab','offset','limit','session'].includes(key)) ||
        url.searchParams.get('tab') !== 'discover' || url.searchParams.get('limit') !== '20' ||
        !/^\d+$/.test(url.searchParams.get('offset') ?? '') || !Number.isSafeInteger(Number(url.searchParams.get('offset'))) ||
        (url.searchParams.has('session') && !UUID.test(url.searchParams.get('session'))))
      throw new Error('Canary feed query rejected');
    return;
  }
  if (method === 'POST' && url.pathname === '/api/feed-events' && !url.search && token !== undefined) {
    let body; try { body = JSON.parse(init.body); } catch { throw new Error('Canary event rejected'); }
    if (!body || Object.keys(body).some(key => !['session','postId','kind','watchSeconds'].includes(key)) ||
        !UUID.test(body.session ?? '') || !UUID.test(body.postId ?? '') || !['exposure','watch'].includes(body.kind) ||
        (body.kind === 'exposure' && body.watchSeconds !== undefined) ||
        (body.kind === 'watch' && (typeof body.watchSeconds !== 'number' || !Number.isFinite(body.watchSeconds) || body.watchSeconds < 0)))
      throw new Error('Canary event rejected');
    return;
  }
  throw new Error('Canary method or endpoint rejected');
}

async function runProductionCanary(rawConfiguration, ports = {}) {
  const config = validateConfiguration(rawConfiguration);
  const fs = ports.fs ?? fsDefault, fetch = ports.fetch ?? globalThis.fetch,
    sleep = ports.sleep ?? sleepDefault, performance = ports.performance ?? performanceDefault,
    dateNow = ports.dateNow ?? (() => new Date().toISOString()), log = ports.log ?? (value => console.log(JSON.stringify(value)));
  const files = outputPaths(config.name);
  if ([...Object.values(files), ...[files.report, files.fixture, files.correlation].map(file => file + '.checkpoint.tmp')]
    .some(file => fs.existsSync(file))) throw new Error('Production canary output already exists');
  // Exclusive creation reserves every output before any network request. A
  // failed reservation can leave empty local files but cannot start traffic.
  for (const file of Object.values(files)) fs.writeFileSync(file, '', { flag: 'wx' });
  const diagnostics = (ports.diagnosticsFactory ?? createFetchDiagnostics)();
  const metadata = Object.freeze({ mode: MODE, project: PROJECT, origin: ORIGIN, commit: config.commit,
    commitVerification: COMMIT_VERIFICATION, name: config.name, startedAt: dateNow() });
  const fixtures = [], samples = [], groups = [], activity = [], correlations = [];
  const correlationCounts = { present: 0, missing: 0, invalid: 0, unavailable: 0 };
  const pendingFeedIntents = new Map();
  const sessionJourneys = new Map();
  const actorJourneys = new Map();
  let active = 0, abortRamp = false, lastCheckpoint = -Infinity;
  const safeError = error => ['AbortError','TimeoutError'].includes(error?.name) ? error.name : 'Error';
  const percentile = (rows, quantile) => {
    const values = rows.map(row => row.ms).sort((a, b) => a - b);
    return values[Math.ceil(values.length * quantile) - 1] ?? null;
  };
  function journal(row) {
    diagnostics.measureWrite('journal', () => fs.appendFileSync(files.journal, JSON.stringify({ ...metadata, ...row }) + '\n'));
  }
  const report = () => ({ ...metadata, endedAt: dateNow(), configuration: { ...config, pageSize: 20,
    maximumConcurrentViewers: 50, maximumFeedPagesPerJourney: MAX_FEED_PAGES,
    maximumRequestsPerJourney: MAX_FEED_PAGES + config.postsPerActor * 3 + 1,
    viewingSecondsPerPost: 10, watchIntervalSeconds: 5,
    actualWaitBetweenSamplesMs: 5100, maximumArrivalWindowMs: 5000, anonymousOnly: true },
    groups, samples, activity, clientDiagnostics: diagnostics.snapshot(), correlationCounts,
    unresolvedFeedIntents: [...pendingFeedIntents.values()],
    limitations: 'Bounded production canary using synthetic anonymous HTTP viewing claims and real elapsed waits. No video playback, media delivery, UI rendering, signed-in users, commercial events or large-catalog fixture creation. Slow responses reduce offered load. This is not 1,000-user or smooth-UX acceptance. Tokens remain only in memory. Expected SHA is operator-verified metadata, not server-attested. Unknown first-page sessions after an interrupted response require separate authoritative reconciliation.' });
  function persist(force = false) {
    if (!force && performance.now() - lastCheckpoint < 1000) return;
    lastCheckpoint = performance.now();
    diagnostics.measureWrite('checkpoint', () => {
      writeAtomicSnapshot(fs, files.fixture, JSON.stringify({ ...metadata, fixtures,
        unresolvedFeedIntents: [...pendingFeedIntents.values()] }, null, 2));
      writeAtomicSnapshot(fs, files.report, JSON.stringify(report(), null, 2));
      writeAtomicSnapshot(fs, files.correlation, JSON.stringify({ ...metadata, source: path.basename(files.report),
        counts: correlationCounts, samples: correlations,
        limitations: 'Only allowlisted x-vercel-id values; mapping to dashboard request IDs remains unverified.' }, null, 2));
    });
  }
  async function journey(concurrency, index) {
    await sleep(index * Math.min(1000, 5000 / Math.max(1, concurrency - 1)));
    if (abortRamp) return;
    active++; activity.push({ at: dateNow(), active, concurrency });
    const journeyKey = concurrency + ':' + index;
    let token, session, offset = 0, feedPages = 0, issuedRequests = 0;
    const seen = new Set();
    async function request(kind, url, init, validate, intent, extra = {}) {
      if (issuedRequests >= MAX_FEED_PAGES + config.postsPerActor * 3 + 1) throw new Error('Request budget exceeded');
      issuedRequests++;
      const start = performance.now(), at = dateNow(), transport = diagnostics.trace(start);
      let correlationStatus, recorded = false;
      return transport.run(async () => {
        try {
          assertAllowedRequest(url, init);
          // First-page GET also creates a snapshot: log its intent before the
          // call, then associate its returned session in a separate journal row.
          journal({ journeyKey, ...intent });
          if (intent.phase === 'feed-intent') pendingFeedIntents.set(journeyKey, { journeyKey, offset: intent.offset,
            ...(intent.session ? { session: intent.session, actor: intent.actor } : {}) });
          if (intent.phase === 'event-intent') {
            const fixture = fixtures.find(value => value.session === intent.session && value.actor === intent.actor);
            if (!fixture) throw new Error('Unknown event fixture');
            if (!fixture.posts.includes(intent.postId)) fixture.posts.push(intent.postId);
          }
          const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
          transport.fetchResolved();
          const correlation = readVercelCorrelation(response.headers.get('x-vercel-id'));
          correlationStatus = correlation.status; correlationCounts[correlationStatus]++;
          if (correlation.status === 'present') correlations.push({ concurrency, index, kind,
            ...(extra.postIndex === undefined ? {} : { postIndex: extra.postIndex }), at, vercelId: correlation.value });
          const data = await response.json(); transport.jsonResolved();
          const valid = response.ok && validate(data), timing = {};
          for (const match of (response.headers.get('server-timing') ?? '').matchAll(/(?:^|,\s*)(identity|context|sample|media|write|session|page|dbtotal|dbmax|dbcount|upstream|upstreamcount|loopbusy|loopidle|routeage|uptime|invocation|total);dur=([\d.]+)(?=,|$)/g)) {
            const value = Number(match[2]); if (Number.isFinite(value) && value >= 0) timing[match[1]] = value;
          }
          samples.push({ concurrency, index, kind, at, ms: Math.round(performance.now() - start),
            status: response.status, valid, timing, transport: transport.summary(), correlationStatus, ...extra });
          recorded = true;
          if (!valid) throw new Error('Invalid response');
          return data;
        } catch (error) {
          if (correlationStatus === undefined) { correlationStatus = 'unavailable'; correlationCounts.unavailable++; }
          if (!recorded) samples.push({ concurrency, index, kind, at, ms: Math.round(performance.now() - start),
            status: null, valid: false, error: safeError(error), transport: transport.summary(), correlationStatus, ...extra });
          abortRamp = true; throw error;
        }
      });
    }
    try {
      const queue = [];
      let hasMore = true, viewed = 0;
      while (viewed < config.postsPerActor && !abortRamp) {
        if (!queue.length) {
          if (!hasMore) break;
          if (feedPages >= MAX_FEED_PAGES) throw new Error('Feed page budget exceeded');
          feedPages++;
          const params = new URLSearchParams({ tab: 'discover', limit: '20', offset: String(offset) });
          if (session) params.set('session', session);
          const page = await request(offset ? 'feed-next' : 'feed-first', ORIGIN + '/api/feed?' + params,
            { headers: token ? { 'x-cn-discover-actor': token } : {} }, data =>
              Array.isArray(data.items) && data.items.length <= 20 && data.items.every(item => UUID.test(item?.post_id ?? '')) &&
              UUID.test(data.session ?? '') && (!session || session === data.session) &&
              Number.isSafeInteger(data.nextOffset) && data.nextOffset >= offset && typeof data.hasMore === 'boolean' &&
              (!data.hasMore || data.nextOffset > offset) && TOKEN.test(data.actorToken ?? ''),
            { phase: 'feed-intent', offset, ...(session ? { session, actor: 'anon:' + token.split('.')[0] } : {}) });
          const actor = 'anon:' + page.actorToken.split('.')[0];
          if (token && actor !== 'anon:' + token.split('.')[0]) throw new Error('Actor changed');
          if (sessionJourneys.has(page.session) && sessionJourneys.get(page.session) !== journeyKey)
            throw new Error('Session shared by independent journeys');
          token = page.actorToken; session = page.session; offset = page.nextOffset; hasMore = page.hasMore;
          journal({ phase: 'feed-result', journeyKey, actor, session });
          sessionJourneys.set(session, journeyKey);
          pendingFeedIntents.delete(journeyKey);
          if (!fixtures.some(fixture => fixture.session === session)) fixtures.push({ actor, session, posts: [] });
          // Retain observed session IDs for exact cleanup even if a repeated
          // actor invalidates the independent-viewer measurement.
          if (actorJourneys.has(actor) && actorJourneys.get(actor) !== journeyKey)
            throw new Error('Actor shared by independent journeys');
          actorJourneys.set(actor, journeyKey);
          persist();
          for (const item of page.items) {
            if (seen.has(item.post_id)) throw new Error('Duplicate page item');
            seen.add(item.post_id); queue.push(item.post_id);
          }
        }
        const postId = queue.shift();
        if (!postId) continue;
        const fixture = fixtures.find(value => value.session === session);
        const event = (kind, watchSeconds, retry = false) => request(kind, ORIGIN + '/api/feed-events', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cn-discover-actor': token },
          body: JSON.stringify({ session, postId, kind, ...(kind === 'watch' ? { watchSeconds } : {}) }),
        }, data => data.ok === true && data.enabled !== false,
        { phase: 'event-intent', actor: fixture.actor, session, postId, eventKind: kind,
          ...(kind === 'watch' ? { watchSeconds } : {}) }, { postIndex: viewed, watchSeconds, retry });
        await event('exposure');
        for (const seconds of [5, 10]) {
          await sleep(5100);
          if (abortRamp) break;
          await event('watch', seconds);
        }
        if (abortRamp) break;
        if (viewed === 0) await event('watch', 10, true);
        viewed++;
      }
      if (viewed !== config.postsPerActor) abortRamp = true;
      samples.push({ concurrency, index, kind: 'journey', valid: viewed === config.postsPerActor, viewedPosts: viewed,
        availableItems: seen.size, exhaustedCatalog: !hasMore, paginationExercised: offset > 20 });
    } catch (error) {
      abortRamp = true;
      samples.push({ concurrency, index, kind: 'journey', valid: false,
        error: ['Duplicate page item','Feed page budget exceeded','Request budget exceeded','Actor shared by independent journeys']
          .includes(error.message) ? error.message : safeError(error) });
    } finally {
      active--; activity.push({ at: dateNow(), active, concurrency });
      try { persist(); } catch (error) { abortRamp = true; throw error; }
    }
  }
  try {
    persist(true);
    if (config.primingJourneys) {
      await journey(0, 0);
      if (abortRamp) throw new Error('Priming failed');
      log({ mode: MODE, primingComplete: true, excludedFromMeasuredStages: true });
    }
    for (const concurrency of config.stages) {
      const stageStart = performance.now();
      const results = await Promise.allSettled(Array.from({ length: concurrency }, (_, index) => journey(concurrency, index)));
      if (results.some(result => result.status === 'rejected')) throw new Error('Canary reporting failed after started journeys settled');
      const rows = samples.filter(row => row.concurrency === concurrency && row.kind !== 'journey');
      const feed = rows.filter(row => row.kind.startsWith('feed')), telemetry = rows.filter(row => !row.kind.startsWith('feed'));
      const errors = rows.filter(row => !row.valid).length;
      const summary = { concurrency, durationSeconds: Math.round((performance.now() - stageStart) / 1000),
        requests: rows.length, errors, completedJourneys: samples.filter(row => row.concurrency === concurrency && row.kind === 'journey' && row.valid).length,
        feedP95Ms: percentile(feed, .95), telemetryP95Ms: percentile(telemetry, .95),
        peakActiveJourneys: Math.max(0, ...activity.filter(row => row.concurrency === concurrency).map(row => row.active)) };
      summary.accepted = summary.completedJourneys === concurrency && summary.peakActiveJourneys === concurrency &&
        summary.feedP95Ms !== null && summary.feedP95Ms <= 1500 && summary.telemetryP95Ms !== null && summary.telemetryP95Ms <= 500 &&
        rows.length > 0 && errors / rows.length < 0.01;
      groups.push(summary); persist(true); log({ mode: MODE, ...summary });
      if (!summary.accepted || abortRamp) break;
    }
  } finally { diagnostics.close(); persist(true); }
  return report();
}

module.exports = { MODE, PROJECT, ORIGIN, COMMIT_VERIFICATION, UUID, SHA,
  parseCanaryArguments, validateConfiguration, outputPaths, writeAtomicSnapshot, assertAllowedRequest, runProductionCanary };
if (require.main === module) {
  Promise.resolve().then(() => runProductionCanary(parseCanaryArguments(process.argv.slice(2))))
    .then(report => { if (report.groups.length !== report.configuration.stages.length ||
      report.groups.some(group => !group.accepted) || report.unresolvedFeedIntents.length) process.exitCode = 2; })
    .catch(() => { console.error('Production canary did not complete; inspect its scoped local report if created.'); process.exitCode = 1; });
}
