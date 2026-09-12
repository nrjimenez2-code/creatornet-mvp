import type { SupabaseClient } from "@supabase/supabase-js";
import { exactAdminEnabled, parseExactStopInput, readExactAdminPage } from "../lib/installments/adminActions";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
const f = exactInstallmentFixture();
const env = { ...f.env, CREATOR_EXACT_INSTALLMENTS_ADMIN_READY:"true", CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",
  CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true", CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY:"true",
  CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true" };
const request = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const input = { agreementId:f.agreement.id, requestId:request, confirmation:"STOP_FUTURE_BILLING" };
function fixture() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    exact_installment_agreements:[{id:f.agreement.id,terms:f.terms,status:"active",purchase_id:f.terms.productId}],
    exact_installment_collection_holds:[], exact_installment_billing_stops:[], exact_installment_payment_recoveries:[],
  };
  const errors = new Set<string>();
  const calls: Array<[string,string,unknown[]]> = [];
  const from = jest.fn((name:string) => {
    const q: Record<string, unknown> = {};
    for(const method of ["select","order","limit","gt","in"]) q[method] = (...args:unknown[]) => {calls.push([name,method,args]); return q;};
    q.then = (resolve:(v:unknown)=>unknown) => Promise.resolve({data:tables[name],error:errors.has(name)?{message:"SECRET"}:null}).then(resolve);
    return q;
  });
  return {tables,errors,calls,from,admin:{from} as unknown as SupabaseClient};
}
test("all independent gates are needed and production can never enable these actions",()=>{
  expect(exactAdminEnabled(env)).toBe(true);
  for(const key of ["CREATOR_EXACT_INSTALLMENTS_ADMIN_READY","CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY",
    "CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY","CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY","CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY"]) {
    expect(exactAdminEnabled({...env,[key]:"false"})).toBe(false);
  }
  for(const v of [{VERCEL_ENV:"production"},{STRIPE_SECRET_KEY:"sk_live_fake"},{NEXT_PUBLIC_SUPABASE_URL:"https://production.supabase.co"},
    {NEXT_PUBLIC_SITE_URL:"https://www.creatornet.net"}]) expect(exactAdminEnabled({...env,...v})).toBe(false);
});
test("stop request only accepts the exact confirmation and identifiers; actor/amount are server controlled",()=>{
  expect(parseExactStopInput(input)).toEqual({agreementId:f.agreement.id,requestId:request});
  for(const body of [null,[],{}, {...input,confirmation:true},{...input,agreementId:"bad"},{...input,requestId:null},
    {...input,actorId:f.terms.creatorId},{...input,refund:true},{...input,amountCents:1}]) expect(parseExactStopInput(body)).toBeNull();
});
test("disabled admin controls perform no new-table reads",async()=>{
  const x=fixture(); await expect(readExactAdminPage(x.admin,f.terms.creatorId,null,{})).rejects.toThrow("unavailable");
  expect(x.from).not.toHaveBeenCalled();
});
test("review projects only safe fields and never returns provider secrets or payment URLs",async()=>{
  const x=fixture(); x.tables.exact_installment_agreements[0].client_secret="SECRET";
  x.tables.exact_installment_agreements[0].terms={...f.terms,client_secret:"SECRET"};
  x.tables.exact_installment_collection_holds=[{agreement_id:f.agreement.id,reason:"cancellation_review",request_id:request,requested_by:f.terms.creatorId}];
  x.tables.exact_installment_payment_recoveries=[{agreement_id:f.agreement.id,outcome:"paid_accounted",observed_at:"2026-09-06T01:00:00Z",evidence:{secret:"SECRET"}}];
  const result=await readExactAdminPage(x.admin,f.terms.creatorId,null,env);
  expect(result.plans[0]).toMatchObject({title:f.terms.title,stop:{status:"requested",requestId:request,ownedByCaller:true},
    recoveries:[{outcome:"paid_accounted",observedAt:"2026-09-06T01:00:00Z"}]});
  expect(JSON.stringify(result)).not.toMatch(/SECRET|customerId|paymentIntentId|destinationId|previewOrigin|evidence/);
});
test("another administrator sees but cannot impersonate the original stop actor",async()=>{
  const x=fixture();x.tables.exact_installment_collection_holds=[{agreement_id:f.agreement.id,reason:"cancellation_review",request_id:request,requested_by:f.terms.buyerId}];
  x.tables.exact_installment_billing_stops=[{agreement_id:f.agreement.id,request_id:request,actor_id:f.terms.buyerId,status:"running"}];
  const r=await readExactAdminPage(x.admin,f.terms.creatorId,null,env);
  expect(r.plans[0].stop).toEqual({requestId:request,status:"running",ownedByCaller:false});
});

