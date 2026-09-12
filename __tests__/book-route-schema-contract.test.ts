/**
 * The booking router's fallback chain must only read columns that exist.
 *
 * Verified against the live production schema (project rvkqxgghqitkwzdsuclz)
 * on 2026-09-11 by asking PostgREST for each column directly:
 *
 *   posts.booking_url      -> 200      exists
 *   closers.booking_url    -> 200      exists
 *   profiles.booking_url   -> 400 42703  "column profiles.booking_url does not exist"
 *   profiles.allow_booking -> 400 42703  "column profiles.allow_booking does not exist"
 *
 * The route used to end with a fourth fallback selecting those two phantom
 * columns from `profiles`. PostgREST rejects any request naming an unknown
 * column, so the query always errored, the `!profErr` guard always failed, and
 * the branch could never redirect anyone. It cost a round trip on every
 * unrouted booking click while reading like a working feature.
 *
 * This is the same defect class as purchases.user_id and
 * watch_progress.duration: the jest mock database accepts any column name, so
 * a schema mismatch passes the suite and only fails in production. Pin it here.
 */
import { readFileSync } from "fs";
import { join } from "path";

const ROUTE = join(process.cwd(), "app/api/book/route.ts");
const source = readFileSync(ROUTE, "utf8");

/**
 * Both names are real columns — on OTHER tables. posts.allow_booking and
 * posts.booking_url exist, and so does closers.booking_url; it is only
 * public.profiles that has neither. So the invariant is not "these words never
 * appear", it is "this route never reads them off profiles".
 */
describe("book route schema contract", () => {
  test("the route never queries public.profiles", () => {
    expect(source).not.toMatch(/\.from\(\s*"profiles"\s*\)/);
  });

  test("every .select() belongs to a table that has those columns", () => {
    // Pair each .select("...") with the .from("...") that precedes it, then
    // check the pair against the live schema verified on 2026-09-11.
    const LIVE: Record<string, string[]> = {
      posts: ["booking_url", "allow_booking", "id", "creator_id", "premium_path"],
      closers: ["booking_url", "weight", "active", "creator_id"],
    };
    const calls = [...source.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)([\s\S]{0,240}?)\.select\(\s*"([^"]+)"\s*\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, table, , list] of calls) {
      expect(Object.keys(LIVE)).toContain(table);
      for (const column of list.split(",").map((c) => c.trim())) {
        expect(LIVE[table]).toContain(column);
      }
    }
  });

  test("the three real booking sources are still wired up", () => {
    // posts.booking_url, next_booking_target(), closers.booking_url — all
    // verified present in production. Removing the dead fallback must not
    // quietly remove a live one.
    expect(source).toMatch(/\.from\(\s*"posts"\s*\)/);
    expect(source).toMatch(/next_booking_target/);
    expect(source).toMatch(/\.from\(\s*"closers"\s*\)/);
  });

  test("an unrouted creator still gets a 404, not a redirect or a crash", () => {
    expect(source).toContain("No booking destination configured for this creator.");
    expect(source).toMatch(/status:\s*404/);
  });
});
