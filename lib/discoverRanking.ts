import { matchInterestTopics, normalizeTopics } from "@/lib/interestTopics";
import { normalizeInterests } from "@/lib/interestCategories";
export type DiscoverEvent = {
  actor: string;
  post_id: string;
  kind: string;
  categories: string[];
  topics: string[];
  audience: string;
  offer_type: string;
  occurred_at: string;
  entity_key?: string;
};
export type DiscoverCandidate = {
  id: string;
  creator_id: string;
  created_at: string;
  interests: string[] | null;
  topics?: string[] | null;
  title?: string | null;
  content?: string | null;
  caption?: string | null;
  offer_type?: string;
  offers?: { title?: string | null; description?: string | null }[];
};
// Operational pilot controls, not fitted commercial weights. Calibrate in a holdout before promotion.
export const DISCOVER_POLICY = {
  evidenceWindowDays: 90,
  preferenceHalfLifeDays: 30,
  initialAudience: 20,
  explorationEvery: 5,
  retestAfterDays: 7,
} as const;
const DAY = 86400000;
const RELATED: Record<string, string[]> = {
  "business & entrepreneurship": [
    "money & investing",
    "content creation & marketing",
  ],
  "money & investing": [
    "business & entrepreneurship",
    "education & career skills",
  ],
  "content creation & marketing": [
    "business & entrepreneurship",
    "technology & ai",
    "arts, design & hobbies",
  ],
  "technology & ai": [
    "education & career skills",
    "content creation & marketing",
  ],
  "health & fitness": ["personal growth & relationships"],
  "personal growth & relationships": [
    "health & fitness",
    "education & career skills",
  ],
  "arts, design & hobbies": [
    "content creation & marketing",
    "education & career skills",
  ],
  "education & career skills": [
    "technology & ai",
    "personal growth & relationships",
    "money & investing",
  ],
};
function explorationOrder(value: string) {
  let hash = 2166136261;
  for (const char of value)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function wilsonLower(success: number, trials: number): number {
  if (trials <= 0) return 0;
  const n = Math.max(0, trials),
    p = Math.min(Math.max(success, 0), n) / n,
    z = 1.96;
  return (
    (p +
      (z * z) / (2 * n) -
      z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) /
    (1 + (z * z) / n)
  );
}
const SIGNAL_ORDER = [
  "qualified_view",
  "completion",
  "like",
  "product_tap",
  "checkout_start",
  "booking_scheduled",
  "purchase",
  "mentorship_purchase",
];
export type DiscoverEvidence = {
  post_id: string;
  audience: string;
  exposures: number;
  sales: number;
  bookings: number;
  intents: number;
  taps: number;
  views: number;
  commercial: number;
  last_exposure: string | null;
};
export function rankDiscover(
  candidates: DiscoverCandidate[],
  events: DiscoverEvent[],
  actor: string,
  declared: unknown,
  declaredTopics: string[] = [],
  now = Date.now(),
  legacy: { category: string; score: number; updated_at: string | null }[] = [],
  evidence?: DiscoverEvidence[],
): string[] {
  const summaries = new Map(
    (evidence ?? []).map((row) => [row.post_id + ":" + row.audience, row]),
  );
  const mine = events.filter((e) => e.actor === actor);
  const categories = new Set(normalizeInterests(declared));
  const topics = new Set(normalizeTopics(declaredTopics));
  const learned = new Map<string, number>();
  const migrated = new Map<string, { score: number; at: number }>();
  for (const prior of legacy) {
    const category = normalizeInterests([prior.category])[0];
    if (!category) continue;
    const current = migrated.get(category) ?? { score: 0, at: 0 };
    migrated.set(category, {
      score: current.score + Math.max(0, prior.score),
      at: Math.max(current.at, Date.parse(prior.updated_at ?? "1970-01-01")),
    });
  }
  const maximum = Math.max(1, ...[...migrated.values()].map((p) => p.score));
  for (const [category, prior] of migrated)
    learned.set(
      category,
      (prior.score / maximum) *
        Math.pow(
          0.5,
          Math.max(0, now - prior.at) /
            (DAY * DISCOVER_POLICY.preferenceHalfLifeDays),
        ),
    );
  const negative = new Map<string, number>();
  for (const e of mine)
    if (e.kind === "quick_skip" || e.kind === "not_interested") {
      const decay = Math.pow(
        0.5,
        Math.max(0, now - Date.parse(e.occurred_at)) /
          (DAY * DISCOVER_POLICY.preferenceHalfLifeDays),
      );
      for (const c of normalizeInterests(e.categories))
        negative.set(c, (negative.get(c) ?? 0) + decay);
    }
  for (const e of mine) {
    const strength = SIGNAL_ORDER.indexOf(e.kind);
    if (strength < 0) continue;
    const decay = Math.pow(
      0.5,
      Math.max(0, now - Date.parse(e.occurred_at)) /
        (DAY * DISCOVER_POLICY.preferenceHalfLifeDays),
    );
    // The hierarchy is ordinal, never added to the post's commercial performance.
    for (const category of normalizeInterests(e.categories))
      learned.set(
        category,
        Math.max(learned.get(category) ?? 0, (strength + 1) * decay),
      );
    if (decay >= 0.5) for (const topic of e.topics ?? []) topics.add(topic);
  }
  const byPost = new Map<string, DiscoverEvent[]>();
  const personalByPost = new Map<string, DiscoverEvent[]>();
  for (const event of mine) {
    const list = personalByPost.get(event.post_id) ?? [];
    list.push(event);
    personalByPost.set(event.post_id, list);
  }
  for (const event of events) {
    const list = byPost.get(event.post_id) ?? [];
    list.push(event);
    byPost.set(event.post_id, list);
  }
  const scored = candidates
    .map((post) => {
      const matching = matchInterestTopics({
        interests: post.interests,
        topics: post.topics,
        title: post.title,
        description: [post.content, post.caption].filter(Boolean).join(" "),
        offers: post.offers,
      });
      const personal = personalByPost.get(post.id) ?? [];
      const dismissed = personal.some(
        (e) =>
          e.kind === "not_interested" &&
          now - Date.parse(e.occurred_at) < 30 * DAY,
      );
      const seen = personal.some((e) => e.kind === "exposure");
      const recent = (byPost.get(post.id) ?? []).filter(
        (e) =>
          now - Date.parse(e.occurred_at) <
          DISCOVER_POLICY.evidenceWindowDays * DAY,
      );
      const preferredAudience =
        matching.topics.find((t) => topics.has(t)) ??
        matching.categories.find((c) => categories.has(c) || learned.has(c)) ??
        "general";
      const cohort = recent.filter((e) => e.audience === preferredAudience);
      const cohortSummary = summaries.get(post.id + ":" + preferredAudience);
      const totalSummary = summaries.get(post.id + ":");
      const summary =
        (cohortSummary?.exposures ?? 0) >= DISCOVER_POLICY.initialAudience
          ? cohortSummary
          : totalSummary;
      const cohortExposure = new Set(
        cohort.filter((e) => e.kind === "exposure").map((e) => e.actor),
      ).size;
      const sample =
        cohortExposure >= DISCOVER_POLICY.initialAudience ? cohort : recent;
      const exposed = new Set(
        sample.filter((e) => e.kind === "exposure").map((e) => e.actor),
      );
      const rate = (kinds: string[]) =>
        evidence !== undefined
          ? wilsonLower(
              summary?.[
                kinds.includes("purchase")
                  ? "sales"
                  : kinds.includes("booking_scheduled")
                    ? "bookings"
                    : kinds.includes("checkout_start")
                      ? "intents"
                      : kinds.includes("product_tap")
                        ? "taps"
                        : "views"
              ] ?? 0,
              summary?.exposures ?? 0,
            )
          : wilsonLower(
              new Set(
                sample
                  .filter((e) => kinds.includes(e.kind) && exposed.has(e.actor))
                  .map((e) => e.actor),
              ).size,
              exposed.size,
            );
      const lastExposure =
        evidence !== undefined
          ? Date.parse(totalSummary?.last_exposure ?? "1970-01-01")
          : recent.reduce(
              (latest, e) =>
                e.kind === "exposure"
                  ? Math.max(latest, Date.parse(e.occurred_at))
                  : latest,
              0,
            );
      const mature =
        (evidence !== undefined ? (summary?.exposures ?? 0) : exposed.size) >=
        DISCOVER_POLICY.initialAudience;
      const age = Math.max(0, now - Date.parse(post.created_at));
      const skipped = personal
        .filter((e) => e.kind === "quick_skip")
        .reduce(
          (sum, e) =>
            sum +
            Math.pow(
              0.5,
              Math.max(0, now - Date.parse(e.occurred_at)) / (30 * DAY),
            ),
          0,
        );
      const relevance =
        matching.categories.reduce(
          (sum, c) =>
            sum +
            ((categories.has(c) ? 1 : 0) + (learned.get(c) ?? 0)) /
              (1 + (negative.get(c) ?? 0)),
          0,
        ) / Math.max(1, matching.categories.length);
      const successes =
        evidence !== undefined
          ? (summary?.commercial ?? 0)
          : new Set(
              sample
                .filter(
                  (e) =>
                    [
                      "purchase",
                      "mentorship_purchase",
                      "booking_scheduled",
                    ].includes(e.kind) && exposed.has(e.actor),
                )
                .map((e) => e.actor),
            ).size;
      const related =
        mature &&
        successes >= 2 &&
        matching.categories.some((c) =>
          (RELATED[c] ?? []).some(
            (other) => categories.has(other as never) || learned.has(other),
          ),
        );
      return {
        post,
        dismissed,
        seen,
        related,
        rotation: explorationOrder(
          actor + ":" + Math.floor(now / DAY) + ":" + post.id,
        ),
        topicMatch: matching.topics.some((t) => topics.has(t)),
        relevance: relevance / (1 + skipped),
        // Compare offer types in separate queues below, so free calls never compete as paid sales.
        sale: mature ? rate(["purchase", "mentorship_purchase"]) : 0,
        booking: mature ? rate(["booking_scheduled"]) : 0,
        intent: mature ? rate(["checkout_start"]) : 0,
        tap: mature ? rate(["product_tap"]) : 0,
        view: rate(["qualified_view"]),
        explore:
          !mature ||
          (lastExposure > 0 &&
            now - lastExposure > DISCOVER_POLICY.retestAfterDays * DAY),
        age,
      };
    })
    .filter((p) => !p.dismissed);
  const compare = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    Number(a.seen) - Number(b.seen) ||
    Number(b.topicMatch) - Number(a.topicMatch) ||
    b.relevance - a.relevance ||
    b.sale - a.sale ||
    b.booking - a.booking ||
    b.intent - a.intent ||
    b.tap - a.tap ||
    b.view - a.view ||
    a.age - b.age ||
    a.post.id.localeCompare(b.post.id);
  // Rank within each offer type; round-robin queues prevent one offer type monopolizing distribution.
  const groups = new Map<string, typeof scored>();
  for (const row of scored) {
    const key = row.post.offer_type ?? "none";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) list.sort(compare);
  const pending: typeof scored = [];
  while ([...groups.values()].some((g) => g.length)) {
    const heads = [...groups.values()]
      .filter((g) => g.length)
      .sort((a, b) => compare(a[0], b[0]));
    for (const queue of heads) pending.push(queue.shift()!);
  }
  const out: string[] = [];
  let lastCreator: string | null = null;
  while (pending.length) {
    const unseen = pending.some((p) => !p.seen);
    const relevant = pending.some(
      (p) => (p.topicMatch || p.relevance > 0) && (!unseen || !p.seen),
    );
    const eligible = (p: (typeof scored)[number]) =>
      (!unseen || !p.seen) && (!relevant || p.topicMatch || p.relevance > 0);
    const explore = out.length % DISCOVER_POLICY.explorationEvery === 0;
    let index = -1;
    if (explore) {
      // Alternate a relevant cold-start/retest with a proven related-audience trial.
      const relatedSlot =
        Math.floor(out.length / DISCOVER_POLICY.explorationEvery) % 2 === 1;
      const trials = pending
        .map((p, index) => ({ p, index }))
        .filter(
          ({ p }) =>
            p.post.creator_id !== lastCreator &&
            (!unseen || !p.seen) &&
            (relatedSlot
              ? p.related && !p.topicMatch && p.relevance === 0
              : eligible(p) && p.explore),
        );
      trials.sort((a, b) => a.p.rotation - b.p.rotation);
      index = trials[0]?.index ?? -1;
    }
    if (index < 0)
      index = pending.findIndex(
        (p) =>
          eligible(p) &&
          p.post.creator_id !== lastCreator &&
          (!explore || p.explore),
      );
    if (index < 0)
      index = pending.findIndex(
        (p) => eligible(p) && p.post.creator_id !== lastCreator,
      );
    if (index < 0)
      index = pending.findIndex(
        (p) => p.post.creator_id !== lastCreator && (!unseen || !p.seen),
      );
    if (index < 0) index = pending.findIndex(eligible);
    if (index < 0) index = 0;
    const [next] = pending.splice(index, 1);
    out.push(next.post.id);
    lastCreator = next.post.creator_id;
  }
  return out;
}
