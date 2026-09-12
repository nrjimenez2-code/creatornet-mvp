import { prepareExactCheckoutSandbox, installmentMonthBoundary } from "../lib/installments/checkoutPreparation";
import { operationHash, snapshotExactTerms } from "../lib/installments/agreementStore";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

test("durably claims each step, holds collection before Checkout, binds IDs without publishing a URL", async () => {
  const f = exactInstallmentFixture();
  const result = await prepareExactCheckoutSandbox(f.args);
  expect(result).toEqual({ sessionId: "cs_test_fixture", subscriptionId: "sub_fixture", status: "prepared_unpublished" });
  expect(f.events).toEqual(["customer", "product", "subscription", "hold", "checkout"]
    .flatMap((s) => [`claim:${s}`, `stripe:${s}`, `complete:${s}`]).concat("bind"));
  const [params, options] = f.mocks.checkout.sessions.create.mock.calls[0];
  expect(params.payment_intent_data).toMatchObject({ application_fee_amount: 9958,
    transfer_data: { destination: "acct_fixture" }, setup_future_usage: "off_session" });
  expect(options.idempotencyKey).toBe(`exact-cents-held-v1:${f.agreement.id}:checkout`);
  expect(params.subscription_data).toBeUndefined();
  expect(params.line_items?.[0].price_data?.unit_amount).toBe(66633);
  expect(f.subscription.pause_collection).toEqual({ behavior: "keep_as_draft", resumes_at: null });
  expect(f.receipts).toEqual([]);
});

