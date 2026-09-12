import { canCollectExactWebhookInvoice, EXACT_WEBHOOK_COLLECTION_GATES } from "../lib/installments/webhookCollection";
import { exactRenewalFixture } from "../test-support/exact-renewal-fixture";

function fixture() {
  const f = exactRenewalFixture();
  const env: Record<string, string | undefined> = { ...f.env,
    ...Object.fromEntries(EXACT_WEBHOOK_COLLECTION_GATES.map(key => [key, "true"])),
    CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS: f.a.planId };
  return { f, env, args: { env, eventType: "invoice.created", agreementId: f.a.planId,
    previewOrigin: f.f.terms.previewOrigin } };
}

test("only an explicitly allowlisted staging plan receives monthly debit permission", () => {
  const { args, env } = fixture(); const before = { ...env };
  expect(canCollectExactWebhookInvoice(args)).toBe(true);
  expect(env).toEqual(before);
  expect(canCollectExactWebhookInvoice({ ...args, agreementId: "88888888-8888-4888-8888-888888888888" })).toBe(false);
});

test.each(EXACT_WEBHOOK_COLLECTION_GATES)("missing %s prevents collection", key => {
  const { args, env } = fixture(); delete env[key];
  expect(canCollectExactWebhookInvoice(args)).toBe(false);
  env[key] = "TRUE"; expect(canCollectExactWebhookInvoice(args)).toBe(false);
});

test.each([undefined, "", "  "])("empty allowlist %p grants nothing", value => {
  const { args, env } = fixture(); env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS = value;
  expect(canCollectExactWebhookInvoice(args)).toBe(false);
});

test.each(["*", "all", "cus_fixture", "77777777-7777-4777-8777-777777777777,", "x".repeat(501),
  "77777777-7777-4777-8777-777777777777,77777777-7777-4777-8777-777777777777"])
("invalid allowlist is rejected without echoing it: %p", value => {
  const { args, env } = fixture(); env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS = value;
  expect(() => canCollectExactWebhookInvoice(args)).toThrow("Invalid staging collection allowlist");
});

test("at most ten distinct UUIDs; whitespace never means a wildcard", () => {
  const { args, env } = fixture();
  const ids = Array.from({ length: 10 }, (_, i) => `${String(i).padStart(8, "0")}-7777-4777-8777-777777777777`);
  env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS = ids.join(", ");
  expect(canCollectExactWebhookInvoice({ ...args, agreementId: ids[9] })).toBe(true);
  env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS += `,${args.agreementId}`;
  expect(() => canCollectExactWebhookInvoice(args)).toThrow("allowlist");
});

test.each(["invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "checkout.session.completed", "invoice.finalized"])
("%s cannot collect and ignores malformed new configuration", eventType => {
  const { args, env } = fixture(); env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS = "*";
  expect(canCollectExactWebhookInvoice({ ...args, eventType })).toBe(false);
});

test.each([
  ["VERCEL_ENV", "production"], ["STRIPE_SECRET_KEY", "sk_live_synthetic"],
  ["NEXT_PUBLIC_SUPABASE_URL", "https://another.supabase.co"], ["SUPABASE_URL", "https://another.supabase.co"],
  ["NEXT_PUBLIC_SITE_URL", "https://www.creatornet.net"],
])("unsafe %s fails before permission is returned", (key, value) => {
  const { args, env } = fixture(); env[key] = value;
  expect(() => canCollectExactWebhookInvoice(args)).toThrow();
});

test("a different persisted Preview origin cannot inherit permission", () => {
  const { args } = fixture();
  expect(() => canCollectExactWebhookInvoice({ ...args, previewOrigin: "https://another.vercel.app" })).toThrow();
});
