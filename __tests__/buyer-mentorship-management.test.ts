import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {inspectBuyerMentorshipFirstCapture} from "../lib/mentorshipInstallmentReceipt";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockRetryReview=jest.fn();
jest.mock("../lib/mentorshipInstallmentRetry",()=>({readBuyerMentorshipRetryReview:(...args:unknown[])=>mockRetryReview(...args)}));
const mockConfig=jest.fn(),mockObserve=jest.fn(),mockReservation=jest.fn();
let db:ReturnType<typeof createMockClient>,f:ReturnType<typeof buyerFirstCaptureFixture>,rows:Record<string,any>;
jest.mock("@supabase/supabase-js",()=>({createClient:()=>db}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>mockConfig()}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("@/lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...a:unknown[])=>mockReservation(...a)}));
import {readBuyerMentorshipManagement} from "../lib/mentorshipInstallmentManagement";
const env=Object.fromEntries(["MANAGEMENT_READY","RESERVATIONS_SCHEMA_READY","LATER_RECEIPT_SCHEMA_READY","RECOVERY_SCHEMA_READY","RECOVERY_READY","BANK_READY","BANK_SCHEMA_READY"].map(k=>[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`,"true"]));
const args=()=>({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,env});
beforeEach(()=>{
  jest.clearAllMocks();f=buyerFirstCaptureFixture();const proof=inspectBuyerMentorshipFirstCapture(f),r=f.reservation;
  mockConfig.mockReturnValue({approvedContext:f.context,configuredSupabaseUrl:f.contextEvidence.configuredSupabaseUrl,supabaseServiceKey:"synthetic"});
  mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});mockReservation.mockResolvedValue(r);
  rows={buyer_mentorship_first_receipts_v1:{reservation_id:r.id,payment_intent_id:proof.paymentIntentId,proof},
    buyer_mentorship_billing_state_v1:{reservation_id:r.id,paid_count:1,service_end_at:proof.serviceEndsAt,financial_hold_at:null,debit_revoked_at:null,collection_enabled_at:null,collection_hold_at:null},
    buyer_mentorship_collection_periods_v1:[{reservation_id:r.id,payment_number:2,invoice_id:"in_due",due_at:proof.nextPaymentAt,amount_cents:3333,counted_at:null,admitted_at:"2026-09-21"}],
    buyer_mentorship_payment_recoveries_v1:[{reservation_id:r.id,payment_number:2,invoice_id:"in_due",payment_intent_id:"pi_due",outcome:"action_required"}],
    read_buyer_mentorship_credited_payment_v1:{reservationId:r.id,proof}};
  db=createMockClient(op=>({error:null,data:rows[op.table]??null}));
});
test("owned management projects original terms and verified receipt without provider capabilities",async()=>{
  const view=await readBuyerMentorshipManagement(args());expect(view).toMatchObject({totalCents:10001,paymentCount:3,payments:[{paymentNumber:1,outcome:"paid_accounted"},{paymentNumber:2,canVerifyBank:true,canCheck:true}]});
  expect(JSON.stringify(view)).not.toMatch(/clientSecret|idempotency|destinationId|pi_owned/);
  expect(db.ops.every(op=>op.kind==="select" || op.table==="read_buyer_mentorship_credited_payment_v1")).toBe(true);
});
test.each(["financial_hold_at","debit_revoked_at"])("%s removes bank verification eligibility",async field=>{
  rows.buyer_mentorship_billing_state_v1[field]="2026-09-21";
  expect((await readBuyerMentorshipManagement(args()))!.payments[1].canVerifyBank).toBe(false);
});
test("saved outcome cannot claim payment without counted receipt",async()=>{
  rows.buyer_mentorship_payment_recoveries_v1[0].outcome="paid_accounted";
  await expect(readBuyerMentorshipManagement(args())).rejects.toThrow("require review");
});
test("foreign reservation returns no payment data",async()=>{
  mockReservation.mockResolvedValue(null);expect(await readBuyerMentorshipManagement(args())).toBeNull();expect(db.ops).toHaveLength(0);
});
test("debit stop eligibility requires both gates and disappears after revocation",async()=>{
  expect((await readBuyerMentorshipManagement(args()))!.canStopDebit).toBe(false);
  const enabled={...env,CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_STOP_READY:"true"};
  expect((await readBuyerMentorshipManagement({...args(),env:enabled}))!.canStopDebit).toBe(true);
  rows.buyer_mentorship_billing_state_v1.debit_revoked_at="2026-09-21";
  expect((await readBuyerMentorshipManagement({...args(),env:enabled}))!.canStopDebit).toBe(false);
});
function cardRows() {
  const enabled={...env,...Object.fromEntries(["CARD_SETUP_SCHEMA_READY","SAVED_CARD_SCHEMA_READY","CARD_SETUP_READY","CARD_SETUP_PUBLISH_READY","SAVED_CARD_READY"].map(k=>[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`,"true"]))};
  const setupId="10000000-0000-4000-8000-000000000099";
  rows.buyer_mentorship_payment_recoveries_v1[0].outcome="payment_method_required";
  rows.buyer_mentorship_card_setup_requests_v1=[{id:setupId,reservation_id:f.reservation.id,buyer_id:f.reservation.buyerId,payment_number:2,
    invoice_id:"in_due",original_payment_intent_id:"pi_due",expires_at:Math.floor(Date.now()/1000)+3600}];
  return {enabled,setupId};
}
test("management recovers original setup identity without exposing provider identifiers or capabilities",async()=>{
  const {enabled,setupId}=cardRows();
  const read=()=>readBuyerMentorshipManagement({...args(),env:enabled});
  expect((await read())!.payments[1]).toMatchObject({canStartCard:false,cardSetup:{requestId:setupId,state:"reserved",canPrepare:true,canOpen:false}});
  rows.buyer_mentorship_card_setup_bindings_v1={setup_id:setupId,session_id:"cs_test_private"};
  expect((await read())!.payments[1].cardSetup).toMatchObject({state:"prepared",canPrepare:false,canOpen:true,canVerify:true});
  rows.buyer_mentorship_saved_card_proofs_v1={setup_id:setupId,session_id:"cs_test_private",billing_country:"US"};
  const verified=await read();expect(verified!.payments[1].cardSetup).toMatchObject({state:"verified",canOpen:false,canVerify:false});
  expect(JSON.stringify(verified)).not.toMatch(/cs_test_private|pi_due|idempotency|clientSecret/);
});
test.each(["expired","stopped"])("%s setup cannot start a new request or open its link",async scenario=>{
  const {enabled}=cardRows();
  if(scenario==="expired")rows.buyer_mentorship_card_setup_requests_v1[0].expires_at=1;
  else rows.buyer_mentorship_billing_state_v1.debit_revoked_at="2026-09-21";
  expect((await readBuyerMentorshipManagement({...args(),env:enabled}))!.payments[1]).toMatchObject({canStartCard:false,cardSetup:{canPrepare:false,canOpen:false}});
});
test("missing saved setup allows only separately gated first setup",async()=>{
  const {enabled}=cardRows();rows.buyer_mentorship_card_setup_requests_v1=[];
  expect((await readBuyerMentorshipManagement({...args(),env:enabled}))!.payments[1].canStartCard).toBe(true);
});

