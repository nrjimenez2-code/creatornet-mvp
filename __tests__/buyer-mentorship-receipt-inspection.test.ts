import { buyerFirstCaptureFixture,buyerManualFirstCaptureFixture } from "../test-support/buyer-mentorship-receipt-fixture";
import {SERVER_PAYMENT_PROTOCOL} from "../lib/serverPaymentConfirmation";
const mockManualObserve=jest.fn();
const mockManualStop=jest.fn();
const mockObserve = jest.fn(), mockReservation = jest.fn(), mockFrom = jest.fn(), mockRpc = jest.fn();
const mockSession = jest.fn(), mockIntent = jest.fn(), mockCharge = jest.fn(), mockBalance = jest.fn(), mockCard = jest.fn(), mockCustomer = jest.fn(), mockSubscription = jest.fn();
const mockExpire=jest.fn(),mockCancel=jest.fn(),mockSubscriptions=jest.fn(),mockInvoices=jest.fn(),mockInvoiceItems=jest.fn(),mockInvoicePayments=jest.fn();
jest.mock("stripe", () => ({ __esModule: true, default: function () { return {
  checkout: { sessions: { retrieve: mockSession,expire:mockExpire } }, paymentIntents: { retrieve: mockIntent }, charges: { retrieve: mockCharge },
  balanceTransactions: { retrieve: mockBalance }, paymentMethods: { retrieve: mockCard }, customers: { retrieve: mockCustomer },
  subscriptions: { retrieve: mockSubscription,list:mockSubscriptions,cancel:mockCancel },
  invoices:{list:mockInvoices},invoiceItems:{list:mockInvoiceItems},invoicePayments:{list:mockInvoicePayments},
}; } }));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: mockFrom, rpc:mockRpc }) }));
jest.mock("@/lib/installments/contextServer", () => ({ exactContextServerConfig: () => config }));
jest.mock("@/lib/installments/contextRuntime", () => ({ createExactContextRuntime: () => ({ observeContext: mockObserve }) }));
jest.mock("@/lib/mentorshipInstallmentReservation", () => ({ readBuyerMentorshipBootstrapReservation: (...a: unknown[]) => mockReservation(...a) }));
jest.mock("@/lib/mentorshipServerPayment",()=>({confirmBuyerMentorshipServerPayment:(...a:unknown[])=>mockManualObserve(...a),
  stopBuyerMentorshipServerPayment:(...a:unknown[])=>mockManualStop(...a)}));
import { inspectBuyerMentorshipFirstPayment,inspectBuyerMentorshipFirstCapture } from "@/lib/mentorshipInstallmentReceipt";
import {buyerMentorshipActivationParams} from "../lib/mentorshipInstallmentActivation";
let activation:any,receipt:any,abandonmentHold:any,manualPin:any;
let fixture: ReturnType<typeof buyerFirstCaptureFixture>, config: Record<string, unknown>, bootstrap: any, operations: any[];
const queries: { table: string; column: string; value: unknown }[] = [];
const env = { CREATOR_MENTORSHIP_INSTALLMENT_BOOTSTRAP_SCHEMA_READY: "true", CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_INSPECTION_READY: "true" };
const args = () => ({ buyerId: fixture.reservation.buyerId, requestId: fixture.reservation.requestId, env });
beforeEach(() => {
  jest.resetAllMocks(); activation=null;receipt=null;abandonmentHold=null;manualPin=null;fixture = buyerFirstCaptureFixture(); jest.useFakeTimers({ now: fixture.nowSeconds * 1000 }); queries.length = 0;
  config = { approvedContext: fixture.context, configuredSupabaseUrl: fixture.contextEvidence.configuredSupabaseUrl,
    stripeSecretKey: "sk_test_synthetic", supabaseServiceKey: "synthetic" };
  mockObserve.mockResolvedValue({ contextEvidence: fixture.contextEvidence }); mockReservation.mockResolvedValue(fixture.reservation);
  bootstrap = { reservation_id: fixture.reservation.id, customer_id: fixture.customer.id, anchor_seconds: fixture.dependencies.anchorSeconds };
  operations = ["product.create", "subscription.create", "subscription.hold", "checkout.create"].map((step, index) => ({
    reservation_id: fixture.reservation.id, step, result_id: ["prod_owned", "sub_owned", "sub_owned", "cs_test_owned"][index],
    bound_at: new Date().toISOString(),lease_until:null, first_dispatch_at: fixture.firstDispatchAt, request: step === "checkout.create" ? fixture.originalRequest : {},
  }));
  mockFrom.mockImplementation(table => {
    const result = () => Promise.resolve({ error: null, data: table === "buyer_mentorship_bootstraps_v1" ? bootstrap :
      table==="server_payment_protocols_v1"?manualPin:table==="buyer_mentorship_abandonment_holds_v1"?abandonmentHold:table==="buyer_mentorship_activation_operations_v1"?activation:table==="buyer_mentorship_first_receipts_v1"?receipt:operations });
    const query = { select: jest.fn(), eq: jest.fn(), single:result,maybeSingle: result, then: (resolve: any, reject: any) => result().then(resolve, reject) };
    query.select.mockReturnValue(query); query.eq.mockImplementation((column, value) => { queries.push({ table, column, value }); return query; });
    return query;
  });
  for (const [mock, value] of [[mockSession, fixture.data.session], [mockIntent, fixture.data.paymentIntent], [mockCharge, fixture.data.charge],
    [mockBalance, fixture.data.balance], [mockCard, fixture.data.paymentMethod], [mockCustomer, fixture.data.customer], [mockSubscription, fixture.data.subscription]] as const) {
    mock.mockResolvedValue(value);
  }
});
afterEach(() => jest.useRealTimers());

