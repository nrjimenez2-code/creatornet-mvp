import { buildMembershipAgreement, membershipMonthBoundary } from "@/lib/membershipAgreement";
import { installmentMonthBoundary } from "@/lib/installments/checkoutPreparation";
const offer = { id: "13000000-0000-4000-8000-000000000001", creator_id: "13000000-0000-4000-8000-000000000002",
  type: "mentorship", title: "Ongoing support", description: "Day-to-day mentor support", price_cents: 10000, amount_cents: 10000,
  currency: "usd", membership_terms: { version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true } };
const args = { offer, buyerId: "13000000-0000-4000-8000-000000000003", postId: "13000000-0000-4000-8000-000000000004",
  destinationId: "acct_creator",
  context: { stripeAccountId: "acct_fixture", mode: "test" as const, apiVersion: "2025-10-29.clover",
    siteOrigin: "https://membership.example.invalid", supabaseProjectRef: "nwqfofezfzljhxolkycz" },
  env: { CREATOR_PROCESSING_FEE_ENABLED: "true", STRIPE_PROCESSING_FEE_BPS: "290", STRIPE_PROCESSING_FEE_FIXED_CENTS: "30",
    STRIPE_BILLING_FEE_BPS: "70", STRIPE_PROCESSING_FEE_SCHEDULE_VERSION: "synthetic-fixed-schedule" } };
test("steps 1/4: snapshots a monthly service commitment, not a full-price installment purchase", () => {
  const result = buildMembershipAgreement(args);
  expect(result.agreement).toMatchObject({ kind: "monthly_mentorship", monthlyPriceCents: 10000, minimumMonths: 3,
    minimumTotalCents: 30000, autoRenew: true, buyerId: args.buyerId, postId: args.postId });
  expect(result.agreement.firstMonthFees).toMatchObject({ platformFeeCents: 1200, processingFeeCents: 320 });
  expect(result.agreement.recurringMonthFees).toMatchObject({ platformFeeCents: 1200, processingFeeCents: 390 });
  expect(result.agreement.policy.version).toBe(result.agreement.policyVersion);
  expect(buildMembershipAgreement(args).fingerprint).toBe(result.fingerprint);
});
test.each(["price", "description", "minimum", "renewal", "context", "destination"])("step 4: changing %s changes the exact acceptance fingerprint", field => {
  const changed = { ...args, offer: { ...offer, membership_terms: { ...offer.membership_terms } }, context: { ...args.context } };
  if (field === "price") changed.offer.price_cents = changed.offer.amount_cents = 12000;
  if (field === "description") changed.offer.description = "Different promised service";
  if (field === "minimum") changed.offer.membership_terms.minimumMonths = 2;
  if (field === "renewal") changed.offer.membership_terms.autoRenew = false;
  if (field === "context") changed.context.stripeAccountId = "acct_different";
  if (field === "destination") changed.destinationId = "acct_differentcreator";
  expect(buildMembershipAgreement(changed).fingerprint).not.toBe(buildMembershipAgreement(args).fingerprint);
});
test("step 1: a first paid month with no additional minimum and a nonrenewing term are supported", () => {
  const result = buildMembershipAgreement({ ...args, offer: { ...offer,
    membership_terms: { version: "monthly-mentorship-v1", minimumMonths: 1, autoRenew: false } } });
  expect(result.agreement.minimumTotalCents).toBe(10000); expect(result.agreement.billing).toContain("no automatic renewal");
});
test.each([{ type: "course" }, { amount_cents: 50 }, { currency: "eur" }, { title: " " }, { membership_terms: null }])(
  "step 1: refuses an inconsistent monthly offer %p", changes => {
    expect(() => buildMembershipAgreement({ ...args, offer: { ...offer, ...changes } })).toThrow();
  });
test("step 2: does not create a minimum that cannot fit the supported single payoff amount", () => {
  expect(() => buildMembershipAgreement({ ...args, offer: { ...offer, price_cents: 99999999, amount_cents: 99999999 } })).toThrow("single-payment");
});
test("step 1: a creator cannot purchase their own membership", () => {
  expect(() => buildMembershipAgreement({ ...args, buyerId: offer.creator_id })).toThrow("owned monthly");
});
test("step 1: original-day month anchoring agrees with the existing helper for the first 24 months", () => {
  const start = Date.UTC(2026, 0, 31, 12, 45) / 1000;
  for (let month = 0; month <= 24; month++) expect(membershipMonthBoundary(start, month)).toBe(installmentMonthBoundary(start, month));
  expect(new Date(membershipMonthBoundary(start, 25) * 1000).toISOString()).toBe("2028-02-29T12:45:00.000Z");
  expect(new Date(membershipMonthBoundary(start, 26) * 1000).toISOString()).toBe("2028-03-31T12:45:00.000Z");
});
test.each([[0, 1], [100, -1], [100, 1.5], [Number.MAX_SAFE_INTEGER, 2]])("step 1: invalid calendar inputs %p/%p fail", (anchor, months) => {
  expect(() => membershipMonthBoundary(anchor, months)).toThrow();
});
