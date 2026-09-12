import { createClient } from "@supabase/supabase-js";
import { createExactAgreementStore } from "../lib/installments/agreementStore";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

// Exercise the real Supabase JS request builder with an entirely local fetch
// double. No service key, real hostname or network access is used.
function setup() {
  const f = exactInstallmentFixture();
  const row = { id: f.agreement.id, terms: f.terms, status: "preparing",
    created_at: new Date(f.agreement.createdAt * 1000).toISOString(), stripe_customer_id: null,
    stripe_subscription_id: null, stripe_checkout_session_id: null };
  let next: unknown;
  let httpStatus = 200;
  const calls: { path: string; method: string; accept: string | null; body: Record<string, unknown> | null }[] = [];
  const localFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const accept = new Headers(init?.headers).get("accept");
    calls.push({ path, method: init?.method || "GET", accept,
      body: init?.body ? JSON.parse(String(init.body)) : null });
    const data = next === undefined
      ? accept === "application/vnd.pgrst.object+json" ? row : [row]
      : next;
    return new Response(JSON.stringify(data), { status: httpStatus, headers: { "content-type": "application/json" } });
  });
  const client = createClient("https://fixture.invalid", "synthetic-not-a-key", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: localFetch },
  });
  return { ...f, row, calls, localFetch, adapter: createExactAgreementStore(client),
    response: (data: unknown, status = 200) => { next = data; httpStatus = status; } };
}

test("create explicitly requests a single composite RPC row using the real Supabase builder", async () => {
  const f = setup();
  const result = await f.adapter.create(f.terms.creatorId, f.terms);
  expect(result.id).toBe(f.agreement.id);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ path: "/rest/v1/rpc/create_exact_installment_agreement", method: "POST",
    accept: "application/vnd.pgrst.object+json", body: { p_actor_id: f.terms.creatorId, p_terms: f.terms } });
  expect(result.createdAt).toBe(f.agreement.createdAt);
});

test("load uses the private table with an explicit singular result", async () => {
  const f = setup();
  expect((await f.adapter.load(f.agreement.id)).terms).toEqual(f.terms);
  expect(f.calls[0]).toMatchObject({ path: "/rest/v1/exact_installment_agreements", method: "GET",
    accept: "application/vnd.pgrst.object+json" });
});

test("a non-creator or invalid UUID cannot issue an RPC", async () => {
  const f = setup();
  await expect(f.adapter.create(f.terms.buyerId, f.terms)).rejects.toThrow("ownership");
  await expect(f.adapter.load("not-a-plan-id")).rejects.toThrow("identity");
  expect(f.localFetch).not.toHaveBeenCalled();
});

test("RPC errors expose no raw database context", async () => {
  const f = setup();
  f.response({ message: "synthetic-sensitive-connection-string", details: "synthetic-private-value", code: "42501" }, 403);
  await expect(f.adapter.create(f.terms.creatorId, f.terms)).rejects.toThrow(
    "Installment state operation failed: create_exact_installment_agreement");
});

test.each([null, [], {}, { status: "unexpected" }, { status: "complete" },
  { status: "complete", resultId: "https://not-an-id.invalid" }])("rejects malformed claim response %#", async (response) => {
  const f = setup(); f.response(response);
  await expect(f.adapter.claim(f.agreement.id, "customer", "a".repeat(64), f.terms.buyerId)).rejects.toThrow();
});

test.each([{ status: "new" }, { status: "busy" }, { status: "review_required" }, { status: "complete", resultId: "cus_fixture" }])
  ("accepts the defined scalar JSON claim %#", async (response) => {
    const f = setup(); f.response(response);
    expect(await f.adapter.claim(f.agreement.id, "customer", "a".repeat(64), f.terms.buyerId)).toEqual(response);
    expect(f.calls[0].accept).not.toBe("application/vnd.pgrst.object+json");
  });

test.each([null, [], { recorded: true }, "true"])("does not treat malformed receipt result %# as success", async (value) => {
  const f = setup(); f.response(value);
  await expect(f.adapter.recordFirstReceipt(f.agreement.id, { sessionId: "cs_test_fixture", paymentIntentId: "pi_fixture",
    amountCents: 66633, applicationFeeCents: 9958, paidAt: f.agreement.createdAt + 60 })).rejects.toThrow();
});

test.each([true, false])("preserves the database's %s receipt result", async (value) => {
  const f = setup(); f.response(value);
  expect(await f.adapter.recordFirstReceipt(f.agreement.id, { sessionId: "cs_test_fixture", paymentIntentId: "pi_fixture",
    amountCents: 66633, applicationFeeCents: 9958, paidAt: f.agreement.createdAt + 60 })).toBe(value);
});