function manualCapture(){
  const m=buyerManualFirstCaptureFixture();operations=operations.filter(o=>o.step!=="checkout.create");
  manualPin={attempt_id:fixture.reservation.attemptId,buyer_id:fixture.reservation.buyerId,reservation_id:fixture.reservation.id,
    kind:"first_installment",protocol:SERVER_PAYMENT_PROTOCOL,context:fixture.context};
  const op={bound_at:new Date().toISOString(),first_dispatch_at:fixture.firstDispatchAt,contract:m.manual.contract,payment_intent_id:"pi_owned"};
  const phase={attempt_id:fixture.reservation.attemptId,payment_intent_id:"pi_owned",operation_id:m.manual.confirmationOperationId,
    latest_observation:{status:"succeeded",paymentIntentId:"pi_owned",chargeId:"ch_owned",paymentMethodId:"pm_owned"}};
  mockRpc.mockImplementation(async name=>({data:name==="read_server_payment_intent_v1"?op:phase,error:null}));
  mockManualObserve.mockResolvedValue({status:"observed",observation:phase.latest_observation});mockIntent.mockResolvedValue(m.data.paymentIntent);
  return {m,op,phase,args:{...args(),env:{...env,CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY:"true",
    CREATOR_SERVER_PAYMENT_RECEIPT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_RECEIPT_INSPECTION_READY:"true"}}};
}
test("manual source is observed and independently inspected without retrieving or creating a hosted session",async()=>{
  const a=manualCapture();const proof=await inspectBuyerMentorshipFirstPayment(a.args);
  expect(proof).toMatchObject({checkoutSessionId:null,paymentIntentId:"pi_owned",manualPayment:{attemptId:fixture.reservation.attemptId,
    confirmationOperationId:a.m.manual.confirmationOperationId}});
  expect(mockSession).not.toHaveBeenCalled();expect(mockManualObserve).toHaveBeenCalledWith(expect.objectContaining({action:{kind:"observe"}}));
  expect(mockIntent).toHaveBeenCalledWith("pi_owned");expect(mockCharge).toHaveBeenCalledWith("ch_owned");
});
test.each(["unbound","unobserved","foreign phase","unknown hosted","wrong contract","missing gate"])
("manual inspection rejects %s",async issue=>{
  const a=manualCapture();
  if(issue==="unbound")a.op.bound_at=null as any;
  if(issue==="unobserved")a.phase.latest_observation.status="requires_action";
  if(issue==="foreign phase")a.phase.payment_intent_id="pi_other";
  if(issue==="unknown hosted")operations.push({step:"checkout.create",result_id:null});
  if(issue==="wrong contract")a.op.contract={...a.op.contract,amountCents:9999};
  if(issue==="missing gate")a.args.env.CREATOR_SERVER_PAYMENT_RECEIPT_SCHEMA_READY="false";
  await expect(inspectBuyerMentorshipFirstPayment(a.args)).rejects.toThrow("requires review");expect(mockSession).not.toHaveBeenCalled();
});

