/**
 * Contracts between the money-path routes and the LIVE production schema.
 *
 * Every rule below was verified by querying production on 2026-09-11. Each one
 * failed silently for months because the jest mock database accepts anything the
 * code sends: a write to a column that does not exist, or an enum label that
 * does not exist, passes here and raises an error in production. These tests
 * pin the source against reality so that cannot recur.
 */
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const WEBHOOK = read("app/api/stripe/webhook/route.ts");
const BY_SESSION = read("app/api/purchases/by-session/route.ts");
const CHECKOUT = read("app/api/checkout/route.ts");

/** Live labels of booking_payment_status. There is no 'expired'. */
const BOOKING_PAYMENT_STATUS_LABELS = [
  "pending",
  "link_sent",
  "completed",
  "canceled",
  "refunded",
];

describe("booking_payments status values exist in the live enum", () => {
  test("the webhook never writes a booking_payments status the enum lacks", () => {
    // Any `status: "..."` inside a booking_payments update block.
    const blocks = WEBHOOK.split('.from("booking_payments")').slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const head = block.slice(0, 400);
      for (const [, value] of head.matchAll(/status:\s*"([a-z_]+)"/g)) {
        expect(BOOKING_PAYMENT_STATUS_LABELS).toContain(value);
      }
    }
  });

  test("'expired' appears nowhere as a booking_payments status write", () => {
    expect(WEBHOOK).not.toMatch(/status:\s*"expired"/);
  });
});

describe("product lookups match either id column", () => {
  // checkout writes products.id into metadata.product_id, but products.product_id
  // is a different column that is NULL on most rows. Filtering only the latter
  // silently found nothing, so fulfillment links were never attached.
  test("the webhook's product lookup does not filter products.product_id alone", () => {
    const helper = WEBHOOK.slice(
      WEBHOOK.indexOf("async function getProductLinks"),
      WEBHOOK.indexOf("async function attachFulfillmentIfEmpty")
    );
    expect(helper).toContain("eitherIdFilter");
    expect(helper).not.toMatch(/\.eq\(\s*"product_id"/);
  });

  test("by-session's product lookup does not filter products.product_id alone", () => {
    const block = BY_SESSION.slice(BY_SESSION.indexOf('.from("products")'));
    expect(block.slice(0, 500)).toContain("eitherIdFilter");
    expect(block.slice(0, 500)).not.toMatch(/\.eq\(\s*"product_id"/);
  });

  test("both guard with isSafeId, because eitherIdFilter throws on a bad id", () => {
    // Regression guard: the old .eq() merely matched nothing on a null id.
    // Swapping in eitherIdFilter without a guard would turn that into a throw.
    expect(WEBHOOK).toContain("isSafeId");
    expect(BY_SESSION).toContain("isSafeId");
  });
});

describe("account.updated cannot report success for a write that changed nothing", () => {
  // This is the only automatic path that sets stripe_onboarding_complete, which
  // is the gate every purchase depends on. A zero-row UPDATE used to log
  // success, so a Connect account that matched no profile looked identical to a
  // working one.
  const block = WEBHOOK.slice(
    WEBHOOK.indexOf('case "account.updated"'),
    WEBHOOK.indexOf('case "account.updated"') + 1800
  );

  test("the profiles update asks for the affected rows back", () => {
    expect(block).toMatch(/\.select\(\s*"id"\s*\)/);
  });

  test("a zero-row result is reported as an error, not as success", () => {
    expect(block).toMatch(/length === 0|!acctRows/);
    expect(block).toContain("console.error");
  });
});

describe("checkout fails closed before Stripe is called", () => {
  test("a product with no post is refused (purchases.post_id is NOT NULL)", () => {
    expect(CHECKOUT).toContain("NO_POST_FOR_PRODUCT");
  });

  test("a post price that disagrees with the charged product price is refused", () => {
    expect(CHECKOUT).toContain("PRICE_MISMATCH");
  });

  test("the mismatch check compares, and never substitutes, the amount charged", () => {
    const block = CHECKOUT.slice(
      CHECKOUT.indexOf("PRICE_MISMATCH") - 1600,
      CHECKOUT.indexOf("PRICE_MISMATCH")
    );
    // It must not assign to amount_cents — that would charge a different number
    // rather than refusing.
    expect(block).not.toMatch(/amount_cents\s*=[^=]/);
  });
});
