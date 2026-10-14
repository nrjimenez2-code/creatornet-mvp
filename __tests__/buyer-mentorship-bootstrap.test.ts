import type Stripe from "stripe";
import { buyerBootstrapFixture } from "../test-support/buyer-mentorship-bootstrap-fixture";
const mockPrepareCustomer = jest.fn(), mockRead = jest.fn(), mockObserve = jest.fn(), mockRpc = jest.fn();
const mockProductCreate = jest.fn(), mockProductRead = jest.fn(), mockSubscriptionCreate = jest.fn(), mockSubscriptionRead = jest.fn();
const mockHold = jest.fn(), mockCheckoutCreate = jest.fn(), mockCheckoutRead = jest.fn(), mockCustomerRead = jest.fn(), mockAccountRead = jest.fn();
jest.mock("stripe", () => ({ __esModule: true, default: function () { return {
  customers: { retrieve: mockCustomerRead }, accounts: { retrieve: mockAccountRead },
  products: { create: mockProductCreate, retrieve: mockProductRead },
  subscriptions: { create: mockSubscriptionCreate, retrieve: mockSubscriptionRead, update: mockHold },
  checkout: { sessions: { create: mockCheckoutCreate, retrieve: mockCheckoutRead } },
}; } }));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: mockRpc }) }));
jest.mock("@/lib/installments/contextServer", () => ({ exactContextServerConfig: () => config }));
jest.mock("@/lib/installments/contextRuntime", () => ({ createExactContextRuntime: () => ({ observeContext: mockObserve }) }));
jest.mock("@/lib/mentorshipInstallmentReservation", () => ({ readBuyerMentorshipBootstrapReservation: (...a: unknown[]) => mockRead(...a) }));
jest.mock("@/lib/mentorshipInstallmentCustomer", () => ({ prepareBuyerMentorshipCustomer: (...a: unknown[]) => mockPrepareCustomer(...a) }));
import { prepareBuyerMentorshipBootstrap } from "@/lib/mentorshipInstallmentBootstrap";
import { SERVER_PAYMENT_PROTOCOL } from "@/lib/serverPaymentConfirmation";
let fixture: ReturnType<typeof buyerBootstrapFixture>;
let config: Record<string, unknown>, subscription: Stripe.Subscription, product: Record<string, any>, session: Record<string, any>;
let operations: Map<string, any>;
const env = { CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_SCHEMA_READY: "true", CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_READY: "true",
  CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_DISPATCH_READY: "true" };
