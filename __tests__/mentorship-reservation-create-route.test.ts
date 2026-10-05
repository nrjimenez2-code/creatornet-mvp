import { NextRequest } from "next/server";
import { PURCHASE_POLICY_VERSION } from "@/lib/purchasePolicies";
const mockAuth = jest.fn(), mockConfig = jest.fn(), mockObserve = jest.fn(), mockRead = jest.fn(), mockReserve = jest.fn(), mockPost = jest.fn();
const mockClient = jest.fn(), mockFrom = jest.fn();
let mockReady = true;
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => mockAuth() }));
jest.mock("@/lib/installments/contextServer", () => ({ exactContextServerConfig: () => mockConfig() }));
jest.mock("@/lib/installments/contextRuntime", () => ({ createExactContextRuntime: () => ({ observeContext: () => mockObserve() }) }));
jest.mock("@/lib/mentorshipInstallmentReservation", () => ({ readBuyerMentorshipInstallmentReservation: (...a: unknown[]) => mockRead(...a), reserveBuyerMentorshipInstallments: (...a: unknown[]) => mockReserve(...a) }));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => mockClient() }));
jest.mock("@/lib/checkoutGuards", () => ({ INVALID_POST: "invalid", resolvePostForProduct: (...a: unknown[]) => mockPost(...a) }));
jest.mock("@/lib/mentorshipInstallmentOptions", () => ({ mentorshipInstallmentOffersReady: () => mockReady }));
jest.mock("@/lib/purchasePolicies", () => ({ ...jest.requireActual("@/lib/purchasePolicies"), purchasePoliciesActive: () => true }));
jest.mock("@/lib/money", () => ({ getProcessingFeeSchedule: () => ({ version: "first-server-fees" }), getSubscriptionProcessingFeeSchedule: () => ({ version: "renewal-server-fees" }) }));
import { POST,GET } from "@/app/api/installments/reservations/route";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { siteOrigin: "https://fixture.vercel.app" }, evidence = { observed: "synthetic" };
const product = { id: id(3), creator_id: id(2), type: "mentorship", active: true, fixed_service_months: 10, price_cents: 10001, installment_options: [3] };
const body = { request_id: id(5), product_id: id(3), post_id: id(4), payment_count: 3,
  acceptance: { accepted: true, version: PURCHASE_POLICY_VERSION, fingerprint: "a".repeat(64) } };
const saved = { requestId: id(5), status: "reserved", terms: { productId: id(3), postId: id(4), paymentCount: 3, version: PURCHASE_POLICY_VERSION },
  fingerprint: body.acceptance.fingerprint, acceptedAt: "2026-09-21T00:00:00Z", providerOperationsAllowed: false };
const q = { select: jest.fn(), eq: jest.fn(), returns: jest.fn(), contains:jest.fn(), is:jest.fn(), maybeSingle: jest.fn() }, previous = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks(); mockReady = true;
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY = "true";
  process.env.CREATOR_PROCESSING_FEE_ENABLED = "true"; process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "true";
  mockAuth.mockResolvedValue({ id: id(1) }); mockConfig.mockReturnValue({ approvedContext: context, configuredSupabaseUrl: "https://example.invalid", supabaseServiceKey: "synthetic" });
  mockObserve.mockResolvedValue({ contextEvidence: evidence }); mockClient.mockReturnValue({ from: mockFrom }); mockFrom.mockReturnValue(q);
  [q.select, q.eq, q.returns,q.contains,q.is].forEach(fn => fn.mockReturnValue(q)); q.maybeSingle.mockResolvedValue({ data: product, error: null });
  mockRead.mockResolvedValue(null); mockPost.mockResolvedValue(id(4)); mockReserve.mockResolvedValue({ ...saved, destinationId: "private", attemptId: "private" });
});
afterAll(() => { process.env = previous; });
const call = (input: unknown = body, origin = context.siteOrigin) => POST(new NextRequest(`${context.siteOrigin}/api/installments/reservations`,
  { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) }));
