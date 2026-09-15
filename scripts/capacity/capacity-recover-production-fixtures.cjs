'use strict';
// Local production journal recovery only. No network, auth, SQL or deletion.
// Deliberately separate from the staging-only capacity-recover-fixtures.cjs.
const fsDefault = require('node:fs');
const { MODE, PROJECT, ORIGIN, COMMIT_VERIFICATION, UUID, SHA, outputPaths, writeAtomicSnapshot } = require('./capacity-production-canary.cjs');
const CORE = ['mode','project','origin','commit','commitVerification','name','startedAt'];
const FIELDS = {
  'feed-intent': ['phase','journeyKey','offset','session','actor'],
  'feed-result': ['phase','journeyKey','session','actor'],
  'event-intent': ['phase','journeyKey','session','actor','postId','eventKind','watchSeconds'],
};
const actorValid = actor => typeof actor === 'string' && actor.startsWith('anon:') && UUID.test(actor.slice(5));
const journeyValid = value => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d?):(0|[1-9]\d*)$/.test(value)) return false;
  const [stage, index] = value.split(':').map(Number);
  return stage <= 50 && (stage === 0 ? index === 0 : index < stage);
};
function recoverProductionJournal(name, journalText, existing) {
  outputPaths(name); // Validate the name without permitting arbitrary paths.
  if (typeof journalText !== 'string' || journalText.length > 40_000_000) throw new Error('Invalid production journal');
  const lines = journalText.trim().split('\n');
  if (lines.length > 50_000) throw new Error('Production journal is unexpectedly large');
  let rows; try { rows = lines.map(line => JSON.parse(line)); } catch { throw new Error('Production journal is incomplete or invalid'); }
  const first = rows[0];
  if (!first || first.mode !== MODE || first.project !== PROJECT || first.origin !== ORIGIN || first.name !== name ||
      first.commitVerification !== COMMIT_VERIFICATION || !SHA.test(first.commit ?? '') ||
      typeof first.startedAt !== 'string' || !Number.isFinite(Date.parse(first.startedAt))) throw new Error('Production journal metadata rejected');
  const metadata = Object.fromEntries(CORE.map(key => [key, first[key]]));
  const fixtures = new Map(), journeys = new Map(), sessionJourneys = new Map(), pending = new Map(), intents = new Map();
  for (const row of rows) {
    const allowed = FIELDS[row?.phase];
    if (!allowed || CORE.some(key => row[key] !== metadata[key]) || !journeyValid(row.journeyKey) ||
        Object.keys(row).some(key => !CORE.includes(key) && !allowed.includes(key))) throw new Error('Production journal row rejected');
    if (row.phase === 'feed-intent') {
      if (!Number.isSafeInteger(row.offset) || row.offset < 0 || pending.has(row.journeyKey) ||
          (row.session === undefined ? row.actor !== undefined || row.offset !== 0 || journeys.has(row.journeyKey)
            : !UUID.test(row.session) || !actorValid(row.actor) || journeys.get(row.journeyKey)?.session !== row.session ||
              journeys.get(row.journeyKey)?.actor !== row.actor)) throw new Error('Production feed intent rejected');
      const intent = { journeyKey: row.journeyKey, offset: row.offset,
        ...(row.session ? { session: row.session, actor: row.actor } : {}) };
      pending.set(row.journeyKey, intent);
      intents.set(row.journeyKey + '/' + row.offset, intent);
      continue;
    }
    if (!UUID.test(row.session ?? '') || !actorValid(row.actor)) throw new Error('Production fixture identity rejected');
    if (row.phase === 'feed-result') {
      const intent = pending.get(row.journeyKey), previous = journeys.get(row.journeyKey);
      if (!intent || (previous && (previous.session !== row.session || previous.actor !== row.actor)) ||
          (sessionJourneys.has(row.session) && sessionJourneys.get(row.session) !== row.journeyKey))
        throw new Error('Conflicting production feed result');
      journeys.set(row.journeyKey, { session: row.session, actor: row.actor });
      sessionJourneys.set(row.session, row.journeyKey);
      fixtures.set(row.session, fixtures.get(row.session) ?? { actor: row.actor, session: row.session, posts: [] });
      pending.delete(row.journeyKey);
      continue;
    }
    const fixture = fixtures.get(row.session), owner = journeys.get(row.journeyKey);
    if (!fixture || fixture.actor !== row.actor || owner?.session !== row.session || owner?.actor !== row.actor ||
        !UUID.test(row.postId ?? '') || !['exposure','watch'].includes(row.eventKind) ||
        (row.eventKind === 'exposure' && row.watchSeconds !== undefined) ||
        (row.eventKind === 'watch' && (typeof row.watchSeconds !== 'number' || !Number.isFinite(row.watchSeconds) || row.watchSeconds < 0)))
      throw new Error('Production event intent rejected');
    if (!fixture.posts.includes(row.postId)) fixture.posts.push(row.postId);
  }
  if (existing !== undefined) {
    if (!existing || CORE.some(key => existing[key] !== metadata[key]) || !Array.isArray(existing.fixtures) ||
        !Array.isArray(existing.unresolvedFeedIntents) ||
        Object.keys(existing).some(key => !CORE.includes(key) && !['fixtures','unresolvedFeedIntents'].includes(key)))
      throw new Error('Conflicting production cleanup manifest');
    // A journal can safely add recorded scope, never silently remove it.
    for (const old of existing.fixtures) {
      const fresh = fixtures.get(old.session);
      if (!fresh || fresh.actor !== old.actor || !Array.isArray(old.posts) ||
          Object.keys(old).some(key => !['actor','session','posts'].includes(key)) || old.posts.some(post => !fresh.posts.includes(post)))
        throw new Error('Production journal is missing existing cleanup scope');
    }
    for (const old of existing.unresolvedFeedIntents) {
      const recorded = intents.get(old?.journeyKey + '/' + old?.offset);
      if (!recorded || Object.keys(old).some(key => !['journeyKey','offset','session','actor'].includes(key)) ||
          old.session !== recorded.session || old.actor !== recorded.actor)
        throw new Error('Production journal is missing an existing unresolved request');
    }
  }
  return { ...metadata, fixtures: [...fixtures.values()], unresolvedFeedIntents: [...pending.values()] };
}
function recoverProductionFiles(name, { fs = fsDefault } = {}) {
  const files = outputPaths(name);
  const existing = fs.existsSync(files.fixture) ? JSON.parse(fs.readFileSync(files.fixture, 'utf8')) : undefined;
  const recovered = recoverProductionJournal(name, fs.readFileSync(files.journal, 'utf8'), existing);
  writeAtomicSnapshot(fs, files.fixture, JSON.stringify(recovered, null, 2), 'recovery');
  return { mode: MODE, project: PROJECT, origin: ORIGIN, recoveredSessions: recovered.fixtures.length,
    intendedPosts: recovered.fixtures.reduce((sum, fixture) => sum + fixture.posts.length, 0),
    unresolvedFeedIntents: recovered.unresolvedFeedIntents.length,
    unresolvedFirstPageIntents: recovered.unresolvedFeedIntents.filter(intent => !intent.session).length };
}
module.exports = { recoverProductionJournal, recoverProductionFiles };
if (require.main === module) {
  try {
    const [mode, name, ...extra] = process.argv.slice(2);
    if (mode !== '--production' || !name || extra.length) throw new Error('Explicit production recovery mode required');
    console.log(JSON.stringify(recoverProductionFiles(name)));
  } catch { console.error('Production fixture recovery refused; inspect the local journal and metadata.'); process.exitCode = 1; }
}
