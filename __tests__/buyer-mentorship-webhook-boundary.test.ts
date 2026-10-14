import Stripe from "stripe";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const verifier = new Stripe("sk_test_synthetic_no_network"), secret = "synthetic-buyer-boundary";
const claim = jest.fn(), complete = jest.fn(), release = jest.fn(), monthly = jest.fn(), exact = jest.fn();
const retrieveCharge = jest.fn();
const recordBuyer = jest.fn();
const recordLater=jest.fn();
const refundBuyer=jest.fn();
const disputeBuyer=jest.fn();
const recoverBuyer=jest.fn(),resumeFuture=jest.fn();
jest.mock("@/lib/mentorshipInstallmentPaymentRecovery",()=>({handoffBuyerMentorshipPaidFutureCollection:(...a:unknown[])=>resumeFuture(...a),recoverBuyerMentorshipPayment:(...a:unknown[])=>recoverBuyer(...a)}));
jest.mock("@/lib/mentorshipInstallmentDispute",()=>({observeBuyerMentorshipDispute:(...a:unknown[])=>disputeBuyer(...a)}));
jest.mock("@/lib/mentorshipInstallmentRefund",()=>({reconcileBuyerMentorshipRefund:(...a:unknown[])=>refundBuyer(...a)}));
jest.mock("@/lib/mentorshipInstallmentReconciliation",()=>({reconcileBuyerMentorshipInvoice:(...a:unknown[])=>recordLater(...a)}));
const activateBuyer=jest.fn();
jest.mock("@/lib/mentorshipInstallmentActivationRuntime",()=>({activateBuyerMentorship:(...a:unknown[])=>activateBuyer(...a)}));
jest.mock("@/lib/mentorshipInstallmentAccounting", () => ({ recordBuyerMentorshipFirstPayment: (...a: unknown[]) => recordBuyer(...a) }));
let db = createMockClient(() => ({ data: null, error: null }));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => ({ webhooks: verifier.webhooks, charges: { retrieve: retrieveCharge } }) }));
jest.mock("@/lib/stripeEvents", () => ({ claimStripeEvent: (...a: unknown[]) => claim(...a), completeStripeEvent: (...a: unknown[]) => complete(...a), releaseStripeEvent: (...a: unknown[]) => release(...a) }));
jest.mock("@/lib/membershipWebhook", () => ({ handoffMonthlyMentorshipWebhook: (...a: unknown[]) => monthly(...a) }));
jest.mock("@/lib/installments/routeHandoff", () => ({ handoffExactInstallmentWebhook: (...a: unknown[]) => exact(...a) }));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("@/lib/updatePostMetrics", () => ({ updatePostMetrics: jest.fn() }));
const previous = { ...process.env };
const metadata = { creatornet_installment_version: "buyer-mentorship-installments-v1", product_id: "synthetic-product" };
beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks();
  process.env = { ...previous, VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_test_synthetic_no_network",
    STRIPE_WEBHOOK_SECRET: secret, NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic",
    CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY: "false" };
  db = createMockClient(() => ({ data: null, error: null }));
  retrieveCharge.mockReset();
  claim.mockResolvedValue({ status: "new", claimToken: "synthetic-token" });
  complete.mockResolvedValue(undefined); release.mockResolvedValue(undefined); monthly.mockResolvedValue(true); exact.mockResolvedValue(false);
  jest.spyOn(console, "log").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks()); afterAll(() => { process.env = previous; });