test("interrupted recovery before first observation is review, not successful payment",async()=>{
  const x=fixture();x.tables.exact_installment_payment_recoveries=[{agreement_id:f.agreement.id,outcome:null,observed_at:null}];
  const r=await readExactAdminPage(x.admin,f.terms.creatorId,null,env);
  expect(r.plans[0].recoveries).toEqual([{outcome:"review_required",observedAt:null}]);
});

test("a hosted row cap of exactly 1000 cannot look like a complete review",async()=>{
  const x=fixture();x.tables.exact_installment_collection_holds=Array(1000).fill({agreement_id:f.agreement.id,reason:"invoice_recovery"});
  await expect(readExactAdminPage(x.admin,f.terms.creatorId,null,env)).rejects.toThrow("incomplete");
});
test("keyset pagination is bounded and reports next page rather than claiming all plans were reviewed",async()=>{
  const x=fixture();const row=x.tables.exact_installment_agreements[0];
  x.tables.exact_installment_agreements=Array.from({length:26},(_,i)=>({...row,id:`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12,"0")}`}));
  const r=await readExactAdminPage(x.admin,f.terms.creatorId,f.agreement.id,env);
  expect(r.plans).toHaveLength(25);expect(r.nextCursor).toBe(r.plans[24].id);
  expect(x.calls).toContainEqual(["exact_installment_agreements","limit",[26]]);
  expect(x.calls).toContainEqual(["exact_installment_agreements","gt",["id",f.agreement.id]]);
});
test.each(["exact_installment_agreements","exact_installment_collection_holds","exact_installment_billing_stops","exact_installment_payment_recoveries"])
("%s lookup errors are not an empty review queue",async(table)=>{
  const x=fixture();x.errors.add(table);
  await expect(readExactAdminPage(x.admin,f.terms.creatorId,null,env)).rejects.not.toThrow("SECRET");
});
test.each(["duplicate stop","wrong actor","malformed state","unbounded holds","foreign row"])("rejects %s before presenting actions",async(problem)=>{
  const x=fixture();const h={agreement_id:f.agreement.id,reason:"cancellation_review",request_id:request,requested_by:f.terms.creatorId};
  x.tables.exact_installment_collection_holds=[h];
  if(problem==="duplicate stop") x.tables.exact_installment_collection_holds.push({...h,request_id:f.terms.buyerId});
  if(problem==="wrong actor") x.tables.exact_installment_billing_stops=[{agreement_id:f.agreement.id,request_id:request,actor_id:f.terms.buyerId,status:"running"}];
  if(problem==="malformed state") x.tables.exact_installment_payment_recoveries=[{agreement_id:f.agreement.id,outcome:"SUCCESS",observed_at:null}];
  if(problem==="unbounded holds") x.tables.exact_installment_collection_holds=Array(1001).fill(h);
  if(problem==="foreign row") x.tables.exact_installment_collection_holds=[{...h,agreement_id:f.terms.buyerId}];
  await expect(readExactAdminPage(x.admin,f.terms.creatorId,null,env)).rejects.toThrow();
});
