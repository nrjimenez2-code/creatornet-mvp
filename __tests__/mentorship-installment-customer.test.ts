const mockCreate = jest.fn(), mockRetrieve = jest.fn(), mockObserve = jest.fn(), mockRpc = jest.fn(), mockRead = jest.fn(), mockStripe = jest.fn();
jest.mock("stripe", () => ({ __esModule: true, default: function (...args: unknown[]) {
  mockStripe(...args); return { customers: { create: mockCreate, retrieve: mockRetrieve } };
} }));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: mockRpc }) }));
jest.mock("@/lib/installments/contextServer", () => ({ exactContextServerConfig: () => config }));
jest.mock("@/lib/installments/contextRuntime", () => ({ createExactContextRuntime: () => ({ observeContext: mockObserve }) }));
jest.mock("@/lib/mentorshipInstallmentReservation", () => ({ readBuyerMentorshipInstallmentReservation: (...args: unknown[]) => mockRead(...args) }));
import { prepareBuyerMentorshipCustomer } from "@/lib/mentorshipInstallmentCustomer";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { mode: "test", platformAccountId: "acct_fixture", supabaseProjectRef: "abcdefghijklmnopqrst", siteOrigin: "https://fixture.vercel.app" };
const config = { approvedContext: context, configuredSupabaseUrl: "https://example.invalid", supabaseServiceKey: "synthetic", stripeSecretKey: "sk_test_synthetic" };
const saved = { fingerprint: "a".repeat(64), terms: { creatorId: id(4), productId: id(5), postId: id(6) } };
const metadata = { creatornet_installment_version: "buyer-mentorship-installments-v1", creatornet_installment_reservation_id: id(1),
  creatornet_installment_request_id: id(2), buyer_id: id(3), creator_id: id(4), product_id: id(5), post_id: id(6),
  terms_fingerprint: saved.fingerprint, operation_kind: "customer.create", payment_mode: "test", platform_account_id: "acct_fixture",
  supabase_project_ref: context.supabaseProjectRef, site_origin: context.siteOrigin };
