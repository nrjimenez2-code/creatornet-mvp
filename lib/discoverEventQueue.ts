"use client";

export type DiscoverQueuedEvent = {
  session: string;
  postId: string;
  kind: string;
  watchSeconds?: number;
  actorToken?: string;
};
type EventResponse = { ok: boolean; status: number; headers?: { get(name: string): string | null } };
type SendEvent = (event: DiscoverQueuedEvent, signal: AbortSignal) => Promise<EventResponse>;
type Job = { event: DiscoverQueuedEvent; createdAt: number; readyAt: number; attempts: number };
type Stream = { key: string; exposed: boolean; active: Job | null; pending: Job[] };

const KINDS = new Set(["exposure", "watch", "product_tap", "booking_tap", "not_interested", "quick_skip"]);
const MAX_ACTIVE = 4;
const MAX_STREAMS = 64;
const MAX_EVENT_AGE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const FAILURE_COOLDOWN_MS = 60_000;

/** Best-effort telemetry must not accumulate behind a slow service or compete
 * with playback without a bound. Each stream retains at most one pending event
 * of each kind, plus one active request. Overflow evicts the oldest inactive
 * stream (idle before queued); expired work is discarded after 30 seconds.
 * None of these bounds change the server's elapsed-time or replay checks.
 */
export class DiscoverEventQueue {
  private streams = new Map<string, Stream>();
  private blocked = new Map<string, number>();
  private active = 0;
  private wake: ReturnType<typeof setTimeout> | undefined;

  constructor(private send: SendEvent) {}

  enqueue(event: DiscoverQueuedEvent): boolean {
    if (!KINDS.has(event.kind) || !event.session || !event.postId ||
        (event.kind === "watch" && (typeof event.watchSeconds !== "number" || !Number.isFinite(event.watchSeconds) || event.watchSeconds < 0))) return false;
    const now = Date.now();
    this.prune(now);
    const key = event.session + ":" + event.postId;
    if ((this.blocked.get(key) ?? 0) > now) return false;
    let stream = this.streams.get(key);
    if (!stream) {
      if (this.streams.size >= MAX_STREAMS) {
        const candidates = [...this.streams.values()].filter(value => !value.active);
        const oldest = candidates.find(value => value.pending.length === 0) ?? candidates[0];
        if (!oldest) return false;
        this.streams.delete(oldest.key);
      }
      stream = { key, exposed: false, active: null, pending: [] };
      this.streams.set(key, stream);
    }
    if (event.kind === "exposure" && stream.exposed) return true;
    if (stream.active?.event.kind === event.kind &&
        (event.kind !== "watch" || event.watchSeconds! <= stream.active.event.watchSeconds!)) return true;
    this.merge(stream, { event: { ...event }, createdAt: now, readyAt: now, attempts: 0 });
    // A retained cumulative claim still needs an acknowledged exposure first,
    // including after an older stream was evicted. Exposure never invents time.
    if (event.kind === "watch" && !stream.exposed && stream.active?.event.kind !== "exposure" &&
        !stream.pending.some(job => job.event.kind === "exposure")) {
      stream.pending.unshift({ event: { ...event, kind: "exposure", watchSeconds: undefined }, createdAt: now, readyAt: now, attempts: 0 });
    }
    this.pump();
    return true;
  }

  private merge(stream: Stream, incoming: Job) {
    const existing = stream.pending.find(job => job.event.kind === incoming.event.kind);
    if (!existing) {
      if (incoming.event.kind === "exposure") stream.pending.unshift(incoming);
      else stream.pending.push(incoming);
      return;
    }
    if (incoming.event.kind === "watch") {
      // The input is already cumulative. Never add a replayed cumulative claim.
      existing.event.watchSeconds = Math.max(existing.event.watchSeconds!, incoming.event.watchSeconds!);
      if (incoming.event.actorToken) existing.event.actorToken = incoming.event.actorToken;
      // Fresh samples replace unsent old samples, but cannot reset a retry budget.
      existing.createdAt = existing.attempts || incoming.attempts
        ? Math.min(existing.createdAt, incoming.createdAt) : Math.max(existing.createdAt, incoming.createdAt);
    }
    existing.attempts = Math.max(existing.attempts, incoming.attempts);
    existing.readyAt = Math.max(existing.readyAt, incoming.readyAt);
  }