function activatedCapture() {
  const proof=inspectBuyerMentorshipFirstCapture(fixture),params=buyerMentorshipActivationParams(proof.paidAt,fixture.reservation.terms.paymentCount,proof.paymentMethodId);
  activation={reservation_id:proof.reservationId,item_id:"si_owned",request:{apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/subscriptions/sub_owned",params}};
  receipt={reservation_id:proof.reservationId,proof};
  Object.assign(fixture.data.subscription,{...params,billing_cycle_anchor:params.trial_end,metadata:{...fixture.data.subscription.metadata,...params.metadata}});
  return {proof,args:{...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_SCHEMA_READY:"true"}}};
}
test("late first-event inspection after original activation returns the same receipt",async()=>{
  const a=activatedCapture();expect(await inspectBuyerMentorshipFirstPayment(a.args)).toEqual(a.proof);
});
test.each(["missing operation","changed original request","different receipt","missing receipt","different item"])("activated %s cannot be adopted",async issue=>{
  const a=activatedCapture();
  if(issue==="missing operation")activation=null;
  if(issue==="changed original request")activation.request.params.default_payment_method="pm_other";
  if(issue==="different receipt")receipt.proof={...a.proof,amountCents:1};
  if(issue==="missing receipt")receipt=null;
  if(issue==="different item")activation.item_id="si_other";
  await expect(inspectBuyerMentorshipFirstPayment(a.args)).rejects.toThrow("requires review");
});

test("uses owned durable IDs and provider relationships, then reobserves context before returning evidence", async () => {
  const proof = await inspectBuyerMentorshipFirstPayment(args());
  expect(proof.paymentIntentId).toBe("pi_owned"); expect(proof.amountCents).toBe(3333);
  expect(queries).toEqual([
    { table: "buyer_mentorship_bootstraps_v1", column: "reservation_id", value: fixture.reservation.id },
    { table: "buyer_mentorship_bootstrap_operations_v1", column: "reservation_id", value: fixture.reservation.id },
  ]);
  expect(mockSession).toHaveBeenCalledWith("cs_test_owned"); expect(mockIntent).toHaveBeenCalledWith("pi_owned");
  expect(mockCharge).toHaveBeenCalledWith("ch_owned"); expect(mockBalance).toHaveBeenCalledWith("txn_owned");
  expect(mockCard).toHaveBeenCalledWith("pm_owned"); expect(mockObserve).toHaveBeenCalledTimes(2);
  expect(mockObserve.mock.invocationCallOrder[1]).toBeGreaterThan(mockSubscription.mock.invocationCallOrder[0]);
});
test("a missing owned reservation prevents provider work", async () => {
  mockReservation.mockResolvedValue(null); await expect(inspectBuyerMentorshipFirstPayment(args())).rejects.toThrow();
  expect(mockFrom).not.toHaveBeenCalled(); expect(mockSession).not.toHaveBeenCalled();
});
test.each(["unbound", "wrong hold", "duplicate step", "foreign reservation", "incomplete chain"])("durable %s fails before provider work", issue => {
  if (issue === "unbound") operations[3].bound_at = null;
  if (issue === "wrong hold") operations[2].result_id = "sub_other";
  if (issue === "duplicate step") operations[1].step = operations[0].step;
  if (issue === "foreign reservation") operations[3].reservation_id = "10000000-0000-4000-8000-000000000099";
  if (issue === "incomplete chain") operations.pop();
  return expect(inspectBuyerMentorshipFirstPayment(args())).rejects.toThrow().then(() => expect(mockSession).not.toHaveBeenCalled());
});
test("unavailable asynchronous balance transaction requires retry, without another charge", async () => {
  fixture.data.charge.balance_transaction = null;
  await expect(inspectBuyerMentorshipFirstPayment(args())).rejects.toThrow("requires review");
  expect(mockCharge).toHaveBeenCalledTimes(1); expect(mockBalance).not.toHaveBeenCalled();
});
test("provider failure exposes no raw details and performs no replacement operation", async () => {
  mockCharge.mockRejectedValue(Error("private provider details"));
  await expect(inspectBuyerMentorshipFirstPayment(args())).rejects.toThrow("Buyer installment first payment requires review");
  expect(mockCharge).toHaveBeenCalledTimes(1); expect(mockBalance).not.toHaveBeenCalled();
});
test("changed independent context after retrieval cannot produce a proof", async () => {
  mockObserve.mockResolvedValueOnce({ contextEvidence: fixture.contextEvidence })
    .mockResolvedValueOnce({ contextEvidence: { ...fixture.contextEvidence, observedPlatformAccountId: "acct_other" } });
  await expect(inspectBuyerMentorshipFirstPayment(args())).rejects.toThrow();
});
test("database lookup failure cannot fall back to event metadata", async () => {
  mockFrom.mockImplementation(() => { throw Error("database unavailable"); });
  await expect(inspectBuyerMentorshipFirstPayment(args())).rejects.toThrow(); expect(mockSession).not.toHaveBeenCalled();
});


// Uses the first-capture fixture and its durable bindings for read-only recovery.
import { observeBuyerMentorshipUnpaidCheckout, requestBuyerMentorshipAbandonment, releaseBuyerMentorshipUnpreparedSelection } from "@/lib/mentorshipInstallmentBootstrap";
function unpaidObservation(status = "open") {
  const p = fixture.originalRequest.params;
  const session = {...fixture.data.session, status, payment_status:"unpaid", payment_intent:null,
    allow_promotion_codes:false, invoice_creation:{enabled:false}, subscription:null, setup_intent:null,
    payment_link:null, recovered_from:null, success_url:p.success_url, cancel_url:p.cancel_url,
    payment_method_types:["card"], custom_text:p.custom_text, consent_collection:p.consent_collection};
  mockSession.mockResolvedValue(session);
  if (status === "expired") jest.setSystemTime((fixture.dependencies.anchorSeconds + 86401) * 1000);
  return {session, args:{...args(), env:{...env, CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_OBSERVATION_READY:"true"}}};
}
test.each(["open", "expired"])("observes original %s Checkout without releasing or accounting", async status => {
  const a = unpaidObservation(status);
  expect(await observeBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({
    status:status === "open" ? "open_unpaid" : "expired_without_payment_intent", releaseAllowed:false,
    requestId:fixture.reservation.requestId});
  expect(mockSession).toHaveBeenCalledTimes(2);
  expect(mockSession).toHaveBeenNthCalledWith(1, "cs_test_owned");
  expect(mockSession).toHaveBeenNthCalledWith(2, "cs_test_owned");
  for (const read of [mockIntent,mockCharge,mockBalance,mockCard,mockCustomer,mockSubscription]) expect(read).not.toHaveBeenCalled();
  expect(mockObserve).toHaveBeenCalledTimes(2);
});
test.each(["gate off", "unbound", "missing reservation", "context drift", "paid during read"])("unpaid observation fails closed: %s", async issue => {
  const a = unpaidObservation();
  if(issue === "gate off") a.args.env.CREATOR_MENTORSHIP_INSTALLMENT_CHECKOUT_OBSERVATION_READY = "false";
  if(issue === "unbound") operations[3].bound_at = null;
  if(issue === "missing reservation") mockReservation.mockResolvedValue(null);
  if(issue === "context drift") mockObserve.mockResolvedValueOnce({contextEvidence:fixture.contextEvidence})
    .mockResolvedValueOnce({contextEvidence:{...fixture.contextEvidence,observedPlatformAccountId:"acct_other"}});
  if(issue === "paid during read") mockSession.mockResolvedValueOnce(a.session)
    .mockResolvedValueOnce({...a.session,status:"complete",payment_status:"paid",payment_intent:"pi_owned"});
  await expect(observeBuyerMentorshipUnpaidCheckout(a.args)).rejects.toThrow("Buyer Checkout recovery requires review");
  if(["gate off","unbound","missing reservation"].includes(issue)) expect(mockSession).not.toHaveBeenCalled();
});


test.each(["canceled","processing","requires_action","succeeded","captured","wrong fee","wrong destination"])("original expired Checkout intent is independently checked: %s",async scenario=>{
  const a=unpaidObservation("expired");Object.assign(a.session,{payment_intent:"pi_owned"});
  const pi={...fixture.data.paymentIntent,status:"canceled",amount_received:0,amount_capturable:0};
  if(["processing","requires_action","succeeded"].includes(scenario))pi.status=scenario as typeof pi.status;
  if(scenario==="captured")pi.amount_received=3333;
  if(scenario==="wrong fee")pi.application_fee_amount=1;
  if(scenario==="wrong destination")pi.transfer_data={destination:"acct_other"};
  mockIntent.mockResolvedValue(pi);
  if(scenario.startsWith("wrong")) await expect(observeBuyerMentorshipUnpaidCheckout(a.args)).rejects.toThrow("requires review");
  else {
    expect(await observeBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({
      status:scenario==="canceled"?"expired_with_canceled_payment":"payment_reconciliation_required",releaseAllowed:false});
    expect(mockIntent).toHaveBeenCalledTimes(2);expect(mockIntent).toHaveBeenCalledWith("pi_owned");
  }
});


test.each(["saved","gate off","wrong owner","wrong binding","database failure"])("buyer abandonment intent: %s",async scenario=>{
  const a={...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_REQUEST_READY:"true"}};
  mockRpc.mockResolvedValue({error:null,data:{reservation_id:fixture.reservation.id,requested_at:new Date().toISOString()}});
  if(scenario==="gate off")a.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_REQUEST_READY="false";
  if(scenario==="wrong owner")mockReservation.mockResolvedValue(null);
  if(scenario==="wrong binding")mockRpc.mockResolvedValue({error:null,data:{reservation_id:"other",requested_at:new Date().toISOString()}});
  if(scenario==="database failure")mockRpc.mockResolvedValue({error:{message:"private"},data:null});
  if(scenario==="saved") {
    expect(await requestBuyerMentorshipAbandonment(a)).toEqual({status:"stop_requested",requestId:a.requestId,releaseAllowed:false});
    expect(mockRpc).toHaveBeenCalledWith("request_buyer_mentorship_abandonment_v1",{
      p_request_id:a.requestId,p_buyer_id:a.buyerId,p_context:fixture.context});
  } else await expect(requestBuyerMentorshipAbandonment(a)).rejects.toThrow("Buyer Checkout abandonment requires review");
  if(["gate off","wrong owner"].includes(scenario))expect(mockRpc).not.toHaveBeenCalled();
  expect(mockSession).not.toHaveBeenCalled();expect(mockSubscription).not.toHaveBeenCalled();expect(mockIntent).not.toHaveBeenCalled();
});


import {stopBuyerMentorshipUnpaidCheckout} from "@/lib/mentorshipInstallmentAbandonment";
function abandonmentExecutor(status="expired") {
  const a=unpaidObservation(status);
  abandonmentHold={reservation_id:fixture.reservation.id,requested_at:new Date().toISOString()};
  mockSubscriptions.mockImplementation(async()=>({has_more:false,data:[fixture.data.subscription]}));
  mockInvoices.mockResolvedValue({has_more:false,data:[]});mockInvoiceItems.mockResolvedValue({has_more:false,data:[]});
  mockExpire.mockImplementation(async()=>{a.session.status="expired";return a.session;});
  mockCancel.mockImplementation(async()=>{Object.assign(fixture.data.subscription,{status:"canceled",canceled_at:Math.floor(Date.now()/1000),ended_at:Math.floor(Date.now()/1000)});return fixture.data.subscription;});
  mockRpc.mockImplementation(async(_name,p)=>_name==="record_buyer_mentorship_abandonment_proof_v1"?{error:null,data:{reservation_id:fixture.reservation.id,proof:p.p_proof}}:({error:null,data:{status:"dispatch",dispatch_before:new Date(Date.now()+30000).toISOString(),operation:{
    reservation_id:fixture.reservation.id,step:p.p_step,lease_token:fixture.reservation.requestId,first_dispatch_at:new Date().toISOString(),
    idempotency_key:p.p_step==="checkout.expire"?`buyer-mentorship-installments-v1:${fixture.reservation.id}:expire-approved-stop-v1`:null,
    request:{apiVersion:"2025-10-29.clover",method:p.p_step==="checkout.expire"?"POST":"DELETE",
      path:p.p_step==="checkout.expire"?"/v1/checkout/sessions/cs_test_owned/expire":"/v1/subscriptions/sub_owned",
      params:p.p_step==="checkout.expire"?{}:{invoice_now:false,prorate:false}}}}}));
  return {...a,args:{...a.args,env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_SCHEMA_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_OPERATIONS_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_PROOF_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_EXECUTOR_READY:"true"}}};
}
test("buyer unpaid stop reuses original cancellation and returns only unreleased terminal observation",async()=>{
  const a=abandonmentExecutor();
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({status:"stopped_unreleased",releaseAllowed:false,
    proof:{subscriptionId:"sub_owned",sessionId:"cs_test_owned",checkoutStatus:"expired",firstPaymentIntentId:null}});
  expect(mockCancel).toHaveBeenCalledTimes(1);expect(mockCancel).toHaveBeenCalledWith("sub_owned",{invoice_now:false,prorate:false},{maxNetworkRetries:0});
  expect(mockExpire).not.toHaveBeenCalled();
});
test("public hosted abandonment records its original hold before provider cancellation",async()=>{
  const a=abandonmentExecutor(),read=mockRpc.getMockImplementation()!;abandonmentHold=null;
  mockRpc.mockImplementation((name,p)=>{
    if(name==="request_buyer_mentorship_abandonment_v1"){
      abandonmentHold={reservation_id:fixture.reservation.id,requested_at:new Date().toISOString()};
      return Promise.resolve({data:abandonmentHold,error:null});
    }
    return read(name,p);
  });
  expect(await stopBuyerMentorshipUnpaidCheckout({...a.args,requestStop:true,env:{...a.args.env,
    CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_REQUEST_READY:"true"}})).toMatchObject({status:"stopped_unreleased"});
  const hold=mockRpc.mock.calls.findIndex(([name])=>name==="request_buyer_mentorship_abandonment_v1");
  expect(hold).toBeGreaterThanOrEqual(0);expect(mockRpc.mock.invocationCallOrder[hold]).toBeLessThan(mockCancel.mock.invocationCallOrder[0]);
});

function partialAbandonment() {
  const a=abandonmentExecutor(),admitted=mockRpc.getMockImplementation()!;
  operations=operations.filter(op=>op.step!=="checkout.create");
  const partial={reservationId:fixture.reservation.id,bootstrap,product:operations[0],subscription:operations[1],hold:operations[2],customer:{}};
  mockRpc.mockImplementation((name,p)=>name==="read_buyer_mentorship_partial_stop_v1"?
    Promise.resolve({error:null,data:structuredClone(partial)}):admitted(name,p));
  Object.assign(fixture.data.customer,{default_source:null,invoice_settings:{default_payment_method:null},balance:0,test_clock:null});
  return {...a,partial,args:{...a.args,env:{...a.args.env,CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_SCHEMA_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_READY:"true"}}};
}
function manualAbandonment(){
  const a=partialAbandonment(),admitted=mockRpc.getMockImplementation()!;
  manualPin={attempt_id:fixture.reservation.attemptId,buyer_id:fixture.reservation.buyerId,product_id:fixture.reservation.productId,
    reservation_id:fixture.reservation.id,kind:"first_installment",protocol:SERVER_PAYMENT_PROTOCOL,context:fixture.context};
  const terminal={version:"server-payment-intent-terminal-v1",paymentIntentId:"pi_owned",status:"canceled",amountReceived:0,
    amountCapturable:0,canceledAt:fixture.nowSeconds,chargeIds:[],observedAt:fixture.nowSeconds};
  const released={reservation_id:fixture.reservation.id,request_id:fixture.reservation.requestId,released_at:new Date().toISOString()};
  mockManualStop.mockResolvedValue({status:"intent_canceled_unreleased",releaseAllowed:false,proof:terminal});
  mockRpc.mockImplementation((name,p)=>name==="read_buyer_mentorship_manual_release_v1"?Promise.resolve({data:null,error:null}):
    name==="read_buyer_mentorship_manual_stop_v1"?Promise.resolve({data:{preparation:structuredClone(a.partial),manualPayment:terminal},error:null}):
    name==="request_buyer_mentorship_abandonment_v1"?Promise.resolve({data:abandonmentHold,error:null}):
    name==="release_buyer_mentorship_abandonment_v1"?Promise.resolve({data:released,error:null}):admitted(name,p));
  return {...a,terminal,released,args:{...a.args,env:{...a.args.env,CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_REQUEST_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_READY:"true"}}};
}
test("manual stop checks original intent before and after existing subscription cancellation, then uses shared release",async()=>{
  const a=manualAbandonment();
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({status:"released",requestId:fixture.reservation.requestId});
  expect(mockManualStop).toHaveBeenCalledTimes(2);expect(mockCancel).toHaveBeenCalledTimes(1);
  expect(mockManualStop.mock.invocationCallOrder[0]).toBeLessThan(mockCancel.mock.invocationCallOrder[0]);
  expect(mockManualStop.mock.invocationCallOrder[1]).toBeGreaterThan(mockCancel.mock.invocationCallOrder[0]);
  expect(mockRpc).toHaveBeenCalledWith("release_buyer_mentorship_abandonment_v1",expect.objectContaining({p_proof:expect.objectContaining({
    version:"buyer-manual-payment-stop-v1",manualPayment:a.terminal,preparation:a.partial,sessionId:null})}));
  expect(mockSession).not.toHaveBeenCalled();expect(mockExpire).not.toHaveBeenCalled();
});
test.each(["busy","reconciliation_required","not_enabled"])("manual %s retains selection without subscription writes",async status=>{
  const a=manualAbandonment();mockManualStop.mockResolvedValue({status,releaseAllowed:false});
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toEqual({status:"reconciliation_required",releaseAllowed:false});
  expect(mockCancel).not.toHaveBeenCalled();expect(mockRpc.mock.calls.some(([n])=>n==="release_buyer_mentorship_abandonment_v1")).toBe(false);
});
test.each(["gate off","schema off","foreign pin","changed terminal","late capture","lost release response"])
("manual %s does not claim a release",async issue=>{
  const a=manualAbandonment();
  if(issue==="gate off")a.args.env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_READY="false";
  if(issue==="schema off")a.args.env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_SCHEMA_READY="false";
  if(issue==="foreign pin")manualPin.product_id=fixture.reservation.buyerId;
  if(issue==="changed terminal")mockManualStop.mockResolvedValueOnce({status:"intent_canceled_unreleased",proof:a.terminal})
    .mockResolvedValueOnce({status:"intent_canceled_unreleased",proof:{...a.terminal,paymentIntentId:"pi_other"}});
  if(issue==="late capture")mockManualStop.mockResolvedValueOnce({status:"intent_canceled_unreleased",proof:a.terminal})
    .mockResolvedValueOnce({status:"reconciliation_required",releaseAllowed:false});
  if(issue==="lost release response"){
    const read=mockRpc.getMockImplementation()!;mockRpc.mockImplementation((name,p)=>name==="release_buyer_mentorship_abandonment_v1"?
      Promise.resolve({data:null,error:{message:"lost"}}):read(name,p));
  }
  await expect(stopBuyerMentorshipUnpaidCheckout(a.args)).rejects.toThrow("requires review");
});
test("manual archived release replay performs no further provider operations",async()=>{
  const a=manualAbandonment(),read=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation((name,p)=>name==="read_buyer_mentorship_manual_release_v1"?Promise.resolve({data:a.released,error:null}):read(name,p));
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({status:"released",releasedAt:a.released.released_at});
  expect(mockManualStop).not.toHaveBeenCalled();expect(mockCancel).not.toHaveBeenCalled();expect(mockSubscription).not.toHaveBeenCalled();
});
test.each(["held","unstarted trial","already canceled","lost response"])("partial %s stops original without any Checkout or payment calls",async state=>{
  const a=partialAbandonment();
  if(state==="unstarted trial")Object.assign(fixture.data.subscription,{pause_collection:null,status:"trialing",
    trial_end:bootstrap.anchor_seconds+48*3600,default_source:null,default_payment_method:null});
  if(state==="already canceled")await mockCancel();
  mockCancel.mockClear();
  if(state==="lost response"){
    const cancel=mockCancel.getMockImplementation()!;mockCancel.mockImplementation(async(...p)=>{await cancel(...p);throw Error("lost");});
  }
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({status:"stopped_unreleased",proof:{
    subscriptionId:"sub_owned",sessionId:null,checkoutStatus:"not_created",firstPaymentIntentId:null}});
  expect(mockCancel).toHaveBeenCalledTimes(state==="already canceled"?0:1);
  expect(mockSession).not.toHaveBeenCalled();expect(mockExpire).not.toHaveBeenCalled();expect(mockIntent).not.toHaveBeenCalled();
  expect(mockRpc).toHaveBeenCalledWith("record_buyer_mentorship_abandonment_proof_v1",expect.objectContaining({
    p_proof:expect.objectContaining({version:"buyer-partial-subscription-stop-v1",preparation:a.partial})}));
});
test.each(["gate off","schema off","missing proof","changed snapshot","active unheld","trial ending","saved card","customer default","hold missing"])
("partial %s refuses cancellation",async issue=>{
  const a=partialAbandonment();
  if(issue==="gate off")a.args.env.CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_READY="false";
  if(issue==="schema off")a.args.env.CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_SCHEMA_READY="false";
  if(issue==="missing proof")mockRpc.mockResolvedValue({error:null,data:null});
  if(issue==="changed snapshot"){
    const read=mockRpc.getMockImplementation()!;let reads=0;
    mockRpc.mockImplementation((name,p)=>name==="read_buyer_mentorship_partial_stop_v1"&&++reads>1?
      Promise.resolve({error:null,data:{...a.partial,hold:null}}):read(name,p));
  }
  if(["active unheld","trial ending","saved card"].includes(issue))Object.assign(fixture.data.subscription,{pause_collection:null,
    status:issue==="active unheld"?"active":"trialing",trial_end:issue==="trial ending"?Date.now()/1000+30:bootstrap.anchor_seconds+48*3600,
    default_source:null,default_payment_method:issue==="saved card"?"pm_other":null});
  if(issue==="customer default")fixture.data.customer.default_source="card_other";
  if(issue==="hold missing")abandonmentHold=null;
  await expect(stopBuyerMentorshipUnpaidCheckout(a.args)).rejects.toThrow("requires review");
  expect(mockCancel).not.toHaveBeenCalled();expect(mockExpire).not.toHaveBeenCalled();
});
test("open checkout expiry is admitted once; busy cancellation waits for a later original recovery",async()=>{
  const a=abandonmentExecutor("open");const admitted=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation((name,p)=>p.p_step==="subscription.cancel"?Promise.resolve({error:null,data:{status:"busy"}}):admitted(name,p));
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toEqual({status:"reconciliation_required",releaseAllowed:false});
  expect(mockExpire).toHaveBeenCalledTimes(1);expect(mockCancel).not.toHaveBeenCalled();
  mockRpc.mockImplementation(admitted);
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({status:"stopped_unreleased",releaseAllowed:false});
  expect(mockExpire).toHaveBeenCalledTimes(1);expect(mockCancel).toHaveBeenCalledTimes(1);
});
test("lost cancellation response recovers terminal original subscription without replacement",async()=>{
  const a=abandonmentExecutor();const cancel=mockCancel.getMockImplementation()!;
  mockCancel.mockImplementation(async(...p)=>{await cancel(...p);throw Error("private timeout");});
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({status:"stopped_unreleased",releaseAllowed:false});
  expect(mockCancel).toHaveBeenCalledTimes(1);
});
test.each(["gate off","missing hold","late receipt","changed context","paid session","wrong customer"])("buyer stop refuses %s before provider writes",async issue=>{
  const a=abandonmentExecutor();
  if(issue==="gate off")a.args.env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_EXECUTOR_READY="false";
  if(issue==="missing hold")abandonmentHold=null;
  if(issue==="late receipt")receipt={reservation_id:fixture.reservation.id};
  if(issue==="changed context")mockObserve.mockResolvedValue({contextEvidence:{...fixture.contextEvidence,observedPlatformAccountId:"acct_other"}});
  if(issue==="paid session")Object.assign(a.session,{status:"complete",payment_status:"paid",payment_intent:"pi_owned"});
  if(issue==="wrong customer")fixture.data.customer.id="cus_other";
  await expect(stopBuyerMentorshipUnpaidCheckout(a.args)).rejects.toThrow("Buyer abandonment requires review");
  expect(mockCancel).not.toHaveBeenCalled();expect(mockExpire).not.toHaveBeenCalled();
});
test.each(["key","request","deadline"])("invalid original admission %s cannot dispatch",async issue=>{
  const a=abandonmentExecutor();const admitted=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation(async(name,p)=>{const result=await admitted(name,p);
    if(issue==="key")result.data.operation.idempotency_key="new-key";
    if(issue==="request")result.data.operation.request.params={invoice_now:true,prorate:true};
    if(issue==="deadline")result.data.dispatch_before=new Date(Date.now()-1).toISOString();return result;});
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toEqual({status:"reconciliation_required",releaseAllowed:false});
  expect(mockCancel).not.toHaveBeenCalled();expect(mockExpire).not.toHaveBeenCalled();
});

test("expired buyer stop cannot accept a canceled Checkout intent with changed fee",async()=>{
  const a=abandonmentExecutor();Object.assign(a.session,{payment_intent:"pi_owned"});
  mockIntent.mockResolvedValue({...fixture.data.paymentIntent,status:"canceled",amount_received:0,amount_capturable:0,application_fee_amount:1});
  await expect(stopBuyerMentorshipUnpaidCheckout(a.args)).rejects.toThrow("Buyer abandonment requires review");
  expect(mockCancel).not.toHaveBeenCalled();
});

test("failed durable stop proof does not report completed abandonment",async()=>{
  const a=abandonmentExecutor(),admitted=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation((name,p)=>name==="record_buyer_mentorship_abandonment_proof_v1"?Promise.resolve({error:{message:"unavailable"},data:null}):admitted(name,p));
  await expect(stopBuyerMentorshipUnpaidCheckout(a.args)).rejects.toThrow("Buyer abandonment requires review");
  expect(mockCancel).toHaveBeenCalledTimes(1);
  mockRpc.mockImplementation(admitted);
  expect(await stopBuyerMentorshipUnpaidCheckout(a.args)).toMatchObject({status:"stopped_unreleased",releaseAllowed:false});
  expect(mockCancel).toHaveBeenCalledTimes(1);
});

test.each(["saved","lost response","wrong identity","schema off"])("gated terminal release: %s",async issue=>{
  const a=abandonmentExecutor(),admitted=mockRpc.getMockImplementation()!;
  const env={...a.args.env,CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY:issue==="schema off"?"false":"true",
    CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_READY:"true"};
  mockRpc.mockImplementation((name,p)=>name==="release_buyer_mentorship_abandonment_v1"?Promise.resolve({
    error:issue==="lost response"?{message:"private"}:null,data:{reservation_id:issue==="wrong identity"?"other":fixture.reservation.id,
      request_id:fixture.reservation.requestId,released_at:new Date().toISOString()}}):admitted(name,p));
  if(issue==="saved"){
    expect(await stopBuyerMentorshipUnpaidCheckout({...a.args,env})).toMatchObject({status:"released",requestId:fixture.reservation.requestId,providerOperationsAllowed:false});
    expect(mockRpc).toHaveBeenCalledWith("release_buyer_mentorship_abandonment_v1",expect.objectContaining({p_request_id:fixture.reservation.requestId,
      p_buyer_id:fixture.reservation.buyerId,p_proof:expect.objectContaining({checkoutStatus:"expired",subscriptionId:"sub_owned",sessionId:"cs_test_owned"})}));
  }else await expect(stopBuyerMentorshipUnpaidCheckout({...a.args,env})).rejects.toThrow("Buyer abandonment requires review");
  if(issue==="schema off")expect(mockCancel).not.toHaveBeenCalled();
});

test.each(["released","prepared_or_uncertain","wrong owner","database failure"])("unprepared release %s performs no Stripe work",async scenario=>{
  const a={...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY:"true"}};
  mockRpc.mockResolvedValue({error:scenario==="database failure"?{}:null,data:{status:scenario==="prepared_or_uncertain"?scenario:"released",
    reservation_id:fixture.reservation.id,request_id:fixture.reservation.requestId,released_at:new Date().toISOString()}});
  if(scenario==="wrong owner")mockReservation.mockResolvedValue(null);
  if(["released","prepared_or_uncertain"].includes(scenario))expect(await releaseBuyerMentorshipUnpreparedSelection(a)).toMatchObject({status:scenario});
  else await expect(releaseBuyerMentorshipUnpreparedSelection(a)).rejects.toThrow("requires review");
  expect(mockSession).not.toHaveBeenCalled();expect(mockCustomer).not.toHaveBeenCalled();expect(mockCancel).not.toHaveBeenCalled();expect(mockExpire).not.toHaveBeenCalled();
});


