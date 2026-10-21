import type {SupabaseClient} from "@supabase/supabase-js";
import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {readFullRefundReviewBacklog,fullRefundReviewReady} from "../lib/fullRefundReviewBacklog";
const context=buyerFirstCaptureFixture().context;
const env={CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY:"true",CREATOR_FULL_REFUND_REVIEW_SCHEMA_READY:"true",CREATOR_FULL_REFUND_REVIEW_MONITOR_READY:"true"};
function harness(){
  const data={context,needsReview:2,events:3,unapplied:1,reviewRecorded:1,observedAt:"2026-09-23T06:00:00Z",oldestObservedAt:"2026-09-23T05:00:00Z"};
  const rpc=jest.fn().mockResolvedValue({data,error:null}),observe=jest.fn().mockResolvedValue(context);
  return {data,rpc,observe,run:(flags=env)=>readFullRefundReviewBacklog(flags,{admin:{rpc} as unknown as SupabaseClient,context,observe})};
}
test("reads bounded counts after context verification and never exposes raw identifiers",async()=>{
  const h=harness();Object.assign(h.data,{providerSecret:"private"});
  expect(await h.run()).toEqual({needsReview:2,events:3,unapplied:1,reviewRecorded:1,observedAt:h.data.observedAt,oldestObservedAt:h.data.oldestObservedAt});
  expect(h.rpc).toHaveBeenCalledTimes(1);expect(h.rpc).toHaveBeenCalledWith("read_full_refund_review_backlog_v1",{p_context:context});
  expect(h.observe).toHaveBeenCalledTimes(2);
});
test.each(Object.keys(env))("%s disabled prevents database work",async key=>{
  const h=harness(),flags={...env,[key]:"false"};expect(fullRefundReviewReady(flags)).toBe(false);
  await expect(h.run(flags)).rejects.toThrow();expect(h.rpc).not.toHaveBeenCalled();expect(h.observe).not.toHaveBeenCalled();
});
test.each(["context","negative","fractional","inconsistent","time","empty","rpc","late context"])("%s never becomes a healthy empty queue",async kind=>{
  const h=harness();
  if(kind==="context")h.data.context={...context,platformAccountId:"acct_foreign"};
  if(kind==="negative")h.data.events=-1;
  if(kind==="fractional")h.data.unapplied=0.5;
  if(kind==="inconsistent")h.data.needsReview=4;
  if(kind==="time")h.data.oldestObservedAt="2027-01-01T00:00:00Z";
  if(kind==="empty")h.data.needsReview=0;
  if(kind==="rpc")h.rpc.mockResolvedValue({data:null,error:{message:"private"}});
  if(kind==="late context")h.observe.mockResolvedValueOnce(context).mockRejectedValueOnce(Error("context changed"));
  await expect(h.run()).rejects.toThrow();
});
test("verified empty snapshot requires zero counts and no oldest event",async()=>{
  const h=harness();Object.assign(h.data,{needsReview:0,events:0,unapplied:0,reviewRecorded:0,oldestObservedAt:null});
  expect(await h.run()).toMatchObject({needsReview:0,events:0,oldestObservedAt:null});
});
