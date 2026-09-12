import type { SupabaseClient } from "@supabase/supabase-js";
import { productPurchaseTerms, requireProductConsent } from "@/lib/purchaseConsent";
import { PURCHASE_POLICY_VERSION, purchasePoliciesActive } from "@/lib/purchasePolicies";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const buyer = "10000000-0000-4000-8000-000000000001";
const creator = "10000000-0000-4000-8000-000000000002";
const consentId = "10000000-0000-4000-8000-000000000003";
const product = { id: "10000000-0000-4000-8000-000000000004", creator_id: creator,
  type: "course", title: "Owned course", description: "One complete course", price_cents: 10000, currency: "usd" };
const env = { CREATOR_PURCHASE_CONSENT_SCHEMA_READY: "true", CREATOR_PURCHASE_POLICIES_READY: "true", CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED: "true" };
const quote = productPurchaseTerms(product, buyer, null);
const accepted = { accepted: true, version: PURCHASE_POLICY_VERSION, fingerprint: quote.fingerprint };
function harness(input: unknown = accepted, options: Partial<Parameters<typeof requireProductConsent>[0]> = {}) {
  const db = createMockClient(() => ({ data: consentId, error: null }));
  const args = { admin: db as unknown as SupabaseClient, product, buyerId: buyer, postId: null, input,
    site: "https://creatornet.example.invalid", origin: "https://creatornet.example.invalid", env, ...options };
  return { db, run: () => requireProductConsent(args) };
}
test("#6 returns an app review URL, without recording acceptance or charging", async () => {
  const h = harness(null), result = await h.run();
  expect(result.consentId).toBeNull(); expect(h.db.ops).toEqual([]);
  expect(await result.response!.json()).toEqual({ requires_consent: true,
    url: `https://creatornet.example.invalid/purchase/review?product_id=${product.id}` });
});
test("#6 records the authenticated buyer and complete immutable offered terms", async () => {
  const h = harness(); expect(await h.run()).toEqual({ consentId });
  expect(h.db.ops).toHaveLength(1);
  expect(h.db.ops[0].table).toBe("record_product_purchase_consent_v1");
  expect(h.db.ops[0].payload).toEqual({ p_buyer_id: buyer, p_creator_id: creator, p_product_id: product.id,
    p_post_id: null, p_terms: quote.terms, p_fingerprint: quote.fingerprint });
});
test.each([
  { ...accepted, accepted: false }, { ...accepted, accepted: "true" },
  { ...accepted, version: "old" }, { ...accepted, fingerprint: "0".repeat(64) },
  { ...accepted, amountCents: 50 }, [], "accepted",
])("#6 rejects missing, changed or forged consent %p", async input => {
  const h = harness(input); expect((await h.run()).response!.status).toBe(409); expect(h.db.ops).toEqual([]);
});
test.each([null, "https://attacker.example.invalid", "null"])("#6 rejects a cross-origin acceptance %p", async origin => {
  const h = harness(accepted, { origin }); expect((await h.run()).response!.status).toBe(409); expect(h.db.ops).toEqual([]);
});
test.each(Object.keys(env))("#6 requires every activation gate: %s", async key => {
  const off = { ...env, [key]: "false" }; expect(purchasePoliciesActive(off)).toBe(false);
  const h = harness(null, { env: off }); expect(await h.run()).toEqual({ consentId: null }); expect(h.db.ops).toEqual([]);
  await expect(harness(accepted, { env: off }).run()).rejects.toThrow("not active");
});
test("#6 refuses checkout if durable acceptance cannot be recorded", async () => {
  const db = createMockClient(() => ({ data: null, error: { message: "synthetic failure" } }));
  await expect(harness(accepted, { admin: db as unknown as SupabaseClient }).run()).rejects.toThrow("could not be recorded");
});
test("#6 a changed buyer, price, description or product changes the acceptance fingerprint", () => {
  expect(productPurchaseTerms(product, creator, null).fingerprint).not.toBe(quote.fingerprint);
  for (const change of [{ price_cents: 20000 }, { description: "Different service" }, { id: creator }]) {
    expect(productPurchaseTerms({ ...product, ...change }, buyer, null).fingerprint).not.toBe(quote.fingerprint);
  }
});
test("#4 monthly mentorships cannot masquerade as one-time purchases", () => {
  expect(() => productPurchaseTerms({ ...product, type: "mentorship", membership_terms: {
    version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true,
  } }, buyer, null)).toThrow("supported purchase agreement");
});
