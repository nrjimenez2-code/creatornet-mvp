import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {inspectBuyerMentorshipFirstCapture} from "../lib/mentorshipInstallmentReceipt";
import {buyerMentorshipActivationParams} from "../lib/mentorshipInstallmentActivation";
import {heldInvoicePreparationRequests} from "../lib/installments/heldInvoice";
import {installmentMonthBoundary} from "../lib/installments/checkoutPreparation";
const mockDiscovery=jest.fn(),mockInspect=jest.fn(),mockObserve=jest.fn(),mockReservation=jest.fn(),mockRpc=jest.fn(),mockFrom=jest.fn(),mockPrepare=jest.fn();
const mockRetrieve=jest.fn(),mockUpdate=jest.fn(),mockFinalize=jest.fn(),mockSub=jest.fn();
jest.mock("stripe",()=>({__esModule:true,default:function(){return {invoices:{retrieve:mockRetrieve,update:mockUpdate,finalizeInvoice:mockFinalize},subscriptions:{retrieve:mockSub}};}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({rpc:mockRpc,from:mockFrom})}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>config}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("@/lib/mentorshipInstallmentDiscovery",()=>({discoverBuyerMentorshipRenewal:(...a:unknown[])=>mockDiscovery(...a)}));
jest.mock("@/lib/mentorshipInstallmentReceipt",()=>({...jest.requireActual("@/lib/mentorshipInstallmentReceipt"),inspectBuyerMentorshipFirstPayment:(...a:unknown[])=>mockInspect(...a)}));
jest.mock("@/lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...a:unknown[])=>mockReservation(...a)}));
jest.mock("@/lib/installments/heldInvoice",()=>({...jest.requireActual("@/lib/installments/heldInvoice"),prepareHeldInvoiceUsingContract:(...a:unknown[])=>mockPrepare(...a)}));
import {prepareBuyerMentorshipInvoice} from "../lib/mentorshipInstallmentInvoicePreparation";
let f:ReturnType<typeof buyerFirstCaptureFixture>,proof:ReturnType<typeof inspectBuyerMentorshipFirstCapture>,config:any,claim:any;
const env={CREATOR_MENTORSHIP_INSTALLMENT_INVOICE_OPERATIONS_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_INVOICE_PREPARATION_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_SCHEMA_READY:"true"};
const args=()=>({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,env});
beforeEach(()=>{
  jest.resetAllMocks();f=buyerFirstCaptureFixture();proof=inspectBuyerMentorshipFirstCapture(f);jest.useFakeTimers({now:proof.nextPaymentAt*1000+1000});
  config={configuredSupabaseUrl:f.contextEvidence.configuredSupabaseUrl,supabaseServiceKey:"synthetic",stripeSecretKey:"sk_test_synthetic"};
  const params=buyerMentorshipActivationParams(proof.paidAt,3,proof.paymentMethodId);
  Object.assign(f.data.subscription,{...params,status:"active",billing_cycle_anchor:params.trial_end,metadata:{...f.data.subscription.metadata,...params.metadata}});
  mockDiscovery.mockResolvedValue({status:"discovered",invoiceId:"in_due",paymentNumber:2});mockInspect.mockResolvedValue(proof);
  mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});mockReservation.mockResolvedValue(f.reservation);mockSub.mockResolvedValue(f.data.subscription);
  mockRetrieve.mockResolvedValue({id:"in_due"});mockUpdate.mockResolvedValue({id:"in_due"});mockFinalize.mockResolvedValue({id:"in_due"});
  claim={reservation_id:f.reservation.id,payment_number:2,invoice_id:"in_due",lease_token:"10000000-0000-4000-8000-000000000099",
    idempotency_prefix:"cn-buyer-invoice-v1:10000000-0000-4000-8000-000000000098",authorization_snapshot:{
      protocol:"buyer-mentorship-installments-v1",planId:f.reservation.id,buyerReservationId:f.reservation.id,buyerRequestId:f.reservation.requestId,
      invoiceId:"in_due",subscriptionId:"sub_owned",subscriptionItemId:"si_owned",customerId:"cus_owned",destinationId:f.reservation.destinationId,
      currency:"usd",totalCents:10001,paymentCount:3,paymentNumber:2,periodStart:proof.nextPaymentAt,periodEnd:installmentMonthBoundary(proof.nextPaymentAt,1),
      cancelAt:params.cancel_at,feeSchedule:f.reservation.terms.renewalFeeSchedule}};
  mockFrom.mockImplementation(table=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({error:null,data:table==="buyer_mentorship_bootstraps_v1"?
    {reservation_id:f.reservation.id,customer_id:"cus_owned",anchor_seconds:f.dependencies.anchorSeconds}:{reservation_id:f.reservation.id,result_id:"prod_owned",bound_at:new Date().toISOString()}})};return q;});
  mockRpc.mockImplementation(async(name,p)=>({error:null,data:name==="claim_buyer_mentorship_invoice_v1"?{status:"claimed",claim,paymentAllowed:false}:
    {paymentAllowed:false,dispatchBefore:new Date(Date.now()+30000).toISOString(),operation:{reservation_id:f.reservation.id,payment_number:2,step:p.p_step,
      request:p.p_request,idempotency_key:`${claim.idempotency_prefix}:${p.p_step}`}}}));
  mockPrepare.mockImplementation(async(api,a,c)=>{
    expect(api.invoices.pay).toBeUndefined();expect(api.paymentIntents.confirm).toBeUndefined();
    c.assertSubscription(await api.subscriptions.retrieve(a.subscriptionId));const requests=heldInvoicePreparationRequests(a,c);
    await api.invoices.update(a.invoiceId,requests.configure,{idempotencyKey:`${c.idempotencyPrefix}:configure`});
    await api.invoices.finalizeInvoice(a.invoiceId,requests.finalize,{idempotencyKey:`${c.idempotencyPrefix}:finalize`});
    return {status:"verified_unpaid",invoiceId:a.invoiceId,paymentIntentId:"pi_due",amountCents:3333,applicationFeeCents:527,destinationId:a.destinationId};
  });
});
afterEach(()=>jest.useRealTimers());
test("persists each original request before sending through the shared unpaid preparer",async()=>{
  expect(await prepareBuyerMentorshipInvoice(args())).toMatchObject({status:"verified_unpaid",paymentAllowed:false,paymentNumber:2});
  expect(mockRpc.mock.calls.map(c=>c[0])).toEqual(["claim_buyer_mentorship_invoice_v1","prepare_buyer_mentorship_invoice_operation_v1","prepare_buyer_mentorship_invoice_operation_v1"]);
  expect(mockUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(mockRpc.mock.invocationCallOrder[1]);
  expect(mockFinalize.mock.invocationCallOrder[0]).toBeGreaterThan(mockRpc.mock.invocationCallOrder[2]);
  expect(mockUpdate.mock.calls[0][2]).toEqual({idempotencyKey:`${claim.idempotency_prefix}:configure`});
});
test("disabled preparation never discovers or writes",async()=>{
  await expect(prepareBuyerMentorshipInvoice({...args(),env:{}})).rejects.toThrow();expect(mockDiscovery).not.toHaveBeenCalled();expect(mockRpc).not.toHaveBeenCalled();
});
test("already admitted invoice goes to reconciliation without preparation",async()=>{
  mockDiscovery.mockResolvedValue({status:"reconcile_admitted",invoiceId:"in_due",paymentNumber:2});
  expect(await prepareBuyerMentorshipInvoice(args())).toMatchObject({status:"reconcile_admitted"});expect(mockPrepare).not.toHaveBeenCalled();
});
test("operation persistence failure prevents provider mutation",async()=>{
  const rpc=mockRpc.getMockImplementation()!;mockRpc.mockImplementation((name,p)=>name==="claim_buyer_mentorship_invoice_v1"?rpc(name,p):{error:{message:"unavailable"},data:null});
  await expect(prepareBuyerMentorshipInvoice(args())).rejects.toThrow();expect(mockUpdate).not.toHaveBeenCalled();expect(mockFinalize).not.toHaveBeenCalled();
});
test("shared preparer cannot substitute another amount",async()=>{
  mockPrepare.mockImplementation(async(api,a,c)=>api.invoices.update(a.invoiceId,{application_fee_amount:1},{idempotencyKey:`${c.idempotencyPrefix}:configure`}));
  await expect(prepareBuyerMentorshipInvoice(args())).rejects.toThrow();expect(mockUpdate).not.toHaveBeenCalled();expect(mockRpc).toHaveBeenCalledTimes(1);
});
test("changed subscription hold prevents preparing an invoice",async()=>{
  f.data.subscription.pause_collection=null;await expect(prepareBuyerMentorshipInvoice(args())).rejects.toThrow();expect(mockUpdate).not.toHaveBeenCalled();
});
test("collection preflight re-reads the original subscription after preparation",async()=>{
  const prepared=await prepareBuyerMentorshipInvoice(args());
  if(prepared.status!=="verified_unpaid")throw Error("expected prepared invoice");
  expect(prepared.claimToken).toBe(claim.lease_token);
  await prepared.verifySubscription();
  f.data.subscription.pause_collection=null;
  await expect(prepared.verifySubscription()).rejects.toThrow();
  expect(mockSub).toHaveBeenLastCalledWith(proof.subscriptionId);
});
