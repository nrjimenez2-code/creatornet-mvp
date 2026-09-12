import { NextRequest } from "next/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { handoffContextCheckoutLink, readContextCheckoutPayments } from "../lib/installments/contextCheckoutApp";
import { confirmExactInstallmentSandbox } from "../lib/installments/purchaseLifecycle";
import { POST } from "../app/api/bookings/[bookingId]/payment-link/route";

const creator = "11111111-1111-4111-8111-111111111111", buyer = "22222222-2222-4222-8222-222222222222";
const booking = "33333333-3333-4333-8333-333333333333", reservation = "44444444-4444-4444-8444-444444444444";
const product = "55555555-5555-4555-8555-555555555555", post = "66666666-6666-4666-8666-666666666666", purchaseId = "77777777-7777-4777-8777-777777777777";
const context = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_Synthetic",
  supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: "https://synthetic-checkout.vercel.app" };
const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "local-v1" };
const terms = { version: "exact-cents-context-v2", currency: "usd", bookingId: booking, productId: product, postId: post,
  buyerId: buyer, creatorId: creator, destinationId: "acct_SyntheticCreator", title: "Synthetic offer", totalCents: 199900,
  paymentCount: 3, firstPaymentFeeSchedule: fee, renewalFeeSchedule: fee };
const r = { id: reservation, bookingId: booking, context, terms };
const url = "https://checkout.stripe.com/c/pay/cs_test_Synthetic#private";
const order: string[] = [];
const stage = (name: string, value: unknown) => jest.fn(async () => { order.push(name); return value; });
const observe = stage("observe", { contextEvidence: "synthetic-owned-evidence" });
const reserve = stage("reserve", r), load = stage("load", r), plan = stage("plan", {}), customer = stage("customer", { status: "customer_bound" });
const held = stage("held", { status: "held_unpublished" }), checkout = stage("checkout", { status: "checkout_prepared_unpublished" });
const publish = stage("publish", { status: "checkout_published", url, sessionId: "cs_test_Synthetic", reused: false });
let known: boolean, prior: boolean, firstCredited: boolean, authenticatedActor: string | null, db: ReturnType<typeof createMockClient>;
let agreement: Record<string, unknown>, purchase: Record<string, unknown>, session: Record<string, unknown>;
const savedEnv = { ...process.env };
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }) }));
jest.mock("../lib/stripeClient", () => ({ getStripe: jest.fn(() => { throw Error("Legacy Stripe must not be called"); }) }));
jest.mock("../lib/installments/contextServer", () => ({ exactContextServerConfig: () => ({ approvedContext: context }) }));
jest.mock("../lib/installments/contextReservation", () => ({ ...jest.requireActual("../lib/installments/contextReservation"),
  createExactContextReservationStore: () => ({ reserve, load }) }));
jest.mock("../lib/installments/contextRuntime", () => ({
  createExactContextRuntime: () => ({ observeContext: observe }), createExactContextBootstrapPlanner: () => ({ planCustomer: plan }),
  createExactContextCustomerBootstrap: () => ({ createCustomer: customer }), createExactContextHeldBootstrap: () => ({ prepareHeld: held }),
  createExactContextCheckout: () => ({ prepareCheckout: checkout }), createExactContextCheckoutPublication: () => ({ publishCheckout: publish }),
}));
function env() { return { CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY: "true", CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY: "true",
  CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_PUBLISH_READY: "true", CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY: "true",
  CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_BOOKING_IDS: booking, CREATOR_PROCESSING_FEE_ENABLED: "true",
  STRIPE_PROCESSING_FEE_BPS: "290", STRIPE_PROCESSING_FEE_FIXED_CENTS: "30", STRIPE_PROCESSING_FEE_SCHEDULE_VERSION: "synthetic-v1", STRIPE_BILLING_FEE_BPS: "0" }; }
const body = { plan_type: "installment", installment_months: 3 };
const args = () => ({ admin: db as never, bookingId: booking, actorId: creator, body, origin: context.siteOrigin, env: env() });
beforeEach(() => {
  jest.clearAllMocks(); order.length = 0; known = false; prior = false; firstCredited = false; authenticatedActor = creator;
  publish.mockImplementation(async () => { order.push("publish"); return { status: "checkout_published", url, sessionId: "cs_test_Synthetic", reused: false }; });
  agreement = { id: reservation, terms, status: "active", purchase_id: purchaseId, purchase_seeded_at: "2026-09-09", first_fulfilled_at: "2026-09-09",
    stripe_checkout_session_id: "cs_test_Synthetic", stripe_subscription_id: "sub_Synthetic", stripe_customer_id: "cus_Synthetic" };
  purchase = { id: purchaseId, buyer_id: buyer, creator_id: creator, post_id: post, product_id: product, booking_id: booking,
    session_id: "cs_test_Synthetic", subscription_id: "sub_Synthetic", status: "active", access_granted: true, paid_count: 1, target_months: 3, is_refund: false, is_suspect: false };
  session = { id: "cs_test_Synthetic", object: "checkout.session", mode: "payment", livemode: false, customer: "cus_Synthetic",
    status: "complete", payment_status: "paid", metadata: { installment_collection_version: "exact-cents-context-v2", installment_plan_id: reservation, buyer_id: buyer } };
  db = createMockClient(op => {
    if (op.table === "bookings") return { data: { id: booking, creator_id: creator, buyer_id: buyer, post_id: post, status: "booked" }, error: null };
    if (op.table === "exact_installment_context_reservations_v2") return { data: known ? { id: reservation } : null, error: null };
    if (op.table === "booking_payments") return { data: prior ? [{ id: "old-payment" }] : [], error: null };
    if (op.table === "read_exact_context_checkout_links_v2") return { data: [{ reservationId: reservation, bookingId: booking, terms,
      createdAt: "2026-09-09", publishedAt: "2026-09-09", sessionId: "cs_test_Synthetic", url, expiresAt: 9999999999 }], error: null };
    if (op.table === "resolve_exact_context_event_v2") return { data: { reservationId: reservation, context, creatorId: creator, firstCredited,
      sessionId: "cs_test_Synthetic", subscriptionId: "sub_Synthetic", customerId: "cus_Synthetic" }, error: null };
    if (op.table === "exact_installment_agreements") return { data: agreement, error: null };
    if (op.table === "purchases") return { data: purchase, error: null };
    throw Error("Unexpected database operation: " + op.table);
  });
  db.auth.getUser = async () => ({ data: { user: authenticatedActor ? { id: authenticatedActor } : null }, error: null });
  process.env = { ...savedEnv, ...env() };
});
afterEach(() => { process.env = { ...savedEnv }; });
const request = () => new NextRequest(context.siteOrigin + `/api/bookings/${booking}/payment-link`, { method: "POST",
  headers: { authorization: "Bearer SYNTHETIC-NOT-A-CREDENTIAL", origin: context.siteOrigin, "content-type": "application/json" }, body: JSON.stringify(body) });
