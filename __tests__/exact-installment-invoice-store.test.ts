import {createClient} from "@supabase/supabase-js";
import {createExactInvoiceStore} from "../lib/installments/invoiceStore";
import {exactRenewalFixture} from "../test-support/exact-renewal-fixture";

function fixture() {
  let value:unknown=null,code=200;
  const calls:{path:string;query:string;body:unknown}[]=[];
  const fakeFetch=jest.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const u=new URL(String(input));calls.push({path:u.pathname,query:u.search,body:init?.body?JSON.parse(String(init.body)):null});
    return new Response(JSON.stringify(value),{status:code,headers:{"content-type":"application/json"}});
  });
  const admin=createClient("https://fixture.invalid","synthetic-not-a-key",{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fakeFetch}});
  const f=exactRenewalFixture();
  const adapter=createExactInvoiceStore(admin);
  return {adapter,calls,a:f.a,token:f.f.terms.buyerId,response:(v:unknown,c=200)=>{value=v;code=c;},
    claim:()=>adapter.claim(f.a.planId,f.a.invoiceId,f.a.subscriptionId,f.a.periodStart,f.a.periodEnd,f.f.terms.buyerId)};
}
test.each(["prepare","reconcile","busy"])("real Supabase builder parses %s and never sends caller fees",async(status)=>{
  const f=fixture();f.response(status==="busy"?{status}:{status,authorization:f.a,paymentIntentId:"pi_renewal"});
  expect((await f.claim()).status).toBe(status);
  expect(f.calls[0].body).toEqual({p_agreement_id:f.a.planId,p_invoice_id:"in_renewal",p_subscription_id:"sub_fixture",
    p_period_start:f.a.periodStart,p_period_end:f.a.periodEnd,p_claim_token:f.token});
});
test.each([null,[],true,{}, {status:"prepare"}, {status:"prepare",authorization:[]},
  {status:"unknown"},{status:"reconcile",authorization:{}}])("malformed claim %# fails closed",async(value)=>{
  const f=fixture();f.response(value);await expect(f.claim()).rejects.toThrow();
});
test.each(["planId","invoiceId","periodStart","destinationId","feeSchedule","paymentMethodId"])
  ("invalid or misbound authorization %s is rejected",async(field)=>{
    const f=fixture();f.response({status:"prepare",authorization:{...f.a,[field]:field==="periodStart"?1:"wrong"}});
    await expect(f.claim()).rejects.toThrow();
  });
test("dispatch, receipt and finish use narrow scalar RPCs and no raw payment payload",async()=>{
  const f=fixture();f.response(null);
  await f.adapter.prepareDispatch(f.a.planId,"in_renewal","pi_renewal",f.token);
  await f.adapter.admitDispatch(f.a.planId,"in_renewal",f.token);
  f.response(true);
  expect(await f.adapter.recordReceipt(f.a.planId,{invoiceId:"in_renewal",paymentIntentId:"pi_renewal",amountCents:66633,
    applicationFeeCents:10425,paidAt:f.a.periodStart})).toBe(true);
  await f.adapter.completeAgreement(f.a.planId);
  expect(f.calls.map(c=>c.path)).toEqual(["prepare_exact_installment_dispatch","admit_exact_installment_dispatch",
    "record_exact_installment_renewal_receipt","complete_exact_installment_agreement"].map(v=>`/rest/v1/rpc/${v}`));
  expect(f.calls[2].body).toMatchObject({p_amount_cents:66633,p_application_fee_cents:10425});
});
test("prior-payment query requires sequential counted evidence and sorts the actual query",async()=>{
  const f=fixture();f.response([{payment_number:1,stripe_payment_intent_id:"pi_first"}]);
  expect(await f.adapter.priorPayments(f.a.planId)).toEqual([{paymentNumber:1,paymentIntentId:"pi_first"}]);
  expect(f.calls[0].query).toContain("counted_at=not.is.null");
  expect(f.calls[0].query).toContain("order=payment_number.asc");
  f.response([{payment_number:2,stripe_payment_intent_id:"pi_second"}]);
  await expect(f.adapter.priorPayments(f.a.planId)).rejects.toThrow("Invalid prior");
});
test("database errors are generic and do not leak raw connection/payment data",async()=>{
  const f=fixture();f.response({message:"synthetic-private-details"},403);
  await expect(f.claim()).rejects.toThrow("Exact invoice operation failed: claim_exact_installment_invoice");
  await expect(f.adapter.priorPayments(f.a.planId)).rejects.toThrow("Prior installment evidence unavailable");
});
test.each([null,{},[],1,"true"])("non-boolean receipt result %# is never success",async(value)=>{
  const f=fixture();f.response(value);
  await expect(f.adapter.recordReceipt(f.a.planId,{invoiceId:"in_renewal",paymentIntentId:"pi_renewal",amountCents:66633,
    applicationFeeCents:10425,paidAt:f.a.periodStart})).rejects.toThrow("Invalid renewal receipt response");
});
