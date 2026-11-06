import "server-only";
import Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {assertHeldBootstrapInvoices} from "./installments/contextActivation";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
import {inspectBuyerMentorshipFirstPayment} from "./mentorshipInstallmentReceipt";
import {buyerMentorshipActivationParams,inspectBuyerMentorshipActivationSubscription} from "./mentorshipInstallmentActivation";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer installment activation requires review");}

/** Internal activation/recovery. Keeps provider and database collection holds.
 * Reuses the existing captured-card / invoice-preflight / original-key / reread
 * sequence with the buyer-owned receipt and operation, never a booking identity. */
export async function activateBuyerMentorship(args:{buyerId:string;requestId:string;env?:Record<string,string|undefined>}):Promise<{
  status:"activated_held"|"collection_enabled"|"busy"|"review_required";
}> {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const proof=await inspectBuyerMentorshipFirstPayment({...args,env});
    check(proof.buyerId===args.buyerId && proof.requestId===args.requestId);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    const observe=async()=>{const observed=await runtime.observeContext();validateExactPaymentContext(proof.context,observed.contextEvidence);return observed;};
    const observed=await observe(),admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:proof.context,contextEvidence:observed.contextEvidence});
    check(r && r.id===proof.reservationId && r.fingerprint===proof.termsFingerprint);
    const deps=await readBuyerMentorshipActivationDependencies(admin,r.id,proof);
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    async function card() {
      const [pm,c]=await Promise.all([stripe.paymentMethods.retrieve(proof.paymentMethodId),stripe.customers.retrieve(proof.customerId)]);
      check(pm.object==="payment_method" && pm.id===proof.paymentMethodId && pm.customer===proof.customerId && pm.livemode===(proof.context.mode==="live") &&
        pm.type==="card" && pm.card && pm.billing_details.address?.country==="US" && !c.deleted);
      const customer=c as Stripe.Customer;
      check(customer.object==="customer" && customer.id===proof.customerId && customer.livemode===(proof.context.mode==="live") &&
        customer.balance===0 && customer.delinquent===false && customer.default_source==null && customer.test_clock==null &&
        (customer.invoice_settings.default_payment_method==null || customer.invoice_settings.default_payment_method===proof.paymentMethodId));
    }
    async function sub() {
      const subscription=await stripe.subscriptions.retrieve(proof.subscriptionId);
      const state=inspectBuyerMentorshipActivationSubscription({reservation:r!,context:proof.context,dependencies:deps,
        paidAt:proof.paidAt,paymentMethodId:proof.paymentMethodId,subscription,nowSeconds:Math.floor(Date.now()/1000),allowActivated:true});
      return {subscription,state};
    }
    await card();let current=await sub();
    const invoices=await stripe.invoices.list({subscription:proof.subscriptionId,limit:100});
    assertHeldBootstrapInvoices(invoices,{mode:proof.context.mode,customerId:proof.customerId,subscriptionId:proof.subscriptionId});
    const request={apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/subscriptions/${proof.subscriptionId}`,
      params:buyerMentorshipActivationParams(proof.paidAt,r.terms.paymentCount,proof.paymentMethodId)};
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:proof.context};
    async function finish():Promise<{status:"activated_held"|"collection_enabled"}> {
      if(env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY!=="true" ||
        env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_ENABLE_READY!=="true")return {status:"activated_held"};
      // Reuse the same independent card and original subscription verifier.
      // Releasing the initial DB hold never removes Stripe keep_as_draft.
      await card();const verified=await sub();check(verified.state.activated);await observe();
      const enabled=await admin.rpc("enable_buyer_mentorship_collection_v1",{...scope,p_subscription:verified.subscription});
      check(!enabled.error && enabled.data?.status==="collection_enabled" && enabled.data.reservationId===r!.id &&
        Number.isFinite(Date.parse(enabled.data.enabledAt)));
      return {status:"collection_enabled"};
    }
    await observe();
    const claimed=await admin.rpc("claim_buyer_mentorship_activation_v1",{...scope,p_item_id:current.state.itemId,p_request:request});
    check(!claimed.error && claimed.data);
    if(claimed.data.status==="busy" || claimed.data.status==="review_required")return {status:claimed.data.status};
    const op=claimed.data.operation;
    check(["dispatch","complete"].includes(claimed.data.status) && op?.reservation_id===r.id && op.item_id===current.state.itemId &&
      isDeepStrictEqual(op.request,request) && /^cn-buyer-activate-v1:[0-9a-f-]{36}$/.test(op.idempotency_key));
    assertAgreementId(op.lease_token);
    await card();current=await sub();check(current.state.itemId===op.item_id);
    if(claimed.data.status==="complete") {check(op.completed_at && current.state.activated);return finish();}
    const dispatchBefore=Date.parse(claimed.data.dispatchBefore),first=Date.parse(op.first_dispatch_at);
    check(Number.isFinite(dispatchBefore) && dispatchBefore>Date.now() && dispatchBefore<=Date.now()+31000 &&
      first>=proof.paidAt*1000 && first<=Date.now() && first>Date.now()-23*3600*1000 && Date.parse(op.lease_until)>Date.now());
    const saved=await admin.from("buyer_mentorship_activation_operations_v1").select("reservation_id,lease_token,request,idempotency_key,first_dispatch_at,completed_at")
      .eq("reservation_id",r.id).maybeSingle();
    check(!saved.error && saved.data?.reservation_id===r.id && saved.data.lease_token===op.lease_token &&
      saved.data.idempotency_key===op.idempotency_key && saved.data.first_dispatch_at===op.first_dispatch_at &&
      saved.data.completed_at==null && isDeepStrictEqual(saved.data.request,request));
    await observe();check(Date.now()<dispatchBefore);
    if(!current.state.activated) await stripe.subscriptions.update(proof.subscriptionId,op.request.params,{idempotencyKey:op.idempotency_key});
    current=await sub();check(current.state.activated && current.state.itemId===op.item_id);
    await card();await observe();
    const requestId=current.subscription.lastResponse?.requestId;check(requestId && /^req_[A-Za-z0-9]+$/.test(requestId));
    const done=await admin.rpc("complete_buyer_mentorship_activation_v1",{...scope,p_token:op.lease_token,p_subscription:current.subscription,p_provider_request_id:requestId});
    check(!done.error && done.data?.status==="complete" && done.data.operation?.reservation_id===r.id && done.data.operation.lease_token===op.lease_token &&
      done.data.operation.completed_at && isDeepStrictEqual(done.data.operation.request,request));
    return finish();
  } catch {throw Error("Buyer installment activation requires review");}
}

/** Original bound bootstrap dependencies shared by activation and recovery. */
export async function readBuyerMentorshipActivationDependencies(admin:SupabaseClient,reservationId:string,proof:{customerId:string;subscriptionId:string}) {
    const [bootstrap,product]=await Promise.all([
      admin.from("buyer_mentorship_bootstraps_v1").select("reservation_id,customer_id,anchor_seconds").eq("reservation_id",reservationId).maybeSingle(),
      admin.from("buyer_mentorship_bootstrap_operations_v1").select("reservation_id,result_id,bound_at").eq("reservation_id",reservationId).eq("step","product.create").maybeSingle()]);
    check(!bootstrap.error && bootstrap.data?.reservation_id===reservationId && bootstrap.data.customer_id===proof.customerId &&
      Number.isSafeInteger(bootstrap.data.anchor_seconds) && !product.error && product.data?.reservation_id===reservationId && product.data.bound_at &&
      /^prod_[A-Za-z0-9]+$/.test(product.data.result_id));
    return {customerId:proof.customerId,subscriptionId:proof.subscriptionId,productId:product.data.result_id,anchorSeconds:bootstrap.data.anchor_seconds};
}
