/**
 * Atomic counters — lib/updatePostMetrics.ts and lib/updateInterestScore.ts
 *
 * Drives both helpers against an in-memory "database" that behaves like
 * Postgres in the one way that matters here: the RPC path applies
 * `col = col + delta` as a single operation, while the legacy path does a
 * SELECT, a JavaScript add, then an UPSERT, with a real async gap in between.
 *
 * Firing a few hundred concurrent calls shows the lost-update race on the old
 * path and proves the new path counts exactly.
 */

type Row = Record<string, number | string | null>;

const db = {
  post_metrics: new Map<string, Row>(),
  user_interest_scores: new Map<string, Row>(),
  posts: new Map<string, Row>(),
  post_events: [] as Row[],
  functionsInstalled: true,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const MISSING = { code: "PGRST202", message: "Could not find the function public.x in the schema cache" };

function makeFake() {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ name, args });
      if (!db.functionsInstalled) return { data: null, error: MISSING };
      await tick();
      if (name === "bump_post_metrics_scored") {
        const id = args.p_post_id as string;
        const r = db.post_metrics.get(id) ?? {
          post_id: id, impressions: 0, views: 0, total_watch_seconds: 0, completions: 0,
          profile_clicks: 0, buy_clicks: 0, checkout_starts: 0, purchases: 0, post_conversion_score: 0,
        };
        // single statement: no interleaving possible between read and write
        for (const f of ["impressions", "views", "completions", "profile_clicks", "buy_clicks", "checkout_starts", "purchases"]) {
          r[f] = (r[f] as number) + Math.max(0, (args[`p_${f}`] as number) ?? 0);
        }
        r.total_watch_seconds = (r.total_watch_seconds as number) + ((args.p_watch_seconds as number) ?? 0);
        r.post_conversion_score =
          (r.purchases as number) * 25 + (r.checkout_starts as number) * 10 + (r.buy_clicks as number) * 5 +
          (r.completions as number) * 3 + (r.views as number);
        db.post_metrics.set(id, r);
        return { data: r, error: null };
      }
      if (name === "bump_interest_score") {
        const key = `${args.p_user_id}|${args.p_category}`;
        const r = db.user_interest_scores.get(key) ?? { score: 0 };
        r.score = (r.score as number) + (args.p_delta as number);
        db.user_interest_scores.set(key, r);
        return { data: r.score, error: null };
      }
      return { data: null, error: MISSING };
    },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const chain: Record<string, unknown> = {};
      const rowsFor = () => {
        if (table === "post_metrics") return [...db.post_metrics.values()].filter((r) => filters.every(([k, v]) => r[k] === v));
        if (table === "user_interest_scores") return [...db.user_interest_scores.entries()]
          .filter(([k]) => { const [u, c] = k.split("|"); return filters.every(([fk, fv]) => (fk === "user_id" ? u === fv : fk === "category" ? c === fv : true)); })
          .map(([, r]) => r);
        if (table === "posts") return [...db.posts.values()].filter((r) => filters.every(([k, v]) => r[k] === v));
        return [];
      };
      chain.select = () => chain;
      chain.eq = (k: string, v: unknown) => { filters.push([k, v]); return chain; };
      chain.maybeSingle = async () => { await tick(); const rows = rowsFor(); return { data: rows[0] ?? null, error: null }; };
      chain.upsert = async (row: Row) => { await tick(); db.post_metrics.set(row.post_id as string, { ...row }); return { error: null }; };
      chain.insert = async (rows: Row | Row[]) => {
        await tick();
        if (table === "post_events") { db.post_events.push(...(Array.isArray(rows) ? rows : [rows])); return { error: null }; }
        if (table === "user_interest_scores") {
          const r = rows as Row;
          const key = `${r.user_id}|${r.category}`;
          if (db.user_interest_scores.has(key)) return { error: { code: "23505", message: "duplicate key" } };
          db.user_interest_scores.set(key, { score: r.score });
          return { error: null };
        }
        return { error: null };
      };
      chain.update = (patch: Row) => {
        const upd = {
          eq: (k: string, v: unknown) => { filters.push([k, v]); return upd; },
          then: (res: (x: { error: null }) => void) => {
            tick().then(() => {
              if (table === "user_interest_scores") {
                for (const [key, r] of db.user_interest_scores.entries()) {
                  const [u, c] = key.split("|");
                  if (filters.every(([fk, fv]) => (fk === "user_id" ? u === fv : fk === "category" ? c === fv : true))) {
                    db.user_interest_scores.set(key, { ...r, score: patch.score });
                  }
                }
              }
              res({ error: null });
            });
          },
        };
        return upd;
      };
      return chain;
    },
  };
}