const args = () => ({ buyerId: fixture.reservation.buyerId, requestId: fixture.reservation.requestId, env });
async function rpc(name: string, params: any) {
  if(name==="pin_installment_server_payment_v1")return {error:null,data:{attempt_id:fixture.reservation.attemptId,
    reservation_id:fixture.reservation.id,buyer_id:fixture.reservation.buyerId,product_id:fixture.reservation.productId,
    kind:"first_installment",protocol:SERVER_PAYMENT_PROTOCOL,context:fixture.context}};
  if (name === "recover_buyer_mentorship_preparation_v1") {
    if (params.p_step === "bootstrap.begin") return rpc("begin_buyer_mentorship_bootstrap_v1", params);
    if (!operations.has(params.p_step)) return { error: null, data: { status: "partial_preparation" } };
    return rpc("claim_buyer_mentorship_bootstrap_v1", params);
  }
  if (name === "begin_buyer_mentorship_bootstrap_v1") return { error: null, data: { reservation_id: fixture.reservation.id,
    customer_id: fixture.customer.id, anchor_seconds: fixture.dependencies.anchorSeconds } };
  let op = operations.get(params.p_step);
  if (name === "claim_buyer_mentorship_bootstrap_v1") {
    if (!op) {
      op = { reservation_id: fixture.reservation.id, step: params.p_step, request: params.p_request,
        idempotency_key: `cn-buyer-bootstrap-v1:20000000-0000-4000-8000-${String(operations.size + 1).padStart(12, "0")}`,
        lease_token: "30000000-0000-4000-8000-000000000001", first_dispatch_at: new Date().toISOString() };
      operations.set(params.p_step, op);
    }
    return { error: null, data: { status: op.result_id ? "bound" : "dispatch", operation: op, dispatch_before: new Date(Date.now() + 30000).toISOString() } };
  }
  if (name === "bind_buyer_mentorship_bootstrap_v1") {
    op.result_id = params.p_object.id; return { error: null, data: op };
  }
  throw Error("Unexpected RPC");
}
beforeEach(() => {
  jest.resetAllMocks(); fixture = buyerBootstrapFixture();
  jest.useFakeTimers({ now: fixture.nowSeconds * 1000 });
  config = { approvedContext: fixture.context, configuredSupabaseUrl: fixture.contextEvidence.configuredSupabaseUrl,
    supabaseServiceKey: "synthetic", stripeSecretKey: "sk_test_synthetic" };
  operations = new Map(); subscription = JSON.parse(JSON.stringify(fixture.subscription)); subscription.pause_collection = null;
  mockPrepareCustomer.mockResolvedValue({ status: "customer_bound", customerId: fixture.customer.id });
  mockRead.mockImplementation(async () => fixture.reservation);
  mockObserve.mockResolvedValue({ contextEvidence: fixture.contextEvidence }); mockRpc.mockImplementation(rpc);
  mockCustomerRead.mockImplementation(async () => fixture.customer);
  mockAccountRead.mockResolvedValue({ id: fixture.reservation.destinationId, charges_enabled: true, payouts_enabled: true, capabilities: { transfers: "active" } });
  mockProductCreate.mockImplementation(async p => {
    product = { id: "prod_owned", object: "product", active: true, livemode: false, ...p, lastResponse: { requestId: "req_product" } }; return product;
  });
  mockProductRead.mockImplementation(async () => product);
  mockSubscriptionCreate.mockImplementation(async () => ({ ...subscription, lastResponse: { requestId: "req_subscription" } }));
  mockSubscriptionRead.mockImplementation(async () => JSON.parse(JSON.stringify(subscription)));
  mockHold.mockImplementation(async () => {
    subscription.pause_collection = { behavior: "keep_as_draft", resumes_at: null };
    return { ...subscription, lastResponse: { requestId: "req_hold" } };
  });
  mockCheckoutCreate.mockImplementation(async p => {
    session = { id: "cs_test_owned", object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid",
      livemode: false, customer: fixture.customer.id, currency: "usd", amount_total: 3333, expires_at: p.expires_at,
      metadata: p.metadata, automatic_tax: { enabled: false }, total_details: { amount_tax: 0, amount_discount: 0 },
      billing_address_collection: "required", url: "https://checkout.stripe.com/synthetic", lastResponse: { requestId: "req_checkout" } };
    return session;
  });
  mockCheckoutRead.mockImplementation(async () => session);
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test("durable claims precede each provider mutation and fresh reads precede binding; no URL or access is returned", async () => {
  expect(await prepareBuyerMentorshipBootstrap(args())).toEqual({ status: "checkout_unpublished", sessionId: "cs_test_owned", subscriptionId: "sub_owned" });
  expect([...operations.keys()]).toEqual(["product.create", "subscription.create", "subscription.hold", "checkout.create"]);
  const mutations = [mockProductCreate, mockSubscriptionCreate, mockHold, mockCheckoutCreate];
  for (const [index, mutation] of mutations.entries()) {
    const kind = [...operations.keys()][index];
    const claimIndex = mockRpc.mock.calls.findIndex(([name, p]) => name === "claim_buyer_mentorship_bootstrap_v1" && p.p_step === kind);
    const bindIndex = mockRpc.mock.calls.findIndex(([name, p]) => name === "bind_buyer_mentorship_bootstrap_v1" && p.p_step === kind);
    expect(mockRpc.mock.invocationCallOrder[claimIndex]).toBeLessThan(mutation.mock.invocationCallOrder[0]);
    expect(mockRpc.mock.invocationCallOrder[bindIndex]).toBeGreaterThan(mutation.mock.invocationCallOrder[0]);
    expect(mutation.mock.calls[0].at(-1)).toEqual({ idempotencyKey: operations.get(kind).idempotency_key, maxNetworkRetries: 0 });
  }
  expect(mockCheckoutCreate.mock.calls[0][0].expires_at).toBe(fixture.dependencies.anchorSeconds + 86400);
  expect(mockCheckoutCreate.mock.calls[0][0].metadata).not.toHaveProperty("booking_id");
});
test("separate dispatch gate leaves a verified held subscription without creating a payable Checkout", async () => {
  expect(await prepareBuyerMentorshipBootstrap({ ...args(), env: { ...env, CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_DISPATCH_READY: "false" } }))
    .toEqual({ status: "held_unpublished", subscriptionId: "sub_owned" });
  expect(mockCheckoutCreate).not.toHaveBeenCalled(); expect(operations.size).toBe(3);
});

test("manual first payment pins its exclusive protocol before subscription creation and never creates hosted Checkout",async()=>{
  const result=await prepareBuyerMentorshipBootstrap({...args(),serverControlledFirstPayment:true,env:{...env,
    CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_INTENT_READY:"true"}});
  expect(result).toEqual({status:"held_unpublished",subscriptionId:"sub_owned"});
  expect([...operations.keys()]).toEqual(["product.create","subscription.create","subscription.hold"]);
  const at=mockRpc.mock.calls.findIndex(([name])=>name==="pin_installment_server_payment_v1");
  expect(mockRpc.mock.invocationCallOrder[at]).toBeLessThan(mockSubscriptionCreate.mock.invocationCallOrder[0]);
  expect(mockCheckoutCreate).not.toHaveBeenCalled();
});
test("manual preparation fails closed if protocol selection is refused",async()=>{
  mockRpc.mockImplementation(async(name,p)=>name==="pin_installment_server_payment_v1"?{data:null,error:{message:"old checkout"}}:rpc(name,p));
  await expect(prepareBuyerMentorshipBootstrap({...args(),serverControlledFirstPayment:true,env:{...env,
    CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_INTENT_READY:"true"}})).rejects.toThrow("needs review");
  expect(mockSubscriptionCreate).not.toHaveBeenCalled();expect(mockCheckoutCreate).not.toHaveBeenCalled();
});
test("manual preparation requires its gates before any customer preparation",async()=>{
  await expect(prepareBuyerMentorshipBootstrap({...args(),serverControlledFirstPayment:true})).rejects.toThrow("needs review");
  expect(mockPrepareCustomer).not.toHaveBeenCalled();
});
test("bootstrap gates default off before any work", async () => {
  await expect(prepareBuyerMentorshipBootstrap({ ...args(), env: {} })).rejects.toThrow("needs review");
  expect(mockPrepareCustomer).not.toHaveBeenCalled(); expect(mockRpc).not.toHaveBeenCalled();
});
test.each(["busy", "review_required"])("%s original customer prevents further bootstrap", async status => {
  mockPrepareCustomer.mockResolvedValue({ status }); expect(await prepareBuyerMentorshipBootstrap(args())).toEqual({ status });
  expect(mockRpc).not.toHaveBeenCalled(); expect(mockProductCreate).not.toHaveBeenCalled();
});
test("bound operations are re-read without repeating provider mutations", async () => {
  await prepareBuyerMentorshipBootstrap(args()); await prepareBuyerMentorshipBootstrap(args());
  for (const mutation of [mockProductCreate, mockSubscriptionCreate, mockHold, mockCheckoutCreate]) expect(mutation).toHaveBeenCalledTimes(1);
  expect(mockProductRead).toHaveBeenCalledTimes(2);
});
test.each(["product.create", "subscription.create", "subscription.hold", "checkout.create"])("lost %s bind retries only the original provider operation with the original key", async failedStep => {
  let fail = true;
  mockRpc.mockImplementation(async (name, p) => {
    if (fail && name === "bind_buyer_mentorship_bootstrap_v1" && p.p_step === failedStep) { fail = false; throw Error("lost reply"); }
    return rpc(name, p);
  });
  await expect(prepareBuyerMentorshipBootstrap(args())).rejects.toThrow("needs review");
  const saved = structuredClone(operations.get(failedStep));
  await prepareBuyerMentorshipBootstrap(args());
  expect(operations.get(failedStep).request).toEqual(saved.request);
  expect(operations.get(failedStep).idempotency_key).toBe(saved.idempotency_key);
  const mutation = ({ "product.create": mockProductCreate, "subscription.create": mockSubscriptionCreate,
    "subscription.hold": mockHold, "checkout.create": mockCheckoutCreate })[failedStep]!;
  expect(mutation).toHaveBeenCalledTimes(2); expect(mutation.mock.calls[1]).toEqual(mutation.mock.calls[0]);
});
test.each(["busy", "review_required", "expired", "request drift"])("claim %s cannot dispatch", async issue => {
  mockRpc.mockImplementation(async (name, p) => {
    const result = await rpc(name, p);
    if (name.startsWith("claim_")) {
      if (issue === "expired") result.data.dispatch_before = new Date(Date.now() - 1).toISOString();
      else if (issue === "request drift") result.data.operation = { ...result.data.operation, request: {} };
      else result.data.status = issue;
    }
    return result;
  });
  if (issue === "busy" || issue === "review_required") expect(await prepareBuyerMentorshipBootstrap(args())).toEqual({ status: issue });
  else await expect(prepareBuyerMentorshipBootstrap(args())).rejects.toThrow("needs review");
  expect(mockProductCreate).not.toHaveBeenCalled();
});
test("foreign customer and unavailable destination stop before any creation", async () => {
  mockAccountRead.mockResolvedValue({ id: "acct_other" });
  await expect(prepareBuyerMentorshipBootstrap(args())).rejects.toThrow(); expect(mockProductCreate).not.toHaveBeenCalled();
});
test("hold drift before Checkout cannot publish a payment session", async () => {
  mockHold.mockImplementation(async () => ({ ...subscription, pause_collection: { behavior: "keep_as_draft", resumes_at: fixture.nowSeconds + 100 }, lastResponse: { requestId: "req_hold" } }));
  await expect(prepareBuyerMentorshipBootstrap(args())).rejects.toThrow(); expect(mockCheckoutCreate).not.toHaveBeenCalled();
});
test("provider create failure preserves the claim and never retries in-process", async () => {
  mockProductCreate.mockRejectedValue(Error("private provider details"));
  await expect(prepareBuyerMentorshipBootstrap(args())).rejects.toThrow("Buyer installment bootstrap needs review");
  expect(mockProductCreate).toHaveBeenCalledTimes(1); expect(operations.get("product.create").result_id).toBeUndefined();
});

const recoveryArgs = () => ({ ...args(), recoverExistingOnly: true, env: { ...env,
  CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_SCHEMA_READY: "true",
  CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_READY: "true" } });
test("existing-only recovery is separately gated before any work", async () => {
  await expect(prepareBuyerMentorshipBootstrap({ ...args(), recoverExistingOnly: true })).rejects.toThrow("needs review");
  expect(mockPrepareCustomer).not.toHaveBeenCalled(); expect(mockRpc).not.toHaveBeenCalled();
});
test("missing original customer or anchor cannot advance preparation", async () => {
  mockPrepareCustomer.mockResolvedValueOnce({ status: "partial_preparation" });
  expect(await prepareBuyerMentorshipBootstrap(recoveryArgs())).toEqual({ status: "partial_preparation" });
  expect(mockRpc).not.toHaveBeenCalled();
  mockRpc.mockResolvedValueOnce({ error: null, data: { status: "partial_preparation" } });
  expect(await prepareBuyerMentorshipBootstrap(recoveryArgs())).toEqual({ status: "partial_preparation" });
  expect(mockProductCreate).not.toHaveBeenCalled();
  expect(mockPrepareCustomer).toHaveBeenLastCalledWith(expect.objectContaining({ recoverExistingOnly: true }));
});
test.each(["product.create", "subscription.create", "subscription.hold", "checkout.create"])(
  "existing-only recovery binds uncertain %s with the same key and stops before the next missing step", async failedStep => {
    let fail = true;
    mockRpc.mockImplementation(async (name, p) => {
      if (fail && name === "bind_buyer_mentorship_bootstrap_v1" && p.p_step === failedStep) { fail = false; throw Error("lost reply"); }
      return rpc(name, p);
    });
    await expect(prepareBuyerMentorshipBootstrap(args())).rejects.toThrow("needs review");
    const savedKeys = [...operations.keys()], original = structuredClone(operations.get(failedStep));
    mockRpc.mockClear();
    const result = await prepareBuyerMentorshipBootstrap(recoveryArgs());
    expect(result.status).toBe(failedStep === "checkout.create" ? "checkout_unpublished" : "partial_preparation");
    expect([...operations.keys()]).toEqual(savedKeys);
    expect(operations.get(failedStep).idempotency_key).toBe(original.idempotency_key);
    expect(operations.get(failedStep).request).toEqual(original.request);
    const mutation = ({ "product.create": mockProductCreate, "subscription.create": mockSubscriptionCreate,
      "subscription.hold": mockHold, "checkout.create": mockCheckoutCreate })[failedStep]!;
    expect(mutation).toHaveBeenCalledTimes(2); expect(mutation.mock.calls[1]).toEqual(mutation.mock.calls[0]);
    expect(mockRpc.mock.calls.filter(([name]) => name.startsWith("claim_") || name.startsWith("begin_"))).toEqual([]);
    expect(result).not.toHaveProperty("url"); expect(result).not.toHaveProperty("releaseAllowed");
  });
