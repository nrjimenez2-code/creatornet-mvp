import type { PostRow } from './feedV3';

export type FeedOfferJob = { post: PostRow; generation: number; version: number };
type Pending = { job: FeedOfferJob; readyAt: number };
type Ports = {
  load: (posts: PostRow[], signal: AbortSignal) => Promise<PostRow[]>;
  isCurrent: (job: FeedOfferJob) => boolean;
  apply: (results: { job: FeedOfferJob; offer: PostRow }[]) => void;
  capacityAvailable: () => void;
};
const MAX_PENDING = 200, MAX_BATCH = 100, COALESCE_MS = 25;

/** One owner, one original read, bounded queued snapshots. Cancelling a generation
 * does not release an ignored-abort transport's slot before its promise settles.
 * Capacity-refused rows remain the owner's responsibility; failed reads never retry.
 */
export class FeedOfferRefreshQueue {
  private pending = new Map<string, Pending>();
  private active: AbortController | null = null;
  private wake: ReturnType<typeof setTimeout> | undefined;
  private generation: number | null = null;
  constructor(private ports: Ports) {}

  begin(generation: number) {
    this.stop();
    this.generation = generation;
  }
  stop() {
    this.generation = null;
    this.pending.clear();
    clearTimeout(this.wake); this.wake = undefined;
    this.active?.abort();
  }
  remove(id: string) { this.pending.delete(id); }
  status() { return { pending: this.pending.size, active: this.active ? 1 : 0 }; }
  private current(job: FeedOfferJob) {
    return this.generation === job.generation && this.ports.isCurrent(job);
  }
  /** Return only current jobs refused for capacity, never stale jobs or failures. */
  enqueue(jobs: readonly FeedOfferJob[], immediate = false): FeedOfferJob[] {
    const deferred: FeedOfferJob[] = [];
    for (const job of jobs) {
      if (!this.current(job)) continue;
      const previous = this.pending.get(job.post.id);
      if (!previous && this.pending.size >= MAX_PENDING) { deferred.push(job); continue; }
      this.pending.set(job.post.id, { job, readyAt: immediate ? Date.now() : previous?.readyAt ?? Date.now() + COALESCE_MS });
    }
    this.pump();
    return deferred;
  }
  private pump() {
    clearTimeout(this.wake); this.wake = undefined;
    if (this.active || this.generation === null) return;
    const jobs: FeedOfferJob[] = [];
    const now = Date.now();
    let next = Infinity;
    for (const [id, pending] of this.pending) {
      if (!this.current(pending.job)) { this.pending.delete(id); continue; }
      if (pending.readyAt <= now && jobs.length < MAX_BATCH) {
        jobs.push(pending.job); this.pending.delete(id);
      } else next = Math.min(next, pending.readyAt);
    }
    if (!jobs.length) {
      if (Number.isFinite(next)) this.wake = setTimeout(() => this.pump(), Math.max(1, next - now));
      return;
    }
    const controller = new AbortController();
    this.active = controller;
    this.ports.capacityAvailable();
    void Promise.resolve().then(async () => {
      // Deletion or a generation change can happen before this microtask runs.
      const current = jobs.filter(job => this.current(job));
      if (controller.signal.aborted || !current.length) return;
      const offers = await this.ports.load(current.map(job => job.post), controller.signal);
      if (controller.signal.aborted) return;
      const byId = new Map(offers.map(offer => [offer.id, offer]));
      const results: { job: FeedOfferJob; offer: PostRow }[] = [];
      for (const job of current) {
        const offer = byId.get(job.post.id);
        if (offer && this.current(job)) results.push({ job, offer });
      }
      if (results.length) this.ports.apply(results);
    }).catch(() => { /* Unavailable metadata stays blocked; no read retry. */ }).finally(() => {
      this.active = null;
      if (this.generation === null) return;
      this.ports.capacityAvailable();
      this.pump();
    });
  }
}