  private prune(now: number) {
    for (const [key, until] of this.blocked) if (until <= now) this.blocked.delete(key);
    const expired = (job: Job) => now - job.createdAt >= MAX_EVENT_AGE_MS ||
      // Tap/feedback idempotency uses the server's UTC day. An indeterminate
      // attempt must not be retried into a different day's deduplication key.
      (job.attempts > 0 && job.event.kind !== "watch" && job.event.kind !== "exposure" &&
        Math.floor(job.createdAt / 86_400_000) !== Math.floor(now / 86_400_000));
    for (const stream of this.streams.values()) {
      if (stream.pending.some(job => job.event.kind === "exposure" && expired(job))) {
        // Do not send a watch whose required exposure expired in the backlog.
        stream.pending = [];
      } else stream.pending = stream.pending.filter(job => !expired(job));
    }
  }

  private pump() {
    clearTimeout(this.wake);
    this.wake = undefined;
    const now = Date.now();
    this.prune(now);
    while (this.active < MAX_ACTIVE) {
      const stream = [...this.streams.values()].find(value => !value.active && value.pending.length && value.pending[0].readyAt <= now);
      if (!stream) break;
      const job = stream.pending.shift()!;
      stream.active = job;
      this.active++;
      // Rotate dispatched streams so a long video cannot starve other posts.
      this.streams.delete(stream.key);
      this.streams.set(stream.key, stream);
      void this.dispatch(stream, job);
    }
    const wakeAt = Math.min(...[...this.streams.values()].flatMap(stream => [
      ...stream.pending.map(job => job.createdAt + MAX_EVENT_AGE_MS),
      !stream.active && this.active < MAX_ACTIVE && stream.pending.length ? stream.pending[0].readyAt : Infinity,
    ]));
    if (Number.isFinite(wakeAt)) this.wake = setTimeout(() => this.pump(), Math.max(1, wakeAt - Date.now()));
  }

  private async dispatch(stream: Stream, job: Job) {
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let response: EventResponse | undefined;
    job.attempts++;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => this.send({ ...job.event }, controller.signal)),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            controller.abort();
            reject(new Error("Feed telemetry deadline exceeded"));
          }, REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch { /* Network errors and deadlines follow the same bounded retry policy. */ }
    finally { clearTimeout(deadline); }
    stream.active = null;
    this.active--;
    if (response?.ok) {
      if (job.event.kind === "exposure") stream.exposed = true;
    } else {
      const transient = !response || response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      const now = Date.now();
      if (transient && job.attempts < MAX_ATTEMPTS && now - job.createdAt < MAX_EVENT_AGE_MS) {
        const header = response?.headers?.get("retry-after");
        const retryAfter = header == null ? 0 : /^\d+(?:\.\d+)?$/.test(header)
          ? Number(header) * 1000 : Math.max(0, Date.parse(header) - now);
        const backoff = 1000 * 2 ** (job.attempts - 1) + Math.floor(Math.random() * 250);
        job.readyAt = now + Math.max(backoff, Number.isFinite(retryAfter) ? Math.min(retryAfter, FAILURE_COOLDOWN_MS) : 0);
        this.merge(stream, job);
        // Retries retain ordering before later events from this same post.
        const retryIndex = stream.pending.findIndex(value => value.event.kind === job.event.kind);
        if (retryIndex > 0) stream.pending.unshift(stream.pending.splice(retryIndex, 1)[0]);
      } else {
        // A denied or repeatedly failing stream is dropped, not retried for
        // every subsequent timeupdate. A new session has its own independent key.
        stream.pending = [];
        this.streams.delete(stream.key);
        this.blocked.set(stream.key, now + FAILURE_COOLDOWN_MS);
        while (this.blocked.size > MAX_STREAMS) this.blocked.delete(this.blocked.keys().next().value!);
      }
    }
    this.pump();
  }
}
