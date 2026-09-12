import type Stripe from "stripe";
import { runExactInvoiceBatchSandbox, createExactInvoiceBatchStore } from "../lib/installments/invoiceWorker";
import { exactRenewalFixture } from "../test-support/exact-renewal-fixture";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
function fixture() {
  const f=exactRenewalFixture();
  const batchStore={page:jest.fn(async()=>({ids:[f.a.planId],hasMore:false}))};
  const discoveryStore={periods:jest.fn(async()=>[
    {number:2,start:f.a.periodStart,end:f.a.periodEnd,invoiceId:null,admitted:false,counted:false},
    {number:3,start:f.a.periodEnd,end:f.a.periodEnd+28*86400,invoiceId:null,admitted:false,counted:false},
  ])};
  const list=jest.fn(async()=>({has_more:false,data:[f.invoice]}));
  const stripe={...f.api,invoices:{...f.api.invoices,list}} as unknown as Stripe;
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_WORKER_READY:"true",CREATOR_EXACT_INSTALLMENTS_DISCOVERY_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true",CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true"};
  const args={...f.args,batchStore,discoveryStore,stripe,env,mode:"inspect" as "inspect"|"prepare"};
  return {f,batchStore,discoveryStore,list,env,args};
}
test("inspection reads discovered invoice without claims, preparation, fees or payment",async()=>{
  const x=fixture();expect(await runExactInvoiceBatchSandbox(x.args)).toEqual({rows:[{agreementId:x.f.a.planId,status:"discovered",paymentNumber:2}],nextCursor:null,halted:false});
  expect(x.f.invoiceStore.claim).not.toHaveBeenCalled();expect(x.f.api.invoices.update).not.toHaveBeenCalled();expect(x.f.api.invoices.pay).not.toHaveBeenCalled();
});
test("prepare worker cannot charge even with collection env flag true",async()=>{
  const x=fixture();x.args.mode="prepare";x.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT="true";
  expect((await runExactInvoiceBatchSandbox(x.args)).rows[0].status).toBe("prepared_unpaid");
  expect(x.f.api.invoices.update).toHaveBeenCalled();expect(x.f.api.invoices.pay).not.toHaveBeenCalled();
  expect(x.f.invoiceStore.admitDispatch).not.toHaveBeenCalled();expect(x.f.creditStore.credit).not.toHaveBeenCalled();
  expect((await runExactInvoiceBatchSandbox(x.args)).rows[0].status).toBe("prepared_unpaid");
  expect(x.f.api.invoices.pay).not.toHaveBeenCalled();
});
test("old admitted paid invoice can be reconciled without a fresh debit",async()=>{
  const x=fixture();x.args.mode="prepare";
  expect((await runExactInvoiceBatchSandbox(x.args)).rows[0].status).toBe("prepared_unpaid");
  x.f.markPaid();x.f.setPhase("dispatching");
  x.discoveryStore.periods.mockResolvedValue([
    {number:2,start:x.f.a.periodStart,end:x.f.a.periodEnd,invoiceId:x.f.invoice.id,admitted:true,counted:false},
    {number:3,start:x.f.a.periodEnd,end:x.f.a.periodEnd+28*86400,invoiceId:null,admitted:false,counted:false},
  ] as never);
  expect((await runExactInvoiceBatchSandbox(x.args)).rows[0].status).toBe("credited");
  expect(x.f.api.invoices.pay).not.toHaveBeenCalled();expect(x.f.creditStore.credit).toHaveBeenCalledTimes(1);
});
test.each(["production","disabled","live key","missing recovery","paused preparation"])("%s blocks prepare before the batch query",async(reason)=>{
  const x=fixture();x.args.mode="prepare";
  if(reason==="production")x.env.VERCEL_ENV="production";
  if(reason==="disabled")x.env.CREATOR_EXACT_INSTALLMENTS_WORKER_READY="false";
  if(reason==="live key")x.env.STRIPE_SECRET_KEY="sk_live_fake";
  if(reason==="missing recovery")x.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY="false";
  if(reason==="paused preparation")x.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  await expect(runExactInvoiceBatchSandbox(x.args)).rejects.toThrow();expect(x.batchStore.page).not.toHaveBeenCalled();
});
test("read-only inspection remains available when preparation is paused",async()=>{
  const x=fixture();x.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  expect((await runExactInvoiceBatchSandbox(x.args)).halted).toBe(false);
});
test("failed current item halts batch without skipping the failed original on resume",async()=>{
  const x=fixture();const previous="00000000-0000-4000-8000-000000000001";
  x.list.mockRejectedValueOnce(new Error("private Stripe evidence"));
  const r=await runExactInvoiceBatchSandbox({...x.args,after:previous});
  expect(r).toEqual({rows:[{agreementId:x.f.a.planId,status:"reconciliation_required"}],nextCursor:previous,halted:true});
  expect(JSON.stringify(r)).not.toContain("private");expect(x.f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each(["duplicate","unsorted","too many","bad id","bad more"])("%s batch rejected before individual work",async(reason)=>{
  const x=fixture();let ids=[x.f.a.planId];let hasMore=false;
  if(reason==="duplicate")ids.push(ids[0]);
  if(reason==="unsorted")ids.push("00000000-0000-4000-8000-000000000001");
  if(reason==="too many")ids=Array(11).fill(ids[0]);
  if(reason==="bad id")ids=["foreign"];
  if(reason==="bad more")hasMore=true;
  x.batchStore.page.mockResolvedValueOnce({ids,hasMore});
  await expect(runExactInvoiceBatchSandbox(x.args)).rejects.toThrow();expect(x.list).not.toHaveBeenCalled();
});
test("adapter page is bounded and returns a stable continuation",async()=>{
  const ids=Array.from({length:11},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`);
  const db=createMockClient(()=>({data:ids.map(id=>({id})),error:null}));
  expect(await createExactInvoiceBatchStore(db as unknown as Parameters<typeof createExactInvoiceBatchStore>[0]).page(null))
    .toEqual({ids:ids.slice(0,10),hasMore:true});
});
