import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {inspectServerPaymentIntent,serverPaymentCreateRequest,type ServerPaymentContract} from "./serverPaymentConfirmation";

type Database={rpc(name:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:unknown}>};
type Provider=Pick<Stripe,"paymentIntents">;
type Operation={attempt_id:string;contract:ServerPaymentContract;request:ReturnType<typeof serverPaymentCreateRequest>;
  idempotency_key:string;first_dispatch_at:string;lease_token:string;lease_until:string;
  payment_intent_id:string|null;provider_request_id:string|null;bound_at:string|null};
export type ServerIntentPreparation=
  | {status:"bound_unpublished";paymentIntentId:string;firstDispatchAt:number;providerStatus:Stripe.PaymentIntent.Status}
  | {status:"not_enabled"|"busy"|"reconciliation_required"|"original_reply_unknown"};
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Server payment preparation requires review");};
const seconds=(value:string)=>{const n=Date.parse(value);check(Number.isFinite(n)&&n>0);return Math.floor(n/1000);};
const providerId=(value:unknown,prefix:string)=>check(typeof value==="string"&&new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value));
const options={apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000};
const same=(a:unknown,b:unknown)=>check(isDeepStrictEqual(a,b));

/** Concrete RPC/provider adapter for an internally derived original contract.
 * The caller must obtain the contract from the authenticated, pinned purchase,
 * and supply independent provider-source validation (original held subscription
 * for installments, destination eligibility for either kind). There is no HTTP
 * caller yet. No confirmation, secret disclosure, receipt or access mutation.
 * SQL admission commits before provider dispatch; uncertain creates keep their
 * original key. Bound read recovery does not require creation to remain enabled.
 */
