/**
 * getSiteUrl() is the single origin source for metadataBase, robots.txt and
 * sitemap.xml. If its fallback chain regresses, every OG/canonical/sitemap URL
 * on the two Vercel projects without NEXT_PUBLIC_SITE_URL goes wrong.
 */

const ORIGINAL_ENV = process.env;

function loadGetSiteUrl(env: Record<string, string | undefined>) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, ...env };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/siteUrl").getSiteUrl as () => string;
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("getSiteUrl", () => {
  test("uses NEXT_PUBLIC_SITE_URL when set, stripping trailing slashes", () => {
    const getSiteUrl = loadGetSiteUrl({
      NEXT_PUBLIC_SITE_URL: "https://www.creatornet.net///",
      NEXT_PUBLIC_BASE_URL: "https://wrong.example.com",
    });
    expect(getSiteUrl()).toBe("https://www.creatornet.net");
  });

  test("falls back to NEXT_PUBLIC_BASE_URL when SITE_URL is unset", () => {
    const getSiteUrl = loadGetSiteUrl({
      NEXT_PUBLIC_SITE_URL: undefined,
      NEXT_PUBLIC_BASE_URL: "https://base.example.com/",
    });
    expect(getSiteUrl()).toBe("https://base.example.com");
  });

  test("whitespace-only env values are treated as unset", () => {
    const getSiteUrl = loadGetSiteUrl({
      NEXT_PUBLIC_SITE_URL: "   ",
      NEXT_PUBLIC_BASE_URL: undefined,
    });
    expect(getSiteUrl()).toMatch(/^https?:\/\//);
  });

  test("production fallback is the primary domain, never localhost", () => {
    const getSiteUrl = loadGetSiteUrl({
      NEXT_PUBLIC_SITE_URL: undefined,
      NEXT_PUBLIC_BASE_URL: undefined,
      NODE_ENV: "production",
    });
    expect(getSiteUrl()).toBe("https://www.creatornet.net");
  });

  test("development fallback is localhost", () => {
    const getSiteUrl = loadGetSiteUrl({
      NEXT_PUBLIC_SITE_URL: undefined,
      NEXT_PUBLIC_BASE_URL: undefined,
      NODE_ENV: "development",
    });
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });
});
