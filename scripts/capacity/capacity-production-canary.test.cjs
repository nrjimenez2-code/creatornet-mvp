'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODE, PROJECT, ORIGIN, COMMIT_VERIFICATION, parseCanaryArguments, validateConfiguration,
  outputPaths, assertAllowedRequest, runProductionCanary } = require('./capacity-production-canary.cjs');
const { recoverProductionJournal, recoverProductionFiles } = require('./capacity-recover-production-fixtures.cjs');
const COMMIT = 'b'.repeat(40);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
// All token-like test values below are synthetic, held by the fake transport.
const tokenFor = n => id(n) + '.' + 'a'.repeat(64);
const configuration = changes => validateConfiguration({ commit: COMMIT, stages: [1], name: 'offline-only',
  postsPerActor: 3, primingJourneys: 0, ...changes });
function memoryRun(options = {}) {
  const contents = new Map(), timeline = [], logs = [], waits = [], tokens = [], calls = [];
  let clock = 0, actorOrdinal = 0, closed = false, cleanupCheckpoints = 0;
  const sessionTokens = new Map();
  const io = {
    existsSync: file => contents.has(file),
    writeFileSync(file, text, init) {
      if (init?.flag === 'wx' && contents.has(file)) throw new Error('Synthetic collision');
      if (file.endsWith('-cleanup.json.checkpoint.tmp') && ++cleanupCheckpoints > 1 && options.tearCheckpoint) {
        contents.set(file, '{"synthetic_torn_snapshot":'); throw new Error('Synthetic interrupted checkpoint');
      }
      contents.set(file, String(text)); timeline.push({ type: 'write', file });
    },
    renameSync(from, to) {
      if (!contents.has(from)) throw new Error('Synthetic missing atomic source');
      contents.set(to, contents.get(from)); contents.delete(from); timeline.push({ type: 'rename', to });
    },
    appendFileSync(file, text) {
      const row = JSON.parse(text);
      if (row.phase === options.failJournalPhase) throw new Error('Synthetic journal failure');
      contents.set(file, (contents.get(file) ?? '') + text); timeline.push({ type: 'journal', row });
    },
    readFileSync: file => contents.get(file),
  };
  const diagnosticsFactory = () => ({
    trace: () => ({ run: fn => fn(), fetchResolved() {}, jsonResolved() {}, summary: () => ({ offline: true }) }),
    measureWrite: (_kind, fn) => fn(), snapshot: () => ({ offline: true, closed }), close: () => { closed = true; },
  });
  const fetch = async (url, init) => {
    assertAllowedRequest(url, init);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const preceding = timeline.at(-1);
    assert.equal(preceding.type, 'journal', 'network work must immediately follow a persisted intent');
    const isFeed = new URL(url).pathname === '/api/feed';
    assert.equal(preceding.row.phase, isFeed ? 'feed-intent' : 'event-intent');
    calls.push({ url, init }); timeline.push({ type: 'fetch', url });
    clock += isFeed ? options.feedMs ?? 10 : options.telemetryMs ?? 10;
    if (options.throwFetch) {
      const error = new Error(tokenFor(999)); error.name = tokenFor(998); throw error;
    }
    let data;
    if (isFeed) {
      const params = new URL(url).searchParams;
      let session = params.get('session'), token = sessionTokens.get(session);
      if (!session) { const n = ++actorOrdinal; session = id(1000 + n); token = tokenFor(options.repeatActor ? 1 : n);
        tokens.push(token); sessionTokens.set(session, token); }
      data = { items: options.emptyPages ? [] : Array.from({ length: 6 }, (_, i) => ({ post_id: id(100 + i), caption: 'PRIVATE_FAKE_RESPONSE_TEXT' })),
        session, actorToken: token, nextOffset: options.emptyPages ? Number(params.get('offset')) + 20 : 6,
        hasMore: options.emptyPages === true };
    } else {
      const body = JSON.parse(init.body);
      assert.equal(preceding.row.session, body.session);
      assert.equal(preceding.row.postId, body.postId);
      assert.equal(preceding.row.eventKind, body.kind);
      assert.equal(preceding.row.watchSeconds, body.watchSeconds);
      data = { ok: true, ...(options.disabledTelemetry ? { enabled: false } : {}) };
    }
    const status = !isFeed && options.failTelemetry ? 503 : 200;
    return { ok: status === 200, status, json: async () => data, headers: { get: header =>
      header === 'x-vercel-id' ? 'iad1::offline-canary-123' : header === 'server-timing' ? 'total;dur=10, unknown;dur=999' : null } };
  };
  const ports = { fs: io, fetch, sleep: async ms => { waits.push(ms); await Promise.resolve(); },
    performance: { now: () => clock }, dateNow: () => new Date(Date.UTC(2026, 8, 15) + clock).toISOString(),
    log: value => logs.push(value), diagnosticsFactory };
  return { contents, timeline, logs, waits, tokens, calls, io, ports };
}

