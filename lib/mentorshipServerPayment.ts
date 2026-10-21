import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
import {prepareBuyerMentorshipBootstrap} from "./mentorshipInstallmentBootstrap";
import {buyerMentorshipServerPaymentContract,buildBuyerMentorshipCheckoutRequest,readBuyerMentorshipManualBindings} from "./mentorshipInstallmentCheckout";
import {SERVER_PAYMENT_PROTOCOL,type ServerPaymentContract} from "./serverPaymentConfirmation";
import {prepareServerPaymentIntent} from "./serverPaymentIntent";
import {runServerPaymentConfirmation,getServerPaymentAuthentication} from "./serverPaymentConfirmationStore";
import {stopServerPaymentIntent} from "./serverPaymentStop";
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Mentorship server payment requires review");};

/** Internal composition for the genuine buyer's selected installment purchase.
 * Uses existing acceptance/bootstrap and the shared intent adapter. Does not
 * confirm, return a client secret, publish checkout, credit or activate access.
 * A route may not call this until confirmation/receipt/terminal recovery is
 * complete and the release gates have actual provider acceptance evidence.
 */
type BuyerServerPaymentArgs={buyerId:string;requestId:string;env?:Record<string,string|undefined>};
type ObservedPaymentEvent={paymentIntentId:string;customerId:string;livemode:boolean};
type ConfirmationAction=Parameters<typeof runServerPaymentConfirmation>[0]["action"];
export async function prepareBuyerMentorshipServerPayment(args:BuyerServerPaymentArgs){
  return runBuyerMentorshipServerPayment(args);
}
export async function confirmBuyerMentorshipServerPayment(args:BuyerServerPaymentArgs&{action:ConfirmationAction;expectedEvent?:ObservedPaymentEvent}){
  return runBuyerMentorshipServerPayment(args);
}
export async function authenticateBuyerMentorshipServerPayment(args:BuyerServerPaymentArgs&{operationId:string}){
  assertAgreementId(args.operationId);
  return runBuyerMentorshipServerPayment({...args,authenticationOperationId:args.operationId});
}
export async function stopBuyerMentorshipServerPayment(args:BuyerServerPaymentArgs){
  return runBuyerMentorshipServerPayment({...args,stop:true});
}
async function runBuyerMentorshipServerPayment(args:BuyerServerPaymentArgs&{action?:ConfirmationAction;authenticationOperationId?:string;stop?:boolean;expectedEvent?:ObservedPaymentEvent}){
  try{
    const env=args.env??process.env;
    if(args.expectedEvent)check(args.action?.kind==="observe"&&!args.authenticationOperationId&&!args.stop);
    if(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY!=="true")return {status:"not_enabled" as const};
    if(args.action||args.authenticationOperationId)check(env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY==="true");
    if(args.stop)check(env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY==="true"&&env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),context=config.approvedContext;
    const contextEvidence=async()=>(await runtime.observeContext()).contextEvidence;
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context,contextEvidence:await contextEvidence()});check(r);
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const scope={p_attempt_id:r.attemptId,p_buyer_id:args.buyerId,p_context:context};
    const pin=await admin.from("server_payment_protocols_v1").select("attempt_id,buyer_id,product_id,reservation_id,kind,protocol,context")
      .eq("attempt_id",r.attemptId).eq("buyer_id",args.buyerId).maybeSingle();check(!pin.error);
    if(pin.data)check(pin.data.attempt_id===r.attemptId&&pin.data.buyer_id===r.buyerId&&pin.data.product_id===r.productId&&
      pin.data.reservation_id===r.id&&pin.data.kind==="first_installment"&&pin.data.protocol===SERVER_PAYMENT_PROTOCOL&&
      isDeepStrictEqual(pin.data.context,context));
    let saved:unknown=null;
    if(pin.data){const read=await admin.rpc("read_server_payment_intent_v1",scope);check(!read.error);saved=read.data;}
    if(args.stop){
      check(pin.data);
      const stopped=await admin.rpc("request_server_payment_stop_v1",scope);
      check(!stopped.error&&stopped.data?.attemptId===r.attemptId&&stopped.data.releaseAllowed===false);
      if(!saved||!(saved as {bound_at:unknown}).bound_at)return {status:"reconciliation_required" as const,releaseAllowed:false as const};
    }
    // Confirm/recover only the existing bound original. A confirmation request
    // never creates a new customer, subscription, intent or purchase selection.
    if(args.action||args.authenticationOperationId)check(saved&&(saved as {bound_at:unknown}).bound_at);
    if(!saved){
      if(env.CREATOR_SERVER_PAYMENT_INTENT_READY!=="true")return {status:"not_enabled" as const};
      const prepared=await prepareBuyerMentorshipBootstrap({...args,env,serverControlledFirstPayment:true});
      if(prepared.status!=="held_unpublished"){
        check(prepared.status!=="checkout_unpublished");return prepared;
      }
    }
    const dependencies=()=>readBuyerMentorshipManualBindings(admin,r);
    const contract=async():Promise<ServerPaymentContract>=>{
      return buyerMentorshipServerPaymentContract(r,context,await dependencies());
    };
    const c=saved?(saved as {contract:ServerPaymentContract}).contract:await contract();
    check(c&&c.attemptId===r.attemptId&&c.buyerId===r.buyerId&&c.productId===r.productId&&c.creatorId===r.terms.creatorId&&
      c.kind==="first_installment"&&c.termsFingerprint===r.fingerprint&&isDeepStrictEqual(c.context,context));
    const assertProviderSource=async()=>{
      const current=await readBuyerMentorshipBootstrapReservation({...args,admin,context,contextEvidence:await contextEvidence()});
      check(isDeepStrictEqual(current,r)&&isDeepStrictEqual(await contract(),c));
      const d=await dependencies();
      const customer=await stripe.customers.retrieve(d.customerId),subscription=await stripe.subscriptions.retrieve(d.subscriptionId);
      // Reuses existing original held-subscription/customer/terms validation;
      // builds no hosted session and does not dispatch the generated payload.
      buildBuyerMentorshipCheckoutRequest({reservation:r,context,contextEvidence:await contextEvidence(),dependencies:d,
        customer,subscription,nowSeconds:Math.floor(Date.now()/1000)});
      const destination=await stripe.accounts.retrieve(r.destinationId);
      check(destination.id===r.destinationId&&destination.charges_enabled&&destination.payouts_enabled&&destination.capabilities?.transfers==="active");
      check(isDeepStrictEqual(await dependencies(),d));
    };
    if(args.action||args.authenticationOperationId||args.stop){
      const original=saved as {payment_intent_id:string;first_dispatch_at:string};
      check(/^pi_[A-Za-z0-9]+$/.test(original.payment_intent_id)&&Number.isFinite(Date.parse(original.first_dispatch_at)));
      if(args.expectedEvent)check(args.expectedEvent.paymentIntentId===original.payment_intent_id&&
        args.expectedEvent.customerId===c.customerId&&args.expectedEvent.livemode===(context.mode==="live"));
      const dependencies={contract:c,binding:{paymentIntentId:original.payment_intent_id,
        firstDispatchAt:Math.floor(Date.parse(original.first_dispatch_at)/1000)},admin,stripe,env,contextEvidence,assertProviderSource};
      if(args.stop)return await stopServerPaymentIntent(dependencies);
      if(args.authenticationOperationId)return await getServerPaymentAuthentication({...dependencies,operationId:args.authenticationOperationId});
      check(args.action);return await runServerPaymentConfirmation({...dependencies,action:args.action});
    }
    return await prepareServerPaymentIntent({contract:c,admin,stripe,env,contextEvidence,assertProviderSource});
  }catch{throw Error("Mentorship server payment requires review");}
}
