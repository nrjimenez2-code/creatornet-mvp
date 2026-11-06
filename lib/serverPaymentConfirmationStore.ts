import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest,serverPaymentConfirmationRequest,inspectServerPaymentIntent,
  inspectServerConfirmationToken,inspectServerCardMethod,dispatchServerPaymentConfirmation,observeServerPaymentConfirmation,serverPaymentAuthenticationCapability,
  type ServerPaymentContract,type ServerConfirmationAdmission,type ServerConfirmationBasis,type ServerConfirmationStore,
  type ServerConfirmationObservation} from "./serverPaymentConfirmation";
type Database={rpc(name:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:unknown}>};
type Dependencies={contract:ServerPaymentContract;binding:{paymentIntentId:string;firstDispatchAt:number};admin:Database;
  contextEvidence:()=>Promise<unknown>;assertProviderSource:()=>Promise<void>;env?:Record<string,string|undefined>;now?:()=>number};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Server confirmation storage requires review");};
const time=(s:unknown)=>{check(typeof s==="string");const n=Date.parse(s);check(Number.isFinite(n)&&n>0);return Math.floor(n/1000);};

/** Concrete service-only storage. Every dispatch checks original source, lease,
 * stop/receipt and context in SQL after the independent provider-source read.
 * Read/observation recovery does not depend on confirmation still being enabled.
 */