test('production is explicit, origin cannot be overridden, and stages never exceed 50', () => {
  const accepted = parseCanaryArguments(['--production', COMMIT, '5,25,50', 'reviewed-canary', '6', '1']);
  assert.deepEqual(accepted.stages, [5, 25, 50]);
  for (const stages of [[51], [1000], [5, 25, 51], [25, 5], [5, 5], [0], [], [1, 2, 3, 4]])
    assert.throws(() => configuration({ stages }));
  for (const postsPerActor of [2, 7, 100]) assert.throws(() => configuration({ postsPerActor }));
  assert.throws(() => configuration({ origin: 'https://example.com' }));
  assert.throws(() => parseCanaryArguments([COMMIT, '5', 'missing-mode']));
  assert.throws(() => parseCanaryArguments(['--production', COMMIT, '5', '../escape']));
  assert.ok(Object.values(outputPaths('reviewed-canary')).every(file => /capacity-prod-reviewed-canary/.test(file)));
});

test('only fixed production feed GET and exposure/watch POST endpoints are accepted', () => {
  const feed = ORIGIN + '/api/feed?tab=discover&offset=0&limit=20';
  const event = { method: 'POST', headers: { 'x-cn-discover-actor': tokenFor(1) },
    body: JSON.stringify({ session: id(2), postId: id(3), kind: 'watch', watchSeconds: 5 }) };
  assert.doesNotThrow(() => assertAllowedRequest(feed));
  assert.doesNotThrow(() => assertAllowedRequest(ORIGIN + '/api/feed-events', event));
  for (const url of ['https://example.com/api/feed?tab=discover&offset=0&limit=20',
    'https://creatornet-mvp-git-feat-discov-6491dd-nrjimenez2-codes-projects.vercel.app/api/feed?tab=discover&offset=0&limit=20',
    ORIGIN + '/auth', ORIGIN + '/api/feed?tab=discover&offset=0&limit=21',
    ORIGIN + '/api/feed?tab=discover&offset=0&limit=20&session=invalid']) assert.throws(() => assertAllowedRequest(url));
  assert.throws(() => assertAllowedRequest(feed, { headers: { Authorization: 'synthetic' } }));
  assert.throws(() => assertAllowedRequest(ORIGIN + '/auth/callback', event));
  assert.throws(() => assertAllowedRequest(ORIGIN + '/api/feed-events', { ...event,
    body: JSON.stringify({ session: id(2), postId: id(3), kind: 'booking_tap' }) }));
});

