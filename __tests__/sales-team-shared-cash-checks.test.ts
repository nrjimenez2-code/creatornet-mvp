import type {SupabaseClient} from "@supabase/supabase-js";
import {inspectSharedCashOriginal} from "@/lib/salesTeams/sharedCashChecks";
import type {SharedCashOriginal} from "@/lib/salesTeams/sharedCashReadback";

// The supplied bridge must remain usable without global database/credential
// composition, including in restricted refund runtimes.
jest.mock("@/lib/salesTeams/server",()=>{throw Error("Global server composition imported");});
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const source:SharedCashOriginal={kind:"legacy_refund",id:id(91),creatorId:id(1),context,fingerprint:"a".repeat(64),createdAt:Math.floor(Date.now()/1000)-10,closed:false,
 chargeId:"ch_original",paymentIntentId:"pi_original",grossCents:10000,refundCents:1000,refundId:null,applicationFeeId:"fee_original",feeRefundId:null,feeRefundCents:120,actualFeeRefundCents:null,responsibility:"creator",reasonCode:"creator_discretionary"};
const args={kind:"legacy_refund" as const,id:id(91),actorId:id(29),checkId:id(96)};
function fixture(){
 const rpc=jest.fn(async(name:string)=>({data:name==="begin_sales_team_shared_cash_check_v1"?{checkId:id(96),completed:false,held:true,source}:{checkId:id(96),completed:true,held:true},error:null}));
 const raw=jest.fn(async()=>{throw Error("No original was bound; no provider request permitted");}),observeContext=jest.fn(async()=>context);
 return {rpc,raw,observeContext,c:{admin:{rpc} as unknown as SupabaseClient,context,observeContext,stripe:{rawRequest:raw}}};
}
test("unfinished original writes an explicit hold through supplied RPCs and sends no provider request",async()=>{
 const f=fixture();expect(await inspectSharedCashOriginal(f.c,args)).toEqual({checkId:id(96),completed:true,held:true});expect(f.raw).not.toHaveBeenCalled();
 expect(f.rpc).toHaveBeenLastCalledWith("complete_sales_team_shared_cash_check_v1",expect.objectContaining({p_actor_id:id(29),p_worker_run_id:null,p_proof:expect.objectContaining({complete:false,holdReason:"original_workflow_unfinished"})}));
});
test("completed replay returns SQL's current hold without a completion call or provider read",async()=>{
 const f=fixture();f.rpc.mockResolvedValue({data:{checkId:id(96),completed:true,held:false,source},error:null});
 expect(await inspectSharedCashOriginal(f.c,args)).toEqual({checkId:id(96),completed:true,held:false});expect(f.rpc).toHaveBeenCalledTimes(1);expect(f.raw).not.toHaveBeenCalled();
});
test("worker provenance is passed as its real run, with no invented administrator",async()=>{
 const f=fixture();await inspectSharedCashOriginal(f.c,{kind:"legacy_refund",id:id(91),workerRunId:id(95),checkId:id(96)});
 expect(f.rpc).toHaveBeenCalledWith("begin_sales_team_shared_cash_check_v1",expect.objectContaining({p_actor_id:null,p_worker_run_id:id(95)}));
});
test("context drift before begin cannot create a check or perform a read",async()=>{
 const f=fixture();f.observeContext.mockResolvedValue({...context,platformAccountId:"acct_changed"});await expect(inspectSharedCashOriginal(f.c,args)).rejects.toThrow(/context changed/);expect(f.rpc).not.toHaveBeenCalled();
});
test("context drift after begin preserves its pending check without completing stale evidence",async()=>{
 const f=fixture();f.observeContext.mockResolvedValueOnce(context).mockResolvedValueOnce(context).mockResolvedValue({...context,platformAccountId:"acct_changed"});
 await expect(inspectSharedCashOriginal(f.c,args)).rejects.toThrow(/context changed/);expect(f.rpc).toHaveBeenCalledTimes(1);expect(f.raw).not.toHaveBeenCalled();
});
test("mismatched saved source and original check identifiers stop before any provider access",async()=>{
 const f=fixture();f.rpc.mockResolvedValue({data:{checkId:id(96),completed:false,held:true,source:{...source,id:id(92)}},error:null});
 await expect(inspectSharedCashOriginal(f.c,args)).rejects.toThrow(/source changed/);expect(f.raw).not.toHaveBeenCalled();
});
