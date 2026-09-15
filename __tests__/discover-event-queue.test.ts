import { DiscoverEventQueue, type DiscoverQueuedEvent } from "@/lib/discoverEventQueue";

const ok = { ok: true, status: 200 };
const event = (postId = "post", kind = "exposure", watchSeconds?: number, session = "session"): DiscoverQueuedEvent =>
  ({ session, postId, kind, watchSeconds });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function flush() { for (let step = 0; step < 12; step++) await Promise.resolve(); }
const originalFetch = globalThis.fetch;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); jest.spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); globalThis.fetch = originalFetch; });

test("a stalled exposure retains only the latest cumulative watch, including identical replayed claims", async () => {
  const first = deferred<typeof ok>();
  const send = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok);
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event());
  for (let seconds = 5; seconds <= 600; seconds += 5) queue.enqueue(event("post", "watch", seconds));
  queue.enqueue(event("post", "watch", 600));
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  first.resolve(ok);
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.map(([value]) => [value.kind, value.watchSeconds])).toEqual([["exposure", undefined], ["watch", 600]]);
  // This is a claim, not 600 seconds of accepted credit. Server elapsed/6s
  // bounds remain unchanged and independently covered by database tests.
});

test("an in-flight watch keeps its payload while newer unsent samples coalesce", async () => {
  const active = deferred<typeof ok>();
  const send = jest.fn().mockResolvedValueOnce(ok).mockReturnValueOnce(active.promise).mockResolvedValue(ok);
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event()); await flush();
  queue.enqueue(event("post", "watch", 5)); await flush();
  queue.enqueue(event("post", "watch", 10));
  queue.enqueue(event("post", "watch", 15));
  queue.enqueue(event("post", "watch", 15));
  expect(send.mock.calls[1][0].watchSeconds).toBe(5);
  active.resolve(ok); await flush();
  expect(send.mock.calls.map(([value]) => value.watchSeconds)).toEqual([undefined, 5, 15]);
});

test("many posts have at most four active requests and overflow preserves the newest queued streams", async () => {
  const completions: (() => void)[] = [];
  let active = 0, peak = 0;
  const send = jest.fn((_value: DiscoverQueuedEvent, _signal: AbortSignal) => {
    active++; peak = Math.max(peak, active);
    return new Promise<typeof ok>(resolve => completions.push(() => { active--; resolve(ok); }));
  });
  const queue = new DiscoverEventQueue(send);
  for (let index = 0; index < 100; index++) queue.enqueue(event("post" + index));
  await flush();
  expect(send).toHaveBeenCalledTimes(4);
  while (completions.length) {
    completions.shift()!(); await flush();
  }
  const sent = send.mock.calls.map(([value]) => (value as unknown as DiscoverQueuedEvent).postId);
  expect(peak).toBe(4);
  expect(send).toHaveBeenCalledTimes(64);
  expect(sent.slice(0, 4)).toEqual(["post0", "post1", "post2", "post3"]);
  expect(sent).not.toContain("post4");
  expect(sent.slice(-4)).toEqual(["post96", "post97", "post98", "post99"]);
});

test("expired queued work is dropped instead of draining an old backlog after recovery", async () => {
  const send = jest.fn().mockResolvedValue({ok:false,status:429,headers:{get:()=>"60"}});
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event());
  queue.enqueue(event("post", "watch", 5));
  await flush();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(send).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(40_000);
  expect(send).toHaveBeenCalledTimes(1);
});

test("a transient failure retries with backoff and preserves exposure-before-watch ordering", async () => {
  const send = jest.fn().mockResolvedValueOnce({ok:false,status:503}).mockResolvedValue(ok);
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event()); queue.enqueue(event("post", "watch", 5));
  await flush();
  await jest.advanceTimersByTimeAsync(999);
  expect(send).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(send.mock.calls.map(([value])=>value.kind)).toEqual(["exposure", "exposure", "watch"]);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
});

test("rate-limit Retry-After delays a retry without polling or an early watch request", async () => {
  const send = jest.fn().mockResolvedValueOnce({ok:false,status:429,headers:{get:()=>"5"}}).mockResolvedValue(ok);
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event()); queue.enqueue(event("post", "watch", 5));
  await flush();
  await jest.advanceTimersByTimeAsync(4_999);
  expect(send).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(send.mock.calls.map(([value])=>value.kind)).toEqual(["exposure", "exposure", "watch"]);
});

test("new watch samples cannot reset a failing stream's retry budget", async () => {
  const send = jest.fn((value: DiscoverQueuedEvent) => Promise.resolve(value.kind === "exposure" ? ok : {ok:false,status:503}));
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event()); await flush();
  queue.enqueue(event("post","watch",5)); await flush();
  queue.enqueue(event("post","watch",10));
  await jest.advanceTimersByTimeAsync(1_000);
  queue.enqueue(event("post","watch",15));
  await jest.advanceTimersByTimeAsync(2_000);
  expect(send.mock.calls.map(([value])=>value.watchSeconds)).toEqual([undefined,5,10,15]);
  expect(queue.enqueue(event("post","watch",20))).toBe(false);
  await jest.advanceTimersByTimeAsync(59_000);
  expect(send).toHaveBeenCalledTimes(4);
});

