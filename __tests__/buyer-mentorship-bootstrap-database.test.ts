/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_test",
  supabaseProjectRef: "abcdefghijklmnopqrst", siteOrigin: "https://fixture.vercel.app" };
let metadata: Record<string, string>;
type Claim = { status: string; dispatch_before: string; operation: { reservation_id: string; step: string; request: any;
  first_dispatch_at: string; lease_token: string; idempotency_key: string; result_id: string | null } };
const scope = () => [id(2), id(3), context];
const request = (step = "product.create", params?: object, path = "/v1/products") => ({ apiVersion: "2025-10-29.clover", method: "POST", path,
  params: params ?? { name: "Accepted mentorship installments", metadata: { ...metadata, operation_kind: step } } });
async function begin(buyer = id(3), ctx = context) {
  return (await db.query<{ result: any }>("select begin_buyer_mentorship_bootstrap_v1($1,$2,$3) result", [id(2), buyer, ctx])).rows[0].result;
}
async function claim(step = "product.create", req = request()): Promise<Claim> {
  return (await db.query<{ result: Claim }>("select claim_buyer_mentorship_bootstrap_v1($1,$2,$3,$4,$5) result", [...scope(), step, req])).rows[0].result;
}
async function bind(c: Claim, changed: Record<string, unknown> = {}, token = c.operation.lease_token) {
  const step = c.operation.step;
  const object = { id: step === "product.create" ? "prod_fixture" : step === "checkout.create" ? "cs_test_fixture" : "sub_fixture",
    object: step === "product.create" ? "product" : step === "checkout.create" ? "checkout.session" : "subscription", livemode: false,
    metadata: { ...metadata, operation_kind: step === "subscription.hold" ? "subscription.create" : step },
    ...(step === "subscription.hold" ? { pause_collection: { behavior: "keep_as_draft" } } : {}), ...changed };
  return (await db.query<{ result: any }>("select bind_buyer_mentorship_bootstrap_v1($1,$2,$3,$4,$5,$6,$7) result",
    [...scope(), step, token, object, "req_fixture"])).rows[0].result;
}
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table buyer_mentorship_installment_reservations_v1(id uuid primary key,request_id uuid unique,buyer_id uuid,
      creator_id uuid,product_id uuid,post_id uuid,context jsonb,fingerprint text,status text);
    alter table buyer_mentorship_installment_reservations_v1 enable row level security;
    grant select on buyer_mentorship_installment_reservations_v1 to service_role;`);
  await db.exec(readFileSync("supabase/migrations/20260921021558_buyer_mentorship_customer_operations.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260921030153_buyer_mentorship_bootstrap_operations.sql", "utf8"));
  await db.exec(`create table buyer_mentorship_first_receipts_v1(reservation_id uuid primary key);
    create table buyer_mentorship_activation_operations_v1(reservation_id uuid primary key);
    grant select,insert on buyer_mentorship_first_receipts_v1,buyer_mentorship_activation_operations_v1 to service_role;`);
  await db.exec(readFileSync("supabase/migrations/20260921094241_buyer_mentorship_abandonment_hold.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260921094705_buyer_mentorship_abandonment_operations.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260921095550_buyer_mentorship_abandonment_proof.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260921152804_buyer_mentorship_existing_preparation_recovery.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260921154143_buyer_mentorship_nonpayable_release.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260921171012_buyer_mentorship_partial_subscription_stop.sql", "utf8"));
});
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into buyer_mentorship_installment_reservations_v1 values($1,$2,$3,$4,$5,$6,$7,$8,'reserved')",
    [id(1), id(2), id(3), id(4), id(5), id(6), context, "a".repeat(64)]);
  await db.exec("set local role service_role");
  const c = (await db.query<{ result: Claim }>("select claim_buyer_mentorship_customer_v1($1,$2,$3) result", scope())).rows[0].result;
  metadata = c.operation.request.metadata;
  await db.query("select bind_buyer_mentorship_customer_v1($1,$2,$3,$4,$5,$6)", [...scope(), c.operation.lease_token,
    { id: "cus_fixture", object: "customer", livemode: false, metadata, created: Math.floor(Date.parse(c.operation.first_dispatch_at) / 1000) }, "req_customer"]);
});
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db.close(); });

async function partialSubscription() {
  const b=await begin();await bind(await claim());
  await bind(await claim("subscription.create",request("subscription.create",{
    metadata:{...metadata,operation_kind:"subscription.create"},customer:b.customer_id,
    items:[{price_data:{product:"prod_fixture"}}]},"/v1/subscriptions")));
}
async function partialContext() {
  return (await db.query<{result:any}>("select read_buyer_mentorship_partial_stop_v1($1,$2,$3) result",scope())).rows[0].result;
}
test.each(["absent","bound","uncertain"])("partial subscription with %s pause can retain stop intent and cancel only the original",async kind=>{
  await partialSubscription();
  if(kind!=="absent"){
    const c=await claim("subscription.hold",request("subscription.hold",{pause_collection:{behavior:"keep_as_draft"}},"/v1/subscriptions/sub_fixture"));
    if(kind==="bound")await bind(c);
    else await db.exec("update buyer_mentorship_bootstrap_operations_v1 set lease_until=clock_timestamp()-interval '1 second' where step='subscription.hold'");
  }
  const preparation=await partialContext();expect(preparation.subscription.result_id).toBe("sub_fixture");
  await stopRequest();
  expect((await stopOperation("subscription.cancel")).operation.request).toEqual({apiVersion:"2025-10-29.clover",method:"DELETE",
    path:"/v1/subscriptions/sub_fixture",params:{invoice_now:false,prorate:false}});
  const proof={version:"buyer-partial-subscription-stop-v1",preparation,subscriptionId:"sub_fixture",sessionId:null,
    checkoutStatus:"not_created",firstPaymentIntentId:null,canceledAt:Math.floor(Date.now()/1000)-1,observedAt:Math.floor(Date.now()/1000)};
  const saved=await recordStopProof(proof as never);expect(saved.proof).toEqual(proof);
  expect(await recordStopProof({...proof,observedAt:proof.observedAt+1} as never)).toEqual(saved);
});
test.each(["unbound subscription","active pause","uncertain checkout","bound checkout","receipt","activation"])
("partial stop excludes %s",async issue=>{
  if(issue==="unbound subscription"){
    const b=await begin();await bind(await claim());await claim("subscription.create",request("subscription.create",{
      metadata:{...metadata,operation_kind:"subscription.create"},customer:b.customer_id,items:[{price_data:{product:"prod_fixture"}}]},"/v1/subscriptions"));
  }else if(issue==="bound checkout")await bindFullChain();
  else{
    await partialSubscription();
    if(issue==="active pause"||issue==="uncertain checkout"){
      const c=await claim("subscription.hold",request("subscription.hold",{pause_collection:{behavior:"keep_as_draft"}},"/v1/subscriptions/sub_fixture"));
      if(issue==="uncertain checkout"){
        await bind(c);const b=await begin();await claim("checkout.create",request("checkout.create",{
          metadata:{...metadata,operation_kind:"checkout.create",installment_subscription_id:"sub_fixture"},customer:b.customer_id,
          expires_at:b.anchor_seconds+86400},"/v1/checkout/sessions"));
      }
    }
    if(issue==="receipt"||issue==="activation")await db.query(`insert into ${issue==="receipt"?"buyer_mentorship_first_receipts_v1":"buyer_mentorship_activation_operations_v1"} values($1)`,[id(1)]);
  }
  expect(await partialContext()).toBeNull();
});
test("partial hold prevents new Checkout admission and late pause binding",async()=>{
  await partialSubscription();
  const c=await claim("subscription.hold",request("subscription.hold",{pause_collection:{behavior:"keep_as_draft"}},"/v1/subscriptions/sub_fixture"));
  await db.exec("update buyer_mentorship_bootstrap_operations_v1 set lease_until=clock_timestamp()-interval '1 second' where step='subscription.hold'");
  await stopRequest();
  await expect(bind(c)).rejects.toThrow("stop requires reconciliation");
});
test.each(["snapshot","subscription","session","stale","no hold","receipt"])("partial terminal proof rejects %s",async issue=>{
  await partialSubscription();const preparation=await partialContext();if(issue!=="no hold")await stopRequest();
  const proof={version:"buyer-partial-subscription-stop-v1",preparation,subscriptionId:"sub_fixture",sessionId:null as string|null,
    checkoutStatus:"not_created",firstPaymentIntentId:null,canceledAt:Math.floor(Date.now()/1000)-100,observedAt:Math.floor(Date.now()/1000)};
  if(issue==="snapshot")proof.preparation.product.result_id="prod_other";
  if(issue==="subscription")proof.subscriptionId="sub_other";
  if(issue==="session")proof.sessionId="cs_test_unknown";
  if(issue==="stale")proof.observedAt-=60;
  if(issue==="receipt")await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[id(1)]);
  await expect(recordStopProof(proof as never)).rejects.toThrow();
});

test("bootstrap retains the original anchor and dedicated customer with no parent UPDATE privilege", async () => {
  const b = await begin(); expect(b.customer_id).toBe("cus_fixture"); expect(b.reservation_id).toBe(id(1));
  expect(Number.isSafeInteger(b.anchor_seconds)).toBe(true); expect(await begin()).toEqual(b);
  expect((await db.query("select has_table_privilege('service_role','buyer_mentorship_installment_reservations_v1','UPDATE') writable")).rows)
    .toEqual([{ writable: false }]);
});
test("claims commit original request and key, serialize active leases and replay expired leases", async () => {
  const first = await claim(); expect(first.status).toBe("dispatch"); expect(first.operation.request).toEqual(request());
  expect((await claim()).status).toBe("busy");
  await db.exec("update buyer_mentorship_bootstrap_operations_v1 set lease_until=now()-interval '1 second'");
  const retry = await claim(); expect(retry.status).toBe("dispatch");
  expect(retry.operation.idempotency_key).toBe(first.operation.idempotency_key);
  expect(retry.operation.first_dispatch_at).toBe(first.operation.first_dispatch_at);
  expect(retry.operation.lease_token).not.toBe(first.operation.lease_token);
});
test("binding is idempotent and further claims retrieve the bound result", async () => {
  const c = await claim(), bound = await bind(c); expect(bound.result_id).toBe("prod_fixture");
  expect(await bind(c)).toEqual(bound); expect((await claim()).status).toBe("bound");
});
test("changed request cannot reuse an operation", async () => {
  await claim(); const req = request(); req.params = { ...req.params, name: "Changed title" };
  await expect(claim("product.create", req)).rejects.toThrow("Original bootstrap request changed");
});
test.each(["subscription.create", "subscription.hold", "checkout.create"])("cannot skip dependencies for %s", async step => {
  await expect(claim(step, request(step))).rejects.toThrow("dependencies");
});
test.each(["buyer", "context"])("foreign %s cannot begin bootstrap", async field => {
  await expect(begin(field === "buyer" ? id(9) : id(3), field === "context" ? { ...context, platformAccountId: "acct_other" } : context))
    .rejects.toThrow("Owned bootstrap reservation unavailable");
});
test.each([{ livemode: true }, { metadata: {} }, { object: "charge" }, { id: "prod_wrong-id" }])("invalid provider result %p cannot bind", async changed => {
  await expect(bind(await claim(), changed)).rejects.toThrow("original provider proof");
});
test("a stale lease cannot bind after another claim", async () => {
  const first = await claim(); await db.exec("update buyer_mentorship_bootstrap_operations_v1 set lease_until=now()-interval '1 second'");
  await claim(); await expect(bind(first)).rejects.toThrow("original provider proof");
});
test.each(["request='{}'", "idempotency_key='changed'", "first_dispatch_at=now()-interval '2 days'"])("durable fields are immutable: %s", async update => {
  await claim(); await expect(db.exec(`update buyer_mentorship_bootstrap_operations_v1 set ${update}`)).rejects.toThrow("immutable");
});
test("aged uncertain operations require review, never a new key", async () => {
  await begin(); await db.query("insert into buyer_mentorship_bootstrap_operations_v1(reservation_id,step,request,first_dispatch_at) values($1,'product.create',$2,now()-interval '23 hours')", [id(1), request()]);
  expect((await claim()).status).toBe("review_required");
});
async function bindFullChain() {
  const b = await begin(); await bind(await claim());
  const sub = request("subscription.create", { metadata: { ...metadata, operation_kind: "subscription.create" },
    customer: b.customer_id, items: [{ price_data: { product: "prod_fixture" } }] }, "/v1/subscriptions");
  await bind(await claim("subscription.create", sub));
  const hold = request("subscription.hold", { pause_collection: { behavior: "keep_as_draft" } }, "/v1/subscriptions/sub_fixture");
  await bind(await claim("subscription.hold", hold));
  const checkoutMetadata = { ...metadata, operation_kind: "checkout.create", installment_subscription_id: "sub_fixture" };
  const checkout = request("checkout.create", { metadata: checkoutMetadata, customer: b.customer_id, expires_at: b.anchor_seconds + 86400 }, "/v1/checkout/sessions");
  const claimed = await claim("checkout.create", checkout); expect(claimed.status).toBe("dispatch");
  expect((await bind(claimed, { metadata: checkoutMetadata })).result_id).toBe("cs_test_fixture");
}
test("full dependency chain preserves original IDs and Checkout expiry", bindFullChain);
test("public roles cannot access operations and RPCs never bypass RLS", async () => {
  const rows = (await db.query(`select prosecdef,has_function_privilege('anon',oid,'execute') anon,
    has_function_privilege('authenticated',oid,'execute') authenticated from pg_proc
    where proname in ('begin_buyer_mentorship_bootstrap_v1','claim_buyer_mentorship_bootstrap_v1','bind_buyer_mentorship_bootstrap_v1')`)).rows;
  expect(rows).toHaveLength(3); expect(rows).toEqual(Array(3).fill({ prosecdef: false, anon: false, authenticated: false }));
});

async function stopRequest(buyer=id(3),ctx=context) {
  return (await db.query<{result:any}>("select request_buyer_mentorship_abandonment_v1($1,$2,$3) result",[id(2),buyer,ctx])).rows[0].result;
}
test("durable abandonment intent preserves evidence and blocks activation after late receipt",async()=>{
  await bindFullChain();const saved=await stopRequest();expect(saved.reservation_id).toBe(id(1));
  expect(await stopRequest()).toEqual(saved);
  // Capture accounting remains possible; stopping does not hide paid money.
  await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[id(1)]);
  expect(await stopRequest()).toEqual(saved);
  await expect(db.query("insert into buyer_mentorship_activation_operations_v1 values($1)",[id(1)]))
    .rejects.toThrow("stop requires reconciliation");
});
test.each(["missing binding","foreign buyer","foreign context","receipt exists","activation exists"])("stop intent rejects %s",async issue=>{
  if(issue!=="missing binding")await bindFullChain();
  else await claim(); // An admitted but unbound create cannot be abandoned.
  if(issue==="receipt exists")await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[id(1)]);
  if(issue==="activation exists")await db.query("insert into buyer_mentorship_activation_operations_v1 values($1)",[id(1)]);
  await expect(stopRequest(issue==="foreign buyer"?id(9):id(3),issue==="foreign context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
test.each(["customer","bootstrap"])("held purchase cannot restart %s preparation",async kind=>{
  await bindFullChain();await stopRequest();
  const run=kind==="customer"?()=>db.query("select claim_buyer_mentorship_customer_v1($1,$2,$3)",scope()):()=>claim();
  await expect(run()).rejects.toThrow("stop requires reconciliation");
});
test("abandonment intent cannot be removed by service role or accessed by public roles",async()=>{
  const rows=(await db.query(`select has_table_privilege('service_role','buyer_mentorship_abandonment_holds_v1','DELETE') removable,
    has_table_privilege('service_role','buyer_mentorship_abandonment_holds_v1','UPDATE') writable,
    has_function_privilege('anon','request_buyer_mentorship_abandonment_v1(uuid,uuid,jsonb)','EXECUTE') anon,
    has_function_privilege('authenticated','request_buyer_mentorship_abandonment_v1(uuid,uuid,jsonb)','EXECUTE') authenticated`)).rows;
  expect(rows).toEqual([{removable:false,writable:false,anon:false,authenticated:false}]);
});

async function stopOperation(step="checkout.expire",buyer=id(3),ctx=context) {
  return (await db.query<{result:any}>("select claim_buyer_mentorship_abandonment_operation_v1($1,$2,$3,$4) result",[id(2),buyer,ctx,step])).rows[0].result;
}
test.each(["checkout.expire","subscription.cancel"])("stop %s retains original request through a lost response",async step=>{
  await bindFullChain();await stopRequest();const first=await stopOperation(step);
  expect(first.status).toBe("dispatch");expect((await stopOperation(step)).status).toBe("busy");
  expect(first.operation.request).toEqual({apiVersion:"2025-10-29.clover",method:step==="checkout.expire"?"POST":"DELETE",
    path:step==="checkout.expire"?"/v1/checkout/sessions/cs_test_fixture/expire":"/v1/subscriptions/sub_fixture",
    params:step==="checkout.expire"?{}:{invoice_now:false,prorate:false}});
  expect(first.operation.idempotency_key).toBe(step==="checkout.expire"?`buyer-mentorship-installments-v1:${id(1)}:expire-approved-stop-v1`:null);
  await db.exec("update buyer_mentorship_abandonment_operations_v1 set lease_until=now()-interval '1 second'");
  const retry=await stopOperation(step);expect(retry.status).toBe("dispatch");
  expect(retry.operation.request).toEqual(first.operation.request);expect(retry.operation.idempotency_key).toBe(first.operation.idempotency_key);
  expect(retry.operation.first_dispatch_at).toBe(first.operation.first_dispatch_at);expect(retry.operation.lease_token).not.toBe(first.operation.lease_token);
});
test("late captured receipt stops further unpaid provider admission",async()=>{
  await bindFullChain();await stopRequest();await stopOperation();
  await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[id(1)]);
  expect(await stopOperation("subscription.cancel")).toEqual({status:"reconciliation_required"});
});
test.each(["missing hold","foreign buyer","foreign context","invalid step"])("stop admission refuses %s",async issue=>{
  await bindFullChain();if(issue!=="missing hold")await stopRequest();
  await expect(stopOperation(issue==="invalid step"?"invoice.pay":"checkout.expire",issue==="foreign buyer"?id(9):id(3),
    issue==="foreign context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
test.each(["request='{}'","idempotency_key='new-key'","first_dispatch_at=now()-interval '2 days'"])("stop original operation is immutable: %s",async change=>{
  await bindFullChain();await stopRequest();await stopOperation();
  await expect(db.exec(`update buyer_mentorship_abandonment_operations_v1 set ${change}`)).rejects.toThrow("immutable");
});

test("expiry and cancellation cannot receive overlapping dispatch leases",async()=>{
  await bindFullChain();await stopRequest();expect((await stopOperation()).status).toBe("dispatch");
  expect(await stopOperation("subscription.cancel")).toEqual({status:"busy"});
  await db.exec("update buyer_mentorship_abandonment_operations_v1 set lease_until=now()-interval '1 second'");
  expect((await stopOperation("subscription.cancel")).status).toBe("dispatch");
  expect(await stopOperation()).toEqual({status:"busy"});
});

test("aged uncertain expiry retains its original key and refuses replay",async()=>{
  await bindFullChain();await stopRequest();
  const key=`buyer-mentorship-installments-v1:${id(1)}:expire-approved-stop-v1`;
  const original={apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/checkout/sessions/cs_test_fixture/expire",params:{}};
  await db.query(`insert into buyer_mentorship_abandonment_operations_v1 values($1,'checkout.expire',$2,$3,
    now()-interval '24 hours',$4,now()-interval '1 hour')`,[id(1),original,key,id(8)]);
  const result=await stopOperation();expect(result.status).toBe("reconciliation_required");
  expect(result.operation.idempotency_key).toBe(key);expect(result.operation.request).toEqual(original);
  expect(result.operation.lease_token).toBe(id(8));
});

const terminalProof=()=>({version:"buyer-unpaid-stop-v1",subscriptionId:"sub_fixture",sessionId:"cs_test_fixture",canceledAt:Math.floor(Date.now()/1000)-1,
  checkoutStatus:"expired",firstPaymentIntentId:null,observedAt:Math.floor(Date.now()/1000)});
async function recordStopProof(proof=terminalProof(),buyer=id(3)) {
  return (await db.query<{result:any}>("select record_buyer_mentorship_abandonment_proof_v1($1,$2,$3,$4) result",[id(2),buyer,context,proof])).rows[0].result;
}
test("terminal proof is immutable and repeated fresh observation returns original record",async()=>{
  await bindFullChain();await stopRequest();const proof=terminalProof(),saved=await recordStopProof(proof);
  expect(saved.reservation_id).toBe(id(1));expect(saved.proof).toEqual(proof);
  expect(await recordStopProof({...proof,observedAt:proof.observedAt+1})).toEqual(saved);
});
test.each(["no hold","receipt","foreign buyer","wrong session","wrong subscription","paid","stale","future","invalid time","changed proof"])("terminal proof rejects %s",async issue=>{
  await bindFullChain();if(issue!=="no hold")await stopRequest();const proof=terminalProof();
  if(issue==="receipt")await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[id(1)]);
  if(issue==="wrong session")proof.sessionId="cs_test_other";
  if(issue==="wrong subscription")proof.subscriptionId="sub_other";
  if(issue==="paid")proof.checkoutStatus="complete";
  if(issue==="stale")proof.observedAt-=60;
  if(issue==="future")proof.observedAt+=60;
  if(issue==="invalid time")proof.canceledAt=0;
  if(issue==="changed proof"){await recordStopProof(proof);proof.canceledAt--;}
  await expect(recordStopProof(proof,issue==="foreign buyer"?id(9):id(3))).rejects.toThrow();
});

async function recoverExisting(step: string, req: object | null = null, buyer = id(3), ctx = context) {
  return (await db.query<{ result: any }>("select recover_buyer_mentorship_preparation_v1($1,$2,$3,$4,$5) result",
    [id(2), buyer, ctx, step, req])).rows[0].result;
}
test("existing-only recovery cannot invent an anchor or missing operation", async () => {
  expect(await recoverExisting("bootstrap.begin")).toEqual({ status: "partial_preparation" });
  expect(await recoverExisting("product.create", request())).toEqual({ status: "partial_preparation" });
  expect((await db.query("select * from buyer_mentorship_bootstraps_v1")).rows).toEqual([]);
  expect((await db.query("select * from buyer_mentorship_bootstrap_operations_v1")).rows).toEqual([]);
});
test("existing-only recovery does not create a missing customer", async () => {
  await db.exec("reset role; delete from buyer_mentorship_customer_operations_v1; set local role service_role");
  expect(await recoverExisting("customer.create")).toEqual({ status: "partial_preparation" });
  expect((await db.query("select * from buyer_mentorship_customer_operations_v1")).rows).toEqual([]);
});
test("existing-only recovery preserves the bound customer and anchor", async () => {
  expect((await recoverExisting("customer.create")).status).toBe("bound");
  const original = await begin(); expect(await recoverExisting("bootstrap.begin")).toEqual(original);
});
test("existing-only recovery retains the original key and existing lease rules", async () => {
  const original = await claim();
  expect((await recoverExisting("product.create", request())).status).toBe("busy");
  await db.exec("update buyer_mentorship_bootstrap_operations_v1 set lease_until=now()-interval '1 second'");
  const retry = await recoverExisting("product.create", request());
  expect(retry.status).toBe("dispatch");
  expect(retry.operation.idempotency_key).toBe(original.operation.idempotency_key);
  expect(retry.operation.request).toEqual(original.operation.request);
  expect(retry.operation.first_dispatch_at).toBe(original.operation.first_dispatch_at);
  await bind(retry);
  expect((await recoverExisting("product.create", request())).status).toBe("bound");
  expect(await recoverExisting("subscription.create", request("subscription.create"))).toEqual({ status: "partial_preparation" });
  expect((await db.query("select step from buyer_mentorship_bootstrap_operations_v1")).rows).toEqual([{ step: "product.create" }]);
});
test.each(["buyer", "context"])("existing-only recovery refuses foreign %s", async field => {
  await expect(recoverExisting("customer.create", null, field === "buyer" ? id(9) : id(3),
    field === "context" ? { ...context, platformAccountId: "acct_other" } : context)).rejects.toThrow("Owned preparation");
});
test.each(["buyer_mentorship_abandonment_holds_v1", "buyer_mentorship_first_receipts_v1", "buyer_mentorship_activation_operations_v1"])(
  "existing-only recovery refuses terminal workflow marker %s", async table => {
    if (table === "buyer_mentorship_abandonment_holds_v1") { await bindFullChain(); await stopRequest(); }
    else await db.query(`insert into ${table}(reservation_id) values($1)`, [id(1)]);
    await expect(recoverExisting("customer.create")).rejects.toThrow("no longer admissible");
  });
test("recovery function is service-only", async () => {
  expect((await db.query("select has_function_privilege('authenticated','recover_buyer_mentorship_preparation_v1(uuid,uuid,jsonb,text,jsonb)','execute') allowed")).rows)
    .toEqual([{ allowed: false }]);
});