test.each(["released","prepared_or_uncertain","error","gate off"])("nonpayable fallback %s uses only SQL and preserves uncertainty",async outcome=>{
 const a={...args(),includeNonpayablePreparation:true,env:{...env,
  CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY:"true",
  CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY:"true",
  CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_SCHEMA_READY:"true",
  CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY:outcome==="gate off"?"false":"true"}};
 mockRpc.mockResolvedValueOnce({error:null,data:{status:"prepared_or_uncertain"}}).mockResolvedValueOnce({error:outcome==="error"?{}:null,data:{status:outcome,
  reservation_id:fixture.reservation.id,request_id:fixture.reservation.requestId,released_at:new Date().toISOString()}});
 if(outcome==="error"||outcome==="gate off")await expect(releaseBuyerMentorshipUnpreparedSelection(a)).rejects.toThrow("requires review");
 else expect(await releaseBuyerMentorshipUnpreparedSelection(a)).toMatchObject({status:outcome});
 expect(mockRpc.mock.calls.map(([name])=>name)).toEqual(outcome==="gate off"?[]:["release_buyer_mentorship_unprepared_v1","release_buyer_mentorship_nonpayable_v1"]);
 expect(mockSession).not.toHaveBeenCalled();expect(mockCustomer).not.toHaveBeenCalled();expect(mockCancel).not.toHaveBeenCalled();expect(mockExpire).not.toHaveBeenCalled();
});
