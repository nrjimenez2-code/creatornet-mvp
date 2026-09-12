/**
 * Platform-fee tripwire.
 *
 * The fee used to be defined three times (checkout, webhook, payment-link) and
 * applied inline eight times, in two different units:
 *   - as a RATE (0.12), multiplied by an amount to get a fee in cents
 *   - as a PERCENT (12), handed to Stripe's application_fee_percent
 *
 * Mixing those up silently changes revenue by 100x. The fee now lives in
 * lib/money.ts and every route imports it. This test fails if anyone puts a
 * local copy back, or calls Stripe's percent field with the rate form.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  PLATFORM_FEE_RATE,
  PLATFORM_FEE_PERCENT,
  PLATFORM_FEE_PERCENT_STR,
  calculateCreatorFees,
  splitFee,
} from "@/lib/money";

const REPO_ROOT = join(__dirname, "..");

const CHECKOUT = "app/api/checkout/route.ts";
const WEBHOOK = "app/api/stripe/webhook/route.ts";
const PAYMENT_LINK = "app/api/bookings/[bookingId]/payment-link/route.ts";
const MONEY = "lib/money.ts";

const read = (relativePath: string) =>
  readFileSync(join(REPO_ROOT, relativePath), "utf8");

describe("the fee is defined exactly once", () => {
  test("lib/money.ts holds the 0.12 rate", () => {
    expect(read(MONEY)).toMatch(/export const PLATFORM_FEE_RATE = 0\.12;/);
    expect(PLATFORM_FEE_RATE).toBe(0.12);
    expect(PLATFORM_FEE_PERCENT).toBe(12);
    expect(PLATFORM_FEE_PERCENT_STR).toBe("12");
  });

  test.each([CHECKOUT, WEBHOOK, PAYMENT_LINK])(
    "%s has no local PLATFORM_FEE_RATE and no inline fee arithmetic",
    (file) => {
      const src = read(file);
      expect(src).not.toMatch(/const PLATFORM_FEE_RATE/);
      expect(src).not.toMatch(/\*\s*0\.12\b/);
      expect(src).not.toMatch(/Math\.round\([^)]*PLATFORM_FEE/);
      expect(src).toMatch(/from "@\/lib\/money"/);
    },
  );
});

describe("Stripe percent fields get the percent form", () => {
  test("subscription application_fee_percent uses the exact combined whole-percent calculation", () => {
    expect(read(PAYMENT_LINK)).toMatch(
      /application_fee_percent:\s*subscriptionApplicationFeePercent\b/,
    );
    expect(read(PAYMENT_LINK)).toContain("exactSubscriptionApplicationFeePercent(fees)");
    expect(read(PAYMENT_LINK)).not.toMatch(/application_fee_percent:\s*PLATFORM_FEE_RATE/);
  });

  test("checkout metadata platform_fee_percent is the string \"12\"", () => {
    expect(read(CHECKOUT)).toMatch(/platform_fee_percent:\s*PLATFORM_FEE_PERCENT_STR/);
  });
});

describe("centralized call sites", () => {
  test.each([CHECKOUT, PAYMENT_LINK])(
    "%s creates new payment splits through calculateCreatorFees()",
    (file) => {
      expect(read(file)).toMatch(/calculateCreatorFees\(/);
    },
  );

  test("the webhook restores the immutable split from Stripe metadata", () => {
    expect(read(WEBHOOK)).toMatch(/creatorFeesFromMetadata\(/);
  });

  test("new-payment routes do not use the legacy splitFee() helper", () => {
    for (const file of [CHECKOUT, PAYMENT_LINK]) {
      expect(read(file)).not.toMatch(/splitFee\(/);
    }
  });
});

describe("the arithmetic", () => {
  test("a $100.00 charge yields a 1200 cent fee and 8800 to the creator", () => {
    expect(splitFee(10_000)).toEqual({ grossCents: 10_000, feeCents: 1200, creatorCents: 8800 });
  });

  test("the disabled creator-processing rollout preserves that legacy split", () => {
    expect(
      calculateCreatorFees(10_000, {
        enabled: false,
        basisPoints: 0,
        fixedCents: 0,
        version: "platform-only-v1",
      }),
    ).toMatchObject({
      platformFeeCents: 1200,
      processingFeeCents: 0,
      creatorNetCents: 8800,
    });
  });

  test("fee + creator always equals gross", () => {
    for (const amt of [50, 99, 101, 333, 652_300, 5_616_500, 1, 7]) {
      const s = splitFee(amt);
      expect(s.feeCents + s.creatorCents).toBe(amt);
      expect(s.feeCents).toBe(Math.round(amt * 0.12));
    }
  });

  test("matches the amounts already written to the orders table", () => {
    // Real rows from production: gross -> (platform_fee, creator_amount)
    expect(splitFee(652_300)).toMatchObject({ feeCents: 78_276, creatorCents: 574_024 });
    expect(splitFee(50_000)).toMatchObject({ feeCents: 6_000, creatorCents: 44_000 });
    expect(splitFee(5_616_500)).toMatchObject({ feeCents: 673_980, creatorCents: 4_942_520 });
  });

  test("garbage in, zero out", () => {
    expect(splitFee(NaN)).toEqual({ grossCents: 0, feeCents: 0, creatorCents: 0 });
    expect(splitFee(-500)).toEqual({ grossCents: 0, feeCents: 0, creatorCents: 0 });
    expect(splitFee(Infinity)).toEqual({ grossCents: 0, feeCents: 0, creatorCents: 0 });
  });

  test("the percent form is 12, and 0.12 would be a 100x undercharge", () => {
    expect(PLATFORM_FEE_PERCENT).toBe(12);
    expect(PLATFORM_FEE_PERCENT).not.toBe(0.12);
  });
});
