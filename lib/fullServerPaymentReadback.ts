import "server-only";
import Stripe from "stripe";
import {createClient,type SupabaseClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest,observeServerPaymentConfirmation,type ServerPaymentContract} from "./serverPaymentConfirmation";
import {createServerConfirmationStore} from "./serverPaymentConfirmationStore";
import {inspectFullServerPaymentCapture} from "./fullServerPaymentReceipt";
import {readOriginalFullRefund,readOriginalFullRefundTotal} from "./fullServerRefundObservation";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Full payment readback requires review");};
function sid(value:unknown,prefix:string){
  const id=typeof value==="string"?value:value&&typeof value==="object"?(value as {id?:unknown}).id:null;
  check(typeof id==="string"&&new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id));return id;
}

/** Internal provider readback only. Persists a verified observation through the
 * existing confirmation store; cannot create/confirm/cancel an intent, release
 * selection, write a receipt, credit earnings or grant access. Recovery uses
 * the original saved source even after new-sales gates or catalog data change. */
type FullReadArguments={buyerId:string;attemptId:string;attemptKey:string;
  env?:Record<string,string|undefined>;expectedEvent?:{paymentIntentId:string;chargeId?:string;livemode:boolean}};
export async function inspectFullServerPayment(args:FullReadArguments){
  return (await inspectOriginalFullCapture(args)).proof;
}

// Financial inspection is private: it cannot be passed into the clean receipt
// recorder or accounting entry point to bypass clean-capture admission.
async function inspectOriginalFullCapture(args:FullReadArguments,financialInspection?:"refund"|"dispute"|"refund_and_dispute"){
  try{
    const env=args.env??process.env;
    for(const gate of ["CREATOR_FULL_SERVER_PAYMENT_RECEIPT_INSPECTION_READY","CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY",
      "CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY","CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY"])check(env[gate]==="true");
    for(const id of [args.buyerId,args.attemptId,args.attemptKey])assertAgreementId(id);
    const config=exactContextServerConfig(env),context=config.approvedContext,runtime=createExactContextRuntime(config);
    const contextEvidence=async()=>{const e=(await runtime.observeContext()).contextEvidence;validateExactPaymentContext(context,e);return e;};
    await contextEvidence();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const scope={p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_context:context};
    const source=await admin.rpc("read_server_payment_source_v1",{...scope,p_for_dispatch:false});
    const s=source.data;
    check(!source.error&&s?.attempt_id===args.attemptId&&s.buyer_id===args.buyerId&&s.kind==="full"&&
      s.protocol===SERVER_PAYMENT_PROTOCOL&&isDeepStrictEqual(s.context,context)&&s.source?.attempt_key===args.attemptKey);
    const [saved,original]=await Promise.all([admin.rpc("read_full_server_payment_contract_v1",scope),admin.rpc("read_server_payment_intent_v1",scope)]);
    const c=saved.data as ServerPaymentContract,op=original.data;
    check(!saved.error&&!original.error&&c&&op?.bound_at&&op.attempt_id===args.attemptId&&
      c.attemptId===args.attemptId&&c.buyerId===args.buyerId&&c.kind==="full"&&c.productId===s.product_id&&
      c.creatorId===s.source.creator_id&&c.termsFingerprint===s.source.terms_fingerprint&&
      c.sourceMetadata.order_id===s.source.order_id&&c.sourceMetadata.purchase_consent_id===s.source.purchase_consent_id&&
      c.sourceMetadata.checkout_attempt_key===args.attemptKey&&isDeepStrictEqual(c.context,context)&&isDeepStrictEqual(op.contract,c));
    check(isDeepStrictEqual(op.request,serverPaymentCreateRequest(c,await contextEvidence())));
    const firstDispatchAt=Math.floor(Date.parse(op.first_dispatch_at)/1000),boundAt=Math.floor(Date.parse(op.bound_at)/1000);
    check(Number.isSafeInteger(firstDispatchAt)&&Number.isSafeInteger(boundAt)&&boundAt>=firstDispatchAt&&boundAt<=Date.now()/1000);
    const binding={paymentIntentId:sid(op.payment_intent_id,"pi"),firstDispatchAt};
    const consent=await admin.from("product_purchase_consents_v1").select("id,terms,accepted_at")
      .eq("id",c.sourceMetadata.purchase_consent_id).eq("buyer_id",args.buyerId).maybeSingle();check(!consent.error&&consent.data);
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const dependencies={contract:c,binding,admin,contextEvidence,env,
      assertProviderSource:async()=>{throw Error("Capture inspection cannot authorize payment dispatch");}};
    const storage=createServerConfirmationStore(dependencies),latest=await storage.latest();check(latest);
    const observation=await observeServerPaymentConfirmation({...dependencies,stripe,admission:latest.admission,store:storage.store});
    check(observation.status==="succeeded"&&observation.paymentIntentId===binding.paymentIntentId);
    const options={apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000};
    const paymentIntent=await stripe.paymentIntents.retrieve(binding.paymentIntentId,options);
    check(sid(paymentIntent.latest_charge,"ch")===observation.chargeId&&sid(paymentIntent.payment_method,"pm")===observation.paymentMethodId);
    const charge=await stripe.charges.retrieve(observation.chargeId!,options);
    const [balance,paymentMethod]=await Promise.all([
      stripe.balanceTransactions.retrieve(sid(charge.balance_transaction,"txn"),options),
      stripe.paymentMethods.retrieve(observation.paymentMethodId!,options)]);
    const proof=inspectFullServerPaymentCapture({contract:c,contextEvidence:await contextEvidence(),binding,financialInspection,
      confirmationOperationId:latest.admission.operationId,consent:consent.data as Parameters<typeof inspectFullServerPaymentCapture>[0]["consent"],
      nowSeconds:Math.floor(Date.now()/1000),data:{paymentIntent,charge,balance,paymentMethod}});
    // A refund or changed original during the multi-object inspection must not
    // be returned as clean capture. The eventual receipt writer must also lock
    // and reconcile database financial state; external reads are not atomic.
    const [freshIntent,freshCharge]=await Promise.all([stripe.paymentIntents.retrieve(binding.paymentIntentId,options),
      stripe.charges.retrieve(charge.id,options)]);
    const freshProof=inspectFullServerPaymentCapture({contract:c,contextEvidence:await contextEvidence(),binding,financialInspection,
      confirmationOperationId:latest.admission.operationId,consent:consent.data as Parameters<typeof inspectFullServerPaymentCapture>[0]["consent"],
      nowSeconds:Math.floor(Date.now()/1000),data:{paymentIntent:freshIntent,charge:freshCharge,balance,paymentMethod}});
    check(isDeepStrictEqual(proof,freshProof));
    if(financialInspection)check(freshCharge.amount_refunded>=charge.amount_refunded);
    assertExpectedCapture(proof,args.expectedEvent);
    await storage.store.assertReadable(latest.admission);
    return {proof,refundedCents:freshCharge.amount_refunded,disputed:charge.disputed||freshCharge.disputed};
  }catch{throw Error("Full payment readback requires review");}
}