test("authenticated creation sends owned identity, observed context and server fees to durable acceptance", async () => {
  const response = await call(); expect(response.status).toBe(201);
  expect(mockReserve).toHaveBeenCalledWith(expect.objectContaining({ buyerId: id(1), requestId: id(5), context, contextEvidence: evidence,
    product, postId: id(4), paymentCount: 3, acceptance: body.acceptance, firstPaymentFees: { version: "first-server-fees" }, renewalFees: { version: "renewal-server-fees" } }));
  const result = await response.json(); expect(result).toMatchObject({ reused: false, status: "reserved", providerOperationsAllowed: false });
  expect(result).not.toHaveProperty("destinationId"); expect(result).not.toHaveProperty("attemptId"); expect(result).not.toHaveProperty("url");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
test("unauthenticated buyers cannot inspect provider context or create acceptance", async () => {
  mockAuth.mockResolvedValue(null); expect((await call()).status).toBe(401); expect(mockConfig).not.toHaveBeenCalled(); expect(mockReserve).not.toHaveBeenCalled();
});
test("disabled complete checkout capability prevents reservations", async () => {
  mockReady = false; expect((await call()).status).toBe(409); expect(mockAuth).not.toHaveBeenCalled();
});
test("cross-origin requests fail before provider observation", async () => {
  expect((await call(body, "https://other.example")).status).toBe(403); expect(mockObserve).not.toHaveBeenCalled();
});
test.each([{ ...body, buyer_id: id(8) }, { ...body, amount_cents: 1 }, { ...body, payment_count: 25 },
  { ...body, payment_count: "3" }, { ...body, request_id: "invalid" },
  { ...body, acceptance: { ...body.acceptance, accepted: false } },
  { ...body, acceptance: { ...body.acceptance, fingerprint: "old" } }])("invalid or overridden request %p does not reach provider/database", async input => {
  expect((await call(input)).status).toBe(400); expect(mockObserve).not.toHaveBeenCalled(); expect(mockClient).not.toHaveBeenCalled();
});
test("retry uses original saved acceptance before looking at changed catalog or fees", async () => {
  mockRead.mockResolvedValue(saved); const response = await call(); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ reused: true, fingerprint: saved.fingerprint });
  expect(mockFrom).not.toHaveBeenCalled(); expect(mockReserve).not.toHaveBeenCalled();
});
test("existing request cannot be repurposed for a different selection", async () => {
  mockRead.mockResolvedValue({ ...saved, terms: { ...saved.terms, paymentCount: 6 } });
  expect((await call()).status).toBe(409); expect(mockFrom).not.toHaveBeenCalled(); expect(mockReserve).not.toHaveBeenCalled();
});
test("withdrawn offer cannot obtain new consent", async () => {
  q.maybeSingle.mockResolvedValue({ data: { ...product, active: false }, error: null });
  expect((await call()).status).toBe(404); expect(mockReserve).not.toHaveBeenCalled();
});
test("mismatched post cannot obtain a reservation", async () => {
  mockPost.mockResolvedValue("invalid"); expect((await call()).status).toBe(400); expect(mockReserve).not.toHaveBeenCalled();
});
test("lost write reply does not generate a new request or automatically retry", async () => {
  mockReserve.mockRejectedValue(Error("private database detail")); const response = await call(); expect(response.status).toBe(409);
  expect(mockReserve).toHaveBeenCalledTimes(1); expect(JSON.stringify(await response.json())).not.toContain("private database detail");
});


const recoverProduct=(query=`product_id=${id(3)}`)=>GET(new NextRequest(`${context.siteOrigin}/api/installments/reservations?${query}`));
test("product recovery finds only the authenticated acceptance without catalog or new-offer gates",async()=>{
  mockReady=false;q.maybeSingle.mockResolvedValue({error:null,data:{request_id:id(5),buyer_id:id(1),product_id:id(3)}});mockRead.mockResolvedValue(saved);
  const response=await recoverProduct();expect(response.status).toBe(200);expect(await response.json()).toEqual(saved);
  expect(mockFrom).toHaveBeenCalledWith("buyer_mentorship_installment_reservations_v1");expect(mockFrom).not.toHaveBeenCalledWith("products");
  expect(q.eq).toHaveBeenCalledWith("buyer_id",id(1));expect(q.eq).toHaveBeenCalledWith("product_id",id(3));expect(q.contains).toHaveBeenCalledWith("context",context);
  expect(mockReserve).not.toHaveBeenCalled();expect(response.headers.get("cache-control")).toBe("private, no-store");
});
test.each(["missing","foreign","error"])("product recovery rejects %s lookup",async kind=>{
  q.maybeSingle.mockResolvedValue({error:kind==="error"?{}:null,data:kind==="missing"?null:{request_id:id(5),buyer_id:id(9),product_id:id(3)}});
  expect((await recoverProduct()).status).toBe(kind==="missing"?404:409);expect(mockRead).not.toHaveBeenCalled();
});
test.each([`product_id=${id(3)}&buyer_id=${id(1)}`,`product_id=${id(3)}&product_id=${id(3)}`,"product_id=invalid"])("product recovery rejects override %s before context reads",async query=>{
  expect((await recoverProduct(query)).status).toBe(400);expect(mockObserve).not.toHaveBeenCalled();
});


test("product recovery authenticates before observing payment context",async()=>{
  mockAuth.mockResolvedValue(null);expect((await recoverProduct()).status).toBe(401);expect(mockConfig).not.toHaveBeenCalled();expect(mockFrom).not.toHaveBeenCalled();
});
test("unapplied reservation schema prevents product recovery reads",async()=>{
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY="false";
  expect((await recoverProduct()).status).toBe(409);expect(mockAuth).not.toHaveBeenCalled();expect(mockFrom).not.toHaveBeenCalled();
});

test("product recovery selects only the active acceptance when release schema is enabled",async()=>{
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY="true";
  q.maybeSingle.mockResolvedValue({data:{request_id:id(5),buyer_id:id(1),product_id:id(3)},error:null});mockRead.mockResolvedValue(saved);
  expect((await GET(new NextRequest(`${context.siteOrigin}/api/installments/reservations?product_id=${id(3)}`))).status).toBe(200);
  expect(q.is).toHaveBeenCalledWith("released_at",null);
  delete process.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY;
});
