import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {inspectBuyerMentorshipFirstCapture} from "../lib/mentorshipInstallmentReceipt";
import {installmentMonthBoundary} from "../lib/installments/checkoutPreparation";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockObserve=jest.fn(),mockReservation=jest.fn(),mockList=jest.fn();
let db:ReturnType<typeof createMockClient>,config:any;
jest.mock("stripe",()=>({__esModule:true,default:function(){return {invoices:{list:mockList}};}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>db}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>config}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("@/lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...a:unknown[])=>mockReservation(...a)}));
import {buyerMentorshipDiscoveryPeriods,discoverBuyerMentorshipRenewal} from "../lib/mentorshipInstallmentDiscovery";
let f:ReturnType<typeof buyerFirstCaptureFixture>,proof:ReturnType<typeof inspectBuyerMentorshipFirstCapture>,rows:any[],state:any;
const env={CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_PERIODS_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_DISCOVERY_READY:"true"};
const args=()=>({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,env});
function invoice(id="in_due"){return {id,object:"invoice",livemode:false,customer:"cus_owned",parent:{subscription_details:{subscription:"sub_owned"}},
  currency:"usd",billing_reason:"subscription_cycle",status:"draft",auto_advance:false,amount_paid:0,
  lines:{has_more:false,data:[{parent:{type:"subscription_item_details",subscription_item_details:{proration:false}},period:{start:rows[0].due_at,end:rows[0].period_end}}]}};}
beforeEach(()=>{
  jest.resetAllMocks();f=buyerFirstCaptureFixture();proof=inspectBuyerMentorshipFirstCapture(f);
  rows=[2,3].map((number,i)=>({reservation_id:f.reservation.id,payment_number:number,
    due_at:i===0?proof.nextPaymentAt:installmentMonthBoundary(proof.nextPaymentAt,i),period_end:installmentMonthBoundary(proof.nextPaymentAt,i+1),
    amount_cents:number===3?3335:3333,fee_schedule:f.reservation.terms.renewalFeeSchedule,invoice_id:null,admitted_at:null,counted_at:null}));
  state={reservation_id:f.reservation.id,paid_count:1,financial_hold_at:null,debit_revoked_at:null};
  jest.useFakeTimers({now:rows[0].due_at*1000+1000});
  config={approvedContext:f.context,configuredSupabaseUrl:f.contextEvidence.configuredSupabaseUrl,supabaseServiceKey:"synthetic",stripeSecretKey:"sk_test_synthetic"};
  mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});mockReservation.mockResolvedValue(f.reservation);
  mockList.mockImplementation(async()=>({object:"list",has_more:false,data:[invoice()]}));
  db=createMockClient(op=>({error:null,data:op.kind==="rpc"?{reservationId:f.reservation.id,periodCount:2,collectionAllowed:false}:
    op.table==="buyer_mentorship_first_receipts_v1"?{reservation_id:f.reservation.id,proof}:
    op.table==="buyer_mentorship_collection_periods_v1"?rows:state}));
});
afterEach(()=>jest.useRealTimers());
test("uses shared provider discovery for the exact owned current period without payment",async()=>{
  expect(await discoverBuyerMentorshipRenewal(args())).toEqual({status:"discovered",invoiceId:"in_due",paymentNumber:2});
  expect(mockList).toHaveBeenCalledWith({subscription:"sub_owned",limit:100});
  expect(db.ops.filter(op=>op.kind==="rpc").map(op=>op.table)).toEqual(["initialize_buyer_mentorship_periods_v1"]);
  expect(mockObserve).toHaveBeenCalledTimes(2);
});
test("before first monthly due date does not query provider invoices",async()=>{
  jest.setSystemTime(f.nowSeconds*1000);expect(await discoverBuyerMentorshipRenewal(args())).toEqual({status:"nothing_due"});expect(mockList).not.toHaveBeenCalled();
});
test("an expired unpaid period cannot become a catch-up debit",async()=>{
  jest.setSystemTime(rows[0].period_end*1000);expect(await discoverBuyerMentorshipRenewal(args())).toEqual({status:"review_required"});expect(mockList).not.toHaveBeenCalled();
});
test("admitted operation remains reconciliation after its period",async()=>{
  rows[0].invoice_id="in_due";rows[0].admitted_at=new Date(rows[0].due_at*1000).toISOString();
  jest.setSystemTime(rows[0].period_end*1000);expect(await discoverBuyerMentorshipRenewal(args())).toEqual({status:"reconcile_admitted",invoiceId:"in_due",paymentNumber:2});
});
test("ambiguous matching invoices require review",async()=>{
  mockList.mockResolvedValue({object:"list",has_more:false,data:[invoice(),invoice("in_other")]});
  expect(await discoverBuyerMentorshipRenewal(args())).toEqual({status:"review_required"});
});
test.each(["date","amount","fees","owner","order","skipped count"])("altered saved %s fails before provider discovery",async issue=>{
  if(issue==="date")rows[0].due_at++;
  if(issue==="amount")rows[1].amount_cents--;
  if(issue==="fees")rows[0].fee_schedule={};
  if(issue==="owner")rows[0].reservation_id="foreign";
  if(issue==="order")rows.reverse();
  if(issue==="skipped count")Object.assign(rows[1],{invoice_id:"in_other",admitted_at:new Date().toISOString(),counted_at:new Date().toISOString()});
  await expect(discoverBuyerMentorshipRenewal(args())).rejects.toThrow();expect(mockList).not.toHaveBeenCalled();
});
test("disabled discovery does no initialization or provider work",async()=>{
  await expect(discoverBuyerMentorshipRenewal({...args(),env:{}})).rejects.toThrow();expect(db.ops).toEqual([]);expect(mockList).not.toHaveBeenCalled();
});
test("persisted final cents and monthly boundaries match the accepted plan",()=>{
  expect(buyerMentorshipDiscoveryPeriods(rows,f.reservation,proof.paidAt)).toEqual(rows.map(row=>({number:row.payment_number,start:row.due_at,end:row.period_end,
    invoiceId:null,admitted:false,counted:false})));
});
