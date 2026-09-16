import { readDiscoverEvidenceBatches } from '@/lib/discoverEvidenceBatches';
import { rankDiscover, type DiscoverEvent, type DiscoverEvidence, type DiscoverPlacement } from '@/lib/discoverRanking';

const now = Date.parse('2026-09-16T12:00:00Z');
const inventory = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `p${i}` }));
const postIds = (count: number) => inventory(count).map(p => p.id);
const evidenceFor = (ids: readonly string[]): DiscoverEvidence[] => ids.flatMap(id => ['', 'languages'].map(audience => ({
  post_id: id, audience, exposures: 40, sales: Number(id.slice(1)) % 5, bookings: 0,
  intents: 2, taps: 3, views: 7, commercial: Number(id.slice(1)) % 5, last_exposure: new Date(now).toISOString(),
})));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test.each([false, true])('empty inventory performs no reads (overlap=%s)', async overlap => {
  const read = jest.fn();
  expect(await readDiscoverEvidenceBatches([], read, overlap)).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

test('default remains serial, with 200-ID boundaries and no input mutation', async () => {
  const ids = Object.freeze(postIds(401));
  const gates = Array.from({ length: 3 }, () => deferred<DiscoverEvidence[]>());
  const read = jest.fn((ids: string[]) => gates[Number(ids[0].slice(1)) / 200].promise);
  const result = readDiscoverEvidenceBatches(ids, read);
  for (let i = 0; i < 3; i++) {
    await flush(); expect(read).toHaveBeenCalledTimes(i + 1);
    const batch = ids.slice(i * 200, (i + 1) * 200);
    expect(read.mock.calls[i][0]).toEqual(batch);
    gates[i].resolve(evidenceFor(batch));
  }
  expect(await result).toEqual(evidenceFor(ids));
});

test('six batches use two-read windows and retain index order when the second finishes first', async () => {
  const ids = postIds(1018), gates = Array.from({ length: 6 }, () => deferred<DiscoverEvidence[]>());
  let active = 0, peak = 0;
  const read = jest.fn((ids: string[]) => {
    active++; peak = Math.max(peak, active);
    return gates[Number(ids[0].slice(1)) / 200].promise.finally(() => { active--; });
  });
  const result = readDiscoverEvidenceBatches(ids, read, true);
  for (let i = 0; i < 6; i += 2) {
    await flush(); expect(read).toHaveBeenCalledTimes(i + 2); expect(active).toBe(2);
    gates[i + 1].resolve(evidenceFor(ids.slice((i + 1) * 200, (i + 2) * 200)));
    await flush(); expect(read).toHaveBeenCalledTimes(i + 2); expect(active).toBe(1);
    gates[i].resolve(evidenceFor(ids.slice(i * 200, (i + 1) * 200)));
  }
  expect(await result).toEqual(evidenceFor(ids));
  expect(peak).toBe(2); expect(active).toBe(0);
  expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([200, 200, 200, 200, 200, 18]);
});

test('a last unpaired batch starts once and produces its complete result', async () => {
  const read = jest.fn(async (ids: string[]) => evidenceFor(ids));
  expect(await readDiscoverEvidenceBatches(postIds(401), read, true)).toEqual(evidenceFor(postIds(401)));
  expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([200, 200, 1]);
});

test.each([0, 1])('failure in slot %i drains its peer and never dispatches a later window', async failedSlot => {
  const gates = [deferred<DiscoverEvidence[]>(), deferred<DiscoverEvidence[]>()], failure = new Error('Evidence unavailable');
  const read = jest.fn((ids: string[]) => gates[Number(ids[0].slice(1)) / 200].promise);
  let finished = false;
  const result = readDiscoverEvidenceBatches(postIds(1000), read, true).then(
    () => { finished = true; return { succeeded: true }; },
    error => { finished = true; return { error }; },
  );
  await flush(); gates[failedSlot].reject(failure);
  await flush(); expect(finished).toBe(false); expect(read).toHaveBeenCalledTimes(2);
  gates[1 - failedSlot].resolve([]);
  expect(await result).toEqual({ error: failure });
  await flush(); expect(read).toHaveBeenCalledTimes(2);
});

test('a later window failure discards partial results and drains a second rejection', async () => {
  const gates = [deferred<DiscoverEvidence[]>(), deferred<DiscoverEvidence[]>()], first = new Error('First batch failure'), second = new Error('Peer failure');
  const read = jest.fn((ids: string[]) => Number(ids[0].slice(1)) < 400
    ? Promise.resolve(evidenceFor(ids)) : gates[(Number(ids[0].slice(1)) - 400) / 200].promise);
  let finished = false;
  const result = readDiscoverEvidenceBatches(postIds(1000), read, true).then(
    value => { finished = true; return { value }; }, error => { finished = true; return { error }; },
  );
  await flush(); expect(read).toHaveBeenCalledTimes(4);
  gates[1].reject(second); await flush(); expect(finished).toBe(false);
  gates[0].reject(first); expect(await result).toEqual({ error: first });
  expect(read).toHaveBeenCalledTimes(4);
});

test('synchronous callback failure still settles the other started read', async () => {
  const gate = deferred<DiscoverEvidence[]>(), failure = new Error('Synchronous failure');
  const read = jest.fn((ids: string[]) => { if (ids[0] === 'p0') throw failure; return gate.promise; });
  let finished = false;
  const result = readDiscoverEvidenceBatches(postIds(600), read, true).catch(error => { finished = true; return error; });
  await flush(); expect(finished).toBe(false); expect(read).toHaveBeenCalledTimes(2);
  gate.resolve([]); expect(await result).toBe(failure); expect(read).toHaveBeenCalledTimes(2);
});

test.each([false, true])('serial and overlapping reads preserve ranking and placements (commercial=%s)', async commercialOrdering => {
  const posts = inventory(451).map((p, i) => ({ ...p, creator_id: `creator${i % 7}`, created_at: new Date(now - i * 86400000).toISOString(),
    interests: [i % 2 ? 'education & career skills' : 'business & entrepreneurship'], topics: [i % 3 ? 'languages' : 'ecommerce'], offer_type: i % 2 ? 'none' : 'product' }));
  const events: DiscoverEvent[] = posts.filter((_, i) => i % 7 === 0).map(p => ({ actor: 'viewer', post_id: p.id, kind: 'exposure',
    categories: p.interests, topics: p.topics, audience: 'languages', offer_type: p.offer_type, occurred_at: new Date(now - 86400000).toISOString() }));
  const rank = (evidence: DiscoverEvidence[]) => {
    const placements: Record<string, DiscoverPlacement> = {};
    const ids = rankDiscover(posts, events, 'viewer', ['education & career skills'], ['languages'], now, [], evidence,
      { commercialOrdering, onPlacement: (id, value) => { placements[id] = value; } });
    return { ids, placements };
  };
  const read = async (ids: string[]) => evidenceFor(ids);
  const ids = posts.map(p => p.id);
  const serial = await readDiscoverEvidenceBatches(ids, read), overlapping = await readDiscoverEvidenceBatches(ids, read, true);
  expect(overlapping).toEqual(serial);
  expect(rank(overlapping)).toEqual(rank(serial));
  expect(new Set(rank(overlapping).ids).size).toBe(posts.length);
});
