import { NextRequest } from "next/server";
let viewer: string | null = "buyer";
const destination = "https://checkout.stripe.com/c/pay/cs_test_bound";
const retrieve = jest.fn();
const record = jest.fn();
const chain = {
  select: () => chain,
  eq: () => chain,
  single: async () => ({
    data: {
      provider_session_id: "cs_test_bound",
      buyer_id: "buyer",
      post_id: "post",
      destination,
    },
    error: null,
  }),
};
jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: { from: () => chain },
}));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: viewer ? { id: viewer } : null },
        error: null,
      }),
    },
  }),
}));
jest.mock("@/lib/stripeClient", () => ({
  getStripe: () => ({
    checkout: {
      sessions: { retrieve: (...args: unknown[]) => retrieve(...args) },
    },
  }),
}));
jest.mock("@/lib/discoverServer", () => ({
  discoverEnabled: () => true,
  recordDiscoverEvent: (...args: unknown[]) => record(...args),
}));
import { GET } from "@/app/api/checkout-link/[id]/route";
const context = {
  params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
};
const request = () =>
  new NextRequest(
    "https://creatornet.test/api/checkout-link/11111111-1111-4111-8111-111111111111",
  );
beforeEach(() => {
  viewer = "buyer";
  retrieve
    .mockReset()
    .mockResolvedValue({
      id: "cs_test_bound",
      status: "open",
      payment_status: "unpaid",
      url: destination,
    });
  record.mockReset();
});
test("only the intended buyer opening the bound active session records checkout intent", async () => {
  expect((await GET(request(), context)).headers.get("location")).toBe(
    destination,
  );
  expect(record).toHaveBeenCalledWith({
    actor: "user:buyer",
    userId: "buyer",
    postId: "post",
    kind: "checkout_start",
    entityKey: "cs_test_bound",
  });
  for (const other of ["creator", null]) {
    viewer = other;
    record.mockClear();
    retrieve.mockClear();
    expect((await GET(request(), context)).status).toBe(302);
    expect(record).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  }
});
test("expired or replaced provider sessions never count as checkout starts", async () => {
  for (const state of [
    { status: "expired", url: destination },
    { status: "open", url: "https://checkout.stripe.com/other" },
  ]) {
    retrieve.mockResolvedValue({
      id: "cs_test_bound",
      payment_status: "unpaid",
      ...state,
    });
    expect((await GET(request(), context)).status).toBe(302);
    expect(record).not.toHaveBeenCalled();
  }
});
