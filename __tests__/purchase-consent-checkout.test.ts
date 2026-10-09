import { NextRequest } from "next/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { productPurchaseTerms, type ConsentProduct } from "@/lib/purchaseConsent";
const buyer = "10000000-0000-4000-8000-000000000001", creator = "10000000-0000-4000-8000-000000000002";
const postId = "10000000-0000-4000-8000-000000000008";
const consentId = "10000000-0000-4000-8000-000000000003";
const product = { id: "10000000-0000-4000-8000-000000000004", product_id: "10000000-0000-4000-8000-000000000004",
  creator_id: creator, type: "course", title: "Owned course", description: "One complete course", price_cents: 10000,
  amount_cents: 10000, currency: "usd", deliver_url: "https://delivery.example.invalid/course" };
const mockOriginalRecovery = jest.fn();
jest.mock("@/lib/productCheckoutOriginalRequest",()=>({recoverProductCheckoutOriginalRequest:(...args:unknown[])=>mockOriginalRecovery(...args)}));
const mockStripe = { checkout: { sessions: { create: jest.fn(), retrieve: jest.fn(), expire: jest.fn() } } };
let mockAttempt: Record<string, unknown> | null;
let mockProduct: ConsentProduct;
let mockOrderUpdateFailure = false;
const mockDb = createMockClient(op => {
  if (mockOrderUpdateFailure && op.table === "orders" && op.kind === "update") return {data:null,error:{message:"lost order attachment"}};
  if (op.table === "posts") return { data: { id: postId, creator_id: creator, product_id: product.id, price_cents: 10000 }, error: null };
  if (op.table === "products") return { data: mockProduct, error: null };
  if (op.table === "profiles") return { data: { stripe_account_id: "acct_ownedcreator" }, error: null };
  if (op.table === "record_product_purchase_consent_v1") return { data: consentId, error: null };
  if (op.table === "product_checkout_attempts") {
    if (op.kind === "insert" && mockAttempt) return { data: null, error: { code: "23505", message: "Existing buyer/product attempt" } };
    if (op.kind === "insert") mockAttempt = { id: "10000000-0000-4000-8000-000000000005", ...(op.payload as object) };
    if (op.kind === "update") mockAttempt = { ...mockAttempt, ...(op.payload as object) };
    return { data: mockAttempt, error: null };
  }
  if (op.table === "purchases" && op.kind === "insert") return { data: { id: "10000000-0000-4000-8000-000000000006" }, error: null };
  return { data: null, error: null };
});
jest.mock("@supabase/supabase-js", () => ({ createClient: () => mockDb }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => ({ id: buyer }) }));
jest.mock("@/lib/creatorStripeConnect", () => ({ isCreatorSellReady: async () => true }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => mockStripe }));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("@/lib/updatePostMetrics", () => ({ updatePostMetrics: jest.fn() }));
import { POST } from "@/app/api/checkout/route";
const saved = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks(); mockOrderUpdateFailure=false; delete process.env.CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY; delete process.env.CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY; mockDb.ops.length = 0; mockAttempt = null; mockProduct = { ...product };
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "true";
  process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY = "true";
  Object.assign(process.env, { NEXT_PUBLIC_SITE_URL: "https://creatornet.example.invalid",
    CREATOR_PURCHASE_CONSENT_SCHEMA_READY: "true", CREATOR_PURCHASE_POLICIES_READY: "true",
    CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED: "true", CREATOR_PROCESSING_FEE_ENABLED: "false" });
  mockStripe.checkout.sessions.create.mockResolvedValue({ id: "cs_test_consented", url: "https://checkout.stripe.com/synthetic", status: "open" });
});
afterAll(() => { process.env = saved; });
function request(consent?: unknown) { return new NextRequest("https://creatornet.example.invalid/api/checkout", {
  method: "POST", headers: { "Content-Type": "application/json", origin: "https://creatornet.example.invalid" },
  body: JSON.stringify({ type: "product", product_id: product.id, purchase_consent: consent }),
}); }
const quote = productPurchaseTerms(product, buyer, postId);
const acceptance = { accepted: true, version: quote.terms.version, fingerprint: quote.fingerprint };

