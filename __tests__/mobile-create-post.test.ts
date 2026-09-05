/**
 * Creating a post must not be gated on Stripe Connect.
 *
 * app/dashboard/page.tsx used to check `window.matchMedia("(min-width: 1024px)")`
 * and, below that width, refuse to open the composer unless the creator's
 * Stripe Connect onboarding was complete — showing a "Connect Stripe first"
 * modal instead. That blocked posting anything at all from a phone, including a
 * free video, for every creator without Connect. Verified in production
 * 2026-08-31: zero of 47 accounts had stripe_onboarding_complete, so no mobile
 * user could post.
 *
 * It was also stricter than the server, which requires Connect only when a post
 * actually sells something:
 *   app/api/posts/route.ts — `selling && !(await isCreatorSellReady(user.id))` → 403
 *
 * PostComposer already enforces the real rule on its own: it fetches the
 * Connect status and, when not ready, clears attachBuy/productId/price and
 * disables those controls — so a non-connected creator can only make a free
 * post. These tests pin that arrangement.
 */

import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

describe("create post is not gated on Stripe Connect", () => {
  const dashboard = read("app/dashboard/page.tsx");

  test("the create handler does not branch on viewport width", () => {
    const handler = dashboard.slice(
      dashboard.indexOf("function handleRequestCreatePost"),
      dashboard.indexOf("function handleRequestCreatePost") + 600
    );
    expect(handler).not.toContain("matchMedia");
    expect(handler).not.toContain("min-width: 1024px");
  });

  test("the create handler does not consult Connect status", () => {
    const handler = dashboard.slice(
      dashboard.indexOf("function handleRequestCreatePost"),
      dashboard.indexOf("function handleRequestCreatePost") + 600
    );
    expect(handler).not.toContain("connect/status");
    expect(handler).not.toContain("onboarding_complete");
  });

  test("no Connect gate modal blocks the composer", () => {
    expect(dashboard).not.toContain("MobileStripeConnectGateModal");
  });
});

describe("the composer still enforces the real selling rule", () => {
  const composer = read("components/PostComposer.tsx");

  test("it reads the creator's Connect status", () => {
    expect(composer).toContain("/api/stripe/connect/status");
    expect(composer).toMatch(/setStripeSellReady/);
  });

  test("it clears every selling field when Connect is not ready", () => {
    // Reset now runs in the asynchronous status response, not a prop-sync
    // effect. creator-ui-state.test.ts also exercises this in the rendered UI.
    const guard = composer.slice(composer.indexOf("if (!ready)"));
    const block = guard.slice(0, guard.indexOf("}") + 1);
    expect(block).toContain("setAttachBuy(false)");
    expect(block).toContain("setProductId(null)");
    expect(block).toContain('setPriceDollars("")');
  });

  test("the server still refuses a selling post without Connect", () => {
    // The client relaxation above is only safe because this stays true.
    const postsRoute = read("app/api/posts/route.ts");
    expect(postsRoute).toMatch(/selling\s*&&\s*!\(await isCreatorSellReady/);
    expect(postsRoute).toContain("STRIPE_CONNECT_REQUIRED");
  });
});