test('in-memory run retains real wait arguments/replay, journals every request, and outputs no auth material', async () => {
  const memory = memoryRun();
  const report = await runProductionCanary(configuration({ stages: [5], primingJourneys: 1 }), memory.ports);
  assert.equal(report.mode, MODE); assert.equal(report.project, PROJECT); assert.equal(report.origin, ORIGIN);
  assert.equal(report.commitVerification, COMMIT_VERIFICATION);
  assert.equal(report.groups[0].requests, 55); assert.equal(report.groups[0].completedJourneys, 5);
  assert.equal(report.groups[0].peakActiveJourneys, 5); assert.equal(report.groups[0].accepted, true);
  assert.equal(memory.calls.length, 66);
  assert.equal(memory.waits.filter(ms => ms === 5100).length, 36);
  const posts = memory.calls.filter(call => call.init.method === 'POST').map(call => JSON.parse(call.init.body));
  assert.equal(posts.length, 60);
  assert.equal(posts.filter(body => body.postId === id(100) && body.kind === 'watch' && body.watchSeconds === 10).length, 12);
  const serialized = JSON.stringify([...memory.contents]) + JSON.stringify(memory.logs) + JSON.stringify(report);
  for (const token of memory.tokens) assert.ok(!serialized.includes(token));
  for (const sensitive of ['x-cn-discover-actor', 'Authorization', 'PRIVATE_FAKE_RESPONSE_TEXT', 'access_token', 'refresh_token'])
    assert.ok(!serialized.includes(sensitive));
  const recovered = recoverProductionJournal('offline-only', memory.contents.get(outputPaths('offline-only').journal));
  assert.equal(recovered.fixtures.length, 6); assert.deepEqual(recovered.unresolvedFeedIntents, []);
});

test('journal failure blocks first feed mutation and event mutation independently', async () => {
  for (const phase of ['feed-intent', 'event-intent']) {
    const memory = memoryRun({ failJournalPhase: phase });
    const report = await runProductionCanary(configuration(), memory.ports);
    assert.equal(report.groups[0].accepted, false);
    assert.equal(memory.calls.filter(call => call.init.method === 'POST').length, 0);
    assert.equal(memory.calls.length, phase === 'feed-intent' ? 0 : 1);
    if (phase === 'event-intent') {
      const recovered = recoverProductionJournal('offline-only', memory.contents.get(outputPaths('offline-only').journal),
        JSON.parse(memory.contents.get(outputPaths('offline-only').fixture)));
      assert.deepEqual(recovered.fixtures[0].posts, []);
    }
  }
});

test('output collision cannot overwrite an artifact or start traffic', async () => {
  const memory = memoryRun();
  memory.contents.set(outputPaths('offline-only').fixture, 'existing sentinel');
  await assert.rejects(runProductionCanary(configuration(), memory.ports), /already exists/);
  assert.equal(memory.calls.length, 0);
  assert.equal(memory.contents.get(outputPaths('offline-only').fixture), 'existing sentinel');
});

test('1500ms/500ms acceptance budgets remain unchanged and failed stages stop the ramp', async () => {
  for (const options of [{ feedMs: 1500, telemetryMs: 500, accepted: true },
    { feedMs: 1501, telemetryMs: 500, accepted: false }, { feedMs: 1500, telemetryMs: 501, accepted: false }]) {
    const memory = memoryRun(options);
    const report = await runProductionCanary(configuration(), memory.ports);
    assert.equal(report.groups[0].accepted, options.accepted);
  }
  const memory = memoryRun({ failTelemetry: true });
  const report = await runProductionCanary(configuration({ stages: [1, 5, 25] }), memory.ports);
  assert.equal(report.groups.length, 1); assert.equal(report.groups[0].accepted, false);
  assert.ok(report.groups[0].errors / report.groups[0].requests >= 0.01);
});

test('unknown transport errors do not serialize token-like error names/messages', async () => {
  const memory = memoryRun({ throwFetch: true });
  const report = await runProductionCanary(configuration(), memory.ports);
  const serialized = JSON.stringify(report) + JSON.stringify([...memory.contents]) + JSON.stringify(memory.logs);
  assert.ok(!serialized.includes(tokenFor(998))); assert.ok(!serialized.includes(tokenFor(999)));
  assert.equal(report.unresolvedFeedIntents.length, 1);
});

