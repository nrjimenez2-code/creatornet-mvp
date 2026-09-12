import type Stripe from "stripe";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
import { validPaidCallTarget, verifyPaidCallCapture, type PaidCallAccess } from "../lib/paidCalls";

let db: MockClient;
let user: { id: string } | null;
const sessions = jest.fn();
const intents = jest.fn();
jest.mock("@/lib/supabaseAdmin", () => ({ get supabaseAdmin() { return db; } }));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => ({ checkout: { sessions: { retrieve: sessions } }, paymentIntents: { retrieve: intents } }) }));
import { GET } from "../app/api/calls/[purchaseId]/schedule/route";

const access: PaidCallAccess = { purchase_id: "11111111-1111-4111-8111-111111111111", buyer_id: "buyer", creator_id: "creator",
  product_id: "product", session_id: "cs_test_call", payment_intent_id: "pi_call", amount_cents: 10000, currency: "usd",
  scheduling_url: "https://scheduler.example/paid-call", stripe_charge_id: "ch_call", total_creator_deduction_cents: 1520 };
const paidSession = () => ({ mode: "payment", status: "complete", payment_status: "paid", subscription: null, amount_total: 10000,
  currency: "usd", payment_intent: "pi_call", metadata: { buyer_id: "buyer", creator_id: "creator", product_id: "product", product_type: "call" } });
const paidIntent = () => ({ status: "succeeded", amount_received: 10000, currency: "usd", application_fee_amount: 1520,
  latest_charge: { id: "ch_call", paid: true, captured: true, disputed: false, refunded: false, amount: 10000, amount_refunded: 0 } });
const stripe = { checkout: { sessions: { retrieve: sessions } }, paymentIntents: { retrieve: intents } } as unknown as Stripe;
const request = () => GET(new Request("https://creatornet.example/api/calls/" + access.purchase_id + "/schedule"), { params: Promise.resolve({ purchaseId: access.purchase_id }) });

beforeEach(() => {
  jest.clearAllMocks(); user = { id: "buyer" };
  process.env.CREATOR_PAID_CALLS_SCHEMA_READY = "true"; process.env.CREATOR_PAID_CALLS_READY = "true";
  db = createMockClient(op => op.table === "read_paid_call_access_v1" ? { data: access, error: null } : undefined);
  sessions.mockResolvedValue(paidSession()); intents.mockResolvedValue(paidIntent());
});
afterAll(() => { delete process.env.CREATOR_PAID_CALLS_SCHEMA_READY; delete process.env.CREATOR_PAID_CALLS_READY; });

test("confirmed owned payment releases only the private scheduling redirect", async () => {
  const response = await request();
  expect(response.status).toBe(303); expect(response.headers.get("location")).toBe(access.scheduling_url);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.text()).toBe("");
  expect(db.opsFor("read_paid_call_access_v1")).toHaveLength(2);
  expect(db.ops[0].payload).toEqual({ p_purchase_id: access.purchase_id, p_buyer_id: "buyer" });
});
test("signed-out requests reveal no destination", async () => { user = null; expect((await request()).status).toBe(401); expect(sessions).not.toHaveBeenCalled(); });
test("default-off configuration cannot expose scheduling", async () => { delete process.env.CREATOR_PAID_CALLS_READY; expect((await request()).status).toBe(503); expect(db.ops).toHaveLength(0); });
test("another buyer or a non-entitled purchase reveals no destination", async () => {
  db = createMockClient(() => ({ data: null, error: null }));
  const response = await request(); expect(response.status).toBe(403); expect(response.headers.get("location")).toBeNull(); expect(sessions).not.toHaveBeenCalled();
});
test.each([
  { mode: "setup" }, { payment_status: "unpaid" }, { status: "open" }, { subscription: "sub_wrong" },
  { amount_total: 9999 }, { currency: "eur" }, { payment_intent: "pi_wrong" },
  { metadata: { ...paidSession().metadata, buyer_id: "someone_else" } },
  { metadata: { ...paidSession().metadata, product_type: "mentorship" } },
])("rejects a mismatched or unpaid Checkout: %j", async patch => {
  sessions.mockResolvedValue({ ...paidSession(), ...patch });
  expect(await verifyPaidCallCapture(stripe, access)).toBe(false); expect(intents).not.toHaveBeenCalled();
});
test.each([
  { status: "processing" }, { amount_received: 0 }, { application_fee_amount: 1200 },
  { latest_charge: { ...paidIntent().latest_charge, refunded: true, amount_refunded: 10000 } },
  { latest_charge: { ...paidIntent().latest_charge, disputed: true } },
  { latest_charge: { ...paidIntent().latest_charge, captured: false } },
  { latest_charge: { ...paidIntent().latest_charge, id: "ch_wrong" } },
])("rejects unconfirmed capture, fee drift or refund/dispute: %j", async patch => {
  intents.mockResolvedValue({ ...paidIntent(), ...patch });
  const response = await request(); expect(response.status).toBe(403); expect(response.headers.get("location")).toBeNull();
});
test("a partial refund retains access only when the existing access policy permits it", async () => {
  intents.mockResolvedValue({ ...paidIntent(), latest_charge: { ...paidIntent().latest_charge, amount_refunded: 2500 } });
  expect((await request()).status).toBe(303);
});
test("a revocation arriving during Stripe reads prevents release", async () => {
  let count = 0; db = createMockClient(() => ({ data: ++count === 1 ? access : null, error: null }));
  expect((await request()).status).toBe(409);
});
test("provider uncertainty never becomes a successful scheduling response", async () => {
  intents.mockRejectedValue(Error("provider unavailable")); const response = await request();
  expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
});
test.each(["javascript:alert(1)", "http://scheduler.example/call", "/api/book", "//scheduler.example/call", "https://user:pass@scheduler.example/call"])("rejects unsafe private target %s", value => expect(validPaidCallTarget(value)).toBe(false));