export function createServerConfirmationStore(args:Dependencies){
  const c=JSON.parse(JSON.stringify(args.contract)) as ServerPaymentContract;
  const binding={...args.binding},env=args.env??process.env,now=args.now??(()=>Math.floor(Date.now()/1000));
  const scope={p_attempt_id:c.attemptId,p_buyer_id:c.buyerId,p_context:c.context};
  const rpc=async(name:string,extra:Record<string,unknown>={})=>{
    check(env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY==="true");
    serverPaymentCreateRequest(c,await args.contextEvidence());
    const response=await args.admin.rpc(name,{...scope,...extra});check(!response.error);return response.data;
  };
  const parse=(raw:unknown)=>{
    check(raw&&typeof raw==="object"&&!Array.isArray(raw));const op=raw as Record<string,any>;
    assertAgreementId(op.operation_id);assertAgreementId(op.lease_token);
    check(op.attempt_id===c.attemptId&&op.payment_intent_id===binding.paymentIntentId&&Number.isSafeInteger(op.phase)&&op.phase>0&&
      time(op.first_dispatch_at)>=binding.firstDispatchAt&&time(op.first_dispatch_at)<=now());
    const basis=op.basis as ServerConfirmationBasis;
    check(basis&&["token","after_authentication","replacement","card","card_replacement"].includes(basis.kind));
    if(basis.kind==="token"||basis.kind==="card")check(op.phase===1&&op.previous_operation_id===null);
    else check(op.phase>1&&basis.previousOperationId===op.previous_operation_id);
    const request=serverPaymentConfirmationRequest(c,binding.paymentIntentId,basis);
    check(isDeepStrictEqual(op.request,request));
    const admission:ServerConfirmationAdmission={operationId:op.operation_id,leaseToken:op.lease_token,attemptId:c.attemptId,
      paymentIntentId:binding.paymentIntentId,firstDispatchAt:time(op.first_dispatch_at),dispatchBefore:time(op.dispatch_before),
      idempotencyKey:`${SERVER_PAYMENT_PROTOCOL}:${op.operation_id}`,basis,request};
    return {admission,observation:op.latest_observation as ServerConfirmationObservation|null};
  };
  const sameOriginal=(a:ServerConfirmationAdmission,b:ServerConfirmationAdmission,dispatch:boolean)=>{
    // Observations end a lease/deadline. Identity and request stay immutable and
    // remain readable; stale leases still cannot record or dispatch in SQL.
    const clean=(v:ServerConfirmationAdmission)=>{const {leaseToken,dispatchBefore,...rest}=v;return rest;};
    check(isDeepStrictEqual(dispatch?a:clean(a),dispatch?b:clean(b)));
  };
  const assertion=async(a:ServerConfirmationAdmission,dispatch:boolean)=>{
    if(dispatch){
      check(env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY==="true");
      if(a.basis.kind==="card"||a.basis.kind==="card_replacement")check(env.CREATOR_SERVER_PAYMENT_CARD_METHOD_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_CARD_METHOD_READY==="true");
      if(a.basis.kind==="replacement"||a.basis.kind==="card_replacement")check(env.CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_REPLACEMENT_READY==="true");
      await args.assertProviderSource();
    }
    const row=await rpc("assert_server_confirmation_v1",{p_operation_id:a.operationId,p_lease_token:a.leaseToken,p_for_dispatch:dispatch});
    sameOriginal(a,parse(row).admission,dispatch);
  };
  const store:ServerConfirmationStore={
    assertReadable:a=>assertion(a,false),assertDispatch:a=>assertion(a,true),
    recordObservation:async(a,observation)=>{
      if(observation.failure)check(env.CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY==="true");
      const result=await rpc("record_server_confirmation_observation_v1",{
        p_operation_id:a.operationId,p_lease_token:a.leaseToken,p_observation:observation});
      check(isDeepStrictEqual(result,observation));
    },
  };
  return {store,
    async assertAuthentication(a:ServerConfirmationAdmission,observation:ServerConfirmationObservation){
      check(env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY==="true"&&
        env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY==="true");
      await args.assertProviderSource();
      const row=await rpc("assert_server_payment_authentication_v1",{p_operation_id:a.operationId,p_observation:observation});
      const parsed=parse(row);sameOriginal(a,parsed.admission,false);check(isDeepStrictEqual(parsed.observation,observation));
    },
    async latest(){const row=await rpc("read_latest_server_confirmation_v1");return row===null?null:parse(row);},
    async claim(basis:ServerConfirmationBasis,pi:Stripe.PaymentIntent){
      check(env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY==="true");
      if(basis.kind==="replacement"||basis.kind==="card_replacement")check(env.CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_REPLACEMENT_READY==="true");
      inspectServerPaymentIntent(c,await args.contextEvidence(),pi,binding,now());
      // Do not pass raw provider payloads/client secrets into durable storage.
      const proof={id:pi.id,object:pi.object,livemode:pi.livemode,customer:c.customerId,amount:pi.amount,currency:pi.currency,
        confirmation_method:pi.confirmation_method,capture_method:pi.capture_method,metadata:pi.metadata,
        application_fee_amount:pi.application_fee_amount,transfer_data:{destination:c.destinationId},setup_future_usage:pi.setup_future_usage,
        payment_method_types:pi.payment_method_types,automatic_payment_methods:{enabled:pi.automatic_payment_methods?.enabled===true},
        amount_received:pi.amount_received,amount_capturable:pi.amount_capturable,on_behalf_of:null,shipping:null,transfer_group:null,
        last_payment_error:pi.last_payment_error?{code:pi.last_payment_error.code,charge:pi.last_payment_error.charge,
          payment_method:{id:pi.last_payment_error.payment_method?.id}}:null,next_action:pi.next_action?{present:true}:null,
        created:pi.created,status:pi.status,payment_method:typeof pi.payment_method==="string"?pi.payment_method:pi.payment_method?.id??null,
        latest_charge:typeof pi.latest_charge==="string"?pi.latest_charge:pi.latest_charge?.id??null};
      const result=await rpc("claim_server_confirmation_v1",{p_basis:basis,p_intent:proof}) as {status:string;operation:unknown};
      check(result&&["dispatch","busy","observe_only","reconciliation_required"].includes(result.status));
      const parsed=parse(result.operation);check(isDeepStrictEqual(parsed.admission.basis,basis));
      return {status:result.status as "dispatch"|"busy"|"observe_only"|"reconciliation_required",...parsed};
    },
  };
}

