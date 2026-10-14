/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {calculateCreatorFees} from "../lib/money";
import {fullServerPaymentContract} from "../lib/fullServerPayment";
import {serverPaymentCreateRequest} from "../lib/serverPaymentConfirmation";
import {mentorshipInstallmentQuote} from "../lib/mentorshipInstallmentQuote";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,contract:any,terminal:any,original:any;
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_owned",
  supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const evidence={approvedContext:context,vercelEnvironment:"preview",stripeSecretKeyMode:"test",stripePublishableKeyMode:"test",
  observedPlatformAccountId:context.platformAccountId,observedSupabaseProjectRef:context.supabaseProjectRef,
  configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin};
const schedule={enabled:true,basisPoints:290,fixedCents:30,version:"fees-v1"};
const candidate={id:id(1),buyer_id:id(2),creator_id:id(3),product_id:id(4),post_id:id(5),purchase_identity:`post:${id(5)}`,
  attempt_key:id(6),order_id:id(7),terms_fingerprint:"a".repeat(64),purchase_consent_id:id(8)};
const query=async(sql:string,args:any[]=[]) => {
  const value=(await db.query<any>(sql,args)).rows[0]?.r;
  // Match the JSON boundary of PostgREST, including this Jest VM's prototypes.
  return value===undefined?undefined:JSON.parse(JSON.stringify(value));
};
const rpc=async(name:string,extra:any[]=[])=>query(`select ${name}(${[id(1),id(2),context,...extra].map((_,i)=>`$${i+1}`).join(",")}) r`,[id(1),id(2),context,...extra]);
const proof=()=>({version:"full-manual-payment-stop-v1",manualPayment:terminal,amountCents:10001,currency:"usd",
  paymentIntent:{id:"pi_owned",status:"canceled",amountReceived:0,amountCapturable:0},observedAt:terminal.observedAt});