const args = { requestId: id(2), buyerId: id(3), env: { CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY: "true", CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_READY: "true" } };
let operation: Record<string, any>, claim: Record<string, any>, customer: Record<string, any>;
beforeEach(() => {
  jest.clearAllMocks();
  operation = { reservation_id: id(1), api_version: "2025-10-29.clover", request: { metadata }, idempotency_key: `cn-buyer-customer-v1:${id(7)}`,
    lease_token: id(8), first_dispatch_at: new Date().toISOString(), customer_id: null };
  claim = { status: "dispatch", dispatch_before: new Date(Date.now()+30000).toISOString(), operation };
  customer = { id: "cus_fixture", object: "customer", created: Math.floor(Date.now()/1000), livemode: false,
    metadata, test_clock: null, lastResponse: { requestId: "req_fixture" } };
  mockRead.mockResolvedValue(saved); mockObserve.mockResolvedValue({ contextEvidence: {} });
  mockCreate.mockImplementation(async () => customer); mockRetrieve.mockImplementation(async () => customer);
  mockRpc.mockImplementation(async (name: string) => ({ error: null, data: name.startsWith("claim_") ? claim : { ...operation, customer_id: customer.id } }));
});
test("owned customer creation claims first, uses the saved key with SDK retries off, retrieves then binds", async () => {
  expect(await prepareBuyerMentorshipCustomer(args)).toEqual({ status: "customer_bound", customerId: "cus_fixture" });
  expect(mockCreate).toHaveBeenCalledWith({ metadata }, { idempotencyKey: operation.idempotency_key, maxNetworkRetries: 0 });
  expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockCreate.mock.invocationCallOrder[0]);
  expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(mockRetrieve.mock.invocationCallOrder[0]);
  expect(mockRetrieve.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[1]);
  expect(mockObserve).toHaveBeenCalledTimes(2);
  expect(mockStripe).toHaveBeenCalledWith("sk_test_synthetic", expect.objectContaining({ maxNetworkRetries: 0, timeout: 10000 }));
});
test("disabled provider capability performs no context, database or provider work", async () => {
  await expect(prepareBuyerMentorshipCustomer({ ...args, env: {} })).rejects.toThrow("needs review");
  expect(mockObserve).not.toHaveBeenCalled(); expect(mockRpc).not.toHaveBeenCalled(); expect(mockCreate).not.toHaveBeenCalled();
});
test.each(["busy", "review_required"])("%s operation never creates another customer", async status => {
  claim.status = status; expect(await prepareBuyerMentorshipCustomer(args)).toEqual({ status });
  expect(mockCreate).not.toHaveBeenCalled(); expect(mockRetrieve).not.toHaveBeenCalled();
});
test("bound identity is retrieved and verified without create or bind", async () => {
  claim.status = "bound"; operation.customer_id = customer.id;
  expect((await prepareBuyerMentorshipCustomer(args)).status).toBe("customer_bound");
  expect(mockCreate).not.toHaveBeenCalled(); expect(mockRpc).toHaveBeenCalledTimes(1);
});
test("expired dispatch admission refuses provider work", async () => {
  claim.dispatch_before = new Date(Date.now()-1000).toISOString();
  await expect(prepareBuyerMentorshipCustomer(args)).rejects.toThrow(); expect(mockCreate).not.toHaveBeenCalled();
});
test("altered request parameters cannot attach a card or replace accepted metadata", async () => {
  operation.request = { metadata, source: "tok_forged" };
  await expect(prepareBuyerMentorshipCustomer(args)).rejects.toThrow(); expect(mockCreate).not.toHaveBeenCalled();
});
test.each([{ livemode: true }, { metadata: { ...metadata, buyer_id: id(9) } }, { test_clock: "clock_other" }, { deleted: true }])("foreign or invalid customer reply %p is never bound", async changed => {
  Object.assign(customer, changed); await expect(prepareBuyerMentorshipCustomer(args)).rejects.toThrow();
  expect(mockRpc).toHaveBeenCalledTimes(1);
});
test("lost create response retains original operation without an in-process retry", async () => {
  mockCreate.mockRejectedValue(Error("private provider detail"));
  await expect(prepareBuyerMentorshipCustomer(args)).rejects.toThrow("Buyer installment customer needs review");
  expect(mockCreate).toHaveBeenCalledTimes(1); expect(mockRpc).toHaveBeenCalledTimes(1);
});
test("failure to bind the known customer never starts replacement creation", async () => {
  mockRpc.mockImplementation(async (name: string) => name.startsWith("claim_") ? { data: claim, error: null } : { data: null, error: { message: "lost reply" } });
  await expect(prepareBuyerMentorshipCustomer(args)).rejects.toThrow(); expect(mockCreate).toHaveBeenCalledTimes(1);
});

const recoveryArgs = () => ({ ...args, recoverExistingOnly: true, env: { ...args.env,
  CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_SCHEMA_READY: "true",
  CREATOR_MENTORSHIP_INSTALLMENT_ORIGINAL_BOOTSTRAP_RECOVERY_READY: "true" } });
test("existing-only customer recovery has a separate default-off capability", async () => {
  await expect(prepareBuyerMentorshipCustomer({ ...args, recoverExistingOnly: true })).rejects.toThrow("needs review");
  expect(mockRpc).not.toHaveBeenCalled(); expect(mockCreate).not.toHaveBeenCalled();
});
test("missing original customer operation cannot be created during recovery", async () => {
  mockRpc.mockResolvedValue({ error: null, data: { status: "partial_preparation" } });
  expect(await prepareBuyerMentorshipCustomer(recoveryArgs())).toEqual({ status: "partial_preparation" });
  expect(mockRpc).toHaveBeenCalledWith("recover_buyer_mentorship_preparation_v1", expect.objectContaining({ p_step: "customer.create" }));
  expect(mockCreate).not.toHaveBeenCalled(); expect(mockRetrieve).not.toHaveBeenCalled();
});
test("existing-only customer recovery uses the admitted original key after uncertainty", async () => {
  mockRpc.mockImplementation(async (name: string) => ({ error: null, data:
    name === "recover_buyer_mentorship_preparation_v1" ? claim : { ...operation, customer_id: customer.id } }));
  expect((await prepareBuyerMentorshipCustomer(recoveryArgs())).status).toBe("customer_bound");
  expect(mockCreate).toHaveBeenCalledWith(operation.request, { idempotencyKey: operation.idempotency_key, maxNetworkRetries: 0 });
  expect(mockRpc.mock.calls.some(([name]) => name === "claim_buyer_mentorship_customer_v1")).toBe(false);
});