function retryRows() {
  const {enabled,setupId}=cardRows();
  for(const flag of ["RETRY_SCHEMA_READY","RETRY_ACTIONS_READY","RETRY_READY","RETRY_RECEIPT_READY","RETRY_RECOVERY_SCHEMA_READY","RECONCILIATION_READY"])
    enabled[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]="true";
  rows.buyer_mentorship_card_setup_bindings_v1={setup_id:setupId,session_id:"cs_test_private"};
  rows.buyer_mentorship_saved_card_proofs_v1={setup_id:setupId,session_id:"cs_test_private",billing_country:"US"};
  const quote={id:"10000000-0000-4000-8000-000000000088",amountCents:3333,paymentNumber:2,paymentCount:3,expiresAt:Math.floor(Date.now()/1000)+100,confirmed:false};
  mockRetryReview.mockResolvedValue({admitted:false,quote});return {enabled,setupId,quote};
}
test("management exposes the saved review without preparing or dispatching a retry",async()=>{
  const {enabled,setupId,quote}=retryRows();
  expect((await readBuyerMentorshipManagement({...args(),env:enabled}))!.payments[1].retry).toEqual({admitted:false,quote,canReview:true,canPay:true,canUseFutureCard:false});
  expect(mockRetryReview).toHaveBeenCalledWith({...args(),env:enabled,invoiceId:"in_due",setupId});
  expect(db.ops.every(op=>op.kind==="select" || op.table==="read_buyer_mentorship_credited_payment_v1")).toBe(true);
});
test.each(["admitted","expired quote","stopped","financial hold","gate off"])("%s disables pay while preserving the saved review",async problem=>{
  const {enabled,quote}=retryRows();
  if(problem==="admitted")mockRetryReview.mockResolvedValue({admitted:true,quote});
  if(problem==="expired quote")quote.expiresAt=1;
  if(problem==="stopped")rows.buyer_mentorship_billing_state_v1.debit_revoked_at="2026-09-21";
  if(problem==="financial hold")rows.buyer_mentorship_billing_state_v1.financial_hold_at="2026-09-21";
  if(problem==="gate off")enabled.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_ACTIONS_READY="false";
  const view=await readBuyerMentorshipManagement({...args(),env:enabled});
  expect(view!.payments[1].retry).toMatchObject({quote,canPay:false});
});


test.each(["authorized","paused","not_activated","stopped","review"])("management reads current collection state: %s",async state=>{
  const b=rows.buyer_mentorship_billing_state_v1;
  b.collection_enabled_at=state==="not_activated"?null:"2026-09-21T00:00:00Z";
  b.collection_hold_at=state==="paused"?"2026-09-21T00:01:00Z":null;
  if(state==="stopped")b.debit_revoked_at="2026-09-21T00:02:00Z";
  if(state==="review")b.financial_hold_at="2026-09-21T00:02:00Z";
  expect((await readBuyerMentorshipManagement({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY:"true"}}))!.collectionState).toBe(state);
  expect(db.ops.every(op=>op.kind==="select" || op.table==="read_buyer_mentorship_credited_payment_v1")).toBe(true);
});


test.each([true,false])("paid receipt can recover a still-held future authorization only with handoff gate: %s",async enabled=>{
  rows.buyer_mentorship_billing_state_v1.paid_count=2;
  rows.buyer_mentorship_billing_state_v1.collection_hold_at="2026-09-21T00:00:00Z";
  rows.buyer_mentorship_collection_periods_v1[0].counted_at="2026-09-21T00:00:00Z";
  rows.buyer_mentorship_later_receipts_v1={payment_intent_id:"pi_due"};
  db=createMockClient(op=>({error:null,data:op.table==="read_buyer_mentorship_credited_payment_v1" &&
    (op.payload as any).p_payment_intent_id==="pi_due"?{reservationId:f.reservation.id,invoiceId:"in_due",proof:{paymentNumber:2}}:rows[op.table]??null}));
  const view=await readBuyerMentorshipManagement({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY:String(enabled)}});
  expect(view!.payments[1]).toMatchObject({outcome:"paid_accounted",canCheck:enabled,canVerifyBank:false});
  expect(view!.collectionState).toBe("paused");
});
