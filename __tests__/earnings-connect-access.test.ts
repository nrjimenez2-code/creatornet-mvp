import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(__dirname, "..", file), "utf8");
const earningsPage = read("app/dashboard/earnings/page.tsx");
const profileMenu = read("components/ProfileMobileHeader.tsx");
const connectBanner = read("components/StripeConnectBanner.tsx");

describe("creator Stripe setup access", () => {
  test("reuses the existing setup control on the authenticated earnings page", () => {
    expect(earningsPage).toContain('import StripeConnectBanner from "@/components/StripeConnectBanner"');
    expect(earningsPage.match(/<StripeConnectBanner\s*\/>/g)).toHaveLength(1);
    expect(earningsPage).toContain('if (!view) redirect("/auth")');
    expect(earningsPage).not.toContain("/api/stripe/connect/onboard");
  });

  test("makes setup reachable from the mobile profile menu without a breakpoint gate", () => {
    expect(profileMenu).toContain('href="/dashboard/earnings"');
    expect(earningsPage).toMatch(
      /<section className="mt-6" aria-label="Stripe account setup">\s*<StripeConnectBanner\s*\/>\s*<\/section>/,
    );
    const layoutClasses = [...earningsPage.matchAll(/className="([^"]*)"/g)]
      .flatMap((match) => match[1].split(/\s+/));
    expect(layoutClasses.some((token) => /^(?:(?:sm|md|lg|xl):)?hidden$/.test(token))).toBe(false);
  });

  test("keeps status checks and account creation behind the existing explicit action", () => {
    expect(connectBanner).toContain('fetch("/api/stripe/connect/status"');
    expect(connectBanner).toContain('fetch("/api/stripe/connect/onboard"');
    expect(connectBanner).toContain("onClick={connect}");
    expect(connectBanner).toContain("if (s.connected && s.onboarding_complete)");
    expect(connectBanner).toContain("if (s.connected && !s.onboarding_complete)");
  });
});
