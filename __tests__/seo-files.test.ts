/**
 * Source tripwires for the launch-polish surface (same style as
 * api-errors-headers.test.ts): pin the crawler/legal/SEO invariants so a later
 * edit can't quietly reopen them.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadReleaseSettings } from "@/lib/release/server";
import { closedFeatures, SETTINGS_ID, type ReleaseSettings } from "@/lib/release/policy";

jest.mock("@/lib/release/server", () => ({ loadReleaseSettings: jest.fn() }));
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: jest.fn() } }));
const settings = (hidden: boolean): ReleaseSettings => ({ id: SETTINGS_ID, owner_id: "owner", hidden, features: { ...closedFeatures(), feed: true, profiles: true, search: true }, public_page: "coming-soon", discord_invite: null, revision: 0, updated_at: "now" });

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("crawler plumbing", () => {
  test("Coming Soon retains the existing limited crawl policy", async () => {
    const state = settings(true);
    jest.mocked(loadReleaseSettings).mockResolvedValue(state);
    const result = await robots();
    expect(result.rules).toEqual([{ userAgent: "*", disallow: "/", allow: ["/$", "/legal/"] }]);
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
  });

  test.each([null, { ...settings(true), public_page: "blank" as const }])("blank or unavailable settings expose no sitemap links and let crawlers see noindex", async state => {
    jest.mocked(loadReleaseSettings).mockResolvedValue(state);
    jest.mocked(supabaseAdmin.from).mockClear();
    expect((await robots()).rules).toEqual([{ userAgent: "*", allow: "/" }]);
    expect(await sitemap()).toEqual([]);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  test("released discovery surfaces are exact exceptions to the private path deny", async () => {
    jest.mocked(loadReleaseSettings).mockResolvedValue(settings(false));
    const result = await robots();
    expect(result.rules).toEqual([{ userAgent: "*", disallow: "/", allow: ["/$", "/legal/", "/dashboard$", "/creators/", "/search$", "/tag/"] }]);
    jest.mocked(loadReleaseSettings).mockResolvedValue({ ...settings(false), features: closedFeatures() });
    expect((await robots()).rules).toEqual([{ userAgent: "*", disallow: "/", allow: ["/$", "/legal/"] }]);
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

  test("browser icons, OG image, manifest and 404 page all exist", () => {
    for (const f of [
      "public/favicon.ico",
      "public/apple-touch-icon.png",
      "public/creatornet-icon-192.png",
      "public/creatornet-icon-512.png",
      "app/opengraph-image.tsx",
      "app/manifest.ts",
      "app/not-found.tsx",
      "app/error.tsx",
    ]) {
      expect(existsSync(join(ROOT, f))).toBe(true);
    }
    const layout = read("app/layout.tsx");
    expect(layout).toContain('url: "/favicon.ico"');
    expect(layout).toContain('url: "/apple-touch-icon.png"');
    expect(layout).toContain('url: "/creatornet-icon-192.png"');
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
