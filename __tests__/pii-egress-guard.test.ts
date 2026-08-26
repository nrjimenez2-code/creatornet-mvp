/**
 * Tripwire against user PII leaking into analytics / error tracking.
 *
 * This was a REAL bug once: an earlier build called
 * `posthog.identify(id, { email, name })` and ran Sentry with
 * `sendDefaultPii: true`, shipping user emails to third-party analytics. PR #75
 * removed both. Nothing structurally prevents a future edit from silently
 * reintroducing it — a stray identify trait or a flipped Sentry flag would leak
 * PII again, type-check fine, and pass every other test. This guard fails loudly
 * if that happens.
 *
 * The assertions read the source files as text on purpose. Importing them would
 * construct the PostHog / Sentry clients at module scope, which needs real
 * config. Reading the source keeps the guard dependency-free.
 *
 * If one of these fails, do NOT "fix" the test — someone is about to send user
 * PII to a third party. Remove the trait / restore the flag instead.
 */

import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");

const read = (relativePath: string) =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

const USE_USER = "lib/useUser.tsx";
const SENTRY_CONFIGS = [
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "instrumentation-client.ts",
];

/** Every `posthog.identify( ... )` call, with the argument list captured. */
function identifyCalls(source: string): string[] {
  return [...source.matchAll(/posthog\.identify\(([^)]*)\)/g)].map((m) => m[1]);
}

describe("PII egress guard — analytics", () => {
  const useUser = read(USE_USER);

  it("useUser calls posthog.identify at least once (guard is wired to a real call)", () => {
    expect(identifyCalls(useUser).length).toBeGreaterThan(0);
  });

  it("posthog.identify is only ever passed a single id argument — never a traits object", () => {
    for (const args of identifyCalls(useUser)) {
      // A second argument (the traits object) is where email/name would ride along.
      expect(args.includes(",")).toBe(false);
      // Belt and suspenders: no PII field names in the call at all.
      expect(/email|name|phone|first_name|last_name/i.test(args)).toBe(false);
    }
  });

  it("no posthog.identify anywhere in useUser carries an email/name trait", () => {
    expect(/posthog\.identify\([^)]*\bemail\b/i.test(useUser)).toBe(false);
    expect(/posthog\.identify\([^)]*\bname\b/i.test(useUser)).toBe(false);
  });
});

describe("PII egress guard — Sentry", () => {
  for (const config of SENTRY_CONFIGS) {
    it(`${config} keeps sendDefaultPii: false`, () => {
      const source = read(config);
      expect(/sendDefaultPii:\s*false/.test(source)).toBe(true);
      // and never flips it on
      expect(/sendDefaultPii:\s*true/.test(source)).toBe(false);
    });

    it(`${config} keeps enableLogs: false (console output is not PII-scrubbed)`, () => {
      const source = read(config);
      expect(/enableLogs:\s*false/.test(source)).toBe(true);
      expect(/enableLogs:\s*true/.test(source)).toBe(false);
    });
  }
});