test("completed operations are retrieved on bind retry, never recreated", async () => {
  const f = exactInstallmentFixture();
  f.store.bind.mockRejectedValueOnce(new Error("response lost"));
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("response lost");
  expect(await prepareExactCheckoutSandbox(f.args)).toHaveProperty("status", "prepared_unpublished");
  for (const create of [f.mocks.customers.create, f.mocks.products.create, f.mocks.subscriptions.create,
    f.mocks.subscriptions.update, f.mocks.checkout.sessions.create]) expect(create).toHaveBeenCalledTimes(1);
  expect(f.mocks.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
});

test("uncertain persistence leaves the claim busy; a later retry reuses the same request/key", async () => {
  const f = exactInstallmentFixture();
  f.store.complete.mockRejectedValueOnce(new Error("database response lost"));
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("database response lost");
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("busy");
  expect(f.mocks.customers.create).toHaveBeenCalledTimes(1);
  f.releaseLeases(); // SQL lease duration/fencing is covered by the real database tests.
  await prepareExactCheckoutSandbox(f.args);
  expect(f.mocks.customers.create.mock.calls[1]).toEqual(f.mocks.customers.create.mock.calls[0]);
});

test("ambiguous aged claim stops before Stripe", async () => {
  const f = exactInstallmentFixture();
  f.store.claim.mockResolvedValueOnce({ status: "review_required" });
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("review_required");
  expect(f.mocks.customers.create).not.toHaveBeenCalled();
});

test.each([
  { CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE: "false" }, { VERCEL_ENV: "production" },
  { STRIPE_SECRET_KEY: "sk_live_synthetic_not_a_key" }, { NEXT_PUBLIC_SUPABASE_URL: "https://production.invalid" },
  { SUPABASE_URL: "https://other.invalid" }, { NEXT_PUBLIC_SITE_URL: "https://www.creatornet.net" },
])("unsafe or disabled environment %# cannot create a Stripe object", async (change) => {
  const f = exactInstallmentFixture();
  await expect(prepareExactCheckoutSandbox({ ...f.args, env: { ...f.env, ...change } })).rejects.toThrow("isolated Sandbox");
  expect(f.store.claim).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

test("expired bootstrap and already bound agreement are not restarted", async () => {
  const f = exactInstallmentFixture();
  await expect(prepareExactCheckoutSandbox({ ...f.args, now: () => f.agreement.createdAt + 86400 })).rejects.toThrow("expired");
  f.setAgreement({ status: "awaiting_first" });
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("not a new preparation");
  expect(f.mocks.customers.create).not.toHaveBeenCalled();
});

test("changed immutable terms during preparation stop before the first Stripe mutation", async () => {
  const f = exactInstallmentFixture();
  f.store.load.mockResolvedValueOnce(f.agreement);
  f.setAgreement({ terms: { ...f.terms, title: "Changed" } });
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("state changed");
  expect(f.mocks.customers.create).not.toHaveBeenCalled();
});

test("missing hold blocks creation of a payable Checkout", async () => {
  const f = exactInstallmentFixture();
  f.mocks.subscriptions.update.mockResolvedValueOnce(f.subscription);
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("hold missing");
  expect(f.mocks.checkout.sessions.create).not.toHaveBeenCalled();
  expect(f.store.bind).not.toHaveBeenCalled();
});

test("a card added to the customer between operations is caught by the fresh pre-Checkout read", async () => {
  const f = exactInstallmentFixture();
  f.mocks.customers.retrieve.mockImplementationOnce(async () => ({ ...f.customer, default_source: "card_other" }));
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("no-card");
  expect(f.mocks.checkout.sessions.create).not.toHaveBeenCalled();
});

test.each(["live", "wrong customer", "noncard", "wrong amount", "automatic tax"])("rejects %s subscription", async (change) => {
  const f = exactInstallmentFixture();
  if (change === "live") f.subscription.livemode = true;
  if (change === "wrong customer") f.subscription.customer = "cus_other";
  if (change === "noncard") f.subscription.payment_settings!.payment_method_types = ["us_bank_account"];
  if (change === "wrong amount") f.subscription.items.data[0].price.unit_amount = 66634;
  if (change === "automatic tax") f.subscription.automatic_tax.enabled = true;
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("subscription bootstrap mismatch");
  expect(f.mocks.checkout.sessions.create).not.toHaveBeenCalled();
});

test("wrong Checkout amount does not bind a link", async () => {
  const f = exactInstallmentFixture();
  f.session.amount_total = 199900;
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("checkout identity/amount");
  expect(f.store.bind).not.toHaveBeenCalled();
});

test("removing the hold after Checkout creation prevents publication/binding", async () => {
  const f = exactInstallmentFixture();
  f.mocks.subscriptions.retrieve.mockResolvedValueOnce(f.subscription).mockImplementationOnce(async () =>
    ({ ...f.subscription, pause_collection: null }));
  await expect(prepareExactCheckoutSandbox(f.args)).rejects.toThrow("hold missing");
  expect(f.mocks.checkout.sessions.create).toHaveBeenCalledTimes(1);
  expect(f.store.bind).not.toHaveBeenCalled();
});

test.each([
  ["2027-01-31T12:34:56Z", 1, "2027-02-28T12:34:56.000Z"],
  ["2027-01-31T12:34:56Z", 2, "2027-03-31T12:34:56.000Z"],
  ["2028-01-31T12:34:56Z", 1, "2028-02-29T12:34:56.000Z"],
  ["2028-02-29T12:34:56Z", 12, "2029-02-28T12:34:56.000Z"],
] as const)("month boundaries preserve the original calendar anchor %s + %i", (date, months, expected) => {
  expect(new Date(installmentMonthBoundary(Date.parse(date) / 1000, months) * 1000).toISOString()).toBe(expected);
});

test("snapshot owns its fee objects and hashes are independent of object property ordering", () => {
  const f = exactInstallmentFixture();
  const input = { ...f.terms, firstPaymentFeeSchedule: { ...f.terms.firstPaymentFeeSchedule } };
  const saved = snapshotExactTerms(input);
  input.firstPaymentFeeSchedule.fixedCents = 999;
  expect(saved.firstPaymentFeeSchedule.fixedCents).toBe(30);
  expect(Object.isFrozen(saved.firstPaymentFeeSchedule)).toBe(true);
  expect(operationHash({ a: 1, b: { c: 2, d: 3 } })).toBe(operationHash({ b: { d: 3, c: 2 }, a: 1 }));
  expect(operationHash({ a: [1, 2] })).not.toBe(operationHash({ a: [2, 1] }));
});
