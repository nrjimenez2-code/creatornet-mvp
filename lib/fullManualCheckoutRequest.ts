import "server-only";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./installments/agreementStore";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {productPurchaseTerms,type ConsentProduct} from "./purchaseConsent";
import {calculateCreatorFees,type ProcessingFeeSchedule} from "./money";
import {acceptFullServerPayment} from "./fullServerPaymentAcceptance";

type Scope={admin:SupabaseClient;buyerId:string;requestId:string;context:unknown;contextEvidence:unknown};
type Snapshot={product:ConsentProduct&{active?:boolean|null};processingFees:ProcessingFeeSchedule;
  acceptance:{accepted:true;version:string;fingerprint:string};termsText:string};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original full checkout request requires review");};
function parse(row:any,args:Scope){
  const context=validateExactPaymentContext(args.context,args.contextEvidence);
  for(const value of [args.buyerId,args.requestId,row?.request_id,row?.buyer_id,row?.product_id,row?.post_id,row?.attempt_id,row?.attempt_key,row?.order_id])assertAgreementId(value);
  check(row.request_id===args.requestId&&row.buyer_id===args.buyerId&&isDeepStrictEqual(row.context,context));
  const s=row.snapshot as Snapshot;check(s&&typeof s.termsText==="string"&&s.termsText.length<=100000&&s.acceptance?.accepted===true&&
    createHash("sha256").update(s.termsText).digest("hex")===s.acceptance.fingerprint);
  const terms=JSON.parse(s.termsText) as ReturnType<typeof productPurchaseTerms>["terms"];
  check(terms.buyerId===args.buyerId&&terms.productId===row.product_id&&terms.postId===row.post_id&&terms.kind==="one_time"&&
    terms.creatorId===s.product?.creator_id&&s.product.id===row.product_id&&s.product.type==="mentorship"&&s.product.active!==false&&
    terms.version===s.acceptance.version&&Number.isSafeInteger(terms.amountCents)&&terms.amountCents>=50&&terms.currency==="usd");
  calculateCreatorFees(terms.amountCents,s.processingFees);
  check(typeof row.created_at==="string"&&Number.isFinite(Date.parse(row.created_at))&&Date.parse(row.created_at)>0);
  check(row.released_at==null||(typeof row.released_at==="string"&&Number.isFinite(Date.parse(row.released_at))&&
    Date.parse(row.released_at)>=Date.parse(row.created_at)&&Date.parse(row.released_at)<=Date.now()+5000));
  return {requestId:args.requestId,buyerId:args.buyerId,productId:row.product_id as string,postId:row.post_id as string,
    attemptId:row.attempt_id as string,attemptKey:row.attempt_key as string,orderId:row.order_id as string,
    context,snapshot:s,terms,fingerprint:s.acceptance.fingerprint,createdAt:row.created_at as string,releasedAt:row.released_at as string|null|undefined};
}
export async function readFullManualCheckoutRequest(args:Scope){
  try{
    const context=validateExactPaymentContext(args.context,args.contextEvidence);
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const row=await args.admin.from("full_manual_checkout_requests_v1").select("*")
      .eq("request_id",args.requestId).eq("buyer_id",args.buyerId).contains("context",context).maybeSingle();
    check(!row.error);return row.data?parse(row.data,args):null;
  }catch{throw Error("Original full checkout request requires review");}
}
export async function findFullManualCheckoutRequest(args:Omit<Scope,"requestId">&{productId:string}){
  try{
    const context=validateExactPaymentContext(args.context,args.contextEvidence);
    assertAgreementId(args.buyerId);assertAgreementId(args.productId);
    const result=await args.admin.rpc("find_full_manual_checkout_v1",{p_buyer_id:args.buyerId,p_product_id:args.productId,p_context:context});
    check(!result.error);if(!result.data)return null;
    const saved=parse(result.data,{...args,requestId:result.data.request_id});
    check(saved.productId===args.productId&&!saved.releasedAt);return saved;
  }catch{throw Error("Original full checkout discovery requires review");}
}
export async function planFullManualCheckoutRequest(args:Scope&{product:Snapshot["product"];postId:string;
  processingFees:ProcessingFeeSchedule;acceptance:unknown}){
  try{
    const context=validateExactPaymentContext(args.context,args.contextEvidence);
    for(const value of [args.buyerId,args.requestId,args.product.id,args.postId])assertAgreementId(value);
    check(args.product.type==="mentorship"&&args.product.active!==false&&args.product.creator_id!==args.buyerId);
    const quote=productPurchaseTerms(args.product,args.buyerId,args.postId);
    const acceptance={accepted:true as const,version:quote.terms.version,fingerprint:quote.fingerprint};
    check(isDeepStrictEqual(args.acceptance,acceptance));calculateCreatorFees(quote.terms.amountCents,args.processingFees);
    const snapshot:Snapshot=JSON.parse(JSON.stringify({product:args.product,processingFees:args.processingFees,acceptance,termsText:JSON.stringify(quote.terms)}));
    const row=await args.admin.rpc("plan_full_manual_checkout_v1",{p_request_id:args.requestId,p_buyer_id:args.buyerId,
      p_product_id:args.product.id,p_post_id:args.postId,p_context:context,p_snapshot:snapshot});
    check(!row.error&&isDeepStrictEqual(row.data?.snapshot,snapshot));return parse(row.data,args);
  }catch{throw Error("Original full checkout request requires review");}
}

