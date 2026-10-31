import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-placeholder";
let db: MockClient;
let postOwner: string | null | undefined;
let productOwner: string | null | undefined;
let lookupFault: string | null;
const stripe = jest.fn(() => { throw Error("No provider calls in ownership admission tests"); });
const exact = jest.fn();
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }) }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => stripe() }));
jest.mock("@/lib/installments/checkoutLink", () => ({ handoffExactCheckoutLink: (...args: unknown[]) => exact(...args) }));
jest.mock("@/lib/discoverCheckoutLinks", () => ({ withBuyerCheckoutLink: async (body: unknown) => body }));

beforeEach(() => {
  jest.clearAllMocks();
  postOwner = productOwner = "creator-one";
  lookupFault = null;
  exact.mockResolvedValue({ status: 200, body: { admitted: true } });
  db = createMockClient(op => {
    if (op.table === lookupFault) return { data: null, error: { message: "private lookup failure" } };
    if (op.table === "bookings") return { data: { id: "booking-one", creator_id: "creator-one",
      buyer_id: "creator-one", post_id: "post-one", status: "booked" }, error: null };
    if (op.table === "posts") return { data: { id: "post-one", creator_id: postOwner,
      product_id: "product-one" }, error: null };
    if (op.table === "products") return { data: { id: "product-one", creator_id: productOwner }, error: null };
    throw Error("Unexpected database operation: " + op.table);
  });
  db.auth.getUser = async () => ({ data: { user: { id: "creator-one" } }, error: null });
});

async function create(plan_type: string) {
  const { POST } = await import("@/app/api/bookings/[bookingId]/payment-link/route");
  return POST(new NextRequest("https://example.invalid/api/bookings/booking-one/payment-link", {
    method: "POST", headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
    body: JSON.stringify({ plan_type, installment_months: 3 }),
  }), { params: Promise.resolve({ bookingId: "booking-one" }) });
}

describe.each(["full", "installment"])("%s booking payment admission", plan => {
  test.each(["victim", null, undefined])("rejects a post owned by %s before any financial path", async owner => {
    postOwner = owner;
    expect((await create(plan)).status).toBe(403);
    expect(db.opsFor("products")).toEqual([]);
    expect(exact).not.toHaveBeenCalled();
    expect(stripe).not.toHaveBeenCalled();
    expect(db.ops.every(op => op.kind === "select")).toBe(true);
  });

  test.each(["victim", null, undefined])("rejects a product owned by %s before any financial path", async owner => {
    productOwner = owner;
    expect((await create(plan)).status).toBe(403);
    expect(exact).not.toHaveBeenCalled();
    expect(stripe).not.toHaveBeenCalled();
    expect(db.ops.every(op => op.kind === "select")).toBe(true);
  });

  test.each(["posts", "products"])("fails closed when the %s ownership lookup fails", async table => {
    lookupFault = table;
    expect((await create(plan)).status).toBe(500);
    expect(exact).not.toHaveBeenCalled();
    expect(stripe).not.toHaveBeenCalled();
    expect(db.ops.every(op => op.kind === "select")).toBe(true);
  });

  test("preserves matching ownership before dispatch to the existing exact handler", async () => {
    expect((await create(plan)).status).toBe(200);
    expect(exact).toHaveBeenCalledTimes(1);
    expect(db.ops.map(op => op.table)).toEqual(["bookings", "posts", "products"]);
    expect(stripe).not.toHaveBeenCalled();
  });
});