test("an installment reservation cannot be adopted or dispatched by full checkout", async () => {
  mockAttempt = { id: "10000000-0000-4000-8000-000000000005", buyer_id: buyer, creator_id: creator,
    product_id: product.id, post_id: postId, purchase_identity: `post:${postId}`, status: "creating",
    checkout_kind: "installments", terms_fingerprint: "installment", attempt_key: "original", order_id: consentId,
    stripe_checkout_session_id: "cs_test_installment", stripe_checkout_url: null };
  const response = await POST(request(acceptance));
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("INSTALLMENT_CHECKOUT_EXISTS");
  expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(mockDb.ops.filter(op => ["orders", "purchases"].includes(op.table) && op.kind !== "select")).toEqual([]);
  expect(mockDb.ops.filter(op => op.table === "product_checkout_attempts" && op.kind === "update")).toEqual([]);
});
test("#6 actual existing checkout returns review before any Stripe session/order/purchase write", async () => {
  const response = await POST(request()); expect(response.status).toBe(200);
  expect((await response.json()).requires_consent).toBe(true);
  expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(mockDb.ops.filter(op => ["orders", "purchases", "product_checkout_attempts"].includes(op.table) && op.kind !== "select")).toEqual([]);
});
test("#6 actual checkout records acceptance and binds it to the same attempt and provider metadata", async () => {
  const response = await POST(request(acceptance)); expect(response.status).toBe(200);
  expect((await response.json()).url).toBe("https://checkout.stripe.com/synthetic");
  expect(mockAttempt?.purchase_consent_id).toBe(consentId);
  const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
  expect(params.metadata.purchase_consent_id).toBe(consentId);
  expect(params.payment_intent_data.metadata.purchase_consent_id).toBe(consentId);
  expect(mockDb.ops.findIndex(op => op.table === "record_product_purchase_consent_v1"))
    .toBeLessThan(mockDb.ops.findIndex(op => op.table === "orders"));
});
test.each([null, "10000000-0000-4000-8000-000000000099"])("#6 an expired checkout replacement replaces prior acceptance %s", async priorConsent => {
  mockAttempt = { id: "10000000-0000-4000-8000-000000000005", buyer_id: buyer, creator_id: creator,
    product_id: product.id, post_id: postId, purchase_identity: `post:${postId}`, status: "open",
    terms_fingerprint: "old", attempt_key: "old-key", order_id: "10000000-0000-4000-8000-000000000007",
    purchase_consent_id: priorConsent, stripe_checkout_session_id: "cs_test_expired", stripe_checkout_url: "https://checkout.stripe.com/expired" };
  mockStripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_test_expired", mode:"payment", livemode:false, status: "expired", payment_status:"unpaid", payment_intent:null, customer:null, amount_total:10000, currency:"usd" });
  const response = await POST(request(acceptance)); expect(response.status).toBe(200);
  const rotated = mockDb.ops.find(op => op.table === "product_checkout_attempts" && op.kind === "update" &&
    (op.payload as Record<string, unknown>).stripe_checkout_session_id === null);
  expect((rotated?.payload as Record<string, unknown>)?.purchase_consent_id).toBe(consentId);
  expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_test_expired");
  expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  expect(mockAttempt?.purchase_consent_id).toBe(consentId);
});

test("#6 rollback rotates to an unversioned attempt without falsely carrying the old acceptance", async () => {
  process.env.CREATOR_PURCHASE_POLICIES_READY = "false";
  mockAttempt = { id: "10000000-0000-4000-8000-000000000005", buyer_id: buyer, creator_id: creator,
    product_id: product.id, post_id: postId, purchase_identity: `post:${postId}`, status: "open",
    terms_fingerprint: "old", attempt_key: "old-key", order_id: "10000000-0000-4000-8000-000000000007",
    purchase_consent_id: consentId, stripe_checkout_session_id: "cs_test_expired", stripe_checkout_url: null };
  mockStripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_test_expired", mode:"payment", livemode:false, status: "expired", payment_status:"unpaid", payment_intent:null, customer:null, amount_total:10000, currency:"usd" });
  const response = await POST(request()); expect(response.status).toBe(200);
  expect(mockAttempt?.purchase_consent_id).toBeNull();
  expect(mockStripe.checkout.sessions.create.mock.calls[0][0].metadata.purchase_consent_id).toBeUndefined();
  expect(mockDb.ops.some(op => op.table === "record_product_purchase_consent_v1")).toBe(false);
});

