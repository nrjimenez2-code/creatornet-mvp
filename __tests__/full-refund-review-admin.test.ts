import type {SupabaseClient} from "@supabase/supabase-js";
import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {parseFullRefundReviewAdmin,readFullRefundReviewAdmin} from "../lib/fullRefundReviewAdmin";
const context=buyerFirstCaptureFixture().context;
const env=Object.fromEntries(["CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY","CREATOR_FULL_REFUND_REVIEW_SCHEMA_READY",
  "CREATOR_FULL_REFUND_REVIEW_ADMIN_SCHEMA_READY","CREATOR_FULL_REFUND_REVIEW_ADMIN_READY"].map(k=>[k,"true"]));
function fixture(){return {context,backlog:{context,observedAt:"2026-09-23T06:00:00Z",events:1,needsReview:1,unapplied:0,reviewRecorded:0,oldestObservedAt:"2026-09-23T05:00:00Z"},
  rows:[{event_id:"evt_001",attempt_id:"10000000-0000-4000-8000-000000000001",refund_id:"re_original",charge_id:"ch_original",payment_intent_id:"pi_original",
    financial_hold_at:"2026-09-23T05:00:00Z",revision:3,observed_at:"2026-09-23T05:00:00Z",applied_at:"2026-09-23T05:01:00Z",
    disposition:"refund_observed",refund_status:"succeeded",amount_cents:100,observations:1}]};}
test("strict projection keeps held succeeded originals visible without forwarding raw evidence",()=>{
  const data=fixture();Object.assign(data.rows[0],{secret:"private",details:{secret:"private"}});
  const result=parseFullRefundReviewAdmin(data,context,null);
  expect(result.rows[0]).toMatchObject({refundStatus:"succeeded",revision:3,observations:1});expect(result.needsReview).toBe(1);
  expect(JSON.stringify(result)).not.toContain("private");
});
test("lookahead is validated and global counts persist on later empty pages",()=>{
  const data=fixture();data.rows=Array.from({length:26},(_,i)=>({...data.rows[0],event_id:`evt_${String(i).padStart(3,"0")}`}));data.backlog.events=30;
  expect(parseFullRefundReviewAdmin(data,context,null)).toMatchObject({events:30,nextCursor:"evt_024"});
  data.rows=[];expect(parseFullRefundReviewAdmin(data,context,"evt_999")).toMatchObject({events:30,rows:[],nextCursor:null});
});
test.each(["context","backlog context","duplicate","cursor","missing rows","unpaired","amount","time","revision","status","total","oversized"])("rejects %s",kind=>{
  const data:any=fixture();let cursor:string|null=null;
  if(kind==="context")data.context={...context,mode:"live"};
  if(kind==="backlog context")data.backlog.context={...context,mode:"live"};
  if(kind==="duplicate")data.rows.push(data.rows[0]);
  if(kind==="cursor")cursor="evt_001";
  if(kind==="missing rows")data.rows=[];
  if(kind==="unpaired")data.rows[0].applied_at=null;
  if(kind==="amount")data.rows[0].amount_cents=-1;
  if(kind==="time")data.rows[0].applied_at="2027-01-01T00:00:00Z";
  if(kind==="revision")data.rows[0].revision=0.5;
  if(kind==="status")data.rows[0].refund_status="resolved";
  if(kind==="total")data.backlog.needsReview=0;
  if(kind==="oversized")data.rows=Array(27).fill(data.rows[0]);
  expect(()=>parseFullRefundReviewAdmin(data,context,cursor)).toThrow("unavailable");
});
test.each(Object.keys(env))("%s disabled prevents reads",async key=>{
  const rpc=jest.fn(),observe=jest.fn();await expect(readFullRefundReviewAdmin({rpc} as unknown as SupabaseClient,null,{...env,[key]:"false"},{context,observe})).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();expect(observe).not.toHaveBeenCalled();
});
test("RPC error and changed context cannot yield an empty or stale page",async()=>{
  const rpc=jest.fn().mockResolvedValue({data:fixture(),error:null}),observe=jest.fn().mockResolvedValue(context);
  const run=()=>readFullRefundReviewAdmin({rpc} as unknown as SupabaseClient,null,env,{context,observe});
  expect((await run()).rows).toHaveLength(1);expect(observe).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenCalledWith("read_full_refund_review_admin_v1",{p_context:context,p_after:null});
  observe.mockResolvedValueOnce(context).mockRejectedValueOnce(Error("changed"));await expect(run()).rejects.toThrow("changed");
  rpc.mockResolvedValue({data:null,error:{message:"private"}});await expect(run()).rejects.toThrow("unavailable");
});
