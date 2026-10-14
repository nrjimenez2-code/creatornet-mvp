/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {calculateCreatorFees,creatorFeeMetadata} from "../lib/money";
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest,type ServerPaymentContract} from "../lib/serverPaymentConfirmation";
import {runServerPaymentConfirmation,getServerPaymentAuthentication} from "../lib/serverPaymentConfirmationStore";
import {stopServerPaymentIntent} from "../lib/serverPaymentStop";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_owned",
  supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const evidence={approvedContext:context,vercelEnvironment:"preview",stripeSecretKeyMode:"test",stripePublishableKeyMode:"test",
  observedPlatformAccountId:context.platformAccountId,observedSupabaseProjectRef:context.supabaseProjectRef,
  configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin};
const schedule={enabled:true,basisPoints:290,fixedCents:30,version:"fixture-v1"};
const fees=calculateCreatorFees(3333,schedule);
const fingerprint="a".repeat(64);
const candidate={id:id(1),buyer_id:id(2),creator_id:id(3),product_id:id(4),post_id:id(5),purchase_identity:`post:${id(5)}`,
  attempt_key:id(6),order_id:id(7),terms_fingerprint:fingerprint,purchase_consent_id:id(8)};
let c:ServerPaymentContract,request:ReturnType<typeof serverPaymentCreateRequest>;
const rpc=async(name:string,tail:unknown[]=[],buyer=id(2),ctx:object=context)=>
  (await db.query<{result:any}>(`select ${name}(${[id(1),buyer,ctx,...tail].map((_,i)=>`$${i+1}`).join(",")}) result`,[id(1),buyer,ctx,...tail])).rows[0].result;
const claim=()=>rpc("claim_server_payment_intent_v1",[c,request]);
const read=()=>rpc("read_server_payment_intent_v1");
const assertDispatch=(token:string)=>rpc("assert_server_payment_intent_dispatch_v1",[token]);
const stop=()=>rpc("request_server_payment_stop_v1");
const provider=(op:any)=>({...request.params,id:"pi_owned",object:"payment_intent",livemode:false,
  customer:c.customerId,setup_future_usage:c.kind==="full"?null:"off_session",status:"requires_payment_method",
  created:Math.floor(Date.parse(op.first_dispatch_at)/1000),payment_method_types:["card"],amount_received:0,amount_capturable:0,
  payment_method:null,latest_charge:null,last_payment_error:null,on_behalf_of:null,shipping:null,transfer_group:null});