test("repeated taps and feedback occupy one pending event of each kind", async () => {
  const first = deferred<typeof ok>();
  const send = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok);
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event());
  for (let index=0;index<100;index++) {
    for (const kind of ["exposure","product_tap","booking_tap","not_interested","quick_skip"]) queue.enqueue(event("post",kind));
  }
  await flush();
  first.resolve(ok); await flush(); await flush();
  expect(send.mock.calls.map(([value])=>value.kind)).toEqual(["exposure","product_tap","booking_tap","not_interested","quick_skip"]);
});

test("a failed tap is not retried across the UTC day used by the server's idempotency key", async () => {
  jest.setSystemTime(Date.parse("2026-09-15T23:59:59Z"));
  const send = jest.fn().mockResolvedValue({ok:false,status:503});
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event("post","booking_tap")); await flush();
  await jest.advanceTimersByTimeAsync(5_000);
  expect(send).toHaveBeenCalledTimes(1);
});

test.each([400, 403])("permanent %s drops the stream and does not repeatedly retry subsequent samples", async status => {
  const send = jest.fn().mockResolvedValue({ok:false,status});
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event()); queue.enqueue(event("post", "watch", 5));
  await flush();
  expect(queue.enqueue(event("post", "watch", 10))).toBe(false);
  await jest.advanceTimersByTimeAsync(59_000);
  expect(send).toHaveBeenCalledTimes(1);
  // A fresh session is independent of this denied snapshot.
  queue.enqueue(event("post", "exposure", undefined, "new-session")); await flush();
  expect(send).toHaveBeenCalledTimes(2);
});

test("hung transports are aborted at ten seconds, attempted at most three times and then cooled down", async () => {
  const send = jest.fn((_value: DiscoverQueuedEvent, _signal: AbortSignal) => new Promise<typeof ok>(() => {}));
  const queue = new DiscoverEventQueue(send);
  queue.enqueue(event()); queue.enqueue(event("post", "watch", 5)); await flush();
  const firstSignal = send.mock.calls[0][1] as unknown as AbortSignal;
  await jest.advanceTimersByTimeAsync(9_999);
  expect(firstSignal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(firstSignal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(23_000);
  expect(send).toHaveBeenCalledTimes(3);
  expect((send.mock.calls[2][1] as unknown as AbortSignal).aborted).toBe(true);
  expect(queue.enqueue(event("post", "watch", 10))).toBe(false);
  await jest.advanceTimersByTimeAsync(59_000);
  expect(send).toHaveBeenCalledTimes(3);
});

test("different sessions of the same post retain separate ordering, claims and tokens", async () => {
  const first = deferred<typeof ok>();
  const send = jest.fn((value: DiscoverQueuedEvent) => value.session === "first" ? first.promise : Promise.resolve(ok));
  const queue = new DiscoverEventQueue(send);
  queue.enqueue({...event("post","watch",5,"first"),actorToken:"first-token"});
  queue.enqueue({...event("post","watch",10,"second"),actorToken:"second-token"});
  await flush();
  expect(send.mock.calls.map(([value])=>[value.session,value.kind,value.actorToken])).toEqual([
    ["first","exposure","first-token"], ["second","exposure","second-token"], ["second","watch","second-token"],
  ]);
  first.resolve(ok); await flush();
  const watch = send.mock.calls.map(([value])=>value).filter(value=>value.kind==="watch");
  expect(watch.map(value=>[value.session,value.watchSeconds])).toEqual([["second",10],["first",5]]);
});

test("feed-generation cancellation leaves keepalive event delivery independent through navigation", async () => {
  const firstEvent = deferred<typeof ok>();
  const fetch = jest.fn((url: string, init: RequestInit) => {
    if (url.startsWith("/api/feed?")) return Promise.resolve({ok:true,status:200,json:async()=>({items:[],session:"navigation",actorToken:"actor-token",nextOffset:0,hasMore:false})});
    const payload = JSON.parse(String(init.body));
    return payload.kind === "exposure" ? firstEvent.promise : Promise.resolve(ok);
  });
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  let client!: typeof import("@/lib/discoverClient");
  jest.isolateModules(() => { client = require("@/lib/discoverClient"); });
  const pageController = new AbortController();
  await client.fetchDiscoverPage("discover",0,20,null,pageController.signal);
  client.rememberDiscoverSession(["post"],"navigation");
  client.sendDiscoverEvent("post","exposure");
  client.sendDiscoverEvent("post","watch",5);
  await flush();
  pageController.abort();
  const init = fetch.mock.calls[1][1];
  expect(init.keepalive).toBe(true);
  expect(init.signal?.aborted).toBe(false);
  firstEvent.resolve(ok); await flush();
  expect(fetch.mock.calls.filter(([url])=>url==="/api/feed-events")).toHaveLength(2);
  expect(fetch.mock.calls[2][1].keepalive).toBe(true);
  expect(fetch.mock.calls[2][1].signal?.aborted).toBe(false);
});