/** Reconcile a signed charge.refunded event against the owned original. No
 * refund is dispatched. An early refund is persisted first, then original-money
 * accounting may run under its separate gates without granting access. */
export async function reconcileFullServerPaymentRefund(args:FullReadArguments&{
  eventId:string;expectedEvent:{paymentIntentId:string;chargeId:string;livemode:boolean}}){
  const env=args.env??process.env;
  check(env.CREATOR_FULL_SERVER_PAYMENT_REFUND_SCHEMA_READY==="true"&&env.CREATOR_FULL_SERVER_PAYMENT_REFUND_READY==="true");
  // This schema provides the durable original-money hold needed if complete
  // Refund-list readback is unavailable or disagrees with the charge total.
  check(env.CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY==="true");
  check(/^evt_[A-Za-z0-9]+$/.test(args.eventId));
  const combined=env.CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_READY==="true"&&env.CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY==="true";
  const {proof,refundedCents,disputed}=await inspectOriginalFullCapture({...args,env},combined?"refund_and_dispute":"refund");
  check(refundedCents>0);
  const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
  validateExactPaymentContext(proof.context,(await runtime.observeContext()).contextEvidence);
  check(isDeepStrictEqual(proof.context,config.approvedContext));
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  let financialHoldEstablished=false;
  const holdFinancialUncertainty=async()=>{
    if(financialHoldEstablished)return;
    const held=await admin.rpc("hold_full_server_payment_financial_signal_v1",{p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_context:proof.context,p_proof:proof});
    check(!held.error&&held.data?.attemptId===proof.attemptId&&held.data.paymentIntentId===proof.paymentIntentId&&held.data.financialHold===true);
    financialHoldEstablished=true;
  };
  // Commit an independently observed dispute hold before accounting so a
  // later transaction failure cannot erase the held-access outcome.
  if(combined&&disputed)await holdFinancialUncertainty();
  const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
  try{
    const total=await readOriginalFullRefundTotal({proof,stripe,eventId:args.eventId,nowSeconds:Math.floor(Date.now()/1000),
      observeContext:async()=>{validateExactPaymentContext(proof.context,(await runtime.observeContext()).contextEvidence);}});
    check(total===refundedCents);
  }catch{
    // Preserve normal verified partial-refund policy. Only uncertainty adds a
    // hold here; once established, this path never removes it on a later retry.
    await holdFinancialUncertainty();
    throw Error("Full payment refund total requires review");
  }
  try{
  const {data:r,error}=await admin.rpc(combined?"apply_full_server_payment_refund_signal_v1":"apply_full_server_payment_refund_v1",{p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,
    p_context:proof.context,p_event_id:args.eventId,p_proof:proof,p_refunded_cents:refundedCents,...(combined?{p_disputed:disputed}:{})});
  check(!error&&r?.attemptId===proof.attemptId&&r.paymentIntentId===proof.paymentIntentId&&
    Number.isSafeInteger(r.refundedCents)&&r.refundedCents>=refundedCents&&r.refundedCents<=proof.amountCents&&
    ["original_refund_applied","refund_recorded_accounting_review"].includes(r.status));
  if(r.status==="original_refund_applied"){assertAgreementId(r.purchaseId);assertAgreementId(r.ledgerId);}
  const financial=r.status==="refund_recorded_accounting_review"?await accountObservedFinancialCapture({admin,env,proof,eventId:args.eventId,kind:"refund"}):null;
  if(financial)check(financial.refundedCents>=r.refundedCents);
  return {status:(financial?"original_refund_applied":r.status) as "original_refund_applied"|"refund_recorded_accounting_review",attemptId:proof.attemptId,
    paymentIntentId:proof.paymentIntentId,amountCents:proof.amountCents,refundedCents:(financial?.refundedCents??r.refundedCents) as number};
  }catch{
    // This also covers a lost commit acknowledgement or a database refusal of
    // regressed cumulative state. Preserve the original; never compensate by
    // recrediting earnings or issuing another provider operation.
    await holdFinancialUncertainty();throw Error("Full payment refund accounting requires review");
  }
}