/** Resume only the saved request, preserving all identities and fee inputs.
 * A saved contract bypasses current catalog/consent regeneration entirely. */
export async function acceptSavedFullManualCheckout(args:Scope&{origin:string|null;env?:Record<string,string|undefined>}){
  const saved=await readFullManualCheckoutRequest(args);check(saved);
  check(!saved.releasedAt);
  check(args.origin===saved.context.siteOrigin);
  const source=await args.admin.from("full_server_payment_sources_v1").select("attempt_id,contract").eq("attempt_id",saved.attemptId).maybeSingle();
  check(!source.error);
  if(source.data){
    const c=source.data.contract;
    check(source.data.attempt_id===saved.attemptId&&c?.attemptId===saved.attemptId&&c.buyerId===saved.buyerId&&c.productId===saved.productId&&
      c.kind==="full"&&c.creatorId===saved.terms.creatorId&&c.amountCents===saved.terms.amountCents&&
      c.sourceMetadata?.checkout_attempt_key===saved.attemptKey&&c.sourceMetadata?.order_id===saved.orderId&&
      isDeepStrictEqual(c.processingFees,saved.snapshot.processingFees)&&isDeepStrictEqual(c.context,saved.context));
    return saved;
  }
  const result=await acceptFullServerPayment({admin:args.admin,buyerId:saved.buyerId,product:saved.snapshot.product,postId:saved.postId,
    attemptId:saved.attemptId,attemptKey:saved.attemptKey,orderId:saved.orderId,processingFees:saved.snapshot.processingFees,
    context:saved.context,contextEvidence:args.contextEvidence,origin:args.origin,acceptance:saved.snapshot.acceptance,env:args.env});
  check(result.status==="accepted");return saved;
}

/** Atomic no-reservation proof only; null requires the existing stop engine. */
export async function releaseUnreservedFullManualCheckout(args:Scope&{env?:Record<string,string|undefined>}){
  const env=args.env??process.env;
  if(env.CREATOR_FULL_UNRESERVED_RELEASE_READY!=="true")return null;
  const context=validateExactPaymentContext(args.context,args.contextEvidence);
  assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
  const result=await args.admin.rpc("release_unreserved_full_checkout_v1",{
    p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context});
  check(!result.error);if(!result.data)return null;
  const saved=parse(result.data,args);check(saved.releasedAt);return saved;
}