test("timed checkout reviews duration before payment and binds it to automatic capture", async () => {
  mockProduct.fixed_service_months = 10;
  const review = await POST(request()); expect((await review.json()).requires_consent).toBe(true);
  expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  const timed = productPurchaseTerms(mockProduct, buyer, postId);
  const response = await POST(request({ accepted: true, version: timed.terms.version, fingerprint: timed.fingerprint }));
  expect(response.status).toBe(200);
  const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
  expect(params.mode).toBe("payment"); expect(params.payment_intent_data.capture_method).toBe("automatic");
  expect(params.metadata.fixed_service_version).toBe("fixed-service-months-v1");
  expect(params.payment_intent_data.metadata.purchase_consent_id).toBe(consentId);
  expect(params.custom_text.submit.message).toContain("10 calendar months");
  expect(params.line_items[0].price_data.unit_amount).toBe(10000);
});
test("a changed duration rejects stale consent before Stripe or financial writes", async () => {
  mockProduct.fixed_service_months = 10;
  const timed = productPurchaseTerms(mockProduct, buyer, postId); mockProduct.fixed_service_months = 4;
  expect((await POST(request({ accepted: true, version: timed.terms.version, fingerprint: timed.fingerprint }))).status).toBe(409);
  expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(mockDb.ops.filter(op => ["orders", "purchases", "product_checkout_attempts"].includes(op.table) && op.kind !== "select")).toEqual([]);
});
test.each(["CREATOR_FIXED_SERVICE_ONE_TIME_READY", "CREATOR_PURCHASE_POLICIES_READY"])(
  "timed checkout remains closed when %s is off", async key => {
    mockProduct.fixed_service_months = 10; process.env[key] = "false";
    const response = await POST(request()); expect(response.ok).toBe(false);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });


test("missing bound full-payment session cannot rotate into a replacement charge",async()=>{
  mockAttempt={id:"10000000-0000-4000-8000-000000000005",buyer_id:buyer,creator_id:creator,product_id:product.id,
    post_id:postId,purchase_identity:`post:${postId}`,status:"open",terms_fingerprint:"old",attempt_key:"old-key",
    order_id:"10000000-0000-4000-8000-000000000007",purchase_consent_id:consentId,stripe_checkout_session_id:"cs_test_missing",stripe_checkout_url:null};
  mockStripe.checkout.sessions.retrieve.mockRejectedValue({code:"resource_missing"});
  const response=await POST(request(acceptance));expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(mockDb.ops.some(op=>op.table==="product_checkout_attempts"&&op.kind==="update")).toBe(false);
});


test("changed terms cannot replace an unbound original full-payment attempt", async () => {
  mockAttempt={id:"10000000-0000-4000-8000-000000000005",buyer_id:buyer,creator_id:creator,product_id:product.id,
    post_id:postId,purchase_identity:`post:${postId}`,status:"creating",terms_fingerprint:"old",attempt_key:"original-uncertain-key",
    order_id:"10000000-0000-4000-8000-000000000007",purchase_consent_id:consentId,stripe_checkout_session_id:null,stripe_checkout_url:null};
  const response=await POST(request(acceptance));expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockAttempt.attempt_key).toBe("original-uncertain-key");
  expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(mockStripe.checkout.sessions.expire).not.toHaveBeenCalled();
  expect(mockDb.ops.filter(op=>["orders","purchases","product_checkout_attempts"].includes(op.table)&&op.kind==="update")).toEqual([]);
});


