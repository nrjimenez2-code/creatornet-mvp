import type Stripe from "stripe";
import { discoverExactRenewalSandbox, createExactDiscoveryStore } from "../lib/installments/invoiceDiscovery";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
function fixture(){
  const f=exactInstallmentFixture();f.paid();f.setAgreement({status:"active"});
  const periods=[{number:2,start:1000,end:2000,invoiceId:null as string|null,admitted:false,counted:false},
    {number:3,start:2000,end:3000,invoiceId:null as string|null,admitted:false,counted:false}];
  const discoveryStore={periods:jest.fn(async()=>periods)};
  const invoice={id:"in_candidate",livemode:false,customer:"cus_fixture",parent:{subscription_details:{subscription:"sub_fixture"}},
    currency:"usd",billing_reason:"subscription_cycle",status:"draft",auto_advance:false,amount_paid:0,
    lines:{has_more:false,data:[{parent:{type:"subscription_item_details",subscription_item_details:{proration:false}},period:{start:1000,end:2000}}]}} as unknown as Stripe.Invoice;
  const list=jest.fn().mockResolvedValue({has_more:false,data:[invoice]});
  const args={agreementId:f.agreement.id,store:f.store,discoveryStore,stripe:{invoices:{list}} as unknown as Pick<Stripe,"invoices">,
    env:{...f.env,CREATOR_EXACT_INSTALLMENTS_DISCOVERY_READY:"true",CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true"},now:()=>1500};
  return {f,periods,invoice,list,args};
}
test("discovers only the next due bound invoice without claiming or paying",async()=>{
  const x=fixture();expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"discovered",invoiceId:x.invoice.id,paymentNumber:2});
  expect(x.list).toHaveBeenCalledWith({subscription:"sub_fixture",limit:100});expect(x.f.store.claim).not.toHaveBeenCalled();
});
test("missing invoice is waiting, not invented or automatically created",async()=>{
  const x=fixture();x.list.mockResolvedValue({has_more:false,data:[]});
  expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"waiting_for_invoice"});
});
test("future and fully counted periods do not trigger provider reads",async()=>{
  const x=fixture();x.args.now=()=>999;expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"nothing_due"});
  x.periods.forEach(p=>{p.counted=true;});x.args.now=()=>4000;
  expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"nothing_due"});expect(x.list).not.toHaveBeenCalled();
});
test("an overdue unpaid installment is not skipped or automatically caught up",async()=>{
  const x=fixture();x.args.now=()=>2500;
  expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"review_required"});expect(x.list).not.toHaveBeenCalled();
});
test("admitted original invoice remains reconciliation, including beyond its old period",async()=>{
  const x=fixture();Object.assign(x.periods[0],{admitted:true,invoiceId:x.invoice.id});x.args.now=()=>5000;x.invoice.status="paid";
  expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"reconcile_admitted",invoiceId:x.invoice.id,paymentNumber:2});
});
test.each(["duplicate","foreign","live","auto collection","proration","missing saved invoice","paid outside admission","bad schedule"])
("%s cannot become a collectable discovery",async(problem)=>{
  const x=fixture();if(problem==="duplicate")x.list.mockResolvedValue({has_more:false,data:[x.invoice,{...x.invoice,id:"in_second"}]});
  if(problem==="foreign")x.invoice.customer="cus_foreign";if(problem==="live")x.invoice.livemode=true;
  if(problem==="auto collection")x.invoice.auto_advance=true;
  if(problem==="proration")x.invoice.lines.data[0].parent!.subscription_item_details!.proration=true;
  if(problem==="missing saved invoice")x.periods[0].invoiceId="in_another";
  if(problem==="paid outside admission")x.invoice.status="paid";
  if(problem==="bad schedule")x.periods[1].start=2500;
  expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"review_required"});
});
test("pagination checks later pages before returning a candidate",async()=>{
  const x=fixture();x.list.mockReset().mockResolvedValueOnce({has_more:true,data:[x.invoice]})
    .mockResolvedValueOnce({has_more:false,data:[{...x.invoice,id:"in_duplicate"}]});
  expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"review_required"});
  expect(x.list).toHaveBeenLastCalledWith({subscription:"sub_fixture",limit:100,starting_after:x.invoice.id});
});
test("broken pagination and provider errors do not imply a missing invoice",async()=>{
  const x=fixture();x.list.mockResolvedValue({has_more:true,data:[]});expect(await discoverExactRenewalSandbox(x.args)).toEqual({status:"review_required"});
  x.list.mockRejectedValue(new Error("SECRET"));await expect(discoverExactRenewalSandbox(x.args)).rejects.toThrow("provider evidence unavailable");
});
test("unsafe environment is refused before store access",async()=>{
  const x=fixture();x.args.env.STRIPE_SECRET_KEY="sk_live_fake";
  await expect(discoverExactRenewalSandbox(x.args)).rejects.toThrow();expect(x.f.store.load).not.toHaveBeenCalled();expect(x.list).not.toHaveBeenCalled();
});
test("private adapter validates ownership, count and original invoice identity",async()=>{
  const x=fixture();const db=createMockClient(op=>({error:null,data:op.table==="exact_installment_periods"?
    [{agreement_id:x.f.agreement.id,payment_number:2,due_at:1000,period_end:2000}]:op.table==="exact_installment_invoice_claims"?
    [{agreement_id:x.f.agreement.id,payment_number:2,stripe_invoice_id:"in_original",dispatch_started_at:"2026-09-06"}]:[]}));
  const r=await createExactDiscoveryStore(db as unknown as Parameters<typeof createExactDiscoveryStore>[0]).periods(x.f.agreement.id);
  expect(r).toEqual([{number:2,start:1000,end:2000,invoiceId:"in_original",admitted:true,counted:false}]);
});
