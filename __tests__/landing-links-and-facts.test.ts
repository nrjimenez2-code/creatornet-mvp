/**
 * The landing page exists to pass a Stripe website review and to be the
 * founder's public front door. Two things must therefore always hold:
 *   1. every link goes somewhere real (Noah: "no placeholder buttons, dead
 *      links ... in the areas Stripe needs to review");
 *   2. the product facts Stripe reads are present and correct.
 *
 * Filesystem-driven over components/landing/*.tsx. Mutation-checked.
 */

import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "components", "landing");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".tsx"));
/** Source with comments stripped and whitespace collapsed — what a reviewer can actually see. */
function visible(raw: string): string {
  return raw
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
}
const src = Object.fromEntries(files.map((f) => [f, visible(fs.readFileSync(path.join(DIR, f), "utf8"))]));
const all = Object.values(src).join("\n");

/** Routes that genuinely exist in this app (pages under app/, plus mailto). */
const REAL_ROUTES = new Set([
  "/",
  "/auth",
  "/dashboard",
  "/legal/terms",
  "/legal/privacy",
  "/legal/cookies",
  "/legal/refunds",
  "/legal/delivery",
  "/legal/creators",
  "/legal/support",
  "mailto:support@creatornet.net",
]);

function hrefs(): string[] {
  return [...all.matchAll(/href=\{?["'`]([^"'`]+)["'`]\}?/g)].map((m) => m[1]);
}
function anchorIds(): Set<string> {
  return new Set([...all.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

describe("every landing-page link is real", () => {
  it("has no placeholder href=\"#\" left over from the mockup", () => {
    expect(hrefs().filter((h) => h === "#")).toEqual([]);
  });

  it("points only at routes that exist, or at in-page anchors that exist", () => {
    const ids = anchorIds();
    for (const h of hrefs()) {
      if (h.startsWith("#")) {
        expect(ids.has(h.slice(1))).toBe(true);
      } else {
        expect(REAL_ROUTES.has(h)).toBe(true);
      }
    }
  });

  it("each route listed above really has a page", () => {
    for (const r of REAL_ROUTES) {
      if (r.startsWith("mailto:")) continue;
      const page = r === "/" ? "app/page.tsx" : `app${r}/page.tsx`;
      expect(fs.existsSync(path.join(process.cwd(), page))).toBe(true);
    }
  });

  it("links the four policy pages Stripe reads, plus Terms and Privacy, from the footer", () => {
    for (const r of ["/legal/terms", "/legal/privacy", "/legal/refunds", "/legal/delivery", "/legal/creators", "/legal/support"]) {
      expect(src["FinalCta.tsx"]).toContain(`href="${r}"`);
    }
  });
});

describe("the product facts a reviewer reads", () => {
  it("states the 12% fee, Stripe payouts, USD, and the not-a-money-transfer line", () => {
    expect(src["Flow.tsx"]).toMatch(/12% platform fee/);
    expect(src["Flow.tsx"]).toMatch(/Stripe/);
    expect(all).toMatch(/USD/);
    expect(src["Flow.tsx"]).toMatch(/not a way to send money/);
  });

  it("names the four offer types", () => {
    for (const t of ["courses", "mentorship", "1-on-1 calls", "digital products"]) {
      expect(src["Cover.tsx"]).toContain(t);
    }
  });

  it("uses the exact production logo asset", () => {
    expect(src["Cover.tsx"]).toContain('src="/creatornet-mark.png"');
  });

  it("invents no support channel and carries no placeholder copy", () => {
    expect(all).not.toMatch(/discord/i);
    expect(all).not.toMatch(/coming soon|lorem ipsum|\bTBD\b/i);
  });

  it("offers a real, monitored contact", () => {
    expect(all).toContain("mailto:support@creatornet.net");
  });
});
