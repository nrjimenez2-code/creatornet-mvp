/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_owned",
  supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const candidate=()=>({id:id(1),buyer_id:id(2),creator_id:id(3),product_id:id(4),post_id:id(5),purchase_identity:`post:${id(5)}`,
  attempt_key:id(6),order_id:id(7),terms_fingerprint:"a".repeat(64),purchase_consent_id:id(8)});
const reserve=async(attempt:object=candidate(),buyer=id(2),ctx=context)=>
  (await db.query<{result:any}>("select reserve_full_server_payment_v1($1,$2,$3) result",[attempt,buyer,ctx])).rows[0].result;
const pin=async(buyer=id(2),ctx=context)=>
  (await db.query<{result:any}>("select pin_installment_server_payment_v1($1,$2,$3) result",[id(10),buyer,ctx])).rows[0].result;
beforeAll(async()=>{
  db=createLocalPostgres();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table exact_installment_context_pin_v2(singleton boolean primary key,context jsonb unique);
    create table product_purchase_consents_v1(id uuid primary key,terms jsonb);
    create table product_checkout_attempts(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,
      purchase_identity text,attempt_key uuid,order_id uuid,terms_fingerprint text,purchase_consent_id uuid,checkout_kind text,status text,
      buyer_installment_reservation_id uuid,original_request_protocol text,original_request jsonb,
      stripe_checkout_session_id text,stripe_checkout_url text,updated_at timestamptz default now());
    create table buyer_mentorship_installment_reservations_v1(id uuid primary key,request_id uuid,attempt_id uuid,buyer_id uuid,
      creator_id uuid,product_id uuid,post_id uuid,context jsonb,status text,released_at timestamptz);
    create table buyer_mentorship_bootstrap_operations_v1(reservation_id uuid,step text);
    create table buyer_mentorship_first_receipts_v1(reservation_id uuid);
    create table buyer_mentorship_activation_operations_v1(reservation_id uuid);
    create table buyer_mentorship_abandonment_holds_v1(reservation_id uuid);
    create table purchases(buyer_id uuid,product_id uuid,post_id uuid);
    grant select,insert,update,delete on product_checkout_attempts to service_role;
    grant select,insert,update on buyer_mentorship_bootstrap_operations_v1,buyer_mentorship_abandonment_holds_v1 to service_role;`);
  await db.exec(readFileSync("supabase/migrations/20260921173504_server_payment_protocol.sql","utf8"));
});
beforeEach(async()=>{
  await db.exec("begin");
  await db.query("insert into exact_installment_context_pin_v2 values(true,$1)",[context]);
  await db.query("insert into product_purchase_consents_v1 values($1,$2)",[id(8),{kind:"one_time",buyerId:id(2),creatorId:id(3),productId:id(4),postId:id(5)}]);
});
afterEach(async()=>{await db.exec("rollback");});
afterAll(async()=>{await db.close();});
async function installment(){
  await db.query("insert into buyer_mentorship_installment_reservations_v1 values($1,$2,$3,$4,$5,$6,$7,$8,'reserved',null)",
    [id(9),id(10),id(1),id(2),id(3),id(4),id(5),context]);
  await db.query(`insert into product_checkout_attempts(id,buyer_id,creator_id,product_id,post_id,purchase_identity,attempt_key,order_id,
    terms_fingerprint,checkout_kind,status,buyer_installment_reservation_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'installments','creating',$10)`,
    [id(1),id(2),id(3),id(4),id(5),`post:${id(5)}`,id(6),id(7),"a".repeat(64),id(9)]);
}
test("full selection pins protocol and existing attempt atomically; exact owner replay preserves it",async()=>{
  await db.exec("set local role service_role");const p=await reserve();
  expect(p).toMatchObject({attempt_id:id(1),buyer_id:id(2),kind:"full",source:candidate(),protocol:"creatornet-us-manual-confirmation-v1"});
  expect(await reserve()).toEqual(p);
  expect((await db.query("select status,original_request,stripe_checkout_session_id from product_checkout_attempts")).rows)
    .toEqual([{status:"creating",original_request:null,stripe_checkout_session_id:null}]);
});
test.each(["same legacy id","different legacy attempt","existing purchase"])("%s cannot be adopted or bypassed",async issue=>{
  if(issue==="existing purchase")await db.query("insert into purchases values($1,$2,$3)",[id(2),id(4),id(5)]);
  else await db.query("insert into product_checkout_attempts(id,buyer_id,product_id) values($1,$2,$3)",[issue==="same legacy id"?id(1):id(20),id(2),id(4)]);
  await expect(reserve()).rejects.toThrow("original recovery");
});
test.each(["foreign buyer","foreign context","missing consent","wrong consent","injected request","changed identity"])
("full %s refuses a new protocol",async issue=>{
  const a={...candidate()} as any;
  if(issue==="missing consent")a.purchase_consent_id=null;
  if(issue==="wrong consent")await db.exec("update product_purchase_consents_v1 set terms='{}'");
  if(issue==="injected request")a.original_request={path:"/v1/checkout/sessions"};
  if(issue==="changed identity")a.purchase_identity=`product:${id(4)}`;
  await expect(reserve(a,issue==="foreign buyer"?id(3):id(2),issue==="foreign context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
test("source/context cannot be rewritten on replay",async()=>{
  await reserve();await expect(reserve({...candidate(),order_id:id(20)})).rejects.toThrow("changed");
});
test("failed parent insertion rolls protocol pin back atomically",async()=>{
  // An existing trigger can still reject; the pin RPC must not bypass it.
  await db.exec(`create function reject_test_attempt() returns trigger language plpgsql as $$ begin raise exception 'existing guard';end $$;
    create trigger reject_test_attempt before insert on product_checkout_attempts for each row execute function reject_test_attempt();savepoint before_pin;`);
  await expect(reserve()).rejects.toThrow("existing guard");await db.exec("rollback to before_pin");
  expect((await db.query("select * from server_payment_protocols_v1")).rows).toEqual([]);
});
test.each(["request","session","rotate","delete"])("manual full protocol blocks legacy %s",async issue=>{
  await reserve();await db.exec("set local role service_role");
  const sql=issue==="delete"?"delete from product_checkout_attempts":issue==="request"?
    "update product_checkout_attempts set original_request='{}'":issue==="session"?
    "update product_checkout_attempts set stripe_checkout_session_id='cs_test_other'":"update product_checkout_attempts set attempt_key=gen_random_uuid()";
  await expect(db.exec(sql)).rejects.toThrow(/Server payment|server payment/);
});
test("owned installments pin without changing archived acceptance and allow nonpayable bootstrap",async()=>{
  await installment();const before=(await db.query("select * from product_checkout_attempts")).rows;
  await db.exec("set local role service_role");const p=await pin();expect(await pin()).toEqual(p);
  expect(p).toMatchObject({kind:"first_installment",reservation_id:id(9),attempt_id:id(1)});
  expect((await db.query("select * from product_checkout_attempts")).rows).toEqual(before);
  await db.query("insert into buyer_mentorship_bootstrap_operations_v1 values($1,'customer.create')",[id(9)]);
});
test.each(["unknown checkout","receipt","activation","stop","released","foreign buyer","foreign context"])
("installment %s cannot change protocol",async issue=>{
  await installment();
  if(issue==="unknown checkout")await db.query("insert into buyer_mentorship_bootstrap_operations_v1 values($1,'checkout.create')",[id(9)]);
  if(issue==="receipt")await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[id(9)]);
  if(issue==="activation")await db.query("insert into buyer_mentorship_activation_operations_v1 values($1)",[id(9)]);
  if(issue==="stop")await db.query("insert into buyer_mentorship_abandonment_holds_v1 values($1)",[id(9)]);
  if(issue==="released")await db.exec("update buyer_mentorship_installment_reservations_v1 set released_at=now()");
  await expect(pin(issue==="foreign buyer"?id(3):id(2),issue==="foreign context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
test.each(["checkout","legacy stop"])("pinned installment rejects %s even after an application rollback",async issue=>{
  await installment();await pin();await db.exec("set local role service_role");
  await expect(issue==="checkout"?db.query("insert into buyer_mentorship_bootstrap_operations_v1 values($1,'checkout.create')",[id(9)]):
    db.query("insert into buyer_mentorship_abandonment_holds_v1 values($1)",[id(9)])).rejects.toThrow("own confirmation or terminal release");
});
test("legacy installment is unaffected when no new protocol was selected",async()=>{
  await installment();await db.exec("set local role service_role");
  await db.query("insert into buyer_mentorship_bootstrap_operations_v1 values($1,'checkout.create')",[id(9)]);
  await db.query("insert into buyer_mentorship_abandonment_holds_v1 values($1)",[id(9)]);
});
test("protocols are immutable to service role and inaccessible to public roles",async()=>{
  const result=(await db.query(`select has_table_privilege('service_role','server_payment_protocols_v1','INSERT') ins,
    has_table_privilege('service_role','server_payment_protocols_v1','UPDATE') upd,
    has_table_privilege('service_role','server_payment_protocols_v1','DELETE') del,
    has_table_privilege('authenticated','server_payment_protocols_v1','SELECT') authenticated,
    has_function_privilege('anon','reserve_full_server_payment_v1(jsonb,uuid,jsonb)','EXECUTE') anon`)).rows;
  expect(result).toEqual([{ins:false,upd:false,del:false,authenticated:false,anon:false}]);
});