async function deliver(object: Record<string, unknown>, type = "checkout.session.completed", signingSecret = secret) {
  const payload = JSON.stringify({ id: "evt_synthetic", object: "event", type, created:1789920000, api_version: "2025-09-30.clover", livemode: false, data: { object } });
  const signature = verifier.webhooks.generateTestHeaderString({ payload, secret: signingSecret });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request("https://example.invalid/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature } }) as never);
}
test.each([
  ["checkout.session.completed", { object: "checkout.session", id: "cs_test", customer: "cus_test", metadata }],
  ["payment_intent.succeeded", { object: "payment_intent", id: "pi_test", metadata }],
  ["invoice.created", { object: "invoice", id: "in_test", parent: { subscription_details: { metadata } } }],
  ["charge.dispute.created", { object: "dispute", id: "dp_test", charge: { id: "ch_test", metadata } }],
] as const)("signed %s from the unfinished buyer protocol releases its claim before any accounting handoff", async (type, object) => {
  expect((await deliver(object, type)).status).toBe(500);
  expect(claim).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledWith("stripe:evt_synthetic", "synthetic-token");
  expect(complete).not.toHaveBeenCalled(); expect(monthly).not.toHaveBeenCalled(); expect(exact).not.toHaveBeenCalled();
  expect(db.ops).toEqual([]);
});
test("unmarked invoice for a persistently bound buyer Customer is also held", async () => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = "true";
  db = createMockClient(() => ({ data: { reservation_id: "synthetic-reservation" }, error: null }));
  expect((await deliver({ object: "invoice", id: "in_test", customer: "cus_test" }, "invoice.payment_succeeded")).status).toBe(500);
  expect(db.ops).toHaveLength(1); expect(db.ops[0].table).toBe("buyer_mentorship_customer_operations_v1");
  expect(db.ops[0].kind).toBe("select"); expect(monthly).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});
test("ownership lookup failure cannot silently choose legacy accounting", async () => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = "true";
  db = createMockClient(() => ({ data: null, error: { message: "unavailable" } }));
  expect((await deliver({ object: "invoice", customer: "cus_test" }, "invoice.created")).status).toBe(500);
  expect(monthly).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});
test.each(["true", "false"])("unowned events retain existing routing with schema flag %s", async ready => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = ready;
  expect((await deliver({ object: "invoice", customer: "cus_other" }, "invoice.created")).status).toBe(200);
  expect(monthly).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
});
test("forged metadata is rejected by the signature verifier before the claim or lookup", async () => {
  expect((await deliver({ object: "checkout.session", metadata }, "checkout.session.completed", "wrong-secret")).status).toBe(400);
  expect(claim).not.toHaveBeenCalled(); expect(db.ops).toEqual([]);
});

const buyerId="10000000-0000-4000-8000-000000000001",requestId="10000000-0000-4000-8000-000000000002",
  reservationId="10000000-0000-4000-8000-000000000003";
function enableFirstReceipt() {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_FIRST_WEBHOOK_READY="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY="true";
  recordBuyer.mockReset();recordBuyer.mockResolvedValue({recorded:true});
  db=createMockClient(op=>({error:null,data:op.table==="buyer_mentorship_customer_operations_v1"?
    {reservation_id:reservationId,bound_at:"2026-09-20T18:00:00Z"}:
    {id:reservationId,buyer_id:buyerId,request_id:requestId,context:{mode:"test"},status:"reserved"}}));
}

function enableLaterReceipt() {
  enableFirstReceipt();
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_LATER_WEBHOOK_READY="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY="true";
  recordLater.mockReset();recordLater.mockResolvedValue({status:"credited"});
  db=createMockClient(op=>({error:null,data:op.table==="buyer_mentorship_customer_operations_v1"?
    {reservation_id:reservationId,bound_at:"2026-09-20T18:00:00Z"}:op.table==="buyer_mentorship_payment_admissions_v1"?
    {reservation_id:reservationId,invoice_id:"in_later",payment_intent_id:"pi_later",payment_number:2}:
    {id:reservationId,buyer_id:buyerId,request_id:requestId,context:{mode:"test"},status:"reserved"}}));
}

