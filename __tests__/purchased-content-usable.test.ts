/**
 * A purchased post must be usable: it must show who made it, and it must hand
 * over the file the buyer paid for.
 *
 * Two separate defects, both verified against production 2026-08-31:
 *
 * 1. ATTRIBUTION. public.profiles has exactly two SELECT policies —
 *    `admin_read_profiles` USING is_admin() and `read own profile` USING
 *    (auth.uid() = id). There is NO cross-user read. So any page that loads
 *    another creator's profile with the RLS-scoped browser client gets nothing:
 *    the watch page showed a purchased video with no creator, and the library
 *    listed every item as an anonymous "Creator". Both must go through
 *    /api/profiles, which is auth-gated, uses the service role, and returns
 *    display columns only.
 *
 * 2. DELIVERY. 8 posts carry a `premium_path` (7 of them also priced), but
 *    nothing in the app called either route that can sign that file
 *    (/api/premium/access, GET /api/watch/[postId]) — only /api/watch/progress,
 *    which is the resume-position endpoint. A buyer could pay and have no way
 *    to get their file. The watch page now requests the signed URL and renders
 *    a download link; entitlement is still enforced server-side by that route.
 */

import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

const watch = read("app/watch/[postId]/page.tsx");
const library = read("app/library/page.tsx");

describe("creator attribution does not depend on a cross-user profiles read", () => {
  test("the watch page does not read profiles directly", () => {
    expect(watch).not.toMatch(/\.from\(\s*["']profiles["']\s*\)/);
  });

  test("the library does not read profiles directly", () => {
    expect(library).not.toMatch(/\.from\(\s*["']profiles["']\s*\)/);
  });

  test("both resolve creators through /api/profiles", () => {
    expect(watch).toContain("/api/profiles?ids=");
    expect(library).toContain("/api/profiles?ids=");
  });

  test("that route still returns display columns only", () => {
    // If someone widens this select, profile data leaks to any signed-in user.
    const route = read("app/api/profiles/route.ts");
    expect(route).toContain('.select("id, full_name, username, avatar_url")');
    expect(route).toMatch(/authError\s*\|\|\s*!user/); // stays auth-gated
  });
});

describe("a buyer can actually get the file they paid for", () => {
  test("the watch page requests the signed premium URL", () => {
    expect(watch).toMatch(/fetch\(\s*`\/api\/watch\/\$\{post\.id\}`/);
  });

  test("it renders a download link when one comes back", () => {
    expect(watch).toMatch(/href=\{premiumUrl\}/);
  });

  test("a post with no premium file is not treated as an error", () => {
    // The route 404s when premium_path is null; that is the normal case for
    // most posts and must not surface a scary message.
    expect(watch).toMatch(/res\.status === 404/);
  });

  test("entitlement is still enforced by the server, not the client", () => {
    const route = read("app/api/watch/[postId]/route.ts");
    expect(route).toContain('.eq("access_granted", true)');
    expect(route).toMatch(/status:\s*402/); // payment required
    expect(route).toMatch(/status:\s*401/); // unauthorized
  });
});
