/**
 * The four code-side critical fixes:
 *   1. installment checkout closed (browser could name its own price)
 *   2. a purchase only unlocks a post that sells that product, by that creator
 *   3. premium_path must live in the creator's own storage folder
 *   4. the paid creator is the product's owner, never the request body
 */

import { readFileSync } from "fs";
import { join } from "path";
import { isOwnPremiumPath } from "@/lib/premiumPath";

const REPO_ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

// ---------------------------------------------------------------- fake db
type Post = { id: string; creator_id: string; product_id: string | null; created_at?: string };
const posts = new Map<string, Post>();

function fakeDb() {
  return {
    from: (table: string) => {
      const f: [string, unknown][] = [];
      const chain: Record<string, unknown> = {};
      const rows = () =>
        table === "posts" ? [...posts.values()].filter((p) => f.every(([k, v]) => (p as never)[k] === v)) : [];
      chain.select = () => chain;
      chain.eq = (k: string, v: unknown) => { f.push([k, v]); return chain; };
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      return chain;
    },
  } as never;
}

import { resolvePostForProduct, INVALID_POST } from "@/lib/checkoutGuards";

beforeEach(() => {
  posts.clear();
  posts.set("post-A1", { id: "post-A1", creator_id: "creator-A", product_id: "prod-A" });
  posts.set("post-A2", { id: "post-A2", creator_id: "creator-A", product_id: "prod-A" });
  posts.set("post-B1", { id: "post-B1", creator_id: "creator-B", product_id: "prod-B" }); // victim premium post
  posts.set("post-X", { id: "post-X", creator_id: "creator-B", product_id: "prod-A" }); // B's post selling A's product
});

describe("resolvePostForProduct (fix 2)", () => {
  test("the post named by the buyer must sell this product", async () => {
    expect(await resolvePostForProduct(fakeDb(), "post-A1", "prod-A", "creator-A")).toBe("post-A1");
  });

  test("cheapest-product-unlocks-any-post is refused", async () => {
    // buyer bought prod-A (creator A) but asked for creator B's premium post
    expect(await resolvePostForProduct(fakeDb(), "post-B1", "prod-A", "creator-A")).toBe(INVALID_POST);
  });

  test("a post by another creator that merely references the product is refused", async () => {
    expect(await resolvePostForProduct(fakeDb(), "post-X", "prod-A", "creator-A")).toBe(INVALID_POST);
  });

  test("unknown or malformed post ids are refused", async () => {
    expect(await resolvePostForProduct(fakeDb(), "nope", "prod-A", "creator-A")).toBe(INVALID_POST);
    expect(await resolvePostForProduct(fakeDb(), "a,b)", "prod-A", "creator-A")).toBe(INVALID_POST);
    expect(await resolvePostForProduct(fakeDb(), 42, "prod-A", "creator-A")).toBe(INVALID_POST);
  });

  test("no post named: falls back to the creator's own post for that product", async () => {
    const r = await resolvePostForProduct(fakeDb(), undefined, "prod-A", "creator-A");
    expect(["post-A1", "post-A2"]).toContain(r);
    expect(await resolvePostForProduct(fakeDb(), "", "prod-Z", "creator-A")).toBeNull();
  });
});

describe("isOwnPremiumPath (fix 3)", () => {
  const me = "1a3ccd15-326d-4b2e-a886-88d898fb00e0";
  test("the shape the composer uploads passes", () => {
    expect(isOwnPremiumPath(`${me}/1764000000000-lesson.mp4`, me)).toBe(true);
    expect(isOwnPremiumPath(`${me}/nested/dir/file.mov`, me)).toBe(true);
  });
  test("another creator's folder is refused", () => {
    expect(isOwnPremiumPath("521c60be-b128-451c-96bd-a37faa0d4b7c/1764-x.mp4", me)).toBe(false);
  });
  test("traversal, absolute and empty paths are refused", () => {
    expect(isOwnPremiumPath(`${me}/../other/file.mp4`, me)).toBe(false);
    expect(isOwnPremiumPath(`/${me}/file.mp4`, me)).toBe(false);
    expect(isOwnPremiumPath(`${me}/`, me)).toBe(false);
    expect(isOwnPremiumPath(`${me}`, me)).toBe(false);
    expect(isOwnPremiumPath(null, me)).toBe(false);
    expect(isOwnPremiumPath(`${me}\\file.mp4`, me)).toBe(false);
  });
});

describe("source tripwires", () => {
  const checkout = read("app/api/checkout/route.ts");

  test("fix 1: installment checkout no longer creates a Stripe session", () => {
    const block = checkout.slice(checkout.indexOf('if (body.type === "installments") {'), checkout.indexOf('if (body.type === "booking")'));
    expect(block).toMatch(/status: 410/);
    expect(block).not.toMatch(/sessions\.create/);
    expect(block).not.toMatch(/plan_price_cents\)/);
  });

  test("fix 4: product checkout takes the creator from the product row only", () => {
    const block = checkout.slice(checkout.indexOf('if (body.type === "product") {'), checkout.indexOf('if (body.type === "installments") {'));
    expect(block).not.toMatch(/body\.creator_id/);
    expect(block).toMatch(/const creatorId = \(prod as \{ creator_id\?: string \}\)\.creator_id/);
  });

  test("fix 2: product checkout never copies body.post_id into orders/purchases/metadata", () => {
    const block = checkout.slice(checkout.indexOf('if (body.type === "product") {'), checkout.indexOf('if (body.type === "installments") {'));
    expect(block).not.toMatch(/post_id: body\.post_id/);
    expect(block).toMatch(/resolvePostForProduct\(/);
    expect(block).toMatch(/INVALID_POST/);
    // the pending-purchase writer takes the resolved post id, not the body
    expect(checkout).toMatch(/post_id: postId,\s*\n\s*creator_id: creatorId,/);
  });

  test("fix 3: posts route validates premium_path and watch route re-checks it", () => {
    expect(read("app/api/posts/route.ts")).toMatch(/isOwnPremiumPath\(premiumRaw, user\.id\)/);
    expect(read("app/api/watch/[postId]/route.ts")).toMatch(/post\.creator_id === user\.id && isOwnPremiumPath\(post\.premium_path, user\.id\)/);
  });

  test("SQL 009 locks the profile flags, the open tables and the rating function", () => {
    const sql = read("supabase/schema/009-lock-profile-flags-and-open-tables.sql");
    expect(sql).toMatch(/REVOKE INSERT, UPDATE ON public\.profiles FROM anon, authenticated/);
    expect(sql).not.toMatch(/GRANT UPDATE \([^)]*stripe_/);
    expect(sql).not.toMatch(/GRANT UPDATE \([^)]*total_earnings/);
    for (const t of ["booking_payments", "profile_reviews", "post_engagements", "_patch_export"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
    }
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.set_profile_rating/);
  });
});