export async function prepareServerPaymentIntent(args:{
  contract:ServerPaymentContract;admin:Database;stripe:Provider;
  contextEvidence:()=>Promise<unknown>;
  assertProviderSource:()=>Promise<void>;
  env?:Record<string,string|undefined>;now?:()=>number;
}):Promise<ServerIntentPreparation>{
  try{
    const env=args.env??process.env;
    if(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY!=="true")return {status:"not_enabled"};
    // Snapshot before the first await; external callbacks cannot rewrite what
    // this invocation later dispatches or uses to scope a database operation.
    const c=JSON.parse(JSON.stringify(args.contract)) as ServerPaymentContract;
    const now=args.now??(()=>Math.floor(Date.now()/1000));
    const time=()=>{const t=now();check(Number.isSafeInteger(t)&&t>0);return t;};
    await args.contextEvidence();
    const scope={p_attempt_id:c.attemptId,p_buyer_id:c.buyerId,p_context:c.context};
    const rpc=async(name:string,extra:Record<string,unknown>={})=>{
      const response=await args.admin.rpc(name,{...scope,...extra});check(!response.error);return response.data;
    };
    const saved=await rpc("read_server_payment_intent_v1");
    const request=serverPaymentCreateRequest(c,await args.contextEvidence(),
      saved!==null?(saved as Operation)?.request:undefined);
    const parse=(raw:unknown):Operation=>{
      check(raw&&typeof raw==="object"&&!Array.isArray(raw));const op=raw as Operation;
      check(op.attempt_id===c.attemptId);same(op.contract,c);same(op.request,request);
      check(typeof op.idempotency_key==="string"&&op.idempotency_key.startsWith("cn-server-intent-v1:"));
      assertAgreementId(op.idempotency_key.slice("cn-server-intent-v1:".length));assertAgreementId(op.lease_token);
      const first=seconds(op.first_dispatch_at);seconds(op.lease_until);
      check(first>=c.acceptedAt&&first<=time());
      if(op.payment_intent_id!==null){
        providerId(op.payment_intent_id,"pi");providerId(op.provider_request_id,"req");
        check(typeof op.bound_at==="string"&&seconds(op.bound_at)>=first&&seconds(op.bound_at)<=time());
      }else check(op.provider_request_id===null&&op.bound_at===null);
      return op;
    };
    const binding=(op:Operation,paymentIntentId:string)=>({paymentIntentId,firstDispatchAt:seconds(op.first_dispatch_at)});
    const retrieve=async(op:Operation,paymentIntentId:string)=>{
      const evidence=await args.contextEvidence();
      const pi=await args.stripe.paymentIntents.retrieve(paymentIntentId,options);
      // Revalidate after a potentially slow network read as well.
      serverPaymentCreateRequest(c,await args.contextEvidence());
      return inspectServerPaymentIntent(c,evidence,pi,binding(op,paymentIntentId),time());
    };
    const recovered=async(op:Operation):Promise<ServerIntentPreparation>=>{
      check(op.payment_intent_id);const pi=await retrieve(op,op.payment_intent_id);
      const current=parse(await rpc("read_server_payment_intent_v1"));same(current,op);
      return {status:"bound_unpublished",paymentIntentId:pi.id,firstDispatchAt:seconds(op.first_dispatch_at),providerStatus:pi.status};
    };
    if(saved!==null){const op=parse(saved);if(op.payment_intent_id)return await recovered(op);}
    if(env.CREATOR_SERVER_PAYMENT_INTENT_READY!=="true")return {status:"not_enabled"};
    serverPaymentCreateRequest(c,await args.contextEvidence());
    const raw=await rpc("claim_server_payment_intent_v1",{p_contract:c,p_request:request});
    check(raw&&typeof raw==="object");
    const claim=raw as {status:string;operation:unknown;dispatchBefore:number},op=parse(claim.operation);
    if(claim.status==="bound"){check(op.payment_intent_id);return await recovered(op);}
    check(op.payment_intent_id===null);
    if(claim.status==="busy"||claim.status==="reconciliation_required")return {status:claim.status};
    check(claim.status==="dispatch");
    const admitted=()=>{
      const t=time(),first=seconds(op.first_dispatch_at);
      check(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_INTENT_READY==="true"&&
        Number.isSafeInteger(claim.dispatchBefore)&&claim.dispatchBefore>t&&claim.dispatchBefore<=t+30&&
        claim.dispatchBefore<=first+23*3600&&claim.dispatchBefore<=c.expiresAt&&seconds(op.lease_until)>t);
    };
    admitted();await args.assertProviderSource();serverPaymentCreateRequest(c,await args.contextEvidence());
    same(parse(await rpc("assert_server_payment_intent_dispatch_v1",{p_lease_token:op.lease_token})),op);
    admitted();
    let created:Stripe.Response<Stripe.PaymentIntent>;
    try{
      created=await args.stripe.paymentIntents.create(request.params,{...options,idempotencyKey:op.idempotency_key});
    }catch{
      // Another original worker may have bound the reply while this request
      // lost it. Otherwise leave the operation for original-key lease recovery.
      const original=parse(await rpc("read_server_payment_intent_v1"));
      same(original.request,op.request);check(original.idempotency_key===op.idempotency_key&&original.first_dispatch_at===op.first_dispatch_at);
      if(original.payment_intent_id)return await recovered(original);
      return {status:"original_reply_unknown"};
    }
    providerId(created.id,"pi");providerId(created.lastResponse?.requestId,"req");
    const pi=await retrieve(op,created.id);
    check((pi.status==="requires_payment_method"||pi.status==="canceled")&&pi.payment_method===null&&
      pi.latest_charge===null&&pi.last_payment_error===null&&pi.amount_received===0&&pi.amount_capturable===0);
    // Only selected evidence enters the binding RPC. In particular, never
    // persist/return the response's client_secret, billing address or card data.
    const proof={id:pi.id,object:pi.object,livemode:pi.livemode,customer:c.customerId,amount:pi.amount,currency:pi.currency,
      confirmation_method:pi.confirmation_method,capture_method:pi.capture_method,metadata:pi.metadata,
      application_fee_amount:pi.application_fee_amount,transfer_data:{destination:c.destinationId},
      setup_future_usage:pi.setup_future_usage,payment_method_types:pi.payment_method_types,
      automatic_payment_methods:{enabled:pi.automatic_payment_methods?.enabled===true},status:pi.status,
      amount_received:pi.amount_received,amount_capturable:pi.amount_capturable,payment_method:null,latest_charge:null,
      last_payment_error:null,on_behalf_of:null,shipping:null,transfer_group:null,created:pi.created};
    const bound=parse(await rpc("bind_server_payment_intent_v1",{p_lease_token:op.lease_token,p_object:proof,
      p_provider_request_id:created.lastResponse.requestId}));
    check(bound.payment_intent_id===pi.id&&bound.provider_request_id===created.lastResponse.requestId);
    same({...bound,payment_intent_id:null,provider_request_id:null,bound_at:null},op);
    return {status:"bound_unpublished",paymentIntentId:pi.id,firstDispatchAt:seconds(op.first_dispatch_at),providerStatus:pi.status};
  }catch{throw Error("Server payment preparation requires review");}
}