/** Internal owner-scoped capability, for a specific current bank challenge.
 * Secret is only returned, never persisted/logged. Manual confirmation keeps
 * the next payment attempt on the server with its own stop/consent checks.
 * HTTP publication additionally requires authenticated, non-cacheable routing.
 */
export async function getServerPaymentAuthentication(args:Dependencies&{
  stripe:Parameters<typeof runServerPaymentConfirmation>[0]["stripe"];operationId:string;
}){
  try{
    const env=args.env??process.env;
    check(env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY==="true"&&
      env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY==="true");
    assertAgreementId(args.operationId);
    const c=JSON.parse(JSON.stringify(args.contract)) as ServerPaymentContract,binding={...args.binding};
    const dependencies={...args,contract:c,binding},storage=createServerConfirmationStore(dependencies);
    const latest=await storage.latest();check(latest&&latest.admission.operationId===args.operationId);
    await args.assertProviderSource();
    const observation=await observeServerPaymentConfirmation({...dependencies,admission:latest.admission,store:storage.store});
    check(observation.status==="requires_action");
    const pi=await args.stripe.paymentIntents.retrieve(binding.paymentIntentId,
      {apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const capability=serverPaymentAuthenticationCapability(c,await args.contextEvidence(),pi,binding,observation,
      (args.now??(()=>Math.floor(Date.now()/1000)))());
    // Last await checks current phase, stop, owner, receipt and original terms
    // under the same database lock used for purchase/confirmation admission.
    await storage.assertAuthentication(latest.admission,observation);
    return {status:"authentication_required" as const,operationId:latest.admission.operationId,...capability};
  }catch{throw Error("Server payment authentication requires review");}
}

/** Internal orchestration; c/binding are server-loaded originals, never request
 * body fields. A token input is independently retrieved; an authentication
 * successor must name its original predecessor (not merely ask for a new key).
 * No success response is receipt/accounting/access proof. No secret is returned.
 */
export async function runServerPaymentConfirmation(args:Dependencies&{
  stripe:Pick<Stripe,"paymentIntents"|"paymentMethods"|"confirmationTokens"|"charges">;
  action:{kind:"card";paymentMethodId:string}|{kind:"card_replacement";paymentMethodId:string;previousOperationId:string}|{kind:"observe"}|{kind:"token";tokenId:string}|{kind:"replacement";tokenId:string;previousOperationId:string}|{kind:"after_authentication";previousOperationId:string};
}){
  try{
    const env=args.env??process.env;
    check(env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY==="true");
    const c=JSON.parse(JSON.stringify(args.contract)) as ServerPaymentContract,binding={...args.binding};
    const dependencies={...args,contract:c,binding},storage=createServerConfirmationStore(dependencies);
    const latest=await storage.latest(),now=args.now??(()=>Math.floor(Date.now()/1000));
    const observe=async(admission:ServerConfirmationAdmission)=>({status:"observed" as const,operationId:admission.operationId,
      observation:await observeServerPaymentConfirmation({...dependencies,admission,store:storage.store})});
    if(args.action.kind==="observe"){check(latest);return await observe(latest.admission);}
    check(env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY==="true");
    const pi=inspectServerPaymentIntent(c,await args.contextEvidence(),await args.stripe.paymentIntents.retrieve(binding.paymentIntentId,
      {apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000}),binding,now());
    let basis:ServerConfirmationBasis;
    if(args.action.kind==="card"||args.action.kind==="card_replacement"){
      check(env.CREATOR_SERVER_PAYMENT_CARD_METHOD_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_CARD_METHOD_READY==="true");
      const action=args.action;
      check(/^pm_[A-Za-z0-9]+$/.test(action.paymentMethodId));
      if(action.kind==="card"){
        if(latest){
          check(latest.admission.basis.kind==="card"&&latest.admission.basis.method.paymentMethodId===action.paymentMethodId);
          if(pi.last_payment_error||pi.status!=="requires_payment_method")return await observe(latest.admission);
          basis=latest.admission.basis;
        }else{
          const pm=await args.stripe.paymentMethods.retrieve(action.paymentMethodId,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
          basis={kind:"card",method:inspectServerCardMethod(c,await args.contextEvidence(),pm,action.paymentMethodId,now())};
        }
      }else{
        check(env.CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_REPLACEMENT_READY==="true");
        assertAgreementId(action.previousOperationId);check(latest);
        const a=latest.admission;
        if(a.basis.kind==="card_replacement"&&a.basis.previousOperationId===action.previousOperationId&&a.basis.method.paymentMethodId===action.paymentMethodId){
          if(latest.observation?.failure||pi.status!=="requires_payment_method")return await observe(a);
          basis=a.basis;
        }else{
          check(a.operationId===action.previousOperationId);
          const current=await observe(a);check(current.observation.failure);
          const pm=await args.stripe.paymentMethods.retrieve(action.paymentMethodId,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
          basis={kind:"card_replacement",previousOperationId:a.operationId,failure:current.observation.failure,
            method:inspectServerCardMethod(c,await args.contextEvidence(),pm,action.paymentMethodId,now())};
        }
      }
    }else if(args.action.kind==="token"){
      if(latest){
        check(latest.admission.basis.kind==="token"&&latest.admission.basis.token.tokenId===args.action.tokenId);
        if(pi.last_payment_error||["requires_action","requires_confirmation","processing","succeeded","canceled"].includes(pi.status))return await observe(latest.admission);
        // Original unknown replay uses the same previously saved proof. The
        // executor independently rechecks the token immediately before writing.
        basis=latest.admission.basis;
      }else{
        check(/^ctoken_[A-Za-z0-9]+$/.test(args.action.tokenId));
        const token=await args.stripe.confirmationTokens.retrieve(args.action.tokenId,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
        basis={kind:"token",token:inspectServerConfirmationToken(c,await args.contextEvidence(),token,args.action.tokenId,now())};
      }
    }else if(args.action.kind==="replacement"){
      check(env.CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_REPLACEMENT_READY==="true");
      assertAgreementId(args.action.previousOperationId);check(latest&&/^ctoken_[A-Za-z0-9]+$/.test(args.action.tokenId));
      const a=latest.admission;
      if(a.basis.kind==="replacement"&&a.basis.previousOperationId===args.action.previousOperationId&&a.basis.token.tokenId===args.action.tokenId){
        if(latest.observation?.failure||pi.status!=="requires_payment_method")return await observe(a);
        basis=a.basis;
      }else{
        check(a.operationId===args.action.previousOperationId);
        const current=await observe(a);check(current.observation.failure);
        const token=await args.stripe.confirmationTokens.retrieve(args.action.tokenId,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
        basis={kind:"replacement",previousOperationId:a.operationId,failure:current.observation.failure,
          token:inspectServerConfirmationToken(c,await args.contextEvidence(),token,args.action.tokenId,now())};
      }
    }else{
      assertAgreementId(args.action.previousOperationId);check(latest);
      const a=latest.admission;
      check(a.operationId===args.action.previousOperationId||a.basis.kind==="after_authentication"&&a.basis.previousOperationId===args.action.previousOperationId);
      if(pi.status!=="requires_confirmation")return await observe(a);
      const method=typeof pi.payment_method==="string"?pi.payment_method:pi.payment_method?.id;
      check(method&&/^pm_[A-Za-z0-9]+$/.test(method));
      basis={kind:"after_authentication",paymentMethodId:method,previousOperationId:args.action.previousOperationId};
    }
    const phase=await storage.claim(basis,pi);
    if(phase.status==="busy")return {status:"busy" as const,operationId:phase.admission.operationId};
    if(phase.status!=="dispatch")return await observe(phase.admission);
    const result=await dispatchServerPaymentConfirmation({...dependencies,admission:phase.admission,store:storage.store});
    return {status:"observed" as const,operationId:phase.admission.operationId,...result};
  }catch{throw Error("Server payment confirmation requires review");}
}
