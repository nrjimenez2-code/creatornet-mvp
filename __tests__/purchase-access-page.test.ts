import { renderToStaticMarkup } from "react-dom/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

let mockUser: { id: string } | null;
let mockPurchase: Record<string, unknown> | null;
let mockDispute: Record<string, unknown> | null;
let mockDisputeError: unknown;
let mockEntitlement: { allowed: boolean; maxAgeSeconds: number; applicable?: boolean };
const privateUrl = "https://private.example.invalid/owned-access";
const mockDb = createMockClient(op => {
  if (op.table === "purchases") return { data: mockPurchase, error: null };
  if (op.table === "payment_dispute_state") return { data: mockDispute, error: mockDisputeError };
  if (op.kind === "rpc") return { data: mockEntitlement, error: null };
});
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: async () => ({
    from: mockDb.from,
    auth: { getUser: async () => ({ data: { user: mockUser } }) },
  }),
}));
jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: { from: (table: string) => mockDb.from(table), rpc: (name: string, args: unknown) => mockDb.rpc(name, args) },
}));
import AccessPage from "@/app/access/[purchaseId]/page";

const originalEnv = { ...process.env };
beforeEach(() => {
  delete process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY;
  delete process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
  mockUser = { id: "buyer" };
  mockPurchase = {
    id: "purchase", buyer_id: "buyer", creator_id: "creator", product_id: "product", post_id: "post",
    status: "paid", access_granted: true, payment_intent_id: "pi_owned", fulfillment: "discord", fulfillment_url: privateUrl,
  };
  mockDispute = null;
  mockDisputeError = null;
  mockEntitlement = { allowed: true, maxAgeSeconds: 30, applicable: true };
  mockDb.ops.length = 0;
});
afterEach(() => { process.env = { ...originalEnv }; });
const render = async () => renderToStaticMarkup(await AccessPage({ params: Promise.resolve({ purchaseId: "purchase" }) }));
const dispute = (status: string) => ({
  stripe_dispute_id: "du_owned", stripe_payment_intent_id: "pi_owned", stripe_charge_id: "ch_owned",
  disputed_amount_cents: 100, currency: "usd", status, stripe_event_created: 1,
});

test.each(["needs_response", "under_review", "lost"])("a %s dispute hides a paid purchase's legacy fulfillment URL", async status => {
  mockDispute = dispute(status);
  const html = await render();
  expect(html).toContain("Access unavailable");
  expect(html).not.toContain(privateUrl);
  expect(html).not.toContain("Open Discord");
  expect(mockDb.opsFor("payment_dispute_state")[0].filters).toEqual({ stripe_payment_intent_id: "pi_owned" });
});
test.each(["won", "warning_closed"])("a resolved %s dispute preserves eligible legacy delivery", async status => {
  mockDispute = dispute(status);
  expect(await render()).toContain(privateUrl);
});
test.each(["monthly", "fixed"])("expired %s access hides fulfillment even if the legacy flag remains true", async kind => {
  process.env[kind === "monthly" ? "CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY" : "CREATOR_FIXED_SERVICE_SCHEMA_READY"] = "true";
  mockEntitlement = { allowed: false, maxAgeSeconds: 0, applicable: true };
  const html = await render();
  expect(html).toContain("Access unavailable");
  expect(html).not.toContain(privateUrl);
});
test.each(["monthly", "fixed"])("current %s access can render delivery with the legacy access flag false", async kind => {
  process.env[kind === "monthly" ? "CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY" : "CREATOR_FIXED_SERVICE_SCHEMA_READY"] = "true";
  mockPurchase!.access_granted = false;
  expect(await render()).toContain(privateUrl);
});
test.each(["lookup error", "malformed canonical row"])("%s fails closed before fulfillment renders", async failure => {
  if (failure === "lookup error") mockDisputeError = { message: "synthetic lookup failure" };
  else mockDispute = { stripe_dispute_id: "du_owned" };
  const html = await render();
  expect(html).toContain("Access unavailable");
  expect(html).not.toContain(privateUrl);
});
test.each(["pending", "refunded", "failed"])("%s purchase never renders fulfillment", async status => {
  mockPurchase!.status = status;
  expect(await render()).not.toContain(privateUrl);
});
test("eligible one-time fulfillment remains available", async () => {
  const html = await render();
  expect(html).toContain(privateUrl);
  expect(html).toContain("Open Discord");
});
test("signed-out and other buyers never trigger privileged entitlement reads", async () => {
  mockUser = null;
  expect(await render()).not.toContain(privateUrl);
  mockUser = { id: "other" };
  expect(await render()).not.toContain(privateUrl);
  expect(mockDb.opsFor("payment_dispute_state")).toHaveLength(0);
});
