import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-placeholder";
let db: MockClient;
let user: { id: string } | null;
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => user }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true, clientKey: () => "test" }));

const bookingId = "11111111-1111-4111-8111-111111111111";
let creatorId: string;
let payments: Array<{ id: string; status: string }> | null;
let paymentError: { code: string; message: string } | null;
let deleteError: { code: string; message: string } | null;
beforeEach(() => {
  user = { id: "creator-one" };
  creatorId = "creator-one";
  payments = [];
  paymentError = deleteError = null;
  db = createMockClient(op => {
    if (op.table === "bookings" && op.kind === "select")
      return { data: { id: bookingId, creator_id: creatorId }, error: null };
    if (op.table === "booking_payments" && op.kind === "select")
      return { data: payments, error: paymentError };
    if (op.table === "bookings" && op.kind === "delete")
      return { data: null, error: deleteError };
    throw Error("Unexpected operation: " + op.kind + " " + op.table);
  });
});

async function remove() {
  const { DELETE } = await import("@/app/api/bookings/[bookingId]/route");
  return DELETE(new NextRequest("https://example.invalid/api/bookings/" + bookingId, { method: "DELETE" }),
    { params: Promise.resolve({ bookingId }) });
}
const writes = () => db.ops.filter(op => op.kind !== "select");

test.each(["pending", "link_sent", "completed", "canceled", "refunded"])(
  "%s payment evidence blocks deletion without mutation", async status => {
    payments = [{ id: "payment-one", status }];
    expect((await remove()).status).toBe(409);
    expect(writes()).toEqual([]);
    expect(db.opsFor("booking_payments")[0].filters).toEqual({ booking_id: bookingId });
  });

test("payment lookup failure, including a missing table, blocks deletion", async () => {
  paymentError = { code: "42P01", message: "booking_payments does not exist" };
  expect((await remove()).status).toBe(500);
  expect(writes()).toEqual([]);
});

test("a missing payment result fails closed", async () => {
  payments = null;
  expect((await remove()).status).toBe(500);
  expect(writes()).toEqual([]);
});

test("an owner can delete a booking with no payment history", async () => {
  expect((await remove()).status).toBe(200);
  expect(writes()).toHaveLength(1);
  expect(writes()[0]).toMatchObject({ table: "bookings", kind: "delete",
    filters: { id: bookingId, creator_id: "creator-one" } });
});

test.each(["23001", "23503"])("a concurrent payment conflict %s returns409 without deleting payment rows", async code => {
  deleteError = { code, message: "booking referenced by payment" };
  const result = await remove();
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ error: "Bookings with payment history cannot be deleted." });
  expect(writes().every(op => op.table === "bookings")).toBe(true);
});

test("other deletion failures remain errors", async () => {
  deleteError = { code: "08006", message: "connection lost" };
  expect((await remove()).status).toBe(500);
});

test("signed-out callers and other creators cannot delete or inspect payment history", async () => {
  user = null;
  expect((await remove()).status).toBe(401);
  expect(db.ops).toEqual([]);
  user = { id: "creator-two" };
  expect((await remove()).status).toBe(403);
  expect(db.opsFor("booking_payments")).toEqual([]);
  expect(writes()).toEqual([]);
});