const bind=(op:any,object:object=provider(op),req="req_owned")=>rpc("bind_server_payment_intent_v1",[op.lease_token,object,req]);
beforeAll(async()=>{
  db=createLocalPostgres();
  // Minimal structural dependencies; the two production migrations, including
  // their role permissions and functions, are executed unchanged below.
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table exact_installment_context_pin_v2(singleton boolean primary key,context jsonb unique);
    create table product_purchase_consents_v1(id uuid primary key,terms jsonb,accepted_at timestamptz default clock_timestamp());
    create table product_checkout_attempts(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,
      purchase_identity text,attempt_key uuid,order_id uuid,terms_fingerprint text,purchase_consent_id uuid,checkout_kind text,status text,
      buyer_installment_reservation_id uuid,original_request_protocol text,original_request jsonb,
      stripe_checkout_session_id text,stripe_checkout_url text,updated_at timestamptz default now());
    create table buyer_mentorship_installment_reservations_v1(id uuid primary key,request_id uuid,attempt_id uuid,buyer_id uuid,
      creator_id uuid,product_id uuid,post_id uuid,context jsonb,status text,released_at timestamptz,
      accepted_at timestamptz,terms jsonb,fingerprint text,destination_id text);
    create table buyer_mentorship_bootstraps_v1(reservation_id uuid,customer_id text,anchor_seconds bigint);
    create table buyer_mentorship_bootstrap_operations_v1(reservation_id uuid,step text,request jsonb,result_id text,bound_at timestamptz,lease_until timestamptz);
    create table buyer_mentorship_first_receipts_v1(reservation_id uuid);
    create table buyer_mentorship_activation_operations_v1(reservation_id uuid);
    create table buyer_mentorship_abandonment_holds_v1(reservation_id uuid);
    create table purchases(buyer_id uuid,product_id uuid,post_id uuid);
    create table profiles(id uuid,stripe_account_id text,stripe_onboarding_complete boolean);
    create table orders(id uuid,buyer_id uuid,creator_id uuid,post_id uuid,status text,currency text,amount_cents bigint,
      gross_amount bigint,platform_fee bigint,processing_fee bigint,total_creator_deduction bigint,creator_amount bigint,fee_schedule_version text);`);
  for(const name of ["20260921173504_server_payment_protocol.sql","20260921175109_server_payment_intent_operations.sql",
    "20260921181924_server_payment_confirmation_operations.sql","20260921190318_server_payment_card_replacement.sql",
    "20260921200823_server_payment_authentication_capability.sql","20260921201913_server_payment_intent_cancellation.sql"])
    await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
  await db.exec(readFileSync("supabase/migrations/20260924071323_manual_intent_card_only.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/20260924074115_manual_card_method.sql","utf8"));
});

const tokenBasis=()=>({kind:"token",token:{tokenId:"ctoken_owned",createdAt:Math.floor(Date.now()/1000),
  expiresAt:Math.floor(Date.now()/1000)+1800,previewHash:"b".repeat(64),country:"US"}});
async function confirmationFixture(){
  await prepare();const intent=(await claim()).operation;await bind(intent);
  const basis=tokenBasis(),pi={...provider(intent),next_action:null};
  const phase=await rpc("claim_server_confirmation_v1",[basis,pi]);
  return {intent,basis,pi,phase:phase.operation};
}
const observe=(phase:any,status:string,extra:object={})=>rpc("record_server_confirmation_observation_v1",[phase.operation_id,phase.lease_token,{
  paymentIntentId:"pi_owned",status,paymentMethodId:status==="requires_payment_method"?null:"pm_owned",
  chargeId:status==="succeeded"?"ch_owned":null,observedAt:Math.floor(Date.now()/1000),
  nextActionHash:status==="requires_action"?"c".repeat(64):null,...extra}]);
const phaseAssert=(phase:any,dispatch=true)=>rpc("assert_server_confirmation_v1",[phase.operation_id,phase.lease_token,dispatch]);
const failedProof={chargeId:"ch_failed",paymentMethodId:"pm_owned",code:"card_declined"};
async function declinedPhase(){
  const f=await confirmationFixture();await observe(f.phase,"requires_payment_method",{chargeId:"ch_failed",failure:failedProof});
  const basis={kind:"replacement",previousOperationId:f.phase.operation_id,failure:failedProof,
    token:{...tokenBasis().token,tokenId:"ctoken_replacement"}};
  const pi={...f.pi,latest_charge:"ch_failed",last_payment_error:{code:"card_declined",charge:"ch_failed",payment_method:{id:"pm_owned"}}};
  return {...f,basis,pi};
}
test("proved decline admits a new token phase on the same intent with an immutable original predecessor",async()=>{
  const f=await declinedPhase();await db.exec("set local role service_role");
  const next=await rpc("claim_server_confirmation_v1",[f.basis,f.pi]);
  expect(next).toMatchObject({status:"dispatch",operation:{phase:2,previous_operation_id:f.phase.operation_id,payment_intent_id:"pi_owned",
    request:{params:{confirmation_token:"ctoken_replacement"}}}});
  expect(next.operation.operation_id).not.toBe(f.phase.operation_id);
  expect((await rpc("claim_server_confirmation_v1",[f.basis,f.pi])).status).toBe("busy");
  expect((await db.query("select count(*)::int n from server_payment_intent_operations_v1")).rows).toEqual([{n:1}]);
});
test.each(["unknown","wrong predecessor","changed failure","old token","reused token","processing","success","wrong charge","stopped","foreign buyer"])
("replacement refuses %s",async issue=>{
  const f=await declinedPhase();
  if(issue==="unknown")await db.exec("update server_payment_confirmations_v1 set latest_observation=latest_observation-'failure'");
  if(issue==="wrong predecessor")f.basis.previousOperationId=id(90);
  if(issue==="changed failure")f.basis={...f.basis,failure:{...failedProof,code:"other"}};
  if(issue==="old token")f.basis.token.createdAt-=10;
  if(issue==="reused token")f.basis.token.tokenId="ctoken_owned";
  if(issue==="processing")f.pi.status="processing";if(issue==="success"){f.pi.status="succeeded";f.pi.amount_received=3333;}
  if(issue==="wrong charge")f.pi.latest_charge="ch_other";if(issue==="stopped")await stop();
  await expect(rpc("claim_server_confirmation_v1",[f.basis,f.pi],issue==="foreign buyer"?id(90):id(2))).rejects.toThrow();
});
test("a proved failure closes dispatch for that phase and cannot regress to unknown",async()=>{
  const f=await declinedPhase();expect((await rpc("claim_server_confirmation_v1",[tokenBasis(),f.pi])).status).toBe("observe_only");
  await expect(phaseAssert(f.phase)).rejects.toThrow();
});
test("failed observation cannot lose its failure proof",async()=>{
  const f=await declinedPhase();await expect(observe(f.phase,"requires_payment_method",{chargeId:"ch_failed"})).rejects.toThrow();
});
test("replacement uncertainty preserves its own original request and key after lease expiry",async()=>{
  const f=await declinedPhase(),first=(await rpc("claim_server_confirmation_v1",[f.basis,f.pi])).operation;
  await observe(first,"requires_payment_method",{chargeId:"ch_failed"});
  await db.exec("update server_payment_confirmations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  const retry=(await rpc("claim_server_confirmation_v1",[f.basis,f.pi])).operation;
  expect(retry.operation_id).toBe(first.operation_id);expect(retry.request).toEqual(first.request);expect(retry.first_dispatch_at).toBe(first.first_dispatch_at);
  expect(retry.lease_token).not.toBe(first.lease_token);
});
test("replacement cannot claim the predecessor's failure as its own outcome",async()=>{
  const f=await declinedPhase(),next=(await rpc("claim_server_confirmation_v1",[f.basis,f.pi])).operation;
  await expect(observe(next,"requires_payment_method",{chargeId:"ch_failed",failure:failedProof})).rejects.toThrow();
});
test("initial phase freezes one token/key identity and exact server confirmation request",async()=>{
  const f=await confirmationFixture();await db.exec("set local role service_role");
  expect(f.phase).toMatchObject({attempt_id:id(1),phase:1,previous_operation_id:null,payment_intent_id:"pi_owned",basis:f.basis,
    request:{apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/payment_intents/pi_owned/confirm",params:{
      confirmation_token:"ctoken_owned",return_url:`${context.siteOrigin}/purchase/payment/return?attempt=${id(1)}`,use_stripe_sdk:true}}});
  expect(await phaseAssert(f.phase)).toEqual(f.phase);
  expect((await rpc("claim_server_confirmation_v1",[f.basis,f.pi])).status).toBe("busy");
  expect(await rpc("read_latest_server_confirmation_v1")).toEqual(f.phase);
});
test("unknown original retries retain operation, request and first time; only lease rotates",async()=>{
  const f=await confirmationFixture();
  await db.exec("update server_payment_confirmations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  const next=(await rpc("claim_server_confirmation_v1",[f.basis,f.pi])).operation;
  expect(next).toMatchObject({operation_id:f.phase.operation_id,first_dispatch_at:f.phase.first_dispatch_at,request:f.phase.request,basis:f.basis});
  expect(next.lease_token).not.toBe(f.phase.lease_token);
  await expect(phaseAssert(f.phase)).rejects.toThrow("no longer admitted");
});
test.each(["stop","purchase"])("%s blocks confirmation but original observations remain readable",async issue=>{
  const f=await confirmationFixture();
  if(issue==="stop")await stop();else await db.query("insert into purchases values($1,$2,$3)",[id(2),id(4),id(5)]);
  await observe(f.phase,"succeeded");expect((await phaseAssert(f.phase,false)).latest_observation.status).toBe("succeeded");
  expect((await rpc("claim_server_confirmation_v1",[f.basis,f.pi])).status).toBe("observe_only");
  await expect(phaseAssert(f.phase)).rejects.toThrow();
});
test("authentication successor requires an observed challenge and same original card, and gets a distinct phase",async()=>{
  const f=await confirmationFixture();await observe(f.phase,"requires_action");
  const basis={kind:"after_authentication",paymentMethodId:"pm_owned",previousOperationId:f.phase.operation_id};
  const pi={...f.pi,status:"requires_confirmation",payment_method:"pm_owned"};
  const next=await rpc("claim_server_confirmation_v1",[basis,pi]);expect(next.status).toBe("dispatch");
  expect(next.operation).toMatchObject({phase:2,previous_operation_id:f.phase.operation_id,payment_intent_id:"pi_owned",basis});
  expect(next.operation.operation_id).not.toBe(f.phase.operation_id);
  expect(next.operation.request.params).toEqual({return_url:`${context.siteOrigin}/purchase/payment/return?attempt=${id(1)}`,use_stripe_sdk:true});
  expect((await rpc("claim_server_confirmation_v1",[basis,pi])).status).toBe("busy");
  expect((await rpc("read_latest_server_confirmation_v1")).operation_id).toBe(next.operation.operation_id);
  await expect(observe(f.phase,"succeeded")).rejects.toThrow("current original");
});
test("challenge remains valid after a recorded requires_confirmation observation",async()=>{
  const f=await confirmationFixture();await observe(f.phase,"requires_action");await observe(f.phase,"requires_confirmation");
  expect((await rpc("claim_server_confirmation_v1",[{kind:"after_authentication",paymentMethodId:"pm_owned",previousOperationId:f.phase.operation_id},
    {...f.pi,status:"requires_confirmation",payment_method:"pm_owned"}])).status).toBe("dispatch");
});
test.each(["no challenge","other predecessor","other card","other intent","money received","stopped"])
("authentication %s cannot admit a successor",async issue=>{
  const f=await confirmationFixture();if(issue!=="no challenge")await observe(f.phase,"requires_action");
  if(issue==="stopped")await stop();
  const basis={kind:"after_authentication",paymentMethodId:issue==="other card"?"pm_other":"pm_owned",
    previousOperationId:issue==="other predecessor"?id(20):f.phase.operation_id};
  await expect(rpc("claim_server_confirmation_v1",[basis,{...f.pi,status:"requires_confirmation",payment_method:basis.paymentMethodId,
    ...(issue==="other intent"?{id:"pi_other"}:{}),...(issue==="money received"?{amount_received:3333}:{})}])).rejects.toThrow();
});
test.each(["expired token","foreign country","extra params","changed token","changed preview","missing hash","automatic intent"])
("%s cannot acquire a new token phase",async issue=>{
  await prepare();const intent=(await claim()).operation;await bind(intent);
  const basis:any=tokenBasis(),pi:any={...provider(intent),next_action:null};
  if(issue==="changed token"||issue==="changed preview")await rpc("claim_server_confirmation_v1",[basis,pi]);
  if(issue==="expired token")basis.token.expiresAt=Math.floor(Date.now()/1000)-1;
  if(issue==="foreign country")basis.token.country="CA";
  if(issue==="extra params")basis.payment_method="pm_injected";
  if(issue==="changed token")basis.token.tokenId="ctoken_other";
  if(issue==="changed preview")basis.token.previewHash="d".repeat(64);
  if(issue==="missing hash")delete basis.token.previewHash;
  if(issue==="automatic intent")pi.confirmation_method="automatic";
  await expect(rpc("claim_server_confirmation_v1",[basis,pi])).rejects.toThrow();
});
test("expired unknown phase cannot obtain a new operation/key",async()=>{
  const f=await confirmationFixture();
  await db.exec("update server_payment_confirmations_v1 set first_dispatch_at=clock_timestamp()-interval '24 hours',lease_until=clock_timestamp()-interval '1 second'");
  const result=await rpc("claim_server_confirmation_v1",[f.basis,f.pi]);expect(result.status).toBe("reconciliation_required");
  expect(result.operation.operation_id).toBe(f.phase.operation_id);
});
test("duplicate observations are idempotent and terminal success cannot regress",async()=>{
  const f=await confirmationFixture();const result=await observe(f.phase,"succeeded");
  await rpc("record_server_confirmation_observation_v1",[f.phase.operation_id,f.phase.lease_token,result]);
  expect((await db.query("select * from server_payment_confirmation_observations_v1")).rows).toHaveLength(1);
  await expect(observe(f.phase,"requires_payment_method")).rejects.toThrow("observation differs");
});
test.each(["foreign intent","foreign card","missing charge","missing challenge","future time","stale time"])
("observation %s is refused",async issue=>{
  const f=await confirmationFixture();let phase=f.phase;
  if(issue==="foreign card"){
    await observe(phase,"requires_action");phase=(await rpc("claim_server_confirmation_v1",[
      {kind:"after_authentication",paymentMethodId:"pm_owned",previousOperationId:phase.operation_id},
      {...f.pi,status:"requires_confirmation",payment_method:"pm_owned"}])).operation;
  }
  const extra=issue==="foreign intent"?{paymentIntentId:"pi_other"}:issue==="foreign card"?{paymentMethodId:"pm_other"}:
    issue==="missing charge"?{chargeId:null}:issue==="missing challenge"?{nextActionHash:null}:
    {observedAt:Math.floor(Date.now()/1000)+(issue==="future time"?60:-60)};
  await expect(observe(phase,issue==="missing challenge"?"requires_action":"succeeded",extra)).rejects.toThrow("observation differs");
});
test("confirmation storage and mutations are inaccessible to client roles and direct service writes",async()=>{
  const result=(await db.query(`select has_table_privilege('service_role','server_payment_confirmations_v1','UPDATE') upd,
    has_table_privilege('service_role','server_payment_confirmation_observations_v1','INSERT') ins,
    has_table_privilege('authenticated','server_payment_confirmations_v1','SELECT') buyer,
    has_function_privilege('anon','claim_server_confirmation_v1(uuid,uuid,jsonb,jsonb,jsonb)','EXECUTE') anon`)).rows;
  expect(result).toEqual([{upd:false,ins:false,buyer:false,anon:false}]);
});

async function confirmationRuntime(){
  await prepare();const intent=(await claim()).operation;await bind(intent);
  const pi:any={...provider(intent),next_action:null,client_secret:"pi_owned_secret_synthetic"};
  const token:any={id:"ctoken_owned",object:"confirmation_token",created:Math.floor(Date.now()/1000),expires_at:Math.floor(Date.now()/1000)+1800,
    livemode:false,payment_intent:null,setup_intent:null,setup_future_usage:null,shipping:null,return_url:null,use_stripe_sdk:true,
    payment_method_options:null,mandate_data:null,payment_method_preview:{type:"card",customer:null,
      billing_details:{name:"Fixture buyer",address:{country:"US",line1:"1 Fixture Way",line2:null,city:"Phoenix",state:"AZ",postal_code:"85001"}},
      card:{exp_month:12,exp_year:2035,last4:"4242"}}};
  const pm:any={id:"pm_owned",object:"payment_method",livemode:false,type:"card",customer:null,card:token.payment_method_preview.card,
    billing_details:token.payment_method_preview.billing_details};
  const copy=(v:any)=>JSON.parse(JSON.stringify(v));
  const stripe={paymentIntents:{retrieve:jest.fn(async()=>copy(pi)),cancel:jest.fn(async()=>{
    Object.assign(pi,{status:"canceled",canceled_at:Math.floor(Date.now()/1000),next_action:null});return copy(pi);
  }),confirm:jest.fn(async()=>{
    Object.assign(pi,{status:"succeeded",payment_method:pm.id,latest_charge:"ch_owned",amount_received:3333,next_action:null});
    token.payment_intent=pi.id;return copy(pi);
  })},charges:{retrieve:jest.fn(),list:jest.fn(async()=>({object:"list",data:[] as any[],has_more:false}))},paymentMethods:{retrieve:jest.fn(async()=>copy(pm))},confirmationTokens:{retrieve:jest.fn(async(_tokenId?:string)=>copy(token))}};
  const admin={rpc:jest.fn(async(name:string,params:Record<string,unknown>)=>{
    const entries=Object.entries(params);
    // Supabase returns JSON through HTTP. Normalize the native PGlite realm to
    // that boundary before exercising strict runtime object comparisons.
    try{return {data:copy((await db.query<{result:any}>(`select ${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(",")}) result`,entries.map(([,v])=>v))).rows[0].result),error:null};}
    catch(error){return {data:null,error};}
  })};
  const env:Record<string,string|undefined>={CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY:"true",
    CREATOR_SERVER_PAYMENT_CONFIRMATION_READY:"true",CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_REPLACEMENT_READY:"true"};
  const args={contract:c,binding:{paymentIntentId:pi.id,firstDispatchAt:Math.floor(Date.parse(intent.first_dispatch_at)/1000)},
    admin,stripe:stripe as unknown as Parameters<typeof runServerPaymentConfirmation>[0]["stripe"],
    contextEvidence:jest.fn(async()=>evidence),assertProviderSource:jest.fn(async()=>{}),env,
    action:{kind:"token" as const,tokenId:token.id}};
  return {args,stripe,admin,pi,token,pm,env};
}
test("concrete runtime and real SQL admit, confirm and observe one original without secret persistence",async()=>{
  const f=await confirmationRuntime();await db.exec("set local role service_role");const result=await runServerPaymentConfirmation(f.args);
  expect(result).toMatchObject({status:"observed",observation:{status:"succeeded",paymentIntentId:"pi_owned",chargeId:"ch_owned"}});
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledWith("pi_owned",expect.objectContaining({confirmation_token:"ctoken_owned"}),
    {idempotencyKey:`${SERVER_PAYMENT_PROTOCOL}:${result.operationId}`,maxNetworkRetries:0,apiVersion:"2025-10-29.clover",timeout:10000});
  expect((await rpc("read_latest_server_confirmation_v1")).latest_observation.status).toBe("succeeded");
  expect(JSON.stringify(f.admin.rpc.mock.calls)).not.toContain("client_secret");expect(JSON.stringify(result)).not.toContain("secret");
  expect((await runServerPaymentConfirmation(f.args))).toMatchObject({status:"observed",operationId:result.operationId,observation:{status:"succeeded"}});
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
});

async function declinedRuntime(){
  const f=await confirmationRuntime();
  f.stripe.charges.retrieve.mockResolvedValue({id:"ch_failed",object:"charge",payment_intent:f.pi.id,customer:c.customerId,
    livemode:false,status:"failed",paid:false,captured:false,amount:3333,currency:"usd",amount_captured:0,amount_refunded:0,
    balance_transaction:null,refunded:false,disputed:false,payment_method:"pm_owned",failure_code:"card_declined",
    payment_method_details:{type:"card"},created:Math.floor(Date.now()/1000)});
  f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{status:"requires_payment_method",payment_method:null,latest_charge:"ch_failed",
      last_payment_error:{code:"card_declined",charge:"ch_failed",payment_method:{id:"pm_owned"}}});
    f.token.payment_intent=f.pi.id;throw Error("provider declined; private message");
  });
  const first=await runServerPaymentConfirmation(f.args);expect(first).toMatchObject({observation:{failure:failedProof}});
  const replacement=JSON.parse(JSON.stringify({...f.token,id:"ctoken_replacement",payment_intent:null,created:Math.floor(Date.now()/1000)}));
  f.stripe.confirmationTokens.retrieve.mockImplementation(async(id?:string)=>JSON.parse(JSON.stringify(id===replacement.id?replacement:f.token)));
  f.stripe.paymentIntents.confirm.mockImplementation(async()=>{
    Object.assign(f.pi,{status:"succeeded",payment_method:"pm_replacement",latest_charge:"ch_success",amount_received:3333,last_payment_error:null});
    replacement.payment_intent=f.pi.id;return JSON.parse(JSON.stringify(f.pi));
  });
  const action={kind:"replacement" as const,previousOperationId:first.operationId,tokenId:replacement.id};
  return {...f,replacement,action,first};
}
test("runtime replacement independently proves decline, checks fresh US token and confirms the same intent once",async()=>{
  const f=await declinedRuntime();const result=await runServerPaymentConfirmation({...f.args,action:f.action});
  expect(result).toMatchObject({observation:{status:"succeeded",paymentMethodId:"pm_replacement"}});
  expect((await runServerPaymentConfirmation({...f.args,action:f.action})).status).toBe("observed");
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(2);
  expect(f.stripe.paymentIntents.confirm.mock.calls.map((x:any)=>x[0])).toEqual(["pi_owned","pi_owned"]);
  const calls=f.stripe.paymentIntents.confirm.mock.calls as any[];
  expect(calls[0][2].idempotencyKey).not.toBe(calls[1][2].idempotencyKey);
  expect(JSON.stringify((await db.query("select * from server_payment_confirmation_observations_v1")).rows)).not.toContain("private message");
});
test("lost replacement reply before provider outcome waits then preserves the replacement key",async()=>{
  const f=await declinedRuntime();f.stripe.paymentIntents.confirm.mockRejectedValueOnce(Error("lost reply"));
  const unknown=await runServerPaymentConfirmation({...f.args,action:f.action});
  expect(unknown).toMatchObject({observation:{status:"requires_payment_method"}});expect((unknown as any).observation.failure).toBeUndefined();
  expect((await runServerPaymentConfirmation({...f.args,action:f.action})).status).toBe("busy");
  await db.exec("update server_payment_confirmations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  expect((await runServerPaymentConfirmation({...f.args,action:f.action}))).toMatchObject({observation:{status:"succeeded"}});
  const calls=f.stripe.paymentIntents.confirm.mock.calls as any[];expect(calls[1][2].idempotencyKey).toBe(calls[2][2].idempotencyKey);
});
test.each(["non-US","stopped","disabled","different predecessor","foreign charge"])("runtime replacement refuses %s before a second charge",async issue=>{
  const f=await declinedRuntime();
  if(issue==="non-US")f.replacement.payment_method_preview.billing_details.address.country="CA";
  if(issue==="stopped")await stop();if(issue==="disabled")f.env.CREATOR_SERVER_PAYMENT_REPLACEMENT_READY="false";
  if(issue==="different predecessor")f.action.previousOperationId=id(99);
  if(issue==="foreign charge")f.stripe.charges.retrieve.mockResolvedValue({id:"ch_other"});
  await expect(runServerPaymentConfirmation({...f.args,action:f.action})).rejects.toThrow();
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
});
test("a second proved decline permits only a fresh token tied to that exact replacement predecessor",async()=>{
  const f=await declinedRuntime();
  const priorCharge=await f.stripe.charges.retrieve();
  const secondCharge={...priorCharge,id:"ch_second",payment_method:"pm_replacement"};
  f.stripe.charges.retrieve.mockImplementation(async(chargeId?:string)=>chargeId===secondCharge.id?secondCharge:priorCharge);
  f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{status:"requires_payment_method",payment_method:null,latest_charge:secondCharge.id,
      last_payment_error:{code:"card_declined",charge:secondCharge.id,payment_method:{id:"pm_replacement"}}});
    f.replacement.payment_intent=f.pi.id;throw Error("second decline");
  });
  const second=await runServerPaymentConfirmation({...f.args,action:f.action});
  expect(second).toMatchObject({observation:{failure:{chargeId:"ch_second",paymentMethodId:"pm_replacement"}}});
  const thirdToken={...f.replacement,id:"ctoken_third",payment_intent:null,created:Math.floor(Date.now()/1000)};
  const retrieve=f.stripe.confirmationTokens.retrieve.getMockImplementation()!;
  f.stripe.confirmationTokens.retrieve.mockImplementation(async(tokenId?:string)=>
    tokenId===thirdToken.id?JSON.parse(JSON.stringify(thirdToken)):retrieve(tokenId));
  await expect(runServerPaymentConfirmation({...f.args,action:{...f.action,tokenId:thirdToken.id}})).rejects.toThrow();
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(2);
  f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{status:"succeeded",payment_method:"pm_third",latest_charge:"ch_success",amount_received:3333,last_payment_error:null});
    thirdToken.payment_intent=f.pi.id;return JSON.parse(JSON.stringify(f.pi));
  });
  const thirdAction={kind:"replacement" as const,previousOperationId:second.operationId,tokenId:thirdToken.id};
  const third=await runServerPaymentConfirmation({...f.args,action:thirdAction});
  expect(third).toMatchObject({observation:{status:"succeeded",paymentMethodId:"pm_third"}});
  await runServerPaymentConfirmation({...f.args,action:thirdAction});
  const calls=f.stripe.paymentIntents.confirm.mock.calls as any[];
  expect(calls).toHaveLength(3);expect(new Set(calls.map(x=>x[2].idempotencyKey)).size).toBe(3);
  expect(calls.every(x=>x[0]==="pi_owned")).toBe(true);
});

test.each([false,true])("replacement challenge preserves its phase and enforces stop before reconfirmation (stop=%s)",async stopped=>{
  const f=await declinedRuntime();f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{status:"requires_action",payment_method:"pm_replacement",last_payment_error:null,
      next_action:{type:"use_stripe_sdk",use_stripe_sdk:{type:"fixture"}}});
    f.replacement.payment_intent=f.pi.id;return JSON.parse(JSON.stringify(f.pi));
  });
  const challenge=await runServerPaymentConfirmation({...f.args,action:f.action});
  expect(challenge).toMatchObject({observation:{status:"requires_action",paymentMethodId:"pm_replacement"}});
  Object.assign(f.pi,{status:"requires_confirmation",next_action:null});f.pm.id="pm_replacement";
  const action={kind:"after_authentication" as const,previousOperationId:challenge.operationId};
  if(stopped){
    await stop();await expect(runServerPaymentConfirmation({...f.args,action})).rejects.toThrow();
    expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(2);
  }else{
    const paid=await runServerPaymentConfirmation({...f.args,action});
    expect(paid).toMatchObject({observation:{status:"succeeded",paymentMethodId:"pm_replacement"}});
    expect(paid.operationId).not.toBe(challenge.operationId);
    await runServerPaymentConfirmation({...f.args,action});
    expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(3);
    expect((f.stripe.paymentIntents.confirm.mock.calls as any[])[2][1]).not.toHaveProperty("confirmation_token");
  }
});

test.each([false,true])("cancellation of an admitted replacement is recoverable with consumed=%s and never recharges",async consumed=>{
  const f=await declinedRuntime();f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{status:"canceled",canceled_at:Math.floor(Date.now()/1000),cancellation_reason:"automatic"});
    if(consumed)f.replacement.payment_intent=f.pi.id;
    throw Error("confirmation limit or cancellation reply");
  });
  const canceled=await runServerPaymentConfirmation({...f.args,action:f.action});
  expect(canceled).toMatchObject({observation:{status:"canceled"}});
  await stop();
  expect(await runServerPaymentConfirmation({...f.args,action:{kind:"observe"}})).toMatchObject({observation:{status:"canceled"}});
  await expect(runServerPaymentConfirmation({...f.args,action:{kind:"replacement",tokenId:"ctoken_next",previousOperationId:canceled.operationId}})).rejects.toThrow();
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(2);
  expect((await rpc("read_latest_server_confirmation_v1")).latest_observation.status).toBe("canceled");
});

test("a failure without a charge cannot authorize replacement or disguise an uncertain original",async()=>{
  const f=await confirmationRuntime();f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{last_payment_error:{code:"payment_intent_authentication_failure",payment_method:{id:"pm_owned"}}});
    throw Error("authentication failed without charge");
  });
  await expect(runServerPaymentConfirmation(f.args)).rejects.toThrow();
  const original=await rpc("read_latest_server_confirmation_v1");
  await expect(runServerPaymentConfirmation({...f.args,action:{kind:"replacement",tokenId:"ctoken_next",previousOperationId:original.operation_id}})).rejects.toThrow();
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
  expect((await rpc("read_latest_server_confirmation_v1")).operation_id).toBe(original.operation_id);
  expect((await db.query("select * from server_payment_confirmations_v1")).rows).toHaveLength(1);
});

test("bank authentication resumes through a new committed phase with the same original intent/card",async()=>{
  const f=await confirmationRuntime();f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{status:"requires_action",payment_method:"pm_owned",next_action:{type:"use_stripe_sdk",use_stripe_sdk:{type:"fixture"}}});
    f.token.payment_intent=f.pi.id;return JSON.parse(JSON.stringify(f.pi));
  });
  const first=await runServerPaymentConfirmation(f.args);expect(first).toMatchObject({observation:{status:"requires_action"}});
  Object.assign(f.pi,{status:"requires_confirmation",next_action:null});
  const next=await runServerPaymentConfirmation({...f.args,action:{kind:"after_authentication",previousOperationId:first.operationId}});
  expect(next).toMatchObject({observation:{status:"succeeded"}});expect(next.operationId).not.toBe(first.operationId);
  expect(f.stripe.paymentIntents.confirm).toHaveBeenNthCalledWith(2,"pi_owned",{
    return_url:`${context.siteOrigin}/purchase/payment/return?attempt=${id(1)}`,use_stripe_sdk:true},
    {idempotencyKey:`${SERVER_PAYMENT_PROTOCOL}:${next.operationId}`,maxNetworkRetries:0,apiVersion:"2025-10-29.clover",timeout:10000});
  expect((await db.query("select * from server_payment_confirmations_v1")).rows).toHaveLength(2);
});
async function authenticationRuntime(){
  const f=await confirmationRuntime();f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{status:"requires_action",payment_method:"pm_owned",next_action:{type:"use_stripe_sdk",use_stripe_sdk:{type:"fixture"}}});
    f.token.payment_intent=f.pi.id;return JSON.parse(JSON.stringify(f.pi));
  });
  const result=await runServerPaymentConfirmation(f.args);
  f.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY="true";f.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY="true";
  f.args.assertProviderSource.mockClear();f.stripe.paymentIntents.confirm.mockClear();f.admin.rpc.mockClear();
  return {...f,authentication:{...f.args,operationId:result.operationId}};
}
test("bank capability checks the original owner/current challenge in SQL and never stores its secret or reconfirms",async()=>{
  const f=await authenticationRuntime();await db.exec("set local role service_role");
  expect(await getServerPaymentAuthentication(f.authentication)).toEqual({status:"authentication_required",operationId:f.authentication.operationId,
    paymentIntentId:"pi_owned",clientSecret:"pi_owned_secret_synthetic"});
  expect(f.args.assertProviderSource).toHaveBeenCalledTimes(2);
  expect(f.admin.rpc.mock.calls.at(-1)?.[0]).toBe("assert_server_payment_authentication_v1");
  expect(JSON.stringify(f.admin.rpc.mock.calls)).not.toMatch(/secret_synthetic|client_secret|clientSecret/);
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
  expect((await db.query("select * from server_payment_confirmations_v1")).rows).toHaveLength(1);
});
test.each(["foreign owner","foreign context","foreign phase","stopped","late stop","changed source","paid","changed challenge","automatic","no secret","expired","schema disabled","capability disabled","confirmation disabled"])
("bank capability refuses %s without disclosing or confirming",async issue=>{
  const f=await authenticationRuntime();
  if(issue==="foreign owner")f.authentication.contract={...f.authentication.contract,buyerId:id(20)};
  if(issue==="foreign context")f.authentication.contextEvidence.mockResolvedValue({...evidence,observedPlatformAccountId:"acct_other"});
  if(issue==="foreign phase")f.authentication.operationId=id(20);
  if(issue==="stopped")await stop();
  if(issue==="late stop")f.args.assertProviderSource.mockResolvedValueOnce(undefined).mockImplementationOnce(async()=>{await stop();});
  if(issue==="changed source")f.args.assertProviderSource.mockRejectedValueOnce(Error("private source failure"));
  if(issue==="paid")Object.assign(f.pi,{status:"succeeded",amount_received:3333,latest_charge:"ch_paid",next_action:null});
  if(issue==="changed challenge"){
    f.stripe.paymentIntents.retrieve.mockResolvedValueOnce(JSON.parse(JSON.stringify(f.pi)));
    f.pi.next_action.use_stripe_sdk.type="changed";
  }
  if(issue==="automatic")f.pi.confirmation_method="automatic";
  if(issue==="no secret")f.pi.client_secret=null;
  if(issue==="expired")Object.assign(f.authentication,{now:()=>c.expiresAt+1});
  if(issue==="schema disabled")f.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY="false";
  if(issue==="capability disabled")f.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY="false";
  if(issue==="confirmation disabled")f.env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY="false";
  await expect(getServerPaymentAuthentication(f.authentication)).rejects.toThrow("Server payment authentication requires review");
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("SQL refuses stale challenge proof, changed terms and direct public capability admission",async()=>{
  const f=await authenticationRuntime();const phase=await rpc("read_latest_server_confirmation_v1");
  const auth=()=>rpc("assert_server_payment_authentication_v1",[phase.operation_id,phase.latest_observation]);
  await db.exec("set local role service_role");expect((await auth()).operation_id).toBe(phase.operation_id);
  const roles=(await db.query(`select has_function_privilege('anon','assert_server_payment_authentication_v1(uuid,uuid,jsonb,uuid,jsonb)','EXECUTE') anon,
    has_function_privilege('authenticated','assert_server_payment_authentication_v1(uuid,uuid,jsonb,uuid,jsonb)','EXECUTE') buyer`)).rows;
  expect(roles).toEqual([{anon:false,buyer:false}]);await db.exec("reset role");
  await db.exec("update server_payment_confirmations_v1 set latest_observation=jsonb_set(latest_observation,'{observedAt}',to_jsonb(floor(extract(epoch from clock_timestamp()))::bigint-31))");
  const stale=await rpc("read_latest_server_confirmation_v1");
  await db.exec("savepoint expected_stale_rejection");
  await expect(rpc("assert_server_payment_authentication_v1",[stale.operation_id,stale.latest_observation])).rejects.toThrow("Current original bank challenge");
  await db.exec("rollback to savepoint expected_stale_rejection");
  await db.query("update server_payment_confirmations_v1 set latest_observation=$1",[phase.latest_observation]);
  await db.exec("update orders set status='paid'");await expect(auth()).rejects.toThrow();
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});

test("a superseded bank challenge cannot disclose the current or previous secret",async()=>{
  const f=await authenticationRuntime();Object.assign(f.pi,{status:"requires_confirmation",next_action:null});
  await runServerPaymentConfirmation({...f.args,action:{kind:"after_authentication",previousOperationId:f.authentication.operationId}});
  f.stripe.paymentIntents.retrieve.mockClear();f.stripe.paymentIntents.confirm.mockClear();
  await expect(getServerPaymentAuthentication(f.authentication)).rejects.toThrow("Server payment authentication requires review");
  expect(f.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});

async function cancellationRuntime(){
  const f=await confirmationRuntime();
  f.env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY="true";f.env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY="true";
  const args={...f.args,stripe:f.stripe as unknown as Parameters<typeof stopServerPaymentIntent>[0]["stripe"]};
  return {...f,args};
}
test.each(["requires_payment_method","requires_confirmation","requires_action"])("manual %s cancellation persists stop before provider dispatch and proof never releases selection",async status=>{
  const f=await cancellationRuntime();f.pi.status=status;
  if(status!=="requires_payment_method")f.pi.payment_method="pm_owned";
  if(status==="requires_action")f.pi.next_action={type:"use_stripe_sdk",use_stripe_sdk:{type:"fixture"}};
  await db.exec("set local role service_role");
  const result=await stopServerPaymentIntent(f.args);
  expect(result).toMatchObject({status:"intent_canceled_unreleased",releaseAllowed:false,proof:{paymentIntentId:"pi_owned",status:"canceled",chargeIds:[]}});
  const op=(await db.query<any>("select * from server_payment_intent_cancellations_v1")).rows[0];
  expect(f.stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_owned",{cancellation_reason:"requested_by_customer"},
    {apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000,idempotencyKey:op.idempotency_key});
  const stopCall=f.admin.rpc.mock.calls.findIndex(([name])=>name==="request_server_payment_stop_v1");
  const assertCall=f.admin.rpc.mock.calls.findIndex(([name])=>name==="assert_server_payment_cancellation_v1");
  expect(stopCall).toBe(0);expect(assertCall).toBeGreaterThan(stopCall);
  expect(f.admin.rpc.mock.invocationCallOrder[assertCall]).toBeLessThan(f.stripe.paymentIntents.cancel.mock.invocationCallOrder[0]);
  expect(JSON.stringify(f.admin.rpc.mock.calls)).not.toMatch(/client_secret|secret_synthetic/);
  await db.exec("reset role");
  expect((await db.query("select * from product_checkout_attempts")).rows).toHaveLength(1);
  await stopServerPaymentIntent(f.args);expect(f.stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("unknown cancel waits then uses its own exact original request and key",async()=>{
  const f=await cancellationRuntime();f.stripe.paymentIntents.cancel.mockRejectedValueOnce(Error("network timeout"));
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:"reconciliation_required",releaseAllowed:false});
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:"busy"});
  await db.exec("update server_payment_intent_cancellations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:"intent_canceled_unreleased"});
  const calls=f.stripe.paymentIntents.cancel.mock.calls as any[];
  expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);
});
test("lost cancellation response recovers terminal state without replay even after dispatch is aged",async()=>{
  const f=await cancellationRuntime(),cancel=f.stripe.paymentIntents.cancel.getMockImplementation()!;
  f.stripe.paymentIntents.cancel.mockImplementationOnce(async()=>{await cancel();throw Error("lost cancel reply");});
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:"intent_canceled_unreleased"});
  await db.exec("update server_payment_intent_cancellations_v1 set first_dispatch_at=clock_timestamp()-interval '24 hours'");
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:"intent_canceled_unreleased"});
  expect(f.stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
});
test.each(["aged","unknown create","foreign owner","foreign context","capturable","schema disabled","dispatch disabled","purchase","automatic"])
("cancellation refuses %s without provider writes",async issue=>{
  const f=await cancellationRuntime();
  if(issue==="aged"){
    await stop();await rpc("claim_server_payment_cancellation_v1");
    await db.exec("update server_payment_intent_cancellations_v1 set first_dispatch_at=clock_timestamp()-interval '24 hours',lease_until=clock_timestamp()-interval '1 second'");
  }
  if(issue==="unknown create")await db.exec("update server_payment_intent_operations_v1 set payment_intent_id=null,provider_request_id=null,bound_at=null");
  if(issue==="foreign owner")f.args.contract={...c,buyerId:id(50)};
  if(issue==="foreign context")f.args.contextEvidence.mockResolvedValue({...evidence,observedPlatformAccountId:"acct_foreign"});
  if(issue==="capturable")f.pi.amount_capturable=3333;
  if(issue==="schema disabled")f.env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY="false";
  if(issue==="dispatch disabled")f.env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY="false";
  if(issue==="purchase")await db.query("insert into purchases values($1,$2,$3)",[id(2),id(4),id(5)]);
  if(issue==="automatic")f.pi.confirmation_method="automatic";
  if(issue==="aged")expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:"reconciliation_required"});
  else await expect(stopServerPaymentIntent(f.args)).rejects.toThrow("Original manual payment stop requires review");
  expect(f.stripe.paymentIntents.cancel).not.toHaveBeenCalled();expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test.each(["processing","succeeded"])("%s wins a cancellation race and requires original financial reconciliation",async status=>{
  const f=await cancellationRuntime();f.stripe.paymentIntents.cancel.mockImplementationOnce(async()=>{
    Object.assign(f.pi,{status,amount_received:status==="succeeded"?3333:0,payment_method:"pm_owned",latest_charge:"ch_owned"});
    throw Error("too late to cancel");
  });
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:"reconciliation_required",releaseAllowed:false});
  expect((await db.query("select * from server_payment_intent_terminal_v1")).rows).toHaveLength(0);
  expect((await db.query("select * from server_payment_stops_v1")).rows).toHaveLength(1);
});
test("failure without a charge can cancel the original without admitting another token or payment",async()=>{
  const f=await cancellationRuntime();f.pi.last_payment_error={code:"payment_intent_authentication_failure",payment_method:{id:"pm_owned"}};
  expect(await stopServerPaymentIntent(f.args)).toMatchObject({status:"intent_canceled_unreleased"});
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("terminal history must include every failed charge, and captured/refunded or incomplete history cannot authorize terminal proof",async()=>{
  const f=await cancellationRuntime();Object.assign(f.pi,{status:"canceled",canceled_at:Math.floor(Date.now()/1000),latest_charge:"ch_failed"});
  f.stripe.charges.list.mockResolvedValue({object:"list",has_more:false,data:[{id:"ch_failed",object:"charge",payment_intent:"pi_owned",customer:null,
    livemode:false,status:"failed",paid:false,captured:false,amount:3333,currency:"usd",amount_captured:3333,amount_refunded:3333,
    balance_transaction:null,refunded:true,disputed:false,payment_method_details:{type:"card"},created:Math.floor(Date.now()/1000)}]});
  await expect(stopServerPaymentIntent(f.args)).rejects.toThrow();
  expect((await db.query("select * from server_payment_intent_terminal_v1")).rows).toHaveLength(0);
  expect(f.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
});
test("cancel operation and terminal proof are service-only immutable records",async()=>{
  const f=await cancellationRuntime();await stopServerPaymentIntent(f.args);
  const permissions=(await db.query(`select
    has_table_privilege('service_role','server_payment_intent_cancellations_v1','UPDATE') upd,
    has_table_privilege('service_role','server_payment_intent_terminal_v1','INSERT') ins,
    has_function_privilege('authenticated','claim_server_payment_cancellation_v1(uuid,uuid,jsonb)','EXECUTE') buyer,
    has_function_privilege('anon','record_server_payment_terminal_v1(uuid,uuid,jsonb,jsonb)','EXECUTE') anon`)).rows;
  expect(permissions).toEqual([{upd:false,ins:false,buyer:false,anon:false}]);
});

test("a stale cancellation lease cannot dispatch after takeover, and request/key/time do not rotate",async()=>{
  const f=await cancellationRuntime();await stop();const first=(await rpc("claim_server_payment_cancellation_v1")).operation;
  await db.exec("update server_payment_intent_cancellations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  const next=(await rpc("claim_server_payment_cancellation_v1")).operation;
  expect(next).toMatchObject({request:first.request,idempotency_key:first.idempotency_key,first_dispatch_at:first.first_dispatch_at});
  expect(next.lease_token).not.toBe(first.lease_token);
  await expect(rpc("assert_server_payment_cancellation_v1",[first.lease_token])).rejects.toThrow("no longer admitted");
  expect(f.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
});
test("a gate disabled while cancellation is being authorized prevents its provider write",async()=>{
  const f=await cancellationRuntime(),rpcImpl=f.admin.rpc.getMockImplementation()!;
  f.admin.rpc.mockImplementation(async(name,params)=>{
    const response=await rpcImpl(name,params);
    if(name==="assert_server_payment_cancellation_v1")f.env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY="false";
    return response;
  });
  await expect(stopServerPaymentIntent(f.args)).rejects.toThrow();expect(f.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
});
test("saved terminal evidence cannot be replaced by a different canceled intent or charge history",async()=>{
  const f=await cancellationRuntime(),result=await stopServerPaymentIntent(f.args);
  expect(result.status).toBe("intent_canceled_unreleased");
  const proof=(result as {proof:unknown}).proof as Record<string,unknown>;
  await expect(rpc("record_server_payment_terminal_v1",[{...proof,chargeIds:["ch_invented"]}])).rejects.toThrow("cannot change");
});

test("lost confirmation response is independently reconciled without replaying the write",async()=>{
  const f=await confirmationRuntime(),confirm=f.stripe.paymentIntents.confirm.getMockImplementation()!;
  f.stripe.paymentIntents.confirm.mockImplementationOnce(async()=>{await confirm();throw Error("lost provider reply");});
  expect(await runServerPaymentConfirmation(f.args)).toMatchObject({observation:{status:"succeeded"}});
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
});
test("unknown confirmation waits for the original lease then replays only its original key",async()=>{
  const f=await confirmationRuntime();f.stripe.paymentIntents.confirm.mockRejectedValueOnce(Error("lost reply before unknown dispatch"));
  const first=await runServerPaymentConfirmation(f.args);expect(first).toMatchObject({observation:{status:"requires_payment_method"}});
  expect(await runServerPaymentConfirmation(f.args)).toEqual({status:"busy",operationId:first.operationId});
  await db.exec("update server_payment_confirmations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  expect(await runServerPaymentConfirmation(f.args)).toMatchObject({operationId:first.operationId,observation:{status:"succeeded"}});
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(2);
  const calls=f.stripe.paymentIntents.confirm.mock.calls as unknown as unknown[][];
  expect(calls[0][2]).toEqual(calls[1][2]);
});
test("stopped and disabled confirmation remains observable without another provider write",async()=>{
  const f=await confirmationRuntime();const first=await runServerPaymentConfirmation(f.args);await stop();
  f.env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY="false";
  expect(await runServerPaymentConfirmation({...f.args,action:{kind:"observe"}})).toMatchObject({operationId:first.operationId,observation:{status:"succeeded"}});
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
});
test.each(["non-US token","stopped before dispatch","changed source","disabled dispatch"])
("runtime %s prevents any confirmation",async issue=>{
  const f=await confirmationRuntime();
  if(issue==="non-US token")f.token.payment_method_preview.billing_details.address.country="CA";
  if(issue==="stopped before dispatch")f.args.assertProviderSource.mockImplementationOnce(async()=>{await stop();});
  if(issue==="changed source")f.args.assertProviderSource.mockRejectedValueOnce(Error("source changed"));
  if(issue==="disabled dispatch")f.env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY="false";
  await expect(runServerPaymentConfirmation(f.args)).rejects.toThrow("Server payment confirmation requires review");
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
beforeEach(async()=>{
  await db.exec("begin");
  await db.query("insert into exact_installment_context_pin_v2 values(true,$1)",[context]);
  await db.query("insert into product_purchase_consents_v1(id,terms) values($1,$2)",[id(8),{
    kind:"one_time",buyerId:id(2),creatorId:id(3),productId:id(4),postId:id(5),amountCents:3333}]);
  await db.query("insert into profiles values($1,'acct_creator',true)",[id(3)]);
  await db.query("insert into orders values($1,$2,$3,$4,'created','usd',3333,3333,$5,$6,$7,$8,$9)",
    [id(7),id(2),id(3),id(5),fees.platformFeeCents,fees.processingFeeCents,fees.totalCreatorDeductionCents,fees.creatorNetCents,fees.feeScheduleVersion]);
});
afterEach(async()=>{await db.exec("rollback");});
afterAll(async()=>{await db.close();});
async function prepare(kind:ServerPaymentContract["kind"]="full"){
  let created:number,accepted:number;
  if(kind==="full"){
    const pin=(await db.query<{result:any}>("select reserve_full_server_payment_v1($1,$2,$3) result",[candidate,id(2),context])).rows[0].result;
    created=Math.floor(Date.parse(pin.created_at)/1000);
    accepted=Number((await db.query<{t:number}>("select floor(extract(epoch from accepted_at)) t from product_purchase_consents_v1")).rows[0].t);
  }else{
    accepted=Math.floor(Date.now()/1000);created=accepted;
    await db.query(`insert into buyer_mentorship_installment_reservations_v1 values($1,$2,$3,$4,$5,$6,$7,$8,'reserved',null,
      to_timestamp($9),$10,$11,'acct_creator')`,[id(9),id(10),id(1),id(2),id(3),id(4),id(5),context,accepted,
      {payments:[{amountCents:3333}],firstPaymentFeeSchedule:schedule},fingerprint]);
    await db.query(`insert into product_checkout_attempts(id,buyer_id,creator_id,product_id,post_id,purchase_identity,attempt_key,order_id,
      terms_fingerprint,checkout_kind,status,buyer_installment_reservation_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'installments','creating',$10)`,
      [id(1),id(2),id(3),id(4),id(5),`post:${id(5)}`,id(6),id(7),fingerprint,id(9)]);
    await db.query("select pin_installment_server_payment_v1($1,$2,$3)",[id(10),id(2),context]);
    await db.query("insert into buyer_mentorship_bootstraps_v1 values($1,'cus_owned',$2)",[id(9),created]);
    for(const step of ["subscription.create","subscription.hold"])
      await db.query("insert into buyer_mentorship_bootstrap_operations_v1 values($1,$2,$3,'sub_owned',clock_timestamp(),null)",
        [id(9),step,{params:{customer:"cus_owned"}}]);
  }
  c={protocol:SERVER_PAYMENT_PROTOCOL,attemptId:id(1),buyerId:id(2),creatorId:id(3),productId:id(4),termsFingerprint:fingerprint,
    context,customerId:kind==="full"?null:"cus_owned",destinationId:"acct_creator",amountCents:3333,processingFees:schedule,kind,
    acceptedAt:accepted,expiresAt:created+86400-(kind==="full"?0:1860),sourceMetadata:{...creatorFeeMetadata(fees),
      buyer_id:id(2),creator_id:id(3),product_id:id(4),...(kind==="full"?{
        order_id:id(7),checkout_attempt_key:id(6),checkout_terms_fingerprint:fingerprint}:{
        creatornet_installment_reservation_id:id(9),creatornet_installment_request_id:id(10),terms_fingerprint:fingerprint,
        installment_subscription_id:"sub_owned",installment_number:"1",plan_type:"installment"})}};
  request=serverPaymentCreateRequest(c,evidence);
}
test.each(["full","first_installment"] as const)("%s freezes the TS request, serializes retries and binds one original",async kind=>{
  await prepare(kind);await db.exec("set local role service_role");
  const first=await claim();expect(first.status).toBe("dispatch");expect(first.operation.request).toEqual(request);
  expect((await claim()).status).toBe("busy");expect(await assertDispatch(first.operation.lease_token)).toEqual(first.operation);
  const bound=await bind(first.operation);expect(bound.payment_intent_id).toBe("pi_owned");
  expect((await claim())).toEqual({status:"bound",operation:bound});expect(await read()).toEqual(bound);
});
async function installFullSource(){
  if(c.kind==="full"){
    await db.exec(`update product_purchase_consents_v1 set terms=terms||'{"version":"accepted-policy"}'::jsonb`);
    c={...c,sourceMetadata:{...c.sourceMetadata,post_id:id(5),purchase_consent_id:id(8),purchase_policy_version:"accepted-policy"}};
    request=serverPaymentCreateRequest(c,evidence);
  }
  await db.exec(readFileSync("supabase/migrations/20260923005519_full_server_payment_source.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
}
test("full source is immutable before intent admission and remains readable after stop and order changes",async()=>{
  await prepare();await installFullSource();await db.exec("set local role service_role");
  expect(await rpc("read_full_server_payment_contract_v1")).toBeNull();
  expect(await rpc("save_full_server_payment_contract_v1",[c,request])).toEqual(c);
  expect((await claim()).status).toBe("dispatch");
  await stop();await db.exec("reset role;update orders set status='canceled'");
  expect(await rpc("read_full_server_payment_contract_v1")).toEqual(c);
  expect(await rpc("save_full_server_payment_contract_v1",[c,request])).toEqual(c);
});
test.each(["missing snapshot","changed snapshot","wrong fees","wrong order","wrong consent metadata","wrong service metadata","stopped","expired","foreign buyer","foreign context","existing unknown intent"])
("full source refuses %s without a replacement admission",async issue=>{
  await prepare();
  if(issue==="existing unknown intent")await claim();
  await installFullSource();
  if(issue==="changed snapshot")await rpc("save_full_server_payment_contract_v1",[c,request]);
  if(issue==="wrong order")await db.exec("update orders set amount_cents=9999");
  if(issue==="stopped")await stop();
  if(issue==="wrong fees"||issue==="changed snapshot")c={...c,processingFees:{...schedule,fixedCents:500}};
  if(issue==="wrong consent metadata")c={...c,sourceMetadata:{...c.sourceMetadata,purchase_consent_id:id(90)}};
  if(issue==="wrong service metadata")c={...c,sourceMetadata:{...c.sourceMetadata,fixed_service_version:"invented"}};
  if(issue==="expired")c={...c,expiresAt:Math.floor(Date.now()/1000)-10};
  await db.exec("savepoint rejected_source");
  if(issue==="missing snapshot")await expect(claim()).rejects.toThrow("snapshot required");
  else await expect(rpc("save_full_server_payment_contract_v1",[c,request],
    issue==="foreign buyer"?id(90):id(2),issue==="foreign context"?{...context,mode:"live"}:context)).rejects.toThrow();
  await db.exec("rollback to savepoint rejected_source");
  expect((await db.query("select count(*)::int n from full_server_payment_sources_v1")).rows).toEqual([{n:issue==="changed snapshot"?1:0}]);
});
test.each(["anon","authenticated"])("%s cannot read or save full source",async role=>{
  await prepare();await installFullSource();await db.exec(`set local role ${role}`);
  await expect(rpc("read_full_server_payment_contract_v1")).rejects.toThrow("permission denied");
});
test("full snapshot requirement leaves the existing installment source path unchanged",async()=>{
  await prepare("first_installment");await installFullSource();expect((await claim()).status).toBe("dispatch");
});
test("expired lease retries the original request/key/time and invalidates the stale worker",async()=>{
  await prepare();const first=(await claim()).operation;
  await db.exec("update server_payment_intent_operations_v1 set lease_until=clock_timestamp()-interval '1 second'");
  const second=(await claim()).operation;
  expect(second).toMatchObject({idempotency_key:first.idempotency_key,first_dispatch_at:first.first_dispatch_at,request:first.request});
  expect(second.lease_token).not.toBe(first.lease_token);
  await expect(bind(first)).rejects.toThrow("binding differs");
});
test("a stop blocks dispatch but preserves binding and reading the original provider reply",async()=>{
  await prepare();const op=(await claim()).operation;
  const stopped=await stop();expect(stopped.releaseAllowed).toBe(false);expect(await stop()).toEqual(stopped);
  const bound=await bind(op);expect(await read()).toEqual(bound);expect((await claim()).status).toBe("bound");
  await expect(assertDispatch(op.lease_token)).rejects.toThrow("stopped");
});
test.each(["stop","purchase"])("%s arriving before dispatch revokes admission",async change=>{
  await prepare();const op=(await claim()).operation;
  if(change==="stop")await stop();
  if(change==="purchase")await db.query("insert into purchases values($1,$2,$3)",[id(2),id(4),id(5)]);
  await expect(assertDispatch(op.lease_token)).rejects.toThrow("stopped");
});
test("the original context pin cannot disappear while its protocol exists",async()=>{
  await prepare();await claim();
  await expect(db.exec("delete from exact_installment_context_pin_v2")).rejects.toThrow("foreign key");
});
test.each(["aged","expired"])("%s unknown intent cannot receive a new idempotency key",async issue=>{
  await prepare();await claim();
  await db.exec(issue==="aged"?"update server_payment_intent_operations_v1 set first_dispatch_at=clock_timestamp()-interval '24 hours'":
    "update server_payment_intent_operations_v1 set contract=jsonb_set(contract,'{expiresAt}',to_jsonb(floor(extract(epoch from clock_timestamp()))::bigint-1))");
  const original=await read();c=original.contract;
  expect(await claim()).toEqual({status:"reconciliation_required",operation:original});
});
test.each(["owner","context"])("a foreign %s cannot recover, stop or bind an operation",async issue=>{
  await prepare();await claim();
  await expect(rpc("read_server_payment_intent_v1",[],issue==="owner"?id(20):id(2),issue==="context"?{...context,mode:"live"}:context))
    .rejects.toThrow("Owned");
});
test.each(["confirm","fee","destination","metadata","payment details"])("create request %s tampering is rejected",async issue=>{
  await prepare();const params=request.params as any;
  if(issue==="confirm")params.confirm=true;
  if(issue==="fee")params.application_fee_amount++;
  if(issue==="destination")params.transfer_data.destination="acct_other";
  if(issue==="metadata")params.metadata.buyer_id=id(20);
  if(issue==="payment details")params.payment_method="pm_injected";
  await expect(claim()).rejects.toThrow("Only the original");
});
test.each(["amount","order","consent","fees","creator"])("changed full %s cannot authorize an intent",async issue=>{
  await prepare();
  if(issue==="amount")c={...c,amountCents:3334};
  if(issue==="order")await db.exec("update orders set status='paid'");
  if(issue==="consent")await db.exec("update product_purchase_consents_v1 set terms='{}'");
  if(issue==="fees")await db.exec("update orders set platform_fee=0");
  if(issue==="creator")await db.exec("update profiles set stripe_onboarding_complete=false");
  await expect(claim()).rejects.toThrow();
});
test.each(["missing hold","live hold lease","different subscription","different customer","receipt","activation"])
("installment %s blocks first-payment creation",async issue=>{
  await prepare("first_installment");
  if(issue==="missing hold")await db.exec("delete from buyer_mentorship_bootstrap_operations_v1 where step='subscription.hold'");
  if(issue==="live hold lease")await db.exec("update buyer_mentorship_bootstrap_operations_v1 set lease_until=clock_timestamp()+interval '1 minute'");
  if(issue==="different subscription")await db.exec("update buyer_mentorship_bootstrap_operations_v1 set result_id='sub_other' where step='subscription.hold'");
  if(issue==="different customer")await db.exec("update buyer_mentorship_bootstraps_v1 set customer_id='cus_other'");
  if(issue==="receipt")await db.query("insert into buyer_mentorship_first_receipts_v1 values($1)",[id(9)]);
  if(issue==="activation")await db.query("insert into buyer_mentorship_activation_operations_v1 values($1)",[id(9)]);
  await expect(claim()).rejects.toThrow();
});
test.each(["mode","automatic","received money","card attached","prior charge","prior failure","wrong destination","wrong customer","old created","request id"])
("binding rejects %s evidence",async issue=>{
  await prepare();const op=(await claim()).operation,pi=provider(op) as any;
  if(issue==="mode")pi.livemode=true;
  if(issue==="automatic")pi.confirmation_method="automatic";
  if(issue==="received money")pi.amount_received=3333;
  if(issue==="card attached")pi.payment_method="pm_other";
  if(issue==="prior charge")pi.latest_charge="ch_other";
  if(issue==="prior failure")pi.last_payment_error={message:"fixture failure"};
  if(issue==="wrong destination")pi.transfer_data={destination:"acct_other"};
  if(issue==="wrong customer")pi.customer="cus_other";
  if(issue==="old created")pi.created-=60;
  await expect(bind(op,pi,issue==="request id"?"other":"req_owned")).rejects.toThrow("evidence differs");
});
test("service role cannot directly change durable requests, stops or provider identity",async()=>{
  await prepare();await claim();
  const rows=(await db.query(`select name,has_table_privilege('service_role',name,'INSERT') ins,
    has_table_privilege('service_role',name,'UPDATE') upd,has_table_privilege('service_role',name,'DELETE') del,
    has_table_privilege('authenticated',name,'SELECT') buyer
    from unnest(array['server_payment_stops_v1','server_payment_intent_operations_v1']) name`)).rows;
  expect(rows).toEqual(expect.arrayContaining([
    {name:"server_payment_stops_v1",ins:false,upd:false,del:false,buyer:false},
    {name:"server_payment_intent_operations_v1",ins:false,upd:false,del:false,buyer:false}]));
});

async function fullReceiptFixture(months?:number){
  await db.exec(`update product_purchase_consents_v1 set terms=terms||'{"currency":"usd"}'::jsonb`);
  await prepare();await installFullSource();
  if(months!==undefined){
    await db.query("update product_purchase_consents_v1 set terms=terms||$1::jsonb",[{serviceMonths:months,serviceVersion:"fixed-service-months-v1"}]);
    c={...c,sourceMetadata:{...c.sourceMetadata,fixed_service_version:"fixed-service-months-v1"}};request=serverPaymentCreateRequest(c,evidence);
  }
  await rpc("save_full_server_payment_contract_v1",[c,request]);
  const intent=(await claim()).operation;await bind(intent);
  const phase=(await rpc("claim_server_confirmation_v1",[tokenBasis(),{...provider(intent),next_action:null}])).operation;
  await observe(phase,"succeeded");
  for(const [file,name] of [["078-monthly-mentorship-receipts","valid_monthly_fee_snapshot_v1"],["096-independent-fixed-service","fixed_service_end_v1"]]){
    const source=readFileSync(`supabase/proposals/${file}.sql`,"utf8"),start=source.indexOf(`create function public.${name}(`);
    await db.exec(source.slice(start,source.indexOf("$$;",source.indexOf("as $$",start)+5)+3));
  }
  await db.exec(readFileSync("supabase/migrations/20260923013622_full_server_payment_receipt.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
  const proof:any={version:"full-server-payment-capture-v1",attemptId:id(1),buyerId:id(2),creatorId:id(3),productId:id(4),postId:id(5),
    orderId:id(7),purchaseConsentId:id(8),termsFingerprint:fingerprint,context,confirmationOperationId:phase.operation_id,
    checkoutSessionId:null,customerId:null,paymentIntentId:"pi_owned",destinationId:"acct_creator",amountCents:3333,fees,
    chargeId:"ch_owned",balanceTransactionId:"txn_owned",transferId:"tr_owned",paymentMethodId:"pm_owned",actualStripeFeeCents:127,
    paidAt:Math.floor(Date.now()/1000),buyerCountry:"US",serviceEndsAt:null};
  if(months!==undefined)proof.serviceEndsAt=Number((await db.query<{v:number}>("select fixed_service_end_v1($1,$2) v",[proof.paidAt,months])).rows[0].v);
  return {proof,phase};
}
const recordFull=(proof:unknown,buyer=id(2),ctx:object=context)=>rpc("record_full_server_payment_receipt_v1",[proof],buyer,ctx);
test("full capture records once, blocks dispatch and preserves stops without granting purchase access",async()=>{
  const {proof}=await fullReceiptFixture();await stop();await db.exec("set local role service_role");
  expect(await recordFull(proof)).toEqual({recorded:true,attemptId:id(1),paymentIntentId:"pi_owned",accountingRequired:true});
  expect(await recordFull(proof)).toMatchObject({recorded:false,accountingRequired:true});
  expect((await db.query("select count(*)::int n from full_server_payment_receipts_v1")).rows).toEqual([{n:1}]);
  expect((await db.query("select count(*)::int n from server_payment_stops_v1")).rows).toEqual([{n:1}]);
  await db.exec("reset role");expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:0}]);
});
test("saved full receipt independently blocks admission before a purchase exists",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);
  await expect(rpc("read_server_payment_source_v1",[true])).rejects.toThrow("already captured");
});
test.each(["foreign buyer","foreign context","wrong consent","wrong amount","wrong fee","wrong schedule","wrong charge","wrong method",
  "wrong phase","future capture","old capture","wrong expiry","session fabrication","missing null customer","unknown field","wrong service end","changed replay"])
("full receipt rejects %s",async issue=>{
  const {proof}=await fullReceiptFixture();
  if(issue==="changed replay"){await recordFull(proof);proof.actualStripeFeeCents++;}
  if(issue==="wrong consent")proof.purchaseConsentId=id(90);
  if(issue==="wrong amount")proof.amountCents++;
  if(issue==="wrong fee")proof.fees={...proof.fees,creatorNetCents:1};
  if(issue==="wrong schedule")proof.fees={...proof.fees,feeScheduleVersion:"other"};
  if(issue==="wrong charge")proof.chargeId="ch_other";
  if(issue==="wrong method")proof.paymentMethodId="pm_other";
  if(issue==="wrong phase")proof.confirmationOperationId=id(90);
  if(issue==="future capture")proof.paidAt+=100;
  if(issue==="old capture")proof.paidAt=c.acceptedAt-10;
  if(issue==="wrong expiry")proof.paidAt=c.expiresAt+1;
  if(issue==="session fabrication")proof.checkoutSessionId="cs_fake";
  if(issue==="missing null customer")delete proof.customerId;
  if(issue==="unknown field")proof.client_secret="must-not-store";
  if(issue==="wrong service end")proof.serviceEndsAt=proof.paidAt+86400;
  await expect(recordFull(proof,issue==="foreign buyer"?id(90):id(2),issue==="foreign context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
test.each(["anon","authenticated"])("%s cannot record full capture",async role=>{
  const {proof}=await fullReceiptFixture();await db.exec(`set local role ${role}`);await expect(recordFull(proof)).rejects.toThrow("permission denied");
});
test.each(["insert","update","delete"])("service role cannot directly %s a full receipt",async kind=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await db.exec("set local role service_role");
  const sql=kind==="insert"?"insert into full_server_payment_receipts_v1 select * from full_server_payment_receipts_v1":
    kind==="update"?"update full_server_payment_receipts_v1 set proof='{}'":"delete from full_server_payment_receipts_v1";
  await expect(db.exec(sql)).rejects.toThrow("permission denied");
});

test("full receipt preserves the accepted service duration independently of installment counts",async()=>{
  const {proof}=await fullReceiptFixture(36);expect(await recordFull(proof)).toMatchObject({recorded:true});
  expect((await db.query<{p:any}>("select proof p from full_server_payment_receipts_v1")).rows[0].p.serviceEndsAt).toBe(proof.serviceEndsAt);
});

async function installFullAccounting(){
  await db.exec(`alter table purchases add column id uuid primary key default gen_random_uuid(),add column buyer_user_id uuid,
    add column creator_id uuid,add column order_id uuid,add column amount_cents bigint,add column currency text,add column status text,
    add column title text,add column session_id text,add column subscription_id text,add column payment_intent_id text,
    add column paid_at timestamptz,add column access_granted boolean default false,add column fixed_service_consent_id uuid,
    add column earnings_credited_at timestamptz,add column earnings_credited_cents integer,add column is_refund boolean default false,
    add column is_suspect boolean default false;
    alter table profiles add column total_earnings_cents bigint default 0;
    create table posts(id uuid primary key,purchase_count integer default 0);
    alter table orders add column stripe_checkout_session_id text,add column stripe_payment_intent_id text,add column stripe_payment_id text,
      add column stripe_charge_id text,add column stripe_balance_transaction_id text,add column actual_stripe_fee bigint,
      add column processing_fee_variance bigint,add column updated_at timestamptz;
    alter table product_purchase_consents_v1 add column buyer_id uuid,add column creator_id uuid,add column product_id uuid,add column post_id uuid;
    update product_purchase_consents_v1 set buyer_id=(terms->>'buyerId')::uuid,creator_id=(terms->>'creatorId')::uuid,
      product_id=(terms->>'productId')::uuid,post_id=(terms->>'postId')::uuid;
    create view product_checkout_records_v1 as select * from product_checkout_attempts;
    create table payment_fee_ledger(id uuid primary key,creator_id uuid,purchase_id uuid,order_id uuid,stripe_payment_intent_id text unique,
      stripe_charge_id text unique,stripe_balance_transaction_id text,gross_amount_cents bigint,platform_fee_cents bigint,processing_fee_cents bigint,
      total_creator_deduction_cents bigint,creator_net_cents bigint,actual_stripe_fee_cents bigint,processing_fee_variance_cents bigint,
      currency text,fee_schedule_version text,status text,refunded_amount_cents bigint default 0,earnings_reversed_cents bigint default 0,dispute_status text);
    create table fixed_purchase_service_contracts_v1(purchase_id uuid primary key,consent_id uuid,payment_intent_id text,charge_id text,
      version text,service_months integer,service_start_at bigint,service_end_at bigint,financial_access boolean,access_updated_at timestamptz);
    create table payment_refund_state(stripe_payment_intent_id text,stripe_charge_id text,charge_amount_cents bigint,refunded_amount_cents bigint);
    create table payment_dispute_state(stripe_payment_intent_id text,status text);
    create table refund_operations(stripe_payment_intent_id text,status text);`);
  await db.query("insert into posts(id) values($1)",[id(5)]);
  const source=readFileSync("supabase/proposals/097-fixed-service-one-time.sql","utf8");
  for(const name of ["attach_fixed_service_consent_v1","bind_fixed_service_one_time_v1","mask_fixed_service_access_v1"]){
    let start=source.indexOf(`create function public.${name}(`);
    if(start<0)start=source.indexOf(`create or replace function public.${name}(`);
    await db.exec(source.slice(start,source.indexOf("$$;",source.indexOf("as $$",start)+5)+3)
      .replaceAll("from public.product_checkout_attempts attempt","from public.product_checkout_records_v1 attempt"));
  }
  await db.exec(`create trigger attach_fixed_service_consent_v1 before insert or update on purchases for each row execute function attach_fixed_service_consent_v1();
    create trigger fixed_service_access_v1 before insert or update of access_granted on purchases for each row execute function mask_fixed_service_access_v1();`);
  await db.exec(readFileSync("test-support/staging-one-time-earnings.sql","utf8"));
  for(const name of ["20260923014620_full_server_payment_service_binding","20260923015224_full_server_payment_accounting"])
    await db.exec(readFileSync(`supabase/migrations/${name}.sql`,"utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
}
const accountFull=()=>rpc("account_full_server_payment_receipt_v1");

async function installFullRefund(){
  await db.exec(`alter table purchases add column refunded_amount_cents bigint default 0,add column earnings_reversed_cents bigint default 0,
    add column platform_fee_cents bigint,add column processing_fee_cents bigint,
    add column platform_fee_refund_attribution_cents bigint,add column processing_fee_refund_attribution_cents bigint,
    add column refund_allocation_rounding_cents bigint;
    alter table orders add column refunded_amount bigint default 0;
    alter table payment_fee_ledger add column earnings_credited_at timestamptz,add column updated_at timestamptz,
    add column platform_fee_refund_attribution_cents bigint,add column processing_fee_refund_attribution_cents bigint,
    add column refund_allocation_rounding_cents bigint;
    alter table payment_refund_state add primary key(stripe_payment_intent_id),add column updated_at timestamptz;`);
  const source=readFileSync("supabase/schema/019-creator-processing-fees.sql","utf8");
  for(const name of ["record_payment_refund_state","apply_purchase_refund_earnings","apply_payment_fee_ledger_refund"]){
    const start=source.indexOf(`create or replace function public.${name}(`);
    expect(start).toBeGreaterThan(-1);
    await db.exec(source.slice(start,source.indexOf("$$;",source.indexOf("as $$",start)+5)+3));
  }
  await db.exec(readFileSync("supabase/migrations/20260923023550_full_server_payment_refund.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
}
const refundFull=(proof:unknown,amount:number,event="evt_refund",buyer=id(2),ctx:object=context)=>
  rpc("apply_full_server_payment_refund_v1",[event,proof,amount],buyer,ctx);

async function installFullDispute(){
  await installFullRefund();
  await db.exec(`alter table payment_dispute_state add column stripe_dispute_id text primary key,add column stripe_charge_id text,
    add column disputed_amount_cents bigint,add column currency text,add column stripe_event_created bigint,
    add column created_at timestamptz default now(),add column updated_at timestamptz default now();
    alter table payment_fee_ledger add column stripe_dispute_id text,add column disputed_amount_cents bigint;`);
  const source=readFileSync("supabase/schema/019-creator-processing-fees.sql","utf8"),start=source.indexOf("create or replace function public.record_payment_dispute_state(");
  await db.exec(source.slice(start,source.indexOf("$$;",source.indexOf("as $$",start)+5)+3));
  await db.exec(readFileSync("supabase/migrations/20260923024924_full_server_payment_dispute.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
}
const holdFullDispute=(event="evt_dispute",dispute="du_owned")=>rpc("hold_full_server_payment_dispute_v1",[event,dispute,"pi_owned","ch_owned"]);
const applyFullDispute=(proof:any,basis:unknown,status="needs_response",event="evt_dispute",dispute="du_owned")=>
  rpc("apply_full_server_payment_dispute_v1",[event,dispute,proof,basis,1000,status,proof.paidAt]);

async function installFinancialAccounting(){
  await installFullDispute();
  await db.exec(readFileSync("supabase/migrations/20260923030101_full_server_financial_accounting.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
}
const accountFinancial=(event="evt_refund",kind="refund")=>rpc("account_full_server_financial_receipt_v1",[event,kind]);

async function installCombinedFinancial(){
  await installFinancialAccounting();
  await db.exec(readFileSync("supabase/migrations/20260923031139_full_server_combined_financial.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
}
const applyCombinedDispute=(proof:any,basis:unknown,refunded=1000)=>rpc("apply_full_server_payment_financial_dispute_v1",
  ["evt_dispute","du_owned",proof,basis,1000,"needs_response",proof.paidAt,refunded]);

async function refundObjectFixture(accounted=false){
  const {proof}=await fullReceiptFixture(36);await recordFull(proof);await installFullAccounting();await installCombinedFinancial();
  await db.exec(readFileSync("supabase/migrations/20260923033818_full_server_refund_observations.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
  if(accounted)await accountFull();return proof;
}
const holdRefundObject=(event="evt_object")=>rpc("hold_full_server_payment_refund_object_v1",[event,"re_owned","pi_owned","ch_owned"]);
async function installRefundEventProvenance(){
  await db.exec(readFileSync("supabase/migrations/20260923064622_full_refund_event_provenance.sql","utf8").replace(/^begin;/," ").replace(/commit;\s*$/," "));
}
const holdRefundEvent=(created:number,event="evt_object",buyer=id(2),ctx:object=context)=>
  rpc("hold_full_server_refund_event_v1",[event,"re_owned","pi_owned","ch_owned",created],buyer,ctx);

test("Refund event provenance persists before readback, replay is immutable and original accounting retains the hold",async()=>{
  const proof=await refundObjectFixture(true);await installRefundEventProvenance();
  await db.exec("set local role service_role");
  const basis=await holdRefundEvent(proof.paidAt);expect(basis.revision).toBe(2);
  expect(await holdRefundEvent(proof.paidAt)).toEqual(basis);
  await db.exec("reset role");
  expect((await db.query("select event_created,details from full_server_payment_refund_object_events_v1")).rows).toEqual([{event_created:proof.paidAt,details:null}]);
  expect((await db.query("select count(*)::int n from full_server_payment_refund_observations_v1")).rows).toEqual([{n:0}]);
  expect(await applyRefundObject(proof,basis,refundObservation(proof,"succeeded"),1000)).toMatchObject({refundApplied:true});
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  expect((await db.query("select count(*)::int n from full_server_payment_financial_holds_v1")).rows).toEqual([{n:1}]);
});
test.each(["changed timestamp","changed details","changed observation","clear timestamp"])("Refund event provenance rejects %s without losing original hold",async issue=>{
  const proof=await refundObjectFixture(true);await installRefundEventProvenance();const basis=await holdRefundEvent(proof.paidAt);
  await db.exec("savepoint invalid_event_provenance");
  if(issue==="changed timestamp")await expect(holdRefundEvent(proof.paidAt-1)).rejects.toThrow("time differs");
  if(issue==="changed details")await expect(db.query("update full_server_payment_refund_object_events_v1 set details=$1",[{eventCreated:proof.paidAt-1}])).rejects.toThrow("details differ");
  if(issue==="changed observation")await expect(applyRefundObject(proof,basis,{...refundObservation(proof),eventCreated:proof.paidAt+1})).rejects.toThrow();
  if(issue==="clear timestamp")await expect(db.exec("update full_server_payment_refund_object_events_v1 set event_created=null")).rejects.toThrow("immutable");
  await db.exec("rollback to savepoint invalid_event_provenance");
  expect(await holdRefundEvent(proof.paidAt)).toEqual(basis);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
});
test("Refund event provenance leaves legacy incomplete events missing until the original timestamp is supplied",async()=>{
  const proof=await refundObjectFixture(true);await holdRefundObject();await installRefundEventProvenance();
  expect((await db.query("select event_created from full_server_payment_refund_object_events_v1")).rows).toEqual([{event_created:null}]);
  await db.exec("savepoint missing_event_provenance");
  await expect(applyRefundObject(proof,await holdRefundObject())).rejects.toThrow("Bound original refund event time required");
  await db.exec("rollback to savepoint missing_event_provenance");
  const basis=await holdRefundEvent(proof.paidAt);
  expect(await applyRefundObject(proof,basis)).toMatchObject({status:"refund_observed"});
});
test("Refund event provenance binding validates older observation history and invalidates older bases",async()=>{
  const proof=await refundObjectFixture(true);await applyRefundObject(proof,await holdRefundObject());
  await installRefundEventProvenance();const previous=await holdRefundObject();
  await db.exec("savepoint conflicting_history");await expect(holdRefundEvent(proof.paidAt-1)).rejects.toThrow("time differs");
  await db.exec("rollback to savepoint conflicting_history");
  const basis=await holdRefundEvent(proof.paidAt);expect(basis.revision).toBe(previous.revision+1);
  expect(await applyRefundObject(proof,previous)).toEqual({status:"reconciliation_required"});
  expect(await applyRefundObject(proof,basis)).toMatchObject({status:"refund_observed"});
});
test.each(["foreign buyer","foreign context","future","zero","null","anon","authenticated"])("Refund event provenance rejects %s",async issue=>{
  const proof=await refundObjectFixture();await installRefundEventProvenance();
  if(issue==="anon"||issue==="authenticated")await db.exec(`set local role ${issue}`);
  await expect(holdRefundEvent(issue==="future"?Math.floor(Date.now()/1000)+1000:issue==="zero"?0:issue==="null"?null as any:proof.paidAt,
    "evt_object",issue==="foreign buyer"?id(90):id(2),issue==="foreign context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
const refundObservation=(proof:any,status="pending",event="evt_object")=>({version:"full-server-refund-observation-v1",eventId:event,
  eventCreated:proof.paidAt,attemptId:id(1),paymentIntentId:"pi_owned",chargeId:"ch_owned",refundId:"re_owned",amountCents:1000,
  currency:"usd",created:proof.paidAt,status,balanceTransactionId:null as string|null,failureBalanceTransactionId:null as string|null,
  failureReason:null as string|null,pendingReason:null as string|null});
const applyRefundObject=(proof:any,basis:unknown,observation=refundObservation(proof),amount=0,total:number|null=observation.status==="succeeded"?amount:null)=>
  rpc("apply_full_server_payment_refund_object_v1",[observation.eventId,"re_owned",proof,basis,observation,amount,total]);

test.each(["pending","requires_action","failed","canceled","succeeded"])("Refund object %s before accounting preserves real capture under hold",async status=>{
  const proof=await refundObjectFixture(),amount=status==="succeeded"?1000:0;
  await db.exec("set local role service_role");
  expect(await applyRefundObject(proof,await holdRefundObject(),refundObservation(proof,status),amount)).toMatchObject({status:"refund_recorded_accounting_review",refundApplied:status==="succeeded"});
  const first=await accountFinancial("evt_object","refund_object");expect(first).toMatchObject({accounted:true,refundedCents:amount});
  expect(await accountFinancial("evt_object","refund_object")).toMatchObject({accounted:false});await db.exec("reset role");
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents-Math.round(fees.creatorNetCents*amount/3333)}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:false}]);
  expect((await db.query("select count(*)::int n from full_server_payment_refund_observations_v1")).rows).toEqual([{n:1}]);
  expect((await db.query("select count(*)::int n from payment_dispute_state")).rows).toEqual([{n:0}]);
});
test("Refund object pending to success accounts cumulative refund once and preserves both observations",async()=>{
  const proof=await refundObjectFixture(true);
  expect(await applyRefundObject(proof,await holdRefundObject())).toMatchObject({status:"refund_observed",refundApplied:false});
  expect(await applyRefundObject(proof,await holdRefundObject(),refundObservation(proof,"succeeded"),1000)).toMatchObject({status:"refund_observed",refundApplied:true});
  await applyRefundObject(proof,await holdRefundObject(),refundObservation(proof,"succeeded"),1000);
  expect((await db.query("select count(*)::int n from full_server_payment_refund_observations_v1")).rows).toEqual([{n:2}]);
  expect((await db.query("select observation_kind from full_server_payment_refund_events_v1")).rows).toEqual([{observation_kind:"refund_object_readback"}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents-Math.round(fees.creatorNetCents*1000/3333)}]);
});
test("Refund object failed after success preserves audit and reversal without recredit or restored access",async()=>{
  const proof=await refundObjectFixture(true);
  await applyRefundObject(proof,await holdRefundObject(),refundObservation(proof,"succeeded"),1000);
  const failed={...refundObservation(proof,"failed"),failureReason:"unknown",failureBalanceTransactionId:"txn_returned"};
  expect(await applyRefundObject(proof,await holdRefundObject(),failed,0)).toMatchObject({status:"refund_review_recorded",refundApplied:false});
  await accountFull();expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  expect((await db.query("select refunded_amount_cents::int n from payment_fee_ledger")).rows).toEqual([{n:1000}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents-Math.round(fees.creatorNetCents*1000/3333)}]);
  expect((await db.query("select count(*)::int n from full_server_payment_refund_observations_v1")).rows).toEqual([{n:2}]);
});
test("Refund object stale basis preserves the pre-read hold without applying stale observation",async()=>{
  const proof=await refundObjectFixture(true),basis=await holdRefundObject();await holdFullDispute();
  expect(await applyRefundObject(proof,basis)).toEqual({status:"reconciliation_required"});
  expect((await db.query("select count(*)::int n from full_server_payment_refund_observations_v1")).rows).toEqual([{n:0}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
});
test.each(["amount","identity","timestamp","private field","status","balance","reason","fractional date","coerced amount"])
("Refund object invalid %s cannot be persisted",async issue=>{
  const proof=await refundObjectFixture(true),basis=await holdRefundObject(),o:any=refundObservation(proof);
  if(issue==="amount")o.amountCents=3334;if(issue==="identity")o.refundId="re_other";
  if(issue==="timestamp")o.created--;if(issue==="private field")o.email="must not persist";
  if(issue==="status")o.status="unknown";if(issue==="balance")o.balanceTransactionId="bad";
  if(issue==="reason")o.pendingReason={secret:"bad"};if(issue==="fractional date")o.created+=0.5;
  if(issue==="coerced amount")o.amountCents="1000";
  await expect(applyRefundObject(proof,basis,o)).rejects.toThrow();
});
test("Refund object original amount cannot change across event IDs",async()=>{
  const proof=await refundObjectFixture(true);await applyRefundObject(proof,await holdRefundObject());
  const next={...refundObservation(proof,"pending","evt_next"),amountCents:500};
  await expect(applyRefundObject(proof,await holdRefundObject("evt_next"),next)).rejects.toThrow("history differs");
});
test("Refund object accounting refuses a held but unverified event",async()=>{
  await refundObjectFixture();await holdRefundObject();await expect(accountFinancial("evt_object","refund_object")).rejects.toThrow("Applied original Refund observation required");
});
test.each([["anon","hold"],["authenticated","hold"],["anon","apply"],["authenticated","apply"]])("Refund object %s cannot %s an observation",async(role,operation)=>{
  const proof=await refundObjectFixture(),basis=await holdRefundObject();await db.exec(`set local role ${role}`);
  await expect(operation==="hold"?holdRefundObject():applyRefundObject(proof,basis)).rejects.toThrow("permission denied");
});
test("Refund object service role cannot rewrite observation history",async()=>{
  const proof=await refundObjectFixture(true);await applyRefundObject(proof,await holdRefundObject());await db.exec("set local role service_role");
  await expect(db.exec("delete from full_server_payment_refund_observations_v1")).rejects.toThrow("permission denied");
});
test.each([null,500])("Refund object succeeded total %s cannot reverse unproved cumulative money",async total=>{
  const proof=await refundObjectFixture(true);
  expect(await applyRefundObject(proof,await holdRefundObject(),refundObservation(proof,"succeeded"),1000,total))
    .toMatchObject({status:"refund_review_recorded",refundApplied:false});
  expect((await db.query("select refunded_amount_cents::int n from payment_fee_ledger")).rows).toEqual([{n:0}]);
  expect((await db.query("select financial_evidence->>'chargeRefundedCents' n,financial_evidence->>'succeededRefundTotal' t from full_server_payment_refund_observations_v1")).rows)
    .toEqual([{n:"1000",t:total===null?null:"500"}]);
});
test("Refund object accounting failure rolls back observation and reversal while retaining earlier hold",async()=>{
  const proof=await refundObjectFixture(true),basis=await holdRefundObject();
  await db.exec("create or replace function apply_payment_fee_ledger_refund(p_ledger_id uuid,p_refunded_gross_cents bigint) returns bigint language plpgsql as $$begin raise exception 'fixture failure';end$$");
  await db.exec("savepoint refund_object_failed");
  await expect(applyRefundObject(proof,basis,refundObservation(proof,"succeeded"),1000)).rejects.toThrow("fixture failure");
  await db.exec("rollback to savepoint refund_object_failed");
  expect((await db.query("select count(*)::int n from full_server_payment_refund_observations_v1")).rows).toEqual([{n:0}]);
  expect((await db.query("select count(*)::int n from payment_refund_state")).rows).toEqual([{n:0}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents}]);
});
test("Refund object stale cumulative refund basis cannot overwrite a newer charge observation",async()=>{
  const proof=await refundObjectFixture(true),basis=await holdRefundObject();await refundFull(proof,1000,"evt_charge");
  expect(await applyRefundObject(proof,basis)).toEqual({status:"reconciliation_required"});
  expect((await db.query("select count(*)::int n from full_server_payment_refund_observations_v1")).rows).toEqual([{n:0}]);
});
test.each(["refund","dispute"])("Refund object migration preserves original %s financial admission",async kind=>{
  const proof=await refundObjectFixture();
  if(kind==="refund")await refundFull(proof,1000,"evt_original");
  else await applyFullDispute(proof,await holdFullDispute("evt_original"),"needs_response","evt_original");
  expect(await accountFinancial("evt_original",kind)).toMatchObject({status:"original_financial_capture_accounted",accounted:true});
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
});

test.each([[false,1000],[false,3333],[true,1000],[true,3333]])("combined financial observation is atomic with prior accounting %s and refund %s",async(accounted,amount)=>{
  const {proof}=await fullReceiptFixture(36);await recordFull(proof);await installFullAccounting();await installCombinedFinancial();
  if(accounted)await accountFull();
  expect(await applyCombinedDispute(proof,await holdFullDispute(),Number(amount))).toBe(accounted?"dispute_observed":"dispute_recorded_accounting_review");
  if(!accounted)await accountFinancial("evt_dispute","dispute");
  expect(await applyCombinedDispute(proof,await holdFullDispute(),Number(amount))).toBe("dispute_observed");
  expect((await db.query("select refunded_amount_cents::int n,dispute_status from payment_fee_ledger")).rows).toEqual([{n:amount,dispute_status:"needs_response"}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents-Math.round(fees.creatorNetCents*Number(amount)/3333)}]);
  expect((await db.query("select observation_kind from full_server_payment_refund_events_v1")).rows).toEqual([{observation_kind:"dispute_charge_readback"}]);
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:false}]);
});
test("refund signal holds access before a separate dispute identity is known",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installCombinedFinancial();await accountFull();
  expect(await rpc("apply_full_server_payment_refund_signal_v1",["evt_refund",proof,1000,true])).toMatchObject({status:"original_refund_applied"});
  expect((await db.query("select count(*)::int n from payment_dispute_state")).rows).toEqual([{n:0}]);
  expect((await db.query("select count(*)::int n from full_server_payment_financial_holds_v1")).rows).toEqual([{n:1}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
});
test("combined application failure rolls back both outcomes while retaining the earlier dispute hold",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installCombinedFinancial();await accountFull();
  const basis=await holdFullDispute();
  await db.exec("create or replace function apply_payment_fee_ledger_refund(p_ledger_id uuid,p_refunded_gross_cents bigint) returns bigint language plpgsql as $$begin raise exception 'fixture failure';end$$");
  await db.exec("savepoint combined_failed");await expect(applyCombinedDispute(proof,basis)).rejects.toThrow("fixture failure");await db.exec("rollback to savepoint combined_failed");
  expect((await db.query("select count(*)::int n from payment_dispute_state")).rows).toEqual([{n:0}]);
  expect((await db.query("select count(*)::int n from payment_refund_state")).rows).toEqual([{n:0}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
});
test("combined stale basis cannot record a refund or overwrite newer dispute state",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installCombinedFinancial();await accountFull();
  const basis=await holdFullDispute();await holdFullDispute("evt_other");
  expect(await applyCombinedDispute(proof,basis)).toBe("reconciliation_required");
  expect((await db.query("select count(*)::int n from payment_refund_state")).rows).toEqual([{n:0}]);
});
test("refund failure retains the separately established dispute signal hold",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installCombinedFinancial();await accountFull();
  expect(await rpc("hold_full_server_payment_financial_signal_v1",[proof])).toMatchObject({financialHold:true});
  await db.exec("create or replace function apply_payment_fee_ledger_refund(p_ledger_id uuid,p_refunded_gross_cents bigint) returns bigint language plpgsql as $$begin raise exception 'fixture failure';end$$");
  await db.exec("savepoint held_refund");
  await expect(rpc("apply_full_server_payment_refund_signal_v1",["evt_refund",proof,1000,true])).rejects.toThrow("fixture failure");
  await db.exec("rollback to savepoint held_refund");
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  expect((await db.query("select count(*)::int n from full_server_payment_financial_holds_v1")).rows).toEqual([{n:1}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents}]);
});
test("combined observation cannot relabel an existing refund event as dispute readback",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installCombinedFinancial();await accountFull();
  await refundFull(proof,1,"evt_dispute");const basis=await holdFullDispute();
  await db.exec("savepoint provenance");await expect(applyCombinedDispute(proof,basis)).rejects.toThrow("provenance differs");await db.exec("rollback to savepoint provenance");
  expect((await db.query("select observation_kind from full_server_payment_refund_events_v1")).rows).toEqual([{observation_kind:"charge.refunded"}]);
  expect((await db.query("select count(*)::int n from payment_dispute_state")).rows).toEqual([{n:0}]);
});

test.each([[undefined,1000],[undefined,3333],[36,1000],[36,3333]])("early refund accounts original capture and reversal atomically, months %s refunded %s",async(months,amount)=>{
  const {proof}=await fullReceiptFixture(months);await installFullAccounting();await installFinancialAccounting();
  expect(await refundFull(proof,amount!)).toMatchObject({status:"refund_recorded_accounting_review"});
  await db.exec("savepoint clean_rejected");await expect(accountFull()).rejects.toThrow("financial reconciliation");await db.exec("rollback to savepoint clean_rejected");
  await stop();await db.exec("set local role service_role");
  const first=await accountFinancial();expect(first).toMatchObject({status:"original_financial_capture_accounted",accounted:true,refundedCents:amount});
  expect(await accountFinancial()).toMatchObject({...first,accounted:false});await db.exec("reset role");
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents-Math.round(fees.creatorNetCents*amount!/3333)}]);
  expect((await db.query("select status,access_granted from purchases")).rows).toEqual([{status:amount===3333?"refunded":"paid",access_granted:false}]);
  expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:1}]);
  expect((await db.query("select refunded_amount_cents::int n from payment_fee_ledger")).rows).toEqual([{n:amount}]);
  if(months)expect((await db.query("select service_end_at::text n,financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{n:String(proof.serviceEndsAt),financial_access:false}]);
  expect((await db.query("select count(*)::int n from server_payment_stops_v1")).rows).toEqual([{n:1}]);
  expect(await accountFull()).toMatchObject({accounted:false,purchaseId:first.purchaseId});
});

test.each(["needs_response","won"])("early %s dispute accounts original money without inventing a creator debit or access",async status=>{
  const {proof}=await fullReceiptFixture(36);await installFullAccounting();await installFinancialAccounting();
  expect(await applyFullDispute(proof,await holdFullDispute(),status)).toBe("dispute_recorded_accounting_review");
  expect(await accountFinancial("evt_dispute","dispute")).toMatchObject({status:"original_financial_capture_accounted",accounted:true,disputeDisposition:"dispute_observed"});
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents}]);
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:false}]);
  expect((await db.query("select dispute_status from payment_fee_ledger")).rows).toEqual([{dispute_status:status}]);
});

test("saved refund and dispute both survive initial financial accounting and stale success",async()=>{
  const {proof}=await fullReceiptFixture(36);await installFullAccounting();await installFinancialAccounting();
  await refundFull(proof,1000);await applyFullDispute(proof,await holdFullDispute());
  const first=await accountFinancial("evt_dispute","dispute");
  expect(await accountFull()).toMatchObject({accounted:false,purchaseId:first.purchaseId});
  expect((await db.query("select refunded_amount_cents::int n,dispute_status from payment_fee_ledger")).rows).toEqual([{n:1000,dispute_status:"needs_response"}]);
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:false}]);
});

test("financial accounting failure rolls back purchase and credit while retaining earlier refund evidence",async()=>{
  const {proof}=await fullReceiptFixture(36);await installFullAccounting();await installFinancialAccounting();await refundFull(proof,3333);
  await db.exec("create or replace function apply_payment_fee_ledger_refund(p_ledger_id uuid,p_refunded_gross_cents bigint) returns bigint language plpgsql as $$begin raise exception 'fixture failure';end$$");
  await db.exec("savepoint atomic_financial");await expect(accountFinancial()).rejects.toThrow("fixture failure");await db.exec("rollback to savepoint atomic_financial");
  expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:0}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:0}]);
  expect((await db.query("select accounted_at from full_server_payment_receipts_v1")).rows).toEqual([{accounted_at:null}]);
  expect((await db.query("select refunded_amount_cents::int n from payment_refund_state")).rows).toEqual([{n:3333}]);
});

test("financial accounting requires an owned applied observation, not merely a clean capture or an unverified dispute hold",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installFinancialAccounting();
  await holdFullDispute();await expect(accountFinancial("evt_dispute","dispute")).rejects.toThrow("Applied original dispute observation required");
});

test("public clean accounting still works through the shared private engine",async()=>{
  const {proof}=await fullReceiptFixture(36);await recordFull(proof);await installFullAccounting();await installFinancialAccounting();
  expect(await accountFull()).toMatchObject({accounted:true});
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:true}]);
});

test("financial-accounting replay after cleared credit claim does not recredit or restore access",async()=>{
  const {proof}=await fullReceiptFixture(36);await recordFull(proof);await installFullAccounting();await installFinancialAccounting();
  const first=await accountFull();await db.query("select reverse_purchase_earnings($1)",[first.purchaseId]);
  await db.exec("update purchases set status='refunded',access_granted=false");
  await refundFull(proof,3333);expect(await accountFinancial()).toMatchObject({accounted:false,purchaseId:first.purchaseId});
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:0}]);
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:false}]);
});

test.each(["anon","authenticated","service_role"])("%s cannot call the permissive private accounting engine",async role=>{
  await fullReceiptFixture();await installFullAccounting();await installFinancialAccounting();await db.exec(`set local role ${role}`);
  await expect(rpc("account_full_server_payment_receipt_core_v1",[true])).rejects.toThrow("permission denied");
});

test.each(["anon","authenticated"])("%s cannot call financial receipt accounting",async role=>{
  const {proof}=await fullReceiptFixture();await installFullAccounting();await installFinancialAccounting();await refundFull(proof,1);
  await db.exec(`set local role ${role}`);await expect(accountFinancial()).rejects.toThrow("permission denied");
});

test.each([undefined,36])("full dispute holds access without debiting earnings, including won and stale success, duration %s",async months=>{
  const {proof}=await fullReceiptFixture(months);await recordFull(proof);await installFullAccounting();await installFullDispute();
  const original=await accountFull();await db.exec("set local role service_role");
  const basis=await holdFullDispute();
  expect(await applyFullDispute(proof,basis)).toBe("dispute_observed");
  expect(await applyFullDispute(proof,await holdFullDispute("evt_won"),"won","evt_won")).toBe("dispute_observed");
  expect(await accountFull()).toEqual({...original,accounted:false});await db.exec("reset role");
  await db.exec("update purchases set access_granted=true");
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  if(months)expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:false}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents}]);
  expect((await db.query("select dispute_status from payment_fee_ledger")).rows).toEqual([{dispute_status:"won"}]);
  expect((await db.query("select count(*)::int n from full_server_payment_financial_holds_v1")).rows).toEqual([{n:1}]);
});

test("full dispute before any receipt blocks dispatch and first credit, retaining audit without inventing a purchase",async()=>{
  const {proof}=await fullReceiptFixture();await installFullAccounting();await installFullDispute();
  const basis=await holdFullDispute();
  await db.exec("savepoint dispatch_held");await expect(rpc("read_server_payment_source_v1",[true])).rejects.toThrow("financial hold");
  await db.exec("rollback to savepoint dispatch_held");
  expect(await applyFullDispute(proof,basis)).toBe("dispute_recorded_accounting_review");
  expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:0}]);
  expect((await db.query("select status from payment_dispute_state")).rows).toEqual([{status:"needs_response"}]);
  await expect(accountFull()).rejects.toThrow("financial reconciliation");
});

test.each(["another event","refund state","another application"])("full dispute rejects stale provider basis after %s",async issue=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installFullDispute();await accountFull();
  const basis=await holdFullDispute();
  if(issue==="another event")await holdFullDispute("evt_other");
  if(issue==="refund state")await refundFull(proof,1);
  if(issue==="another application")expect(await applyFullDispute(proof,basis)).toBe("dispute_observed");
  expect(await applyFullDispute(proof,basis,"won")).toBe("reconciliation_required");
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
});

test("terminal dispute conflict records review without replacing terminal evidence or releasing the hold",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installFullDispute();await accountFull();
  expect(await applyFullDispute(proof,await holdFullDispute(),"lost")).toBe("dispute_observed");
  expect(await applyFullDispute(proof,await holdFullDispute("evt_stale"),"needs_response","evt_stale")).toBe("dispute_review_recorded");
  expect((await db.query("select status from payment_dispute_state")).rows).toEqual([{status:"lost"}]);
  expect((await db.query("select dispute_status from payment_fee_ledger")).rows).toEqual([{dispute_status:"lost"}]);
});

test("failed dispute application preserves its previously established hold and rolls back its financial writes",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installFullDispute();await accountFull();
  const basis=await holdFullDispute();await db.exec("savepoint dispute_application");
  await expect(applyFullDispute({...proof,amountCents:1},basis)).rejects.toThrow();await db.exec("rollback to savepoint dispute_application");
  expect((await db.query("select count(*)::int n from payment_dispute_state")).rows).toEqual([{n:0}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  expect((await db.query("select applied_at from full_server_payment_dispute_events_v1")).rows).toEqual([{applied_at:null}]);
});

test.each(["zero amount","excess amount","unknown status","future event","foreign prior dispute"])("full dispute rejects %s without financial application",async issue=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installFullDispute();await accountFull();
  if(issue==="foreign prior dispute")await db.exec("insert into payment_dispute_state(stripe_dispute_id,stripe_payment_intent_id,stripe_charge_id,currency,status,stripe_event_created) values('du_owned','pi_other','ch_other','usd','needs_response',1)");
  const basis=await holdFullDispute();await db.exec("savepoint dispute_rejected");
  await expect(rpc("apply_full_server_payment_dispute_v1",["evt_dispute","du_owned",proof,basis,
    issue==="zero amount"?0:issue==="excess amount"?3334:1000,issue==="unknown status"?"invented":"needs_response",
    issue==="future event"?proof.paidAt+86400:proof.paidAt])).rejects.toThrow();
  await db.exec("rollback to savepoint dispute_rejected");
  expect((await db.query("select dispute_status from payment_fee_ledger")).rows).toEqual([{dispute_status:null}]);
  expect((await db.query("select access_granted from purchases")).rows).toEqual([{access_granted:false}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents}]);
});

test.each(["anon","authenticated"])("%s cannot establish a full dispute hold",async role=>{
  await fullReceiptFixture();await installFullAccounting();await installFullDispute();await db.exec(`set local role ${role}`);
  await expect(holdFullDispute()).rejects.toThrow("permission denied");
});

test.each([undefined,36])("full refund uses original reversal engines once with service duration %s",async months=>{
  const {proof}=await fullReceiptFixture(months);await recordFull(proof);await installFullAccounting();await installFullRefund();
  const original=await accountFull();await stop();await db.exec("set local role service_role");
  expect(await refundFull(proof,1000)).toMatchObject({status:"original_refund_applied",purchaseId:original.purchaseId,refundedCents:1000});
  await refundFull(proof,1000);await refundFull(proof,500,"evt_older");await db.exec("reset role");
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents-Math.round(fees.creatorNetCents*1000/3333)}]);
  expect((await db.query("select platform_fee_refund_attribution_cents::int n from purchases")).rows).toEqual([{n:Math.round(400*1000/3333)}]);
  expect((await db.query("select refunded_amount::int n from orders")).rows).toEqual([{n:1000}]);
  await refundFull(proof,3333,"evt_full");await refundFull(proof,3333,"evt_full");
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:0}]);
  expect((await db.query("select status,access_granted from purchases")).rows).toEqual([{status:"refunded",access_granted:false}]);
  expect((await db.query("select status from orders")).rows).toEqual([{status:"refunded"}]);
  expect(await accountFull()).toEqual({...original,accounted:false,purchaseStatus:"refunded"});
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:0}]);
  if(months)expect((await db.query("select financial_access,service_end_at::text n from fixed_purchase_service_contracts_v1")).rows)
    .toEqual([{financial_access:false,n:String(proof.serviceEndsAt)}]);
  expect((await db.query("select count(*)::int n from server_payment_stops_v1")).rows).toEqual([{n:1}]);
});

test("refund before first accounting records original money and prevents clean credit without manufacturing a purchase",async()=>{
  const {proof}=await fullReceiptFixture();await installFullAccounting();await installFullRefund();
  expect(await refundFull(proof,1000)).toMatchObject({status:"refund_recorded_accounting_review",refundedCents:1000});
  expect(await refundFull(proof,500)).toMatchObject({status:"refund_recorded_accounting_review",refundedCents:1000});
  expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:0}]);
  expect((await db.query("select count(*)::int n from full_server_payment_receipts_v1")).rows).toEqual([{n:1}]);
  expect((await db.query("select applied_at from full_server_payment_refund_events_v1")).rows).toEqual([{applied_at:null}]);
  await expect(accountFull()).rejects.toThrow("financial reconciliation");
});

test.each(["foreign proof","too much","zero","wrong buyer","wrong context","changed prior charge","changed order owner","changed purchase fee","double credit","reversal failure"])
("full refund rejects %s atomically",async issue=>{
  const {proof}=await fullReceiptFixture(36);await recordFull(proof);await installFullAccounting();await installFullRefund();await accountFull();
  if(issue==="foreign proof")proof.chargeId="ch_other";
  if(issue==="changed prior charge")await db.exec("insert into payment_refund_state values('pi_owned','ch_other',3333,1,null)");
  if(issue==="changed order owner")await db.query("update orders set buyer_id=$1",[id(90)]);
  if(issue==="changed purchase fee")await db.exec("update purchases set platform_fee_cents=1");
  if(issue==="double credit")await db.exec("update payment_fee_ledger set earnings_credited_at=now()");
  if(issue==="reversal failure")await db.exec("create or replace function apply_payment_fee_ledger_refund(p_ledger_id uuid,p_refunded_gross_cents bigint) returns bigint language plpgsql as $$begin raise exception 'fixture failure';end$$");
  await db.exec("savepoint rejected_refund");
  await expect(refundFull(proof,issue==="too much"?3334:issue==="zero"?0:1000,"evt_refund",issue==="wrong buyer"?id(90):id(2),
    issue==="wrong context"?{...context,mode:"live"}:context)).rejects.toThrow();
  await db.exec("rollback to savepoint rejected_refund");
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents}]);
  expect((await db.query("select count(*)::int n from full_server_payment_refund_events_v1")).rows).toEqual([{n:0}]);
  expect((await db.query("select refunded_amount::int n from orders")).rows).toEqual([{n:0}]);
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:true}]);
});

test.each(["anon","authenticated"])("%s cannot apply full refund observations",async role=>{
  const {proof}=await fullReceiptFixture();await installFullAccounting();await installFullRefund();await db.exec(`set local role ${role}`);
  await expect(refundFull(proof,1)).rejects.toThrow("permission denied");
});

test.each(["anon","authenticated","service_role"])("%s cannot bypass full refund validation with a direct observation insert",async role=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await installFullRefund();
  await db.exec(`set local role ${role}`);
  await expect(db.query("insert into full_server_payment_refund_events_v1(event_id,attempt_id,payment_intent_id,charge_id,observed_refunded_cents) values('evt_bad',$1,'pi_owned','ch_owned',1)",[id(1)]))
    .rejects.toThrow("permission denied");
});
test.each([undefined,36])("full accounting uses real source/receipt/credit/service SQL exactly once with duration %s",async months=>{
  const {proof}=await fullReceiptFixture(months);await recordFull(proof);await installFullAccounting();await stop();
  await db.exec("set local role service_role");const result=await accountFull();
  expect(result).toMatchObject({accounted:true,attemptId:id(1),purchaseStatus:"paid"});
  expect(await accountFull()).toEqual({...result,accounted:false});await db.exec("reset role");
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:fees.creatorNetCents}]);
  expect((await db.query("select purchase_count from posts")).rows).toEqual([{purchase_count:1}]);
  expect((await db.query("select status,session_id,access_granted from purchases")).rows)
    .toEqual([{status:"paid",session_id:null,access_granted:months===undefined}]);
  expect((await db.query("select status,stripe_payment_intent_id from orders")).rows).toEqual([{status:"paid",stripe_payment_intent_id:"pi_owned"}]);
  expect((await db.query("select count(*)::int n from server_payment_stops_v1")).rows).toEqual([{n:1}]);
  if(months)expect((await db.query("select service_months,financial_access from fixed_purchase_service_contracts_v1")).rows)
    .toEqual([{service_months:months,financial_access:true}]);
});
test("full accounting replay after reversal never recredits or restores service",async()=>{
  const {proof}=await fullReceiptFixture(36);await recordFull(proof);await installFullAccounting();const first=await accountFull();
  await db.query("select reverse_purchase_earnings($1)",[first.purchaseId]);
  await db.exec("update purchases set status='refunded',access_granted=false;update orders set status='refunded';update payment_fee_ledger set status='refunded',refunded_amount_cents=3333");
  expect(await accountFull()).toEqual({...first,accounted:false,purchaseStatus:"refunded"});
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:0}]);
  expect((await db.query("select financial_access from fixed_purchase_service_contracts_v1")).rows).toEqual([{financial_access:false}]);
});
test.each(["refund","dispute","pending refund","canceled order","wrong order fee","existing purchase","existing ledger","service failure"])
("%s prevents partial accounting or access",async issue=>{
  const {proof}=await fullReceiptFixture(36);await recordFull(proof);await installFullAccounting();
  if(issue==="refund")await db.exec("insert into payment_refund_state values('pi_owned','ch_owned',3333,1)");
  if(issue==="dispute")await db.exec("insert into payment_dispute_state values('pi_owned','needs_response')");
  if(issue==="pending refund")await db.exec("insert into refund_operations values('pi_owned','processing')");
  if(issue==="canceled order")await db.exec("update orders set status='canceled'");
  if(issue==="wrong order fee")await db.exec("update orders set creator_amount=1");
  if(issue==="existing purchase")await db.query("insert into purchases(buyer_id,product_id) values($1,$2)",[id(2),id(4)]);
  if(issue==="existing ledger")await db.query("insert into payment_fee_ledger(id,stripe_payment_intent_id) values($1,'pi_owned')",[id(90)]);
  if(issue==="service failure")await db.exec("create or replace function bind_fixed_service_one_time_v1(p_purchase_id uuid,p_consent_id uuid,p_attempt_key uuid,p_payment_intent_id text,p_charge_id text,p_captured_at bigint,p_amount_cents bigint,p_currency text) returns boolean language sql as $$select false$$");
  await db.exec("savepoint rejected_accounting");await expect(accountFull()).rejects.toThrow();await db.exec("rollback to savepoint rejected_accounting");
  expect((await db.query("select count(*)::int n from purchases")).rows).toEqual([{n:issue==="existing purchase"?1:0}]);
  expect((await db.query("select count(*)::int n from payment_fee_ledger")).rows).toEqual([{n:issue==="existing ledger"?1:0}]);
  expect((await db.query("select total_earnings_cents::int n from profiles")).rows).toEqual([{n:0}]);
  expect((await db.query("select count(*)::int n from full_server_payment_receipts_v1 where accounted_at is not null")).rows).toEqual([{n:0}]);
});
test.each(["anon","authenticated"])("%s cannot account a full receipt",async role=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();await db.exec(`set local role ${role}`);
  await expect(accountFull()).rejects.toThrow("permission denied");
});

test.each(["ledger economics","purchase owner","service dates"])("accounted replay rejects changed %s without recredit",async issue=>{
  const {proof}=await fullReceiptFixture(36);await recordFull(proof);await installFullAccounting();await accountFull();
  if(issue==="ledger economics")await db.exec("update payment_fee_ledger set processing_fee_cents=1");
  if(issue==="purchase owner")await db.query("update purchases set buyer_user_id=$1",[id(90)]);
  if(issue==="service dates")await db.exec("update fixed_purchase_service_contracts_v1 set service_end_at=service_end_at+1");
  await expect(accountFull()).rejects.toThrow();
});
test("record replay reports completed accounting accurately and receipt reads remain owner scoped",async()=>{
  const {proof}=await fullReceiptFixture();await recordFull(proof);await installFullAccounting();const result=await accountFull();
  expect(await recordFull(proof)).toMatchObject({recorded:false,accountingRequired:false});
  expect(await rpc("read_full_server_payment_receipt_v1")).toMatchObject({purchase_id:result.purchaseId,ledger_id:result.ledgerId,proof});
  await expect(rpc("read_full_server_payment_receipt_v1",[],id(90))).rejects.toThrow();
});

test.each(['full','first_installment'] as const)('%s rejects the legacy shape for a new admission',async kind=>{
  await prepare(kind);
  delete request.params.payment_method_types;request.params.automatic_payment_methods={enabled:false};
  await expect(claim()).rejects.toThrow('Only the original unconfirmed manual intent');
});

test.each(['full','first_installment'] as const)('%s retains an already persisted legacy operation without changing request or key',async kind=>{
  await prepare(kind);const saved=(await claim()).operation;
  delete request.params.payment_method_types;request.params.automatic_payment_methods={enabled:false};
  // Model a pre-upgrade persisted row, not a production mutation.
  await db.query("update server_payment_intent_operations_v1 set request=$1,lease_until=clock_timestamp()-interval '1 second' where attempt_id=$2",[request,id(1)]);
  const retried=await claim();
  expect(retried.status).toBe('dispatch');expect(retried.operation.request).toEqual(request);
  expect(retried.operation.idempotency_key).toBe(saved.idempotency_key);
  const corrected=serverPaymentCreateRequest(c,evidence);
  await expect(rpc('claim_server_payment_intent_v1',[c,corrected])).rejects.toThrow('Original manual intent request changed');
});

const cardBasis=()=>{const createdAt=Math.floor(Date.now()/1000);return {kind:"card",method:{paymentMethodId:"pm_card",createdAt,
  expiresAt:Math.min(c.expiresAt,createdAt+43200),previewHash:"c".repeat(64),country:"US"}};};
test("Card Element method phase admits exact manual request and preserves same-key retry",async()=>{
  await prepare();const intent=(await claim()).operation;await bind(intent);const basis=cardBasis(),pi={...provider(intent),next_action:null};
  const first=(await rpc("claim_server_confirmation_v1",[basis,pi])).operation;
  expect(first.phase).toBe(1);expect(first.request.params).toEqual({payment_method:"pm_card",use_stripe_sdk:true,
    return_url:context.siteOrigin+"/purchase/payment/return?attempt="+id(1)});
  expect((await rpc("claim_server_confirmation_v1",[basis,pi])).status).toBe("busy");
  await db.query("update server_payment_confirmations_v1 set lease_until=clock_timestamp()-interval '1 second' where operation_id=$1",[first.operation_id]);
  const retry=(await rpc("claim_server_confirmation_v1",[basis,pi])).operation;
  expect(retry.operation_id).toBe(first.operation_id);expect(retry.request).toEqual(first.request);expect(retry.basis).toEqual(first.basis);
});
test.each(["foreign country","wrong prefix","expired","changed window","missing hash","extra field","changed method","stop"])("card method admission refuses %s",async issue=>{
  await prepare();const intent=(await claim()).operation;await bind(intent);const basis:any=cardBasis(),pi={...provider(intent),next_action:null};
  if(issue==="foreign country")basis.method.country="CA";
  if(issue==="wrong prefix")basis.method.paymentMethodId="ctoken_wrong";
  if(issue==="expired")basis.method.expiresAt=Math.floor(Date.now()/1000);
  if(issue==="changed window")basis.method.expiresAt++;
  if(issue==="missing hash")delete basis.method.previewHash;
  if(issue==="extra field")basis.method.secret="never";
  if(issue==="changed method"){await rpc("claim_server_confirmation_v1",[basis,pi]);basis.method.paymentMethodId="pm_changed";}
  if(issue==="stop")await stop();
  await expect(rpc("claim_server_confirmation_v1",[basis,pi])).rejects.toThrow();
});
test("card replacement still requires independently recorded failure and exact predecessor",async()=>{
  const f=await declinedPhase(),basis={kind:"card_replacement",method:cardBasis().method,previousOperationId:f.phase.operation_id,failure:failedProof};
  const phase=(await rpc("claim_server_confirmation_v1",[basis,f.pi])).operation;
  expect(phase.phase).toBe(2);expect(phase.request.params.payment_method).toBe("pm_card");
  expect(phase.previous_operation_id).toBe(f.phase.operation_id);
});

test("card replacement cannot record its predecessor decline as a new failed attempt",async()=>{
  const f=await declinedPhase(),basis={kind:"card_replacement",method:cardBasis().method,previousOperationId:f.phase.operation_id,failure:failedProof};
  const phase=(await rpc("claim_server_confirmation_v1",[basis,f.pi])).operation;
  await db.exec("savepoint rejected_card_observation");
  await expect(observe(phase,"requires_payment_method",{chargeId:"ch_failed",failure:failedProof})).rejects.toThrow();
  await db.exec("rollback to savepoint rejected_card_observation");
  await observe(phase,"requires_payment_method",{chargeId:"ch_failed"});
  expect((await phaseAssert(phase,false)).latest_observation.failure).toBeUndefined();
});
test.each(["succeeded","requires_action","requires_confirmation","failure"])("card phase rejects unrelated method in %s observation",async state=>{
  await prepare();const intent=(await claim()).operation;await bind(intent);
  const phase=(await rpc("claim_server_confirmation_v1",[cardBasis(),{...provider(intent),next_action:null}])).operation;
  const status=state==="failure"?"requires_payment_method":state;
  await db.exec("savepoint rejected_card_observation");
  await expect(observe(phase,status,state==="failure"?{chargeId:"ch_failed",failure:failedProof}:{})).rejects.toThrow();
  await db.exec("rollback to savepoint rejected_card_observation");
  await observe(phase,status,state==="failure"?{chargeId:"ch_failed",failure:{...failedProof,paymentMethodId:"pm_card"}}:{paymentMethodId:"pm_card"});
});
test("card method uniqueness prevents another phase from reusing an admitted method",async()=>{
  await prepare();const intent=(await claim()).operation;await bind(intent);const pi={...provider(intent),next_action:null};
  const basis=cardBasis(),first=(await rpc("claim_server_confirmation_v1",[basis,pi])).operation;
  const failure={...failedProof,paymentMethodId:"pm_card"};
  await observe(first,"requires_payment_method",{chargeId:"ch_failed",failure});
  await expect(rpc("claim_server_confirmation_v1",[{kind:"card_replacement",method:basis.method,previousOperationId:first.operation_id,failure},
    {...pi,latest_charge:"ch_failed",last_payment_error:{code:failure.code,charge:"ch_failed",payment_method:{id:"pm_card"}}}])).rejects.toThrow();
});
