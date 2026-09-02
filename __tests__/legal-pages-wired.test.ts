/**
 * Every legal/policy page must be reachable and must not carry placeholder
 * copy — Stripe's website review is what these pages exist for, and Noah's
 * brief was explicit: "no placeholder buttons, dead links, fake policies, or
 * 'coming soon' pages in the areas Stripe needs to review."
 *
 * Driven by the filesystem, so adding a page and forgetting the nav or the
 * sitemap fails CI instead of quietly orphaning it. Mutation-checked.
 */

import fs from "node:fs";
import path from "node:path";

const LEGAL_DIR = path.join(process.cwd(), "app", "legal");

function legalRoutes(): string[] {
  return fs
    .readdirSync(LEGAL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(LEGAL_DIR, d.name, "page.tsx")))
    .map((d) => `/legal/${d.name}`)
    .sort();
}

/** JSX text only: strip JSX block comments and line comments before scanning. */
function visibleSource(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("legal pages are wired, not orphaned", () => {
  const routes = legalRoutes();

  it("finds the pages this suite is meant to guard", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        "/legal/terms",
        "/legal/privacy",
        "/legal/cookies",
        "/legal/refunds",
        "/legal/delivery",
        "/legal/creators",
        "/legal/support",
      ])
    );
  });

  it("links every legal page from the legal nav", () => {
    const layout = fs.readFileSync(path.join(LEGAL_DIR, "layout.tsx"), "utf8");
    for (const r of routes) {
      expect(layout).toContain(`href="${r}"`);
    }
  });

  it("lists every legal page in the sitemap", () => {
    const sitemap = fs.readFileSync(path.join(process.cwd(), "app", "sitemap.ts"), "utf8");
    for (const r of routes) {
      expect(sitemap).toContain(`\`\${site}${r}\``);
    }
  });

  it.each(routes)("%s exports metadata with a title and a page component", async (r) => {
    const mod = await import(`@/app${r}/page`);
    expect(typeof mod.metadata?.title).toBe("string");
    expect(mod.metadata.title.length).toBeGreaterThan(2);
    expect(typeof mod.default).toBe("function");
  });

  it.each(routes)("%s shows no placeholder copy to a reviewer", (r) => {
    const src = visibleSource(path.join(process.cwd(), `app${r}`, "page.tsx"));
    // Visible text only — source comments carrying TODO(Noah) are allowed and stripped above.
    expect(src).not.toMatch(/coming soon|lorem ipsum|placeholder|\bTBD\b|\bTODO\b/i);
  });

  it("every policy page names a real, monitored contact", () => {
    for (const r of ["/legal/refunds", "/legal/delivery", "/legal/creators", "/legal/support"]) {
      const src = fs.readFileSync(path.join(process.cwd(), `app${r}`, "page.tsx"), "utf8");
      expect(src).toContain("support@creatornet.net");
    }
  });

  it("states the currency, the fee, and a cancellation route where Stripe requires them", () => {
    const refunds = fs.readFileSync(path.join(LEGAL_DIR, "refunds", "page.tsx"), "utf8");
    const delivery = fs.readFileSync(path.join(LEGAL_DIR, "delivery", "page.tsx"), "utf8");
    const creators = fs.readFileSync(path.join(LEGAL_DIR, "creators", "page.tsx"), "utf8");
    expect(refunds).toMatch(/USD/);
    expect(creators).toMatch(/12%/);
    expect(delivery).toMatch(/[Cc]ancel/);
    expect(delivery).toMatch(/stops automatically/);
  });
});
