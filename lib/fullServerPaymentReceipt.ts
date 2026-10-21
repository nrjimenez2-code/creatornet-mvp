import "server-only";
import type Stripe from "stripe";
import {assertAgreementId} from "./installments/agreementStore";
import {inspectServerPaymentIntent,type ServerPaymentContract} from "./serverPaymentConfirmation";
import {inspectPaymentCaptureEvidence} from "./paymentCaptureEvidence";
import {calculateCreatorFees} from "./money";
import {fixedServiceEndAt,FIXED_SERVICE_VERSION} from "./fixedServiceTerms";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Full payment capture requires review");};

/** Read-only full-payment evidence from the saved contract, original consent
 * and independently retrieved provider objects. The caller must establish the
 * owned binding and recorded confirmation. Publication/accounting stay gated
 * until an atomic writer validates this evidence against those database rows. */
export function inspectFullServerPaymentCapture(args:{
  contract:ServerPaymentContract;contextEvidence:unknown;
  binding:{paymentIntentId:string;firstDispatchAt:number};confirmationOperationId:string;nowSeconds:number;
  consent:{id:string;accepted_at:string;terms:{kind:string;version:string;buyerId:string;creatorId:string;productId:string;
    postId:string|null;amountCents:number;currency:string;serviceVersion?:string;serviceMonths?:number}};
  data:{paymentIntent:Stripe.PaymentIntent;charge:Stripe.Charge;balance:Stripe.BalanceTransaction;paymentMethod:Stripe.PaymentMethod};
  financialInspection?:"refund"|"dispute"|"refund_and_dispute";
}){
  const {contract:c,consent}=args,t=consent.terms;
  check(c.kind==="full"&&c.customerId===null);
  assertAgreementId(args.confirmationOperationId);assertAgreementId(consent.id);
  assertAgreementId(c.sourceMetadata.order_id);assertAgreementId(c.sourceMetadata.checkout_attempt_key);
  if(t.postId!==null)assertAgreementId(t.postId);
  check(consent.id===c.sourceMetadata.purchase_consent_id&&t.kind==="one_time"&&t.version===c.sourceMetadata.purchase_policy_version&&
    t.buyerId===c.buyerId&&t.creatorId===c.creatorId&&t.productId===c.productId&&
    (t.postId??"")===c.sourceMetadata.post_id&&t.amountCents===c.amountCents&&t.currency==="usd"&&
    Math.floor(Date.parse(consent.accepted_at)/1000)===c.acceptedAt);
  if(t.serviceMonths!==undefined)check(t.serviceVersion===FIXED_SERVICE_VERSION&&c.sourceMetadata.fixed_service_version===FIXED_SERVICE_VERSION);
  else check(t.serviceVersion===undefined&&c.sourceMetadata.fixed_service_version===undefined);
  const pi=inspectServerPaymentIntent(c,args.contextEvidence,args.data.paymentIntent,args.binding,args.nowSeconds);
  check(pi.status==="succeeded");
  const fees=calculateCreatorFees(c.amountCents,c.processingFees);
  const capture=inspectPaymentCaptureEvidence({...args.data,customerId:null,live:c.context.mode==="live",amountCents:c.amountCents,
    applicationFeeCents:fees.totalCreatorDeductionCents,createdAt:pi.created,expiresAt:c.expiresAt,
    nowSeconds:args.nowSeconds,financialInspection:args.financialInspection});
  return Object.freeze({version:"full-server-payment-capture-v1" as const,attemptId:c.attemptId,buyerId:c.buyerId,
    creatorId:c.creatorId,productId:c.productId,postId:t.postId,orderId:c.sourceMetadata.order_id,purchaseConsentId:consent.id,
    termsFingerprint:c.termsFingerprint,context:c.context,confirmationOperationId:args.confirmationOperationId,
    checkoutSessionId:null,customerId:null,paymentIntentId:pi.id,destinationId:c.destinationId,amountCents:c.amountCents,
    fees,...capture,serviceEndsAt:t.serviceMonths===undefined?null:fixedServiceEndAt(capture.paidAt,t.serviceMonths)});
}
