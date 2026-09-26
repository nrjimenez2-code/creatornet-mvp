import type { FeedTab, PostRow } from "@/lib/feedV3";

const MAX_AGE_MS = 2 * 60 * 1000;
const MAX_SNAPSHOTS = 4;

export type MobileFeedSnapshot = {
  items: PostRow[];
  activePostId: string;
  scrollTop: number;
  savedAt: number;
};

const snapshots = new Map<string, MobileFeedSnapshot>();
const keyFor = (tab: FeedTab, viewerId: string | null) => `${tab}:${viewerId ?? "guest"}`;

/** In-memory only: a short profile visit can restore the phone feed before revalidation. */
export function saveMobileFeedSnapshot(
  tab: FeedTab,
  viewerId: string | null,
  items: PostRow[],
  activePostId: string | null,
  scrollTop: number,
): void {
  if (!items.length || !activePostId || !items.some(item => item.id === activePostId)) return;
  const key = keyFor(tab, viewerId);
  snapshots.delete(key);
  snapshots.set(key, {
    // An offer must be rechecked before its purchase control becomes usable.
    items: items.map(item => ({ ...item, purchaseOptionsReady: false })),
    activePostId,
    scrollTop: Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0,
    savedAt: Date.now(),
  });
  while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
}

export function readMobileFeedSnapshot(tab: FeedTab, viewerId: string | null): MobileFeedSnapshot | null {
  const key = keyFor(tab, viewerId);
  const snapshot = snapshots.get(key);
  if (!snapshot) return null;
  if (Date.now() - snapshot.savedAt > MAX_AGE_MS) {
    snapshots.delete(key);
    return null;
  }
  return snapshot;
}

export function clearMobileFeedSnapshot(tab: FeedTab, viewerId: string | null): void {
  snapshots.delete(keyFor(tab, viewerId));
}
