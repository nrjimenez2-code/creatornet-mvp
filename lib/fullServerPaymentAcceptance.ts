import "server-only";
import {isDeepStrictEqual} from "node:util";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./installments/agreementStore";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {resolvePostForProduct} from "./checkoutGuards";
import {requireProductConsent,productPurchaseTerms,type ConsentProduct} from "./purchaseConsent";
import {calculateCreatorFees,type ProcessingFeeSchedule} from "./money";
import {productCheckoutFingerprint} from "./productCheckoutFingerprint";
import {productCheckoutOrderMatches} from "./productCheckoutOrder";
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest} from "./serverPaymentConfirmation";
import {fullServerPaymentContract} from "./fullServerPayment";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Full payment acceptance requires review");};

/** Trusted initial acceptance only. Identity comes from authentication; product,
 * fees and context evidence come from independent server reads. The caller must
 * retain the same attemptId/attemptKey/orderId across uncertain acknowledgements.
 * Recovery of an already dispatched attempt uses the saved source/contract, never
 * this current-quote composition. No provider call or payment authority is issued.
 */
export async function acceptFullServerPayment(args:{
  admin:SupabaseClient;buyerId:string;product:ConsentProduct;postId:string;
  attemptId:string;attemptKey:string;orderId:string;processingFees:ProcessingFeeSchedule;
  context:unknown;contextEvidence:unknown;origin:string|null;acceptance:unknown;
  env?:Record<string,string|undefined>;
}) {
  try {
    const env=args.env??process.env;
    if(env.CREATOR_FULL_SERVER_PAYMENT_ACCEPTANCE_READY!=="true"||
      env.CREATOR_SERVER_PAYMENT_PROTOCOL_SCHEMA_READY!=="true"||
      env.CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY!=="true")return {status:"not_enabled" as const};
    const context=validateExactPaymentContext(args.context,args.contextEvidence);
    check(args.origin===context.siteOrigin);
    const {buyerId,postId,attemptId,attemptKey,orderId,admin}=args;
    const product={...args.product},processingFees={...args.processingFees};
    for(const value of [buyerId,postId,attemptId,attemptKey,orderId,product.id,product.creator_id]){
      check(typeof value==="string");assertAgreementId(value);
    }
    check(product.type==="mentorship"&&product.creator_id!==buyerId&&product.membership_terms==null);
    const quote=productPurchaseTerms(product,buyerId,postId),fees=calculateCreatorFees(quote.terms.amountCents,processingFees);
    check(await resolvePostForProduct(admin,postId,product.id,product.creator_id!)===postId);
    const [pricing,destination]=await Promise.all([
      admin.from("posts").select("id,price_cents").eq("id",postId).maybeSingle(),
      admin.from("profiles").select("id,stripe_account_id,stripe_onboarding_complete").eq("id",product.creator_id!).maybeSingle(),
    ]);
    check(!pricing.error&&pricing.data?.id===postId);
    const postPrice=Number(pricing.data.price_cents??0);
    check(Number.isSafeInteger(postPrice)&&postPrice>=0&&(postPrice===0||postPrice===quote.terms.amountCents));
    check(!destination.error&&destination.data&&destination.data.id===product.creator_id&&destination.data.stripe_onboarding_complete===true&&
      typeof destination.data.stripe_account_id==="string"&&/^acct_[A-Za-z0-9]+$/.test(destination.data.stripe_account_id));
    const consent=await requireProductConsent({admin,product,buyerId,postId,input:args.acceptance,
      site:context.siteOrigin,origin:args.origin,env});
    check(!consent.response&&consent.consentId);assertAgreementId(consent.consentId);
    const accepted=await admin.from("product_purchase_consents_v1").select("id,terms,fingerprint,accepted_at")
      .eq("id",consent.consentId).eq("buyer_id",buyerId).eq("product_id",product.id).maybeSingle();
    check(!accepted.error&&accepted.data?.id===consent.consentId&&accepted.data.fingerprint===quote.fingerprint&&
      isDeepStrictEqual(accepted.data.terms,quote.terms));
    const termsFingerprint=productCheckoutFingerprint({version:"creatornet-product-checkout-v1",
      purchase_consent_id:consent.consentId,buyer_id:buyerId,creator_id:product.creator_id!,product_id:product.id,post_id:postId,
      amount_cents:quote.terms.amountCents,currency:"usd",destination:destination.data.stripe_account_id,
      checkout_title:quote.terms.title,site:context.siteOrigin,category:"",platform_fee_cents:fees.platformFeeCents,
      processing_fee_cents:fees.processingFeeCents,total_creator_deduction_cents:fees.totalCreatorDeductionCents,
      creator_net_cents:fees.creatorNetCents,fee_schedule_version:fees.feeScheduleVersion});
    const candidate={id:attemptId,buyer_id:buyerId,creator_id:product.creator_id!,product_id:product.id,post_id:postId,
      purchase_identity:`post:${postId}`,attempt_key:attemptKey,order_id:orderId,terms_fingerprint:termsFingerprint,
      purchase_consent_id:consent.consentId};
    const reserved=await admin.rpc("reserve_full_server_payment_v1",{p_attempt:candidate,p_buyer_id:buyerId,p_context:context});
    const pin=reserved.data;
    check(!reserved.error&&pin?.attempt_id===attemptId&&pin.buyer_id===buyerId&&pin.product_id===product.id&&pin.kind==="full"&&
      pin.protocol===SERVER_PAYMENT_PROTOCOL&&isDeepStrictEqual(pin.context,context)&&isDeepStrictEqual(pin.source,candidate)&&
      typeof pin.created_at==="string"&&Number.isFinite(Date.parse(pin.created_at))&&Date.parse(pin.created_at)>0);
    // Reservation precedes order creation: a competing/legacy selection cannot
    // acquire an order here. A lost order acknowledgement is checked by identity;
    // it never causes an upsert, replacement order, rotation or provider dispatch.
    const order={id:orderId,buyer_id:buyerId,buyer_user_id:buyerId,creator_id:product.creator_id!,post_id:postId,
      amount_cents:quote.terms.amountCents,gross_amount:quote.terms.amountCents,platform_fee:fees.platformFeeCents,
      processing_fee:fees.processingFeeCents,total_creator_deduction:fees.totalCreatorDeductionCents,
      creator_amount:fees.creatorNetCents,fee_schedule_version:fees.feeScheduleVersion,status:"created",currency:"usd"};
    const inserted=await admin.from("orders").insert(order);
    check(!inserted.error||inserted.error.code==="23505");
    const saved=await admin.from("orders").select("id,buyer_id,creator_id,post_id,amount_cents,gross_amount,platform_fee,processing_fee,total_creator_deduction,creator_amount,fee_schedule_version,status,currency,stripe_checkout_session_id,stripe_payment_intent_id")
      .eq("id",orderId).eq("buyer_id",buyerId).maybeSingle();
    check(!saved.error&&productCheckoutOrderMatches(saved.data,{orderId,buyerId,creatorId:product.creator_id!,postId,
      amountCents:quote.terms.amountCents,currency:"usd",fees})&&!saved.data?.stripe_checkout_session_id&&!saved.data?.stripe_payment_intent_id);
    const contract=fullServerPaymentContract({selection:pin,consent:accepted.data,order:saved.data!,
      destinationId:destination.data.stripe_account_id,processingFees,context});
    const scope={p_attempt_id:attemptId,p_buyer_id:buyerId,p_context:context};
    const stored=await admin.rpc("save_full_server_payment_contract_v1",{...scope,p_contract:contract,
      p_request:serverPaymentCreateRequest(contract,args.contextEvidence)});
    check(!stored.error&&isDeepStrictEqual(stored.data,contract));
    return Object.freeze({status:"accepted" as const,attemptId,attemptKey,orderId,buyerId,productId:product.id,postId,
      termsFingerprint,consentId:consent.consentId,providerOperationsAllowed:false as const});
  } catch {throw Error("Full payment acceptance requires review");}
}