test("#3 existing authenticated creator endpoint returns a link projection only after publication", async () => {
  const response = await POST(request(), { params: Promise.resolve({ bookingId: booking }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ url, payment: { id: reservation, payment_record_kind: "checkout_reservation", status: "link_sent",
    amount_total_cents: 199900, installment_amount_cents: 66633, stripe_payment_intent_id: null } });
  expect(order).toEqual(["observe", "reserve", "plan", "customer", "held", "checkout", "publish"]);
  expect(db.ops.every(op => op.kind === "select" || op.table === "read_exact_context_checkout_links_v2")).toBe(true);
  expect(purchase.paid_count).toBe(1);
});
test.each([null, buyer])("#3 creator endpoint refuses unauthenticated/non-owner %s before payment operations", async actor => {
  authenticatedActor = actor;
  expect((await POST(request(), { params: Promise.resolve({ bookingId: booking }) })).status).toBe(actor ? 403 : 401);
  expect(order).toEqual([]);
});
test("#3 repeated creator request reuses the reservation and never resnapshots its fees", async () => {
  known = true; expect(await handoffContextCheckoutLink(args())).toMatchObject({ status: 200 });
  expect(reserve).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledWith(reservation, creator);
});
test.each(["gate", "origin", "count", "price", "publication"])('#3 failed %s preserves reservation and exposes no URL', async fault => {
  known = true; const input = args();
  if (fault === "gate") input.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_PUBLISH_READY = "false";
  if (fault === "origin") input.origin = "https://foreign.invalid";
  if (fault === "count") input.body = { ...body, installment_months: 4 };
  if (fault === "price") input.body = { ...body, price: 1 } as typeof body;
  if (fault === "publication") publish.mockRejectedValueOnce(Error("Synthetic private provider failure"));
  const result = await handoffContextCheckoutLink(input);
  expect(result?.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify(result)).not.toContain("checkout.stripe.com");
  expect(reserve).not.toHaveBeenCalled();
});
test("#3 earlier payments stay on their original protocol and default-off reads nothing", async () => {
  prior = true; expect(await handoffContextCheckoutLink(args())).toBeNull(); expect(order).toEqual([]);
  db.ops.length = 0; expect(await handoffContextCheckoutLink({ ...args(), env: {} })).toBeNull();
  expect(await readContextCheckoutPayments(db as never, creator, [booking], {})).toEqual([]); expect(db.ops).toEqual([]);
});
test("#3 paid redirect before first credit remains pending without seeding or access writes", async () => {
  expect(await confirmExactInstallmentSandbox({ admin: db as never, session: session as never, buyerId: buyer, env: env() })).toMatchObject({ httpStatus: 202, body: { status: "pending" } });
  expect(db.ops.map(op => op.table)).toEqual(["resolve_exact_context_event_v2"]);
  expect(plan).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
});
test("#3 credited first installment reaches the existing success contract without claiming full payoff", async () => {
  firstCredited = true;
  expect(await confirmExactInstallmentSandbox({ admin: db as never, session: session as never, buyerId: buyer, env: env() })).toMatchObject({ httpStatus: 200,
    body: { status: "paid", purchase_id: purchaseId, product_id: product } });
  expect(purchase.status).toBe("active"); expect(purchase.paid_count).toBe(1);
  expect(db.ops.every(op => op.kind === "select" || op.table === "resolve_exact_context_event_v2")).toBe(true);
});
test.each(["buyer", "mode", "refunded", "unfulfilled", "no_access"])("#3 success does not grant access for %s", async fault => {
  firstCredited = true; let caller = buyer;
  if (fault === "buyer") caller = creator;
  if (fault === "mode") session.livemode = true;
  if (fault === "refunded") purchase.is_refund = true;
  if (fault === "unfulfilled") agreement.first_fulfilled_at = null;
  if (fault === "no_access") purchase.access_granted = false;
  const result = confirmExactInstallmentSandbox({ admin: db as never, session: session as never, buyerId: caller, env: env() });
  if (fault === "buyer" || fault === "mode") await expect(result).rejects.toThrow();
  else expect((await result)?.httpStatus).toBe(fault === "refunded" ? 409 : 202);
});
