import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {inspectBuyerMentorshipFirstCapture} from "../lib/mentorshipInstallmentReceipt";
const mockPrepare=jest.fn(),mockObserve=jest.fn(),mockReservation=jest.fn(),mockRpc=jest.fn(),mockFrom=jest.fn(),mockHistory=jest.fn();
const mockInvoice=jest.fn(),mockLinks=jest.fn(),mockIntent=jest.fn(),mockMethod=jest.fn(),mockPay=jest.fn(),mockSubscription=jest.fn();
const mockReconcile=jest.fn();
jest.mock("@/lib/mentorshipInstallmentReconciliation",()=>({reconcileBuyerMentorshipInvoice:(...a:unknown[])=>mockReconcile(...a)}));
jest.mock("stripe",()=>({__esModule:true,default:function(){return {invoices:{retrieve:mockInvoice,pay:mockPay},invoicePayments:{list:mockLinks},paymentIntents:{retrieve:mockIntent},paymentMethods:{retrieve:mockMethod}};}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({rpc:mockRpc,from:mockFrom})}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>config}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("@/lib/installments/renewal",()=>({verifyRenewalProviderHistory:(...a:unknown[])=>mockHistory(...a)}));
jest.mock("@/lib/mentorshipInstallmentInvoicePreparation",()=>({prepareBuyerMentorshipInvoice:(...a:unknown[])=>mockPrepare(...a)}));
jest.mock("@/lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...a:unknown[])=>mockReservation(...a)}));
import {collectBuyerMentorshipInvoice} from "../lib/mentorshipInstallmentCollection";
let f:ReturnType<typeof buyerFirstCaptureFixture>,proof:ReturnType<typeof inspectBuyerMentorshipFirstCapture>,config:any,admission:any;
const env={CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_READY:"true"};
const args=()=>({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,env});
beforeEach(()=>{
  jest.resetAllMocks();f=buyerFirstCaptureFixture();proof=inspectBuyerMentorshipFirstCapture(f);jest.useFakeTimers({now:proof.nextPaymentAt*1000+1000});
  config={configuredSupabaseUrl:f.contextEvidence.configuredSupabaseUrl,supabaseServiceKey:"synthetic",stripeSecretKey:"sk_test_synthetic"};
  mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});mockReservation.mockResolvedValue(f.reservation);
  mockPrepare.mockResolvedValue({status:"verified_unpaid",reservationId:f.reservation.id,paymentNumber:2,invoiceId:"in_due",paymentIntentId:"pi_due",amountCents:3333,applicationFeeCents:527,
    card:{paymentMethodId:proof.paymentMethodId,defaultPaymentMethodId:proof.paymentMethodId,cardAuthorizationId:null},
    claimToken:"00000000-0000-4000-8000-000000000099",verifySubscription:mockSubscription});
  mockFrom.mockImplementation(table=>{
    const data=table==="buyer_mentorship_first_receipts_v1"?{reservation_id:f.reservation.id,purchase_id:"purchase_owned",proof}:
      table==="buyer_mentorship_collection_periods_v1"?[2,3].map(payment_number=>({reservation_id:f.reservation.id,payment_number})):
      table==="buyer_mentorship_payment_admissions_v1"?[]:[{purchase_id:"purchase_owned",stripe_payment_intent_id:proof.paymentIntentId,earnings_credited_at:"saved",status:"paid"}];
    const q:any={select:()=>q,eq:()=>q,order:()=>q,limit:async()=>({data,error:null}),maybeSingle:async()=>({data,error:null})};return q;
  });
  mockInvoice.mockResolvedValue({id:"in_due"});mockIntent.mockResolvedValue({id:"pi_due"});
  mockMethod.mockResolvedValue({id:proof.paymentMethodId,billing_details:{address:{country:"US"}}});mockLinks.mockResolvedValue({has_more:false,data:[{id:"inpay_due"}]});
  mockRpc.mockImplementation(async(_name,p)=>{
    admission={reservation_id:f.reservation.id,payment_number:2,invoice_id:"in_due",payment_intent_id:"pi_due",payment_method_id:proof.paymentMethodId,
      request:p.p_request,idempotency_key:"cn-buyer-pay-v1:00000000-0000-4000-8000-000000000088",dispatch_before:new Date(Date.now()+25000).toISOString()};
    return {error:null,data:{status:"dispatch_once",admission}};
  });
});
afterEach(()=>jest.useRealTimers());
test("original admission precedes a single saved-card pay and does not claim a receipt",async()=>{
  expect(await collectBuyerMentorshipInvoice(args())).toMatchObject({status:"reconciliation_required",invoiceId:"in_due",paymentNumber:2});
  expect(mockHistory).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({destinationId:f.reservation.destinationId,paymentMethodId:proof.paymentMethodId}),
    [{paymentNumber:1,paymentIntentId:proof.paymentIntentId}],expect.any(Array),false);
  expect(mockSubscription.mock.invocationCallOrder[0]).toBeGreaterThan(mockHistory.mock.invocationCallOrder[0]);
  expect(mockRpc.mock.calls[0][0]).toBe("admit_buyer_mentorship_payment_v1");
  expect(mockPay.mock.invocationCallOrder[0]).toBeGreaterThan(mockRpc.mock.invocationCallOrder[0]);
  expect(mockPay).toHaveBeenCalledTimes(1);
  expect(mockPay).toHaveBeenCalledWith("in_due",{payment_method:proof.paymentMethodId,off_session:true},{idempotencyKey:admission.idempotency_key});
});
test("provider timeout retains admission and requires reconciliation",async()=>{
  mockPay.mockRejectedValue(Error("lost response"));
  expect((await collectBuyerMentorshipInvoice(args())).status).toBe("reconciliation_required");expect(mockPay).toHaveBeenCalledTimes(1);
});
test("existing admission never dispatches again",async()=>{
  const rpc=mockRpc.getMockImplementation()!;mockRpc.mockImplementation(async(...a)=>{const result=await rpc(...a);result.data.status="reconcile_admitted";return result;});
  expect((await collectBuyerMentorshipInvoice(args())).status).toBe("reconciliation_required");expect(mockPay).not.toHaveBeenCalled();
});
test.each(["disabled","prior refund","subscription changed","non-US","ambiguous link","persistence failed","expired admission","changed request"])("%s prevents pay",async(problem)=>{
  if(problem==="prior refund")mockHistory.mockRejectedValue(Error("refund"));
  if(problem==="subscription changed")mockSubscription.mockRejectedValue(Error("changed"));
  if(problem==="non-US")mockMethod.mockResolvedValue({billing_details:{address:{country:"CA"}}});
  if(problem==="ambiguous link")mockLinks.mockResolvedValue({has_more:true,data:[{}]});
  if(problem==="persistence failed")mockRpc.mockResolvedValue({error:{message:"unavailable"}});
  if(problem==="expired admission" || problem==="changed request"){
    const rpc=mockRpc.getMockImplementation()!;mockRpc.mockImplementation(async(...a)=>{const result=await rpc(...a);
      if(problem==="expired admission")result.data.admission.dispatch_before=new Date(Date.now()-1).toISOString();
      else result.data.admission.request={...result.data.admission.request,params:{payment_method:"pm_other",off_session:true}};
      return result;});
  }
  await expect(collectBuyerMentorshipInvoice({...args(),...(problem==="disabled"?{env:{}}:{})})).rejects.toThrow();expect(mockPay).not.toHaveBeenCalled();
});