const release=(p:any=proof(),buyer=id(2),key=id(6),ctx:object=context)=>query("select release_product_checkout_stop_v1($1,$2,$3,$4,$5) r",[id(1),buyer,key,ctx,p]);
const archived=(buyer=id(2),key=id(6),ctx:object=context)=>query("select read_full_manual_release_v1($1,$2,$3,$4) r",[id(1),buyer,key,ctx]);
beforeAll(async()=>{
  db=createLocalPostgres();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table exact_installment_context_pin_v2(singleton boolean primary key,context jsonb unique);
    create table product_purchase_consents_v1(id uuid primary key,terms jsonb,accepted_at timestamptz default clock_timestamp());
    create table product_checkout_attempts(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,
      purchase_identity text,attempt_key uuid,order_id uuid,terms_fingerprint text,purchase_consent_id uuid,checkout_kind text,status text,
      buyer_installment_reservation_id uuid,stripe_checkout_session_id text,stripe_checkout_url text,updated_at timestamptz default now());
    create table buyer_mentorship_installment_reservations_v1(id uuid primary key,request_id uuid,attempt_id uuid,buyer_id uuid,
      creator_id uuid,product_id uuid,post_id uuid,context jsonb,status text,released_at timestamptz,
      accepted_at timestamptz,terms jsonb,fingerprint text,destination_id text);
    create table buyer_mentorship_bootstraps_v1(reservation_id uuid,customer_id text,anchor_seconds bigint);
    create table buyer_mentorship_bootstrap_operations_v1(reservation_id uuid,step text,request jsonb,result_id text,bound_at timestamptz,lease_until timestamptz);
    create table buyer_mentorship_first_receipts_v1(reservation_id uuid);
    create table buyer_mentorship_activation_operations_v1(reservation_id uuid);
    create table buyer_mentorship_abandonment_holds_v1(reservation_id uuid);
    create table purchases(id uuid primary key,buyer_id uuid,session_id text,status text,payment_intent_id text,access_granted boolean,
      earnings_credited_at timestamptz,is_refund boolean,is_suspect boolean,creator_id uuid,product_id uuid,post_id uuid,order_id uuid,
      amount_cents bigint,currency text,subscription_id text,fixed_service_consent_id uuid);
    create table profiles(id uuid,stripe_account_id text,stripe_onboarding_complete boolean);
    create table orders(id uuid primary key,buyer_id uuid,creator_id uuid,post_id uuid,status text,currency text,amount_cents bigint,
      gross_amount bigint,platform_fee bigint,processing_fee bigint,total_creator_deduction bigint,creator_amount bigint,fee_schedule_version text,
      stripe_checkout_session_id text,stripe_payment_intent_id text);
    create table payment_fee_ledger(id uuid primary key,order_id uuid,purchase_id uuid);
    create table refund_operations(id uuid primary key,order_id uuid,purchase_id uuid);
    create table fixed_purchase_service_contracts_v1(purchase_id uuid primary key);
    grant select,insert,update,delete on product_checkout_attempts,orders,purchases to service_role;
    grant select on payment_fee_ledger,refund_operations,product_purchase_consents_v1 to service_role;`);
  const migrations=["20260921103742_product_checkout_original_request.sql","20260921144337_product_checkout_stop_intent.sql",
    "20260921144757_product_checkout_stop_operations.sql","20260921145555_product_checkout_stop_proof.sql"];
  for(const name of migrations)await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
  const service=readFileSync("supabase/proposals/097-fixed-service-one-time.sql","utf8");
  for(const name of ["attach_fixed_service_consent_v1","bind_fixed_service_one_time_v1"]){
    const a=service.indexOf("create function public."+name),start=a>=0?a:service.indexOf("create or replace function public."+name);
    if(start<0)throw Error("Missing existing service function");await db.exec(service.slice(start,service.indexOf("end $$;",start)+7));
  }
  for(const name of ["20260921145930_product_checkout_verified_release.sql","20260921173504_server_payment_protocol.sql",
    "20260921175109_server_payment_intent_operations.sql","20260921201913_server_payment_intent_cancellation.sql",
    "20260923005519_full_server_payment_source.sql"])
    await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
  await db.exec(readFileSync("supabase/migrations/20260924071323_manual_intent_card_only.sql","utf8"));
  // Structural financial dependencies only; financial accounting is exercised
  // in its existing suites. These rows must all deny unpaid release.
  for(const name of ["full_server_payment_receipts_v1","full_server_payment_financial_holds_v1","full_server_payment_refund_events_v1",
    "full_server_payment_dispute_events_v1","full_server_payment_refund_object_events_v1"])
    await db.exec(`create table ${name}(attempt_id uuid primary key);`);
  await db.exec(readFileSync("supabase/migrations/20260923044310_full_manual_payment_release.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/20260923052646_full_unclaimed_payment_release.sql","utf8"));
  await db.exec(`create table products(id uuid primary key,creator_id uuid,type text,active boolean,amount_cents bigint,price_cents bigint,
    membership_terms jsonb,currency text,title text,description text,fixed_service_months integer,installment_options integer[]);
    create table posts(id uuid primary key,product_id uuid,creator_id uuid);
    alter table buyer_mentorship_installment_reservations_v1 add column terms_text text,
      alter column status set default 'reserved',alter column accepted_at set default clock_timestamp();
    alter table product_checkout_attempts alter column status set default 'creating';`);
  const acceptance=readFileSync("supabase/migrations/20260921012900_buyer_mentorship_installment_reservations.sql","utf8");
  for(const name of ["reserve_buyer_mentorship_installments_v1"]){
    const start=acceptance.indexOf("create function public."+name);
    if(start<0)throw Error("Missing real installment function");
    await db.exec(acceptance.slice(start,acceptance.indexOf("$$;",start)+3));
  }
  const description=readFileSync("supabase/proposals/096-independent-fixed-service.sql","utf8");
  const descriptionStart=description.indexOf("create function public.fixed_service_description_v1(");
  await db.exec(description.slice(descriptionStart,description.indexOf("$$;",descriptionStart)+3));
  await db.exec(`create trigger guard_buyer_installment_checkout_v1 before insert or update or delete on product_checkout_attempts
    for each row execute function guard_buyer_installment_checkout_v1();`);
});
beforeEach(async()=>{
  await db.exec("begin");
  await db.query("insert into exact_installment_context_pin_v2 values(true,$1)",[context]);
  const terms={kind:"one_time",version:"policy-v1",buyerId:id(2),creatorId:id(3),productId:id(4),postId:id(5),amountCents:10001,currency:"usd"};
  const accepted=await query("insert into product_purchase_consents_v1 values($1,$2,clock_timestamp()-interval '1 second') returning to_jsonb(product_purchase_consents_v1) r",[id(8),terms]);
  const pin=await query("select reserve_full_server_payment_v1($1,$2,$3) r",[candidate,id(2),context]);
  const fees=calculateCreatorFees(10001,schedule);
  const order=await query(`insert into orders(id,buyer_id,creator_id,post_id,status,currency,amount_cents,gross_amount,platform_fee,processing_fee,
    total_creator_deduction,creator_amount,fee_schedule_version) values($1,$2,$3,$4,'created','usd',10001,10001,$5,$6,$7,$8,$9) returning to_jsonb(orders) r`,
    [id(7),id(2),id(3),id(5),fees.platformFeeCents,fees.processingFeeCents,fees.totalCreatorDeductionCents,fees.creatorNetCents,fees.feeScheduleVersion]);
  await db.query("insert into profiles values($1,'acct_creator',true)",[id(3)]);
  contract=fullServerPaymentContract({selection:pin,consent:accepted,order,destinationId:"acct_creator",processingFees:schedule,context});
  const request=serverPaymentCreateRequest(contract,evidence);
  await rpc("save_full_server_payment_contract_v1",[contract,request]);
  const op=(await rpc("claim_server_payment_intent_v1",[contract,request])).operation;
  const pi={...request.params,id:"pi_owned",object:"payment_intent",livemode:false,customer:null,setup_future_usage:null,
    status:"requires_payment_method",created:Math.floor(Date.parse(op.first_dispatch_at)/1000),payment_method_types:["card"],
    amount_received:0,amount_capturable:0,payment_method:null,latest_charge:null,last_payment_error:null,on_behalf_of:null,shipping:null,transfer_group:null};
  await rpc("bind_server_payment_intent_v1",[op.lease_token,pi,"req_owned"]);
  await rpc("request_server_payment_stop_v1");
  terminal={version:"server-payment-intent-terminal-v1",paymentIntentId:"pi_owned",status:"canceled",amountReceived:0,amountCapturable:0,
    canceledAt:pi.created,chargeIds:[],observedAt:Math.floor(Date.now()/1000)};
  await rpc("record_server_payment_terminal_v1",[terminal]);
  original=await query("select to_jsonb(product_checkout_attempts) r from product_checkout_attempts");
  await db.exec("set local role service_role");
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});

const unclaimed=()=>query("select release_unclaimed_full_payment_v1($1,$2,$3,$4) r",[id(1),id(2),id(6),context]);
async function beforeClaim(removeOrder=false){
  await db.exec("reset role;delete from server_payment_intent_terminal_v1;delete from server_payment_intent_operations_v1;delete from server_payment_stops_v1;");
  if(removeOrder)await db.exec("delete from full_server_payment_sources_v1;delete from orders;");
  await db.exec("set local role service_role");
}
test.each([false,true])("unclaimed release archives with absent order=%s and permanently stops dispatch",async absent=>{
  await beforeClaim(absent);const released=await unclaimed();expect(released).toMatchObject({attempt_id:id(1),product_id:id(4)});
  expect(await archived()).toEqual(released);expect(await unclaimed()).toEqual(released);
  expect((await db.query("select * from product_checkout_attempts")).rows).toEqual([]);
  expect((await db.query("select * from server_payment_stops_v1")).rows).toHaveLength(1);
  const h=(await db.query<any>("select * from product_checkout_releases_v1")).rows[0];
  expect(h.original_attempt).toEqual(original);expect(h.original_purchases).toEqual([]);
  if(absent)expect(h.original_order).toBeNull();
  else expect((await db.query<any>("select status from orders")).rows[0].status).toBe("canceled");
  await db.exec("savepoint stopped");
  await expect(rpc("claim_server_payment_intent_v1",[contract,serverPaymentCreateRequest(contract,evidence)])).rejects.toThrow();
  await db.exec("rollback to stopped");
  expect(await archived()).toEqual(released);
});
test("claimed but unbound create cannot be declared absent",async()=>{
  await db.exec("reset role;delete from server_payment_intent_terminal_v1;update server_payment_intent_operations_v1 set payment_intent_id=null,provider_request_id=null,bound_at=null;set local role service_role;");
  expect(await unclaimed()).toBeNull();expect(await archived()).toBeNull();
  expect((await db.query("select * from product_checkout_attempts")).rows).toHaveLength(1);
});
test("reservation and order without a saved source can be released",async()=>{
  await beforeClaim();await db.exec("reset role;delete from full_server_payment_sources_v1;set local role service_role;");
  expect(await unclaimed()).toMatchObject({attempt_id:id(1)});expect(await archived()).toBeTruthy();
});
test.each(["owner","key","context"])("unclaimed release rejects wrong %s",async kind=>{
  await beforeClaim();
  await expect(query("select release_unclaimed_full_payment_v1($1,$2,$3,$4) r",
    [id(1),kind==="owner"?id(99):id(2),kind==="key"?id(99):id(6),kind==="context"?{...context,mode:"live"}:context])).rejects.toThrow();
});
test.each(["paid order","intent on order","wrong order owner","fee ledger","refund operation","purchase"])
("unclaimed %s remains held with no archive",async issue=>{
  await beforeClaim();await db.exec("reset role");
  if(issue==="paid order")await db.exec("update orders set status='paid'");
  if(issue==="intent on order")await db.exec("update orders set stripe_payment_intent_id='pi_unknown'");
  if(issue==="wrong order owner")await db.query("update orders set buyer_id=$1",[id(99)]);
  if(issue==="fee ledger")await db.query("insert into payment_fee_ledger(id,order_id) values($1,$2)",[id(99),id(7)]);
  if(issue==="refund operation")await db.query("insert into refund_operations(id,order_id) values($1,$2)",[id(99),id(7)]);
  if(issue==="purchase")await db.query("insert into purchases(id,buyer_id,product_id,post_id) values($1,$2,$3,$4)",[id(99),id(2),id(4),id(5)]);
  await db.exec("set local role service_role;savepoint refused");await expect(unclaimed()).rejects.toThrow();
  await db.exec("rollback to refused");expect(await archived()).toBeNull();
  expect((await db.query("select * from server_payment_stops_v1")).rows).toEqual([]);
});
test.each(["order","attempt"])("delayed %s insert cannot revive an unclaimed release",async target=>{
  await beforeClaim(true);await unclaimed();
  if(target==="order")await expect(db.query("insert into orders(id,buyer_id,creator_id,post_id,status) values($1,$2,$3,$4,'created')",
    [id(7),id(2),id(3),id(5)])).rejects.toThrow("cannot recreate its order");
  else await expect(db.query("insert into product_checkout_attempts select * from jsonb_populate_record(null::product_checkout_attempts,$1)",[original]))
    .rejects.toThrow("cannot recreate its attempt");
});
test.each(["full_server_payment_receipts_v1","full_server_payment_financial_holds_v1","full_server_payment_refund_events_v1",
  "full_server_payment_dispute_events_v1","full_server_payment_refund_object_events_v1"])("unclaimed release retains %s",async table=>{
  await beforeClaim();await db.exec("reset role");await db.query(`insert into ${table} values($1)`,[id(1)]);await db.exec("set local role service_role");
  await expect(unclaimed()).rejects.toThrow("requires reconciliation");
});
test("unclaimed release cannot be invoked by browser roles",async()=>{
  const rows=(await db.query(`select has_function_privilege('anon','release_unclaimed_full_payment_v1(uuid,uuid,uuid,jsonb)','EXECUTE') anon,
    has_function_privilege('authenticated','release_unclaimed_full_payment_v1(uuid,uuid,uuid,jsonb)','EXECUTE') auth`)).rows;
  expect(rows).toEqual([{anon:false,auth:false}]);
});

test("manual terminal release reuses the exact archive and cancels only its order",async()=>{
  expect(await archived()).toBeNull();const result=await release();
  expect(result).toMatchObject({attempt_id:id(1),product_id:id(4)});
  expect(await archived()).toEqual(result);expect(await release(null)).toEqual(result);
  expect((await db.query("select * from product_checkout_attempts")).rows).toEqual([]);
  expect(await query("select status r from orders")).toBe("canceled");
  expect(await query("select original_attempt r from product_checkout_releases_v1")).toEqual(original);
  expect(await query("select original_order->>'status' r from product_checkout_releases_v1")).toBe("created");
  expect(await query("select count(*)::int r from server_payment_intent_operations_v1")).toBe(1);
  expect(await query("select proof->>'version' r from product_checkout_stop_proofs_v1")).toBe("full-manual-payment-stop-v1");
});
test("archived original replay cannot stop or delete a newer full selection",async()=>{
  const result=await release();
  const next={...candidate,id:id(11),attempt_key:id(16),order_id:id(17)};
  await query("select reserve_full_server_payment_v1($1,$2,$3) r",[next,id(2),context]);
  expect(await archived()).toEqual(result);expect(await release(null)).toEqual(result);
  expect(await query("select id r from product_checkout_attempts")).toBe(id(11));
  expect(await query("select count(*)::int r from server_payment_stops_v1")).toBe(1);
});
test("the additive manual migration preserves genuine hosted Checkout release",async()=>{
  const metadata={buyer_id:id(12),creator_id:id(3),product_id:id(14),order_id:id(17),checkout_attempt_key:id(16),checkout_terms_fingerprint:"hosted-terms"};
  const request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params:{mode:"payment",payment_method_types:["card"],
    metadata,payment_intent_data:{metadata},line_items:[{price_data:{unit_amount:10000,currency:"usd"},quantity:1}]}};
  await db.query(`insert into product_checkout_attempts(id,buyer_id,creator_id,product_id,order_id,attempt_key,terms_fingerprint,
    checkout_kind,status,original_request_protocol) values($1,$2,$3,$4,$5,$6,'hosted-terms','full','creating','product-checkout-original-v1')`,
    [id(11),id(12),id(3),id(14),id(17),id(16)]);
  await query("select claim_product_checkout_original_request_v1($1,$2,$3,$4,$5) r",[id(11),id(12),id(16),context,request]);
  await db.query("update product_checkout_attempts set stripe_checkout_session_id='cs_test_legacy',status='open',original_request_lease_until=clock_timestamp()-interval '1 second' where id=$1",[id(11)]);
  await query("select request_product_checkout_stop_v1($1,$2,$3,$4) r",[id(11),id(12),id(16),context]);
  await db.query("insert into orders(id,buyer_id,creator_id,status,stripe_checkout_session_id,amount_cents,currency) values($1,$2,$3,'created','cs_test_legacy',10000,'usd')",[id(17),id(12),id(3)]);
  const hostedProof={version:"product-unpaid-stop-v1",sessionId:"cs_test_legacy",checkoutStatus:"expired",paymentStatus:"unpaid",amountCents:10000,
    currency:"usd",paymentIntent:null,observedAt:Math.floor(Date.now()/1000)};
  expect(await query("select release_product_checkout_stop_v1($1,$2,$3,$4,$5) r",[id(11),id(12),id(16),context,hostedProof]))
    .toMatchObject({attempt_id:id(11),product_id:id(14)});
  expect(await query("select id r from product_checkout_attempts")).toBe(id(1));
});
test("a creator-approved installment choice is admitted only after the full original is archived",async()=>{
  await db.exec("reset role");
  await db.query("insert into products values($1,$2,'mentorship',true,10001,null,null,'usd','Mentorship','',null,'{3}')",[id(4),id(3)]);
  await db.query("insert into posts values($1,$2,$3)",[id(5),id(4),id(3)]);
  const quote=mentorshipInstallmentQuote({product:{id:id(4),creator_id:id(3),type:"mentorship",title:"Mentorship",amount_cents:10001,
    currency:"usd",installment_options:[3]},buyerId:id(2),postId:id(5),paymentCount:3,firstPaymentFees:schedule,renewalFees:schedule});
  const reserve=()=>query("select to_jsonb(reserve_buyer_mentorship_installments_v1($1,$2,$3,$4,$5,$6,$7)) r",
    [id(40),id(2),id(4),id(5),context,JSON.stringify(quote.terms),quote.fingerprint]);
  await db.exec("set local role service_role;savepoint before_choice");
  await expect(reserve()).rejects.toThrow("requires reconciliation");await db.exec("rollback to before_choice");
  const released=await release(),next=await reserve();
  expect(next).toMatchObject({request_id:id(40),buyer_id:id(2),product_id:id(4),status:"reserved",terms:quote.terms});
  expect(await archived()).toEqual(released);
  expect(await query("select checkout_kind r from product_checkout_attempts")).toBe("installments");
  expect(await query("select count(*)::int r from server_payment_intent_operations_v1")).toBe(1);
});
test.each(["foreign buyer","foreign key","foreign context","stale","wrong intent","money","different charges","extra","amount",
  "paid order","missing order","ledger","refund","purchase","receipt","hold","refund event","dispute event","refund object"])
("%s denies release atomically and preserves the original",async issue=>{
  await db.exec("reset role");let p=proof();
  if(issue==="stale")p={...p,observedAt:1,manualPayment:{...terminal,observedAt:1}};
  if(issue==="wrong intent")p.manualPayment={...terminal,paymentIntentId:"pi_other"};
  if(issue==="money")p.manualPayment={...terminal,amountReceived:10001};
  if(issue==="different charges")p.manualPayment={...terminal,chargeIds:["ch_other"]};
  if(issue==="extra")p={...p,releaseAllowed:true} as any;
  if(issue==="amount")p.amountCents++;
  if(issue==="paid order")await db.exec("update orders set status='paid'");
  if(issue==="missing order")await db.exec("delete from orders");
  if(issue==="ledger"||issue==="refund")await db.query(`insert into ${issue==="ledger"?"payment_fee_ledger":"refund_operations"}(id,order_id) values($1,$2)`,[id(20),id(7)]);
  if(issue==="purchase")await db.query("insert into purchases(id,buyer_id,product_id,post_id) values($1,$2,$3,$4)",[id(20),id(2),id(4),id(5)]);
  const tables:Record<string,string>={receipt:"receipts",hold:"financial_holds","refund event":"refund_events","dispute event":"dispute_events","refund object":"refund_object_events"};
  if(tables[issue])await db.query(`insert into full_server_payment_${tables[issue]}_v1 values($1)`,[id(1)]);
  await db.exec("set local role service_role;savepoint before_release");
  await expect(release(p,issue==="foreign buyer"?id(9):id(2),issue==="foreign key"?id(9):id(6),issue==="foreign context"?{...context,mode:"live"}:context)).rejects.toThrow();
  await db.exec("rollback to before_release");
  expect(await query("select count(*)::int r from product_checkout_releases_v1")).toBe(0);
  expect(await query("select to_jsonb(product_checkout_attempts) r from product_checkout_attempts")).toEqual(original);
});
test.each(["buyer","key","context"])("archive read rejects foreign %s",async issue=>{
  await release();await expect(archived(issue==="buyer"?id(9):id(2),issue==="key"?id(9):id(6),issue==="context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
test("direct deletion still requires archive proof and public callers cannot release",async()=>{
  await db.exec("savepoint before_delete");await expect(db.exec("delete from product_checkout_attempts")).rejects.toThrow("own terminal release proof");
  await db.exec("rollback to before_delete");
  expect(await query("select has_function_privilege('authenticated','record_full_manual_release_proof_v1(uuid,uuid,uuid,jsonb,jsonb)','EXECUTE') r")).toBe(false);
  expect(await query("select has_function_privilege('anon','read_full_manual_release_v1(uuid,uuid,uuid,jsonb)','EXECUTE') r")).toBe(false);
});

async function rejectedCreate(){
  await db.exec('reset role;delete from server_payment_intent_terminal_v1;delete from server_payment_stops_v1;');
  // Pre-upgrade persisted validation-rejected operation; fixture setup only.
  await db.exec(`update server_payment_intent_operations_v1 set payment_intent_id=null,provider_request_id=null,bound_at=null,
    lease_until=clock_timestamp()-interval '3 minutes',request=jsonb_set(request,'{params}',
      ((request->'params')-'payment_method_types')||'{"automatic_payment_methods":{"enabled":false}}'::jsonb);`);
  await db.exec('create table server_payment_confirmations_v1(attempt_id uuid);');
  await db.exec(readFileSync('supabase/migrations/20260924071351_sandbox_rejected_full_release.sql','utf8').replace(/^begin;/,' ').replace(/commit;\s*$/,' '));
  const op=await query('select to_jsonb(server_payment_intent_operations_v1) r from server_payment_intent_operations_v1');
  const evidence={version:'operator-reviewed-stripe-create-rejection-v1',requestId:'req_rejected',idempotencyKey:op.idempotency_key,
    request:op.request,context,status:400,error:{type:'invalid_request_error',param:'automatic_payment_methods',
      message:'You may only specify one of these parameters: automatic_payment_methods, confirmation_method.'},
    reviewedBy:'fixture-operator',observedAt:Math.floor(Date.now()/1000),providerInventoryComplete:true,matchingIntentIds:[]};
  await db.exec('set local role service_role');return {op,evidence};
}
const releaseRejected=(proof:any)=>query('select release_rejected_full_payment_v1($1,$2,$3,$4,$5) r',[id(1),id(2),id(6),context,proof]);

test('reviewed exact validation rejection releases once and preserves the immutable operation',async()=>{
  const f=await rejectedCreate();const result=await releaseRejected(f.evidence);
  expect(result).toMatchObject({attempt_id:id(1),product_id:id(4)});
  expect(await archived()).toEqual(result);expect(await releaseRejected(f.evidence)).toEqual(result);
  expect(await query('select to_jsonb(server_payment_intent_operations_v1) r from server_payment_intent_operations_v1')).toEqual(f.op);
  expect(await query('select count(*)::int r from server_payment_create_rejections_v1')).toBe(1);
  expect(await query('select count(*)::int r from product_checkout_attempts')).toBe(0);
  expect(await query('select status r from orders')).toBe('canceled');
  await db.exec('savepoint stopped');
  await expect(rpc('claim_server_payment_intent_v1',[contract,f.op.request])).rejects.toThrow();
  await db.exec('rollback to stopped');expect(await archived()).toEqual(result);
  expect(await query("select has_function_privilege('authenticated','release_rejected_full_payment_v1(uuid,uuid,uuid,jsonb,jsonb)','EXECUTE') r")).toBe(false);
  expect(await query("select has_function_privilege('anon','release_rejected_full_payment_v1(uuid,uuid,uuid,jsonb,jsonb)','EXECUTE') r")).toBe(false);
});

test.each(['key','request','context','status','error','request id','stale','future','reviewer','extra','inventory','intent found',
  'bound','lease','confirmation','receipt','hold','refund event','dispute event','ledger','purchase','paid order'])
('rejection release refuses %s atomically',async issue=>{
  const f=await rejectedCreate(),p:any=f.evidence;await db.exec('reset role');
  if(issue==='key')p.idempotencyKey+='changed';
  if(issue==='request')p.request.params.amount++;
  if(issue==='context')p.context={...context,mode:'live'};
  if(issue==='status')p.status=500;
  if(issue==='error')p.error={type:'api_error',message:'uncertain'};
  if(issue==='request id')p.requestId='pi_not_a_request';
  if(issue==='stale')p.observedAt-=180;
  if(issue==='future')p.observedAt+=180;
  if(issue==='reviewer')p.reviewedBy='';
  if(issue==='extra')p.authorized=true;
  if(issue==='inventory')p.providerInventoryComplete=false;
  if(issue==='intent found')p.matchingIntentIds=['pi_found'];
  if(issue==='bound')await db.exec("update server_payment_intent_operations_v1 set payment_intent_id='pi_other',provider_request_id='req_other',bound_at=clock_timestamp()");
  if(issue==='lease')await db.exec("update server_payment_intent_operations_v1 set lease_until=clock_timestamp()+interval '1 minute'");
  if(issue==='confirmation')await db.query('insert into server_payment_confirmations_v1 values($1)',[id(1)]);
  const tables:Record<string,string>={receipt:'receipts',hold:'financial_holds','refund event':'refund_events','dispute event':'dispute_events'};
  if(tables[issue])await db.query(`insert into full_server_payment_${tables[issue]}_v1 values($1)`,[id(1)]);
  if(issue==='ledger')await db.query('insert into payment_fee_ledger(id,order_id) values($1,$2)',[id(20),id(7)]);
  if(issue==='purchase')await db.query('insert into purchases(id,buyer_id,product_id,post_id) values($1,$2,$3,$4)',[id(20),id(2),id(4),id(5)]);
  if(issue==='paid order')await db.exec("update orders set status='paid'");
  await db.exec('set local role service_role;savepoint rejection');
  await expect(releaseRejected(p)).rejects.toThrow();await db.exec('rollback to rejection');
  expect(await query('select count(*)::int r from server_payment_create_rejections_v1')).toBe(0);
  expect(await query('select count(*)::int r from product_checkout_releases_v1')).toBe(0);
  expect(await query('select to_jsonb(product_checkout_attempts) r from product_checkout_attempts')).toEqual(original);
});