function enableRefund() {
  enableFirstReceipt();
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_SCHEMA_READY="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_EVENTS_READY="true";
  refundBuyer.mockReset();refundBuyer.mockResolvedValue({status:"refund_reconciled"});
}
const refundCharge={object:"charge",id:"ch_refund",customer:"cus_test",payment_intent:"pi_refund",livemode:false,amount_refunded:1000};
test.each(["charge.refunded","charge.updated"])("signed %s reconciles owned refunds before capture or legacy accounting",async type=>{
  enableRefund();
  expect((await deliver(refundCharge,type)).status).toBe(200);
  expect(refundBuyer).toHaveBeenCalledWith(expect.objectContaining({buyerId,requestId,eventId:"evt_synthetic",paymentIntentId:"pi_refund",chargeId:"ch_refund",customerId:"cus_test",livemode:false}));
  expect(recordBuyer).not.toHaveBeenCalled();expect(recordLater).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();expect(exact).not.toHaveBeenCalled();
  expect(claim.mock.invocationCallOrder[0]).toBeLessThan(refundBuyer.mock.invocationCallOrder[0]);
  expect(refundBuyer.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
});
test("unsettled refund releases the original signed claim for reconciliation",async()=>{
  enableRefund();refundBuyer.mockResolvedValue({status:"reconciliation_required"});
  expect((await deliver(refundCharge,"charge.refunded")).status).toBe(500);
  expect(release).toHaveBeenCalledTimes(1);expect(complete).not.toHaveBeenCalled();expect(recordBuyer).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();
});
test("forged refund never reaches ownership or accounting",async()=>{
  enableRefund();
  expect((await deliver(refundCharge,"charge.refunded","wrong-secret")).status).toBe(400);
  expect(claim).not.toHaveBeenCalled();expect(refundBuyer).not.toHaveBeenCalled();expect(db.ops).toEqual([]);
});
test.each(["invoice.paid","invoice.payment_succeeded","payment_intent.succeeded","charge.succeeded","charge.updated"])("signed later %s resolves original admission before first/legacy accounting",async type=>{
  enableLaterReceipt();const object=type.startsWith("invoice.")?{object:"invoice",id:"in_later"}:
    type.startsWith("payment_intent.")?{object:"payment_intent",id:"pi_later"}:{object:"charge",id:"ch_later",payment_intent:"pi_later"};
  expect((await deliver({...object,customer:"cus_test",livemode:false},type)).status).toBe(200);
  expect(recordLater).toHaveBeenCalledWith(expect.objectContaining({buyerId,requestId,invoiceId:"in_later",expectedEvent:{object:object.object,id:object.id,customerId:"cus_test",livemode:false}}));
  expect(recordBuyer).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();expect(exact).not.toHaveBeenCalled();
  expect(claim.mock.invocationCallOrder[0]).toBeLessThan(recordLater.mock.invocationCallOrder[0]);
  expect(recordLater.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
});
test("unsettled later capture retries its event without first-payment or legacy credit",async()=>{
  enableLaterReceipt();recordLater.mockResolvedValue({status:"reconciliation_required"});
  expect((await deliver({object:"invoice",id:"in_later",customer:"cus_test",livemode:false},"invoice.paid")).status).toBe(500);
  expect(complete).not.toHaveBeenCalled();expect(recordBuyer).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});
test("signed handler completes only after enabled activation succeeds",async()=>{
  enableFirstReceipt();process.env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY="true";
  activateBuyer.mockResolvedValue({status:"activated_held"});
  expect((await deliver({object:"charge",id:"ch_owned",customer:"cus_owned",livemode:false},"charge.updated")).status).toBe(200);
  expect(activateBuyer).toHaveBeenCalledWith(expect.objectContaining({buyerId,requestId}));
  expect(activateBuyer.mock.invocationCallOrder[0]).toBeGreaterThan(recordBuyer.mock.invocationCallOrder[0]);
  expect(complete.mock.invocationCallOrder[0]).toBeGreaterThan(activateBuyer.mock.invocationCallOrder[0]);
});
test.each(["busy","review_required"])("signed activation %s retains retry rather than marking the event complete",async status=>{
  enableFirstReceipt();process.env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY="true";activateBuyer.mockResolvedValue({status});
  expect((await deliver({object:"charge",id:"ch_owned",customer:"cus_owned",livemode:false},"charge.updated")).status).toBe(500);
  expect(recordBuyer).toHaveBeenCalledTimes(1);expect(complete).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});
test.each([["checkout.session.completed","checkout.session","cs_owned"],["payment_intent.succeeded","payment_intent","pi_owned"],
  ["charge.succeeded","charge","ch_owned"],["charge.updated","charge","ch_owned"]])("signed %s reaches only owned receipt accounting",async(type,object,id)=>{
  enableFirstReceipt();
  expect((await deliver({object,id,customer:"cus_owned",livemode:false,metadata:{...metadata,buyer_id:"forged"}},type)).status).toBe(200);
  expect(recordBuyer).toHaveBeenCalledWith(expect.objectContaining({buyerId,requestId,
    expectedEvent:{reservationId,customerId:"cus_owned",livemode:false,object,id}}));
  expect(db.ops[0].filters).toEqual({customer_id:"cus_owned"});expect(db.ops[1].filters).toEqual({id:reservationId});
  expect(complete).toHaveBeenCalledTimes(1);expect(release).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();expect(exact).not.toHaveBeenCalled();
  expect(complete.mock.invocationCallOrder[0]).toBeGreaterThan(recordBuyer.mock.invocationCallOrder[0]);
});
test("incomplete capture releases the signed claim for original-operation retry",async()=>{
  enableFirstReceipt();recordBuyer.mockRejectedValue(Error("asynchronous balance unavailable"));
  expect((await deliver({object:"charge",id:"ch_owned",customer:"cus_owned",livemode:false},"charge.updated")).status).toBe(500);
  expect(release).toHaveBeenCalledTimes(1);expect(complete).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();
});
test("new first-receipt gate does not acknowledge unsupported lifecycle processing",async()=>{
  enableFirstReceipt();
  expect((await deliver({object:"invoice",id:"in_owned",customer:"cus_owned",livemode:false},"invoice.payment_failed")).status).toBe(500);
  expect(recordBuyer).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});
test.each(["missing reservation","unbound customer","wrong mode","database failure"])("%s prevents signed first-event accounting",async issue=>{
  enableFirstReceipt();db=createMockClient(op=>{
    if(issue==="database failure")return {data:null,error:{message:"unavailable"}};
    if(op.table==="buyer_mentorship_customer_operations_v1")return {error:null,data:{reservation_id:reservationId,bound_at:issue==="unbound customer"?null:"2026-09-20"}};
    return {error:null,data:issue==="missing reservation"?null:{id:reservationId,buyer_id:buyerId,request_id:requestId,
      context:{mode:issue==="wrong mode"?"live":"test"},status:"reserved"}};
  });
  expect((await deliver({object:"charge",id:"ch_owned",customer:"cus_owned",livemode:false},"charge.updated")).status).toBe(500);
  expect(recordBuyer).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});

test.each(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"])("unexpanded %s resolves the charge before routing", async type => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = "true";
  retrieveCharge.mockResolvedValue({ object: "charge", id: "ch_test", livemode: false, customer: "cus_owned", metadata: {} });
  db = createMockClient(() => ({ data: { reservation_id: "owned" }, error: null }));
  expect((await deliver({ object: "dispute", id: "dp_test", charge: "ch_test" }, type)).status).toBe(500);
  expect(retrieveCharge).toHaveBeenCalledWith("ch_test", { expand: ["payment_intent"] });
  expect(monthly).not.toHaveBeenCalled(); expect(exact).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

test("dispute resolves protocol metadata on the charge's PaymentIntent", async () => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = "true";
  retrieveCharge.mockResolvedValue({ object: "charge", id: "ch_test", livemode: false, customer: null,
    payment_intent: { object: "payment_intent", id: "pi_test", livemode: false, metadata } });
  expect((await deliver({ object: "dispute", charge: "ch_test", payment_intent: "pi_test" }, "charge.dispute.closed")).status).toBe(500);
  expect(db.ops).toEqual([]); expect(monthly).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
});

test.each(["provider failure", "wrong charge", "wrong mode", "wrong intent", "wrong intent mode", "missing charge"])("dispute uncertainty releases original claim: %s", async issue => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = "true";
  retrieveCharge.mockResolvedValue({ object: "charge", id: issue === "wrong charge" ? "ch_other" : "ch_test",
    livemode: issue === "wrong mode", customer: "cus_other", payment_intent: { object: "payment_intent",
      id: issue === "wrong intent" ? "pi_other" : "pi_test", livemode: issue === "wrong intent mode" } });
  if (issue === "provider failure") retrieveCharge.mockRejectedValue(Error("unavailable"));
  expect((await deliver({ object: "dispute", charge: issue === "missing charge" ? null : "ch_test",
    payment_intent: "pi_test" }, "charge.dispute.created")).status).toBe(500);
  expect(monthly).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});

test("verified nonbuyer dispute preserves existing routing", async () => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = "true";
  retrieveCharge.mockResolvedValue({ object: "charge", id: "ch_test", livemode: false, customer: "cus_other", payment_intent: null });
  expect((await deliver({ object: "dispute", charge: "ch_test" }, "charge.dispute.created")).status).toBe(200);
  expect(db.ops).toHaveLength(1); expect(monthly).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1);
});

