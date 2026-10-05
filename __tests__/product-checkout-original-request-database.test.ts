/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_fixture",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.invalid"};
const metadata={buyer_id:id(2),creator_id:id(3),product_id:id(4),order_id:id(5),checkout_attempt_key:"10000000-0000-4000-8000-000000000006",checkout_terms_fingerprint:"original-terms"};
const request={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions",params:{mode:"payment",payment_method_types:["card"],metadata,payment_intent_data:{metadata},line_items:[{price_data:{unit_amount:10000,currency:"usd"},quantity:1}]}};
async function claim(req:unknown=request,buyer=id(2),ctx=context){
 return (await db.query<{r:any}>("select claim_product_checkout_original_request_v1($1,$2,$3,$4,$5) r",[id(1),buyer,"10000000-0000-4000-8000-000000000006",ctx,req])).rows[0].r;
}
beforeAll(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table product_checkout_attempts(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,
 purchase_identity text,attempt_key uuid,order_id uuid,terms_fingerprint text,checkout_kind text,purchase_consent_id uuid,
 stripe_checkout_session_id text,status text);
 alter table product_checkout_attempts enable row level security;
 grant select,insert,update,delete on product_checkout_attempts to service_role;`);
 await db.exec(`create table orders(id uuid primary key,buyer_id uuid,status text,stripe_checkout_session_id text,stripe_payment_intent_id text,creator_id uuid,post_id uuid,amount_cents bigint,currency text);
 create table purchases(id uuid primary key,buyer_id uuid,session_id text,status text,payment_intent_id text,access_granted boolean,earnings_credited_at timestamptz,is_refund boolean,is_suspect boolean,creator_id uuid,product_id uuid,post_id uuid,order_id uuid,amount_cents bigint,currency text,subscription_id text,fixed_service_consent_id uuid);
 grant select,insert,update,delete on orders,purchases to service_role;
 create table payment_fee_ledger(id uuid primary key,order_id uuid,purchase_id uuid);
 create table refund_operations(id uuid primary key,order_id uuid,purchase_id uuid);
 create table product_purchase_consents_v1(id uuid primary key,terms jsonb);
 create table fixed_purchase_service_contracts_v1(purchase_id uuid primary key);
 grant select,insert on payment_fee_ledger,refund_operations,product_purchase_consents_v1 to service_role;`);
 await db.exec(readFileSync("supabase/migrations/20260921103742_product_checkout_original_request.sql","utf8"));
 await db.exec(readFileSync("supabase/migrations/20260921144337_product_checkout_stop_intent.sql","utf8"));
 await db.exec(readFileSync("supabase/migrations/20260921144757_product_checkout_stop_operations.sql","utf8"));
 await db.exec(readFileSync("supabase/migrations/20260921145555_product_checkout_stop_proof.sql","utf8"));
 // Actual legacy function bodies, not substitute accounting implementations.
 const source=readFileSync("supabase/proposals/097-fixed-service-one-time.sql","utf8");
 for(const name of ["attach_fixed_service_consent_v1", "bind_fixed_service_one_time_v1"]){
  const start=source.indexOf("create function public."+name);
  const replaceStart=source.indexOf("create or replace function public."+name);
  const from=start>=0?start:replaceStart;
  if(from<0)throw Error("Missing original function");
  await db.exec(source.slice(from,source.indexOf("end $$;",from)+7));
 }
 await db.exec(readFileSync("supabase/migrations/20260921145930_product_checkout_verified_release.sql","utf8"));
});
beforeEach(async()=>{
 await db.exec("begin;set local role service_role");
 await db.query(`insert into product_checkout_attempts(id,buyer_id,creator_id,product_id,order_id,attempt_key,terms_fingerprint,
 checkout_kind,status,original_request_protocol) values($1,$2,$3,$4,$5,'10000000-0000-4000-8000-000000000006','original-terms','full','creating','product-checkout-original-v1')`,[id(1),id(2),id(3),id(4),id(5)]);
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
test("saves original request before dispatch and serializes recovery",async()=>{
 const first=await claim();expect(first.status).toBe("dispatch");expect(first.attempt.original_request).toEqual(request);
 expect(first.idempotency_key).toBe("creatornet-product-checkout:10000000-0000-4000-8000-000000000006");
 expect(Date.parse(first.dispatch_before)-Date.parse(first.attempt.original_request_started_at)).toBe(30000);
 expect((await claim()).status).toBe("busy");
 await db.exec("update product_checkout_attempts set original_request_lease_until=now()-interval '1 second'");
 const replay=await claim(null);expect(replay.status).toBe("dispatch");expect(replay.attempt.original_request).toEqual(request);
 expect(replay.attempt.original_request_started_at).toBe(first.attempt.original_request_started_at);
 expect(replay.idempotency_key).toBe(first.idempotency_key);expect(replay.attempt.original_request_lease_token).not.toBe(first.attempt.original_request_lease_token);
});
test("wrong buyer cannot claim or inspect original operation",async()=>{await expect(claim(request,id(9))).rejects.toThrow("Owned original checkout unavailable");});
test("a changed candidate cannot replace the original request",async()=>{
 await claim();await expect(claim({...request,params:{...request.params,cancel_url:"https://changed.invalid"}})).rejects.toThrow("Original checkout request changed");
});
test("recovery cannot adopt a different provider context",async()=>{
 await claim();await expect(claim(null,id(2),{...context,platformAccountId:"acct_other"})).rejects.toThrow("Original checkout request changed");
});
test.each(["attempt_key='10000000-0000-4000-8000-000000000009'","terms_fingerprint='new-terms'","order_id='10000000-0000-4000-8000-000000000009'"])("rotation cannot rewrite %s",async change=>{
 await claim();await expect(db.exec(`update product_checkout_attempts set ${change}`)).rejects.toThrow("Original checkout identity is immutable");
});
test("saved request cannot be edited",async()=>{await claim();await expect(db.exec("update product_checkout_attempts set original_request='{}'")).rejects.toThrow("Original checkout request is immutable");});
test("binding permits original retrieval but never another create admission",async()=>{
 await claim();await db.exec("update product_checkout_attempts set stripe_checkout_session_id='cs_test_original',status='open'");
 expect((await claim(null)).status).toBe("bound");
 await expect(db.exec("update product_checkout_attempts set stripe_checkout_session_id='cs_test_other'")).rejects.toThrow("Original checkout session is immutable");
});
test("legacy uncertain rows cannot be upgraded",async()=>{
 await db.query("insert into product_checkout_attempts(id,checkout_kind,status) values($1,'full','creating')",[id(9)]);
 await expect(db.exec("update product_checkout_attempts set original_request_protocol='product-checkout-original-v1' where original_request_protocol is null")).rejects.toThrow("Legacy checkout cannot adopt");
});
test("expiry of the provider key window requires reconciliation without a fresh key",async()=>{
 await claim();
 // Test-only administrative clock setup; production guard makes the timestamp immutable.
 await db.exec("reset role;alter table product_checkout_attempts disable trigger guard_product_checkout_original_request_v1;update product_checkout_attempts set original_request_started_at=now()-interval '24 hours',original_request_lease_until=now()-interval '1 second';alter table product_checkout_attempts enable trigger guard_product_checkout_original_request_v1;set local role service_role");
 expect((await claim(null)).status).toBe("reconciliation_required");
});
test("original row cannot be deleted without a later release protocol",async()=>{await claim();await expect(db.exec("delete from product_checkout_attempts")).rejects.toThrow("durable release proof");});
test("public roles cannot invoke admission",async()=>{
 const rows=(await db.query<{allowed:boolean}>("select has_function_privilege('authenticated','claim_product_checkout_original_request_v1(uuid,uuid,uuid,jsonb,jsonb)','execute') allowed")).rows;
 expect(rows).toEqual([{allowed:false}]);
});
test("mismatched original metadata is rejected before admission",async()=>{
 await expect(claim({...request,params:{...request.params,metadata:{...metadata,buyer_id:id(9)}}})).rejects.toThrow("identity mismatch");
});

async function requestStop(buyer=id(2),ctx=context){
 return (await db.query<{r:any}>("select request_product_checkout_stop_v1($1,$2,$3,$4) r",[id(1),buyer,id(6),ctx])).rows[0].r;
}
async function bound(){
 await claim();await db.exec("update product_checkout_attempts set stripe_checkout_session_id='cs_test_original',status='open',original_request_lease_until=now()-interval '1 second'");
}
test("stop intent replays original timestamp without release or changing original request",async()=>{
 await bound();const first=await requestStop();expect(first.release_allowed).toBe(false);expect(await requestStop()).toEqual(first);
 const row=(await db.query<{original_request:unknown;stripe_checkout_session_id:string}>("select original_request,stripe_checkout_session_id from product_checkout_attempts")).rows[0];
 expect(row.original_request).toEqual(request);expect(row.stripe_checkout_session_id).toBe("cs_test_original");
});
test.each(["new lease","clear hold","change hold","delete"])("durable stop rejects %s",async action=>{
 await bound();await requestStop();
 const sql=action==="new lease"?"update product_checkout_attempts set original_request_lease_token=gen_random_uuid()":
  action==="clear hold"?"update product_checkout_attempts set original_stop_requested_at=null":
  action==="change hold"?"update product_checkout_attempts set original_stop_requested_at=now()-interval '1 hour'":"delete from product_checkout_attempts";
 await expect(db.exec(sql)).rejects.toThrow();
});
test.each(["unbound","active dispatch","foreign owner","wrong context"])("stop refuses %s instead of declaring unpaid",async issue=>{
 if(issue==="unbound")await claim();else await bound();
 if(issue==="active dispatch")await db.exec("update product_checkout_attempts set original_request_lease_until=now()+interval '1 minute'");
 await expect(requestStop(issue==="foreign owner"?id(9):id(2),issue==="wrong context"?{...context,platformAccountId:"acct_other"}:context)).rejects.toThrow();
});
test("browser roles cannot persist a stop intent",async()=>{
 expect((await db.query("select has_function_privilege('authenticated','request_product_checkout_stop_v1(uuid,uuid,uuid,jsonb)','execute') allowed")).rows).toEqual([{allowed:false}]);
});
async function claimStop(){return (await db.query<{r:any}>("select claim_product_checkout_stop_operation_v1($1,$2,$3,$4) r",[id(1),id(2),id(6),context])).rows[0].r;}
test("expiry admission preserves original parameters/key and serializes replay",async()=>{
 await bound();await requestStop();const first=await claimStop();expect(first.status).toBe("dispatch");
 expect(first.operation.request).toEqual({apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions/cs_test_original/expire",params:{}});
 expect(first.operation.idempotency_key).toBe(`creatornet-product-checkout:${id(6)}:expire`);expect((await claimStop()).status).toBe("busy");
 await db.exec("update product_checkout_stop_operations_v1 set lease_until=now()-interval '1 second'");
 const replay=await claimStop();expect(replay.operation.request).toEqual(first.operation.request);expect(replay.operation.started_at).toBe(first.operation.started_at);
 expect(replay.operation.idempotency_key).toBe(first.operation.idempotency_key);expect(replay.operation.lease_token).not.toBe(first.operation.lease_token);
});
test("expiry admission requires original stop intent",async()=>{await bound();await expect(claimStop()).rejects.toThrow("Owned original stop unavailable");});
test.each(["request='{}'","idempotency_key='replacement'","started_at=now()-interval '1 day'"])("stop operation cannot rewrite %s",async change=>{
 await bound();await requestStop();await claimStop();await expect(db.exec(`update product_checkout_stop_operations_v1 set ${change}`)).rejects.toThrow("immutable");
});
test("old expiry key cannot be redispatched after its safe retention window",async()=>{
 await bound();await requestStop();await claimStop();
 await db.exec("reset role;alter table product_checkout_stop_operations_v1 disable trigger guard_product_checkout_stop_operation_v1;update product_checkout_stop_operations_v1 set started_at=now()-interval '24 hours',lease_until=now()-interval '1 second';alter table product_checkout_stop_operations_v1 enable trigger guard_product_checkout_stop_operation_v1;set local role service_role");
 expect((await claimStop()).status).toBe("reconciliation_required");
});
function proof(){return {version:"product-unpaid-stop-v1",sessionId:"cs_test_original",checkoutStatus:"expired",paymentStatus:"unpaid",amountCents:10000,currency:"usd",paymentIntent:null as any,observedAt:Math.floor(Date.now()/1000)};}
async function recordProof(value:unknown=proof()){return (await db.query<{r:any}>("select record_product_checkout_stop_proof_v1($1,$2,$3,$4,$5) r",[id(1),id(2),id(6),context,value])).rows[0].r;}
test.each(["none","canceled"])("terminal %s payment intent proof persists unchanged without release",async mode=>{
 await bound();await requestStop();const p=proof();if(mode==="canceled")p.paymentIntent={id:"pi_original",status:"canceled",amountReceived:0,amountCapturable:0};
 const first=await recordProof(p);expect(first.proof).toEqual(p);expect(await recordProof({...p,observedAt:p.observedAt+1})).toEqual(first);
 expect((await db.query("select count(*)::int n from product_checkout_attempts")).rows).toEqual([{n:1}]);
});
test.each(["paid","open","wrong session","wrong amount","stale","missing intent","processing","received money","capturable","extra field"])("proof rejects %s",async problem=>{
 await bound();await requestStop();const p:any=proof();
 if(problem==="paid")p.paymentStatus="paid";if(problem==="open")p.checkoutStatus="open";
 if(problem==="wrong session")p.sessionId="cs_other";if(problem==="wrong amount")p.amountCents++;
 if(problem==="stale")p.observedAt-=60;if(problem==="missing intent")delete p.paymentIntent;
 if(["processing","received money","capturable"].includes(problem))p.paymentIntent={id:"pi_original",status:problem==="processing"?"processing":"canceled",amountReceived:problem==="received money"?1:0,amountCapturable:problem==="capturable"?1:0};
 if(problem==="extra field")p.releaseAllowed=true;await expect(recordProof(p)).rejects.toThrow();
});
test.each(["order paid","buyer mismatch","intent mismatch","purchase credited","purchase paid","purchase access"])("contradicting %s prevents terminal proof",async problem=>{
 await bound();await requestStop();
 await db.query("insert into orders(id,buyer_id,status,stripe_checkout_session_id,stripe_payment_intent_id) values($1,$2,$3,'cs_test_original',$4)",[id(5),problem==="buyer mismatch"?id(9):id(2),problem==="order paid"?"paid":"created",problem==="intent mismatch"?"pi_other":null]);
 if(problem.startsWith("purchase"))await db.query("insert into purchases(id,buyer_id,session_id,status,access_granted,earnings_credited_at) values($1,$2,'cs_test_original',$3,$4,$5)",
  [id(7),id(2),problem==="purchase paid"?"paid":"pending",problem==="purchase access",problem==="purchase credited"?new Date().toISOString():null]);
 await expect(recordProof()).rejects.toThrow("financial state");
});
test("original terminal evidence cannot change intent after a lost response",async()=>{
 await bound();await requestStop();await recordProof();
 await expect(recordProof({...proof(),paymentIntent:{id:"pi_original",status:"canceled",amountReceived:0,amountCapturable:0}})).rejects.toThrow("Original terminal checkout proof changed");
});
test("browser roles cannot record proof or rewrite saved terminal evidence",async()=>{
 expect((await db.query("select has_function_privilege('authenticated','record_product_checkout_stop_proof_v1(uuid,uuid,uuid,jsonb,jsonb)','execute') allowed,has_table_privilege('service_role','product_checkout_stop_proofs_v1','update') mutable")).rows).toEqual([{allowed:false,mutable:false}]);
});
async function readyRelease(pending=true){
 await bound();await requestStop();
 await db.query("insert into orders(id,buyer_id,creator_id,status,stripe_checkout_session_id,amount_cents,currency) values($1,$2,$3,'created','cs_test_original',10000,'usd')",[id(5),id(2),id(3)]);
 if(pending)await db.query("insert into purchases(id,buyer_id,creator_id,product_id,order_id,session_id,status,amount_cents,currency,access_granted) values($1,$2,$3,$4,$5,'cs_test_original','pending',10000,'usd',false)",[id(7),id(2),id(3),id(4),id(5)]);
}
async function release(value:unknown=proof(),ctx=context){return (await db.query<{r:any}>("select release_product_checkout_stop_v1($1,$2,$3,$4,$5) r",[id(1),id(2),id(6),ctx,value])).rows[0].r;}
test.each([true,false])("verified release archives the exact original and preserves operation/proof history; pending=%s",async pending=>{
 await readyRelease(pending);await claimStop();
 const original=(await db.query<{a:unknown}>("select to_jsonb(a) a from product_checkout_attempts a")).rows[0].a;
 const released=await release();expect(released).toMatchObject({attempt_id:id(1),product_id:id(4)});expect(released.released_at).toBeTruthy();
 expect((await db.query("select * from product_checkout_attempts")).rows).toHaveLength(0);
 expect((await db.query("select * from purchases")).rows).toHaveLength(0);
 const archive=(await db.query<any>("select * from product_checkout_releases_v1")).rows[0];expect(archive.original_attempt).toEqual(original);
 expect(archive.original_purchases).toHaveLength(pending?1:0);expect(archive.original_order.status).toBe("created");
 expect((await db.query("select status from orders")).rows).toEqual([{status:"canceled"}]);
 expect((await db.query("select * from product_checkout_stop_operations_v1")).rows).toHaveLength(1);
 expect((await db.query("select * from product_checkout_stop_proofs_v1")).rows).toHaveLength(1);
 expect((await db.query<{a:unknown}>("select to_jsonb(a) a from product_checkout_records_v1 a")).rows[0].a).toEqual(original);
 expect(await release(null)).toEqual(released);
});
test.each(["paid","earnings","access","other session","other order","missing order","ledger","refund","stale proof"])("release rejects %s atomically",async problem=>{
 await readyRelease();
 if(problem==="paid")await db.exec("update purchases set status='paid'");
 if(problem==="earnings")await db.exec("update purchases set earnings_credited_at=now()");
 if(problem==="access")await db.exec("update purchases set access_granted=true");
 if(problem==="other session")await db.exec("update purchases set session_id='cs_other'");
 if(problem==="other order")await db.query("update purchases set order_id=$1",[id(9)]);
 if(problem==="missing order")await db.exec("delete from orders");
 if(problem==="ledger")await db.query("insert into payment_fee_ledger values($1,$2,$3)",[id(9),id(5),id(7)]);
 if(problem==="refund")await db.query("insert into refund_operations values($1,$2,$3)",[id(9),id(5),id(7)]);
 await db.exec("savepoint before_release");await expect(release(problem==="stale proof"?{...proof(),observedAt:1}:proof())).rejects.toThrow();
 await db.exec("rollback to before_release");
 expect((await db.query("select * from product_checkout_releases_v1")).rows).toHaveLength(0);
 expect((await db.query("select * from product_checkout_attempts")).rows).toHaveLength(1);
 expect((await db.query("select * from purchases")).rows).toHaveLength(1);
});
test("delayed pending attachment cannot recreate the released original purchase",async()=>{
 await readyRelease();await release();
 await expect(db.query("insert into purchases(id,buyer_id,product_id,session_id,status) values($1,$2,$3,'cs_test_original','pending')",[id(9),id(2),id(4)])).rejects.toThrow("Released checkout cannot recreate");
});
test("late paid purchase consent still binds to archived original rather than current offer",async()=>{
 // Test-only setup of original immutable consent, before the operation is saved.
 await db.exec("reset role;alter table product_checkout_attempts disable trigger guard_product_checkout_original_request_v1");
 await db.query("update product_checkout_attempts set purchase_consent_id=$1",[id(8)]);
 await db.exec("alter table product_checkout_attempts enable trigger guard_product_checkout_original_request_v1;set local role service_role");
 await db.query("insert into product_purchase_consents_v1 values($1,$2)",[id(8),{serviceVersion:"fixed-service-months-v1"}]);
 await readyRelease();await release();
 await db.exec("reset role;create trigger attach_fixed_service_consent_v1 before insert or update on purchases for each row execute function attach_fixed_service_consent_v1();set local role service_role");
 await db.query("insert into purchases(id,buyer_id,creator_id,product_id,order_id,session_id,status) values($1,$2,$3,$4,$5,'cs_test_original','paid')",[id(9),id(2),id(3),id(4),id(5)]);
 expect((await db.query("select fixed_service_consent_id from purchases")).rows).toEqual([{fixed_service_consent_id:id(8)}]);
 const definitions=await db.query<{definition:string}>("select pg_get_functiondef('bind_fixed_service_one_time_v1(uuid,uuid,uuid,text,text,bigint,bigint,text)'::regprocedure) definition");
 expect(definitions.rows[0].definition).toContain("from public.product_checkout_records_v1 attempt");
});
test("release is service-only and history is not mutable",async()=>{
 expect((await db.query("select has_function_privilege('authenticated','release_product_checkout_stop_v1(uuid,uuid,uuid,jsonb,jsonb)','execute') allowed,has_table_privilege('service_role','product_checkout_releases_v1','update') mutable,has_table_privilege('authenticated','product_checkout_records_v1','select') visible")).rows).toEqual([{allowed:false,mutable:false,visible:false}]);
});
