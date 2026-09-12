/**
 * watch_progress is (user_id, post_id, seconds, updated_at) in production —
 * verified against the live schema on 2026-09-11.
 *
 * The route used to select and upsert `duration` and `completed`, which have
 * never existed. PostgREST rejects a request naming an unknown column, so BOTH
 * GET and POST returned 500 on every call since the route was written: no
 * playback position was ever saved and none was ever restored. That is why
 * "Continue watching" stayed empty and why resuming a video never worked.
 *
 * The jest suite does not execute route handlers, so this guards the contract at
 * the source level: the column names the route sends must be a subset of the
 * columns the table actually has.
 */
import { readFileSync } from "fs";
import { join } from "path";

const ROUTE = join(process.cwd(), "app/api/watch/progress/route.ts");
const LIVE_COLUMNS = ["user_id", "post_id", "seconds", "updated_at"];
const PHANTOM_COLUMNS = ["duration", "completed"];

describe("watch_progress route column contract", () => {
  const source = readFileSync(ROUTE, "utf8");

  test("the .select() list names only columns that exist", () => {
    const select = source.match(/\.select\(\s*"([^"]+)"\s*\)/);
    expect(select).not.toBeNull();
    const selected = select![1].split(",").map((c) => c.trim());
    expect(selected.length).toBeGreaterThan(0);
    for (const column of selected) {
      expect(LIVE_COLUMNS).toContain(column);
    }
  });

  test("the upsert payload names only columns that exist", () => {
    const upsert = source.slice(
      source.indexOf(".upsert("),
      source.indexOf("{ onConflict")
    );
    expect(upsert).toContain("seconds");
    for (const phantom of PHANTOM_COLUMNS) {
      // e.g. `duration,` or `completed:` as an object key in the payload
      expect(upsert).not.toMatch(new RegExp(`\\b${phantom}\\s*[,:]`));
    }
  });

  test("onConflict matches the real primary key (user_id, post_id)", () => {
    expect(source).toContain('onConflict: "user_id,post_id"');
  });
});