test("forged unexpanded dispute cannot trigger provider lookup", async () => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = "true";
  expect((await deliver({ object: "dispute", charge: "ch_test" }, "charge.dispute.created", "wrong-secret")).status).toBe(400);
  expect(retrieveCharge).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
});

test("expanded related customer binding is checked without inherited metadata", async () => {
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY = "true";
  db = createMockClient(() => ({ data: { reservation_id: "owned" }, error: null }));
  expect((await deliver({ object: "invoice", payment_intent: { id: "pi_test", customer: "cus_owned" } }, "invoice.payment_succeeded")).status).toBe(500);
  expect(monthly).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
});

function enableRecordedRefund(later=false,problem="") {
  enableRefund();
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY="true";
  if(later){process.env.CREATOR_MENTORSHIP_INSTALLMENT_LATER_WEBHOOK_READY="true";process.env.CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY="true";}
  if(problem.startsWith("dispute")) {
    process.env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY="true";
    process.env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY="true";
    disputeBuyer.mockReset();disputeBuyer.mockResolvedValue({status:problem==="dispute unsettled"?"reconciliation_required":"dispute_observed"});
  }
  const proof={reservationId,customerId:"cus_test",checkoutSessionId:"cs_owned",paymentIntentId:"pi_owned",chargeId:"ch_owned",invoiceId:later?"in_owned":undefined,amountCents:3333};
  db=createMockClient(op=>{
    if(op.table==="buyer_mentorship_customer_operations_v1")return {error:null,data:{reservation_id:reservationId,bound_at:"2026-09-20"}};
    if(op.table==="buyer_mentorship_installment_reservations_v1")return {error:null,data:{id:reservationId,buyer_id:buyerId,request_id:requestId,context:{mode:"test"},status:"reserved"}};
    if(op.table==="buyer_mentorship_payment_admissions_v1")return {error:null,data:later?{reservation_id:reservationId,invoice_id:"in_owned",payment_intent_id:"pi_owned",payment_number:2}:null};
    if(op.table==="buyer_mentorship_first_receipts_v1" || op.table==="buyer_mentorship_later_receipts_v1")return {error:null,data:{reservation_id:reservationId,proof:{...proof,...(problem==="foreign receipt"?{chargeId:"ch_other"}: {})}}};
    if(op.table==="buyer_mentorship_dispute_events_v1")return {error:null,data:[{event_id:"evt_originaldispute",reservation_id:reservationId,
      payment_intent_id:"pi_owned",charge_id:problem==="dispute foreign"?"ch_other":"ch_owned",dispute_id:"du_owned",details:problem==="dispute pending"?null:{eventCreated:1789910000}}]};
    if(op.table==="buyer_mentorship_refund_events_v1")return {error:problem==="lookup failure"?{message:"unavailable"}:null,data:problem==="no refund" || problem.startsWith("dispute")?null:
      {reservation_id:reservationId,payment_intent_id:"pi_owned",charge_id:problem==="foreign refund"?"ch_other":"ch_owned",gross_cents:3333}};
    return {error:null,data:null};
  });
  if(problem==="unsettled")refundBuyer.mockResolvedValue({status:"reconciliation_required"});
}
const delayedEvents=[
  ["checkout.session.completed","checkout.session","cs_owned",false],
  ["payment_intent.succeeded","payment_intent","pi_owned",false],
  ["charge.succeeded","charge","ch_owned",false],
  ["charge.updated","charge","ch_owned",false],
  ["invoice.paid","invoice","in_owned",true],
  ["invoice.payment_succeeded","invoice","in_owned",true],
  ["payment_intent.succeeded","payment_intent","pi_owned",true],
  ["charge.succeeded","charge","ch_owned",true],
  ["charge.updated","charge","ch_owned",true],
] as const;
test.each(delayedEvents)("delayed %s (%s %s later=%s) reconciles current refund without credit or activation",async(type,object,id,later)=>{
  enableRecordedRefund(later);
  expect((await deliver({object,id,customer:"cus_test",livemode:false,payment_intent:"pi_owned",amount_refunded:0},type)).status).toBe(200);
  expect(refundBuyer).toHaveBeenCalledWith(expect.objectContaining({buyerId,requestId,eventId:"evt_synthetic",paymentIntentId:"pi_owned",chargeId:"ch_owned"}));
  expect(recordBuyer).not.toHaveBeenCalled();expect(recordLater).not.toHaveBeenCalled();expect(activateBuyer).not.toHaveBeenCalled();
  expect(monthly).not.toHaveBeenCalled();expect(exact).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
  expect(complete.mock.invocationCallOrder[0]).toBeGreaterThan(refundBuyer.mock.invocationCallOrder[0]);
});
test.each(["foreign receipt","foreign refund","lookup failure","unsettled"])("delayed success with %s remains retryable without activation",async problem=>{
  enableRecordedRefund(false,problem);
  expect((await deliver({object:"charge",id:"ch_owned",customer:"cus_test",livemode:false,amount_refunded:0},"charge.updated")).status).toBe(500);
  expect(recordBuyer).not.toHaveBeenCalled();expect(activateBuyer).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});
