import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {inspectExpiredCheckoutPaymentIntent} from "./installments/checkoutExpiry";
import {calculateInstallmentPlan} from "./installmentPlan";
import {assertAgreementId} from "./installments/agreementStore";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {assertFixedTotalCheckoutSession} from "./installments/contextCheckout";
import {stopExactBillingUsingContract,type BillingStopProvider,type ExactBillingStopStore} from "./installments/billingStop";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
import {readBuyerMentorshipCheckoutBindings,buyerMentorshipFirstPaymentRequest} from "./mentorshipInstallmentCheckout";
import {stopBuyerMentorshipServerPayment} from "./mentorshipServerPayment";
import {SERVER_PAYMENT_PROTOCOL} from "./serverPaymentConfirmation";
import type {ServerPaymentTerminalProof} from "./serverPaymentStop";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Buyer abandonment requires review");};
/** Internal held, unpaid-purchase executor. Reuses the existing stop algorithm;
 * durable admission precedes each original provider write. Terminal observation
 * is persisted separately from release, so this cannot authorize a new checkout. */
export async function stopBuyerMentorshipUnpaidCheckout(args:{buyerId:string;requestId:string;requestStop?:boolean;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    for(const key of ["BOOTSTRAP_SCHEMA_READY","ABANDONMENT_SCHEMA_READY","ABANDONMENT_OPERATIONS_SCHEMA_READY","ABANDONMENT_PROOF_SCHEMA_READY","ABANDONMENT_EXECUTOR_READY"])
      check(env[`CREATOR_MENTORSHIP_INSTALLMENT_${key}`]==="true");
    const releaseEnabled=env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_READY==="true";
    if(releaseEnabled)check(env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_RELEASE_SCHEMA_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    const evidence=async()=>{
      const observed=await runtime.observeContext();
      validateExactPaymentContext(config.approvedContext,observed.contextEvidence);return observed.contextEvidence;
    };
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:await evidence()});
    check(r);
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:config.approvedContext};
    type FullBindings=Awaited<ReturnType<typeof readBuyerMentorshipCheckoutBindings>>;
    type PartialPreparation={reservationId:string;bootstrap:FullBindings["bootstrap"];product:FullBindings["product"];
      subscription:FullBindings["subscription"];hold:FullBindings["hold"]|null;customer:Record<string,unknown>};
    let manual=false;
    if(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY==="true"){
      const pin=await admin.from("server_payment_protocols_v1").select("attempt_id,buyer_id,product_id,reservation_id,kind,protocol,context")
        .eq("attempt_id",r.attemptId).eq("buyer_id",args.buyerId).maybeSingle();check(!pin.error);
      if(pin.data){
        check(pin.data.attempt_id===r.attemptId&&pin.data.buyer_id===r.buyerId&&pin.data.product_id===r.productId&&
          pin.data.reservation_id===r.id&&pin.data.kind==="first_installment"&&pin.data.protocol===SERVER_PAYMENT_PROTOCOL&&
          isDeepStrictEqual(pin.data.context,config.approvedContext));
        manual=true;
        check(env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_SCHEMA_READY==="true"&&env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_READY==="true");
      }
    }
    const validateRelease=(value:any)=>{
      check(value?.reservation_id===r.id&&value.request_id===r.requestId&&typeof value.released_at==="string"&&
        Number.isFinite(Date.parse(value.released_at))&&Date.parse(value.released_at)>0&&Date.parse(value.released_at)<=Date.now()+5000);
      return value.released_at as string;
    };
    if(manual){
      const replay=await admin.rpc("read_buyer_mentorship_manual_release_v1",scope);check(!replay.error);
      if(replay.data)return {status:"released" as const,requestId:r.requestId,releasedAt:validateRelease(replay.data),providerOperationsAllowed:false as const};
      const stopped=await stopBuyerMentorshipServerPayment(args);
      if(stopped.status!=="intent_canceled_unreleased")return {status:"reconciliation_required" as const,releaseAllowed:false as const};
      check(env.CREATOR_MENTORSHIP_INSTALLMENT_ABANDONMENT_REQUEST_READY==="true");
      const hold=await admin.rpc("request_buyer_mentorship_abandonment_v1",scope);
      check(!hold.error&&hold.data?.reservation_id===r.id);
    }else if(args.requestStop){
      const {requestBuyerMentorshipAbandonment}=await import("./mentorshipInstallmentBootstrap");
      await requestBuyerMentorshipAbandonment(args);
    }
    const readManual=async()=>{
      const result=await admin.rpc("read_buyer_mentorship_manual_stop_v1",scope);check(!result.error&&result.data);
      const value=result.data as {preparation:PartialPreparation;manualPayment:ServerPaymentTerminalProof};
      check(value.manualPayment?.version==="server-payment-intent-terminal-v1"&&value.manualPayment.status==="canceled"&&
        value.manualPayment.amountReceived===0&&value.manualPayment.amountCapturable===0);
      return value;
    };
    const manualSource=manual?await readManual():null;
    const readPartial=async():Promise<PartialPreparation|null>=>{
      let p:PartialPreparation;
      if(manual){const current=await readManual();check(isDeepStrictEqual(current,manualSource));p=current.preparation;}
      else{
        if(env.CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_READY!=="true")return null;
        check(env.CREATOR_MENTORSHIP_INSTALLMENT_PARTIAL_STOP_SCHEMA_READY==="true");
        const result=await admin.rpc("read_buyer_mentorship_partial_stop_v1",scope);check(!result.error);
        if(result.data===null)return null;
        p=result.data as PartialPreparation;
      }
      check(p?.reservationId===r.id&&p.bootstrap?.reservation_id===r.id&&p.product?.reservation_id===r.id&&
        p.subscription?.reservation_id===r.id&&/^cus_[A-Za-z0-9]+$/.test(p.bootstrap.customer_id)&&
        /^prod_[A-Za-z0-9]+$/.test(p.product.result_id)&&/^sub_[A-Za-z0-9]+$/.test(p.subscription.result_id)&&
        Number.isSafeInteger(p.bootstrap.anchor_seconds));
      return p;
    };
    const partial=await readPartial();
    const bindings=partial?{...partial,checkout:null}:await readBuyerMentorshipCheckoutBindings(admin,r);
    const {bootstrap,product,subscription,checkout}=bindings;
    const original=buyerMentorshipFirstPaymentRequest(r,config.approvedContext,{customerId:bootstrap.customer_id,
      productId:product.result_id,subscriptionId:subscription.result_id,anchorSeconds:bootstrap.anchor_seconds});
    if(checkout)check(isDeepStrictEqual(original,checkout.request));
    const fresh=async()=>{
      if(manual)check(env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_SCHEMA_READY==="true"&&
        env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_STOP_READY==="true");
      await evidence();
      if(partial)check(isDeepStrictEqual(partial,await readPartial()));
      else check(isDeepStrictEqual(bindings,await readBuyerMentorshipCheckoutBindings(admin,r)));
      const hold=await admin.from("buyer_mentorship_abandonment_holds_v1").select("reservation_id,requested_at").eq("reservation_id",r.id).maybeSingle();
      const receipt=await admin.from("buyer_mentorship_first_receipts_v1").select("reservation_id").eq("reservation_id",r.id).maybeSingle();
      check(!hold.error&&hold.data?.reservation_id===r.id&&!receipt.error&&!receipt.data);
    };
    await fresh();
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const identity={agreementId:r.id,requestId:r.requestId,actorId:r.buyerId,token:randomUUID()};
    let releasedAt:string|null=null;
    let terminal:Parameters<ExactBillingStopStore["complete"]>[1]|null=null;
    const store:ExactBillingStopStore={
      claim:async i=>{check(isDeepStrictEqual(i,identity));await fresh();return "ready";},
      assertClaim:async i=>{check(isDeepStrictEqual(i,identity));await fresh();},
      accounted:async()=>false, // A capture must use the existing receipt/reconciliation path.
      complete:async(i,proof)=>{
        check(isDeepStrictEqual(i,identity)&&proof.checkoutStatus===(partial?"not_created":"expired")&&proof.firstPaymentIntentId===null&&
          proof.sessionId===(checkout?.result_id??null));
        await fresh();
        if(manual){
          const stopped=await stopBuyerMentorshipServerPayment(args);
          check(stopped.status==="intent_canceled_unreleased"&&manualSource&&
            isDeepStrictEqual({...stopped.proof,observedAt:manualSource.manualPayment.observedAt},manualSource.manualPayment));
          await fresh();
        }
        const observation={version:manual?"buyer-manual-payment-stop-v1":partial?"buyer-partial-subscription-stop-v1":"buyer-unpaid-stop-v1",
          ...(manualSource?{manualPayment:manualSource.manualPayment}:{}),
          ...(partial?{preparation:partial}:{}),...proof,observedAt:Math.floor(Date.now()/1000)};
        const saved=await admin.rpc("record_buyer_mentorship_abandonment_proof_v1",{...scope,p_proof:observation});
        check(!saved.error&&saved.data?.reservation_id===r.id);
        const {observedAt,...persisted}=saved.data.proof??{};
        const {observedAt:currentObservedAt,...expected}=observation;
        check(isDeepStrictEqual(persisted,expected)&&Number.isSafeInteger(observedAt)&&observedAt<=currentObservedAt+5);
        if(releaseEnabled){
          await fresh();check(Date.now()/1000-observation.observedAt<30);
          const released=await admin.rpc("release_buyer_mentorship_abandonment_v1",{...scope,p_proof:observation});
          check(!released.error);releasedAt=validateRelease(released.data);
        }
        terminal=proof;
      },
    };
    const dispatch=async<T,>(step:"checkout.expire"|"subscription.cancel",params:object,send:(key:string|null)=>Promise<T>)=>{
      await fresh();
      if(step==="checkout.expire")check(checkout);
      const result=await admin.rpc("claim_buyer_mentorship_abandonment_operation_v1",{...scope,p_step:step});
      check(!result.error);
      const value=result.data,op=value?.operation;
      check(value?.status==="dispatch"&&op?.reservation_id===r.id&&op.step===step);
      const expected={apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:step==="checkout.expire"?"POST":"DELETE",
        path:step==="checkout.expire"?`/v1/checkout/sessions/${checkout!.result_id}/expire`:`/v1/subscriptions/${subscription.result_id}`,params};
      const key=step==="checkout.expire"?`${r.terms.installmentVersion}:${r.id}:expire-approved-stop-v1`:null;
      check(isDeepStrictEqual(op.request,expected)&&op.idempotency_key===key);assertAgreementId(op.lease_token);
      const deadline=Date.parse(value.dispatch_before),first=Date.parse(op.first_dispatch_at);
      check(Number.isFinite(first)&&first<=Date.now()+5000&&Number.isFinite(deadline)&&deadline>Date.now()&&deadline<=Date.now()+35000&&
        (step!=="checkout.expire"||deadline<=first+23*3600000));
      await fresh();check(Date.now()<deadline);return send(key);
    };
    let checkoutIntentId:string|null=null;
    const provider:BillingStopProvider={
      customers:{retrieve:id=>{check(id===bootstrap.customer_id);return stripe.customers.retrieve(id);}},
      subscriptions:{
        retrieve:id=>{check(id===subscription.result_id);return stripe.subscriptions.retrieve(id);},
        list:p=>{check(p.customer===bootstrap.customer_id);return stripe.subscriptions.list(p);},
        cancel:(id,p,options)=>{
          check(id===subscription.result_id&&isDeepStrictEqual(p,{invoice_now:false,prorate:false})&&isDeepStrictEqual(options,{maxNetworkRetries:0}));
          return dispatch("subscription.cancel",p,()=>stripe.subscriptions.cancel(id,p,options));
        },
      },
      checkout:{sessions:{
        retrieve:async id=>{
          check(checkout&&id===checkout.result_id);const session=await stripe.checkout.sessions.retrieve(id);
          assertFixedTotalCheckoutSession(session,{params:original.params,customerId:bootstrap.customer_id,
            expectedLiveMode:config.approvedContext.mode==="live",firstDispatchAt:checkout.first_dispatch_at,purchaseConsentRequired:true},id,"observe_unpaid");
          check(session.billing_address_collection==="required");checkoutIntentId=session.payment_intent as string|null;return session;
        },
        expire:(id,p,options)=>{
          check(checkout&&id===checkout.result_id&&isDeepStrictEqual(p,{})&&isDeepStrictEqual(options,{
            idempotencyKey:`${r.terms.installmentVersion}:${r.id}:expire-approved-stop-v1`,maxNetworkRetries:0}));
          return dispatch("checkout.expire",p,key=>{check(key===options.idempotencyKey);return stripe.checkout.sessions.expire(id,p,options);});
        },
      }},
      invoices:{list:p=>{check(p.customer===bootstrap.customer_id);return stripe.invoices.list(p);}},
      invoiceItems:{list:p=>{check(p.customer===bootstrap.customer_id);return stripe.invoiceItems.list(p);}},
      invoicePayments:{list:p=>stripe.invoicePayments.list(p)},
      paymentIntents:{retrieve:async id=>{
        const pi=await stripe.paymentIntents.retrieve(id);
        if(id===checkoutIntentId){
          const first=calculateInstallmentPlan(r.terms.amountCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule).payments[0];
          inspectExpiredCheckoutPaymentIntent(pi,{paymentIntentId:id,customerId:bootstrap.customer_id,liveMode:config.approvedContext.mode==="live",
            amountCents:first.amountCents,feeCents:first.fees.totalCreatorDeductionCents,destinationId:r.destinationId});
        }
        return pi;
      }},
    };
    const metadata=original.params.metadata!;
    // Customer and subscription metadata are the accepted ownership fields;
    // checkout has the additional existing fee/collection contract fields.
    const ownership={creatornet_installment_version:r.terms.installmentVersion,creatornet_installment_reservation_id:r.id,
      creatornet_installment_request_id:r.requestId,buyer_id:r.buyerId,creator_id:r.terms.creatorId,product_id:r.productId,post_id:r.postId,
      terms_fingerprint:r.fingerprint,payment_mode:config.approvedContext.mode,platform_account_id:config.approvedContext.platformAccountId,
      supabase_project_ref:config.approvedContext.supabaseProjectRef,site_origin:config.approvedContext.siteOrigin};
    const result=await stopExactBillingUsingContract({identity,agreement:{id:r.id,customerId:bootstrap.customer_id,
      subscriptionId:subscription.result_id,sessionId:checkout?.result_id??null,terms:{totalCents:r.terms.amountCents,paymentCount:r.terms.paymentCount,
        firstPaymentFeeSchedule:r.terms.firstPaymentFeeSchedule,renewalFeeSchedule:r.terms.renewalFeeSchedule,destinationId:r.destinationId,version:r.terms.installmentVersion}},
      stopStore:store,stripe:provider,expectedLiveMode:config.approvedContext.mode==="live",
      ...(partial?{checkoutNotAdmitted:{assertCurrent:fresh,trialEndsAt:bootstrap.anchor_seconds+48*3600}}:{}),
      matchesMetadata:(kind,m)=>isDeepStrictEqual(m,kind==="checkout"?metadata:{...ownership,operation_kind:`${kind}.create`})});
    if(result.status!=="collection_stopped")return {status:result.status,releaseAllowed:false as const};
    check(terminal);
    if(releasedAt)return {status:"released" as const,requestId:r.requestId,releasedAt,providerOperationsAllowed:false as const};
    return {status:"stopped_unreleased" as const,releaseAllowed:false as const,proof:terminal};
  } catch {throw Error("Buyer abandonment requires review");}
}