jest.mock("@supabase/supabase-js", () => ({ createClient: () => makeFake() }));

import { updatePostMetrics, clampWatchSeconds, MAX_WATCH_SECONDS } from "@/lib/updatePostMetrics";
import { updateInterestScore } from "@/lib/updateInterestScore";

beforeEach(() => {
  db.post_metrics.clear();
  db.user_interest_scores.clear();
  db.posts.clear();
  db.post_events.length = 0;
  db.rpcCalls.length = 0;
  db.functionsInstalled = true;
  db.posts.set("p1", { id: "p1", creator_id: "c1" });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const N = 200;

describe("updatePostMetrics", () => {
  test(`${N} concurrent views count exactly ${N} through the atomic RPC`, async () => {
    await Promise.all(Array.from({ length: N }, () => updatePostMetrics("p1", { views: 1 }, 30, "u1")));
    const m = db.post_metrics.get("p1")!;
    expect(m.views).toBe(N);
    expect(m.total_watch_seconds).toBe(N * 30);
    expect(m.post_conversion_score).toBe(N); // views * 1
    expect(db.rpcCalls.every((c) => c.name === "bump_post_metrics_scored")).toBe(true);
    expect(db.post_events).toHaveLength(N);
  });

  test("the legacy read-then-write path loses updates under the same load (why 006 exists)", async () => {
    db.functionsInstalled = false;
    await Promise.all(Array.from({ length: N }, () => updatePostMetrics("p1", { views: 1 })));
    const m = db.post_metrics.get("p1")!;
    expect(m.views).toBeLessThan(N); // the race, reproduced
    expect(m.views).toBeGreaterThan(0); // but it still works, so merging early is safe
  });

  test("falls back only when the function is missing, not on other errors", async () => {
    db.functionsInstalled = false;
    await updatePostMetrics("p1", { impressions: 1 });
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.post_metrics.get("p1")?.impressions).toBe(1); // via fallback upsert
  });

  test("mixed counters and the score formula", async () => {
    await updatePostMetrics("p1", { views: 10, completions: 5, buy_clicks: 2, checkout_starts: 1, purchases: 1 });
    const m = db.post_metrics.get("p1")!;
    expect(m.post_conversion_score).toBe(1 * 25 + 1 * 10 + 2 * 5 + 5 * 3 + 10);
  });

  test("negative or absurd deltas and watch times are clamped", async () => {
    await updatePostMetrics("p1", { views: -50, impressions: 1e9 }, 9_999_999);
    const m = db.post_metrics.get("p1")!;
    expect(m.views).toBe(0);
    expect(m.impressions).toBe(1000);
    expect(m.total_watch_seconds).toBe(MAX_WATCH_SECONDS);
    expect(clampWatchSeconds(-1)).toBe(0);
    expect(clampWatchSeconds("12" as unknown as number)).toBe(0);
    expect(clampWatchSeconds(45.5)).toBe(45.5);
  });

  test("no post id is a silent no-op", async () => {
    await updatePostMetrics(null, { views: 1 });
    await updatePostMetrics(undefined, { views: 1 });
    expect(db.rpcCalls).toHaveLength(0);
  });
});

describe("updateInterestScore", () => {
  test(`${N} concurrent +1s land as exactly ${N} through the atomic RPC`, async () => {
    await Promise.all(Array.from({ length: N }, () => updateInterestScore("u1", "Money & Investing", 1)));
    expect(db.user_interest_scores.get("u1|money & investing")?.score).toBe(N);
  });

  test("legacy path loses updates under the same load", async () => {
    db.functionsInstalled = false;
    await Promise.all(Array.from({ length: N }, () => updateInterestScore("u1", "money & investing", 1)));
    const score = db.user_interest_scores.get("u1|money & investing")?.score as number;
    expect(score).toBeLessThan(N);
    expect(score).toBeGreaterThan(0);
  });

  test("unknown categories never reach the database", async () => {
    await updateInterestScore("u1", "$$$random$$$", 5);
    await updateInterestScore("u1", "entrepreneur", 5); // hashtag, not a category
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.user_interest_scores.size).toBe(0);
  });

  test("category is normalised to the stored lowercase form", async () => {
    await updateInterestScore("u1", "  Health & Fitness ", 3);
    expect(db.rpcCalls[0].args.p_category).toBe("health & fitness");
  });

  test("zero, NaN or missing inputs are no-ops", async () => {
    await updateInterestScore("u1", "health & fitness", 0);
    await updateInterestScore("u1", "health & fitness", NaN);
    await updateInterestScore(null, "health & fitness", 5);
    await updateInterestScore("u1", null, 5);
    expect(db.rpcCalls).toHaveLength(0);
  });
});
