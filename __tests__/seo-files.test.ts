/**
 * Source tripwires for the launch-polish surface (same style as
 * api-errors-headers.test.ts): pin the crawler/legal/SEO invariants so a later
 * edit can't quietly reopen them.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("crawler plumbing", () => {
  test("robots.ts exists and disallows every private surface", () => {
    const src = read("app/robots.ts");
    for (const path of ["/api/", "/admin", "/access/", "/library", "/profile", "/watch/", "/onboarding"]) {
      expect(src).toContain(`"${path}"`);
    }
    expect(src).toContain("sitemap");
  });

  test("sitemap.ts never lists private or transactional routes", () => {
    const src = read("app/sitemap.ts");
    for (const banned of ["/admin", "/access", "/library", "/profile", "/onboarding", "/success", "/watch"]) {
      expect(src).not.toContain(`${banned}`);
    }
  });

  test("root layout sets metadataBase and a title template", () => {
    const src = read("app/layout.tsx");
    expect(src).toContain("metadataBase");
    expect(src).toContain("template");
  });

  test("favicon, OG image, manifest and 404 page all exist", () => {
    for (const f of [
      "app/icon.svg",
      "app/apple-icon.tsx",
      "app/opengraph-image.tsx",
      "app/manifest.ts",
      "app/not-found.tsx",
      "app/error.tsx",
    ]) {
      expect(existsSync(join(ROOT, f))).toBe(true);
    }
  });
});

describe("legal pages", () => {
  const pages = [
    "app/legal/privacy/page.tsx",
    "app/legal/terms/page.tsx",
    "app/legal/cookies/page.tsx",
  ];

  test('no legal page fakes its "Last updated" date with new Date()', () => {
    for (const p of pages) {
      expect(read(p)).not.toContain("new Date(");
    }
  });

  test("every legal page exports metadata with a title", () => {
    for (const p of pages) {
      const src = read(p);
      expect(src).toContain("export const metadata");
      expect(src).toContain("title:");
    }
  });
});

describe("dev leftovers stay deleted", () => {
  test("sentry example page/api and debug whoami are gone", () => {
    for (const f of [
      "app/sentry-example-page/page.tsx",
      "app/api/sentry-example-api/route.ts",
      "app/api/debug/whoami/route.ts",
    ]) {
      expect(existsSync(join(ROOT, f))).toBe(false);
    }
  });

  test("success page ships without console debug logging", () => {
    expect(read("app/success/page.tsx")).not.toMatch(/console\.(log|error|warn)/);
  });
});