/** A committed hold precedes provider readback. Dispute observation records no
 * creator debit and never restores access, including for a won dispute. */
export async function reconcileFullServerPaymentDispute(args:FullReadArguments&{
  eventId:string;disputeId:string;eventCreated:number;
  expectedEvent:{paymentIntentId:string;chargeId:string;livemode:boolean}}){
  const env=args.env??process.env;
  check(env.CREATOR_FULL_SERVER_PAYMENT_DISPUTE_SCHEMA_READY==="true"&&env.CREATOR_FULL_SERVER_PAYMENT_DISPUTE_READY==="true");
  sid(args.eventId,"evt");sid(args.disputeId,"du");sid(args.expectedEvent.paymentIntentId,"pi");sid(args.expectedEvent.chargeId,"ch");
  for(const value of [args.buyerId,args.attemptId,args.attemptKey])assertAgreementId(value);
  check(Number.isSafeInteger(args.eventCreated)&&args.eventCreated>0&&args.eventCreated<=Math.floor(Date.now()/1000));
  const config=exactContextServerConfig(env),context=config.approvedContext,runtime=createExactContextRuntime(config);
  const observe=async()=>{validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);};
  await observe();check(args.expectedEvent.livemode===(context.mode==="live"));
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const scope={p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_context:context};
  const source=await admin.rpc("read_server_payment_source_v1",{...scope,p_for_dispatch:false});
  check(!source.error&&source.data?.attempt_id===args.attemptId&&source.data.buyer_id===args.buyerId&&source.data.kind==="full"&&
    source.data.protocol===SERVER_PAYMENT_PROTOCOL&&source.data.source?.attempt_key===args.attemptKey&&isDeepStrictEqual(source.data.context,context));
  const held=await admin.rpc("hold_full_server_payment_dispute_v1",{...scope,p_event_id:args.eventId,p_dispute_id:args.disputeId,
    p_payment_intent_id:args.expectedEvent.paymentIntentId,p_charge_id:args.expectedEvent.chargeId});
  check(!held.error&&held.data&&Number.isSafeInteger(held.data.revision)&&held.data.revision>=0&&
    Array.isArray(held.data.disputes)&&Array.isArray(held.data.refunds));
  const combined=env.CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_READY==="true"&&env.CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY==="true";
  const {proof,refundedCents}=await inspectOriginalFullCapture({...args,env},combined?"refund_and_dispute":"dispute");
  check(isDeepStrictEqual(proof.context,context)&&args.eventCreated>=proof.paidAt);
  const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
  const options={apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000};
  if(refundedCents>0){
    const total=await readOriginalFullRefundTotal({proof,stripe,eventId:args.eventId,observeContext:observe,nowSeconds:Math.floor(Date.now()/1000)});
    check(total===refundedCents);
  }
  const readDispute=async()=>{
    const d=await stripe.disputes.retrieve(args.disputeId,options);
    check(d.object==="dispute"&&d.id===args.disputeId&&d.livemode===args.expectedEvent.livemode&&
      sid(d.charge,"ch")===proof.chargeId&&(d.payment_intent===null||sid(d.payment_intent,"pi")===proof.paymentIntentId)&&d.currency==="usd"&&
      Number.isSafeInteger(d.amount)&&d.amount>0&&d.amount<=proof.amountCents&&
      Number.isSafeInteger(d.created)&&d.created>=proof.paidAt&&d.created<=args.eventCreated&&
      ["warning_needs_response","warning_under_review","warning_closed","needs_response","under_review","won","lost","prevented"].includes(d.status));
    return {id:d.id,chargeId:proof.chargeId,paymentIntentId:proof.paymentIntentId,amount:d.amount,status:d.status,created:d.created};
  };
  const first=await readDispute();await observe();check(isDeepStrictEqual(first,await readDispute()));
  const applied=await admin.rpc(combined?"apply_full_server_payment_financial_dispute_v1":"apply_full_server_payment_dispute_v1",{...scope,p_event_id:args.eventId,p_dispute_id:args.disputeId,
    p_proof:proof,p_read:held.data,p_disputed_cents:first.amount,p_status:first.status,p_event_created:args.eventCreated,...(combined?{p_refunded_cents:refundedCents}:{})});
  check(!applied.error&&["dispute_observed","dispute_review_recorded","dispute_recorded_accounting_review","reconciliation_required"].includes(applied.data));
  const financial=applied.data==="dispute_recorded_accounting_review"?await accountObservedFinancialCapture({admin,env,proof,eventId:args.eventId,kind:"dispute"}):null;
  if(financial)check(["dispute_observed","dispute_review_recorded"].includes(financial.disputeDisposition));
  return {status:(financial?.disputeDisposition??applied.data) as "dispute_observed"|"dispute_review_recorded"|"dispute_recorded_accounting_review"|"reconciliation_required",
    attemptId:proof.attemptId,paymentIntentId:proof.paymentIntentId};
}

