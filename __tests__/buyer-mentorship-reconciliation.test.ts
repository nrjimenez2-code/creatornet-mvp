import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {exactRenewalFixture} from "../test-support/exact-renewal-fixture";
import {inspectBuyerMentorshipFirstCapture} from "../lib/mentorshipInstallmentReceipt";
import {heldInvoicePreparationRequests} from "../lib/installments/heldInvoice";
import {inspectExactCardSetupUnpaid} from "../lib/installments/cardRecovery";
const mockObserve=jest.fn(),mockReservation=jest.fn(),mockRpc=jest.fn(),mockFrom=jest.fn();
let api:any,config:any,rows:Record<string,any>,f:ReturnType<typeof buyerFirstCaptureFixture>;
jest.mock("stripe",()=>({__esModule:true,default:function(){return api;}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({rpc:mockRpc,from:mockFrom})}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>config}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("@/lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...a:unknown[])=>mockReservation(...a)}));
import {reconcileBuyerMentorshipInvoice} from "../lib/mentorshipInstallmentReconciliation";
const env={CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RECONCILIATION_READY:"true"};
const purchaseId="10000000-0000-4000-8000-000000000080",ledgerId="10000000-0000-4000-8000-000000000081";
const args=()=>({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,invoiceId:"in_due",env});
let invoice:any,intent:any,charge:any,link:any,balance:any;
beforeEach(()=>{
  jest.resetAllMocks();f=buyerFirstCaptureFixture();const first=inspectBuyerMentorshipFirstCapture(f),r=f.reservation;
  jest.useFakeTimers({now:(first.nextPaymentAt+100)*1000});
  const a={protocol:"buyer-mentorship-installments-v1" as const,planId:r.id,buyerReservationId:r.id,buyerRequestId:r.requestId,
    invoiceId:"in_due",subscriptionId:first.subscriptionId,subscriptionItemId:"si_owned",customerId:first.customerId,destinationId:r.destinationId,
    currency:"usd" as const,totalCents:10001,paymentCount:3,paymentNumber:2,periodStart:first.nextPaymentAt,periodEnd:first.nextPaymentAt+28*86400,
    cancelAt:first.nextPaymentAt+56*86400,feeSchedule:r.terms.renewalFeeSchedule};
  const admittedAt=new Date((first.nextPaymentAt+10)*1000).toISOString();
  const metadata={creatornet_installment_version:a.protocol,terms_fingerprint:r.fingerprint,payment_mode:f.context.mode,
    platform_account_id:f.context.platformAccountId,supabase_project_ref:f.context.supabaseProjectRef,site_origin:f.context.siteOrigin};
  const base=exactRenewalFixture();invoice=structuredClone(base.invoice);
  Object.assign(invoice,{object:"invoice",id:"in_due",status:"paid",customer:first.customerId,parent:{subscription_details:{subscription:first.subscriptionId}},
    amount_due:3333,amount_remaining:0,amount_paid:3333,total:3333,subtotal:3333,attempted:true,attempt_count:1,
    metadata:heldInvoicePreparationRequests(a,{expectedLiveMode:false,collectionVersion:"buyer-mentorship-collection-v1",idempotencyPrefix:"synthetic",metadata,assertSubscription:()=>{}}).configure.metadata});
  Object.assign(invoice.lines.data[0],{invoice:"in_due",amount:3333,period:{start:a.periodStart,end:a.periodEnd},
    parent:{type:"subscription_item_details",subscription_item_details:{subscription:a.subscriptionId,subscription_item:a.subscriptionItemId,proration:false}}});
  intent={...f.data.paymentIntent,id:"pi_due",latest_charge:"ch_due"};
  charge={...f.data.charge,id:"ch_due",payment_intent:"pi_due",balance_transaction:"txn_due",transfer:"tr_due",created:first.nextPaymentAt+20};
  balance={...f.data.balance,id:"txn_due",source:"ch_due"};
  link={...base.link,invoice:"in_due",status:"paid",amount_requested:3333,amount_paid:3333,payment:{type:"payment_intent",payment_intent:"pi_due"}};
  api={invoices:{retrieve:jest.fn(async()=>invoice),pay:jest.fn(),update:jest.fn(),finalizeInvoice:jest.fn()},
    invoicePayments:{list:jest.fn(async()=>({has_more:false,data:[link]}))},paymentIntents:{retrieve:jest.fn(async()=>intent),confirm:jest.fn()},
    charges:{retrieve:jest.fn(async()=>charge)},balanceTransactions:{retrieve:jest.fn(async()=>balance)},subscriptions:{update:jest.fn()}};
  config={configuredSupabaseUrl:f.contextEvidence.configuredSupabaseUrl,supabaseServiceKey:"synthetic",stripeSecretKey:"sk_test_synthetic"};
  mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});mockReservation.mockResolvedValue(r);
  rows={buyer_mentorship_first_receipts_v1:{reservation_id:r.id,purchase_id:purchaseId,proof:first},
    buyer_mentorship_payment_admissions_v1:{reservation_id:r.id,payment_number:2,invoice_id:"in_due",payment_intent_id:"pi_due",payment_method_id:first.paymentMethodId,
      admitted_at:admittedAt,dispatch_before:admittedAt,idempotency_key:"cn-buyer-pay-v1:10000000-0000-4000-8000-000000000088",
      request:{apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/invoices/in_due/pay",params:{payment_method:first.paymentMethodId,off_session:true}}},
    buyer_mentorship_invoice_claims_v1:{reservation_id:r.id,payment_number:2,invoice_id:"in_due",authorization_snapshot:a},
    buyer_mentorship_collection_periods_v1:{reservation_id:r.id,payment_number:2,invoice_id:"in_due",admitted_at:admittedAt,due_at:a.periodStart,period_end:a.periodEnd,amount_cents:3333,fee_schedule:a.feeSchedule}};
  mockFrom.mockImplementation(table=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({error:null,data:rows[table]})};return q;});
  mockRpc.mockResolvedValue({error:null,data:{recorded:true,reservationId:r.id,paymentNumber:2,purchaseId,ledgerId}});
});
afterEach(()=>{
  expect(api.invoices.pay).not.toHaveBeenCalled();expect(api.invoices.update).not.toHaveBeenCalled();
  expect(api.invoices.finalizeInvoice).not.toHaveBeenCalled();expect(api.paymentIntents.confirm).not.toHaveBeenCalled();
  expect(api.subscriptions.update).not.toHaveBeenCalled();jest.useRealTimers();
});
test.each(["original decline","pending payment","foreign invoice payment","changed default","fabricated booking"])("shared card-setup inspection checks buyer-owned %s",async scenario=>{
  const a={...rows.buyer_mentorship_invoice_claims_v1.authorization_snapshot,paymentMethodId:rows.buyer_mentorship_payment_admissions_v1.payment_method_id};
  Object.assign(invoice,{status:"open",amount_paid:0,amount_remaining:3333});
  Object.assign(link,{status:"open",amount_paid:0});
  Object.assign(intent,{status:"requires_payment_method",amount_received:0,amount_capturable:0,payment_method:null});
  const subscription={id:a.subscriptionId,livemode:false,customer:a.customerId,status:"past_due",ended_at:null,
    pause_collection:{behavior:"keep_as_draft",resumes_at:null},default_payment_method:a.paymentMethodId,payment_settings:{save_default_payment_method:"off"}};
  api.subscriptions.retrieve=jest.fn(async()=>subscription);
  if(scenario==="pending payment")intent.status="processing";
  if(scenario==="foreign invoice payment")link.payment.payment_intent="pi_other";
  if(scenario==="changed default")subscription.default_payment_method="pm_other";
  if(scenario==="fabricated booking")a.bookingPaymentId="fabricated";
  const inspection=inspectExactCardSetupUnpaid(api,{invoiceId:a.invoiceId,originalPaymentIntentId:intent.id,authorization:a},
    {expectedLiveMode:false,collectionVersion:"buyer-mentorship-collection-v1",metadata:invoice.metadata});
  if(scenario==="original decline")await expect(inspection).resolves.toBeUndefined();
  else await expect(inspection).rejects.toThrow();
});
test("reconciles captured original admission with collection disabled and expired dispatch deadline",async()=>{
  expect(await reconcileBuyerMentorshipInvoice(args())).toMatchObject({status:"credited",paymentNumber:2,ledgerId});
  expect(mockRpc).toHaveBeenCalledWith("record_buyer_mentorship_later_receipt_v1",expect.objectContaining({p_proof:expect.objectContaining({
    paymentIntentId:"pi_due",invoiceId:"in_due",chargeId:"ch_due",amountCents:3333,actualStripeFeeCents:127,transferId:"tr_due"})}));
});
test("lost accounting reply retries only original receipt and returns already credited",async()=>{
  mockRpc.mockRejectedValueOnce(Error("lost reply"));await expect(reconcileBuyerMentorshipInvoice(args())).rejects.toThrow("requires review");
  mockRpc.mockResolvedValueOnce({data:{recorded:false,reservationId:f.reservation.id,paymentNumber:2,purchaseId,ledgerId}});
  expect((await reconcileBuyerMentorshipInvoice(args())).status).toBe("already_credited");
  expect(mockRpc.mock.calls[1]).toEqual(mockRpc.mock.calls[0]);
});
function replacementAttempt() {
  const quoteId="10000000-0000-4000-8000-000000000088",admitted=Date.parse(rows.buyer_mentorship_payment_admissions_v1.admitted_at)+1000;
  intent.payment_method=charge.payment_method="pm_replacement";
  rows.buyer_mentorship_retry_admissions_v1={quote_id:quoteId,reservation_id:f.reservation.id,payment_number:2,invoice_id:"in_due",payment_intent_id:"pi_due",
    payment_method_id:"pm_replacement",admitted_at:new Date(admitted).toISOString(),idempotency_key:`cn-buyer-retry-v1:${quoteId}`,
    request:{apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/invoices/in_due/pay",params:{payment_method:"pm_replacement",off_session:false}}};
  rows.buyer_mentorship_retry_quotes_v1={id:quoteId,reservation_id:f.reservation.id,buyer_id:f.reservation.buyerId,payment_number:2,invoice_id:"in_due",
    original_payment_intent_id:"pi_due",replacement_payment_method_id:"pm_replacement",amount_cents:3333,consent_version:"single-invoice-pay-now-v1",
    authorization_snapshot:{...rows.buyer_mentorship_invoice_claims_v1.authorization_snapshot,paymentMethodId:"pm_owned"},
    created_at:new Date(admitted-1000).toISOString(),expires_at:Math.floor(admitted/1000)+300,future_card_option:false};
  rows.buyer_mentorship_retry_consents_v1={quote_id:quoteId,confirmed_at:new Date(admitted).toISOString(),future_card_accepted:false};
  return admitted;
}
test.each(["authorized","missing admission","changed request","missing consent","capture predates retry"])("replacement capture reconciliation: %s",async scenario=>{
  const admitted=replacementAttempt();
  if(scenario==="missing admission")rows.buyer_mentorship_retry_admissions_v1=null;
  if(scenario==="changed request")rows.buyer_mentorship_retry_admissions_v1.request.params.off_session=true;
  if(scenario==="missing consent")rows.buyer_mentorship_retry_consents_v1=null;
  if(scenario==="capture predates retry")charge.created=Math.floor(admitted/1000)-1;
  const call=reconcileBuyerMentorshipInvoice({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RETRY_RECEIPT_READY:"true"}});
  if(scenario==="authorized") {
    expect((await call).status).toBe("credited");expect(mockRpc.mock.calls[0][1].p_proof.paymentMethodId).toBe("pm_replacement");
  } else {await expect(call).rejects.toThrow("requires review");expect(mockRpc).not.toHaveBeenCalled();}
});
function finalInstallment() {
  const c=rows.buyer_mentorship_invoice_claims_v1,a=c.authorization_snapshot,p=rows.buyer_mentorship_collection_periods_v1,d=rows.buyer_mentorship_payment_admissions_v1;
  a.paymentNumber=c.payment_number=p.payment_number=d.payment_number=3;
  a.periodStart=p.due_at=a.periodEnd;a.periodEnd=p.period_end=a.cancelAt;
  const time=a.periodStart+100; jest.setSystemTime(time*1000);
  d.admitted_at=p.admitted_at=new Date((time-20)*1000).toISOString();charge.created=time-10;
  invoice.metadata.installment_number="3";
  invoice.amount_due=invoice.amount_paid=invoice.total=invoice.subtotal=p.amount_cents=intent.amount=intent.amount_received=
    charge.amount=charge.amount_captured=balance.amount=link.amount_requested=link.amount_paid=3335;
  balance.net=3335-balance.fee;
  invoice.lines.data[0].period={start:a.periodStart,end:a.periodEnd};
  invoice.lines.data.push({...invoice.lines.data[0],amount:2,discountable:false,
    parent:{type:"invoice_item_details",invoice_item_details:{proration:false,subscription:null}},
    metadata:{installment_adjustment:"final-cent-v1",installment_plan_id:a.planId,
      creatornet_installment_reservation_id:a.planId,creatornet_installment_request_id:a.buyerRequestId}});
  mockRpc.mockResolvedValue({data:{recorded:true,reservationId:f.reservation.id,paymentNumber:3,purchaseId,ledgerId}});
}
test("final installment retains the final-cent adjustment and renewal fee schedule",async()=>{
  finalInstallment();
  expect((await reconcileBuyerMentorshipInvoice(args())).status).toBe("credited");
  expect(mockRpc.mock.calls[0][1].p_proof).toMatchObject({paymentNumber:3,amountCents:3335,fees:{creatorNetCents:2808}});
});
test.each(["open","void","uncollectible"])("%s invoice remains unresolved without accounting",async status=>{
  invoice.status=status;expect((await reconcileBuyerMentorshipInvoice(args())).status).toBe("reconciliation_required");expect(mockRpc).not.toHaveBeenCalled();
});
test.each(["missing admission","foreign owner","changed request","wrong invoice link","wrong amount","wrong fees","refund","dispute","non-US","missing balance","wrong event","context drift","disabled"])("%s prevents clean credit",async problem=>{
  if(problem==="missing admission")rows.buyer_mentorship_payment_admissions_v1=null;
  if(problem==="foreign owner")rows.buyer_mentorship_first_receipts_v1.proof={...rows.buyer_mentorship_first_receipts_v1.proof,buyerId:"10000000-0000-4000-8000-000000000099"};
  if(problem==="changed request")rows.buyer_mentorship_payment_admissions_v1.request.params.off_session=false;
  if(problem==="wrong invoice link")link.payment.payment_intent="pi_other";
  if(problem==="wrong amount")invoice.amount_paid--;
  if(problem==="wrong fees")intent.application_fee_amount--;
  if(problem==="refund")charge.amount_refunded=1;
  if(problem==="dispute")charge.disputed=true;
  if(problem==="non-US")charge.billing_details={address:{country:"CA"}};
  if(problem==="missing balance")charge.balance_transaction=null;
  if(problem==="context drift")mockObserve.mockResolvedValueOnce({contextEvidence:f.contextEvidence}).mockRejectedValueOnce(Error("changed context"));
  await expect(reconcileBuyerMentorshipInvoice({...args(),...(problem==="disabled"?{env:{}}:{}),...(problem==="wrong event"?{
    expectedEvent:{object:"payment_intent" as const,id:"pi_other",customerId:"cus_owned",livemode:false}}:{})})).rejects.toThrow("requires review");
  expect(mockRpc).not.toHaveBeenCalled();
});

test("financial inspection reuses original admitted capture without writing clean credit",async()=>{
  charge.amount_refunded=1000;
  const {inspectBuyerMentorshipAdmittedCapture}=await import("../lib/mentorshipInstallmentReconciliation");
  const inspected=await inspectBuyerMentorshipAdmittedCapture({...args(),financialInspection:"refund",env:{...env,
    CREATOR_MENTORSHIP_INSTALLMENT_REFUND_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_REFUND_EVENTS_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_REFUND_RECOVERY_READY:"true"}});
  expect(inspected).toMatchObject({status:"captured",proof:{paymentNumber:2,paymentIntentId:"pi_due",chargeId:"ch_due"}});
  expect(mockRpc).not.toHaveBeenCalled();
  await expect(reconcileBuyerMentorshipInvoice(args())).rejects.toThrow("requires review");
  expect(mockRpc).not.toHaveBeenCalled();
});

test("financial dispute inspection reads original admitted capture without clean credit",async()=>{
  charge.disputed=true;
  const {inspectBuyerMentorshipAdmittedCapture}=await import("../lib/mentorshipInstallmentReconciliation");
  expect(await inspectBuyerMentorshipAdmittedCapture({...args(),financialInspection:"dispute",env:{...env,
    CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_RECOVERY_READY:"true"}})).toMatchObject({status:"captured",proof:{paymentNumber:2,chargeId:"ch_due"}});
  expect(mockRpc).not.toHaveBeenCalled();await expect(reconcileBuyerMentorshipInvoice(args())).rejects.toThrow("requires review");
});

const recoveryEnv={...env,CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY:"true"};
function unpaidRecovery(status:string) {
  Object.assign(invoice,{status:"open",amount_paid:0,amount_remaining:3333});
  Object.assign(intent,{status,amount_received:0,amount_capturable:0,latest_charge:null,canceled_at:null});
  Object.assign(link,{status:"open",amount_paid:0});
  mockRpc.mockImplementation(async(name)=>({error:null,data:name==="begin_buyer_mentorship_payment_recovery_v1"?
    {reservationId:f.reservation.id,paymentIntentId:"pi_due",paymentNumber:2,revision:7,recoveryRevision:0,paidCount:1,countedAt:null}:true}));
}
test.each([["requires_action","action_required"],["requires_payment_method","payment_method_required"],["processing","payment_pending"]])("original %s is durably classified as %s without a charge",async(status,outcome)=>{
  unpaidRecovery(status);const {recoverBuyerMentorshipPayment}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  expect(await recoverBuyerMentorshipPayment({...args(),env:recoveryEnv,eventId:"evt_failure"})).toEqual({status:"payment_recovery_recorded",outcome});
  expect(mockRpc.mock.calls[1][1]).toMatchObject({p_outcome:outcome,p_event_id:"evt_failure",p_evidence:{amountReceived:0}});
  expect(api.invoices.retrieve.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
  expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(api.paymentIntents.retrieve.mock.invocationCallOrder[0]);
});

test.each([true,false])("paid original records capture before any recovery hold (new receipt %s)",async recorded=>{
  mockRpc.mockImplementation(async(name)=>({error:null,data:name==="record_buyer_mentorship_later_receipt_v1"?
    {recorded,reservationId:f.reservation.id,paymentNumber:2,purchaseId,ledgerId}:name==="begin_buyer_mentorship_payment_recovery_v1"?
    {reservationId:f.reservation.id,paymentIntentId:"pi_due",paymentNumber:2,revision:7,recoveryRevision:0,paidCount:2,countedAt:"saved"}:true}));
  const {recoverBuyerMentorshipPayment}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  expect(await recoverBuyerMentorshipPayment({...args(),env:recoveryEnv})).toEqual({status:"payment_recovery_recorded",outcome:"paid_accounted"});
  expect(mockRpc.mock.calls.map(c=>c[0])).toEqual(["record_buyer_mentorship_later_receipt_v1","begin_buyer_mentorship_payment_recovery_v1","finish_buyer_mentorship_payment_recovery_v1"]);
});
test.each(["lost accounting reply","invalid paid capture","failed invoice read"])("%s cannot manufacture a recovery hold or acknowledge payment",async scenario=>{
  if(scenario==="lost accounting reply")mockRpc.mockRejectedValue(Error("lost response"));
  if(scenario==="invalid paid capture")charge.amount_refunded=1;
  if(scenario==="failed invoice read")api.invoices.retrieve.mockRejectedValue(Error("unavailable"));
  const {recoverBuyerMentorshipPayment}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  await expect(recoverBuyerMentorshipPayment({...args(),env:recoveryEnv})).rejects.toThrow("requires review");
  expect(mockRpc.mock.calls.map(c=>c[0])).toEqual(scenario==="lost accounting reply"?["record_buyer_mentorship_later_receipt_v1"]:[]);
});
test("changed recovery basis retains reconciliation instead of acknowledging failure",async()=>{
  unpaidRecovery("requires_action");const original=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation((name,p)=>name==="finish_buyer_mentorship_payment_recovery_v1"?{error:null,data:false}:original(name,p));
  const {recoverBuyerMentorshipPayment}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  expect((await recoverBuyerMentorshipPayment({...args(),env:recoveryEnv})).status).toBe("reconciliation_required");
});

async function bankFixture() {
  unpaidRecovery("requires_action");
  const {buyerMentorshipActivationParams}=await import("../lib/mentorshipInstallmentActivation");
  const first=rows.buyer_mentorship_first_receipts_v1.proof;
  const params=buyerMentorshipActivationParams(first.paidAt,3,"pm_owned");
  rows.buyer_mentorship_invoice_claims_v1.authorization_snapshot.cancelAt=params.cancel_at;
  const subscription={...f.data.subscription,...params,billing_cycle_anchor:params.trial_end,status:"past_due",
    metadata:{...f.data.subscription.metadata,...params.metadata}};
  api.subscriptions.retrieve=jest.fn(async()=>subscription);
  api.customers={retrieve:jest.fn(async()=>({...f.data.customer,balance:0,default_source:null,invoice_settings:{default_payment_method:"pm_owned"}}))};
  api.paymentMethods={retrieve:jest.fn(async()=>f.data.paymentMethod)};
  api.paymentIntents.retrieve=jest.fn(async(id:string)=>id==="pi_owned"?f.data.paymentIntent:intent);
  api.charges.retrieve=jest.fn(async(id:string)=>id==="ch_owned"?f.data.charge:charge);
  Object.assign(intent,{capture_method:"automatic",confirmation_method:"automatic",next_action:{type:"use_stripe_sdk"},client_secret:"pi_due_secret_synthetic"});
  const snapshot={reservationId:f.reservation.id,paymentIntentId:"pi_due",paymentMethodId:"pm_owned",prior:[{paymentNumber:1,paymentIntentId:"pi_owned"}],
    firstProof:first,dependencies:f.dependencies,billing:{revision:7},recovery:{revision:1}};
  mockRpc.mockResolvedValue({error:null,data:snapshot});
  return {subscription,snapshot,env:{...recoveryEnv,CREATOR_MENTORSHIP_INSTALLMENT_BANK_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_BANK_READY:"true",NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:"pk_test_synthetic"}};
}
test("bank challenge exposes only original SDK capability after current history/subscription and SQL recheck",async()=>{
  const state=await bankFixture();const {readBuyerMentorshipBankChallenge}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  expect(await readBuyerMentorshipBankChallenge({...args(),env:state.env})).toEqual({status:"bank_verification_ready",amountCents:3333,paymentNumber:2,publishableKey:"pk_test_synthetic",clientSecret:"pi_due_secret_synthetic"});
  expect(mockRpc).toHaveBeenCalledTimes(2);expect(mockRpc.mock.calls[1]).toEqual(mockRpc.mock.calls[0]);
  expect(api.subscriptions.retrieve).toHaveBeenCalledTimes(2);
});
test.each(["stop race","non-US card","provider canceled","changed original payment"])("bank challenge refuses %s",async problem=>{
  const state=await bankFixture();
  if(problem==="stop race")mockRpc.mockResolvedValueOnce({error:null,data:state.snapshot}).mockResolvedValueOnce({error:{message:"revoked"},data:null});
  if(problem==="non-US card")f.data.paymentMethod.billing_details.address!.country="CA";
  if(problem==="provider canceled")state.subscription.status="canceled";
  if(problem==="changed original payment")intent.id="pi_other";
  const {readBuyerMentorshipBankChallenge}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  await expect(readBuyerMentorshipBankChallenge({...args(),env:state.env})).rejects.toThrow("Bank verification unavailable");
});
test.each(["created","lost create response","stop before dispatch"])("buyer card setup composes original operation: %s",async scenario=>{
  const state=await bankFixture();intent.status="requires_payment_method";intent.payment_method=null;state.subscription.ended_at=null;
  state.subscription.pause_collection={behavior:"keep_as_draft",resumes_at:null};
  state.subscription.payment_settings={payment_method_types:["card"],save_default_payment_method:"off"};
  const {exactCardSetupParams}=await import("../lib/installments/cardRecovery");
  const setupId="10000000-0000-4000-8000-000000000099",createdAt=Math.floor(Date.now()/1000);
  const a={...rows.buyer_mentorship_invoice_claims_v1.authorization_snapshot,paymentMethodId:"pm_owned"};
  const params=exactCardSetupParams({id:setupId,buyerId:f.reservation.buyerId,buyerReservationId:f.reservation.id,buyerRequestId:f.reservation.requestId,
    invoiceId:"in_due",originalPaymentIntentId:"pi_due",authorization:a,createdAt,expiresAt:createdAt+3600,sessionId:null,setupIntentId:null,paymentMethodId:null},f.context.siteOrigin);
  const setup={id:setupId,reservation_id:f.reservation.id,buyer_id:f.reservation.buyerId,invoice_id:"in_due",original_payment_intent_id:"pi_due",
    authorization_snapshot:a,created_at:new Date(createdAt*1000).toISOString(),expires_at:createdAt+3600,
    request:{apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params},idempotency_key:`cn-buyer-card-setup-v1:${setupId}`};
  const session={...params,id:"cs_test_setup",object:"checkout.session",livemode:false,created:createdAt,
    payment_intent:null,subscription:null,invoice:null,payment_status:"no_payment_required",amount_total:null};
  api.checkout={sessions:{create:jest.fn(async()=>session),retrieve:jest.fn(async()=>session)}};
  let binding:any=null;
  mockRpc.mockImplementation(async(name:string)=>{
    if(name==="read_buyer_mentorship_recovery_action_context_v1")return {data:state.snapshot,error:null};
    if(name==="record_buyer_mentorship_saved_card_v1")return {data:{status:"card_saved_payment_not_attempted",setupId,paymentAllowed:false,
      proof:{session_id:session.id,setup_intent_id:"seti_original",payment_method_id:"pm_replacement",billing_country:"US"}},error:null};
    if(name==="admit_buyer_mentorship_card_setup_v1" && scenario==="stop before dispatch")return {error:{message:"stopped"}};
    if(name==="bind_buyer_mentorship_card_setup_v1")binding={setup_id:setupId,session_id:session.id};
    return {error:null,data:{setup,paymentAllowed:false,binding,dispatchAllowed:true,dispatchBefore:new Date(Date.now()+30000).toISOString()}};
  });
  if(scenario==="lost create response")api.checkout.sessions.create.mockRejectedValueOnce(Error("lost"));
  const {prepareBuyerMentorshipCardSetup}=await import("../lib/mentorshipInstallmentCardSetup");
  const request={...args(),setupId,consent:{accepted:true,consentVersion:"replacement-card-setup-v1"},
    env:{...state.env,CREATOR_MENTORSHIP_INSTALLMENT_CARD_SETUP_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_CARD_SETUP_READY:"true"}};
  if(scenario!=="created")await expect(prepareBuyerMentorshipCardSetup(request)).rejects.toThrow("Keep the original request");
  if(scenario==="stop before dispatch")expect(api.checkout.sessions.create).not.toHaveBeenCalled();
  else {
    expect(await prepareBuyerMentorshipCardSetup(request)).toEqual({status:"prepared_unpublished",setupId,sessionId:session.id});
    expect(api.checkout.sessions.create).toHaveBeenLastCalledWith(params,expect.objectContaining({idempotencyKey:setup.idempotency_key,maxNetworkRetries:0}));
    const count=api.checkout.sessions.create.mock.calls.length;
    await prepareBuyerMentorshipCardSetup(request);expect(api.checkout.sessions.create).toHaveBeenCalledTimes(count);
    if(scenario==="lost create response")expect(api.checkout.sessions.create.mock.calls[0]).toEqual(api.checkout.sessions.create.mock.calls[1]);
    if(scenario==="created") {
      const {verifyBuyerMentorshipSavedCard,readBuyerMentorshipCardSetupRedirect}=await import("../lib/mentorshipInstallmentCardSetup");
      const verification={...request,env:{...request.env,CREATOR_MENTORSHIP_INSTALLMENT_SAVED_CARD_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_SAVED_CARD_READY:"true"}};
      Object.assign(session,{status:"open",setup_intent:null});
      const publication={...verification,env:{...verification.env,CREATOR_MENTORSHIP_INSTALLMENT_CARD_SETUP_PUBLISH_READY:"true"}};
      Object.assign(session,{url:`https://checkout.stripe.com/c/setup/${session.id}`});
      expect(await readBuyerMentorshipCardSetupRedirect(publication)).toMatchObject({status:"card_setup_ready",setupId,url:`https://checkout.stripe.com/c/setup/${session.id}`});
      Object.assign(session,{url:`https://checkout.stripe.com.evil.invalid/c/setup/${session.id}`});
      await expect(readBuyerMentorshipCardSetupRedirect(publication)).rejects.toThrow("Secure card setup is unavailable");
      expect(await verifyBuyerMentorshipSavedCard(verification)).toEqual({status:"setup_pending",setupId});
      Object.assign(session,{status:"complete",setup_intent:"seti_original"});
      await expect(readBuyerMentorshipCardSetupRedirect(publication)).rejects.toThrow("Secure card setup is unavailable");
      api.setupIntents={retrieve:jest.fn(async()=>({id:"seti_original",object:"setup_intent",livemode:false,customer:a.customerId,
        metadata:params.metadata,created:createdAt,usage:"off_session",on_behalf_of:null,payment_method_types:["card"],status:"succeeded",payment_method:"pm_replacement"}))};
      const replacement={id:"pm_replacement",object:"payment_method",livemode:false,customer:a.customerId,type:"card",billing_details:{address:{country:"US"}}};
      api.paymentMethods.retrieve=jest.fn(async(id:string)=>id==="pm_replacement"?replacement:f.data.paymentMethod);
      expect(await verifyBuyerMentorshipSavedCard(verification)).toEqual({status:"card_saved_payment_not_attempted",setupId});
      expect(api.setupIntents.retrieve).toHaveBeenCalledWith("seti_original");
      const writes=mockRpc.mock.calls.filter(([name])=>name==="record_buyer_mentorship_saved_card_v1");
      expect(writes).toHaveLength(1);expect(writes[0][1]).toMatchObject({p_basis:state.snapshot,p_session_id:session.id});
      replacement.billing_details.address.country="CA";
      await expect(verifyBuyerMentorshipSavedCard(verification)).rejects.toThrow("Saved card could not be verified");
      expect(mockRpc.mock.calls.filter(([name])=>name==="record_buyer_mentorship_saved_card_v1")).toHaveLength(1);
      expect(api.checkout.sessions.create).toHaveBeenCalledTimes(count);
    }
  }
});

const retryRecoveryFlags={CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RETRY_RECEIPT_READY:"true"};
test.each([["requires_action","action_required"],["requires_payment_method","payment_method_required"],["processing","payment_pending"]])("replacement %s is classified without redispatch",async(status,outcome)=>{
  unpaidRecovery(status);replacementAttempt();
  const {recoverBuyerMentorshipPayment}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  expect(await recoverBuyerMentorshipPayment({...args(),env:{...recoveryEnv,...retryRecoveryFlags}})).toEqual({status:"payment_recovery_recorded",outcome});
});
test("replacement recovery refuses missing consent before saving an outcome",async()=>{
  unpaidRecovery("requires_action");replacementAttempt();rows.buyer_mentorship_retry_consents_v1=null;
  const {recoverBuyerMentorshipPayment}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  await expect(recoverBuyerMentorshipPayment({...args(),env:{...recoveryEnv,...retryRecoveryFlags}})).rejects.toThrow("requires review");
  expect(mockRpc.mock.calls.map(c=>c[0])).toEqual(["begin_buyer_mentorship_payment_recovery_v1"]);
});
test.each(["authorized","non-US replacement","missing consent","stop race"])("replacement bank challenge: %s",async scenario=>{
  const state=await bankFixture();replacementAttempt();
  api.paymentMethods.retrieve=jest.fn(async(id:string)=>id==="pm_replacement"?{...f.data.paymentMethod,id,billing_details:{address:{country:scenario==="non-US replacement"?"CA":"US"}}}:f.data.paymentMethod);
  if(scenario==="missing consent")rows.buyer_mentorship_retry_consents_v1=null;
  if(scenario==="stop race")mockRpc.mockResolvedValueOnce({error:null,data:state.snapshot}).mockResolvedValueOnce({error:{message:"revoked"},data:null});
  const {readBuyerMentorshipBankChallenge}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  const call=readBuyerMentorshipBankChallenge({...args(),env:{...state.env,...retryRecoveryFlags}});
  if(scenario==="authorized")expect(await call).toMatchObject({status:"bank_verification_ready",clientSecret:"pi_due_secret_synthetic"});
  else await expect(call).rejects.toThrow("Bank verification unavailable");
});

test.each(["authorized","non-US card","changed subscription","stop race","refund race","missing receipt","release","lost release reply","recover release","new hold"])("future-card runtime: %s",async scenario=>{
  const paidInvoice=structuredClone(invoice),paidIntent=structuredClone(intent),paidLink=structuredClone(link);
  const state=await bankFixture();Object.assign(invoice,paidInvoice);Object.assign(intent,paidIntent);Object.assign(link,paidLink);
  replacementAttempt();state.subscription.status="active";
  const a=rows.buyer_mentorship_invoice_claims_v1.authorization_snapshot,quoteId=rows.buyer_mentorship_retry_quotes_v1.id;
  const first=rows.buyer_mentorship_first_receipts_v1.proof;
  rows.buyer_mentorship_bootstraps_v1={reservation_id:f.reservation.id,customer_id:a.customerId,anchor_seconds:f.dependencies.anchorSeconds};
  rows.buyer_mentorship_bootstrap_operations_v1={reservation_id:f.reservation.id,result_id:f.dependencies.productId,bound_at:new Date().toISOString()};
  api.paymentMethods.retrieve=jest.fn(async(id:string)=>id==="pm_replacement"?{...f.data.paymentMethod,id,billing_details:{address:{country:scenario==="non-US card"?"CA":"US"}}}:f.data.paymentMethod);
  const basis={reservationId:f.reservation.id,quoteId,afterPaymentNumber:2,paymentMethodId:"pm_replacement",originalDefaultPaymentMethodId:"pm_owned",
    remainingPayments:[{paymentNumber:3,amountCents:3335,dueAt:a.periodEnd,periodEnd:a.cancelAt}],
    prior:[{paymentNumber:1,paymentIntentId:"pi_owned"},{paymentNumber:2,paymentIntentId:"pi_due"}],firstProof:first,billing:{revision:9}};
  rows.buyer_mentorship_invoice_cards_v1={reservation_id:f.reservation.id,payment_number:2,invoice_id:"in_due",payment_method_id:"pm_owned",original_default_payment_method_id:"pm_owned",authorization_quote_id:null};
  const resume=["release","lost release reply","recover release","new hold"].includes(scenario);
  const previousRelease=["recover release","new hold"].includes(scenario);
  if(previousRelease)rows.buyer_mentorship_collection_releases_v1={quote_id:quoteId,reservation_id:f.reservation.id,verified_basis:basis};
  let reads=0;
  mockRpc.mockImplementation(async(name:string)=>{
    if(name==="read_buyer_mentorship_future_card_context_v1") {
      reads++;return scenario==="missing receipt" || scenario==="stop race" && reads>1?{error:{message:"unavailable"},data:null}:{error:null,data:basis};
    }
    if(name==="release_buyer_mentorship_future_collection_v1") {
      if(scenario==="lost release reply")throw Error("lost reply");
      if(scenario==="new hold")return {error:{message:"new hold"},data:null};
      return {error:null,data:{status:"collection_resumed",reservationId:f.reservation.id,quoteId}};
    }
    return {error:null,data:{status:"authorized_held",reservationId:f.reservation.id,quoteId}};
  });
  if(scenario==="changed subscription")state.subscription.default_payment_method="pm_replacement";
  if(scenario==="refund race")f.data.charge.refunded=true;
  const {authorizeBuyerMentorshipFutureCard,resumeBuyerMentorshipFutureCollection}=await import("../lib/mentorshipInstallmentFutureCard");
  const call=(resume?resumeBuyerMentorshipFutureCollection:authorizeBuyerMentorshipFutureCard)({...args(),quoteId,env:{...env,...retryRecoveryFlags,
    ...Object.fromEntries(["COLLECTION_RELEASE_SCHEMA_READY","COLLECTION_RELEASE_RECOVERY_READY","COLLECTION_RELEASE_READY","FUTURE_COLLECTION_READY","INVOICE_CARD_SCHEMA_READY","CARD_RECOVERY_SCHEMA_READY"].map(k=>[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`,resume&&!previousRelease?"true":"false"])),
    ...(previousRelease?{CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_RELEASE_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_RELEASE_RECOVERY_READY:"true"}:{}),
    CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_READY:previousRelease?"false":"true"}});
  if(["authorized","release","recover release"].includes(scenario)) {
    expect(await call).toEqual({status:resume?"collection_resumed":"authorized_held"});
    const calls=mockRpc.mock.calls.map(c=>c[0]);
    if(previousRelease)expect(calls).toEqual(["release_buyer_mentorship_future_collection_v1"]);
    else expect(calls).toEqual(["read_buyer_mentorship_future_card_context_v1","read_buyer_mentorship_future_card_context_v1","authorize_buyer_mentorship_future_card_v1",
      ...(resume?["read_buyer_mentorship_future_card_context_v1","release_buyer_mentorship_future_collection_v1"]:[])]);
  } else {
    await expect(call).rejects.toThrow("requires review");
    if(scenario!=="lost release reply")expect(mockRpc.mock.calls.some(c=>c[0]==="authorize_buyer_mentorship_future_card_v1")).toBe(false);
  }
});

test.each(["authorized","missing binding","changed period","missing authorization","wrong original default","schema off"])("future installment card binding: %s",async scenario=>{
  const remaining=futureInvoiceCard();
  if(scenario==="missing binding")rows.buyer_mentorship_invoice_cards_v1=null;
  if(scenario==="changed period")remaining[0].dueAt++;
  if(scenario==="missing authorization")rows.buyer_mentorship_future_card_authorizations_v1=null;
  if(scenario==="wrong original default")rows.buyer_mentorship_invoice_cards_v1.original_default_payment_method_id="pm_other";
  const call=reconcileBuyerMentorshipInvoice({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_INVOICE_CARD_SCHEMA_READY:scenario==="schema off"?"false":"true",
    CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_SCHEMA_READY:"true"}});
  if(scenario==="authorized") {
    expect((await call).status).toBe("credited");expect(mockRpc.mock.calls[0][1].p_proof).toMatchObject({paymentMethodId:"pm_replacement",paymentNumber:3,amountCents:3335});
  } else {await expect(call).rejects.toThrow("requires review");expect(mockRpc).not.toHaveBeenCalled();}
});

function futureInvoiceCard() {
  finalInstallment();const a=rows.buyer_mentorship_invoice_claims_v1.authorization_snapshot;
  const quoteId="10000000-0000-4000-8000-000000000088";
  intent.payment_method=charge.payment_method=rows.buyer_mentorship_payment_admissions_v1.payment_method_id="pm_replacement";
  rows.buyer_mentorship_payment_admissions_v1.request.params.payment_method="pm_replacement";
  rows.buyer_mentorship_invoice_cards_v1={reservation_id:f.reservation.id,payment_number:3,invoice_id:"in_due",payment_method_id:"pm_replacement",
    original_default_payment_method_id:"pm_owned",authorization_quote_id:quoteId};
  const remaining=[{paymentNumber:3,amountCents:3335,dueAt:a.periodStart,periodEnd:a.periodEnd}];
  rows.buyer_mentorship_future_card_authorizations_v1={quote_id:quoteId,reservation_id:f.reservation.id,after_payment_number:2,
    payment_method_id:"pm_replacement",original_default_payment_method_id:"pm_owned",remaining_periods:remaining,
    verified_basis:{reservationId:f.reservation.id,quoteId,afterPaymentNumber:2,paymentMethodId:"pm_replacement",originalDefaultPaymentMethodId:"pm_owned",remainingPayments:remaining}};
  return remaining;
}

test("future installment bank verification checks selected card while retaining original subscription default",async()=>{
  const state=await bankFixture();futureInvoiceCard();
  // finalInstallment initializes paid evidence; restore unpaid action and the
  // two independently captured prior payments for this third installment.
  Object.assign(invoice,{status:"open",amount_paid:0,amount_remaining:3335});
  Object.assign(intent,{status:"requires_action",amount_received:0,amount_capturable:0,latest_charge:null,canceled_at:null,
    capture_method:"automatic",confirmation_method:"automatic",next_action:{type:"use_stripe_sdk"},client_secret:"pi_due_secret_synthetic"});
  Object.assign(link,{status:"open",amount_paid:0});
  state.snapshot.paymentMethodId="pm_replacement";
  Object.assign(state.snapshot,{defaultPaymentMethodId:"pm_owned",cardAuthorizationId:"10000000-0000-4000-8000-000000000088"});
  state.snapshot.prior.push({paymentNumber:2,paymentIntentId:"pi_prior"});
  api.paymentIntents.retrieve=jest.fn(async(id:string)=>id==="pi_owned"?f.data.paymentIntent:id==="pi_prior"?
    {...f.data.paymentIntent,id,latest_charge:"ch_prior",application_fee_amount:527}:intent);
  api.charges.retrieve=jest.fn(async(id:string)=>id==="ch_owned"?f.data.charge:id==="ch_prior"?{...f.data.charge,id,payment_intent:"pi_prior"}:charge);
  api.paymentMethods.retrieve=jest.fn(async(id:string)=>({...f.data.paymentMethod,id}));
  mockRpc.mockResolvedValue({error:null,data:state.snapshot});
  const {readBuyerMentorshipBankChallenge}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  expect(await readBuyerMentorshipBankChallenge({...args(),env:{...state.env,CREATOR_MENTORSHIP_INSTALLMENT_INVOICE_CARD_SCHEMA_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_CARD_RECOVERY_SCHEMA_READY:"true"}}))
    .toMatchObject({status:"bank_verification_ready",amountCents:3335,paymentNumber:3});
  expect(state.subscription.default_payment_method).toBe("pm_owned");
});


test.each(["no future consent","release unavailable","recovery snapshot changed"])("paid recovery preserves accounting when %s",async scenario=>{
  replacementAttempt();
  rows.buyer_mentorship_retry_quotes_v1.future_card_option=true;
  rows.buyer_mentorship_retry_consents_v1.future_card_accepted=scenario!=="no future consent";
  mockRpc.mockImplementation(async(name)=>({error:null,data:name==="begin_buyer_mentorship_payment_recovery_v1"?
    {reservationId:f.reservation.id,paymentIntentId:"pi_due",paymentNumber:2,revision:7,recoveryRevision:0,paidCount:2,countedAt:"saved"}:
    name==="record_buyer_mentorship_later_receipt_v1"?{recorded:true,reservationId:f.reservation.id,paymentNumber:2,purchaseId,ledgerId}:
    scenario!=="recovery snapshot changed"}));
  const {recoverBuyerMentorshipPayment}=await import("../lib/mentorshipInstallmentPaymentRecovery");
  const result=await recoverBuyerMentorshipPayment({...args(),env:{...recoveryEnv,
    CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RETRY_RECEIPT_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY:"true"}});
  expect(result).toEqual(scenario==="recovery snapshot changed"?{status:"reconciliation_required"}:
    {status:"payment_recovery_recorded",outcome:"paid_accounted",futureCollection:scenario==="no future consent"?"not_requested":"review_required"});
  expect(mockRpc.mock.calls.filter(c=>c[0]==="record_buyer_mentorship_later_receipt_v1")).toHaveLength(1);
  expect(mockRpc.mock.calls.some(c=>c[0]==="release_buyer_mentorship_future_collection_v1")).toBe(false);
});

test.each(["release","non-US card","changed subscription","stop race","refund race","missing receipt","wrong card","stale basis","lost reply","recover reply","new hold","disabled release","not held","complete"])("same-card continuation runtime: %s",async scenario=>{
  const paidInvoice=structuredClone(invoice),paidIntent=structuredClone(intent),paidLink=structuredClone(link);
  const state=await bankFixture();Object.assign(invoice,paidInvoice);Object.assign(intent,paidIntent);Object.assign(link,paidLink);
  state.subscription.status="active";
  const a=rows.buyer_mentorship_invoice_claims_v1.authorization_snapshot,first=rows.buyer_mentorship_first_receipts_v1.proof;
  rows.buyer_mentorship_bootstraps_v1={reservation_id:f.reservation.id,customer_id:a.customerId,anchor_seconds:f.dependencies.anchorSeconds};
  rows.buyer_mentorship_bootstrap_operations_v1={reservation_id:f.reservation.id,result_id:f.dependencies.productId,bound_at:new Date().toISOString()};
  rows.buyer_mentorship_invoice_cards_v1={reservation_id:f.reservation.id,payment_number:2,invoice_id:"in_due",payment_method_id:"pm_owned",original_default_payment_method_id:"pm_owned",authorization_quote_id:null};
  const basis={status:"held",reservationId:f.reservation.id,invoiceId:"in_due",afterPaymentNumber:2,paymentMethodId:"pm_owned",originalDefaultPaymentMethodId:"pm_owned",cardAuthorizationId:null,
    remainingPayments:[{paymentNumber:3,amountCents:3335,dueAt:a.periodEnd,periodEnd:a.cancelAt}],
    prior:[{paymentNumber:1,paymentIntentId:"pi_owned"},{paymentNumber:2,paymentIntentId:"pi_due"}],firstProof:first,billing:{revision:9}};
  const replay=["recover reply","new hold"].includes(scenario);
  if(replay)rows.buyer_mentorship_same_card_releases_v1={reservation_id:f.reservation.id,payment_number:2,verified_basis:basis};
  let reads=0;
  mockRpc.mockImplementation(async(name:string)=>{
    if(name==="read_buyer_mentorship_same_card_context_v1") {
      reads++;
      if(scenario==="missing receipt" || scenario==="stop race" && reads>1)return {error:{message:"unavailable"},data:null};
      if(scenario==="not held" || scenario==="complete")return {error:null,data:{status:scenario==="complete"?"complete":"not_held",reservationId:f.reservation.id}};
      return {error:null,data:scenario==="stale basis" && reads>1?{...basis,billing:{revision:10}}:basis};
    }
    if(name==="release_buyer_mentorship_same_card_v1") {
      if(scenario==="lost reply")throw Error("lost response");
      if(scenario==="new hold")return {error:{message:"new hold"},data:null};
      return {error:null,data:{status:"collection_resumed",reservationId:f.reservation.id,invoiceId:"in_due"}};
    }
    throw Error("Unexpected mutation");
  });
  if(scenario==="non-US card")f.data.paymentMethod.billing_details.address!.country="CA";
  if(scenario==="changed subscription")state.subscription.default_payment_method="pm_other";
  if(scenario==="refund race")f.data.charge.refunded=true;
  if(scenario==="wrong card")basis.paymentMethodId="pm_other";
  const {resumeBuyerMentorshipSameCard}=await import("../lib/mentorshipInstallmentSameCard");
  const call=resumeBuyerMentorshipSameCard({...args(),env:{...env,
    ...Object.fromEntries(["SAME_CARD_SCHEMA_READY","SAME_CARD_RECOVERY_READY","INVOICE_CARD_SCHEMA_READY"].map(k=>[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`,"true"])),
    CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RELEASE_READY:scenario==="disabled release" || replay?"false":"true"}});
  if(["release","recover reply","not held","complete"].includes(scenario)) {
    expect(await call).toBe(scenario==="not held"?"not_requested":scenario==="complete"?"complete":"collection_resumed");
    if(replay)expect(mockRpc.mock.calls.map(c=>c[0])).toEqual(["release_buyer_mentorship_same_card_v1"]);
  } else {
    await expect(call).rejects.toThrow();
    if(!["lost reply","new hold"].includes(scenario))expect(mockRpc.mock.calls.some(c=>c[0]==="release_buyer_mentorship_same_card_v1")).toBe(false);
  }
  expect(mockRpc.mock.calls.every(c=>["read_buyer_mentorship_same_card_context_v1","release_buyer_mentorship_same_card_v1"].includes(c[0]))).toBe(true);
});