test("receipt without a refund observation retains ordinary first accounting and activation",async()=>{
  enableRecordedRefund(false,"no refund");activateBuyer.mockResolvedValue({status:"activated_held"});
  expect((await deliver({object:"charge",id:"ch_owned",customer:"cus_test",livemode:false,amount_refunded:0},"charge.updated")).status).toBe(200);
  expect(refundBuyer).not.toHaveBeenCalled();expect(recordBuyer).toHaveBeenCalledTimes(1);expect(activateBuyer).toHaveBeenCalledTimes(1);
});

function enableDisputes() {
  enableFirstReceipt();
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY="true";
  disputeBuyer.mockReset();disputeBuyer.mockResolvedValue({status:"dispute_observed"});
  retrieveCharge.mockResolvedValue({object:"charge",id:"ch_owned",customer:"cus_test",payment_intent:"pi_owned",livemode:false});
}
test.each(["charge.dispute.created","charge.dispute.updated","charge.dispute.closed"])("signed %s routes owned dispute to current-provider audit",async type=>{
  enableDisputes();
  expect((await deliver({object:"dispute",id:"du_owned",charge:"ch_owned",payment_intent:"pi_owned",livemode:false},type)).status).toBe(200);
  expect(disputeBuyer).toHaveBeenCalledWith(expect.objectContaining({buyerId,requestId,disputeId:"du_owned",paymentIntentId:"pi_owned",chargeId:"ch_owned",customerId:"cus_test"}));
  expect(recordBuyer).not.toHaveBeenCalled();expect(refundBuyer).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();
  expect(complete.mock.invocationCallOrder[0]).toBeGreaterThan(disputeBuyer.mock.invocationCallOrder[0]);
});
test("unsettled owned dispute releases original claim without acknowledgement",async()=>{
  enableDisputes();disputeBuyer.mockResolvedValue({status:"reconciliation_required"});
  expect((await deliver({object:"dispute",id:"du_owned",charge:"ch_owned",livemode:false},"charge.dispute.updated")).status).toBe(500);
  expect(complete).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});