/** Record current Refund-object state independently of the delivered event's
 * stale payload. The signed locator establishes a durable hold before reads.
 * A review disposition records work for operations; it does not settle a
 * failed refund, recredit money, clear a hold or authorize another charge. */
export async function reconcileFullServerRefundObject(args:FullReadArguments&{
  eventId:string;refundId:string;eventCreated:number;expectedEvent:{paymentIntentId:string;chargeId:string;livemode:boolean}}){
  const env=args.env??process.env;
  for(const gate of ["CREATOR_FULL_SERVER_REFUND_OBJECT_SCHEMA_READY","CREATOR_FULL_SERVER_REFUND_OBJECT_READY",
    "CREATOR_FULL_REFUND_EVENT_SCHEMA_READY",
    "CREATOR_FULL_SERVER_PAYMENT_REFUND_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_REFUND_READY",
    "CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_READY"])check(env[gate]==="true");
  sid(args.eventId,"evt");sid(args.refundId,"re");sid(args.expectedEvent.paymentIntentId,"pi");sid(args.expectedEvent.chargeId,"ch");
  for(const value of [args.buyerId,args.attemptId,args.attemptKey])assertAgreementId(value);
  check(Number.isSafeInteger(args.eventCreated)&&args.eventCreated>0&&args.eventCreated<=Math.floor(Date.now()/1000));
  const config=exactContextServerConfig(env),context=config.approvedContext,runtime=createExactContextRuntime(config);
  const observe=async()=>{validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);};
  await observe();check(args.expectedEvent.livemode===(context.mode==="live"));
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const scope={p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_context:context};
  const source=await admin.rpc("read_server_payment_source_v1",{...scope,p_for_dispatch:false});
  check(!source.error&&source.data?.attempt_id===args.attemptId&&source.data.buyer_id===args.buyerId&&source.data.kind==="full"&&
    source.data.protocol===SERVER_PAYMENT_PROTOCOL&&source.data.source?.attempt_key===args.attemptKey&&isDeepStrictEqual(source.data.context,context));
  const held=await admin.rpc("hold_full_server_refund_event_v1",{...scope,p_event_id:args.eventId,p_refund_id:args.refundId,
    p_payment_intent_id:args.expectedEvent.paymentIntentId,p_charge_id:args.expectedEvent.chargeId,p_event_created:args.eventCreated});
  check(!held.error&&Number.isSafeInteger(held.data?.revision)&&held.data.revision>=0&&Array.isArray(held.data.refunds)&&Array.isArray(held.data.disputes));
  const {proof,refundedCents}=await inspectOriginalFullCapture({...args,env},"refund_and_dispute");
  check(isDeepStrictEqual(proof.context,context));
  const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
  const observation=await readOriginalFullRefund({proof,stripe,observeContext:observe,refundId:args.refundId,eventId:args.eventId,
    eventCreated:args.eventCreated,eventLivemode:args.expectedEvent.livemode,nowSeconds:Math.floor(Date.now()/1000)});
  const succeededTotal=observation.status==="succeeded"?await readOriginalFullRefundTotal({proof,stripe,observation,
    observeContext:observe,nowSeconds:Math.floor(Date.now()/1000)}):null;
  const applied=await admin.rpc("apply_full_server_payment_refund_object_v1",{...scope,p_event_id:args.eventId,p_refund_id:args.refundId,
    p_proof:proof,p_read:held.data,p_observation:observation,p_refunded_cents:refundedCents,p_succeeded_total:succeededTotal});
  check(!applied.error);const r=applied.data;
  if(r?.status==="reconciliation_required")return {status:"reconciliation_required" as const,refundApplied:false};
  check(r?.attemptId===proof.attemptId&&r.paymentIntentId===proof.paymentIntentId&&r.refundStatus===observation.status&&
    ["refund_observed","refund_review_recorded","refund_recorded_accounting_review"].includes(r.status)&&
    ["refund_observed","refund_review_recorded"].includes(r.disposition)&&r.refundedCents===refundedCents&&typeof r.refundApplied==="boolean");
  check(r.status==="refund_recorded_accounting_review"||r.status===r.disposition);
  check(!r.refundApplied||(observation.status==="succeeded"&&r.disposition==="refund_observed"&&refundedCents>=observation.amountCents&&succeededTotal===refundedCents));
  const financial=r.status==="refund_recorded_accounting_review"?
    await accountObservedFinancialCapture({admin,env,proof,eventId:args.eventId,kind:"refund_object"}):null;
  if(financial&&r.refundApplied)check(financial.refundedCents>=refundedCents);
  return {status:(financial?r.disposition:r.status) as "refund_observed"|"refund_review_recorded"|"refund_recorded_accounting_review",
    attemptId:proof.attemptId,paymentIntentId:proof.paymentIntentId,amountCents:proof.amountCents,
    refundedCents,refundStatus:observation.status,refundApplied:r.refundApplied as boolean};
}

