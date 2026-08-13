/**
 * Tripwire for the 12% platform fee.
 *
 * The fee constant is used in TWO DIFFERENT UNITS:
 *
 *   - as a RATE (0.12), multiplied by an amount to get a fee in cents
 *   - as a PERCENT (12), which Stripe wants for `application_fee_percent`
 *     and which is produced by multiplying the rate by 100
 *
 * Dropping a `* 100` while consolidating the duplicated constant would set the
 * subscription fee to 0.12% instead of 12%. That is a 100x revenue loss, it
 * type-checks, and it passes every other test in this repo. The same mistake in
 * reverse (adding `* 100` to a cents site) would overcharge by 100x.
 *
 * These assertions read the route files as text on purpose. Importing them
 * would construct the Stripe and Supabase clients at module scope, which needs
 * real credentials. Reading the source keeps the guard dependency-free.
 *
 * If one of these fails, do not "fix" the test. Re-read which unit that call
 * site needs and confirm the arithmetic first.
 */

import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");

const CHECKOUT = "app/api/checkout/route.ts";
const WEBHOOK = "app/api/stripe/webhook/route.ts";
const PAYMENT_LINK = "app/api/bookings/[bookingId]/payment-link/route.ts";

const read = (relativePath: string) =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

/** Occurrences of `Math.round(<anything> * PLATFORM_FEE_RATE)` — the cents form. */
const centsSites = (source: string) =>
  source.match(/Math\.round\(\s*[A-Za-z_$][\w$]*\s*\*\s*PLATFORM_FEE_RATE\s*\)/g) ?? [];

/** Occurrences of `PLATFORM_FEE_RATE * 100` — the percent form. */
const percentSites = (source: string) =>
  source.match(/PLATFORM_FEE_RATE\s*\*\s*100/g) ?? [];

describe("platform fee constant", () => {
  test("all three copies of PLATFORM_FEE_RATE are 0.12", () => {
    for (const file of [CHECKOUT, WEBHOOK, PAYMENT_LINK]) {
      expect(read(file)).toMatch(/const PLATFORM_FEE_RATE = 0\.12;/);
    }
  });
});

describe("percent call sites keep their * 100", () => {
  test("subscription application_fee_percent is 12, not 0.12", () => {
    expect(read(PAYMENT_LINK)).toMatch(
      /application_fee_percent:\s*PLATFORM_FEE_RATE\s*\*\s*100/,
    );
  });

  test("checkout's platform_fee_percent metadata string is 12, not 0.12", () => {
    expect(read(CHECKOUT)).toMatch(
      /PLATFORM_FEE_PERCENT_STR\s*=\s*String\(\s*Math\.round\(\s*PLATFORM_FEE_RATE\s*\*\s*100\s*\)\s*\)/,
    );
  });
});

describe("cents call sites do NOT multiply by 100", () => {
  test.each([
    ["checkout", CHECKOUT, 2],
    ["stripe webhook", WEBHOOK, 3],
    ["booking payment link", PAYMENT_LINK, 1],
  ])("%s has %i cents-form call site(s)", (_label, file, expected) => {
    expect(centsSites(read(file))).toHaveLength(expected as number);
  });

  test("no cents-form site is followed by a stray * 100", () => {
    for (const file of [CHECKOUT, WEBHOOK, PAYMENT_LINK]) {
      expect(read(file)).not.toMatch(
        /Math\.round\(\s*[A-Za-z_$][\w$]*\s*\*\s*PLATFORM_FEE_RATE\s*\)\s*\*\s*100/,
      );
    }
  });
});

describe("call-site census", () => {
  /**
   * Deliberately exact. A new fee call site should fail this and force whoever
   * added it to state which unit it uses. Update the number only after checking.
   */
  test("there are exactly 6 cents-form and 2 percent-form call sites", () => {
    const sources = [CHECKOUT, WEBHOOK, PAYMENT_LINK].map(read);
    const cents = sources.reduce((n, s) => n + centsSites(s).length, 0);
    const percent = sources.reduce((n, s) => n + percentSites(s).length, 0);

    expect({ cents, percent }).toEqual({ cents: 6, percent: 2 });
  });
});

describe("the arithmetic both units have to satisfy", () => {
  const RATE = 0.12;

  test("a $100.00 charge yields a 1200 cent fee", () => {
    expect(Math.round(10_000 * RATE)).toBe(1200);
  });

  test("the percent form is 12, and 0.12 would be a 100x undercharge", () => {
    expect(RATE * 100).toBe(12);
    expect(RATE).not.toBe(12);
  });
});