test("forged dispute cannot invoke enabled dispute processing",async()=>{
  enableDisputes();
  expect((await deliver({object:"dispute",id:"du_owned",charge:"ch_owned",livemode:false},"charge.dispute.created","wrong-secret")).status).toBe(400);
  expect(disputeBuyer).not.toHaveBeenCalled();expect(retrieveCharge).not.toHaveBeenCalled();expect(claim).not.toHaveBeenCalled();
});

test.each(delayedEvents)("delayed %s (%s %s later=%s) respects current dispute without reactivation",async(type,object,id,later)=>{
  enableRecordedRefund(later,"dispute");
  expect((await deliver({object,id,customer:"cus_test",livemode:false,payment_intent:"pi_owned",amount_refunded:0},type)).status).toBe(200);
  expect(disputeBuyer).toHaveBeenCalledWith(expect.objectContaining({eventId:"evt_originaldispute",eventCreated:1789910000,disputeId:"du_owned"}));
  expect(recordBuyer).not.toHaveBeenCalled();expect(recordLater).not.toHaveBeenCalled();expect(activateBuyer).not.toHaveBeenCalled();
  expect(refundBuyer).not.toHaveBeenCalled();expect(complete.mock.invocationCallOrder[0]).toBeGreaterThan(disputeBuyer.mock.invocationCallOrder[0]);
});
test.each(["dispute unsettled","dispute foreign","dispute pending"])("delayed success with %s cannot be acknowledged",async problem=>{
  enableRecordedRefund(false,problem);
  expect((await deliver({object:"charge",id:"ch_owned",customer:"cus_test",livemode:false},"charge.updated")).status).toBe(500);
  expect(recordBuyer).not.toHaveBeenCalled();expect(activateBuyer).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});