async function accountObservedFinancialCapture(args:{admin:SupabaseClient;env:Record<string,string|undefined>;
  proof:Awaited<ReturnType<typeof inspectFullServerPayment>>;eventId:string;kind:"refund"|"dispute"|"refund_object"}){
  if(args.env.CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_SCHEMA_READY!=="true"||
    args.env.CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_READY!=="true")return null;
  const {proof}=args;
  const {data:r,error}=await args.admin.rpc("account_full_server_financial_receipt_v1",{p_attempt_id:proof.attemptId,
    p_buyer_id:proof.buyerId,p_context:proof.context,p_event_id:args.eventId,p_event_kind:args.kind});
  check(!error&&r?.status==="original_financial_capture_accounted"&&r.attemptId===proof.attemptId&&
    r.paymentIntentId===proof.paymentIntentId&&typeof r.accounted==="boolean"&&Number.isSafeInteger(r.refundedCents)&&
    r.refundedCents>=0&&r.refundedCents<=proof.amountCents);
  assertAgreementId(r.purchaseId);assertAgreementId(r.ledgerId);return r;
}

/** Persist verified evidence only. A successful result explicitly leaves
 * accounting pending; callers must not interpret it as purchase fulfillment. */
export async function recordFullServerPaymentCapture(args:Parameters<typeof inspectFullServerPayment>[0]){
  try{
    const env=args.env??process.env;
    check(env.CREATOR_FULL_SERVER_PAYMENT_RECEIPT_SCHEMA_READY==="true"&&env.CREATOR_FULL_SERVER_PAYMENT_RECEIPT_RECORD_READY==="true");
    const proof=await inspectFullServerPayment({...args,env});
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    const observed=await runtime.observeContext();validateExactPaymentContext(proof.context,observed.contextEvidence);
    check(isDeepStrictEqual(proof.context,config.approvedContext));
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const saved=await admin.rpc("record_full_server_payment_receipt_v1",{
      p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_context:proof.context,p_proof:proof});
    check(!saved.error&&saved.data?.attemptId===proof.attemptId&&saved.data.paymentIntentId===proof.paymentIntentId&&
      typeof saved.data.recorded==="boolean"&&typeof saved.data.accountingRequired==="boolean");
    return {status:saved.data.accountingRequired?"capture_recorded_accounting_pending" as const:"capture_already_accounted" as const,attemptId:proof.attemptId,
      paymentIntentId:proof.paymentIntentId,recorded:saved.data.recorded as boolean};
  }catch{throw Error("Full payment receipt recording requires review");}
}

