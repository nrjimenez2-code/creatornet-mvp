import {fullServerCaptureFixture} from "../test-support/full-server-capture-fixture";
import {inspectFullServerPaymentCapture} from "../lib/fullServerPaymentReceipt";
import {inspectOriginalFullRefund,readOriginalFullRefund,readOriginalFullRefundTotal} from "../lib/fullServerRefundObservation";

function fixture(){
  const f=fullServerCaptureFixture(),proof=inspectFullServerPaymentCapture(f);
  return {proof,refundId:"re_original",eventId:"evt_original",eventCreated:f.nowSeconds,eventLivemode:false,nowSeconds:f.nowSeconds,
    refund:{object:"refund",id:"re_original",charge:proof.chargeId,payment_intent:proof.paymentIntentId,currency:"usd",
      amount:500,created:proof.paidAt,status:"pending",balance_transaction:null,failure_balance_transaction:null,
      failure_reason:null,pending_reason:"processing",metadata:{private:"never persist"},instructions_email:"private@example.invalid",
      next_action:{secret:"never persist"}} as Record<string,any>};
}
test.each(["pending","requires_action","succeeded","failed","canceled"])("original %s refund is observation only",status=>{
  const f=fixture();f.refund.status=status;const before=JSON.stringify(f),result=inspectOriginalFullRefund(f);
  expect(result).toMatchObject({refundId:"re_original",status,amountCents:500,paymentIntentId:f.proof.paymentIntentId});
  expect(JSON.stringify(f)).toBe(before);expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private|secret|next_action|instructions_email|metadata/);
  expect(result).not.toHaveProperty("accounted");expect(result).not.toHaveProperty("accessGranted");
});
test("expanded references and nullable intent rely on the independently verified original charge",()=>{
  const f=fixture();f.refund.charge={id:f.proof.chargeId};f.refund.payment_intent=null;
  f.refund.balance_transaction={id:"txn_refund"};f.refund.failure_balance_transaction="txn_returned";
  f.refund.failure_reason="charge_for_pending_refund_disputed";
  expect(inspectOriginalFullRefund(f)).toMatchObject({balanceTransactionId:"txn_refund",failureBalanceTransactionId:"txn_returned",
    failureReason:"charge_for_pending_refund_disputed"});
});
const corruptions:Record<string,(f:ReturnType<typeof fixture>)=>void>={
  "foreign refund":f=>{f.refund.id="re_other";},"foreign charge":f=>{f.refund.charge="ch_other";},
  "foreign intent":f=>{f.refund.payment_intent="pi_other";},"absent intent":f=>{delete f.refund.payment_intent;},
  "absent charge":f=>{f.refund.charge=null;},"foreign currency":f=>{f.refund.currency="cad";},
  "wrong object":f=>{f.refund.object="charge";},"zero amount":f=>{f.refund.amount=0;},
  "negative amount":f=>{f.refund.amount=-1;},"fractional amount":f=>{f.refund.amount=1.5;},
  "excess amount":f=>{f.refund.amount=f.proof.amountCents+1;},"coerced amount":f=>{f.refund.amount="500";},
  "before capture":f=>{f.refund.created=f.proof.paidAt-1;},"after event":f=>{f.refund.created=f.eventCreated+1;},
  "future event":f=>{f.eventCreated=f.nowSeconds+1;},"fractional event":f=>{f.eventCreated-=0.5;},
  "missing status":f=>{f.refund.status=null;},"unknown status":f=>{f.refund.status="complete";},
  "foreign mode":f=>{f.eventLivemode=true;},"invalid refund locator":f=>{f.refundId="bad";},
  "invalid event":f=>{f.eventId="bad";},"invalid balance reference":f=>{f.refund.balance_transaction="pi_wrong";},
  "invalid reversal reference":f=>{f.refund.failure_balance_transaction={id:"bad"};},
  "private free text reason":f=>{f.refund.failure_reason="private customer@example.invalid";},
  "non-string pending reason":f=>{f.refund.pending_reason={secret:"value"};},
};
test.each(Object.entries(corruptions))("%s cannot become an owned original refund observation",(_name,change)=>{
  const f=fixture();change(f);expect(()=>inspectOriginalFullRefund(f)).toThrow("requires review");
});
test("status or reversal changes between readbacks produce different evidence",()=>{
  const f=fixture(),first=inspectOriginalFullRefund(f);f.refund.status="failed";
  f.refund.failure_balance_transaction="txn_returned";f.refund.failure_reason="unknown";
  expect(inspectOriginalFullRefund(f)).not.toEqual(first);
});
test("independent original refund readback pins options and verifies context around both reads",async()=>{
  const f=fixture(),steps:string[]=[];
  const retrieve=jest.fn(async()=>{steps.push("refund");return f.refund;});
  const observeContext=jest.fn(async()=>{steps.push("context");});
  const result=await readOriginalFullRefund({...f,stripe:{refunds:{retrieve}} as any,observeContext});
  expect(result).toEqual(inspectOriginalFullRefund(f));expect(steps).toEqual(["context","refund","context","refund","context"]);
  for(const call of retrieve.mock.calls as unknown[][])expect(call).toEqual(["re_original",{apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000}]);
});
test.each(["status","failure_balance_transaction","amount","charge"])("changed %s blocks independent refund evidence",async field=>{
  const f=fixture(),changed={...f.refund,[field]:({status:"failed",failure_balance_transaction:"txn_returned",amount:501,charge:"ch_other"} as any)[field]};
  const retrieve=jest.fn().mockResolvedValueOnce(f.refund).mockResolvedValueOnce(changed);
  await expect(readOriginalFullRefund({...f,stripe:{refunds:{retrieve}} as any,observeContext:async()=>{}})).rejects.toThrow("requires review");
});
test.each([1,2,3])("failed context check %s cannot return refund evidence",async failAt=>{
  const f=fixture(),retrieve=jest.fn().mockResolvedValue(f.refund);let count=0;
  await expect(readOriginalFullRefund({...f,stripe:{refunds:{retrieve}} as any,observeContext:async()=>{
    if(++count===failAt)throw Error("context changed");
  }})).rejects.toThrow("context changed");
  expect(retrieve).toHaveBeenCalledTimes(Math.min(failAt-1,2));
});
test("provider uncertainty propagates without retrying the refund or sending writes",async()=>{
  const f=fixture(),retrieve=jest.fn().mockRejectedValue(Error("provider unavailable"));
  await expect(readOriginalFullRefund({...f,stripe:{refunds:{retrieve}} as any,observeContext:async()=>{}})).rejects.toThrow("provider unavailable");
  expect(retrieve).toHaveBeenCalledTimes(1);
});
test("stable complete refund lists count only succeeded money and paginate using pinned options",async()=>{
  const f=fixture();f.refund.status="succeeded";let calls=0;
  const list=jest.fn(async()=>++calls%2===1?{object:"list",has_more:true,data:[f.refund]}:
    {object:"list",has_more:false,data:[{...f.refund,id:"re_pending",status:"pending",amount:200},{...f.refund,id:"re_second",amount:100}]});
  expect(await readOriginalFullRefundTotal({proof:f.proof,stripe:{refunds:{list}} as any,observation:inspectOriginalFullRefund(f),
    observeContext:async()=>{},nowSeconds:f.nowSeconds})).toBe(600);
  expect(list).toHaveBeenCalledTimes(4);expect(list.mock.calls[1]).toEqual([{charge:f.proof.chargeId,limit:100,starting_after:"re_original"},
    {apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000}]);
});
test.each(["missing original","duplicate","non-advancing page","foreign charge","changing list","changed original","excess total"])
("refund total rejects %s without returning financial evidence",async issue=>{
  const f=fixture();f.refund.status="succeeded";const original=inspectOriginalFullRefund(f);
  const list=jest.fn().mockResolvedValue({object:"list",has_more:false,data:[f.refund]});
  if(issue==="missing original")list.mockResolvedValue({object:"list",has_more:false,data:[]});
  if(issue==="duplicate")list.mockResolvedValue({object:"list",has_more:false,data:[f.refund,f.refund]});
  if(issue==="non-advancing page")list.mockResolvedValue({object:"list",has_more:true,data:[]});
  if(issue==="foreign charge")list.mockResolvedValue({object:"list",has_more:false,data:[{...f.refund,charge:"ch_other"}]});
  if(issue==="changing list")list.mockResolvedValueOnce({object:"list",has_more:false,data:[f.refund]})
    .mockResolvedValueOnce({object:"list",has_more:false,data:[f.refund,{...f.refund,id:"re_second",amount:100}]});
  if(issue==="changed original")list.mockResolvedValue({object:"list",has_more:false,data:[{...f.refund,status:"failed"}]});
  if(issue==="excess total")list.mockResolvedValue({object:"list",has_more:false,data:[f.refund,{...f.refund,id:"re_second",amount:f.proof.amountCents}]});
  await expect(readOriginalFullRefundTotal({proof:f.proof,stripe:{refunds:{list}} as any,observation:original,
    observeContext:async()=>{},nowSeconds:f.nowSeconds})).rejects.toThrow();
});
test("charge event reads complete succeeded totals without inventing a Refund locator",async()=>{
  const f=fixture();f.refund.status="succeeded";
  const list=jest.fn().mockResolvedValue({object:"list",has_more:false,data:[f.refund]});
  expect(await readOriginalFullRefundTotal({proof:f.proof,stripe:{refunds:{list}} as any,eventId:"evt_charge",
    observeContext:async()=>{},nowSeconds:f.nowSeconds})).toBe(500);
});
test("invalid charge-event identity cannot initiate refund-list readback",async()=>{
  const f=fixture(),list=jest.fn();
  await expect(readOriginalFullRefundTotal({proof:f.proof,stripe:{refunds:{list}} as any,eventId:"invalid",
    observeContext:async()=>{},nowSeconds:f.nowSeconds})).rejects.toThrow();expect(list).not.toHaveBeenCalled();
});