function durableAttempt(){
 Object.assign(process.env,{CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY:"true",CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY:"true"});
 mockOriginalRecovery.mockResolvedValue({id:"cs_test_original",status:"open",payment_status:"unpaid",url:"https://checkout.stripe.com/original",payment_intent:null});
}
test("new mentorship full checkout uses existing durable runtime and never legacy create",async()=>{
 durableAttempt();mockProduct.type="mentorship";
 const q=productPurchaseTerms(mockProduct,buyer,postId);
 const response=await POST(request({accepted:true,version:q.terms.version,fingerprint:q.fingerprint}));
 expect(response.status).toBe(200);expect(mockAttempt?.original_request_protocol).toBe("product-checkout-original-v1");
 expect(mockOriginalRecovery).toHaveBeenCalledTimes(1);expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
 expect(mockOriginalRecovery.mock.calls[0][0].candidate.payment_intent_data.application_fee_amount).toBe(1200);
 expect(mockStripe.checkout.sessions.expire).not.toHaveBeenCalled();
});
test("durable completed race returns original completion without legacy session overwrite",async()=>{
 durableAttempt();mockProduct.type="mentorship";mockOriginalRecovery.mockResolvedValue({id:"cs_test_paid",status:"complete",payment_status:"paid"});
 const q=productPurchaseTerms(mockProduct,buyer,postId);
 const response=await POST(request({accepted:true,version:q.terms.version,fingerprint:q.fingerprint}));
 expect(response.status).toBe(200);expect((await response.json()).session_id).toBe("cs_test_paid");
 expect(mockDb.ops.filter(op=>op.table==="product_checkout_attempts"&&op.kind==="update")).toEqual([]);
 expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();expect(mockStripe.checkout.sessions.expire).not.toHaveBeenCalled();
});
test("expired original checkout cannot fall into legacy cleanup or replacement",async()=>{
 durableAttempt();mockProduct.type="mentorship";mockOriginalRecovery.mockResolvedValue({id:"cs_test_expired",status:"expired",payment_status:"unpaid",url:null});
 const q=productPurchaseTerms(mockProduct,buyer,postId);
 expect((await POST(request({accepted:true,version:q.terms.version,fingerprint:q.fingerprint}))).status).toBeGreaterThanOrEqual(400);
 expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();expect(mockStripe.checkout.sessions.expire).not.toHaveBeenCalled();
 expect(mockDb.ops.filter(op=>op.table==="product_checkout_attempts"&&op.kind==="update")).toEqual([]);
});
test("lost durable runtime response leaves original attempt and order intact",async()=>{
 durableAttempt();mockProduct.type="mentorship";mockOriginalRecovery.mockRejectedValue(Error("lost response"));
 const q=productPurchaseTerms(mockProduct,buyer,postId);
 expect((await POST(request({accepted:true,version:q.terms.version,fingerprint:q.fingerprint}))).status).toBeGreaterThanOrEqual(400);
 expect(mockAttempt?.original_request_protocol).toBe("product-checkout-original-v1");
 expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();expect(mockStripe.checkout.sessions.expire).not.toHaveBeenCalled();
 expect(mockDb.ops.some(op=>op.table==="orders"&&op.kind==="update"&&(op.payload as any).status==="canceled")).toBe(false);
});


test("database failure after durable binding cannot expire original checkout or cancel its order",async()=>{
 durableAttempt();mockProduct.type="mentorship";mockOrderUpdateFailure=true;
 const q=productPurchaseTerms(mockProduct,buyer,postId);
 expect((await POST(request({accepted:true,version:q.terms.version,fingerprint:q.fingerprint}))).status).toBeGreaterThanOrEqual(400);
 expect(mockOriginalRecovery).toHaveBeenCalledTimes(1);expect(mockStripe.checkout.sessions.expire).not.toHaveBeenCalled();
 expect(mockDb.ops.some(op=>op.table==="orders"&&op.kind==="update"&&(op.payload as any).status==="canceled")).toBe(false);
});
test.each(["CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_READY","CREATOR_PRODUCT_CHECKOUT_ORIGINAL_REQUEST_SCHEMA_READY"])("disabling %s cannot send an existing durable attempt through legacy create",async flag=>{
 durableAttempt();mockProduct.type="mentorship";
 const q=productPurchaseTerms(mockProduct,buyer,postId),accepted={accepted:true,version:q.terms.version,fingerprint:q.fingerprint};
 expect((await POST(request(accepted))).status).toBe(200);
 process.env[flag]="false";
 expect((await POST(request(accepted))).status).toBeGreaterThanOrEqual(400);
 expect(mockOriginalRecovery).toHaveBeenCalledTimes(1);expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
 expect(mockStripe.checkout.sessions.expire).not.toHaveBeenCalled();
});


test("new full mentorship checkout collects a billing address without treating collection as country enforcement",async()=>{
 mockProduct={...product,type:"mentorship",fixed_service_months:3};
 const current=productPurchaseTerms(mockProduct,buyer,postId);
 const response=await POST(request({accepted:true,version:current.terms.version,fingerprint:current.fingerprint}));
 expect(response.status).toBe(200);
 expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({billing_address_collection:"required"}),expect.anything());
});