/** Account the original capture through the existing one-time engines. A
 * returned purchaseStatus is bookkeeping, not an access capability; callers
 * must use the existing entitlement reader, including service expiry/holds. */
export async function accountFullServerPayment(args:Parameters<typeof inspectFullServerPayment>[0]){
  try{
    const env=args.env??process.env;check(env.CREATOR_FULL_SERVER_PAYMENT_ACCOUNTING_SCHEMA_READY==="true");
    for(const id of [args.attemptId,args.buyerId,args.attemptKey])assertAgreementId(id);
    const config=exactContextServerConfig(env),context=config.approvedContext,runtime=createExactContextRuntime(config);
    const observe=async()=>{const result=await runtime.observeContext();validateExactPaymentContext(context,result.contextEvidence);};
    await observe();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const scope={p_attempt_id:args.attemptId,p_buyer_id:args.buyerId,p_context:context};
    const source=await admin.rpc("read_server_payment_source_v1",{...scope,p_for_dispatch:false});
    check(!source.error&&source.data?.attempt_id===args.attemptId&&source.data.buyer_id===args.buyerId&&source.data.kind==="full"&&
      source.data.source?.attempt_key===args.attemptKey&&isDeepStrictEqual(source.data.context,context));
    const receipt=await admin.rpc("read_full_server_payment_receipt_v1",scope);check(!receipt.error);
    if(receipt.data)check(receipt.data.attempt_id===args.attemptId&&receipt.data.proof?.buyerId===args.buyerId);
    if(receipt.data?.accounted_at)assertExpectedCapture(receipt.data.proof,args.expectedEvent);
    if(!receipt.data?.accounted_at){
      check(env.CREATOR_FULL_SERVER_PAYMENT_ACCOUNTING_READY==="true");
      // Fresh clean provider evidence is required for first accounting. A
      // previously accounted/refunded original uses its durable linkage below.
      await recordFullServerPaymentCapture({...args,env});
    }
    await observe();
    const result=await admin.rpc("account_full_server_payment_receipt_v1",scope),r=result.data;
    check(!result.error&&r?.attemptId===args.attemptId&&typeof r.accounted==="boolean"&&typeof r.purchaseStatus==="string");
    assertAgreementId(r.purchaseId);assertAgreementId(r.ledgerId);
    return {status:"original_capture_accounted" as const,attemptId:args.attemptId,purchaseId:r.purchaseId as string,
      ledgerId:r.ledgerId as string,purchaseStatus:r.purchaseStatus as string,accounted:r.accounted as boolean};
  }catch{throw Error("Full payment accounting requires review");}
}

function assertExpectedCapture(proof:{paymentIntentId:string;chargeId:string;context:{mode:string}},
  event?:{paymentIntentId:string;chargeId?:string;livemode:boolean}){
  if(event)check(event.paymentIntentId===proof.paymentIntentId&&event.livemode===(proof.context.mode==="live")&&
    (event.chargeId===undefined||event.chargeId===proof.chargeId));
}
