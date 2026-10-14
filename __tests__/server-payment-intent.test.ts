import type Stripe from "stripe";
import {prepareServerPaymentIntent} from "../lib/serverPaymentIntent";
import {serverPaymentFixture} from "../test-support/server-payment-fixture";
import {serverPaymentCreateRequest} from "../lib/serverPaymentConfirmation";
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function fixture(kind:"full"|"first_installment"|"monthly_first"="full"){
  const f=serverPaymentFixture(kind),request=serverPaymentCreateRequest(f.c,f.f.contextEvidence);
  let clock=f.now(),saved:any=null;
  const op={attempt_id:f.c.attemptId,contract:copy(f.c),request:copy(request),
    idempotency_key:`cn-server-intent-v1:${f.c.attemptId}`,lease_token:f.c.buyerId,
    first_dispatch_at:new Date(clock*1000).toISOString(),lease_until:new Date((clock+75)*1000).toISOString(),
    payment_intent_id:null as string|null,provider_request_id:null as string|null,bound_at:null as string|null};
  f.pi.created=clock;
  const db=jest.fn(async(name:string,args:Record<string,unknown>):Promise<{data:any;error:any}>=>{
    expect(args).toMatchObject({p_attempt_id:f.c.attemptId,p_buyer_id:f.c.buyerId,p_context:f.c.context});
    if(name==="read_server_payment_intent_v1")return {data:copy(saved),error:null};
    if(name==="claim_server_payment_intent_v1"){
      saved=copy(op);return {data:{status:"dispatch",operation:copy(saved),dispatchBefore:clock+30},error:null};
    }
    if(name==="assert_server_payment_intent_dispatch_v1")return {data:copy(saved),error:null};
    if(name==="bind_server_payment_intent_v1"){
      saved={...saved,payment_intent_id:(args.p_object as any).id,provider_request_id:args.p_provider_request_id,
        bound_at:new Date(clock*1000).toISOString()};return {data:copy(saved),error:null};
    }
    throw Error("Unexpected RPC");
  });
  const created=()=>({...copy(f.pi),lastResponse:{requestId:"req_owned"}} as Stripe.Response<Stripe.PaymentIntent>);
  const stripe={paymentIntents:{create:jest.fn(async()=>created()),retrieve:jest.fn(async()=>copy(f.pi))}};
  const env:Record<string,string|undefined>={CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_INTENT_READY:"true"};
  const args={contract:f.c,admin:{rpc:db},stripe:stripe as unknown as Parameters<typeof prepareServerPaymentIntent>[0]["stripe"],
    contextEvidence:jest.fn(async()=>f.f.contextEvidence),assertProviderSource:jest.fn(async()=>{}),env,now:()=>clock};
  const bindOriginal=()=>{saved={...copy(op),payment_intent_id:f.pi.id,provider_request_id:"req_owned",bound_at:new Date(clock*1000).toISOString()};};
  return {f,op,request,db,stripe,args,env,created,bindOriginal,advance:(s:number)=>clock+=s,
    setSaved:(v:any)=>saved=copy(v),getSaved:()=>copy(saved)};
}
test.each(["full","first_installment"] as const)("%s persists admission before unconfirmed create, retrieves independently, and stores no secret",async kind=>{
  const f=fixture(kind);const result=await prepareServerPaymentIntent(f.args);
  expect(result).toEqual({status:"bound_unpublished",paymentIntentId:"pi_owned",firstDispatchAt:f.f.now(),providerStatus:"requires_payment_method"});
  expect(f.stripe.paymentIntents.create).toHaveBeenCalledWith(f.request.params,{apiVersion:"2025-10-29.clover",maxNetworkRetries:0,
    timeout:10000,idempotencyKey:f.op.idempotency_key});
  expect(f.stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_owned",{apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
  const names=f.db.mock.calls.map(([name])=>name);
  expect(names).toEqual(["read_server_payment_intent_v1","claim_server_payment_intent_v1","assert_server_payment_intent_dispatch_v1","bind_server_payment_intent_v1"]);
  expect(f.db.mock.invocationCallOrder[2]).toBeLessThan(f.stripe.paymentIntents.create.mock.invocationCallOrder[0]);
  expect(f.stripe.paymentIntents.create.mock.invocationCallOrder[0]).toBeLessThan(f.stripe.paymentIntents.retrieve.mock.invocationCallOrder[0]);
  expect(JSON.stringify(f.db.mock.calls)).not.toContain("client_secret");expect(JSON.stringify(result)).not.toContain("secret");
});
test.each(["schema","creation"])("disabled %s gate performs no provider create",async gate=>{
  const f=fixture();f.env[gate==="schema"?"CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY":"CREATOR_SERVER_PAYMENT_INTENT_READY"]="false";
  expect(await prepareServerPaymentIntent(f.args)).toEqual({status:"not_enabled"});
  expect(f.stripe.paymentIntents.create).not.toHaveBeenCalled();if(gate==="schema")expect(f.db).not.toHaveBeenCalled();
});
test.each(["first_installment","monthly_first"] as const)("%s bound original remains readable after expiry and with creation gate off",async kind=>{
  const f=fixture(kind);f.bindOriginal();f.advance(30*86400);f.env.CREATOR_SERVER_PAYMENT_INTENT_READY="false";
  Object.assign(f.f.pi,{status:"succeeded",amount_received:f.f.c.amountCents,payment_method:"pm_owned",latest_charge:"ch_owned"});
  expect(await prepareServerPaymentIntent(f.args)).toMatchObject({status:"bound_unpublished",providerStatus:"succeeded"});
  expect(f.stripe.paymentIntents.create).not.toHaveBeenCalled();expect(f.args.assertProviderSource).not.toHaveBeenCalled();
  expect(f.db.mock.calls.map(([name])=>name)).toEqual(["read_server_payment_intent_v1","read_server_payment_intent_v1"]);
});
test.each(["busy","reconciliation_required"])("durable %s response never creates a replacement",async status=>{
  const f=fixture();f.db.mockImplementation(async name=>({data:name==="read_server_payment_intent_v1"?null:{status,operation:f.op},error:null}));
  expect(await prepareServerPaymentIntent(f.args)).toEqual({status});expect(f.stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test("lost create reply leaves original request/key intact and does not retry within the same call",async()=>{
  const f=fixture();f.stripe.paymentIntents.create.mockRejectedValueOnce(Error("provider secret synthetic"));
  expect(await prepareServerPaymentIntent(f.args)).toEqual({status:"original_reply_unknown"});
  expect(f.getSaved()).toEqual(f.op);expect(f.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  expect(f.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test("lost reply can recover a concurrently bound original without another create",async()=>{
  const f=fixture();f.stripe.paymentIntents.create.mockImplementationOnce(async()=>{f.bindOriginal();throw Error("lost reply");});
  expect(await prepareServerPaymentIntent(f.args)).toMatchObject({status:"bound_unpublished",paymentIntentId:"pi_owned"});
  expect(f.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test("retry dispatch uses the database's original request/key/time, never a generated replacement",async()=>{
  const f=fixture();f.setSaved(f.op);f.advance(90);
  const original=f.db.getMockImplementation()!;
  f.db.mockImplementation(async(name,args)=>{
    if(name==="claim_server_payment_intent_v1"){
      const op={...f.op,lease_token:f.f.c.creatorId,lease_until:new Date((f.args.now()+75)*1000).toISOString()};f.setSaved(op);
      return {data:{status:"dispatch",operation:op,dispatchBefore:f.args.now()+30},error:null};
    }
    return original(name,args);
  });
  expect(await prepareServerPaymentIntent(f.args)).toMatchObject({status:"bound_unpublished",firstDispatchAt:f.f.now()});
  expect(f.stripe.paymentIntents.create).toHaveBeenCalledWith(f.request.params,expect.objectContaining({idempotencyKey:f.op.idempotency_key}));
});
test.each(["stop","lease","request","gate","deadline","context","source"])("changed %s before dispatch prevents provider creation",async change=>{
  const f=fixture(),original=f.db.getMockImplementation()!;
  if(change==="source")f.args.assertProviderSource.mockRejectedValueOnce(Error("source mismatch"));
  else f.db.mockImplementation(async(name,args)=>{
    const result=await original(name,args);if(name!=="assert_server_payment_intent_dispatch_v1")return result;
    if(change==="stop")return {data:null,error:{message:"Stopped; secret"}};
    if(change==="lease")result.data.lease_token=f.f.c.creatorId;
    if(change==="request")result.data.request.params.amount++;
    if(change==="gate")f.env.CREATOR_SERVER_PAYMENT_INTENT_READY="false";
    if(change==="deadline")f.advance(31);
    if(change==="context")f.args.contextEvidence.mockRejectedValue(Error("wrong account"));
    return result;
  });
  // Context changes must be observed before the final durable dispatch check.
  if(change==="context")f.args.assertProviderSource.mockImplementationOnce(async()=>{f.args.contextEvidence.mockRejectedValue(Error("wrong account"));});
  await expect(prepareServerPaymentIntent(f.args)).rejects.toThrow("Server payment preparation requires review");
  expect(f.stripe.paymentIntents.create).not.toHaveBeenCalled();
});
test.each(["automatic","mode","amount","fee","destination","method","charge","failure","received","metadata"])
("independent provider %s mismatch prevents binding",async change=>{
  const f=fixture();
  f.stripe.paymentIntents.retrieve.mockImplementation(async()=>{
    const pi=copy(f.f.pi);
    if(change==="automatic")pi.confirmation_method="automatic";
    if(change==="mode")pi.livemode=true;
    if(change==="amount")pi.amount++;
    if(change==="fee")pi.application_fee_amount!++;
    if(change==="destination")pi.transfer_data!.destination="acct_other";
    if(change==="method")pi.payment_method="pm_other";
    if(change==="charge")pi.latest_charge="ch_other";
    if(change==="failure")pi.last_payment_error={type:"card_error",message:"synthetic"};
    if(change==="received")pi.amount_received=3333;
    if(change==="metadata")pi.metadata.buyer_id=f.f.c.creatorId;
    return pi;
  });
  await expect(prepareServerPaymentIntent(f.args)).rejects.toThrow("Server payment preparation requires review");
  expect(f.db.mock.calls.some(([name])=>name==="bind_server_payment_intent_v1")).toBe(false);
});
test("a lost bind reply does not trigger another provider create",async()=>{
  const f=fixture(),original=f.db.getMockImplementation()!;
  f.db.mockImplementation(async(name,args)=>{
    const result=await original(name,args);if(name==="bind_server_payment_intent_v1")throw Error("lost bind reply");return result;
  });
  await expect(prepareServerPaymentIntent(f.args)).rejects.toThrow("Server payment preparation requires review");
  f.db.mockImplementation(original);expect(await prepareServerPaymentIntent(f.args)).toMatchObject({status:"bound_unpublished"});
  expect(f.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
});
test("mutating caller contract during a callback cannot alter the saved request",async()=>{
  const f=fixture();f.args.assertProviderSource.mockImplementationOnce(async()=>{Object.assign(f.args.contract,{amountCents:99999});});
  expect(await prepareServerPaymentIntent(f.args)).toMatchObject({status:"bound_unpublished"});
  expect(f.stripe.paymentIntents.create).toHaveBeenCalledWith(f.request.params,expect.anything());
});

test('persisted legacy request is never silently rewritten to the corrected card-only shape',async()=>{
  const f=fixture();
  delete f.op.request.params.payment_method_types;
  f.op.request.params.automatic_payment_methods={enabled:false};
  f.setSaved(f.op);f.advance(90);
  const original=f.db.getMockImplementation()!;
  f.db.mockImplementation(async(name,args)=>{
    if(name==='claim_server_payment_intent_v1'){
      expect(args.p_request).toEqual(f.op.request);
      const op={...f.op,lease_until:new Date((f.args.now()+75)*1000).toISOString()};f.setSaved(op);
      return {data:{status:'dispatch',operation:op,dispatchBefore:f.args.now()+30},error:null};
    }
    return original(name,args);
  });
  f.stripe.paymentIntents.create.mockRejectedValueOnce(Error('provider rejected original shape'));
  expect(await prepareServerPaymentIntent(f.args)).toEqual({status:'original_reply_unknown'});
  expect(f.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  expect(f.stripe.paymentIntents.create).toHaveBeenCalledWith(f.op.request.params,
    expect.objectContaining({idempotencyKey:f.op.idempotency_key,apiVersion:'2025-10-29.clover'}));
  expect(f.getSaved().request).toEqual(f.op.request);
});

test.each(['amount','extra parameter'])('persisted request with changed %s is rejected before dispatch',async issue=>{
  const f=fixture();
  if(issue==='amount')f.op.request.params.amount++;
  else Object.assign(f.op.request.params,{unexpected_parameter:true});
  f.setSaved(f.op);
  await expect(prepareServerPaymentIntent(f.args)).rejects.toThrow('requires review');
  expect(f.stripe.paymentIntents.create).not.toHaveBeenCalled();
  expect(f.db.mock.calls.map(([name])=>name)).toEqual(['read_server_payment_intent_v1']);
});
