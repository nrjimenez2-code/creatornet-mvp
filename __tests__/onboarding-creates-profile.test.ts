/**
 * Onboarding must actually CREATE the profile row, and must not let a user
 * out of the form in a state the "/" gate rejects.
 *
 * Signing up creates a row in auth.users but nothing creates the matching
 * public.profiles row — there is no database trigger for it. Onboarding used
 * `.update().eq("id", userId)`, which matches zero rows for a brand-new user,
 * returns NO error, and so reported success while saving nothing. The user was
 * sent to /dashboard with no username, and app/page.tsx bounced them back to
 * /onboarding on their next visit to "/". Forever.
 *
 * Observed in production 2026-08-31: 36 of 47 accounts had no profile row at
 * all; the last profile row was created 2026-05-31 and all 6 accounts that
 * signed up after that date had none.
 *
 * Two traps this pins down, both found by review rather than by the gate:
 *
 * 1. `.upsert()` is NOT usable here. PostgREST compiles it to
 *    `INSERT ... ON CONFLICT("id") DO UPDATE SET "id" = EXCLUDED."id", ...`
 *    and migration 009 grants `authenticated` INSERT on `id` but not UPDATE,
 *    so it fails with 42501 permission denied. Insert-then-update stays inside
 *    the granted column lists.
 * 2. The form's exit condition must match app/page.tsx's gate. If Continue can
 *    be pressed with no interests selected, the row saves with `interests: []`
 *    and "/" bounces the user back — the same loop, just one step later.
 */

import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

const src = read("app/onboarding/page.tsx");

/** The profiles write block: from the first profiles call to the redirect. */
const writeBlock = src.slice(
  src.indexOf('.from("profiles")'),
  src.indexOf('trackEvent("onboarding_completed"')
);

describe("onboarding creates the profile row", () => {
  test("inserts, so a brand-new user gets a row", () => {
    expect(writeBlock).toMatch(/\.insert\(/);
  });

  test("the insert payload carries the primary key", () => {
    // Scoped to the insert call itself — a bare `id: userId` grep elsewhere in
    // the file (e.g. trackEvent's `user_id: userId`) must not satisfy this.
    const insertCall = writeBlock.slice(writeBlock.indexOf(".insert("));
    const payload = insertCall.slice(0, insertCall.indexOf("}") + 1);
    expect(payload).toMatch(/(^|[^_\w])id:\s*userId/);
    expect(payload).toContain("username");
    expect(payload).toContain("interests");
  });

  test("does not use upsert (PostgREST would need UPDATE on id, which is revoked)", () => {
    expect(writeBlock).not.toContain(".upsert(");
  });

  test("does not save with a bare update alone", () => {
    // `.update(...).eq("id", ...)` as the ONLY write is the original bug.
    // It may still appear as the fallback after a primary-key conflict.
    const updateOnly =
      /\.update\(/.test(writeBlock) && !/\.insert\(/.test(writeBlock);
    expect(updateOnly).toBe(false);
  });
});

describe("onboarding cannot exit into a state the root gate rejects", () => {
  test("Continue requires at least one interest", () => {
    // app/page.tsx redirects when `interests.length === 0`, so the button must
    // not be enabled with an empty selection.
    const canContinue = src.slice(src.indexOf("const canContinue"));
    const decl = canContinue.slice(0, canContinue.indexOf(";") + 1);
    expect(decl).toMatch(/selected\.length\s*>\s*0/);
  });

  test("no control routes to /dashboard without saving", () => {
    // The old "Skip for now" link called router.replace("/dashboard") directly
    // from an onClick, leaving the user with no row and looping them forever.
    expect(src).not.toMatch(/onClick=\{\(\)\s*=>\s*router\.replace\("\/dashboard"\)\}/);
  });

  test("the root gate this file must satisfy has not moved", () => {
    // If someone changes app/page.tsx's gate, this test should fail loudly so
    // both sides get updated together.
    const rootGate = read("app/page.tsx");
    expect(rootGate).toMatch(/!username\s*\|\|\s*interests\.length\s*===\s*0/);
  });
});