test('production recovery rejects staging or mixed metadata and cannot erase prior scope', async () => {
  const memory = memoryRun();
  await runProductionCanary(configuration(), memory.ports);
  const files = outputPaths('offline-only'), text = memory.contents.get(files.journal);
  const rows = text.trim().split('\n').map(JSON.parse);
  for (const changed of [{ mode: 'staging' }, { project: 'nwqfofezfzljhxolkycz' },
    { origin: 'https://example.com' }, { commit: 'c'.repeat(40) }, { actorToken: tokenFor(1) }]) {
    const altered = rows.map((row, i) => i === rows.length - 1 ? { ...row, ...changed } : row);
    assert.throws(() => recoverProductionJournal('offline-only', altered.map(JSON.stringify).join('\n')));
  }
  const current = JSON.parse(memory.contents.get(files.fixture));
  current.fixtures[0].posts.push(id(99999));
  assert.throws(() => recoverProductionJournal('offline-only', text, current), /missing existing cleanup scope/);
  const unresolved = JSON.parse(memory.contents.get(files.fixture));
  unresolved.unresolvedFeedIntents.push({ journeyKey: '50:49', offset: 0 });
  assert.throws(() => recoverProductionJournal('offline-only', text, unresolved), /missing an existing unresolved request/);
  const result = recoverProductionFiles('offline-only', { fs: memory.io });
  assert.equal(result.recoveredSessions, 1); assert.equal(result.intendedPosts, 3);
  assert.equal(result.unresolvedFirstPageIntents, 0);
});

test('interrupted first-page intent remains unresolved instead of inventing a cleanup identity', async () => {
  const memory = memoryRun({ throwFetch: true });
  await runProductionCanary(configuration(), memory.ports);
  const recovered = recoverProductionJournal('offline-only', memory.contents.get(outputPaths('offline-only').journal));
  assert.deepEqual(recovered.fixtures, []);
  assert.deepEqual(recovered.unresolvedFeedIntents, [{ journeyKey: '1:0', offset: 0 }]);
});

test('advancing empty pages hit a fixed six-page ceiling and stop the production ramp', async () => {
  const memory = memoryRun({ emptyPages: true });
  const report = await runProductionCanary(configuration({ stages: [1, 5, 25] }), memory.ports);
  assert.equal(memory.calls.length, 6);
  assert.equal(report.groups.length, 1); assert.equal(report.groups[0].accepted, false);
  assert.equal(report.samples.at(-1).error, 'Feed page budget exceeded');
  assert.equal(report.configuration.maximumFeedPagesPerJourney, 6);
  assert.equal(report.configuration.maximumRequestsPerJourney, 16);
});

test('repeated actors across new sessions invalidate the measurement while preserving observed cleanup IDs', async () => {
  const memory = memoryRun({ repeatActor: true });
  const report = await runProductionCanary(configuration({ stages: [5, 25] }), memory.ports);
  assert.equal(report.groups.length, 1); assert.equal(report.groups[0].accepted, false);
  assert.ok(report.samples.some(row => row.error === 'Actor shared by independent journeys'));
  const recovered = recoverProductionJournal('offline-only', memory.contents.get(outputPaths('offline-only').journal),
    JSON.parse(memory.contents.get(outputPaths('offline-only').fixture)));
  assert.equal(recovered.fixtures.length, 5);
});

test('a disabled telemetry no-op is a failed request, never a successful canary', async () => {
  const memory = memoryRun({ disabledTelemetry: true });
  const report = await runProductionCanary(configuration({ stages: [1, 5] }), memory.ports);
  assert.equal(report.groups.length, 1); assert.equal(report.groups[0].accepted, false);
  assert.ok(report.samples.some(row => row.kind === 'exposure' && row.status === 200 && row.valid === false));
});

test('a torn checkpoint preserves the prior canonical snapshot and a complete journal can still recover it', async () => {
  const memory = memoryRun({ tearCheckpoint: true, feedMs: 1500 });
  await assert.rejects(runProductionCanary(configuration(), memory.ports));
  const files = outputPaths('offline-only');
  const canonical = JSON.parse(memory.contents.get(files.fixture));
  assert.deepEqual(canonical.fixtures, []);
  assert.equal(memory.contents.get(files.fixture + '.checkpoint.tmp'), '{"synthetic_torn_snapshot":');
  const recovered = recoverProductionFiles('offline-only', { fs: memory.io });
  assert.equal(recovered.recoveredSessions, 1);
  assert.equal(recovered.intendedPosts, 0);
  assert.equal(JSON.parse(memory.contents.get(files.fixture)).fixtures.length, 1);
  assert.equal(memory.contents.get(files.fixture + '.checkpoint.tmp'), '{"synthetic_torn_snapshot":');
});