test.each(["success","lost response","existing admission"])("enabled reconciliation follows %s without a replacement pay",async condition=>{
  const enabled={...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RECONCILIATION_READY:"true"}};
  mockReconcile.mockResolvedValue({status:"credited",paymentNumber:2});
  if(condition==="lost response")mockPay.mockRejectedValue(Error("uncertain"));
  if(condition==="existing admission")mockPrepare.mockResolvedValue({status:"reconcile_admitted",invoiceId:"in_due",paymentNumber:2});
  expect(await collectBuyerMentorshipInvoice(enabled)).toEqual({status:"credited",paymentNumber:2});
  expect(mockReconcile).toHaveBeenCalledWith({...enabled,invoiceId:"in_due"});
  expect(mockPay).toHaveBeenCalledTimes(condition==="existing admission"?0:1);
});

test.each(["authorized","disabled","wrong default"])("future card collection: %s",async scenario=>{
  const prepared=await mockPrepare();mockPrepare.mockClear();
  prepared.paymentNumber=3;prepared.amountCents=3335;
  prepared.card={paymentMethodId:"pm_replacement",defaultPaymentMethodId:scenario==="wrong default"?"pm_other":proof.paymentMethodId,
    cardAuthorizationId:"10000000-0000-4000-8000-000000000088"};
  mockPrepare.mockResolvedValue(prepared);
  const original=mockFrom.getMockImplementation()!;
  mockFrom.mockImplementation(table=>{
    let data;
    if(table==="buyer_mentorship_collection_periods_v1")data=[{reservation_id:f.reservation.id,payment_number:2,invoice_id:"in_prior",counted_at:"saved"},{reservation_id:f.reservation.id,payment_number:3}];
    else if(table==="buyer_mentorship_payment_admissions_v1")data=[{reservation_id:f.reservation.id,payment_number:2,invoice_id:"in_prior",payment_intent_id:"pi_prior"}];
    else if(table==="payment_fee_ledger")data=[{purchase_id:"purchase_owned",stripe_payment_intent_id:proof.paymentIntentId,earnings_credited_at:"saved",status:"paid"},
      {purchase_id:"purchase_owned",stripe_payment_intent_id:"pi_prior",stripe_invoice_id:"in_prior",earnings_credited_at:"saved",status:"paid"}];
    else return original(table);
    const q:any={select:()=>q,eq:()=>q,order:()=>q,limit:async()=>({data,error:null})};return q;
  });
  mockMethod.mockResolvedValue({id:"pm_replacement",billing_details:{address:{country:"US"}}});
  const rpc=mockRpc.getMockImplementation()!;mockRpc.mockImplementation(async(...a)=>{const result=await rpc(...a);
    result.data.admission.payment_number=3;result.data.admission.payment_method_id="pm_replacement";return result;});
  const flags=Object.fromEntries(["INVOICE_CARD_SCHEMA_READY","FUTURE_CARD_SCHEMA_READY","FUTURE_CARD_READY","FUTURE_COLLECTION_READY","CARD_RECOVERY_SCHEMA_READY"].map(k=>[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`,"true"]));
  if(scenario==="disabled")flags.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_COLLECTION_READY="false";
  const call=collectBuyerMentorshipInvoice({...args(),env:{...env,...flags}});
  if(scenario==="authorized") {
    expect((await call).status).toBe("reconciliation_required");
    expect(mockPay).toHaveBeenCalledWith("in_due",{payment_method:"pm_replacement",off_session:true},expect.anything());
    expect(mockHistory.mock.calls[0][1]).toMatchObject({paymentMethodId:"pm_replacement",defaultPaymentMethodId:proof.paymentMethodId});
  } else {await expect(call).rejects.toThrow();expect(mockPay).not.toHaveBeenCalled();}
});