test.each(["invoice.payment_failed","invoice.payment_action_required","payment_intent.payment_failed","payment_intent.requires_action"])("signed %s records recovery of the original admission",async type=>{
  enableLaterReceipt();process.env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY="true";process.env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY="true";
  recoverBuyer.mockReset();recoverBuyer.mockResolvedValue({status:"payment_recovery_recorded",outcome:"action_required"});
  const object=type.startsWith("invoice.")?"invoice":"payment_intent",id=object==="invoice"?"in_later":"pi_later";
  expect((await deliver({object,id,customer:"cus_test",livemode:false},type)).status).toBe(200);
  expect(recoverBuyer).toHaveBeenCalledWith(expect.objectContaining({buyerId,requestId,invoiceId:"in_later",eventId:"evt_synthetic",expectedEvent:{object,id,customerId:"cus_test",livemode:false}}));
  expect(recordLater).not.toHaveBeenCalled();expect(recordBuyer).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();
  expect(complete.mock.invocationCallOrder[0]).toBeGreaterThan(recoverBuyer.mock.invocationCallOrder[0]);
});
test("unresolved original payment failure releases its signed claim",async()=>{
  enableLaterReceipt();process.env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY="true";process.env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY="true";
  recoverBuyer.mockResolvedValue({status:"reconciliation_required"});
  expect((await deliver({object:"invoice",id:"in_later",customer:"cus_test",livemode:false},"invoice.payment_failed")).status).toBe(500);
  expect(complete).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
});

test.each(["invoice.payment_failed","payment_intent.requires_action"])("late %s after refund cannot revive an unpaid recovery action",async type=>{
  enableRecordedRefund(true);
  const object=type.startsWith("invoice.")?"invoice":"payment_intent",id=object==="invoice"?"in_owned":"pi_owned";
  expect((await deliver({object,id,customer:"cus_test",livemode:false},type)).status).toBe(200);
  expect(refundBuyer).toHaveBeenCalledTimes(1);expect(recoverBuyer).not.toHaveBeenCalled();expect(recordLater).not.toHaveBeenCalled();
});


test.each(["collection_resumed","not_requested","review_required"])("signed paid event retains receipt and handles future release %s",async future=>{
  enableLaterReceipt();process.env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY="true";
  resumeFuture.mockResolvedValue(future);
  const response=await deliver({object:"invoice",id:"in_later",customer:"cus_test",livemode:false},"invoice.paid");
  expect(response.status).toBe(future==="review_required"?500:200);
  expect(recordLater).toHaveBeenCalledTimes(1);
  expect(resumeFuture).toHaveBeenCalledWith(expect.objectContaining({buyerId,requestId,invoiceId:"in_later"}));
  expect(resumeFuture.mock.invocationCallOrder[0]).toBeGreaterThan(recordLater.mock.invocationCallOrder[0]);
  if(future==="review_required"){expect(complete).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);}
  else expect(complete).toHaveBeenCalledTimes(1);
  expect(recordBuyer).not.toHaveBeenCalled();expect(monthly).not.toHaveBeenCalled();
});
