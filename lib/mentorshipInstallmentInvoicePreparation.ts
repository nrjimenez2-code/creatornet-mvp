import "server-only";
import {readBuyerMentorshipInvoiceCard} from "./mentorshipInstallmentInvoiceCard";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {heldInvoicePreparationRequests,prepareHeldInvoiceUsingContract,type BuyerHeldInvoiceAuthorization,type HeldInvoicePreparationContract} from "./installments/heldInvoice";
import {discoverBuyerMentorshipRenewal} from "./mentorshipInstallmentDiscovery";
import {inspectBuyerMentorshipFirstPayment} from "./mentorshipInstallmentReceipt";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
import {inspectBuyerMentorshipActivationSubscription} from "./mentorshipInstallmentActivation";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer invoice preparation requires review");}

/** Internal collector stage: independently discovers and claims an owned invoice,
 * then runs the existing unpaid-invoice algorithm through persisted operations.
 * Has no pay/confirm capability and never releases automatic collection. */
export async function prepareBuyerMentorshipInvoice(args:{buyerId:string;requestId:string;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_INVOICE_OPERATIONS_SCHEMA_READY==="true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_INVOICE_PREPARATION_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_SCHEMA_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const discovered=await discoverBuyerMentorshipRenewal({...args,env});if(discovered.status!=="discovered")return discovered;
    const proof=await inspectBuyerMentorshipFirstPayment({...args,env});
    check(proof.buyerId===args.buyerId && proof.requestId===args.requestId);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    const observe=async()=>{const e=await runtime.observeContext();validateExactPaymentContext(proof.context,e.contextEvidence);return e;};
    const observed=await observe(),admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:proof.context,contextEvidence:observed.contextEvidence});
    check(r && r.id===proof.reservationId && r.fingerprint===proof.termsFingerprint);
    const [bootstrap,product]=await Promise.all([
      admin.from("buyer_mentorship_bootstraps_v1").select("reservation_id,customer_id,anchor_seconds").eq("reservation_id",r.id).maybeSingle(),
      admin.from("buyer_mentorship_bootstrap_operations_v1").select("reservation_id,result_id,bound_at").eq("reservation_id",r.id).eq("step","product.create").maybeSingle()]);
    check(!bootstrap.error && bootstrap.data?.reservation_id===r.id && bootstrap.data.customer_id===proof.customerId &&
      Number.isSafeInteger(bootstrap.data.anchor_seconds) && !product.error && product.data?.reservation_id===r.id && product.data.bound_at &&
      /^prod_[A-Za-z0-9]+$/.test(product.data.result_id));
    const deps={customerId:proof.customerId,subscriptionId:proof.subscriptionId,productId:product.data.result_id,anchorSeconds:bootstrap.data.anchor_seconds};
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const invoice=await stripe.invoices.retrieve(discovered.invoiceId);
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:proof.context,p_payment_number:discovered.paymentNumber};
    await observe();
    const claimed=await admin.rpc("claim_buyer_mentorship_invoice_v1",{...scope,p_invoice:invoice});check(!claimed.error && claimed.data);
    if(["busy","review_required","reconcile_admitted"].includes(claimed.data.status))return {status:claimed.data.status as "busy"|"review_required"|"reconcile_admitted",invoiceId:discovered.invoiceId,paymentNumber:discovered.paymentNumber};
    const claim=claimed.data.claim,a=claim?.authorization_snapshot as BuyerHeldInvoiceAuthorization;
    check(claimed.data.status==="claimed" && claimed.data.paymentAllowed===false && claim.reservation_id===r.id && claim.payment_number===discovered.paymentNumber &&
      claim.invoice_id===discovered.invoiceId && a?.protocol==="buyer-mentorship-installments-v1" && a.planId===r.id && a.buyerReservationId===r.id &&
      a.buyerRequestId===args.requestId && a.invoiceId===discovered.invoiceId && a.subscriptionId===proof.subscriptionId && a.customerId===proof.customerId &&
      a.destinationId===r.destinationId && a.totalCents===r.terms.amountCents && a.paymentCount===r.terms.paymentCount && a.paymentNumber===discovered.paymentNumber &&
      isDeepStrictEqual(a.feeSchedule,r.terms.renewalFeeSchedule) && /^cn-buyer-invoice-v1:[0-9a-f-]{36}$/.test(claim.idempotency_prefix));
    assertAgreementId(claim.lease_token);
    const card=await readBuyerMentorshipInvoiceCard({admin,authorization:a,originalPaymentMethodId:proof.paymentMethodId,env});
    if(card.cardAuthorizationId)check(env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_COLLECTION_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_READY==="true");
    const contract:HeldInvoicePreparationContract<BuyerHeldInvoiceAuthorization>={expectedLiveMode:proof.context.mode==="live",
      collectionVersion:"buyer-mentorship-collection-v1",idempotencyPrefix:claim.idempotency_prefix,
      metadata:{creatornet_installment_version:a.protocol,terms_fingerprint:r.fingerprint,payment_mode:proof.context.mode,
        platform_account_id:proof.context.platformAccountId,supabase_project_ref:proof.context.supabaseProjectRef,site_origin:proof.context.siteOrigin},
      assertSubscription(sub){const state=inspectBuyerMentorshipActivationSubscription({reservation:r,context:proof.context,dependencies:deps,
        paidAt:proof.paidAt,paymentMethodId:proof.paymentMethodId,subscription:sub,nowSeconds:Math.floor(Date.now()/1000),allowActivated:true});
        check(state.activated && state.itemId===a.subscriptionItemId && state.cancelAt===a.cancelAt && sub.status==="active");}};
    const requests=heldInvoicePreparationRequests(a,contract);
    async function send(step:"final-cent"|"configure"|"finalize",id:string,params:object,options?:Stripe.RequestOptions) {
      const expectedParams=step==="final-cent"?requests.adjustment:step==="configure"?requests.configure:requests.finalize;
      check(id===a.invoiceId && isDeepStrictEqual(params,expectedParams) && options?.idempotencyKey===`${claim.idempotency_prefix}:${step}`);
      await observe();
      const request={apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/invoices/${id}${step==="final-cent"?"/add_lines":step==="finalize"?"/finalize":""}`,params};
      const saved=await admin.rpc("prepare_buyer_mentorship_invoice_operation_v1",{...scope,p_token:claim.lease_token,p_step:step,p_request:request});
      const operation=saved.data?.operation,deadline=Date.parse(saved.data?.dispatchBefore);
      check(!saved.error && saved.data?.paymentAllowed===false && operation?.reservation_id===r!.id && operation.payment_number===a.paymentNumber && operation.step===step &&
        isDeepStrictEqual(operation.request,request) && operation.idempotency_key===options.idempotencyKey &&
        Number.isFinite(deadline) && deadline>Date.now() && deadline<=Date.now()+31000);
      await observe();check(Date.now()<deadline);
      const original={idempotencyKey:operation.idempotency_key};
      if(step==="final-cent")return stripe.invoices.addLines(id,operation.request.params,original);
      if(step==="configure")return stripe.invoices.update(id,operation.request.params,original);
      return stripe.invoices.finalizeInvoice(id,operation.request.params,original);
    }
    const prepared=await prepareHeldInvoiceUsingContract({subscriptions:{retrieve:async id=>{check(id===a.subscriptionId);return stripe.subscriptions.retrieve(id);}},
      invoices:{retrieve:async id=>{check(id===a.invoiceId);return stripe.invoices.retrieve(id);},
        addLines:(id,p,o)=>send("final-cent",id,p,o),update:(id,p,o)=>send("configure",id,p,o),finalizeInvoice:(id,p,o)=>send("finalize",id,p,o)},
      invoicePayments:{list:p=>stripe.invoicePayments.list(p)},paymentIntents:{retrieve:id=>stripe.paymentIntents.retrieve(id)}},a,contract);
    // Internal capability only: reuse the exact independently bound contract
    // immediately before debit admission, after prior-payment history reads.
    const verifySubscription=async()=>{
      await observe();
      contract.assertSubscription(await stripe.subscriptions.retrieve(a.subscriptionId),a);
    };
    await observe();return {...prepared,reservationId:r.id,paymentNumber:a.paymentNumber,claimToken:claim.lease_token as string,card,verifySubscription,paymentAllowed:false as const};
  } catch {throw Error("Buyer invoice preparation requires review");}
}
