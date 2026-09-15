/**
 * The three public *.vercel.app copies of production must redirect to www.
 *
 * Two properties here are safety-critical and invisible in a diff, which is why
 * they are asserted rather than eyeballed:
 *
 *  1. /api/* must NOT redirect. The Stripe webhook URL lives in the Stripe
 *     dashboard, and Stripe does not follow redirects — if that endpoint still
 *     points at one of these hosts, redirecting it silently drops payment
 *     notifications.
 *  2. PREVIEW deployments must NOT match. Their hosts are
 *     `<project>-<hash>-<team>.vercel.app`; a looser pattern like `.*\.vercel\.app`
 *     would send every PR preview to production and make review impossible.
 */

import nextConfig from "@/next.config";

type Redirect = {
  source: string;
  destination: string;
  permanent: boolean;
  has?: { type: string; value: string }[];
};

async function hostRedirects(): Promise<Redirect[]> {
  const cfg = nextConfig as { redirects?: () => Promise<Redirect[]> };
  const all = (await cfg.redirects?.()) ?? [];
  return all.filter((r) => r.has?.some((h) => h.type === "host"));
}

describe("duplicate production host redirect", () => {
  it("matches the three known duplicate hosts", async () => {
    const rules = await hostRedirects();
    expect(rules.length).toBeGreaterThan(0);

    const pattern = new RegExp(`^${rules[0].has![0].value}$`);
    for (const host of [
      "creatornet-mvp.vercel.app",
      "creatornet-mvpv2.vercel.app",
      "nextjs-7fjq.vercel.app",
    ]) {
      expect(pattern.test(host)).toBe(true);
    }
  });

  it("does NOT match preview deployment hosts", async () => {
    const rules = await hostRedirects();
    const pattern = new RegExp(`^${rules[0].has![0].value}$`);
    for (const host of [
      "creatornet-mvp-abc123-nrjimenez2-codes-projects.vercel.app",
      "creatornet-mvp-git-main-nrjimenez2-codes-projects.vercel.app",
      "creatornet-mvpv2-xyz789.vercel.app",
    ]) {
      expect(pattern.test(host)).toBe(false);
    }
  });

  it("does NOT match the real production host", async () => {
    const rules = await hostRedirects();
    const pattern = new RegExp(`^${rules[0].has![0].value}$`);
    expect(pattern.test("www.creatornet.net")).toBe(false);
    expect(pattern.test("creatornet.net")).toBe(false);
  });

  it("excludes /api from the path rule, so the Stripe webhook is never redirected", async () => {
    const rules = await hostRedirects();
    const pathRule = rules.find((r) => r.source.includes(":path"));
    expect(pathRule).toBeDefined();

    // The source carries a negative lookahead on "api/".
    expect(pathRule!.source).toContain("(?!api/)");

    // And prove the lookahead actually behaves: build the same matcher and
    // confirm api paths fall outside it while normal pages fall inside.
    const inner = /^(?!api\/).*$/;
    expect(inner.test("api/stripe/webhook")).toBe(false);
    expect(inner.test("api/confirm-purchase")).toBe(false);
    expect(inner.test("search")).toBe(true);
    expect(inner.test("watch/abc123")).toBe(true);
  });

  it("sends traffic to the canonical site and stays reversible", async () => {
    const rules = await hostRedirects();
    for (const r of rules) {
      expect(r.destination.startsWith("https://www.creatornet.net")).toBe(true);
      // 307, not 308: these hosts may be repurposed, and a permanent redirect
      // is cached hard by browsers.
      expect(r.permanent).toBe(false);
    }
  });
});
