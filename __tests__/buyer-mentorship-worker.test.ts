import type {SupabaseClient} from "@supabase/supabase-js";
import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {buyerMentorshipWorkerReady,buyerMentorshipWorkerCollectionReady,buyerMentorshipWorkStatus,runBuyerMentorshipBillingWorker} from "../lib/mentorshipInstallmentWorker";
const context=buyerFirstCaptureFixture().context;
const row={reservation_id:"10000000-0000-4000-8000-000000000001",request_id:"10000000-0000-4000-8000-000000000002",
  buyer_id:"10000000-0000-4000-8000-000000000003",lease_token:"10000000-0000-4000-8000-000000000004",action:"collect",invoice_id:null as string|null};
function harness(){
  const keys=["WORKER_SCHEMA_READY","WORKER_READY","LATER_RECEIPT_SCHEMA_READY","RECONCILIATION_READY","RECOVERY_SCHEMA_READY","RECOVERY_READY",
    "WORKER_COLLECTION_READY","BOOTSTRAP_SCHEMA_READY","RECEIPT_INSPECTION_READY","ACTIVATION_SCHEMA_READY","COLLECTION_PERIODS_SCHEMA_READY","DISCOVERY_READY",
    "INVOICE_OPERATIONS_SCHEMA_READY","INVOICE_PREPARATION_READY","DEBIT_SCHEMA_READY","COLLECTION_READY"];
  const env:Record<string,string>={CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY:"true",...Object.fromEntries(keys.map(k=>[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`,"true"]))};
  let rows=[{...row}],attention=0;
  const rpc=jest.fn(async(name:string,_params:unknown)=>({data:name==="lease_buyer_mentorship_work_v1"?rows:
    name==="read_buyer_mentorship_work_summary_v1"?{pending:rows.length,attention}:true,error:null}));
  const observe=jest.fn().mockResolvedValue(context),collect=jest.fn().mockResolvedValue({status:"credited"}),recover=jest.fn().mockResolvedValue({status:"payment_recovery_recorded",outcome:"paid_accounted"});
  const run=()=>runBuyerMentorshipBillingWorker(env,{admin:{rpc} as unknown as SupabaseClient,context,observe,collect,recover});
  return {env,rpc,observe,collect,recover,run,setRows:(v:typeof rows)=>{rows=v;},attention:(n:number)=>{attention=n;}};
}
test("worker invokes existing collection with only the original buyer/request and completes exact token",async()=>{
  const h=harness();expect(await h.run()).toEqual({selected:1,failed:0,needsReview:0,pending:1});
  expect(h.collect).toHaveBeenCalledWith({buyerId:row.buyer_id,requestId:row.request_id,env:h.env});expect(h.recover).not.toHaveBeenCalled();
  expect(h.rpc).toHaveBeenCalledWith("finish_buyer_mentorship_work_v1",{p_reservation_id:row.reservation_id,p_token:row.lease_token,p_context:context,p_status:"accounted"});
});
test("collection rollback preserves original-only recovery",async()=>{
  const h=harness();h.env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_READY="false";h.setRows([{...row,action:"recover",invoice_id:"in_original"}]);
  expect(buyerMentorshipWorkerReady(h.env)).toBe(true);expect(buyerMentorshipWorkerCollectionReady(h.env)).toBe(false);
  await h.run();expect(h.collect).not.toHaveBeenCalled();expect(h.recover).toHaveBeenCalledWith({buyerId:row.buyer_id,requestId:row.request_id,invoiceId:"in_original",env:h.env});
  expect(h.rpc).toHaveBeenCalledWith("lease_buyer_mentorship_work_v1",{p_context:context,p_collect:false,p_limit:2});
});
test("disabled worker makes no observations, lease or provider calls",async()=>{
  const h=harness();h.env.CREATOR_MENTORSHIP_INSTALLMENT_WORKER_READY="false";await expect(h.run()).rejects.toThrow();
  expect(h.rpc).not.toHaveBeenCalled();expect(h.observe).not.toHaveBeenCalled();
});
test.each(["duplicate","too many","missing invoice","collection disabled"])("invalid leased batch %s never reaches providers",async kind=>{
  const h=harness();
  if(kind==="duplicate")h.setRows([{...row},{...row}]);
  if(kind==="too many")h.setRows([{...row},{...row},{...row}]);
  if(kind==="missing invoice")h.setRows([{...row,action:"recover"}]);
  if(kind==="collection disabled")h.env.CREATOR_MENTORSHIP_INSTALLMENT_WORKER_COLLECTION_READY="false";
  await expect(h.run()).rejects.toThrow();expect(h.collect).not.toHaveBeenCalled();expect(h.recover).not.toHaveBeenCalled();
});
test("review selection makes no payment call and an empty backoff batch preserves attention",async()=>{
  const h=harness();h.setRows([{...row,action:"review"}]);h.attention(1);
  expect((await h.run()).needsReview).toBe(1);expect(h.collect).not.toHaveBeenCalled();expect(h.recover).not.toHaveBeenCalled();
  h.setRows([]);expect(await h.run()).toEqual({selected:0,failed:0,needsReview:1,pending:0});
});
test("provider error records bounded failure without leaking its message",async()=>{
  const h=harness();h.collect.mockRejectedValue(Error("sensitive provider message"));h.attention(1);
  expect(await h.run()).toMatchObject({failed:1,needsReview:1});
  expect(h.rpc).toHaveBeenCalledWith("finish_buyer_mentorship_work_v1",expect.objectContaining({p_status:"retry_required"}));
});
test("completion failure settles the other owned job before failing the batch",async()=>{
  const h=harness();h.setRows([{...row},{...row,reservation_id:"10000000-0000-4000-8000-000000000005",action:"recover",invoice_id:"in_original"}]);
  const normal=h.rpc.getMockImplementation()!;let recovered=false;
  h.rpc.mockImplementation(async(name,args)=>name==="finish_buyer_mentorship_work_v1" && (args as {p_reservation_id:string}).p_reservation_id===row.reservation_id?{data:false,error:null}:normal(name,args));
  h.recover.mockImplementation(async()=>{await new Promise(resolve=>setTimeout(resolve,10));recovered=true;return {status:"credited"};});
  await expect(h.run()).rejects.toThrow();expect(recovered).toBe(true);
  expect(h.rpc.mock.calls.filter(([name])=>name==="finish_buyer_mentorship_work_v1")).toHaveLength(2);
});
test.each(["action_required","payment_method_required","terminal_unpaid","review_required"])("unpaid recovery %s remains visible for review",outcome=>{
  expect(buyerMentorshipWorkStatus({status:"payment_recovery_recorded",outcome})).toBe("review_required");
});
test("pending, unexpected outcomes and failed future handoff cannot become accounted",()=>{
  expect(buyerMentorshipWorkStatus({status:"payment_recovery_recorded",outcome:"payment_pending"})).toBe("payment_pending");
  expect(buyerMentorshipWorkStatus({status:"new_status"})).toBe("review_required");
  expect(buyerMentorshipWorkStatus({status:"payment_recovery_recorded",outcome:"paid_accounted",futureCollection:"review_required"})).toBe("review_required");
});
