/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const paid=Math.floor(Date.now()/1000)-60;
function original(file:string,name:string){const s=readFileSync(`supabase/proposals/${file}.sql`,"utf8");
  const start=s.indexOf(`create function public.${name}(`);if(start<0)throw Error("Missing original function");
  return s.slice(start,s.indexOf("$$;",s.indexOf("as $$",start)+5)+3);}
beforeAll(async()=>{
  db=createLocalPostgres();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table profiles(id uuid primary key,total_earnings_cents bigint default 0);
    create table posts(id uuid primary key,purchase_count integer default 0);
    create table purchases(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,order_id uuid,
      amount_cents bigint,currency text,status text,session_id text,subscription_id text,payment_intent_id text,
      fixed_service_consent_id uuid,access_granted boolean default false,earnings_credited_at timestamptz,
      earnings_credited_cents integer,is_refund boolean default false,is_suspect boolean default false);
    create table product_purchase_consents_v1(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,terms jsonb,accepted_at timestamptz);
    create table product_checkout_records_v1(attempt_key uuid,purchase_consent_id uuid,stripe_checkout_session_id text,order_id uuid,
      buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid);
    create table full_server_payment_receipts_v1(attempt_id uuid primary key,payment_intent_id text,charge_id text,proof jsonb);
    create table server_payment_protocols_v1(attempt_id uuid primary key,kind text,source jsonb);
    create table payment_fee_ledger(id uuid,purchase_id uuid,stripe_payment_intent_id text,stripe_charge_id text,gross_amount_cents bigint,
      status text,refunded_amount_cents bigint,earnings_reversed_cents bigint,dispute_status text);
    create table fixed_purchase_service_contracts_v1(purchase_id uuid primary key,consent_id uuid,payment_intent_id text,charge_id text,
      version text,service_months integer,service_start_at bigint,service_end_at bigint,financial_access boolean,access_updated_at timestamptz);`);
  await db.exec(original("096-independent-fixed-service","fixed_service_end_v1"));
  for(const name of ["attach_fixed_service_consent_v1","bind_fixed_service_one_time_v1"])
    await db.exec(original("097-fixed-service-one-time",name).replaceAll("from public.product_checkout_attempts attempt","from public.product_checkout_records_v1 attempt"));
  const mask=readFileSync("supabase/proposals/097-fixed-service-one-time.sql","utf8");const start=mask.indexOf("create or replace function public.mask_fixed_service_access_v1()");
  await db.exec(mask.slice(start,mask.indexOf("$$;",mask.indexOf("as $$",start)+5)+3));
  await db.exec(`create trigger attach_fixed_service_consent_v1 before insert or update on purchases for each row execute function attach_fixed_service_consent_v1();
    create trigger fixed_service_access_v1 before insert or update of access_granted on purchases for each row execute function mask_fixed_service_access_v1();`);
  await db.exec(readFileSync("test-support/staging-one-time-earnings.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/20260923014620_full_server_payment_service_binding.sql","utf8"));
});
beforeEach(async()=>{
  await db.exec("begin");
  await db.query("insert into profiles(id) values($1)",[id(3)]);await db.query("insert into posts(id) values($1)",[id(5)]);
  await db.query("insert into product_purchase_consents_v1 values($1,$2,$3,$4,$5,$6,to_timestamp($7))",
    [id(8),id(2),id(3),id(4),id(5),{amountCents:10000,serviceMonths:36,serviceVersion:"fixed-service-months-v1"},paid-60]);
  await db.query("insert into server_payment_protocols_v1 values($1,'full',$2)",[id(1),{attempt_key:id(6),purchase_consent_id:id(8)}]);
  await db.query("insert into full_server_payment_receipts_v1 values($1,'pi_owned','ch_owned',$2)",[id(1),{
    buyerId:id(2),creatorId:id(3),productId:id(4),postId:id(5),orderId:id(7),purchaseConsentId:id(8),amountCents:10000,paidAt:paid}]);
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
async function purchase(session:string|null=null){
  await db.query(`insert into purchases(id,buyer_id,creator_id,product_id,post_id,order_id,amount_cents,currency,status,session_id,payment_intent_id,access_granted)
    values($1,$2,$3,$4,$5,$6,10000,'usd','paid',$7,'pi_owned',true)`,[id(9),id(2),id(3),id(4),id(5),id(7),session]);
}
async function credit(){return (await db.query<{v:boolean}>("select credit_purchase_earnings($1,8480) v",[id(9)])).rows[0].v;}
async function ledger(){await db.query("insert into payment_fee_ledger values($1,$2,'pi_owned','ch_owned',10000,'paid',0,0,null)",[id(10),id(9)]);}
const bind=(key:string|null=id(6),charge="ch_owned",at=paid)=>db.query("select bind_fixed_service_one_time_v1($1,$2,$3,'pi_owned',$4,$5,10000,'usd') v",[id(9),id(8),key,charge,at]);
test("manual source attaches accepted service, masks access and uses existing once-only earnings before binding",async()=>{
  await purchase();expect((await db.query("select fixed_service_consent_id,access_granted from purchases")).rows)
    .toEqual([{fixed_service_consent_id:id(8),access_granted:false}]);
  expect(await credit()).toBe(true);expect(await credit()).toBe(false);await ledger();await bind();await bind();
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:8480}]);
  expect((await db.query("select purchase_count from posts")).rows).toEqual([{purchase_count:1}]);
  expect((await db.query("select service_months,service_start_at::bigint::text,financial_access from fixed_purchase_service_contracts_v1")).rows)
    .toEqual([{service_months:36,service_start_at:String(paid),financial_access:true}]);
});
test("existing Checkout source still binds without manual receipts",async()=>{
  await db.exec("delete from full_server_payment_receipts_v1");
  await db.query("insert into product_checkout_records_v1 values($1,$2,'cs_owned',$3,$4,$5,$6,$7)",[id(6),id(8),id(7),id(2),id(3),id(4),id(5)]);
  await purchase("cs_owned");await credit();await ledger();await bind();
  expect((await db.query("select count(*)::int n from fixed_purchase_service_contracts_v1")).rows).toEqual([{n:1}]);
});
test.each(["missing receipt","foreign buyer","wrong order","wrong amount","subscription"])("%s cannot acquire a manual service promise",async issue=>{
  if(issue==="missing receipt")await db.exec("delete from full_server_payment_receipts_v1");
  else if(issue==="subscription"){}else{
    const field=issue==="foreign buyer"?"buyerId":issue==="wrong order"?"orderId":"amountCents";
    await db.query("update full_server_payment_receipts_v1 set proof=jsonb_set(proof,array[$1],$2::jsonb)",[field,JSON.stringify(field==="amountCents"?9999:id(90))]);
  }
  await purchase();if(issue==="subscription")await db.exec("update purchases set subscription_id='sub_other'");
  await credit();await ledger();await expect(bind()).rejects.toThrow();
});
test.each(["uncredited","missing ledger","refund","dispute","wrong key","missing key","wrong charge","wrong date"])("%s blocks initial manual service binding",async issue=>{
  await purchase();if(issue!=="uncredited")await credit();if(issue!=="missing ledger")await ledger();
  if(issue==="refund")await db.exec("update payment_fee_ledger set refunded_amount_cents=1");
  if(issue==="dispute")await db.exec("update payment_fee_ledger set dispute_status='needs_response'");
  await expect(bind(issue==="missing key"?null:issue==="wrong key"?id(90):id(6),issue==="wrong charge"?"ch_other":"ch_owned",issue==="wrong date"?paid-1:paid)).rejects.toThrow();
});
test("service replay never restores a later financial revocation or shifts dates",async()=>{
  await purchase();await credit();await ledger();await bind();await db.exec("update purchases set status='refunded',access_granted=false");await bind();
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:false}]);
});
test.each(["anon","authenticated","service_role"])("%s cannot call the private manual provenance predicate",async role=>{
  await purchase();await db.exec(`set local role ${role}`);
  await expect(db.exec("select full_server_payment_service_consent_v1(null::purchases)")).rejects.toThrow("permission denied");
});
